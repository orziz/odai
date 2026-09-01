#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = resolve(repoRoot, "skills/odai");
const runtimeSource = resolve(repoRoot, "dsh/runtime/build");
const clientSource = resolve(repoRoot, "dsh/client/build/client.js");
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
    prepareCopy(skillSource, resolve(skillRoot, "odai"), skillRoot),
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
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${label} must stay below the package root`);
  }
  return target;
}

async function prepareCopy(source, target, cleanRoot) {
  await rm(cleanRoot, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function prepareClient(target, packageName) {
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new Error("--client-package must be a non-empty package name");
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
  const rendered = source.replaceAll(marker, packageName.trim());
  if (rendered.includes(marker)) throw new Error(`failed to render ${marker} in ${entry}`);
  await writeFile(entry, rendered, "utf8");
}

async function assertCanonicalSkill() {
  const entry = await readFile(resolve(skillSource, "SKILL.md"), "utf8").catch(() => "");
  if (!entry.includes("name: odai")) {
    throw new Error(`expected canonical odai skill at ${skillSource}`);
  }
}
