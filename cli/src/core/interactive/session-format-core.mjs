import path from "node:path";
import {
  publicUsage,
  redactCommand,
  redactString,
  redactUrl,
} from "../../runtime/redaction.mjs";
import { formatContextWindowTokens } from "../../runtime/model-options.mjs";
import { formatSessionAuth } from "./session-auth.mjs";
import {
  estimateTokensFromText,
  formatUsageTokens,
} from "./session-tokens.mjs";

export function defaultInteractiveWrite(message) {
  process.stdout.write(`${message}\n`);
}



export function formatInteractiveStatus(result = {}) {
  if (typeof result?.note === "string" && result.note) return result.note;
  if (typeof result?.reason === "string" && result.reason) return result.reason;
  if (typeof result?.error === "string" && result.error) return result.error;
  return formatJson(result);
}



export function formatSessionCommandResult(result = {}, { command, argv = [] } = {}) {
  if (result?.status === "blocked" || result?.ok === false) {
    return formatInteractiveStatus(result);
  }
  if (argv.length === 0 && typeof result?.note === "string" && result.note.startsWith("Use /")) {
    return result.note;
  }
  if (command === "provider") {
    return `provider: ${result.provider || "auto"}`;
  }
  if (command === "model") {
    return `model: ${formatModelSelectionLabel(result)}`;
  }
  if (command === "reasoning") {
    return `reasoning: ${result.display || result.reasoning || "auto"}`;
  }
  if (command === "context") {
    return `context: ${result.display || formatContextWindowTokens(result.contextWindowTokens)}`;
  }
  if (command === "auth") {
    return `auth: ${formatSessionAuth(result.session)}`;
  }
  if (command === "settings") {
    return formatSessionSettings(result);
  }
  return formatInteractiveStatus(result);
}



export function formatAuthorizationResult(result = {}) {
  if (result?.ok === true) {
    return `authorized: ${redactString(result.scope || "ok")}`;
  }
  return formatInteractiveStatus(result);
}



export function formatModelSelectionLabel(result = {}) {
  if (result.selected) return result.selected;
  if (!result.model) return "auto";
  return result.model;
}



export function formatSessionSettings(result = {}) {
  return [
    `provider: ${result.provider || "auto"}`,
    `model: ${result.model || "auto"}`,
    `reasoning: ${result.reasoning || "auto"}`,
    `context: ${result.context || "auto"}`,
    `auth: ${formatSessionAuth(result.auth)}`,
  ].join("\n");
}



export function formatRunSummary(result = {}, { workspaceRoot = process.cwd() } = {}) {
  const savedPath = result.savedRecordPath
    ? `saved: ${formatDisplayPath(result.savedRecordPath, workspaceRoot)}`
    : result.recordPath
      ? `record: ${formatDisplayPath(result.recordPath, workspaceRoot)}`
      : "";
  const stopReason = result.agentLoop?.stopReason;
  const userPrompt = result.agentLoop?.userPrompt;
  const completionSummary = result.agentLoop?.completionSummary || result.agentLoop?.finalOutput?.summary;
  return [
    `status: ${result.status || "unknown"}`,
    result.task ? `task: ${redactString(result.task)}` : "",
    result.agentLoop?.agent?.provider
      ? `provider: ${result.agentLoop.agent.provider}`
      : result.subagent?.provider
        ? `provider: ${result.subagent.provider}`
        : "",
    stopReason ? `stop: ${redactString(String(stopReason))}` : "",
    Number.isFinite(result.maxTurns) ? `max-turns: ${result.maxTurns}` : "",
    userPrompt ? `needs-user: ${redactString(String(userPrompt))}` : "",
    completionSummary ? `complete: ${redactString(String(completionSummary))}` : "",
    formatRunModel(result),
    formatRunModelOptions(result),
    formatRunUsage(result),
    formatRunOutput(result),
    ...formatToolActions(result, { workspaceRoot }),
    Array.isArray(result.subagentReviews) && result.subagentReviews.length > 0
      ? `subagents: ${result.subagentReviews.length}`
      : "",
    Array.isArray(result.skill?.references) && result.skill.references.length > 0
      ? `skill-refs: ${result.skill.references.length}`
      : "",
    Array.isArray(result.requiredAuthorizations) && result.requiredAuthorizations.length > 0
      ? `authorization: ${result.requiredAuthorizations.map((scope) => `/authorize ${scope}`).join(", ")}`
      : "",
    savedPath,
    result.note ? `note: ${redactString(result.note)}` : "",
    result.error ? `error: ${formatErrorMessage(result.error)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}



export function formatProvidersResult(result = {}, { json = false } = {}) {
  if (json) {
    return formatJson(result);
  }
  const providers = Array.isArray(result.providers) ? result.providers : [];
  const available = providers.filter((provider) => provider.available !== false).length;
  const lines = [
    `providers: ${available}/${providers.length} available`,
  ];
  if (providers.length === 0) {
    lines.push("No providers are registered. Run odai init, then edit .odai/providers.json for custom providers.");
  } else {
    const nameWidth = Math.min(26, Math.max(...providers.map((provider) => String(provider.name || "").length), 8));
    const kindWidth = Math.min(18, Math.max(...providers.map((provider) => String(provider.kind || "").length), 4));
    lines.push(`${"name".padEnd(nameWidth)}  ${"state".padEnd(10)}  ${"kind".padEnd(kindWidth)}  auth`);
    lines.push(`${"-".repeat(nameWidth)}  ${"-".repeat(10)}  ${"-".repeat(kindWidth)}  ${"-".repeat(18)}`);
    for (const provider of providers) {
      const state = provider.available === false ? provider.blockedReason || "blocked" : "ready";
      const auth = provider.auth || provider.source?.type || "unknown";
      lines.push(
        [
          redactString(String(provider.name || "")).padEnd(nameWidth),
          redactString(String(state)).padEnd(10),
          redactString(String(provider.kind || "")).padEnd(kindWidth),
          redactString(String(auth)),
        ].join("  ").trimEnd(),
      );
    }
  }
  const errors = Array.isArray(result.configErrors) ? result.configErrors : [];
  if (errors.length > 0) {
    lines.push(`config errors: ${errors.length}`);
    for (const error of errors.slice(0, 4)) {
      lines.push(`  ${redactString(error.field || error.provider || "config")}: ${redactString(error.message || "")}`);
    }
    if (errors.length > 4) {
      lines.push(`  ... ${errors.length - 4} more`);
    }
  }
  lines.push("Use /provider select to switch, /models select to pick a model, or /providers --json for details.");
  lines.push("Use odai provider add|set|remove|clear to manage global providers, /provider path for file locations, or --workspace for project overrides.");
  return lines.join("\n");
}



export function formatRunModel(result = {}) {
  const model = result.agentLoop?.finalOutput?.model
    || result.agentLoop?.turns?.findLast?.((turn) => turn?.output?.model)?.output?.model
    || result.subagent?.model
    || result.model;
  return model ? `model: ${redactString(String(model))}` : "";
}



export function formatRunModelOptions(result = {}) {
  const options = result.modelOptions;
  if (!options || typeof options !== "object") return "";
  const parts = [];
  if (options.reasoning) parts.push(`reasoning ${redactString(String(options.reasoning))}`);
  if (Number.isFinite(options.contextWindowTokens)) {
    parts.push(`context ${formatContextWindowTokens(options.contextWindowTokens)}`);
  }
  return parts.length > 0 ? `model options: ${parts.join(", ")}` : "";
}



export function formatRunOutput(result = {}) {
  const text = result.agentLoop?.finalOutput?.text
    || result.agentLoop?.turns?.findLast?.((turn) => typeof turn?.output?.text === "string")?.output?.text
    || result.subagent?.text
    || result.text;
  const display = truncateDisplayText(redactString(String(text || "").trimEnd()));
  return display ? `output:\n${display}` : "";
}



export function formatRunUsage(result = {}) {
  const output = finalProviderOutput(result);
  const usage = publicUsage(output?.usage || output?.usageMetadata);
  const usageText = formatUsageTokens(usage);
  if (usageText) return `usage: ${usageText}`;
  const text = output?.text || result.text || "";
  const estimated = estimateTokensFromText(text);
  return estimated > 0 ? `usage: output ~${estimated} tok estimated` : "";
}



export function finalProviderOutput(result = {}) {
  return result.agentLoop?.finalOutput
    || result.agentLoop?.turns?.findLast?.((turn) => turn?.output)?.output
    || result.subagent
    || result;
}



export function truncateDisplayText(value = "", limit = 2000) {
  const text = String(value || "");
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}



export function formatErrorMessage(error) {
  if (typeof error === "string") return redactString(error);
  if (error && typeof error === "object") {
    return redactString(error.message || error.reason || JSON.stringify(error));
  }
  return redactString(String(error || ""));
}



export function formatToolActions(result = {}, { workspaceRoot = process.cwd() } = {}) {
  const turns = result.agentLoop?.turns || [];
  const actions = [];
  for (const turn of turns) {
    for (const toolResult of turn.toolResults || []) {
      actions.push(formatToolAction(toolResult, { workspaceRoot }));
    }
  }
  return actions.filter(Boolean).slice(0, 8);
}



export function formatToolAction(toolResult = {}, { workspaceRoot = process.cwd() } = {}) {
  if (toolResult.type === "list") {
    const displayPath = formatDisplayPath(toolResult.path, workspaceRoot);
    const count = Array.isArray(toolResult.entries) ? toolResult.entries.length : 0;
    return `tool: list ${displayPath || "."} ${count} entries${toolResult.truncated ? " truncated" : ""}`;
  }
  if (toolResult.type === "read") {
    const displayPath = formatDisplayPath(toolResult.path, workspaceRoot);
    return toolResult.ok === false
      ? `tool: read ${displayPath} failed ${redactString(toolResult.error || toolResult.reason || "")}`.trimEnd()
      : `tool: read ${displayPath}`;
  }
  if (toolResult.type === "search") {
    const displayPath = formatDisplayPath(toolResult.path, workspaceRoot);
    const count = Array.isArray(toolResult.matches) ? toolResult.matches.length : 0;
    return `tool: search ${displayPath || "."} ${count} matches${toolResult.truncated ? " truncated" : ""}`;
  }
  if (toolResult.type === "write") {
    return `tool: write ${formatDisplayPath(toolResult.path, workspaceRoot)}`;
  }
  if (toolResult.type === "shell") {
    const command = Array.isArray(toolResult.command)
      ? redactCommand(toolResult.command)?.join(" ")
      : redactString(toolResult.command || "");
    return `tool: shell ${command || ""}`.trimEnd();
  }
  if (toolResult.type === "network") {
    return `tool: network ${toolResult.method || "GET"} ${redactUrl(toolResult.url || "")} ${
      toolResult.status || ""
    }`.trimEnd();
  }
  if (toolResult.gate) {
    return `tool: blocked ${toolResult.gate} ${redactString(toolResult.reason || "")}`.trimEnd();
  }
  return "";
}



export function formatProgressEvent(event = {}, { workspaceRoot = process.cwd() } = {}) {
  if (event.type === "agent-turn-start") {
    return `agent: turn ${event.turn} ${event.provider}`;
  }
  if (event.type === "provider-text") {
    return `assistant: ${oneLine(redactString(event.text || ""))}`;
  }
  if (event.type === "provider-usage") {
    return "";
  }
  if (event.type === "tool-result") {
    return formatToolAction(event.result, { workspaceRoot });
  }
  return "";
}



export function formatDisplayPath(value, workspaceRoot = process.cwd()) {
  if (typeof value !== "string" || value === "") return "";
  const redacted = redactString(value);
  if (!path.isAbsolute(redacted)) return redacted;
  const root = path.resolve(workspaceRoot || process.cwd());
  const relative = path.relative(root, redacted);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return redactString(relative);
  }
  return redacted;
}



export function summarizeTranscriptEvent(event = {}, { workspaceRoot = process.cwd() } = {}) {
  if (event.type === "provider-text") {
    return {
      type: event.type,
      provider: event.provider,
      model: event.model,
      text: oneLine(redactString(event.text || ""), 1000),
    };
  }
  if (event.type === "provider-usage") {
    return {
      type: event.type,
      provider: event.provider,
      model: event.model,
      usage: publicUsage(event.usage || event.usageMetadata),
    };
  }
  if (event.type === "provider-meter") {
    return {
      type: event.type,
      provider: event.provider,
      model: event.model,
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
    return {
      type: event.type,
      result: summarizeToolResult(event.result, { workspaceRoot }),
    };
  }
  return {
    type: event.type,
    turn: event.turn,
    provider: event.provider,
  };
}



export function summarizeTranscriptResult(result = {}, { workspaceRoot = process.cwd() } = {}) {
  return {
    status: result.status,
    kind: result.kind,
    task: typeof result.task === "string" ? redactString(result.task) : result.task,
    provider: result.agentLoop?.agent?.provider || result.subagent?.provider || result.provider?.name || result.provider,
    stopReason: result.agentLoop?.stopReason,
    userPrompt: result.agentLoop?.userPrompt
      ? redactString(String(result.agentLoop.userPrompt))
      : undefined,
    completionSummary: result.agentLoop?.completionSummary
      ? redactString(String(result.agentLoop.completionSummary))
      : undefined,
    maxTurns: result.maxTurns,
    skillReferenceCount: Array.isArray(result.skill?.references) ? result.skill.references.length : undefined,
    summary: result.summary && typeof result.summary === "object" ? result.summary : undefined,
    blockerCount: Array.isArray(result.blockers) ? result.blockers.length : undefined,
    savedRecordPath: result.savedRecordPath ? formatDisplayPath(result.savedRecordPath, workspaceRoot) : result.savedRecordPath,
    recordPath: result.recordPath ? formatDisplayPath(result.recordPath, workspaceRoot) : result.recordPath,
    providerSessions: Array.isArray(result.providerSessions) ? result.providerSessions : undefined,
    requiredAuthorizationCount: Array.isArray(result.requiredAuthorizations)
      ? result.requiredAuthorizations.length
      : undefined,
    toolActions: formatToolActions(result, { workspaceRoot }),
    subagentReviewCount: Array.isArray(result.subagentReviews) ? result.subagentReviews.length : undefined,
    note: result.note,
    error: result.error,
  };
}



export function summarizeToolResult(result = {}, { workspaceRoot = process.cwd() } = {}) {
  return {
    ok: result.ok,
    type: result.type,
    path: result.path ? formatDisplayPath(result.path, workspaceRoot) : result.path,
    entryCount: Array.isArray(result.entries) ? result.entries.length : undefined,
    matchCount: Array.isArray(result.matches) ? result.matches.length : undefined,
    truncated: result.truncated,
    gate: result.gate,
    reason: result.reason,
    error: result.error,
    command: Array.isArray(result.command) ? result.command : undefined,
    url: result.url,
    method: result.method,
    status: result.status,
  };
}



export function oneLine(text = "", limit = 240) {
  const value = String(text).replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}



export function formatRollbackSummary(result = {}) {
  return [
    `status: ${result.status || "unknown"}`,
    result.task ? `task: ${redactString(result.task)}` : "",
    result.confirmRequired ? "mode: preview" : "mode: confirmed",
    Array.isArray(result.items) ? `items: ${result.items.length}` : "",
    result.note ? `note: ${redactString(result.note)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}



export function formatDoctorSummary(result = {}, { workspaceRoot = process.cwd() } = {}) {
  if (result.kind === "odai-status") {
    return [
      `status: ${result.status || "unknown"}`,
      `governance: ${result.summary?.governanceCovered || 0}/${result.summary?.governanceTotal || 0} covered`,
      `acceptance: ${result.summary?.acceptanceReady || 0}/${result.summary?.acceptanceTotal || 0} ready`,
      `milestones: ${result.summary?.milestonesReady || 0}/${result.summary?.milestonesTotal || 0} ready`,
      `e2e: ${result.summary?.e2eReady || 0}/${result.summary?.e2eTotal || 0} ready`,
      Array.isArray(result.blockers) && result.blockers.length > 0 ? `blockers: ${result.blockers.length}` : "",
      Array.isArray(result.next) && result.next.length > 0 ? `next: ${redactString(result.next[0])}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "completion-audit") {
    return [
      `status: ${result.status || "unknown"}`,
      `complete: ${result.complete ? "yes" : "no"}`,
      `requirements: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      result.summary?.blocked ? `blocked: ${result.summary.blocked}` : "",
      Array.isArray(result.next) && result.next.length > 0 ? `next: ${redactString(result.next[0])}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "setup-guide") {
    return [
      `status: ${result.status || "unknown"}`,
      `setup: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      `e2e: ${result.summary?.e2eReady || 0}/${result.summary?.e2eTotal || 0} ready`,
      `saved evidence: ${result.summary?.savedEvidenceReady || 0}/${result.summary?.savedEvidenceTotal || 0} ready`,
      result.summary?.blocked ? `blocked: ${result.summary.blocked}` : "",
      Array.isArray(result.next) && result.next.length > 0 ? `next: ${redactString(result.next[0])}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "external-evidence") {
    return [
      `status: ${result.status || "unknown"}`,
      `external evidence: ${result.summary?.ready || 0}/${(result.summary?.ready || 0) + (result.summary?.blocked || 0)} ready`,
      `api providers: ${result.summary?.apiProviders || 0}`,
      `subscription runtime providers: ${result.summary?.subscriptionRuntimeProviders || 0}`,
      `strong sandbox smokes: ${result.summary?.strongSandboxSmokes || 0}`,
      result.summary?.parseErrors ? `parse errors: ${result.summary.parseErrors}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "runtime-governance") {
    return [
      `status: ${result.status || "unknown"}`,
      `governance: ${result.summary?.covered || 0}/${result.summary?.total || 0} covered`,
      result.summary?.missingCanary ? `missing canary: ${result.summary.missingCanary}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "plan-acceptance") {
    return [
      `status: ${result.status || "unknown"}`,
      `acceptance: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      result.summary?.["needs-external-evidence"]
        ? `external evidence needed: ${result.summary["needs-external-evidence"]}`
        : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "sandbox-readiness") {
    return [
      `status: ${result.status || "unknown"}`,
      `sandbox: ${result.configured?.mode || "unknown"} (${result.configured?.status || "unknown"})`,
      `ready candidates: ${result.summary?.readyCandidates || 0}`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "sandbox-smoke") {
    return [
      `status: ${result.status || "unknown"}`,
      `sandbox smoke: ${result.status === "ready" ? "passed" : "not ready"}`,
      result.result?.sandbox?.mode ? `sandbox: ${result.result.sandbox.mode}` : "",
      result.escapeProbe ? `escape: ${result.escapeProbe.hostEscapeCreated ? "host file created" : "host file not created"}` : "",
      result.reason ? `reason: ${redactString(result.reason)}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "plan-milestones") {
    return [
      `status: ${result.status || "unknown"}`,
      `milestones: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      result.summary?.partial ? `partial: ${result.summary.partial}` : "",
      result.summary?.["needs-external-evidence"]
        ? `external evidence needed: ${result.summary["needs-external-evidence"]}`
        : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "e2e-readiness") {
    return [
      `status: ${result.status || "unknown"}`,
      `e2e: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      `real providers: ${result.summary?.availableRealProviders || 0}`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (Array.isArray(result.probes)) {
    return [
      `status: ${result.status || "unknown"}`,
      `probes: ${result.summary?.ready || 0} ready, ${result.summary?.blocked || 0} blocked, ${result.summary?.failed || 0} failed`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (Array.isArray(result.providers?.providers)) {
    const available = result.providers.providers.filter((provider) => provider.available).length;
    return [
      `status: ${result.status || "unknown"}`,
      `providers: ${available}/${result.providers.providers.length} available`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `status: ${result.status || "unknown"}`,
    result.provider?.name ? `provider: ${result.provider.name}` : result.provider ? `provider: ${result.provider}` : "",
    result.probe?.model ? `model: ${result.probe.model}` : "",
    typeof result.probe?.toolIntentCount === "number" ? `toolIntents: ${result.probe.toolIntentCount}` : "",
    result.error?.message ? `error: ${redactString(result.error.message)}` : "",
    result.savedRecordPath ? `saved: ${formatDisplayPath(result.savedRecordPath, workspaceRoot)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}



export function formatJson(value) {
  return JSON.stringify(value, null, 2);
}
