import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { assertNoSymlinkDescendants, resolveDshHome, resolveManagedDshHome } from "./installer.mjs";
import { acquireAgentOperationLock } from "./operation-lock.mjs";

interface PackageMetadata {
  name: string;
  version: string;
}

interface ProfileMetadata {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

interface ResolvedPackage {
  root?: string;
  version?: string;
  complete: boolean;
  issues: string[];
}

type CommandExecutor = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

export type AgentControlCenterStatus =
  | "absent"
  | "current"
  | "registry-upgrade"
  | "local-link"
  | "partial-drift"
  | "newer"
  | "unknown-source";

export interface AgentControlCenterOptions {
  dshHome?: string;
  profile?: string;
  packageSpec?: string;
  dshBin?: string;
  platform?: NodeJS.Platform;
  execute?: CommandExecutor;
}

export interface AgentControlCenterInspection {
  status: AgentControlCenterStatus;
  issues: string[];
  dshHome: string;
  profile: string;
  target: string;
  targetVersion: string;
  dependency?: string;
  installedVersion?: string;
  resolvedRoot?: string;
}

interface FileSnapshot {
  path: string;
  content?: Buffer;
}

interface ProfileSnapshot {
  files: FileSnapshot[];
  revision: string;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDirectory, moduleDirectory.endsWith(`${sep}build${sep}src`) ? "../.." : "..");
const parsedMetadata: unknown = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
if (!isRecord(parsedMetadata) || typeof parsedMetadata.name !== "string" || typeof parsedMetadata.version !== "string") {
  throw new Error("odai-dsh-agent package metadata is invalid for Control Center management");
}
const packageMetadata: PackageMetadata = { name: parsedMetadata.name, version: parsedMetadata.version };
const PROFILE_STATE_FILES = Object.freeze(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const EXACT_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function assertProfile(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new TypeError("profile must contain only letters, digits, dots, underscores, or hyphens");
  }
  return value;
}

async function optionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function profileMetadata(path: string): Promise<ProfileMetadata | undefined> {
  const source = await optionalFile(path);
  if (!source) return undefined;
  const parsed: unknown = JSON.parse(source.toString("utf8"));
  if (!isRecord(parsed)) throw new TypeError(`DSH profile package metadata ${path} must be an object`);
  const dependencies = isRecord(parsed.dependencies)
    ? Object.fromEntries(Object.entries(parsed.dependencies).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  const dsh = isRecord(parsed.dsh) && isRecord(parsed.dsh.profile)
    ? { profile: { bundles: Array.isArray(parsed.dsh.profile.bundles)
        ? parsed.dsh.profile.bundles.filter((entry): entry is string => typeof entry === "string")
        : undefined } }
    : undefined;
  return { dependencies, dsh };
}

async function lockDependencyIssues(target: string, dependency: string): Promise<string[]> {
  const source = await optionalFile(resolve(target, "pnpm-lock.yaml"));
  if (!source) return [];
  let parsed: unknown;
  try {
    parsed = parseYaml(source.toString("utf8"));
  } catch (error) {
    return [`profile lockfile is invalid YAML: ${errorMessage(error)}`];
  }
  if (!isRecord(parsed) || !isRecord(parsed.importers) || !isRecord(parsed.importers["."])) {
    return ["profile lockfile is missing the root importer"];
  }
  const importer = parsed.importers["."];
  const dependencies = isRecord(importer.dependencies) ? importer.dependencies : undefined;
  const entry = dependencies?.[packageMetadata.name];
  if (!isRecord(entry)) return [`profile lockfile is missing ${packageMetadata.name}`];
  const specifier = typeof entry.specifier === "string" ? entry.specifier : undefined;
  const version = typeof entry.version === "string" ? entry.version : undefined;
  const issues: string[] = [];
  if (specifier !== dependency) issues.push(`lockfile specifier ${specifier ?? "<missing>"} does not match dependency ${dependency}`);
  if (!version || (version !== dependency && !version.startsWith(`${dependency}(`))) {
    issues.push(`lockfile version ${version ?? "<missing>"} does not resolve dependency ${dependency}`);
  }
  return issues;
}

function localDependency(dependency: string): boolean {
  return /^(?:file|link|workspace):/iu.test(dependency)
    || /^\.{0,2}[/\\]/u.test(dependency)
    || /^[A-Za-z]:[/\\]/u.test(dependency)
    || dependency.endsWith(".tgz");
}

function exactRegistryVersion(dependency: string): string | undefined {
  return EXACT_VERSION_PATTERN.test(dependency) ? dependency : undefined;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly [number, number, number, string | undefined] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
    if (!match) throw new TypeError(`invalid exact package version ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) return difference;
  }
  if (a[3] === b[3]) return 0;
  if (a[3] === undefined) return 1;
  if (b[3] === undefined) return -1;
  return a[3].localeCompare(b[3]);
}

async function resolvedPackage(target: string): Promise<ResolvedPackage | undefined> {
  const manifestPath = resolve(target, "node_modules", packageMetadata.name, "package.json");
  const source = await optionalFile(manifestPath);
  if (!source) return undefined;
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    return { complete: false, issues: [`resolved package metadata is invalid JSON: ${errorMessage(error)}`] };
  }
  if (!isRecord(parsed) || parsed.name !== packageMetadata.name || typeof parsed.version !== "string") {
    return { complete: false, issues: ["resolved package metadata has the wrong name or version"] };
  }
  let root: string | undefined;
  try {
    root = await realpath(dirname(manifestPath));
  } catch (error) {
    issues.push(`cannot resolve installed package root: ${errorMessage(error)}`);
  }
  for (const relativePath of [
    "build/src/installer.mjs",
    "preset/odai/runtime/control-center-host.mjs",
    "preset/odai/runtime/control-center-runtime.mjs",
    "client/client.js",
  ]) {
    if (!await optionalFile(resolve(dirname(manifestPath), relativePath))) {
      issues.push(`resolved package is missing ${relativePath}`);
    }
  }
  return {
    ...(root ? { root } : {}),
    version: parsed.version,
    complete: issues.length === 0,
    issues,
  };
}

export async function inspectAgentControlCenter(
  options: AgentControlCenterOptions = {},
): Promise<AgentControlCenterInspection> {
  const dshHome = await resolveManagedDshHome(options.dshHome, false);
  const profile = assertProfile(options.profile ?? "web");
  await assertNoSymlinkDescendants(dshHome, `profiles/${profile}`);
  const target = resolve(dshHome, "profiles", profile);
  const metadata = await profileMetadata(resolve(target, "package.json"));
  const dependency = metadata?.dependencies?.[packageMetadata.name];
  const bundleCount = metadata?.dsh?.profile?.bundles?.filter((entry) => entry === packageMetadata.name).length ?? 0;
  const base = { dshHome, profile, target, targetVersion: packageMetadata.version };
  if (!dependency && bundleCount === 0) return { status: "absent", issues: [], ...base };

  const issues: string[] = [];
  if (!dependency) issues.push(`missing ${packageMetadata.name} profile dependency`);
  if (bundleCount === 0) issues.push(`missing ${packageMetadata.name} profile bundle entry`);
  if (bundleCount > 1) issues.push(`duplicate ${packageMetadata.name} profile bundle entries`);
  const installed = await resolvedPackage(target);
  if (!installed) issues.push(`resolved ${packageMetadata.name} package is missing from the profile install tree`);
  else issues.push(...installed.issues);
  const detail = {
    ...base,
    ...(dependency ? { dependency } : {}),
    ...(installed?.version ? { installedVersion: installed.version } : {}),
    ...(installed?.root ? { resolvedRoot: installed.root } : {}),
  };

  if (!dependency || bundleCount !== 1) return { status: "partial-drift", issues, ...detail };
  if (localDependency(dependency)) {
    issues.unshift(`profile dependency uses local source ${dependency}`);
    return { status: "local-link", issues, ...detail };
  }
  const declaredVersion = exactRegistryVersion(dependency);
  if (!declaredVersion) {
    issues.unshift(`profile dependency is not an exact registry version: ${dependency}`);
    return { status: "unknown-source", issues, ...detail };
  }
  const lockIssues = await lockDependencyIssues(target, dependency);
  if (lockIssues.length > 0) return { status: "partial-drift", issues: [...lockIssues, ...issues], ...detail };
  if (!installed?.version || !installed.complete) return { status: "partial-drift", issues, ...detail };
  if (installed.version !== declaredVersion) {
    issues.unshift(`resolved package version ${installed.version} does not match dependency ${declaredVersion}`);
    return { status: "partial-drift", issues, ...detail };
  }
  const order = compareVersions(installed.version, packageMetadata.version);
  if (order < 0) return { status: "registry-upgrade", issues, ...detail };
  if (order > 0) {
    issues.unshift(`installed registry version ${installed.version} is newer than this installer ${packageMetadata.version}`);
    return { status: "newer", issues, ...detail };
  }
  return { status: "current", issues: [], ...detail };
}

function runPluginCommand(
  action: "add" | "remove",
  operand: string,
  options: AgentControlCenterOptions,
): void {
  const dsh = options.dshBin ?? process.env.DSH_BIN ?? "dsh";
  const platform = options.platform ?? process.platform;
  const command = platform === "win32" && dsh === "dsh" ? "dsh.cmd" : dsh;
  const execute = options.execute ?? execFileSync;
  const processOptions: ExecFileSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: resolveDshHome(options.dshHome) },
    ...(platform === "win32" ? { shell: true } : {}),
  };
  const args = ["plugin", "--profile", assertProfile(options.profile ?? "web"), action, operand];
  if (action === "add") args.push("--save-exact");
  execute(command, args, processOptions);
}

async function captureProfile(target: string): Promise<ProfileSnapshot> {
  const files = await Promise.all(PROFILE_STATE_FILES.map(async (relativePath) => ({
    path: resolve(target, relativePath),
    content: await optionalFile(resolve(target, relativePath)),
  })));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path.split(/[\\/]/u).at(-1) ?? "state"}\0${file.content?.length ?? -1}\0`);
    if (file.content !== undefined) digest.update(file.content);
  }
  return { files, revision: digest.digest("hex") };
}

async function retainRollbackEvidence(
  dshHome: string,
  before: ProfileSnapshot,
  after: ProfileSnapshot,
  failure: string,
): Promise<string> {
  await assertNoSymlinkDescendants(dshHome, "odai/control-center-backups");
  const root = resolve(dshHome, "odai", "control-center-backups", `${Date.now()}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await assertNoSymlinkDescendants(dshHome, "odai/control-center-backups");
  for (const [name, snapshot] of [["before", before], ["after", after]] as const) {
    const snapshotRoot = resolve(root, name);
    await mkdir(snapshotRoot, { recursive: true });
    const states: Record<string, "present" | "missing"> = {};
    for (const file of snapshot.files) {
      const filename = file.path.split(/[\\/]/u).at(-1) ?? "state";
      states[filename] = file.content === undefined ? "missing" : "present";
      if (file.content !== undefined) await writeFile(resolve(snapshotRoot, filename), file.content);
    }
    await writeFile(resolve(snapshotRoot, "snapshot.json"), `${JSON.stringify({ revision: snapshot.revision, files: states }, null, 2)}\n`, "utf8");
  }
  await writeFile(resolve(root, "failure.txt"), `${failure}\n`, "utf8");
  return root;
}

async function changedProfileFailure(
  dshHome: string,
  before: ProfileSnapshot,
  after: ProfileSnapshot,
  detail: string,
  cause: unknown,
): Promise<Error> {
  try {
    const backupPath = await retainRollbackEvidence(dshHome, before, after, detail);
    return new Error(`${detail}\ncurrent profile state was preserved; recovery evidence retained at ${backupPath}`, { cause });
  } catch (evidenceError) {
    return new AggregateError(
      [cause, evidenceError],
      `${detail}\ncurrent profile state was preserved, but recovery evidence could not be retained`,
    );
  }
}

async function acquireControlCenterOperation(dshHome: string, profile: string): Promise<() => void> {
  await assertNoSymlinkDescendants(dshHome, "odai/locks");
  const lockRoot = resolve(dshHome, "odai", "locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkDescendants(dshHome, "odai/locks");
  return acquireAgentOperationLock(resolve(lockRoot, `control-center-${profile}.lock`), `Agent Control Center ${profile} operation`);
}

export async function installAgentControlCenter(
  options: AgentControlCenterOptions = {},
): Promise<Readonly<{
    operation: "installed" | "updated" | "repaired" | "unchanged";
    target: string;
    profile: string;
    dependency: string;
    previousStatus: AgentControlCenterStatus;
  }>> {
  const dshHome = await resolveManagedDshHome(options.dshHome, true);
  const profile = assertProfile(options.profile ?? "web");
  const operationOptions = { ...options, dshHome, profile };
  const releaseOperation = await acquireControlCenterOperation(dshHome, profile);
  try {
    return await installAgentControlCenterUnderLock(operationOptions);
  } finally {
    releaseOperation();
  }
}

async function installAgentControlCenterUnderLock(
  options: AgentControlCenterOptions,
): Promise<Readonly<{
    operation: "installed" | "updated" | "repaired" | "unchanged";
    target: string;
    profile: string;
    dependency: string;
    previousStatus: AgentControlCenterStatus;
  }>> {
  const current = await inspectAgentControlCenter(options);
  if (current.status === "current") {
    return Object.freeze({
      operation: "unchanged",
      target: current.target,
      profile: current.profile,
      dependency: current.dependency ?? "",
      previousStatus: current.status,
    });
  }
  if (current.status === "newer") {
    throw new Error(`refusing to downgrade Agent Control Center at ${current.target}: ${current.issues.join("; ")}`);
  }

  const snapshot = await captureProfile(current.target);
  const packageSpec = options.packageSpec ?? `${packageMetadata.name}@${packageMetadata.version}`;
  try {
    runPluginCommand("add", packageSpec, options);
    const installed = await inspectAgentControlCenter(options);
    if (installed.status !== "current" || !installed.dependency) {
      throw new Error(`DSH plugin manager did not install the exact Agent Control Center package: ${installed.issues.join("; ") || installed.status}`);
    }
    const operation = current.status === "absent"
      ? "installed"
      : current.status === "registry-upgrade"
        ? "updated"
        : "repaired";
    return Object.freeze({
      operation,
      target: installed.target,
      profile: installed.profile,
      dependency: installed.dependency,
      previousStatus: current.status,
    });
  } catch (error) {
    const after = await captureProfile(current.target);
    if (after.revision === snapshot.revision) {
      throw new Error(`${errorMessage(error)}; Control Center profile state remained unchanged`, { cause: error });
    }
    const detail = `install failed: ${errorMessage(error)}\nautomatic rollback was not attempted because profile ownership changed`;
    throw await changedProfileFailure(current.dshHome, snapshot, after, detail, error);
  }
}

export async function uninstallAgentControlCenter(
  options: AgentControlCenterOptions = {},
): Promise<Readonly<{ operation: "uninstalled" | "absent"; target: string; profile: string }>> {
  const initial = await inspectAgentControlCenter(options);
  if (initial.status === "absent") return Object.freeze({ operation: "absent", target: initial.target, profile: initial.profile });
  const operationOptions = { ...options, dshHome: initial.dshHome, profile: initial.profile };
  const releaseOperation = await acquireControlCenterOperation(initial.dshHome, initial.profile);
  try {
    const current = await inspectAgentControlCenter(operationOptions);
    if (current.status === "absent") return Object.freeze({ operation: "absent", target: current.target, profile: current.profile });
    if (current.status === "partial-drift") {
      throw new Error(`refusing to remove partially owned Control Center profile state at ${current.target}: ${current.issues.join("; ")}`);
    }
    const before = await captureProfile(current.target);
    try {
      runPluginCommand("remove", packageMetadata.name, operationOptions);
      const removed = await inspectAgentControlCenter(operationOptions);
      if (removed.status !== "absent") {
        throw new Error(`DSH plugin manager did not remove the Agent Control Center completely: ${removed.issues.join("; ") || removed.status}`);
      }
      return Object.freeze({ operation: "uninstalled", target: removed.target, profile: removed.profile });
    } catch (error) {
      const after = await captureProfile(current.target);
      if (after.revision === before.revision) throw error;
      const detail = `uninstall failed: ${errorMessage(error)}\nautomatic rollback was not attempted because profile ownership changed`;
      throw await changedProfileFailure(current.dshHome, before, after, detail, error);
    }
  } finally {
    releaseOperation();
  }
}
