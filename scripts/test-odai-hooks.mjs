#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(repoRoot, "skills", "odai", "scripts", "odai-hook.mjs");
const builder = path.join(repoRoot, "skills", "odai", "scripts", "build-hooks.mjs");
const project = mkdtempSync(path.join(os.tmpdir(), "odai-hooks-project-"));

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

const generatedRoot = mkdtempSync(path.join(os.tmpdir(), "odai-hook-adapters-"));
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
