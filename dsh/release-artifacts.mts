import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ReleaseArtifact {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
}

interface PublicationOperations {
  lookup: (artifact: ReleaseArtifact) => unknown | Promise<unknown>;
  publish: (artifact: ReleaseArtifact) => void | Promise<void>;
  report?: (artifact: ReleaseArtifact, alreadyPublished: boolean) => void;
  wait?: (milliseconds: number) => Promise<void>;
  pending?: (artifact: ReleaseArtifact, waitedMs: number) => void;
}

function integrityOf(tarball: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}

export function identifyReleaseArtifact(
  metadata: Readonly<{ name: string; version: string }>,
  tarball: string,
): ReleaseArtifact {
  return Object.freeze({ ...metadata, tarball, integrity: integrityOf(tarball) });
}

export function assertReleaseArtifactUnchanged(artifact: ReleaseArtifact): void {
  if (integrityOf(artifact.tarball) !== artifact.integrity) {
    throw new Error(`${artifact.name}@${artifact.version} tarball changed after it was selected for verification.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertPublishedArtifact(artifact: ReleaseArtifact, metadata: unknown): void {
  const spec = `${artifact.name}@${artifact.version}`;
  if (!isRecord(metadata) || metadata.name !== artifact.name || metadata.version !== artifact.version) {
    throw new Error(`Registry returned mismatched package identity for ${spec}.`);
  }
  const integrity = isRecord(metadata.dist) ? metadata.dist.integrity : undefined;
  // npm's tarball publication path need not populate gitHead. Only the exact
  // archive already checked against this checkout and the load matrix may pass.
  if (integrity !== artifact.integrity) {
    throw new Error(`${spec} exists with different or missing tarball integrity; refusing to reuse this version.`);
  }
}

export async function publishVerifiedArtifacts(
  artifacts: readonly ReleaseArtifact[],
  operations: PublicationOperations,
): Promise<void> {
  const existing: boolean[] = [];
  // Check the entire pair before any registry mutation, including an existing
  // second package that would otherwise fail after publishing the first one.
  for (const artifact of artifacts) {
    assertReleaseArtifactUnchanged(artifact);
    const metadata = await operations.lookup(artifact);
    existing.push(metadata !== undefined);
    if (metadata !== undefined) assertPublishedArtifact(artifact, metadata);
  }

  const wait = operations.wait ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const pollIntervalMs = 5_000;
  const visibilityWaitMs = 300_000;
  const spec = (artifact: ReleaseArtifact): string => `${artifact.name}@${artifact.version}`;
  const verifiedPackages = artifacts.filter((_, index) => existing[index]).map(spec);
  for (const [index, artifact] of artifacts.entries()) {
    assertReleaseArtifactUnchanged(artifact);
    if (existing[index]) {
      operations.report?.(artifact, true);
      continue;
    }
    await operations.publish(artifact);
    let verified = false;
    try {
      for (let waitedMs = 0; waitedMs <= visibilityWaitMs; waitedMs += pollIntervalMs) {
        const metadata = await operations.lookup(artifact);
        if (metadata !== undefined) {
          assertPublishedArtifact(artifact, metadata);
          verified = true;
          break;
        }
        if (waitedMs < visibilityWaitMs) {
          if (waitedMs % 30_000 === 0) operations.pending?.(artifact, waitedMs);
          await wait(pollIntervalMs);
        }
      }
      if (!verified) throw new Error("Registry visibility is still pending after 5 minutes of polling waits.");
    } catch (error) {
      const unattempted = artifacts.slice(index + 1).filter((_, offset) => !existing[index + 1 + offset]);
      throw new Error([
        `npm publish returned success for ${spec(artifact)}, but registry verification has not completed.`,
        `Verified: ${verifiedPackages.join(", ") || "none"}.`,
        `Not yet submitted: ${unattempted.map(spec).join(", ") || "none"}.`,
        "No automatic republish was attempted. Once the version is visible, rerun this script with unchanged package contents; matching published tarballs will be verified and skipped.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"), { cause: error });
    }
    verifiedPackages.push(spec(artifact));
    operations.report?.(artifact, false);
  }
}
