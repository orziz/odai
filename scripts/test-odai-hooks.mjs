#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(repoRoot, "skills", "odai", "scripts", "odai-hook.mjs");
const builder = path.join(repoRoot, "skills", "odai", "scripts", "build-hooks.mjs");
const temporaryRoots = [];
process.on("exit", () => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
const project = temporaryRoot("odai-hooks-project-");

run("git", ["init", "-q", project]);
mkdirSync(path.join(project, ".odai"), { recursive: true });

assert.equal(runHook("pre-tool", "codex", editPayload("src/index.js")).status, 0, "missing policy must be a no-op");

writePolicy({
  version: 1,
  protectedPaths: ["examples/reference/**"],
  blockUnresolvedWrites: false,
  checks: [],
});
assert.equal(runHook("pre-tool", "claude", editPayload("src/index.js")).status, 0, "ordinary target must remain writable");

const protectedEdit = runHook("pre-tool", "codex", editPayload("examples/reference/demo.js"));
assert.equal(protectedEdit.status, 2, "protected structured edit must be blocked");
assert.match(protectedEdit.stderr, /命中项目只读路径/);

const protectedPatch = runHook("pre-tool", "gemini", {
  cwd: project,
  tool_name: "apply_patch",
  tool_input: {
    command: "*** Begin Patch\n*** Update File: examples/reference/demo.js\n@@\n-old\n+new\n*** End Patch\n",
  },
});
assert.equal(protectedPatch.status, 2, "protected apply_patch target must be blocked");

writeFileSync(path.join(project, ".odai", "hooks.json"), "{ nope", "utf8");
const invalidPolicy = runHook("pre-tool", "kimi", editPayload("src/index.js"));
assert.equal(invalidPolicy.status, 2, "invalid explicit policy must not fail silently");
assert.match(invalidPolicy.stderr, /策略无效/);

const checkScript = path.join(project, "check.mjs");
writeFileSync(checkScript, "process.exit(1);\n", "utf8");
mkdirSync(path.join(project, "src"), { recursive: true });
writeFileSync(path.join(project, "src", "index.js"), "export const value = 1;\n", "utf8");
writePolicy({
  version: 1,
  protectedPaths: [],
  checks: [
    {
      name: "fixture check",
      whenChanged: ["src/**"],
      run: [process.execPath, checkScript],
      timeoutSeconds: 5,
    },
  ],
});

const blockedStop = runHook("stop", "copilot", { cwd: project, stopHookActive: false });
assert.equal(blockedStop.status, 0, "Copilot stop uses structured block output");
assert.equal(JSON.parse(blockedStop.stdout).decision, "block");
assert.match(JSON.parse(blockedStop.stdout).reason, /fixture check/);

const activeStop = runHook("stop", "copilot", { cwd: project, stopHookActive: true });
assert.equal(activeStop.status, 0, "continued stop must not loop");
assert.equal(activeStop.stdout, "");

writeFileSync(checkScript, "process.exit(0);\n", "utf8");
const passedStop = runHook("stop", "codex", { cwd: project, stop_hook_active: false });
assert.equal(passedStop.status, 0, "passing declared check must allow stop");
assert.equal(passedStop.stdout, "");

// Symlink regression tests (V-002)

// Test 1: escaping the project root stays allowed by default, whatever the route.
const externalDir = temporaryRoot("odai-external-");
let symlinkAvailable = true;
try {
  symlinkSync(externalDir, path.join(project, "outside-link"));
} catch (error) {
  if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  symlinkAvailable = false;
  console.warn(`symlink hook assertions unavailable in this environment (${error.code})`);
}
writePolicy({ version: 1, protectedPaths: [], blockUnresolvedWrites: false, checks: [] });
for (const [label, target] of [
  ...(symlinkAvailable ? [["symlink", "outside-link/new-file.js"]] : []),
  ["absolute", path.join(externalDir, "new-file.js")],
  ["parent traversal", "../escape.js"],
]) {
  assert.equal(
    runHook("pre-tool", "claude", editPayload(target)).status,
    0,
    `${label} escape must stay allowed while blockOutsideWrites is off`,
  );
}

// Test 1b: with blockOutsideWrites on, every escape route is blocked alike.
writePolicy({ version: 1, protectedPaths: [], blockOutsideWrites: true, checks: [] });
for (const [label, target, pattern] of [
  ...(symlinkAvailable ? [["symlink", "outside-link/new-file.js", /经由符号链接指向项目根目录之外/]] : []),
  ["absolute", path.join(externalDir, "new-file.js"), /位于项目根目录之外/],
  ["parent traversal", "../escape.js", /位于项目根目录之外/],
]) {
  const escaped = runHook("pre-tool", "claude", editPayload(target));
  assert.equal(escaped.status, 2, `${label} escape must be blocked when blockOutsideWrites is on`);
  assert.match(escaped.stderr, pattern);
}
assert.equal(
  runHook("pre-tool", "claude", editPayload("src/index.js")).status,
  0,
  "blockOutsideWrites must not affect in-project writes",
);

// Test 1c: an unknown policy key is still rejected, so the new flag cannot be silently misspelled.
writePolicy({ version: 1, protectedPaths: [], blockOutsideWrite: true, checks: [] });
assert.match(runHook("pre-tool", "codex", editPayload("src/index.js")).stderr, /含未知字段/);

if (symlinkAvailable) {
// Test 2: write to an existing protected file through an internal symlink must be blocked
mkdirSync(path.join(project, "examples", "reference"), { recursive: true });
writeFileSync(path.join(project, "examples", "reference", "demo.js"), "// fixture\n", "utf8");
symlinkSync(path.join(project, "examples", "reference"), path.join(project, "link-to-ref"));
writePolicy({ version: 1, protectedPaths: ["examples/reference/**"], blockUnresolvedWrites: false, checks: [] });
const internalSymlinkProtected = runHook("pre-tool", "codex", editPayload("link-to-ref/demo.js"));
assert.equal(internalSymlinkProtected.status, 2, "protected file accessed through internal symlink must be blocked");
assert.match(internalSymlinkProtected.stderr, /命中项目只读路径/);

// Test 3: new protected file through an internal symlink must also be blocked
const internalSymlinkNewProtected = runHook("pre-tool", "codex", editPayload("link-to-ref/brand-new.js"));
assert.equal(internalSymlinkNewProtected.status, 2, "new protected file through internal symlink must be blocked");

// Test 4: write to an existing file through a symlink whose alias path is protected (but canonical target is not)
mkdirSync(path.join(project, "src"), { recursive: true });
writeFileSync(path.join(project, "src", "real.js"), "// fixture\n", "utf8");
symlinkSync(path.join(project, "src"), path.join(project, "protected-alias"));
writePolicy({ version: 1, protectedPaths: ["protected-alias/**"], blockUnresolvedWrites: false, checks: [] });
const aliasProtectedExisting = runHook("pre-tool", "codex", editPayload("protected-alias/real.js"));
assert.equal(aliasProtectedExisting.status, 2, "write through alias-protected symlink to existing file must be blocked");
assert.match(aliasProtectedExisting.stderr, /命中项目只读路径/);

// Test 5: write to a new file through a symlink whose alias path is protected (but canonical target is not)
const aliasProtectedNew = runHook("pre-tool", "codex", editPayload("protected-alias/new.js"));
assert.equal(aliasProtectedNew.status, 2, "write through alias-protected symlink to new file must be blocked");

// Test 6: an outside symlink pointing back into a protected directory must not bypass protectedPaths either.
symlinkSync(path.join(project, "examples", "reference"), path.join(externalDir, "into-project"));
writePolicy({ version: 1, protectedPaths: ["examples/reference/**"], blockUnresolvedWrites: false, checks: [] });
const inboundSymlinkProtected = runHook("pre-tool", "codex", editPayload(path.join(externalDir, "into-project", "demo.js")));
assert.equal(inboundSymlinkProtected.status, 2, "protected file reached through an outside symlink must be blocked");
assert.match(inboundSymlinkProtected.stderr, /命中项目只读路径/);

// A declared check must stay inside the project after resolving cwd aliases.
const checkCommand = [process.execPath, "-e", 'require("node:fs").writeFileSync("check-ran", "yes")'];
writePolicy({ version: 1, protectedPaths: [], checks: [
  { name: "outside check", always: true, cwd: "outside-link", run: checkCommand, timeoutSeconds: 5 },
] });
const outsideCheck = runHook("stop", "codex", { cwd: project });
assert.equal(outsideCheck.status, 0, "Codex Stop uses a structured rejection");
const outsideDecision = JSON.parse(outsideCheck.stdout || "{}");
assert.equal(outsideDecision.decision, "block", "Stop checks cannot escape through a cwd symlink");
assert.match(outsideDecision.reason, /cwd.*项目根/);
assert.equal(existsSync(path.join(externalDir, "check-ran")), false, "rejected check must not execute");
writePolicy({ version: 1, protectedPaths: [], checks: [
  { name: "inside check", always: true, cwd: "protected-alias", run: checkCommand, timeoutSeconds: 5 },
] });
const insideCheck = runHook("stop", "codex", { cwd: project });
assert.equal(insideCheck.status, 0, insideCheck.stderr);
assert.equal(readFileSync(path.join(project, "src/check-ran"), "utf8"), "yes");
}

const generatedRoot = temporaryRoot("odai-hook-adapters-");
const build = run(process.execPath, [builder, "--host", "all", "--out", generatedRoot]);
assert.equal(build.status, 0, build.stderr);

const codexHooks = readJson("codex/hooks/hooks.json");
const claudeHooks = readJson("claude/hooks/hooks.json");
const copilotHooks = readJson("copilot/.github/hooks/odai.json");
const geminiHooks = readJson("gemini/hooks/hooks.json");
const grokHooks = readJson("grok/hooks/hooks.json");
const kimiManifest = readJson("kimi/kimi.plugin.json");

assert.ok(codexHooks.hooks.PreToolUse && codexHooks.hooks.Stop);
assert.ok(claudeHooks.hooks.PreToolUse && claudeHooks.hooks.Stop);
assert.ok(copilotHooks.hooks.preToolUse && copilotHooks.hooks.agentStop);
assert.ok(geminiHooks.hooks.BeforeTool && geminiHooks.hooks.AfterAgent);
assert.ok(grokHooks.hooks.PreToolUse);
assert.equal(grokHooks.hooks.Stop, undefined, "Grok adapter must not claim a blocking Stop hook");
assert.deepEqual(
  kimiManifest.hooks.map((item) => item.event),
  ["PreToolUse", "Stop"],
);

console.log("odai hook runtime and six generated adapters are valid.");

function editPayload(filePath) {
  return {
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  };
}

function writePolicy(value) {
  writeFileSync(path.join(project, ".odai", "hooks.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runHook(action, host, payload) {
  return run(process.execPath, [hook, action, "--host", host], {
    cwd: project,
    input: JSON.stringify(payload),
  });
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(generatedRoot, relativePath), "utf8"));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}
