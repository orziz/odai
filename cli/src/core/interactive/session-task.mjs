import { publicTaskArgv } from "../../runtime/redaction.mjs";
import { compressConversationContext } from "../../runtime/context-compress.mjs";
import { hasOption, hasAnyOption } from "./args.mjs";
import { appendSessionAuthArgv } from "./session-auth.mjs";
import {
  createProgressMeter,
  formatAuthorizationResult,
  formatRunSummary,
  formatProgressEvent,
  summarizeTranscriptEvent,
  summarizeTranscriptResult,
} from "./session-format.mjs";

export async function runTaskWithInteractiveAuthorization({
  ask,
  write,
  statusLine,
  handleTask,
  handleAuthorize,
  recordTranscript,
  argv,
  taskContext,
  workspaceRoot,
}) {
  await recordTranscript?.({ type: "task-submit", argv: publicTaskArgv(argv) });
  const meter = createProgressMeter({
    statusLine,
    onMeterEvent: (event) =>
      recordTranscript?.({ type: "progress", event: summarizeTranscriptEvent(event, { workspaceRoot }) }),
  });
  const runOptions = {
    context: taskContext,
    onEvent: (event) => {
      meter.onEvent(event);
      const formatted = formatProgressEvent(event, { workspaceRoot });
      if (formatted) {
        meter.clearLine();
        write(formatted);
      }
      recordTranscript?.({ type: "progress", event: summarizeTranscriptEvent(event, { workspaceRoot }) });
    },
  };
  let result;
  try {
    result = await handleTask([...argv], runOptions);
  } finally {
    meter.stop();
  }
  meter.finish(result);
  write(formatRunSummary(result, { workspaceRoot }));
  await recordTranscript?.({ type: "task-result", result: summarizeTranscriptResult(result, { workspaceRoot }) });

  const scopes = Array.isArray(result?.requiredAuthorizations) ? result.requiredAuthorizations : [];
  if (scopes.length === 0 || !handleAuthorize) {
    return result;
  }

  const approved = [];
  for (const scope of scopes) {
    const answer = await askNext(ask, `authorize ${scope}? [y/N] `);
    await recordTranscript?.({ type: "authorization-prompt", scope, answered: answer !== undefined });
    if (answer === undefined) {
      return result;
    }
    if (isApprovalAnswer(answer)) {
      const authorization = await handleAuthorize([scope]);
      write(formatAuthorizationResult(authorization));
      await recordTranscript?.({ type: "authorization-result", scope, approved: Boolean(authorization?.ok) });
      if (authorization?.ok) {
        approved.push(scope);
      }
    } else {
      write(`authorization denied: ${scope}`);
      await recordTranscript?.({ type: "authorization-result", scope, approved: false });
      return result;
    }
  }

  if (approved.length !== scopes.length) {
    return result;
  }

  let retry;
  try {
    retry = await handleTask([...argv], runOptions);
  } finally {
    meter.stop();
  }
  meter.finish(retry);
  write(formatRunSummary(retry, { workspaceRoot }));
  await recordTranscript?.({ type: "task-result", retry: true, result: summarizeTranscriptResult(retry, { workspaceRoot }) });
  return retry;
}


export function buildNextTaskContext({ previousContext, argv = [], result, workspaceRoot = process.cwd(), contextWindowTokens } = {}) {
  if (!result) return previousContext;
  const recent = [];
  if (previousContext?.lastTaskArgv || previousContext?.lastResult) {
    recent.push({
      type: "task-pair",
      argv: previousContext.lastTaskArgv || [],
      status: previousContext.lastResult?.status,
      stopReason: previousContext.lastResult?.stopReason,
    });
  }
  if (Array.isArray(previousContext?.recent)) {
    recent.push(...previousContext.recent.slice(-12));
  }
  const next = {
    status: "ready",
    kind: "interactive-task-context",
    sourceSessionId: previousContext?.sourceSessionId,
    sourceTranscriptPath: previousContext?.sourceTranscriptPath,
    eventCount: previousContext?.eventCount,
    providerSessions: Array.isArray(result.providerSessions) ? result.providerSessions : previousContext?.providerSessions,
    lastTaskArgv: publicTaskArgv(argv),
    lastResult: summarizeTranscriptResult(result, { workspaceRoot }),
    recent,
    previous: previousContext
      ? {
          lastTaskArgv: previousContext.lastTaskArgv || [],
          lastResult: previousContext.lastResult,
          stopReason: previousContext.lastResult?.stopReason,
        }
      : undefined,
    notRestored: previousContext?.notRestored || [
      "authorizations",
      "api-key-confirmation",
      "provider-command-confirmation",
      "shell-execution-confirmation",
      "network-execution-confirmation",
    ],
  };
  // Keep interactive multi-turn memory bounded automatically.
  return compressConversationContext(next, {
    contextWindowTokens,
    maxRecent: 10,
    force: true,
  });
}


export function isApprovalAnswer(answer = "") {
  return ["y", "yes", "allow", "authorize", "approved"].includes(answer.trim().toLowerCase());
}


export async function askNext(ask, prompt) {
  try {
    return await ask(prompt);
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(error?.message || "")) {
      return undefined;
    }
    throw error;
  }
}


export function normalizeTaskArgv(
  argv = [],
  {
    defaultProvider = "auto",
    defaultModel,
    defaultReasoning,
    defaultContextWindowTokens,
    sessionAuth,
    skills = [],
  } = {},
) {
  const normalized = [...argv];
  if (!normalized.includes("--save")) {
    normalized.push("--save");
  }
  if (!normalized.includes("--agent-loop")) {
    normalized.push("--agent-loop");
  }
  if (!hasOption(normalized, "--provider")) {
    normalized.push("--provider", defaultProvider || "auto");
  }
  if (defaultModel && !hasOption(normalized, "--model")) {
    normalized.push("--model", defaultModel);
  }
  if (defaultReasoning && !hasAnyOption(normalized, ["--reasoning", "--reasoning-depth", "--reasoning-effort"])) {
    normalized.push("--reasoning", defaultReasoning);
  }
  if (
    Number.isFinite(defaultContextWindowTokens)
    && !hasAnyOption(normalized, ["--context", "--context-size", "--context-window"])
  ) {
    normalized.push("--context", String(defaultContextWindowTokens));
  }
  for (const skill of skills || []) {
    const name = String(skill || "").trim();
    if (!name || name === "odai") continue;
    const flag = "--skill";
    // Avoid duplicating the same skill flag pair.
    let present = false;
    for (let i = 0; i < normalized.length; i += 1) {
      if (normalized[i] === flag && normalized[i + 1] === name) {
        present = true;
        break;
      }
      if (String(normalized[i]).startsWith(`${flag}=`) && String(normalized[i]).slice(flag.length + 1) === name) {
        present = true;
        break;
      }
    }
    if (!present) {
      normalized.push(flag, name);
    }
  }
  return appendSessionAuthArgv(normalized, sessionAuth);
}

