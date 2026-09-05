import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { assertPublishedArtifact, identifyReleaseArtifact, publishVerifiedArtifacts } from "../dsh/build/release-artifacts.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

test("DSH publication verifies the pinned release matrix instead of PATH", async () => {
  const publishSource = await readFile(resolve(repoRoot, "dsh/npm-publish.mts"), "utf8");
  assert.match(publishSource, /scripts\/verify-dsh-release-matrix\.mjs/u);
  assert.doesNotMatch(publishSource, /"run", "verify:dsh"/u);
});

test("DSH publication clean gate covers root build inputs", async () => {
  const publishSource = await readFile(resolve(repoRoot, "dsh/npm-publish.mts"), "utf8");
  const gate = /function requireCleanPublishedCommit[\s\S]*?const status =/u.exec(publishSource)?.[0] ?? "";
  assert.match(gate, /"package\.json"/u);
  assert.match(gate, /"package-lock\.json"/u);
  assert.match(gate, /"dsh"/u);
  assert.match(gate, /"scripts"/u);
  assert.match(gate, /"skills\/odai"/u);
});

test("publication verifies and publishes the same packed tarballs", async () => {
  const publishSource = await readFile(resolve(repoRoot, "dsh/npm-publish.mts"), "utf8");
  assert.match(publishSource, /packReleaseArtifacts\(\)/u);
  assert.match(publishSource, /verify-dsh-packed-artifacts\.mjs/u);
  assert.match(publishSource, /verify-dsh-release-matrix\.mjs/u);
  assert.match(publishSource, /"--plugin-tgz", artifacts\.plugin/u);
  assert.match(publishSource, /"--agent-tgz", artifacts\.agent/u);
  assert.match(publishSource, /identifyReleaseArtifact\(plugin, artifacts\.plugin/u);
  assert.match(publishSource, /identifyReleaseArtifact\(agent, artifacts\.agent/u);
  assert.match(publishSource, /publishVerifiedArtifacts\(releases/u);
  assert.match(publishSource, /\["publish", tarball/u);
  assert.ok(publishSource.indexOf("identifyReleaseArtifact(plugin") < publishSource.indexOf('"scripts/verify-dsh-packed-artifacts.mjs"'));
  assert.ok(publishSource.indexOf('"scripts/verify-dsh-release-matrix.mjs"') < publishSource.indexOf("await publishVerifiedArtifacts"));
});

test("CI verifies the same isolated DSH release contract", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/skill-integrity.yml"), "utf8");
  assert.match(workflow, /Verify isolated DSH release contract[\s\S]*node scripts\/verify-dsh-release-matrix\.mjs/u);
});

function fixture(context) {
  const root = mkdtempSync(resolve(tmpdir(), "odai-release-artifacts-"));
  context.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return ["plugin", "agent"].map((surface) => {
    const tarball = resolve(root, `${surface}.tgz`);
    writeFileSync(tarball, `frozen ${surface} archive bytes`);
    return identifyReleaseArtifact({ name: `odai-dsh-${surface}`, version: "0.2.25" }, tarball);
  });
}

function published(artifact, extra = {}) {
  return { name: artifact.name, version: artifact.version, dist: { integrity: artifact.integrity }, ...extra };
}

test("partial publication resumes an identical tarball without gitHead", async (context) => {
  const [plugin, agent] = fixture(context);
  const registry = new Map([[plugin.name, published(plugin)]]);
  const writes = [];
  const reports = [];
  await publishVerifiedArtifacts([plugin, agent], {
    lookup: ({ name }) => registry.get(name),
    publish: (artifact) => { writes.push(artifact.name); registry.set(artifact.name, published(artifact)); },
    report: (artifact, skipped) => reports.push([artifact.name, skipped]),
  });
  assert.deepEqual(writes, [agent.name]);
  assert.deepEqual(reports, [[plugin.name, true], [agent.name, false]]);
});

test("tarball equality is authoritative when only the release-script commit changes", (context) => {
  const [artifact] = fixture(context);
  assert.doesNotThrow(() => assertPublishedArtifact(artifact, published(artifact, { gitHead: "earlier-commit" })));
  assert.throws(() => assertPublishedArtifact(artifact, published(artifact, {
    gitHead: "expected-commit", dist: { integrity: "sha512-different" },
  })), /different or missing tarball integrity/u);
});

test("existing metadata cannot pass with missing digest, SHA-1 alone, or wrong identity", (context) => {
  const [artifact] = fixture(context);
  for (const metadata of [
    null, {}, [],
    published(artifact, { name: "other-package" }),
    published(artifact, { version: "0.2.23" }),
    published(artifact, { dist: undefined }),
    published(artifact, { dist: { integrity: "" } }),
    published(artifact, { dist: { shasum: "old-sha1", integrity: "sha1-old-sha1" } }),
  ]) {
    assert.throws(() => assertPublishedArtifact(artifact, metadata), /identity|integrity/u);
  }
});

test("a conflicting second package stops the pair before the first publish", async (context) => {
  const [plugin, agent] = fixture(context);
  let writes = 0;
  await assert.rejects(publishVerifiedArtifacts([plugin, agent], {
    lookup: ({ name }) => name === agent.name ? published(agent, { dist: { integrity: "wrong" } }) : undefined,
    publish: () => { writes += 1; },
  }), /different or missing tarball integrity/u);
  assert.equal(writes, 0);
});

test("lookup failures cannot be mistaken for an unpublished version", async (context) => {
  const artifacts = fixture(context);
  let writes = 0;
  await assert.rejects(publishVerifiedArtifacts(artifacts, {
    lookup: () => { throw new Error("registry unavailable"); },
    publish: () => { writes += 1; },
  }), /registry unavailable/u);
  assert.equal(writes, 0);
});

test("changed local tarballs fail both before lookup and before publication", async (context) => {
  const [plugin, agent] = fixture(context);
  let lookups = 0;
  let writes = 0;
  writeFileSync(plugin.tarball, "changed after verification");
  await assert.rejects(publishVerifiedArtifacts([plugin], {
    lookup: () => { lookups += 1; }, publish: () => { writes += 1; },
  }), /tarball changed/u);
  assert.equal(lookups, 0);
  await assert.rejects(publishVerifiedArtifacts([agent], {
    lookup: () => { writeFileSync(agent.tarball, "changed during registry lookup"); },
    publish: () => { writes += 1; },
  }), /tarball changed/u);
  assert.equal(writes, 0);
});

test("post-publish verification retries visibility but never republishes", async (context) => {
  const [artifact] = fixture(context);
  let reads = 0;
  let writes = 0;
  let waits = 0;
  await publishVerifiedArtifacts([artifact], {
    lookup: () => ++reads < 4 ? undefined : published(artifact),
    publish: () => { writes += 1; },
    wait: async () => { waits += 1; },
  });
  assert.equal(writes, 1);
  assert.equal(waits, 2);
});

test("missing publication evidence stops after bounded reads", async (context) => {
  const [artifact] = fixture(context);
  let writes = 0;
  let reads = 0;
  let waits = 0;
  await assert.rejects(publishVerifiedArtifacts([artifact], {
    lookup: () => { reads += 1; },
    publish: () => { writes += 1; },
    wait: async () => { waits += 1; },
  }), /could not be verified/u);
  assert.equal(writes, 1);
  assert.equal(reads, 6);
  assert.equal(waits, 4);
});

test("wrong uploaded bytes stop publication of the second package", async (context) => {
  const artifacts = fixture(context);
  let writes = 0;
  await assert.rejects(publishVerifiedArtifacts(artifacts, {
    lookup: (artifact) => writes > 0 ? published(artifact, { dist: { integrity: "wrong" } }) : undefined,
    publish: () => { writes += 1; },
  }), /different or missing tarball integrity/u);
  assert.equal(writes, 1);
});

test("an uncertain successful write can be recovered on the next invocation", async (context) => {
  const artifacts = fixture(context);
  const registry = new Map();
  const writes = [];
  const lookup = ({ name }) => registry.get(name);
  await assert.rejects(publishVerifiedArtifacts(artifacts, {
    lookup,
    publish: (artifact) => {
      writes.push(artifact.name);
      registry.set(artifact.name, published(artifact));
      throw new Error("publish response was lost");
    },
  }), /response was lost/u);
  await publishVerifiedArtifacts(artifacts, {
    lookup,
    publish: (artifact) => { writes.push(artifact.name); registry.set(artifact.name, published(artifact)); },
  });
  assert.deepEqual(writes, artifacts.map(({ name }) => name));
});
