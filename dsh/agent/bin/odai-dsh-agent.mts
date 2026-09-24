#!/usr/bin/env node

import { readDshVersion } from "../src/dsh-version.mjs";
import {
  inspectAgentInstallation,
  installAgentPreset,
  moveLegacyAgentPreset,
  supportsDshVersion,
  SUPPORTED_DSH_RANGE,
  uninstallAgentPreset,
} from "../src/installer.mjs";

type Command = "install" | "status" | "uninstall" | "cleanup-legacy";

interface CliArguments {
  command?: Command;
  legacyControlCenter: boolean;
  deprecatedFlag?: string;
  dshHome?: string;
  profile?: string;
  json: boolean;
  help: boolean;
}

interface DisplayResult {
  status?: string;
  operation?: string;
  target: string;
  backup?: string;
  issues?: readonly string[];
  notice?: string;
  security?: string;
  legacy?: { status: string; target: string; issues: readonly string[] };
}

const HELP = `Usage: odai-dsh-agent <command> [options]

Installs the Odai agent preset for DSH ${SUPPORTED_DSH_RANGE} as a profile bundle. The
bundle declares the \`odai\` preset and the Control Center; the Control Center row can
be switched off in DSH's Plugins page, while the preset's own rows are read-only there.

Commands:
  install           Install or update the Odai bundle in a DSH profile
  status            Inspect the bundle and any preset directory left by older releases
  uninstall         Remove the bundle (refused while odai is the default preset)
  cleanup-legacy    Move the old $DSH_HOME/.agent-presets/odai directory into a backup

Options:
  --dsh-home <path>  Override DSH_HOME
  --profile <name>   DSH profile (default: web)
  --json             Print JSON
  -h, --help         Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.legacyControlCenter) {
    process.stderr.write("odai-dsh-agent: `control-center` commands now manage the whole Odai bundle; the Control Center is part of it.\n");
  }
  if (args.deprecatedFlag) {
    process.stderr.write(`odai-dsh-agent: ${args.deprecatedFlag} is ignored; the Control Center is part of the bundle and can be disabled in DSH's Plugins page.\n`);
  }
  if (args.help) {
    process.stdout.write(HELP);
  } else if (args.command === "install") {
    assertDshVersion();
    print(await installAgentPreset({ dshHome: args.dshHome, profile: args.profile }), args.json);
  } else if (args.command === "status") {
    const result = await inspectAgentInstallation({ dshHome: args.dshHome, profile: args.profile });
    print(result, args.json);
    if (result.status !== "absent" && result.status !== "current") process.exitCode = 2;
  } else if (args.command === "uninstall") {
    print(await uninstallAgentPreset({ dshHome: args.dshHome, profile: args.profile }), args.json);
  } else if (args.command === "cleanup-legacy") {
    print(await moveLegacyAgentPreset({ dshHome: args.dshHome }), args.json);
  } else {
    throw new Error("a command is required\n\n" + HELP);
  }
} catch (error) {
  process.stderr.write(`odai-dsh-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function assertDshVersion(): string {
  const dsh = process.env.DSH_BIN ?? "dsh";
  let actual: string;
  try {
    actual = readDshVersion({ dsh });
  } catch {
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

export function parseArgs(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = { json: false, help: false, legacyControlCenter: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--with-control-center" || arg === "--without-control-center") parsed.deprecatedFlag = arg;
    else if (arg === "--dsh-home") parsed.dshHome = requiredOptionValue(argv, ++index, "--dsh-home", "path");
    else if (arg === "--profile") parsed.profile = requiredOptionValue(argv, ++index, "--profile", "name");
    else if (!parsed.command && !parsed.legacyControlCenter && arg === "control-center") parsed.legacyControlCenter = true;
    else if (!parsed.command && (arg === "install" || arg === "status" || arg === "uninstall"
      || (arg === "cleanup-legacy" && !parsed.legacyControlCenter))) parsed.command = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.legacyControlCenter && !parsed.command && !parsed.help) {
    throw new Error("control-center requires install, status, or uninstall");
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
  } else {
    process.stdout.write(`${result.operation}: ${result.target}\n`);
    if (result.backup) process.stdout.write(`backup: ${result.backup}\n`);
    for (const issue of result.issues ?? []) process.stdout.write(`- ${issue}\n`);
  }
  if (result.legacy && result.legacy.status !== "absent") {
    process.stdout.write(`legacy preset directory (${result.legacy.status}, no longer read by DSH): ${result.legacy.target}\n`);
    process.stdout.write("run `odai-dsh-agent cleanup-legacy` to move it into a backup\n");
  }
  if (result.notice) process.stdout.write(`notice: ${result.notice}\n`);
  if (result.security) process.stdout.write(`security: ${result.security}\n`);
}
