#!/usr/bin/env node

import { promptForControlCenterInstall } from "../src/control-center-prompt.mjs";
import {
  inspectAgentControlCenter,
  installAgentControlCenter,
  uninstallAgentControlCenter,
} from "../src/control-center-installer.mjs";
import { readDshVersion } from "../src/dsh-version.mjs";
import {
  inspectAgentInstallation,
  installAgentPreset,
  supportsDshVersion,
  SUPPORTED_DSH_RANGE,
  uninstallAgentPreset,
} from "../src/installer.mjs";
interface CliArguments {
  command?: "install" | "status" | "uninstall" | "control-center";
  controlCenterCommand?: "install" | "status" | "uninstall";
  dshHome?: string;
  profile?: string;
  controlCenter?: boolean;
  json: boolean;
  help: boolean;
}

interface DisplayResult {
  status?: string;
  operation?: string;
  target: string;
  issues?: readonly string[];
  security?: string;
}

const HELP = `Usage: odai-dsh-agent <command> [options]

Commands:
  install                         Install or update the managed Odai preset
  status                          Inspect the managed Odai preset
  uninstall                       Remove the preset when its managed files are unchanged
  control-center install          Add the Agent package's Control Center to a DSH profile
  control-center status           Inspect the Agent Control Center profile state
  control-center uninstall        Remove only the Agent Control Center profile state

Options:
  --dsh-home <path>  Override DSH_HOME
  --profile <name>          Control Center profile (default: web)
  --with-control-center     Install Control Center without prompting
  --without-control-center  Skip the interactive Control Center prompt
  --json                    Print JSON; never prompts
  -h, --help                Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else if (args.command === "install") {
    const dshVersion = assertDshVersion();
    const preset = await installAgentPreset({
      dshHome: args.dshHome,
      dshVersion,
    });
    if (args.json) {
      const controlCenter = args.controlCenter === true
        ? await installAgentControlCenter({ dshHome: args.dshHome, profile: args.profile })
        : undefined;
      process.stdout.write(`${JSON.stringify({
        ...preset,
        ...(controlCenter ? { controlCenter } : {}),
      }, null, 2)}\n`);
    } else {
      print(preset, false);
      const installControlCenter = await shouldInstallControlCenter(args);
      if (installControlCenter) {
        print(await installAgentControlCenter({ dshHome: args.dshHome, profile: args.profile }), false);
      }
    }
  } else if (args.command === "status") {
    const result = await inspectAgentInstallation({ dshHome: args.dshHome });
    print(result, args.json);
    if (result.status === "drifted") process.exitCode = 2;
  } else if (args.command === "uninstall") {
    print(await uninstallAgentPreset({
      dshHome: args.dshHome,
    }), args.json);
  } else if (args.command === "control-center" && args.controlCenterCommand === "install") {
    print(await installAgentControlCenter({ dshHome: args.dshHome, profile: args.profile }), args.json);
  } else if (args.command === "control-center" && args.controlCenterCommand === "status") {
    const result = await inspectAgentControlCenter({ dshHome: args.dshHome, profile: args.profile });
    print(result, args.json);
    if (result.status !== "absent" && result.status !== "current") process.exitCode = 2;
  } else if (args.command === "control-center" && args.controlCenterCommand === "uninstall") {
    print(await uninstallAgentControlCenter({ dshHome: args.dshHome, profile: args.profile }), args.json);
  } else {
    throw new Error("a command is required\n\n" + HELP);
  }
} catch (error) {
  process.stderr.write(`odai-dsh-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function shouldInstallControlCenter(args: CliArguments): Promise<boolean> {
  if (args.controlCenter !== undefined) return args.controlCenter;
  const current = await inspectAgentControlCenter({ dshHome: args.dshHome, profile: args.profile });
  if (current.status === "current") {
    process.stdout.write(`Control Center registry ${current.installedVersion} 已准确安装，未修改：${current.target}\n`);
    return false;
  }
  if (current.status === "newer") {
    process.stdout.write(`Control Center ${current.installedVersion ?? current.dependency ?? "<unknown>"} 高于当前安装器 ${current.targetVersion}，禁止静默降级：${current.target}\n`);
    return false;
  }
  if (args.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`Control Center 状态为 ${current.status}，非交互安装未修改 Web profile；需要时显式传 --with-control-center。\n`);
    return false;
  }
  const action = current.status === "absent"
    ? `把 Odai Control Center registry ${current.targetVersion} 安装到 DSH profile “${current.profile}”`
    : current.status === "registry-upgrade"
      ? `把 DSH profile “${current.profile}” 的 Control Center 从 registry ${current.installedVersion ?? current.dependency ?? "<unknown>"} 升级到 ${current.targetVersion}`
      : current.status === "local-link"
        ? `把 DSH profile “${current.profile}” 的本地 Control Center 来源 ${current.dependency ?? current.resolvedRoot ?? "<unknown>"} 替换为 registry ${current.targetVersion}`
        : `修复 DSH profile “${current.profile}” 的 Control Center ${current.status} 状态并固定到 registry ${current.targetVersion}（${current.issues.join("；") || "来源无法确认"}）`;
  const accepted = await promptForControlCenterInstall(process.stdin, process.stdout, current.profile, action);
  if (!accepted) process.stdout.write("已跳过 Control Center，Web profile 未修改；稍后可运行 odai-dsh-agent control-center install。\n");
  return accepted;
}

function assertDshVersion(): string {
  const dsh = process.env.DSH_BIN ?? "dsh";
  let actual: string;
  try {
    actual = readDshVersion({ dsh });
  } catch (error) {
    throw new Error(`cannot run ${dsh} -V; install DSH ${SUPPORTED_DSH_RANGE} before installing the preset`);
  }
  if (!supportsDshVersion(actual)) {
    throw new Error(`unsupported DSH version ${actual || "<empty>"}; expected ${SUPPORTED_DSH_RANGE}`);
  }
  return actual;
}

function requiredOptionValue(argv: readonly string[], index: number, option: string, label: string): string {
  const value = argv[index];
  if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${option} requires a non-empty ${label}`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--with-control-center") {
      if (parsed.controlCenter === false) throw new Error("--with-control-center conflicts with --without-control-center");
      parsed.controlCenter = true;
    } else if (arg === "--without-control-center") {
      if (parsed.controlCenter === true) throw new Error("--without-control-center conflicts with --with-control-center");
      parsed.controlCenter = false;
    } else if (arg === "--dsh-home") parsed.dshHome = requiredOptionValue(argv, ++index, "--dsh-home", "path");
    else if (arg === "--profile") parsed.profile = requiredOptionValue(argv, ++index, "--profile", "name");
    else if (!parsed.command && (arg === "install" || arg === "status" || arg === "uninstall" || arg === "control-center")) parsed.command = arg;
    else if (parsed.command === "control-center" && !parsed.controlCenterCommand
      && (arg === "install" || arg === "status" || arg === "uninstall")) parsed.controlCenterCommand = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.dshHome !== undefined && parsed.dshHome.trim() === "") {
    throw new Error("--dsh-home requires a non-empty path");
  }
  if (parsed.profile !== undefined && parsed.profile.trim() === "") {
    throw new Error("--profile requires a non-empty name");
  }
  if (parsed.command === "control-center" && !parsed.controlCenterCommand && !parsed.help) {
    throw new Error("control-center requires install, status, or uninstall");
  }
  if (parsed.controlCenter !== undefined && parsed.command !== "install" && !parsed.help) {
    throw new Error("--with-control-center and --without-control-center are valid only with install");
  }
  return parsed;
}

function print(result: DisplayResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.status) {
    process.stdout.write(`${result.status}: ${result.target}\n`);
    for (const issue of result.issues ?? []) process.stdout.write(`- ${issue}\n`);
    return;
  }
  process.stdout.write(`${result.operation}: ${result.target}\n`);
  if (result.security) process.stdout.write(`security: ${result.security}\n`);
}
