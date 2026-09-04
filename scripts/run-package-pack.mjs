#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runPackagePack(options) {
  const packageRoot = resolve(options.packageRoot ?? process.cwd());
  const cleanRoots = (options.cleanRoots ?? []).map((value) => resolveCleanRoot(packageRoot, value));
  if (cleanRoots.length === 0) throw new Error("at least one --clean path is required");

  const runCommand = options.runCommand ?? spawnPack;
  try {
    return await runCommand(options.packArgs ?? [], packageRoot);
  } finally {
    await Promise.all(cleanRoots.map((path) => rm(path, { recursive: true, force: true })));
  }
}

function resolveCleanRoot(packageRoot, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--clean must be a non-empty package-relative path");
  }
  const target = resolve(packageRoot, value);
  const fromRoot = relative(packageRoot, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("--clean paths must stay below the package root");
  }
  return target;
}

export function packageManagerInvocation(
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
) {
  if (npmExecPath) return { command: process.execPath, prefixArgs: [npmExecPath], shell: false };
  return platform === "win32"
    ? { command: "npm.cmd", prefixArgs: [], shell: true }
    : { command: "npm", prefixArgs: [], shell: false };
}

function spawnPack(packArgs, packageRoot) {
  const invocation = packageManagerInvocation();
  const args = [...invocation.prefixArgs, "pack", ...packArgs];
  return new Promise((accept, reject) => {
    const child = spawn(invocation.command, args, {
      cwd: packageRoot,
      stdio: "inherit",
      ...(invocation.shell ? { shell: true } : {}),
    });
    child.once("error", reject);
    child.once("close", (code) => accept(code ?? 1));
  });
}

function parseArgs(argv) {
  const cleanRoots = [];
  const packArgs = [];
  let parsingPackArgs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (parsingPackArgs) packArgs.push(arg);
    else if (arg === "--") parsingPackArgs = true;
    else if (arg === "--clean") cleanRoots.push(argv[++index]);
    else throw new Error(`unknown runner argument: ${arg}`);
  }
  return { cleanRoots, packArgs };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = await runPackagePack({ ...parseArgs(process.argv.slice(2)), packageRoot: process.cwd() });
  if (code !== 0) process.exitCode = code;
}
