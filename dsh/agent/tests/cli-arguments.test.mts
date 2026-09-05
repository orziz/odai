import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const cli = resolve(import.meta.dirname, "../build/bin/odai-dsh-agent.mjs");

for (const option of ["--dsh-home", "--profile"]) {
  test(`${option} rejects a missing value`, () => {
    const result = spawnSync(process.execPath, [cli, "status", option], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${option} requires a non-empty`, "u"));
  });
}
