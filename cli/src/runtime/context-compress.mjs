/**
 * Conversation-context compression helpers.
 *
 * Default policy is conservative: small contexts pass through unchanged.
 * Compression runs when:
 * - caller sets compressContext: true / force: true, or
 * - estimated size exceeds the budget threshold (oversized auto-compress).
 *
 * Interactive multi-turn builders may force compress to keep session memory bounded.
 */

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 4000;
export const DEFAULT_MAX_RECENT_ENTRIES = 8;
export const DEFAULT_MAX_PREVIOUS_TOOL_RESULTS = 12;
/** Auto-compress only after the context reaches this fraction of the budget. */
export const DEFAULT_AUTO_COMPRESS_THRESHOLD = 0.75;

/**
 * Decide whether compression should run.
 */
export function shouldCompressConversationContext(context, {
  contextWindowTokens,
  budgetTokens,
  maxRecent = DEFAULT_MAX_RECENT_ENTRIES,
  compressContext,
  force = false,
  threshold = DEFAULT_AUTO_COMPRESS_THRESHOLD,
} = {}) {
  if (!context || typeof context !== "object") return false;
  if (force || compressContext === true) return true;
  if (compressContext === false) return false;

  const resolvedBudget = resolveBudgetTokens({ contextWindowTokens, budgetTokens });
  const recentLen = Array.isArray(context.recent) ? context.recent.length : 0;
  if (recentLen > maxRecent) return true;

  const used = estimateContextTokens({
    lastTaskArgv: context.lastTaskArgv,
    lastResult: context.lastResult,
    providerSessions: context.providerSessions,
    recent: context.recent,
    previous: context.previous,
    files: context.files,
  });
  return used >= Math.floor(resolvedBudget * threshold);
}

/**
 * Compress conversation context. Returns the original object when compression
 * is not needed, unless force/compressContext requests it.
 */
export function compressConversationContext(context, {
  contextWindowTokens,
  maxRecent = DEFAULT_MAX_RECENT_ENTRIES,
  budgetTokens,
  force = false,
  compressContext,
  threshold = DEFAULT_AUTO_COMPRESS_THRESHOLD,
} = {}) {
  if (!context || typeof context !== "object") {
    return context;
  }

  if (!shouldCompressConversationContext(context, {
    contextWindowTokens,
    budgetTokens,
    maxRecent,
    compressContext,
    force,
    threshold,
  })) {
    return context;
  }

  const resolvedBudget = resolveBudgetTokens({ contextWindowTokens, budgetTokens });

  // Skip rework only when already compressed under the same or tighter budget
  // and the recent tail is already within maxRecent.
  if (
    !force
    && context.compressed
    && Number.isFinite(context.compressed.budgetTokens)
    && context.compressed.budgetTokens <= resolvedBudget
    && Array.isArray(context.recent)
    && context.recent.length <= maxRecent
  ) {
    return context;
  }

  const recentSource = Array.isArray(context.recent) ? context.recent : [];
  const recent = [];
  let used = estimateContextTokens({
    lastTaskArgv: context.lastTaskArgv,
    lastResult: context.lastResult,
    providerSessions: context.providerSessions,
  });
  for (let i = recentSource.length - 1; i >= 0 && recent.length < maxRecent; i -= 1) {
    const entry = recentSource[i];
    const cost = estimateContextTokens(entry);
    if (used + cost > resolvedBudget && recent.length > 0) {
      break;
    }
    recent.unshift(entry);
    used += cost;
  }

  return {
    status: context.status || "ready",
    kind: context.kind || "compressed-task-context",
    sourceSessionId: context.sourceSessionId,
    currentSessionId: context.currentSessionId,
    sourceTranscriptPath: context.sourceTranscriptPath,
    eventCount: context.eventCount,
    providerSessions: Array.isArray(context.providerSessions)
      ? context.providerSessions.slice(-4)
      : context.providerSessions,
    lastTaskArgv: context.lastTaskArgv,
    lastResult: summarizeContextResult(context.lastResult),
    previous: summarizePreviousContext(context.previous),
    recent,
    files: Array.isArray(context.files) ? context.files.slice(0, 40) : context.files,
    toolResults: context.toolResults,
    authorizations: context.authorizations,
    stopReasons: Array.isArray(context.stopReasons) ? context.stopReasons.slice(-8) : context.stopReasons,
    notRestored: context.notRestored,
    compressed: {
      budgetTokens: resolvedBudget,
      usedTokens: used,
      recentKept: recent.length,
      recentDropped: Math.max(0, recentSource.length - recent.length),
      automatic: compressContext !== true && force !== true,
      forced: force === true || compressContext === true,
    },
  };
}

/**
 * Bound previous tool results only when they exceed the retention cap.
 */
export function compressPreviousToolResults(results = [], {
  maxResults = DEFAULT_MAX_PREVIOUS_TOOL_RESULTS,
  maxCharsPerResult = 4000,
  force = false,
} = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return results;
  }
  const needsTrim = force
    || results.length > maxResults
    || results.some((entry) => resultLooksOversized(entry, maxCharsPerResult));
  if (!needsTrim) {
    return results;
  }
  return results.slice(-Math.max(1, maxResults)).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const next = { ...entry };
    if (next.result && typeof next.result === "object") {
      next.result = trimToolResultValue(next.result, maxCharsPerResult);
    }
    return next;
  });
}

function resultLooksOversized(entry, maxChars) {
  const result = entry?.result;
  if (!result || typeof result !== "object") return false;
  for (const key of ["body", "stdout", "stderr", "content", "text"]) {
    if (typeof result[key] === "string" && result[key].length > maxChars) return true;
  }
  if (Array.isArray(result.entries) && result.entries.length > 50) return true;
  if (Array.isArray(result.matches) && result.matches.length > 30) return true;
  return false;
}

function resolveBudgetTokens({ contextWindowTokens, budgetTokens } = {}) {
  if (Number.isFinite(budgetTokens) && budgetTokens > 0) {
    return Math.floor(budgetTokens);
  }
  if (Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
    return Math.max(800, Math.floor(contextWindowTokens * 0.08));
  }
  return DEFAULT_CONTEXT_BUDGET_TOKENS;
}

function trimToolResultValue(result = {}, maxChars = 4000) {
  const next = { ...result };
  for (const key of ["body", "stdout", "stderr", "content", "text"]) {
    if (typeof next[key] === "string" && next[key].length > maxChars) {
      next[key] = `${next[key].slice(0, maxChars)}\n[truncated ${next[key].length - maxChars} chars]`;
      next.truncated = true;
    }
  }
  if (Array.isArray(next.entries) && next.entries.length > 50) {
    next.entries = next.entries.slice(0, 50);
    next.truncated = true;
  }
  if (Array.isArray(next.matches) && next.matches.length > 30) {
    next.matches = next.matches.slice(0, 30);
    next.truncated = true;
  }
  return next;
}

function summarizeContextResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    status: result.status,
    kind: result.kind,
    task: result.task,
    mode: result.mode,
    provider: result.provider,
    stopReason: result.agentLoop?.stopReason || result.stopReason,
    userPrompt: result.agentLoop?.userPrompt || result.userPrompt,
    completionSummary: result.completionSummary,
    toolActions: Array.isArray(result.toolActions) ? result.toolActions.slice(0, 12) : result.toolActions,
    providerSessions: Array.isArray(result.providerSessions)
      ? result.providerSessions.slice(-4)
      : result.providerSessions,
    requiredAuthorizationCount: Array.isArray(result.requiredAuthorizations)
      ? result.requiredAuthorizations.length
      : result.requiredAuthorizationCount,
    subagentReviewCount: result.subagentReviewCount,
    note: result.note,
  };
}

function summarizePreviousContext(previous) {
  if (!previous || typeof previous !== "object") return previous;
  return {
    lastTaskArgv: previous.lastTaskArgv,
    lastResult: summarizeContextResult(previous.lastResult),
    stopReason: previous.stopReason,
  };
}

export function estimateContextTokens(value) {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(value || null).length / 4));
  } catch {
    return 32;
  }
}
