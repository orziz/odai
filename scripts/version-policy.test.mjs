import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryVersionPolicy, validateOwnedVersion } from "./version-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("owned versions reject the forbidden digit at every position", () => {
  for (const value of ["0.2.4", "0.4.0", "4.0.0", "0.2.14", 4, 14]) {
    assert.throws(() => validateOwnedVersion(value, ["4"], "candidate"), /contains forbidden digit 4/u);
  }
  for (const value of ["0.2.6", "0.3.0", 3, 5]) {
    assert.equal(validateOwnedVersion(value, ["4"], "candidate"), String(value));
  }
});

test("repository policy covers every current owned version carrier", () => {
  const result = assertRepositoryVersionPolicy({ repoRoot });
  assert.deepEqual(result.forbiddenDigits, ["4"]);
  assert.deepEqual(
    result.versions.map(({ path, field, version }) => `${path}#${field}=${version}`),
    [
      "cli/package.json#version=0.0.2",
      "dsh/plugin/package.json#version=0.2.19",
      "dsh/agent/package.json#version=0.2.19",
      "skills/odai/manifest.json#skillVersion=0.3.7",
      "skills/odai/manifest.json#runtimeContract=6",
    ],
  );
});
