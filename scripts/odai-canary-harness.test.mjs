import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fingerprintSkillBundle } from "./odai-canary-harness.mjs";
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
  const out = await realpath(await mkdtemp(join(tmpdir(), "odai-canary-test-")));
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

test("bundle identity covers manifests and installed orchestration without coupling plain runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "odai-fingerprint-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["odai", "ribao", "odai-orchestration"]) {
    await mkdir(join(root, "skills", name), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), `${name} body`);
    await writeFile(join(root, "skills", name, "manifest.json"), "{}");
  }
  const plain = fingerprintSkillBundle(root);
  const routed = fingerprintSkillBundle(root, { orchestration: true });
  assert.ok(plain.files.includes("odai/manifest.json"));
  assert.ok(routed.files.includes("odai-orchestration/manifest.json"));
  await writeFile(join(root, "skills", "odai-orchestration", "SKILL.md"), "changed orchestration");
  assert.equal(fingerprintSkillBundle(root).sha256, plain.sha256);
  const changed = fingerprintSkillBundle(root, { orchestration: true });
  assert.notEqual(changed.sha256, routed.sha256);
  await writeFile(join(root, "skills", "odai-orchestration", "manifest.json"), '{"changed":true}');
  assert.notEqual(fingerprintSkillBundle(root, { orchestration: true }).sha256, changed.sha256);
  await writeFile(join(root, "skills", "odai", "manifest.json"), '{"changed":true}');
  assert.notEqual(fingerprintSkillBundle(root).sha256, plain.sha256);
});

test("rejudge refuses missing bundle identity, changed bundles, and changed routing configuration", async (t) => {
  const baseline = await dryRun(["--cases", "1"]);
  assert.equal(baseline.manifest.skill_bundle_contract, "odai-canary-skill-bundle/v1");
  assert.match(baseline.manifest.skill_bundle_sha256, /^[a-f0-9]{64}$/u);
  const source = await mkdtemp(join(tmpdir(), "odai-rejudge-source-"));
  const out = await mkdtemp(join(tmpdir(), "odai-rejudge-output-"));
  t.after(() => Promise.all([source, out].map(dir => rm(dir, { recursive: true, force: true }))));
  await writeFile(join(source, "report.json"), JSON.stringify(baseline.report));
  for (const [field, value] of [["skill_bundle_contract", undefined], ["skill_bundle_sha256", "changed"], ["routing_config_sha256", "changed"]]) {
    await writeFile(join(source, "manifest.json"), JSON.stringify({ ...baseline.manifest, [field]: value }));
    await assert.rejects(execFileAsync(process.execPath, [harness, "--run", "--judge-cmd", 'node -e "process.exit(99)"', "--cases", "1", "--out", out, "--rejudge-from", source], { cwd: repoRoot }), new RegExp(`incompatible ${field}`, "u"));
  }
});

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

test("canary requires an explicit selection before preparing or running an experiment", async () => {
  for (const args of [[], ["--run"]]) {
    await assert.rejects(execFileAsync(process.execPath, [harness, ...args], { cwd: repoRoot }), /Select --cases, --suite, or --smoke explicitly/u);
  }
  const explicit = await dryRun(["--cases", "20,34"]);
  assert.equal(explicit.manifest.suite, null);
  assert.deepEqual(explicit.manifest.selected_cases, [20, 34]);
});

test("explicit routing installs the sibling skill in an isolated fixture without model calls", async () => {
  const routed = await dryRun(["--cases", "1", "--codex-routing-telemetry", "--runner-model", "fixture-controller", "--codex-routing-planner-model", "fixture-planner"]);
  assert.equal(routed.report.results[0].status, "dry-run");
  assert.equal(routed.report.results[0].metrics.installed_routing.planner.model, "fixture-planner");
});

test("strict canonical suites persist a 4-of-4 pass threshold", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [harness, "--suite", "intent", "--pass-score", "3"], { cwd: repoRoot }),
    /--suite intent requires --pass-score 4/u,
  );
  const intent = await dryRun(["--suite", "intent", "--cases", "1,25"]);
  assert.equal(intent.manifest.suite, "intent");
  assert.deepEqual(intent.manifest.selected_cases, [25]);
  assert.equal(intent.manifest.pass_score, 4);
  assert.equal(intent.report.pass_score, 4);

  const verification = await dryRun(["--suite", "verification", "--cases", "32"]);
  assert.deepEqual(verification.manifest.selected_cases, [32]);
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
