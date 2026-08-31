import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harness = resolve(repoRoot, "scripts", "odai-canary-harness.mjs");
const plan = resolve(repoRoot, "plans", "odai-canary.md");

async function dryRun(args = []) {
  const out = await mkdtemp(join(tmpdir(), "odai-canary-test-"));
  try {
    await execFileAsync(process.execPath, [harness, "--out", out, ...args], { cwd: repoRoot });
    return {
      manifest: JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
      report: JSON.parse(await readFile(join(out, "report.json"), "utf8")),
    };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

test("isolated canary rejects a reasoning effort that cannot actually inherit", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      harness,
      "--plan", plan,
      "--cases", "1",
      "--judge-reasoning-effort", "inherit",
    ], { cwd: repoRoot }),
    /reasoning effort inherit is unsupported because isolated Codex calls ignore user config/u,
  );
});

test("canonical suite selection preserves historical defaults and bypasses them for explicit cases", async () => {
  const full = await dryRun();
  assert.equal(full.manifest.suite, "full");
  assert.deepEqual(full.manifest.selected_cases, Array.from({ length: 19 }, (_, index) => index + 1));

  const ab = await dryRun(["--suite", "ab"]);
  assert.equal(ab.manifest.suite, "ab");
  assert.deepEqual(ab.manifest.selected_cases, [1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 17, 18, 19]);

  const explicit = await dryRun(["--cases", "20,34"]);
  assert.equal(explicit.manifest.suite, null);
  assert.deepEqual(explicit.manifest.selected_cases, [20, 34]);
});

test("strict canonical suites persist a 4-of-4 pass threshold", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [harness, "--suite", "intent", "--pass-score", "3"], { cwd: repoRoot }),
    /--suite intent requires --pass-score 4/u,
  );
  const intent = await dryRun(["--suite", "intent"]);
  assert.equal(intent.manifest.suite, "intent");
  assert.deepEqual(intent.manifest.selected_cases, [25, 26, 27, 28, 29, 30, 31]);
  assert.equal(intent.manifest.pass_score, 4);
  assert.equal(intent.report.pass_score, 4);

  const verification = await dryRun(["--suite", "verification"]);
  assert.deepEqual(verification.manifest.selected_cases, [32, 33, 34]);
  assert.equal(verification.manifest.pass_score, 4);
});

test("an explicit legacy plan without suite metadata remains usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "odai-legacy-plan-"));
  const legacyPlan = join(root, "legacy.md");
  await writeFile(legacyPlan, [
    "# Legacy canary",
    "",
    "| # | 用户请求 | 可观察验收 | 失败门 | 层级 | 权重 |",
    "|---|---|---|---|---|---:|",
    "| 1 | Legacy prompt | Legacy acceptance | Legacy failure | direct | 1 |",
    "",
  ].join("\n"), "utf8");
  try {
    const result = await dryRun(["--plan", legacyPlan, "--cases", "1"]);
    assert.equal(result.manifest.suite, null);
    assert.deepEqual(result.manifest.selected_cases, [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
