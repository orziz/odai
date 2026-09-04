import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

interface ProcessCall {
  command: string;
  args: readonly string[];
  options: object;
}

import { spawnDsh, terminateDsh } from "./dsh-process.mjs";

const pluginRoot = resolve(import.meta.dirname, "..");

test("bundle patch resolves the packaged runtime through the package export", async () => {
  const metadata = JSON.parse(await readFile(resolve(pluginRoot, "package.json"), "utf8"));
  const patch = await readFile(resolve(pluginRoot, "cordis.patch.yml"), "utf8");

  assert.equal(metadata.name, "odai-dsh-plugin");
  assert.equal(metadata.main, "./runtime/index.mjs");
  assert.equal(metadata.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(metadata.exports["./client"], "./client/client.js");
  assert.equal(metadata.dsh.client.platform, "web");
  assert.ok(metadata.files.includes("client"));
  assert.match(patch, /name: odai-dsh-plugin/u);
  assert.match(patch, /mode: auto/u);
  assert.doesNotMatch(patch, /roles:|planner:|executor:|reviewer:|model:|reasoningEffort:|maxTokens:/u);
  assert.doesNotMatch(patch, /name: \.\/runtime/u);
  assert.equal(metadata.bin["odai-dsh-plugin"], "./build/bin/odai-dsh-plugin.mjs");
  assert.equal(metadata.engines.node, ">=22.15.0");
  assert.ok(metadata.files.includes("build/bin"));
  assert.equal(metadata.files.some((entry: string) => entry.includes("tests") || entry.includes("scripts")), false);
});

test("CLI exposes only the explicit legacy session repair command", () => {
  const bin = resolve(pluginRoot, "build/bin/odai-dsh-plugin.mjs");
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /odai-dsh-plugin legacy-session-repair/u);

  const retired = spawnSync(process.execPath, [bin, "repair-sessions"], { encoding: "utf8" });
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /unknown argument: repair-sessions/u);

  const runtimeLocated = spawnSync(process.execPath, [bin, "legacy-session-repair", "--dsh-home", pluginRoot], { encoding: "utf8" });
  assert.notEqual(runtimeLocated.status, 0);
  assert.match(runtimeLocated.stderr, /rerun legacy-session-repair with --yes/u);
  assert.doesNotMatch(runtimeLocated.stderr, /runtime is unavailable/u);

  const missingHome = spawnSync(process.execPath, [bin, "legacy-session-repair", "--dsh-home", "--yes"], { encoding: "utf8" });
  assert.notEqual(missingHome.status, 0);
  assert.match(missingHome.stderr, /--dsh-home requires a non-empty path/u);
});

test("DSH process spawn supports Windows npm command shims", () => {
  const calls: ProcessCall[] = [];
  const execute = (command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    return {};
  };

  spawnDsh("dsh", ["--profile", "web"], { cwd: pluginRoot }, {
    platform: "win32",
    execute,
  });
  spawnDsh("dsh", ["--profile", "web"], { cwd: pluginRoot }, {
    platform: "linux",
    execute,
  });
  spawnDsh("C:\\tools\\dsh.cmd", ["--profile", "web"], { cwd: pluginRoot }, {
    platform: "win32",
    execute,
  });

  assert.deepEqual(calls, [
    {
      command: "dsh.cmd",
      args: ["--profile", "web"],
      options: { cwd: pluginRoot, shell: true },
    },
    {
      command: "dsh",
      args: ["--profile", "web"],
      options: { cwd: pluginRoot },
    },
    {
      command: "C:\\tools\\dsh.cmd",
      args: ["--profile", "web"],
      options: { cwd: pluginRoot, shell: true },
    },
  ]);
});

test("Windows plugin probe terminates the DSH process tree", () => {
  const calls: ProcessCall[] = [];
  const child = { pid: 42, exitCode: null, kill() { throw new Error("taskkill should be preferred"); } };
  terminateDsh(child, {
    platform: "win32",
    execute(command, args, options) { calls.push({ command, args, options }); },
  });
  assert.deepEqual(calls, [{
    command: "taskkill",
    args: ["/pid", "42", "/T", "/F"],
    options: { stdio: "ignore" },
  }]);
});
