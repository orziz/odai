import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRepositoryVersionPolicy, validateOwnedVersion } from "./version-policy.mjs";
import { assertDshReleaseNotes } from "./verify-dsh-package-versions.mjs";

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
    result.versions.map(({ path, field }) => `${path}#${field}`),
    [
      "cli/package.json#version",
      "dsh/plugin/package.json#version",
      "dsh/agent/package.json#version",
      "skills/odai/manifest.json#skillVersion",
      "skills/odai/manifest.json#runtimeContract",
      "skills/odai/manifest.json#schemaVersion",
      "skills/odai-orchestration/manifest.json#version",
      "skills/odai-orchestration/manifest.json#governanceContract",
      "skills/odai-orchestration/manifest.json#schemaVersion",
    ],
  );
});

test("release notes bind a unique candidate and preserve descending historical versions", () => {
  const current = "## Unreleased — DSH 0.2.31 / canonical 0.3.15";
  const row = (version) => `| \`${version}\` | \`${version}\` | pinned peer | notes |`;
  const fixture = { packageVersion: "0.2.31", skillVersion: "0.3.15", changelog: `${current}\n\n## 0.2.30`, compatibility: [row("0.2.31"), row("0.2.30"), row("0.2.14")].join("\n") };
  assert.doesNotThrow(() => assertDshReleaseNotes(fixture));
  // A consumed release can be the current source without an Unreleased section.
  assert.doesNotThrow(() => assertDshReleaseNotes({ ...fixture, changelog: "## 0.2.31 — published" }));
  for (const changelog of [
    `${current}\n${current}`, `## 0.2.30\n${current}`,
    current.replace("0.2.31", "0.2.30"), current.replace("0.3.15", "0.3.11"),
  ]) assert.throws(() => assertDshReleaseNotes({ ...fixture, changelog }), /Unreleased owner/);
  for (const versions of [["0.2.30", "0.2.31"], ["0.2.31", "0.2.31"], ["0.2.31", "0.2.29", "0.2.30"]]) {
    assert.throws(() => assertDshReleaseNotes({ ...fixture, compatibility: versions.map(row).join("\n") }), /package pair first|descending version order/);
  }
});
