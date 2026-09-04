#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { LegacySessionRepairOptions, LegacySessionRepairResult } from "../../runtime/build/legacy-session-repair.mjs";

interface CliArguments {
  command?: "legacy-session-repair";
  dshHome?: string;
  json: boolean;
  yes: boolean;
  help: boolean;
}

type RepairLegacySessionLogs = (options?: LegacySessionRepairOptions) => LegacySessionRepairResult;

const HELP = `Usage: odai-dsh-plugin legacy-session-repair [options]

Repair historical DSH session logs written by older Odai Agent or Plugin versions.
The command adds the official ignorable marker to Odai-only audit events; it does
not delete messages or other session events. Stop DSH before running it; repair
also refuses when local DSH process inspection fails or finds an active process.

Options:
  --dsh-home <path>  Override DSH_HOME
  --json             Print JSON
  --yes              Confirm every DSH process is stopped; active processes still fail
  -h, --help         Show this help
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else {
    const packageRoot = [
      resolve(import.meta.dirname, ".."),
      resolve(import.meta.dirname, "../.."),
    ].find((candidate) => existsSync(resolve(candidate, "package.json")));
    const modulePath = packageRoot && [
      resolve(packageRoot, "runtime/legacy-session-repair.mjs"),
      resolve(packageRoot, "../runtime/build/legacy-session-repair.mjs"),
    ].find(existsSync);
    if (!modulePath) throw new Error("legacy session repair runtime is unavailable");
    const runtime: { repairLegacySessionLogs: RepairLegacySessionLogs } = await import(pathToFileURL(modulePath).href);
    const { repairLegacySessionLogs } = runtime;
    if (!args.yes) throw new Error("stop every DSH process, then rerun legacy-session-repair with --yes");
    const result = repairLegacySessionLogs({
      dshHome: args.dshHome,
      confirmDshStopped: true,
    });
    print(result, args.json);
    if (result.failures.length > 0) process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`odai-dsh-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = { json: false, yes: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--yes") parsed.yes = true;
    else if (arg === "--dsh-home") {
      const dshHome = argv[++index];
      if (!dshHome || dshHome.startsWith("-")) throw new Error("--dsh-home requires a non-empty path");
      parsed.dshHome = dshHome;
    }
    else if (!parsed.command && arg === "legacy-session-repair") parsed.command = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.help && parsed.command !== "legacy-session-repair") {
    throw new Error(`legacy-session-repair is required\n\n${HELP}`);
  }
  if (parsed.dshHome !== undefined && parsed.dshHome.trim() === "") {
    throw new Error("--dsh-home requires a non-empty path");
  }
  return parsed;
}

function print(result: LegacySessionRepairResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`scanned ${result.scannedArtifacts} session artifact(s)\n`);
  process.stdout.write(`repaired ${result.repairedEvents} Odai event(s) in ${result.repairedArtifacts} artifact(s)\n`);
  if (result.backupPaths.length > 0) process.stdout.write(`retained ${result.backupPaths.length} verified backup artifact(s)\n`);
  for (const path of result.tornArtifacts) process.stdout.write(`warning: preserved DSH-recoverable torn tail: ${path}\n`);
  for (const failure of result.failures) {
    process.stdout.write(`warning: ${failure.path}: ${failure.error}\n`);
  }
}
