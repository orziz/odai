import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { applyDeterministicOverrides } from "./blind-verdict.mjs";

const source = await readFile(resolve(import.meta.dirname, "odai-blind-harness.mjs"), "utf8");

test("blind runner and judge use isolated Codex homes", () => {
  assert.match(source, /runIsolatedCodex/u);
  assert.match(source, /HOME: isolatedHome/u);
  assert.match(source, /USERPROFILE: isolatedHome/u);
  assert.match(source, /CODEX_HOME: codexHome/u);
  assert.match(source, /name\.startsWith\("ODAI_"\)/u);
  assert.match(source, /name === "DSH_HOME"/u);
  assert.match(source, /name === "DSH_AGENTS_HOME"/u);
  assert.match(source, /name === "AGENTS_HOME"/u);
  assert.match(source, /XDG_CONFIG_HOME: path\.join\(isolatedHome/u);
  assert.match(source, /"exec", "--ephemeral", "--ignore-user-config", "--sandbox"/u);
  assert.match(source, /"exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only"/u);
});

test("deterministic score caps recompute ranking before first-place totals", () => {
  const verdict = {
    ranking: ["candidate-a", "candidate-b"],
    candidates: {
      "candidate-a": { score: 4, pass: true, critical_failure: false, reason: "judge" },
      "candidate-b": { score: 3, pass: true, critical_failure: false, reason: "judge" },
    },
  };
  applyDeterministicOverrides(
    verdict,
    ["candidate-a", "candidate-b"],
    { "candidate-a": "arm-a", "candidate-b": "arm-b" },
    {
      "arm-a": { deterministicGate: { ok: false, cap: 1, note: "failed" } },
      "arm-b": { deterministicGate: { ok: true, cap: 4, note: "passed" } },
    },
  );
  assert.deepEqual(verdict.ranking, ["candidate-b", "candidate-a"]);
  assert.equal(verdict.candidates["candidate-a"].score, 1);
  assert.equal(verdict.candidates["candidate-a"].pass, false);
});
