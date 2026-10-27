import type { spawn } from "node:child_process";

export interface LocalCliRoute {
  backend: "local-cli";
  cli: "claude" | "codex" | "antigravity" | "grok";
  model: string;
  /** Validated by the selected CLI adapter. */
  reasoningEffort?: string;
  timeoutSeconds?: number;
  session?: "fresh" | "continue";
  provider?: never;
  maxTokens?: never;
}

export interface LocalCliInvocation {
  command: string;
  args: string[];
}

export interface LocalCliParsedResult {
  status: "completed" | "error";
  text: string;
  actualModel?: string;
  modelVerified: boolean;
  /** Unverified successful results stay completed so the host can choose its policy. */
  modelVerification: "verified" | "mismatch" | "missing";
  error?: string;
  usage?: Record<string, unknown>;
  /** Claude's reported API-equivalent cost; not evidence of a subscription charge. */
  cliReportedCostUsd?: number;
  reasoningEffortVerification: "verified" | "mismatch" | "requested-only";
  actualReasoningEffort?: string;
  sessionId?: string;
  deniedActionsCount?: number;
  boundaryStatus?: "boundary-violation";
  boundaryTools?: string[];
}

export interface LocalCliExecutionResult extends Omit<LocalCliParsedResult, "status"> {
  status: "completed" | "error" | "timeout" | "cancelled";
  durationMs: number;
  /** Actual process exit code, including zero on parsed-output failure; null if unavailable. */
  exitCode: number | null;
}

export interface ExecuteLocalCliOptions {
  route: LocalCliRoute;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam. Injected spawns use child.kill unless killProcess is also supplied. */
  spawnProcess?: typeof spawn;
  /** POSIX signal seam, called with a negative process-group ID; defaults to process.kill for native spawn. */
  killProcess?: (pid: number, signal: "SIGTERM" | "SIGKILL") => unknown;
  /** Time between SIGTERM and SIGKILL, default 1000 milliseconds. */
  killGraceMs?: number;
  /** Maximum stdout bytes, default 16 MiB. Stderr retains only its last 8 KiB. */
  maxOutputBytes?: number;
}

export interface LocalCliContext {
  sessionId?: string;
  resumeSessionId?: string;
  cwd?: string;
  prompt?: string;
  promptFile?: string;
  env?: NodeJS.ProcessEnv;
}

/** Throws TypeError for invalid routes; preserves omitted timeoutSeconds. */
export function validateLocalCliRoute(value: unknown): LocalCliRoute;
export function buildLocalCliInvocation(route: LocalCliRoute, env?: NodeJS.ProcessEnv, context?: LocalCliContext): LocalCliInvocation;
export function parseLocalCliResult(stdout: string, requestedRoute: string | LocalCliRoute, context?: LocalCliContext): LocalCliParsedResult;
/**
 * Input validation rejects; process, parse, timeout and cancellation failures return a result.
 * Native POSIX execution terminates the entire process group. Windows only terminates
 * the direct child; process-tree cleanup on Windows is not verified.
 */
export function executeLocalCli(options: ExecuteLocalCliOptions): Promise<LocalCliExecutionResult>;

export const AGY_READ_ONLY_TOOLS: readonly string[];
