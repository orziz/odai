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

test("CI verifies the same isolated DSH release contract", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/skill-integrity.yml"), "utf8");
  assert.match(workflow, /Verify isolated DSH release contract[\s\S]*node scripts\/verify-dsh-release-matrix\.mjs/u);
});
