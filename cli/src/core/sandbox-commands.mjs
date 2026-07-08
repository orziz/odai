import { describeSandboxReadiness, runSandboxSmoke as executeSandboxSmoke } from "./sandbox-readiness.mjs";
import { hasFlag } from "./cli-args.mjs";

export function runSandboxReadiness({
  repoRoot: root = process.cwd(),
  platform,
  commandExists,
  sandboxProbe,
} = {}) {
  return describeSandboxReadiness({
    workspaceRoot: root,
    platform,
    commandExists,
    sandboxProbe,
  });
}

export async function runSandboxSmoke({
  repoRoot: root = process.cwd(),
  argv = [],
  platform,
  commandExists,
  sandboxProbe,
  runShellCommand,
} = {}) {
  return executeSandboxSmoke({
    workspaceRoot: root,
    allowShell: hasFlag(argv, "--allow-shell"),
    platform,
    commandExists,
    sandboxProbe,
    runShellCommand,
  });
}
