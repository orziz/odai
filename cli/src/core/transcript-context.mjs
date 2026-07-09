import {
  publicProviderSessions,
  publicRecentEntry,
  publicTranscriptResult,
  sanitizeResumedTaskArgv,
} from "./transcript-public.mjs";
import { normalizeProviderSession } from "../runtime/provider-session.mjs";
import { redactString } from "../runtime/redaction.mjs";

export function buildTranscriptResumeContext({ sessionId, transcriptPath, entries = [], tail = 20 } = {}) {
  const taskSubmissions = entries.filter((entry) => entry.type === "task-submit");
  const taskResults = entries.filter((entry) => entry.type === "task-result");
  const inheritedContext = entries.filter((entry) => entry.type === "session-resume" && entry.context?.status === "ready").at(-1)
    ?.context;
  const lastTask = taskSubmissions.at(-1);
  const lastResult = taskResults.at(-1);
  const hasLocalTask = Boolean(lastTask);
  return {
    status: "ready",
    sourceSessionId: hasLocalTask ? sessionId : inheritedContext?.sourceSessionId || sessionId,
    currentSessionId: sessionId,
    eventCount: entries.length,
    inheritedFromSessionId: hasLocalTask ? undefined : inheritedContext?.sourceSessionId,
    providerSessions: publicProviderSessions(
      lastResult?.result?.providerSessions || inheritedContext?.providerSessions || inheritedContext?.lastResult?.providerSessions,
    ),
    lastTaskArgv: hasLocalTask ? sanitizeResumedTaskArgv(lastTask.argv || []) : inheritedContext?.lastTaskArgv || [],
    lastResult: publicTranscriptResult(lastResult?.result || inheritedContext?.lastResult),
    recent: entries.slice(Math.max(0, entries.length - tail)).map(summarizeEntryForContext),
    notRestored: [
      "authorizations",
      "api-key-confirmation",
      "provider-command-confirmation",
      "shell-execution-confirmation",
      "network-execution-confirmation",
    ],
  };
}


export function buildTranscriptCompactContext({
  sessionId,
  transcriptPath,
  entries = [],
  tail = 50,
  maxRecent = 12,
  budgetTokens = 4000,
} = {}) {
  const resumeContext = buildTranscriptResumeContext({
    sessionId,
    transcriptPath,
    entries,
    tail,
  });
  const providerSessions = collectProviderSessions(entries);
  const recent = budgetRecentEntries(resumeContext.recent || [], {
    maxRecent,
    budgetTokens,
    reserved: estimateJsonTokens({
      lastTaskArgv: resumeContext.lastTaskArgv,
      lastResult: resumeContext.lastResult,
      files: collectFiles(entries).slice(0, 40),
    }),
  });
  return {
    status: "ready",
    kind: "session-compact-context",
    sourceSessionId: resumeContext.sourceSessionId,
    currentSessionId: resumeContext.currentSessionId,
    eventCount: entries.length,
    lastTaskArgv: resumeContext.lastTaskArgv,
    lastResult: resumeContext.lastResult,
    recentTasks: collectRecentTasks(entries),
    providers: collectProviders(entries),
    providerSessions: providerSessions.length > 0 ? providerSessions : resumeContext.providerSessions || [],
    files: collectFiles(entries).slice(0, 40),
    toolResults: collectToolResults(entries),
    authorizations: collectAuthorizations(entries),
    stopReasons: collectStopReasons(entries),
    recent,
    compressed: {
      budgetTokens,
      recentKept: recent.length,
      recentDropped: Math.max(0, (resumeContext.recent || []).length - recent.length),
    },
    notRestored: resumeContext.notRestored,
  };
}


export function budgetRecentEntries(entries = [], { maxRecent = 12, budgetTokens = 4000, reserved = 0 } = {}) {
  const recent = [];
  let used = Math.max(0, reserved);
  for (let i = entries.length - 1; i >= 0 && recent.length < maxRecent; i -= 1) {
    const entry = entries[i];
    const cost = estimateJsonTokens(entry);
    if (used + cost > budgetTokens && recent.length > 0) {
      break;
    }
    recent.unshift(entry);
    used += cost;
  }
  return recent;
}


export function estimateJsonTokens(value) {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(value || null).length / 4));
  } catch {
    return 32;
  }
}


export function collectStopReasons(entries = []) {
  const reasons = [];
  for (const entry of entries) {
    if (entry.type !== "task-result") continue;
    const stopReason = entry.result?.agentLoop?.stopReason || entry.result?.stopReason;
    if (stopReason) {
      reasons.push({
        stopReason,
        status: entry.result?.status,
        task: typeof entry.result?.task === "string" ? redactString(entry.result.task) : undefined,
      });
    }
  }
  return reasons.slice(-8);
}


export function summarizeEntryForContext(entry = {}) {
  if (entry.type === "progress") {
    return {
      type: entry.type,
      event: entry.event?.type,
      provider: entry.event?.provider,
      tool: entry.event?.result?.type,
      path: entry.event?.result?.path,
    };
  }
  if (entry.type === "task-result") {
    return {
      type: entry.type,
      status: entry.result?.status,
      task: typeof entry.result?.task === "string" ? redactString(entry.result.task) : entry.result?.task,
      provider: entry.result?.provider,
      providerSessions: publicProviderSessions(entry.result?.providerSessions),
    };
  }
  if (entry.type === "task-submit") {
    return {
      type: entry.type,
      argv: sanitizeResumedTaskArgv(entry.argv || []),
    };
  }
  return {
    type: entry.type,
    reason: entry.reason,
    command: entry.command,
    authorizationEvent: entry.type?.startsWith?.("authorization") || undefined,
  };
}


export function collectRecentTasks(entries = [], limit = 5) {
  return entries
    .filter((entry) => entry.type === "task-submit")
    .slice(-limit)
    .map((entry) => sanitizeResumedTaskArgv(entry.argv || []));
}


export function collectProviders(entries = []) {
  const providers = new Set();
  for (const entry of entries) {
    if (entry.type === "progress" && entry.event?.provider) {
      providers.add(entry.event.provider);
    }
    const provider = entry.result?.provider;
    if (entry.type === "task-result" && provider) {
      providers.add(typeof provider === "string" ? provider : provider.name);
    }
  }
  return [...providers].filter(Boolean).sort();
}


export function collectProviderSessions(entries = []) {
  const sessions = [];
  const seen = new Set();
  for (const entry of entries) {
    const candidates = entry.type === "task-result" && Array.isArray(entry.result?.providerSessions)
      ? entry.result.providerSessions
      : [];
    for (const session of candidates) {
      if (!session || typeof session !== "object") continue;
      const publicSession = normalizeProviderSession(session);
      const key = JSON.stringify(publicSession);
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push(publicSession);
    }
  }
  return sessions;
}


export function collectFiles(entries = []) {
  const files = new Set();
  for (const entry of entries) {
    const result = entry.type === "progress" ? entry.event?.result : undefined;
    if (result?.path) {
      files.add(result.path);
    }
  }
  return [...files].sort();
}


export function collectToolResults(entries = []) {
  const counts = {};
  const denials = {};
  for (const entry of entries) {
    const result = entry.type === "progress" ? entry.event?.result : undefined;
    if (!result) continue;
    if (result.type) {
      counts[result.type] = (counts[result.type] || 0) + 1;
    }
    if (result.gate) {
      denials[result.gate] = (denials[result.gate] || 0) + 1;
    }
  }
  return { counts, denials };
}


export function collectAuthorizations(entries = []) {
  let approvedCount = 0;
  let deniedCount = 0;
  for (const entry of entries) {
    if (entry.type === "authorization-result") {
      if (entry.approved) {
        approvedCount += 1;
      } else {
        deniedCount += 1;
      }
    }
    if (entry.type === "command-result" && entry.command === "authorize") {
      if (entry.result?.ok) {
        approvedCount += 1;
      } else {
        deniedCount += 1;
      }
    }
  }
  return {
    approvedCount,
    deniedCount,
    restoredOnResume: false,
  };
}

