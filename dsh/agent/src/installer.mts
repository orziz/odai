import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import type {
  SessionCompatOptions,
  SessionCompatResult,
} from "../../runtime/build/session-compat.mjs";

interface PackageMetadata {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
}

export interface AgentInstallerOptions {
  presetId?: string;
  dshHome?: string;
  sourceRoot?: string;
  dshVersion?: string;
  confirmDshStopped?: boolean;
  processScanner?: SessionCompatOptions["processScanner"];
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

export const inject = ["connection", "llm"];

export async function apply(ctx: unknown, rawConfig: unknown = {}): Promise<void> {
  const moduleUrl = pathToFileURL(resolve(packageRoot, "preset/odai/runtime/control-center-host.mjs")).href;
  const host: unknown = await import(moduleUrl);
  if (!isRecord(host) || typeof host.apply !== "function") {
    throw new Error("odai-dsh-agent Control Center host artifact is invalid");
  }
  await host.apply(ctx, rawConfig);
}

const defaultSourceRoot = resolve(packageRoot, "preset/odai");
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
const DSH_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const peerRange = packageMetadata.peerDependencies["@deepseek-ai/dsh"];
if (!peerRange) throw new Error("odai-dsh-agent peer dependency is missing @deepseek-ai/dsh");
export const SUPPORTED_DSH_VERSIONS = Object.freeze(
  peerRange.split(/\s*\|\|\s*/u).filter(Boolean),
);
if (SUPPORTED_DSH_VERSIONS.length === 0 || SUPPORTED_DSH_VERSIONS.some((version) => !DSH_VERSION_PATTERN.test(version))) {
  throw new Error("odai-dsh-agent peer dependency must list exact supported DSH versions");
}
const SOURCE_DSH_VERSION = "0.1.2-alpha.4";
const LEGACY_DSH_VERSION = "0.1.1-rc.2";
if (!SUPPORTED_DSH_VERSIONS.includes(SOURCE_DSH_VERSION)
  || !SUPPORTED_DSH_VERSIONS.includes(LEGACY_DSH_VERSION)
  || SUPPORTED_DSH_VERSIONS.length !== 2) {
  throw new Error(`Odai Agent peer must target exactly ${LEGACY_DSH_VERSION} and source composition ${SOURCE_DSH_VERSION}`);
}
export const SUPPORTED_DSH_VERSION = SOURCE_DSH_VERSION;
const requiredFiles = Object.freeze([
  "agent.cordis.yml",
  "preset.yml",
  "runtime/index.mjs",
  "runtime/session-compat.mjs",
  "runtime/session-evidence.mjs",
  "runtime/skill-bundle.mjs",
  "runtime/skill-evolution.mjs",
  "runtime/skill-selection-state.mjs",
  "runtime/skill-selector.mjs",
  "runtime/skill-source-config.mjs",
  "skills/odai/SKILL.md",
  "skills/odai/manifest.json",
]);

function replaceRequired(value: string, oldString: string, newString: string, label: string): string {
  if (!value.includes(oldString)) throw new Error(`agent source composition is missing ${label}`);
  return value.replace(oldString, newString);
}

export function renderAgentCompositionForDsh(composition: string, dshVersion = SUPPORTED_DSH_VERSION): string {
  if (typeof composition !== "string" || composition.trim() === "") {
    throw new TypeError("agent composition must be a non-empty string");
  }
  if (!SUPPORTED_DSH_VERSIONS.includes(dshVersion)) {
    throw new Error(`unsupported DSH version ${dshVersion || "<empty>"}; expected one of ${SUPPORTED_DSH_VERSIONS.join(", ")}`);
  }
  let rendered = composition.replace(/\r\n/gu, "\n");
  if (dshVersion === SOURCE_DSH_VERSION) return rendered;

  rendered = replaceRequired(rendered, [
    "# The goal service and session driver stay on the host plane, where the Gateway",
    "# can resolve them. The human command and model-facing tool register into this",
    "# preset's scoped layers.",
    "- id: command-goal",
    "  name: '@deepseek-ai/dsh-command-goal'",
  ].join("\n") + "\n\n", [
    "# Only the model-facing tool. The goal SERVICE, its session driver, and the",
    "# `/goal` command stay on the host plane: the Gateway serves the goal domain as",
    "# Remote endpoints whose receiver comes from a generated descriptor, so it",
    "# resolves `goals` on the host and an entry-local realm here would hide it. The",
    "# registry is keyed by session anyway, so one host instance serves every",
    "# session. What a preset chooses is whether its agent can call the goal tool.",
  ].join("\n") + "\n", "alpha.4 goal command block");
  rendered = replaceRequired(rendered, "- id: delegation\n", [
    "#",
    "# `tool-subagent-report` is host-plane for the same reason as the registry,",
    "# not because a preset may not want it: it registers a CONTINUABLE SETUP on",
    "# that singleton rather than a tool this agent calls, and the setup list is",
    "# not scope-aware — one copy per mounted preset means every child gets",
    "# `report` registered once per live session, which throws on the second.",
    "- id: delegation",
  ].join("\n") + "\n", "alpha.4 send_message host guidance");
  rendered = replaceRequired(rendered, "        modelSelectionSettings: true\n", "", "alpha.4 spawn model selection setting");
  rendered = replaceRequired(rendered, [
    "    # Fork omits model selection so provider/model stay equal to the parent and",
    "    # the inherited history remains eligible for KV Cache reuse. This preset",
    "    # keeps fork continuable; parent and child inherit the same messaging tool,",
    "    # while the parent id and return guidance follow the inherited history.",
  ].join("\n") + "\n", "", "alpha.4 fork messaging guidance");
  rendered = replaceRequired(rendered, "    fetch: true\n", "    fetch: false\n", "alpha.4 web fetch setting");
  return rendered;
}

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

export async function inspectAgentInstallation(options: AgentInstallerOptions = {}) {
  const presetId = assertPresetId(options.presetId ?? DEFAULT_PRESET_ID);
  const dshHome = resolveDshHome(options.dshHome);
  const target = resolve(dshHome, ".agent-presets", presetId);
  const state = await inspectTarget(target, presetId);
  return Object.freeze({ dshHome, presetId, target, ...state });
}

export async function installAgentPreset(options: AgentInstallerOptions = {}) {
  const presetId = assertPresetId(options.presetId ?? DEFAULT_PRESET_ID);
  const dshHome = resolveDshHome(options.dshHome);
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot);
  const dshVersion = options.dshVersion ?? SUPPORTED_DSH_VERSION;
  if (!SUPPORTED_DSH_VERSIONS.includes(dshVersion)) {
    throw new Error(`unsupported DSH version ${dshVersion || "<empty>"}; expected one of ${SUPPORTED_DSH_VERSIONS.join(", ")}`);
  }
  const targetRoot = resolve(dshHome, ".agent-presets");
  const target = resolve(targetRoot, presetId);
  const current = await inspectTarget(target, presetId);
  const previousCompositionSize = current.status === "installed"
    ? Buffer.byteLength(await readFile(resolve(target, "agent.cordis.yml")))
    : undefined;

  if (current.status === "drifted") {
    throw new Error(`refusing to replace modified preset at ${target}: ${current.issues.join("; ")}`);
  }

  await assertSource(sourceRoot);
  const sessionCompatibility = await repairSessionCompatibility(
    dshHome,
    [sourceRoot],
    options.confirmDshStopped === true,
    options.processScanner,
  );
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const staging = resolve(targetRoot, `.${presetId}.tmp-${process.pid}-${randomUUID()}`);
  const backup = resolve(targetRoot, `.${presetId}.backup-${process.pid}-${randomUUID()}`);
  let backupCreated = false;

  try {
    await cp(sourceRoot, staging, { recursive: true, errorOnExist: true });
    await tightenTree(staging);
    const compositionPath = resolve(staging, "agent.cordis.yml");
    const composition = renderAgentCompositionForDsh(await readFile(compositionPath, "utf8"), dshVersion);
    let stampedComposition = `${composition.trimEnd()}\n# odai-dsh-agent generation ${packageMetadata.version}:${randomUUID()}\n`;
    // Supported DSH releases key standing generations by mtime and size, so size must change even on same-tick updates.
    if (previousCompositionSize === Buffer.byteLength(stampedComposition)) {
      stampedComposition += "# odai-dsh-agent generation size bump\n";
    }
    await writeFile(compositionPath, stampedComposition, "utf8");
    const files = await hashTree(staging);
    const manifest = {
      schemaVersion: 1,
      package: packageMetadata.name,
      version: packageMetadata.version,
      dshVersion,
      presetId,
      files,
    };
    const manifestPath = resolve(staging, MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await chmod(manifestPath, 0o600);

    if (current.status === "installed") {
      await rename(target, backup);
      backupCreated = true;
    }
    await rename(staging, target);
    if (backupCreated) {
      await rm(backup, { recursive: true, force: true });
      backupCreated = false;
    }

    return Object.freeze({
      operation: current.status === "installed" ? "updated" : "installed",
      dshHome,
      presetId,
      target,
      version: packageMetadata.version,
      dshVersion,
      trust: "user",
      security: "DSH user presets have the same privileges as shell access; install only reviewed preset code.",
      sessionCompatibility,
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (backupCreated) {
      const targetState = await pathState(target);
      if (targetState === "missing") await rename(backup, target);
    }
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}

export async function uninstallAgentPreset(options: AgentInstallerOptions = {}) {
  const inspected = await inspectAgentInstallation(options);
  if (inspected.status === "absent") {
    return Object.freeze({ operation: "absent", target: inspected.target, presetId: inspected.presetId });
  }
  if (inspected.status === "drifted") {
    throw new Error(`refusing to remove modified preset at ${inspected.target}: ${inspected.issues.join("; ")}`);
  }
  await assertPresetIsNotDefault(inspected.dshHome, inspected.presetId);
  const sessionCompatibility = await repairSessionCompatibility(
    inspected.dshHome,
    [defaultSourceRoot, inspected.target],
    options.confirmDshStopped === true,
    options.processScanner,
  );
  if (sessionCompatibility.failures.length > 0) {
    throw new Error(`refusing to uninstall before legacy Odai session evidence is made ignorable: ${sessionCompatibility.failures.map((failure) => `${failure.path}: ${failure.error}`).join("; ")}`);
  }
  await rm(inspected.target, { recursive: true, force: true });
  return Object.freeze({
    operation: "uninstalled",
    target: inspected.target,
    presetId: inspected.presetId,
    sessionCompatibility,
  });
}

async function assertPresetIsNotDefault(dshHome: string, presetId: string): Promise<void> {
  const settingsPath = resolve(dshHome, "settings.yaml");
  let text: string;
  try {
    text = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  let settings: unknown;
  try {
    settings = parseYaml(text) ?? {};
  } catch (error) {
    throw new Error(`cannot verify the default agent preset in ${settingsPath}: ${errorMessage(error)}`);
  }
  const presets = isRecord(settings) ? settings["agent-presets"] : undefined;
  if (isRecord(presets) && presets.default === presetId) {
    throw new Error(`refusing to uninstall the default preset ${presetId}; select another agent-presets.default first`);
  }
}

async function inspectTarget(target: string, presetId: string): Promise<TargetInspection> {
  const state = await pathState(target);
  if (state === "missing") return { status: "absent", issues: [] };
  if (state !== "directory") return { status: "drifted", issues: ["target is not a regular directory"] };

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(resolve(target, MANIFEST_FILE), "utf8"));
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
  if (!isRecord(manifest) || manifest.presetId !== presetId) issues.push("managed manifest preset id mismatch");
  if (!isRecord(manifest) || !isRecord(manifest.files)
    || !Object.values(manifest.files).every((value) => typeof value === "string")) {
    issues.push("managed manifest file map is invalid");
  }
  return issues;
}

async function repairSessionCompatibility(
  dshHome: string,
  sourceRoots: readonly string[],
  confirmDshStopped: boolean,
  processScanner?: SessionCompatOptions["processScanner"],
): Promise<SessionCompatResult> {
  for (const sourceRoot of sourceRoots) {
    const modulePath = resolve(sourceRoot, "runtime/session-compat.mjs");
    if (await pathState(modulePath) !== "file") continue;
    const compatibility: {
      inspectLegacySessionLogs(options?: SessionCompatOptions): SessionCompatResult;
      repairLegacySessionLogs(options?: SessionCompatOptions): SessionCompatResult;
    } = await import(pathToFileURL(modulePath).href);
    if (typeof compatibility.inspectLegacySessionLogs !== "function"
      || typeof compatibility.repairLegacySessionLogs !== "function") {
      throw new Error(`agent package session compatibility module is invalid: ${modulePath}`);
    }
    const inspected = compatibility.inspectLegacySessionLogs({ dshHome });
    if (inspected.failures.length > 0) {
      throw new Error(`cannot inspect legacy Odai session evidence safely: ${inspected.failures.map((failure) => `${failure.path}: ${failure.error}`).join("; ")}`);
    }
    if (inspected.matchedEvents === 0) return inspected;
    if (!confirmDshStopped) {
      throw new Error(`found ${inspected.matchedEvents} legacy Odai session event(s); stop every DSH process and rerun with --yes before changing the Agent preset`);
    }
    const repaired = compatibility.repairLegacySessionLogs({
      dshHome,
      confirmDshStopped: true,
      processScanner,
    });
    if (repaired.failures.length > 0) {
      throw new Error(`cannot repair legacy Odai session evidence safely: ${repaired.failures.map((failure) => `${failure.path}: ${failure.error}`).join("; ")}`);
    }
    return repaired;
  }
  throw new Error("agent package is incomplete: missing runtime/session-compat.mjs");
}

async function assertSource(sourceRoot: string): Promise<void> {
  for (const path of requiredFiles) {
    const state = await pathState(resolve(sourceRoot, path));
    if (state !== "file") throw new Error(`agent package is incomplete: missing ${path}`);
  }
}

async function tightenTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in managed preset: ${entry.name}`);
    if (entry.isDirectory()) await tightenTree(path);
    else if (entry.isFile()) await chmod(path, 0o600);
    else throw new Error(`unsupported filesystem entry in managed preset: ${entry.name}`);
  }
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
