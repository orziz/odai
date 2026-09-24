import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { satisfies, valid, validRange } from "semver";

import { acquireAgentOperationLock } from "./operation-lock.mjs";

interface PackageMetadata {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
}

export interface AgentInstallerOptions {
  presetId?: string;
  dshHome?: string;
  profile?: string;
  packageSpec?: string;
  dshBin?: string;
  platform?: NodeJS.Platform;
  execute?: import("./control-center-installer.mjs").AgentControlCenterOptions["execute"];
}

interface ManagedManifest {
  schemaVersion: 1;
  package: string;
  version: string;
  dshVersion: string;
  presetId: string;
  files: Record<string, string>;
}

interface TargetInspection {
  status: "absent" | "installed" | "drifted";
  issues: string[];
  version?: string;
  dshVersion?: string;
  revision?: string;
}

type PathState = "missing" | "symlink" | "directory" | "file" | "other";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export const DEFAULT_PRESET_ID = "odai";
export const MANIFEST_FILE = ".odai-agent.json";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDirectory, moduleDirectory.endsWith(`${sep}build${sep}src`) ? "../.." : "..");

export const inject = ["connection", "llm", "webServer"];

export async function apply(ctx: unknown, rawConfig: unknown = {}): Promise<void> {
  const moduleUrl = pathToFileURL(resolve(packageRoot, "preset/odai/runtime/control-center-host.mjs")).href;
  const host: unknown = await import(moduleUrl);
  if (!isRecord(host) || typeof host.apply !== "function") {
    throw new Error("odai-dsh-agent Control Center host artifact is invalid");
  }
  await host.apply(ctx, rawConfig);
}

const parsedPackageMetadata: unknown = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
if (!isRecord(parsedPackageMetadata) || typeof parsedPackageMetadata.name !== "string"
  || typeof parsedPackageMetadata.version !== "string" || !isRecord(parsedPackageMetadata.peerDependencies)) {
  throw new Error("odai-dsh-agent package metadata is invalid");
}
const peerDependencies = Object.fromEntries(
  Object.entries(parsedPackageMetadata.peerDependencies).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const packageMetadata: PackageMetadata = {
  name: parsedPackageMetadata.name,
  version: parsedPackageMetadata.version,
  peerDependencies,
};
export const MINIMUM_DSH_VERSION = "0.1.7-rc.1";
const SOURCE_DSH_VERSION = "0.1.7-rc.1";
const peerRange = packageMetadata.peerDependencies["@deepseek-ai/dsh"];
if (peerRange !== "*" || validRange(peerRange) === null) {
  throw new Error("odai-dsh-agent must keep an open DSH peer; tested releases are not an allow-list");
}
// The old directory-based host cannot load this bundle. Newer releases, including
// prereleases, are admitted; actual bundle loading still validates host services.
export const SUPPORTED_DSH_RANGE = `>=${MINIMUM_DSH_VERSION}`;
// Historical export name: these are tested versions, never an admission list.
export const SUPPORTED_DSH_VERSIONS = Object.freeze([SOURCE_DSH_VERSION]);
export function supportsDshVersion(version: string): boolean {
  return valid(version) !== null && satisfies(version, SUPPORTED_DSH_RANGE, { includePrerelease: true });
}
export const SUPPORTED_DSH_VERSION = SOURCE_DSH_VERSION;

export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = configured ?? env.DSH_HOME ?? resolve(homedir(), ".dsh");
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("DSH home must be a non-empty path");
  }
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith(`~${sep}`)) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export async function resolveManagedDshHome(configured: string | undefined, create: boolean): Promise<string> {
  const requested = resolveDshHome(configured);
  const state = await pathState(requested);
  if (state === "missing") {
    if (!create) return requested;
    await mkdir(requested, { recursive: true, mode: 0o700 });
  } else if (state !== "directory" && state !== "symlink") {
    throw new Error(`DSH home is not a directory: ${requested}`);
  }
  const canonical = await realpath(requested);
  if (await pathState(canonical) !== "directory") throw new Error(`DSH home is not a regular directory: ${canonical}`);
  return canonical;
}

export async function assertNoSymlinkDescendants(root: string, relativePath: string): Promise<void> {
  if (relativePath.split(/[\\/]/u).some((segment) => segment === "..")) {
    throw new Error(`managed DSH path escapes its root: ${relativePath}`);
  }
  const rootState = await pathState(root);
  if (rootState === "missing") return;
  if (rootState !== "directory") throw new Error(`managed DSH root is not a regular directory: ${root}`);
  let current = root;
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    const state = await pathState(current);
    if (state === "missing") return;
    if (state === "symlink") throw new Error(`symbolic link is not allowed in managed DSH path: ${current}`);
    if (index < segments.length - 1 && state !== "directory") {
      throw new Error(`managed DSH parent is not a directory: ${current}`);
    }
  }
}

async function acquireLegacyOperation(dshHome: string, presetId: string): Promise<() => void> {
  await assertNoSymlinkDescendants(dshHome, "odai/locks");
  const lockRoot = resolve(dshHome, "odai", "locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkDescendants(dshHome, "odai/locks");
  return acquireAgentOperationLock(resolve(lockRoot, `agent-preset-${presetId}.lock`), `Agent preset ${presetId} operation`);
}

// DSH 0.1.7 registers presets only from bundle declarations. The Agent package is that
// bundle: installing it adds the `odai` preset and the Control Center to one profile.
// Loaded lazily so the host entry above never imports the package-manager lifecycle.
export async function installAgentPreset(options: AgentInstallerOptions = {}) {
  const { installAgentControlCenter } = await import("./control-center-installer.mjs");
  const result = await installAgentControlCenter(options);
  return Object.freeze({
    ...result,
    presetId: DEFAULT_PRESET_ID,
    notice: "DSH 0.1.7 does not carry an earlier agent-presets default forward; choose odai as the default preset in DSH if you want new sessions to start with it.",
    security: "DSH bundles run with the same privileges as the host process; install only reviewed packages.",
  });
}

export async function inspectAgentInstallation(options: AgentInstallerOptions = {}) {
  const { inspectAgentControlCenter } = await import("./control-center-installer.mjs");
  const bundle = await inspectAgentControlCenter(options);
  const legacy = await inspectLegacyAgentPreset(options);
  return Object.freeze({ ...bundle, presetId: DEFAULT_PRESET_ID, legacy });
}

export async function uninstallAgentPreset(options: AgentInstallerOptions = {}) {
  const { uninstallAgentControlCenter } = await import("./control-center-installer.mjs");
  return uninstallAgentControlCenter(options);
}

/** Inspect a preset directory that releases for DSH 0.1.5 copied into `.agent-presets`. */
export async function inspectLegacyAgentPreset(options: AgentInstallerOptions = {}) {
  const presetId = assertPresetId(options.presetId ?? DEFAULT_PRESET_ID);
  const dshHome = await resolveManagedDshHome(options.dshHome, false);
  await assertNoSymlinkDescendants(dshHome, ".agent-presets");
  const target = resolve(dshHome, ".agent-presets", presetId);
  const state = await inspectTarget(target, presetId);
  return Object.freeze({ dshHome, presetId, target, ...state });
}

/**
 * Move the legacy preset directory into a timestamped backup. Nothing is deleted:
 * DSH 0.1.7 no longer reads the directory, and the backup keeps any local edits.
 */
export async function moveLegacyAgentPreset(options: AgentInstallerOptions = {}) {
  const inspected = await inspectLegacyAgentPreset(options);
  if (inspected.status === "absent") {
    return Object.freeze({ operation: "absent", target: inspected.target, presetId: inspected.presetId });
  }
  const releaseOperation = await acquireLegacyOperation(inspected.dshHome, inspected.presetId);
  try {
    const current = await inspectTarget(inspected.target, inspected.presetId);
    if (current.status === "absent") {
      return Object.freeze({ operation: "absent", target: inspected.target, presetId: inspected.presetId });
    }
    await assertNoSymlinkDescendants(inspected.dshHome, "odai/legacy-preset-backups");
    const backupRoot = resolve(inspected.dshHome, "odai", "legacy-preset-backups", `${Date.now()}-${randomUUID()}`);
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await assertNoSymlinkDescendants(inspected.dshHome, "odai/legacy-preset-backups");
    const backup = resolve(backupRoot, inspected.presetId);
    await rename(inspected.target, backup);
    return Object.freeze({
      operation: "moved",
      target: inspected.target,
      backup,
      presetId: inspected.presetId,
      previousStatus: current.status,
      issues: current.issues,
    });
  } finally {
    releaseOperation();
  }
}

async function inspectTarget(target: string, presetId: string): Promise<TargetInspection> {
  const state = await pathState(target);
  if (state === "missing") return { status: "absent", issues: [] };
  if (state !== "directory") return { status: "drifted", issues: ["target is not a regular directory"] };

  let manifest: unknown;
  let manifestSource: Buffer;
  try {
    manifestSource = await readFile(resolve(target, MANIFEST_FILE));
    manifest = JSON.parse(manifestSource.toString("utf8"));
  } catch (error) {
    return { status: "drifted", issues: [`managed manifest is unavailable: ${errorMessage(error)}`] };
  }

  const issues = validateManifest(manifest, presetId);
  let actualFiles: Record<string, string> = {};
  try {
    actualFiles = await hashTree(target, { exclude: new Set([MANIFEST_FILE]) });
  } catch (error) {
    issues.push(errorMessage(error));
  }

  if (issues.length === 0 && isManagedManifest(manifest)) {
    const expectedFiles = manifest.files;
    for (const [path, hash] of Object.entries(expectedFiles)) {
      if (!(path in actualFiles)) issues.push(`missing managed file ${path}`);
      else if (actualFiles[path] !== hash) issues.push(`modified managed file ${path}`);
    }
    for (const path of Object.keys(actualFiles)) {
      if (!(path in expectedFiles)) issues.push(`unmanaged file ${path}`);
    }
  }

  return {
    status: issues.length === 0 ? "installed" : "drifted",
    issues,
    version: isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : undefined,
    dshVersion: isRecord(manifest) && typeof manifest.dshVersion === "string" ? manifest.dshVersion : undefined,
    revision: issues.length === 0 ? createHash("sha256").update(manifestSource).digest("hex") : undefined,
  };
}

function isManagedManifest(manifest: unknown): manifest is ManagedManifest {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || typeof manifest.package !== "string"
    || typeof manifest.version !== "string" || typeof manifest.dshVersion !== "string"
    || typeof manifest.presetId !== "string" || !isRecord(manifest.files)) return false;
  return Object.values(manifest.files).every((value) => typeof value === "string");
}

function validateManifest(manifest: unknown, presetId: string): string[] {
  const issues: string[] = [];
  if (!isRecord(manifest) || manifest.schemaVersion !== 1) issues.push("unsupported managed manifest schema");
  if (!isRecord(manifest) || manifest.package !== packageMetadata.name) issues.push("managed manifest package mismatch");
  if (!isRecord(manifest) || typeof manifest.version !== "string" || valid(manifest.version) === null) {
    issues.push("managed manifest version is invalid");
  }
  if (!isRecord(manifest) || typeof manifest.dshVersion !== "string" || valid(manifest.dshVersion) === null) {
    issues.push("managed manifest DSH version is invalid");
  }
  if (!isRecord(manifest) || manifest.presetId !== presetId) issues.push("managed manifest preset id mismatch");
  if (!isRecord(manifest) || !isRecord(manifest.files)
    || !Object.values(manifest.files).every((value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) {
    issues.push("managed manifest file map is invalid");
  }
  return issues;
}

async function hashTree(
  root: string,
  options: { exclude?: ReadonlySet<string> } = {},
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  await walk(root, "");
  return Object.fromEntries(Object.entries(found).sort(([left], [right]) => left.localeCompare(right)));

  async function walk(base: string, prefix: string): Promise<void> {
    const entries = await readdir(base, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (options.exclude?.has(relativePath)) continue;
      const absolutePath = resolve(base, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in managed preset: ${relativePath}`);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) found[relativePath] = await hashFile(absolutePath);
      else throw new Error(`unsupported filesystem entry in managed preset: ${relativePath}`);
    }
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pathState(path: string): Promise<PathState> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

function assertPresetId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new TypeError("preset id must contain only letters, digits, dots, underscores, or hyphens");
  }
  return value;
}
