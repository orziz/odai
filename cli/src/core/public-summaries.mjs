import { publicModelList, publicUsage, redactString } from "../runtime/redaction.mjs";
import { normalizeProviderSession } from "../runtime/provider-session.mjs";
import { publicProviderSource } from "../config/provider-config.mjs";

export function publicTaskText(task = "") {
  return redactString(String(task || ""));
}

export function publicError(error) {
  const result = {
    name: error?.name || "Error",
    message: redactString(error?.message || String(error)),
  };
  const cause = publicErrorCause(error?.cause);
  if (cause) {
    result.cause = cause;
  }
  return result;
}

function publicErrorCause(cause) {
  if (!cause || typeof cause !== "object") {
    return undefined;
  }
  const result = {};
  if (cause.name) {
    result.name = redactString(cause.name);
  }
  if (cause.code) {
    result.code = redactString(cause.code);
  }
  if (cause.message) {
    result.message = redactString(cause.message);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function summarizeProvider(provider = {}) {
  if (typeof provider === "string") return provider;
  return {
    name: provider.name,
    kind: provider.kind,
    auth: provider.auth || "unknown",
    source: publicProviderSource(provider.source),
    available: Boolean(provider.available),
    blockedReason: provider.blockedReason || "",
    capabilities: provider.capabilities || [],
  };
}

export function summarizeProviderProbe(output = {}) {
  return {
    provider: output.provider,
    model: output.model,
    text: truncateText(redactString(output.text || ""), 2000),
    toolIntentCount: Array.isArray(output.toolIntents) ? output.toolIntents.length : 0,
    usage: publicUsage(output.usage || output.usageMetadata),
    messageCount: Array.isArray(output.messages) ? output.messages.length : undefined,
    providerSession: normalizeProviderSession(output.providerSession, {
      provider: output.provider,
      model: output.model,
    }),
    unverified: publicModelList(output.unverified),
  };
}

export function summarizeProgressEvents(events = []) {
  return {
    count: events.length,
    providerText: events.filter((event) => event.type === "provider-text").length,
    toolResults: events.filter((event) => event.type === "tool-result").length,
  };
}

export function truncateText(value = "", limit = 2000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}
