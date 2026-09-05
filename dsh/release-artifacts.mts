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
  wait?: () => Promise<void>;
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

  const wait = operations.wait ?? (() => new Promise<void>((done) => setTimeout(done, 1_500)));
  for (const [index, artifact] of artifacts.entries()) {
    assertReleaseArtifactUnchanged(artifact);
    if (existing[index]) {
      operations.report?.(artifact, true);
      continue;
    }
    await operations.publish(artifact);
    let verified = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const metadata = await operations.lookup(artifact);
      if (metadata !== undefined) {
        assertPublishedArtifact(artifact, metadata);
        verified = true;
        break;
      }
      if (attempt < 4) await wait();
    }
    if (!verified) {
      throw new Error(`Publication returned success, but ${artifact.name}@${artifact.version} could not be verified on the registry.`);
    }
    operations.report?.(artifact, false);
  }
}
