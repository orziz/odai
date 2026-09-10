#!/usr/bin/env node

const RETIRED = "legacy-session-repair is retired for DSH 0.1.5-rc.1: adding ignorable markers cannot migrate v0 logs containing Odai events. No files were modified.";
const HELP = `Usage: odai-dsh-plugin legacy-session-repair [options]

This historical repair command is retired. DSH 0.1.5-rc.1 rejects unknown v0
historical events even when marked ignorable. This entry never opens or changes
session logs. Existing backups and historical package versions remain separate
from the current SDK support contract.

Options accepted for a clear retirement error:
  --dsh-home <path>
  --json
  --yes
  -h, --help         Show this help
`;

try {
  const argv = process.argv.slice(2);
  let help = false;
  let command = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--yes" || arg === "--json") continue;
    else if (arg === "--dsh-home") {
      const path = argv[++index];
      if (!path || path.startsWith("-") || path.trim() === "") throw new Error("--dsh-home requires a non-empty path");
    } else if (!command && arg === "legacy-session-repair") command = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (help) process.stdout.write(HELP);
  else throw new Error(RETIRED);
} catch (error) {
  process.stderr.write(`odai-dsh-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
