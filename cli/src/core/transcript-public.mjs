import path from "node:path";
import {
  publicInputLine,
  publicTaskArgv,
  publicToolResult,
  publicUsage,
  redactString,
  redactUrl,
} from "../runtime/redaction.mjs";
import { normalizeProviderSession } from "../runtime/provider-session.mjs";

export function sanitizeResumedTaskArgv(argv = []) {
  return publicTaskArgv(argv);
}


export function publicTranscriptEntry(entry = {}, { workspaceRoot } = {}) {
  if (entry.type === "task-submit") {
    return {
      ...entry,
      argv: publicTaskArgv(entry.argv || []),
    };
  }
  if (entry.type === "session-start") {
    const { transcriptPath: _transcriptPath, ...publicEntry } = entry;
    return {
      ...publicEntry,
      initialTaskArgv: publicTaskArgv(entry.initialTaskArgv || []),
    };
  }
  if (entry.type === "task-result") {
    return {
      ...entry,
      result: publicTranscriptResult(entry.result),
    };
  }
  if (entry.type === "progress") {
    return {
      ...entry,
      event: publicProgressEvent(entry.event, { workspaceRoot }),
    };
  }
  if (entry.type === "session-resume") {
    return {
      ...entry,
      context: publicTranscriptContext(entry.context),
    };
  }
  if (entry.type === "authorization-prompt") {
    return {
      ...entry,
      scope: undefined,
    };
  }
  if (entry.type === "authorization-result") {
    return {
      ...entry,
      scope: undefined,
    };
  }
  if (entry.type === "command-result") {
    return publicCommandResultEntry(entry);
  }
  if (entry.type === "input") {
    return {
      ...entry,
      line: publicInputLine(entry.line || ""),
    };
  }
  return entry;
}


export function publicProgressEvent(event = {}, { workspaceRoot } = {}) {
  if (!event || typeof event !== "object") return event;
  if (event.type === "provider-text") {
    return {
      type: event.type,
      provider: typeof event.provider === "string" ? redactString(event.provider) : event.provider,
      model: typeof event.model === "string" ? redactString(event.model) : event.model,
      text: typeof event.text === "string" ? redactString(event.text) : event.text,
    };
  }
  if (event.type === "provider-usage") {
    return {
      type: event.type,
      provider: typeof event.provider === "string" ? redactString(event.provider) : event.provider,
      model: typeof event.model === "string" ? redactString(event.model) : event.model,
      usage: publicUsage(event.usage || event.usageMetadata) || {},
    };
  }
  if (event.type === "provider-meter") {
    return {
      type: event.type,
      provider: typeof event.provider === "string" ? redactString(event.provider) : event.provider,
      model: typeof event.model === "string" ? redactString(event.model) : event.model,
      turn: event.turn,
      phase: event.phase,
      elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : undefined,
      outputChars: Number.isFinite(event.outputChars) ? event.outputChars : undefined,
      estimatedInputTokens: Number.isFinite(event.estimatedInputTokens) ? event.estimatedInputTokens : undefined,
      estimatedOutputTokens: Number.isFinite(event.estimatedOutputTokens) ? event.estimatedOutputTokens : undefined,
      estimatedActiveTokens: Number.isFinite(event.estimatedActiveTokens) ? event.estimatedActiveTokens : undefined,
      estimatedThinkingTokens: Number.isFinite(event.estimatedThinkingTokens)
        ? event.estimatedThinkingTokens
        : undefined,
      estimatedTotalTokens: Number.isFinite(event.estimatedTotalTokens) ? event.estimatedTotalTokens : undefined,
      usage: publicUsage(event.usage) || {},
    };
  }
  if (event.type === "tool-result") {
    const result = publicToolResult(event.result || {});
    return {
      type: event.type,
      result: {
        ...result,
        path: result.path ? publicDisplayPath(result.path, workspaceRoot) : result.path,
      },
    };
  }
  return {
    type: event.type,
    turn: event.turn,
    provider: typeof event.provider === "string" ? redactString(event.provider) : event.provider,
  };
}


export function publicDisplayPath(value, workspaceRoot) {
  if (typeof value !== "string" || value === "") return value;
  const redacted = redactString(value);
  if (!workspaceRoot || !path.isAbsolute(redacted)) return redacted;
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, redacted);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return redactString(relative);
  }
  return redacted;
}


export function publicCommandResultEntry(entry = {}) {
  const command = typeof entry.command === "string" ? entry.command : undefined;
  return {
    ...entry,
    argv: Array.isArray(entry.argv) ? publicTaskArgv(entry.argv) : undefined,
    result: publicCommandResult(command, entry.result),
  };
}


export function publicCommandResult(command, result = {}) {
  if (command === "authorize") {
    return { ok: Boolean(result?.ok) };
  }
  if (command === "context" || command === "sessions") {
    return publicSessionCommandResult(result);
  }
  if (command === "policy") {
    return publicPolicyCommandResult(result);
  }
  if (command === "providers") {
    return publicProvidersCommandResult(result);
  }
  if (command === "models") {
    return publicModelsCommandResult(result);
  }
  if (command === "auth") {
    return publicAuthCommandResult(result);
  }
  if (command === "provider" || command === "model") {
    return publicProviderCommandResult(result);
  }
  if (command === "agents") {
    return publicAgentsCommandResult(result);
  }
  if (command === "init") {
    return publicInitCommandResult(result);
  }
  if (["doctor", "setup", "status", "audit", "evidence", "continue", "rollback"].includes(command)) {
    return publicTranscriptResult(result);
  }
  return publicGenericCommandResult(result);
}


export function publicSessionCommandResult(result = {}) {
  return {
    status: result?.status,
    sessionId: result?.sessionId,
    count: result?.count,
    entryCount: Array.isArray(result?.entries) ? result.entries.length : undefined,
    context: result?.context ? publicTranscriptContext(result.context) : undefined,
    note: typeof result?.note === "string" ? redactString(result.note) : result?.note,
    error: typeof result?.error === "string" ? redactString(result.error) : result?.error,
  };
}


export function publicPolicyCommandResult(result = {}) {
  return {
    shell: result?.shell
      ? {
          allowExecution: Boolean(result.shell.allowExecution),
          allowedCommandCount: Array.isArray(result.shell.allowedCommands) ? result.shell.allowedCommands.length : 0,
          sandboxMode: result.shell.sandbox?.mode,
        }
      : undefined,
    network: result?.network
      ? {
          allowRequests: Boolean(result.network.allowRequests),
          allowedHostCount: Array.isArray(result.network.allowedHosts) ? result.network.allowedHosts.length : 0,
          timeoutMs: result.network.timeoutMs,
        }
      : undefined,
    configErrorCount: Array.isArray(result?.configErrors) ? result.configErrors.length : undefined,
  };
}


export function publicProvidersCommandResult(result = {}) {
  const providers = Array.isArray(result?.providers) ? result.providers.map(publicProviderSummary) : [];
  return {
    credentials: publicBooleanMap(result?.credentials),
    local: publicBooleanMap(result?.local),
    commands: publicBooleanMap(result?.commands),
    packages: publicBooleanMap(result?.packages),
    providerCount: providers.length,
    availableCount: providers.filter((provider) => provider.available).length,
    providers,
    configErrorCount: Array.isArray(result?.configErrors) ? result.configErrors.length : undefined,
  };
}


export function publicModelsCommandResult(result = {}) {
  const models = Array.isArray(result?.models)
    ? result.models.map((model = {}) => ({
        label: typeof model.label === "string" ? redactString(model.label) : model.label,
        provider: typeof model.provider === "string" ? redactString(model.provider) : model.provider,
        model: typeof model.model === "string" ? redactString(model.model) : model.model,
        available: Boolean(model.available),
        blockedReason: typeof model.blockedReason === "string" ? redactString(model.blockedReason) : model.blockedReason,
        source: model.source,
        current: Boolean(model.current),
      }))
    : [];
  const providers = Array.isArray(result?.providers)
    ? result.providers.map((provider = {}) => ({
        name: provider.name,
        kind: provider.kind,
        auth: provider.auth,
        available: Boolean(provider.available),
        blockedReason: typeof provider.blockedReason === "string" ? redactString(provider.blockedReason) : provider.blockedReason,
        configuredModel: typeof provider.configuredModel === "string"
          ? redactString(provider.configuredModel)
          : provider.configuredModel,
        configuredModelSource: provider.configuredModelSource,
        acceptsModelOverride: Boolean(provider.acceptsModelOverride),
        source: publicProviderSourceSummary(provider.source),
      }))
    : [];
  return {
    status: result?.status,
    kind: result?.kind,
    summary: result?.summary,
    flags: result?.flags
      ? {
          useApiKey: Boolean(result.flags.useApiKey),
          useProviderCommand: Boolean(result.flags.useProviderCommand),
          model: typeof result.flags.model === "string" ? redactString(result.flags.model) : result.flags.model,
        }
      : undefined,
    modelCount: models.length,
    models,
    providerCount: providers.length,
    providers,
    configErrorCount: Array.isArray(result?.configErrors) ? result.configErrors.length : undefined,
  };
}


export function publicAuthCommandResult(result = {}) {
  return {
    status: result?.status,
    session: result?.session
      ? {
          useApiKey: Boolean(result.session.useApiKey),
          useProviderCommand: Boolean(result.session.useProviderCommand),
        }
      : undefined,
    reason: typeof result?.reason === "string" ? redactString(result.reason) : result?.reason,
    note: typeof result?.note === "string" ? redactString(result.note) : result?.note,
  };
}


export function publicProviderCommandResult(result = {}) {
  return {
    status: result?.status,
    provider: result?.provider,
    model: result?.model,
    requested: result?.requested,
    reason: typeof result?.reason === "string" ? redactString(result.reason) : result?.reason,
    note: typeof result?.note === "string" ? redactString(result.note) : result?.note,
    providerCount: Array.isArray(result?.providers) ? result.providers.length : undefined,
  };
}


export function publicAgentsCommandResult(result = {}) {
  const profiles = Array.isArray(result?.profiles)
    ? result.profiles.map((profile = {}) => ({
        name: profile.name,
        purpose: typeof profile.purpose === "string" ? redactString(profile.purpose) : profile.purpose,
        tools: profile.tools,
        providerRequirements: Array.isArray(profile.providerRequirements)
          ? profile.providerRequirements.map(String)
          : undefined,
        allowedOutputs: Array.isArray(profile.allowedOutputs) ? profile.allowedOutputs.map(String) : undefined,
        source: profile.source,
      }))
    : [];
  return {
    profileCount: profiles.length,
    profiles,
    configErrorCount: Array.isArray(result?.configErrors) ? result.configErrors.length : undefined,
  };
}


export function publicInitCommandResult(result = {}) {
  return {
    status: result?.status,
    createdCount: Array.isArray(result?.created) ? result.created.length : undefined,
    skippedCount: Array.isArray(result?.skipped) ? result.skipped.length : undefined,
    overwrittenCount: Array.isArray(result?.overwritten) ? result.overwritten.length : undefined,
    error: typeof result?.error === "string" ? redactString(result.error) : result?.error,
    note: typeof result?.note === "string" ? redactString(result.note) : result?.note,
  };
}


export function publicGenericCommandResult(result = {}) {
  if (!result || typeof result !== "object") return result;
  const publicResult = {};
  for (const key of ["status", "kind", "ok", "reason", "note", "error", "task", "provider", "language"]) {
    const value = result[key];
    if (value === undefined) continue;
    publicResult[key] = typeof value === "string" ? redactString(redactUrl(value)) : value;
  }
  return publicResult;
}


export function publicProviderSummary(provider = {}) {
  return {
    name: provider.name,
    kind: provider.kind,
    auth: provider.auth,
    available: Boolean(provider.available),
    blockedReason: typeof provider.blockedReason === "string" ? redactString(provider.blockedReason) : provider.blockedReason,
    capabilities: Array.isArray(provider.capabilities) ? provider.capabilities.map(String) : undefined,
    cost: provider.cost,
    source: publicProviderSourceSummary(provider.source),
  };
}


export function publicProviderSourceSummary(source = {}) {
  if (!source || typeof source !== "object") return undefined;
  const allowed = {};
  for (const key of [
    "type",
    "apiKeyEnv",
    "modelEnv",
    "apiKeyPresent",
    "modelPresent",
    "modelOverridePresent",
    "baseUrl",
    "command",
    "commandPresent",
    "confirmationFlag",
    "inputMode",
    "modelArgsPresent",
    "configured",
    "package",
    "packagePresent",
    "executableEnv",
    "executableConfigured",
  ]) {
    if (source[key] !== undefined) {
      allowed[key] = typeof source[key] === "string" ? redactString(redactUrl(source[key])) : source[key];
    }
  }
  return Object.keys(allowed).length > 0 ? allowed : undefined;
}


export function publicBooleanMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Boolean(item)]));
}


export function publicTranscriptContext(context = {}) {
  if (!context || typeof context !== "object") return context;
  return {
    status: context.status,
    kind: context.kind,
    sourceSessionId: context.sourceSessionId,
    currentSessionId: context.currentSessionId,
    eventCount: context.eventCount,
    inheritedFromSessionId: context.inheritedFromSessionId,
    providerSessions: publicProviderSessions(context.providerSessions),
    lastTaskArgv: publicTaskArgv(context.lastTaskArgv || []),
    lastResult: publicTranscriptResult(context.lastResult),
    recentTasks: Array.isArray(context.recentTasks) ? context.recentTasks.map((argv) => publicTaskArgv(argv || [])) : undefined,
    providers: Array.isArray(context.providers) ? context.providers.filter(Boolean).map(String).sort() : undefined,
    files: Array.isArray(context.files) ? [...context.files].filter(Boolean).map(String).sort() : undefined,
    toolResults: context.toolResults,
    recent: Array.isArray(context.recent) ? context.recent.map(publicRecentEntry) : undefined,
    notRestored: Array.isArray(context.notRestored) ? context.notRestored.map(String) : undefined,
  };
}


export function publicTranscriptResult(result = {}) {
  if (!result || typeof result !== "object") return result;
  return {
    status: result.status,
    kind: result.kind,
    task: typeof result.task === "string" ? redactString(result.task) : result.task,
    provider: typeof result.provider === "string" ? result.provider : result.provider?.name,
    summary: publicSimpleSummary(result.summary),
    blockerCount: Array.isArray(result.blockers) ? result.blockers.length : result.blockerCount,
    providerSessions: publicProviderSessions(result.providerSessions),
    requiredAuthorizationCount: Array.isArray(result.requiredAuthorizations)
      ? result.requiredAuthorizations.length
      : undefined,
    toolActions: Array.isArray(result.toolActions) ? result.toolActions.map(String) : undefined,
    subagentReviewCount: result.subagentReviewCount,
    note: typeof result.note === "string" ? redactString(redactUrl(result.note)) : result.note,
    error: typeof result.error === "string" ? redactString(redactUrl(result.error)) : result.error,
  };
}


export function publicSimpleSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return undefined;
  const publicSummary = {};
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      publicSummary[key] = typeof value === "string" ? redactString(value) : value;
    }
  }
  return publicSummary;
}


export function publicProviderSessions(sessions) {
  if (!Array.isArray(sessions)) return undefined;
  return sessions.map((session) => normalizeProviderSession(session)).filter(Boolean);
}


export function publicRecentEntry(entry = {}) {
  if (!entry || typeof entry !== "object") return entry;
  if (entry.type === "task-submit") {
    return {
      type: entry.type,
      argv: publicTaskArgv(entry.argv || []),
    };
  }
  if (entry.type === "task-result") {
    return {
      type: entry.type,
      status: entry.status,
      task: typeof entry.task === "string" ? redactString(entry.task) : entry.task,
      provider: typeof entry.provider === "string" ? entry.provider : entry.provider?.name,
      providerSessions: publicProviderSessions(entry.providerSessions),
    };
  }
  return {
    type: entry.type,
    reason: entry.reason,
    command: entry.command,
    authorizationEvent: entry.type?.startsWith?.("authorization") || undefined,
    event: entry.event,
    provider: entry.provider,
    tool: entry.tool,
    path: entry.path,
  };
}


export function safeName(value = "") {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || `session-${Date.now()}`;
}

