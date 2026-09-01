import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDshHome } from "./installer.mjs";

interface PackageMetadata {
  name: string;
  version: string;
}

interface ProfileMetadata {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

type CommandExecutor = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

export interface AgentControlCenterOptions {
  dshHome?: string;
  profile?: string;
  packageSpec?: string;
  dshBin?: string;
  platform?: NodeJS.Platform;
  execute?: CommandExecutor;
}

export interface AgentControlCenterInspection {
  status: "absent" | "installed" | "drifted";
  issues: string[];
  dshHome: string;
  profile: string;
  target: string;
  dependency?: string;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDirectory, moduleDirectory.endsWith(`${sep}build${sep}src`) ? "../.." : "..");
const parsedMetadata: unknown = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
if (!isRecord(parsedMetadata) || typeof parsedMetadata.name !== "string" || typeof parsedMetadata.version !== "string") {
  throw new Error("odai-dsh-agent package metadata is invalid for Control Center management");
}
const packageMetadata: PackageMetadata = { name: parsedMetadata.name, version: parsedMetadata.version };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertProfile(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new TypeError("profile must contain only letters, digits, dots, underscores, or hyphens");
  }
  return value;
}

async function profileMetadata(path: string): Promise<ProfileMetadata | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
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

export async function inspectAgentControlCenter(
  options: AgentControlCenterOptions = {},
): Promise<AgentControlCenterInspection> {
  const dshHome = resolveDshHome(options.dshHome);
  const profile = assertProfile(options.profile ?? "web");
  const target = resolve(dshHome, "profiles", profile);
  const metadata = await profileMetadata(resolve(target, "package.json"));
  if (!metadata) return { status: "absent", issues: [], dshHome, profile, target };
  const dependency = metadata.dependencies?.[packageMetadata.name];
  const bundled = metadata.dsh?.profile?.bundles?.includes(packageMetadata.name) === true;
  if (!dependency && !bundled) return { status: "absent", issues: [], dshHome, profile, target };
  const issues: string[] = [];
  if (!dependency) issues.push(`missing ${packageMetadata.name} profile dependency`);
  if (!bundled) issues.push(`missing ${packageMetadata.name} profile bundle entry`);
  return {
    status: issues.length === 0 ? "installed" : "drifted",
    issues,
    dshHome,
    profile,
    target,
    ...(dependency ? { dependency } : {}),
  };
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
  execute(command, ["plugin", "--profile", assertProfile(options.profile ?? "web"), action, operand], processOptions);
}

export async function installAgentControlCenter(
  options: AgentControlCenterOptions = {},
): Promise<Readonly<{ operation: "installed" | "unchanged"; target: string; profile: string; dependency: string }>> {
  const current = await inspectAgentControlCenter(options);
  if (current.status === "drifted") {
    throw new Error(`refusing to replace drifted Control Center profile state at ${current.target}: ${current.issues.join("; ")}`);
  }
  if (current.status === "installed") {
    return Object.freeze({ operation: "unchanged", target: current.target, profile: current.profile, dependency: current.dependency ?? "" });
  }
  const packageSpec = options.packageSpec ?? `${packageMetadata.name}@${packageMetadata.version}`;
  runPluginCommand("add", packageSpec, options);
  const installed = await inspectAgentControlCenter(options);
  if (installed.status !== "installed" || !installed.dependency) {
    throw new Error(`DSH plugin manager did not install the Agent Control Center completely: ${installed.issues.join("; ") || installed.status}`);
  }
  return Object.freeze({ operation: "installed", target: installed.target, profile: installed.profile, dependency: installed.dependency });
}

export async function uninstallAgentControlCenter(
  options: AgentControlCenterOptions = {},
): Promise<Readonly<{ operation: "uninstalled" | "absent"; target: string; profile: string }>> {
  const current = await inspectAgentControlCenter(options);
  if (current.status === "absent") return Object.freeze({ operation: "absent", target: current.target, profile: current.profile });
  if (current.status === "drifted") {
    throw new Error(`refusing to remove drifted Control Center profile state at ${current.target}: ${current.issues.join("; ")}`);
  }
  runPluginCommand("remove", packageMetadata.name, options);
  const removed = await inspectAgentControlCenter(options);
  if (removed.status !== "absent") {
    throw new Error(`DSH plugin manager did not remove the Agent Control Center completely: ${removed.issues.join("; ") || removed.status}`);
  }
  return Object.freeze({ operation: "uninstalled", target: removed.target, profile: removed.profile });
}
