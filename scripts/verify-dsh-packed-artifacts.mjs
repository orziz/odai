#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let [pluginTarballArg, agentTarballArg] = process.argv.slice(2);
let scratch;
if (!pluginTarballArg && !agentTarballArg) {
  scratch = mkdtempSync(resolve(tmpdir(), "odai-dsh-packed-verification-"));
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
  pluginTarballArg = pack(resolve(repoRoot, "dsh/plugin"), scratch, "Plugin");
  agentTarballArg = pack(resolve(repoRoot, "dsh/agent"), scratch, "Agent");
} else if (!pluginTarballArg || !agentTarballArg) {
  throw new Error("provide both Plugin and Agent tarballs, or neither to pack them automatically");
}

const runtimeFiles = await relativeFileMap(resolve(repoRoot, "dsh/runtime/build"));
const runtimeModules = [...runtimeFiles.keys()].filter((path) => path.endsWith(".mjs"));
const canonicalFiles = await relativeFileMap(resolve(repoRoot, "skills/odai"));
if (!runtimeModules.includes("index.mjs")) throw new Error("compiled runtime is missing index.mjs");
if (!canonicalFiles.has("SKILL.md") || !canonicalFiles.has("manifest.json")) {
  throw new Error("canonical Odai source is incomplete");
}

const clientTemplate = await readFile(resolve(repoRoot, "dsh/client/build/client.js"), "utf8");
if (!clientTemplate.includes("__ODAI_CLIENT_PACKAGE__")) {
  throw new Error("compiled DSH client is missing its package marker");
}
const pluginExpected = new Map([
  ...prefixed(runtimeFiles, "package/runtime"),
  ...prefixed(canonicalFiles, "package/skills/odai"),
  ...prefixed(await relativeFileMap(resolve(repoRoot, "dsh/plugin/build")), "package/build"),
  ["package/client/client.js", Buffer.from(clientTemplate.replaceAll("__ODAI_CLIENT_PACKAGE__", "odai-dsh-plugin"))],
  ["package/cordis.patch.yml", await readFile(resolve(repoRoot, "dsh/plugin/cordis.patch.yml"))],
  ["package/package.json", await readFile(resolve(repoRoot, "dsh/plugin/package.json"))],
  ["package/README.md", await readFile(resolve(repoRoot, "dsh/plugin/README.md"))],
  ["package/LICENSE", await readFile(resolve(repoRoot, "dsh/plugin/LICENSE"))],
]);
const agentExpected = new Map([
  ...prefixed(runtimeFiles, "package/preset/odai/runtime"),
  ...prefixed(canonicalFiles, "package/preset/odai/skills/odai"),
  ...prefixed(await relativeFileMap(resolve(repoRoot, "dsh/agent/build")), "package/build"),
  ["package/client/client.js", Buffer.from(clientTemplate.replaceAll("__ODAI_CLIENT_PACKAGE__", "odai-dsh-agent"))],
  ["package/control-center.cordis.patch.yml", await readFile(resolve(repoRoot, "dsh/agent/control-center.cordis.patch.yml"))],
  ["package/preset/odai/agent.cordis.yml", await readFile(resolve(repoRoot, "dsh/agent/preset/odai/agent.cordis.yml"))],
  ["package/preset/odai/preset.yml", await readFile(resolve(repoRoot, "dsh/agent/preset/odai/preset.yml"))],
  ["package/package.json", await readFile(resolve(repoRoot, "dsh/agent/package.json"))],
  ["package/README.md", await readFile(resolve(repoRoot, "dsh/agent/README.md"))],
  ["package/LICENSE", await readFile(resolve(repoRoot, "dsh/agent/LICENSE"))],
]);

const pluginEntries = await tarEntries(resolve(pluginTarballArg));
const agentEntries = await tarEntries(resolve(agentTarballArg));
verifyPackage("Plugin", pluginEntries, pluginExpected, "odai-dsh-plugin");
verifyPackage("Agent", agentEntries, agentExpected, "odai-dsh-agent");

process.stdout.write(`${JSON.stringify({
  pluginEntries: pluginEntries.files.size,
  agentEntries: agentEntries.files.size,
  runtimeFiles: runtimeFiles.size,
  runtimeModules: runtimeModules.length,
  canonicalFiles: canonicalFiles.size,
  packedArtifactsVerified: true,
  byteParityVerified: true,
  packageTargetsVerified: true,
}, null, 2)}\n`);

function pack(directory, destination, label) {
  const result = spawnSync("npm", ["pack", directory, "--pack-destination", destination], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} pack failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
  }
  const filename = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!filename) throw new Error(`${label} pack did not report a tarball`);
  const tarball = resolve(destination, filename);
  if (dirname(tarball) !== resolve(destination)) throw new Error(`${label} pack reported an unexpected tarball path`);
  return tarball;
}

function prefixed(files, prefix) {
  return [...files].map(([path, content]) => [`${prefix}/${path}`, content]);
}

function verifyPackage(label, archive, expected, expectedName) {
  if (archive.links.length > 0) {
    throw new Error(`${label} tarball contains link entries: ${archive.links.join(", ")}`);
  }
  const allowed = new Set(expected.keys());
  const missing = [...allowed].filter((path) => !archive.files.has(path));
  if (missing.length > 0) {
    throw new Error(`${label} tarball is incomplete; missing: ${missing.join(", ")}`);
  }
  const unexpected = [...archive.files.keys()].filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`${label} tarball contains unexpected files: ${unexpected.join(", ")}`);
  }
  for (const [path, expectedContent] of expected) {
    const actual = archive.files.get(path);
    if (!actual?.equals(expectedContent)) throw new Error(`${label} tarball content differs from the verified build input: ${path}`);
  }
  const sourceModules = [...archive.files.keys()].filter((path) => path.endsWith(".mts") && !path.endsWith(".d.mts"));
  if (sourceModules.length > 0) {
    throw new Error(`${label} tarball contains editable TypeScript sources: ${sourceModules.join(", ")}`);
  }
  const metadata = parsePackageMetadata(label, archive.files.get("package/package.json"), expectedName);
  for (const target of packageTargets(metadata)) {
    if (!archive.files.has(target)) throw new Error(`${label} package target is missing from tarball: ${target}`);
  }
}

function parsePackageMetadata(label, source, expectedName) {
  let metadata;
  try {
    metadata = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} package metadata is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.name !== expectedName) {
    throw new Error(`${label} package metadata has the wrong package name`);
  }
  return metadata;
}

function packageTargets(metadata) {
  const raw = [metadata.main, ...objectValues(metadata.bin), ...nestedStringValues(metadata.exports)];
  const patch = metadata.dsh?.bundle?.patch;
  if (typeof patch === "string") raw.push(patch);
  return [...new Set(raw.filter((value) => typeof value === "string").map(packageTarget))];
}

function objectValues(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.values(value) : [];
}

function nestedStringValues(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(nestedStringValues);
}

function packageTarget(value) {
  if (!value.startsWith("./")) throw new Error(`package target must be package-relative: ${value}`);
  const relative = posix.normalize(value.slice(2));
  if (!relative || relative === ".." || relative.startsWith("../")) {
    throw new Error(`package target escapes package root: ${value}`);
  }
  return `package/${relative}`;
}

async function relativeFileMap(root) {
  const files = new Map();
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.set(relative, await readFile(absolute));
      else throw new Error(`unsupported build input entry: ${absolute}`);
    }
  };
  await visit(root);
  return files;
}

async function tarEntries(tarballPath) {
  const archive = gunzipSync(await readFile(tarballPath));
  const files = new Map();
  const links = [];
  let offset = 0;
  let extendedPath;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const type = String.fromCharCode(header[156] || 0);
    const sizeText = tarText(header.subarray(124, 136)).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar size in ${tarballPath}`);
    const payloadStart = offset + 512;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > archive.length) throw new Error(`truncated tar entry in ${tarballPath}`);
    const payload = archive.subarray(payloadStart, payloadEnd);
    if (type === "x") {
      extendedPath = paxPath(payload.toString("utf8"));
    } else {
      const path = (extendedPath ?? (prefix ? `${prefix}/${name}` : name)).replace(/\/$/u, "");
      extendedPath = undefined;
      if (["1", "2"].includes(type)) links.push(path);
      else if (path && type !== "5") {
        if (files.has(path)) throw new Error(`duplicate tar entry in ${tarballPath}: ${path}`);
        files.set(path, Buffer.from(payload));
      }
    }
    offset = payloadStart + Math.ceil(size / 512) * 512;
  }
  return { files, links };
}

function tarText(buffer) {
  const nul = buffer.indexOf(0);
  return buffer.subarray(0, nul < 0 ? buffer.length : nul).toString("utf8");
}

function paxPath(text) {
  let offset = 0;
  while (offset < text.length) {
    const separator = text.indexOf(" ", offset);
    if (separator < 0) break;
    const length = Number.parseInt(text.slice(offset, separator), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(separator + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") return record.slice(equals + 1);
    offset += length;
  }
  return undefined;
}
