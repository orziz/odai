#!/usr/bin/env node

import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = resolve(repoRoot, "skills/odai");
const runtimeSource = resolve(repoRoot, "dsh/runtime/build");
const clientSource = resolve(repoRoot, "dsh/client/build/client.js");
const IGNORED_OS_FILES = new Set([".DS_Store", "Thumbs.db"]);
const [command, ...argv] = process.argv.slice(2);
const options = parseOptions(argv);
const packageRoot = process.cwd();
const skillRoot = resolveTarget(packageRoot, options.skillRoot, "skill root");
const runtimeRoot = options.runtimeRoot
  ? resolveTarget(packageRoot, options.runtimeRoot, "runtime root")
  : undefined;
const clientRoot = options.clientRoot
  ? resolveTarget(packageRoot, options.clientRoot, "client root")
  : undefined;
if ((clientRoot === undefined) !== (options.clientPackage === undefined)) {
  throw new Error("--client-root and --client-package must be supplied together");
}

if (command === "prepare") {
  await assertCanonicalSkill();
  await Promise.all([
    prepareSkills(),
    runtimeRoot ? prepareCopy(runtimeSource, runtimeRoot, runtimeRoot) : undefined,
    clientRoot && options.clientPackage
      ? prepareClient(clientRoot, options.clientPackage)
      : undefined,
  ]);
  process.stdout.write(`prepared odai artifact files in ${packageRoot}\n`);
} else if (command === "clean") {
  await Promise.all([
    rm(skillRoot, { recursive: true, force: true }),
    runtimeRoot ? rm(runtimeRoot, { recursive: true, force: true }) : undefined,
    clientRoot ? rm(clientRoot, { recursive: true, force: true }) : undefined,
  ]);
  process.stdout.write(`cleaned odai artifact files in ${packageRoot}\n`);
} else {
  throw new Error("usage: package-odai-artifact.mjs <prepare|clean> --skill-root <path> [--runtime-root <path>] [--client-root <path> --client-package <name>]");
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skill-root") parsed.skillRoot = args[++index];
    else if (arg === "--runtime-root") parsed.runtimeRoot = args[++index];
    else if (arg === "--client-root") parsed.clientRoot = args[++index];
    else if (arg === "--client-package") parsed.clientPackage = args[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (typeof parsed.skillRoot !== "string" || parsed.skillRoot.trim() === "") {
    throw new Error("--skill-root must be a non-empty package-relative path");
  }
  return parsed;
}

function resolveTarget(root, value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty package-relative path`);
  }
  const target = resolve(root, value);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must stay below the package root`);
  }
  return target;
}

async function normalizePermissions(target) {
  const info = await stat(target);
  if (info.isDirectory()) {
    await chmod(target, 0o755);
    const entries = await readdir(target, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const child = resolve(target, entry.name);
      if (IGNORED_OS_FILES.has(entry.name)) {
        await rm(child, { force: true });
        return;
      }
      await normalizePermissions(child);
    }));
    return;
  }
  const executable = (info.mode & 0o111) !== 0;
  await chmod(target, executable ? 0o755 : 0o644);
}

async function prepareSkills() {
  await rm(skillRoot, { recursive: true, force: true });
  await mkdir(skillRoot, { recursive: true });
  await Promise.all(["odai", "odai-orchestration"].map(name => cp(resolve(repoRoot, "skills", name), resolve(skillRoot, name), { recursive: true })));
  await normalizePermissions(skillRoot);
}

async function prepareCopy(source, target, cleanRoot) {
  await rm(cleanRoot, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  await normalizePermissions(target);
}

async function prepareClient(target, packageName) {
  const trimmed = typeof packageName === "string" ? packageName.trim() : "";
  if (!trimmed || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(trimmed)) {
    throw new Error("--client-package must be a valid npm package name");
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const entry = resolve(target, "client.js");
  await cp(clientSource, entry);
  const source = await readFile(entry, "utf8");
  const marker = "__ODAI_CLIENT_PACKAGE__";
  if (!source.includes(marker)) {
    throw new Error(`expected at least one ${marker} marker in ${entry}`);
  }
  const rendered = source.split(marker).join(trimmed);
  if (rendered.includes(marker)) throw new Error(`failed to render ${marker} in ${entry}`);
  await writeFile(entry, rendered, { encoding: "utf8", mode: 0o644 });
  await normalizePermissions(target);
}

async function assertCanonicalSkill() {
  const entry = await readFile(resolve(skillSource, "SKILL.md"), "utf8").catch(() => "");
  if (!entry.includes("name: odai")) {
    throw new Error(`expected canonical odai skill at ${skillSource}`);
  }
}
