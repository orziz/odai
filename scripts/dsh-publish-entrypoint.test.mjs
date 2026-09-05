import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

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
  assert.match(publishSource, /publishIfMissing\(plugin, artifacts\.plugin/u);
  assert.match(publishSource, /publishIfMissing\(agent, artifacts\.agent/u);
  assert.match(publishSource, /\["publish", tarball/u);
});

test("CI verifies the same isolated DSH release contract", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/skill-integrity.yml"), "utf8");
  assert.match(workflow, /Verify isolated DSH release contract[\s\S]*node scripts\/verify-dsh-release-matrix\.mjs/u);
});
