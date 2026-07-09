import {
  formatContextWindowTokens,
  normalizeReasoningDepth,
  parseContextWindowTokens,
} from "../../runtime/model-options.mjs";
import { detectLanguage, languageName, normalizeLanguage, t } from "../../runtime/i18n.mjs";
import { formatModelsList } from "../model-catalog.mjs";
import { normalizeProviderCommandList } from "./session-auth.mjs";

export function updateSessionLanguage({ argv = [], current = "en", setLanguage } = {}) {
  if (argv.length === 0) {
    const language = normalizeLanguage(current);
    return {
      status: "ready",
      language,
      note: t(language, "language.current", { language: languageName(language) }),
    };
  }
  if (argv.length !== 1) {
    return {
      status: "blocked",
      language: normalizeLanguage(current),
      reason: t(current, "language.blocked"),
    };
  }
  const raw = String(argv[0] || "").trim();
  const next = normalizeLanguage(raw, "");
  if (!next) {
    return {
      status: "blocked",
      language: normalizeLanguage(current),
      reason: t(current, "language.blocked"),
    };
  }
  setLanguage?.(next);
  return {
    status: "ready",
    language: next,
    note: t(next, "language.updated"),
  };
}


export async function updateDefaultProvider({ argv = [], current = "auto", handleProviders, commandName = "provider" } = {}) {
  const provider = argv[0];
  const targetLabel = commandName === "model" ? "model/provider" : "provider";
  const resultTarget = (value) => ({
    provider: value,
    ...(commandName === "model" ? { model: value } : {}),
  });
  if (!provider) {
    return {
      status: "ready",
      ...resultTarget(current),
      note: `Use /${commandName} <name|auto> to set the session default ${targetLabel}. High-risk confirmations are not made persistent.`,
    };
  }
  if (provider.startsWith("-")) {
    return {
      status: "blocked",
      ...resultTarget(current),
      reason: `Usage: /${commandName} <name|auto>`,
    };
  }
  if (provider === "auto") {
    return {
      status: "ready",
      ...resultTarget("auto"),
      note: `Session default ${targetLabel} set to auto.`,
    };
  }

  const availableProviders = await handleProviders?.([]);
  const names = Array.isArray(availableProviders?.providers)
    ? availableProviders.providers.map((entry) => entry.name).filter(Boolean)
    : [];
  if (names.length > 0 && !names.includes(provider)) {
    return {
      status: "blocked",
      ...resultTarget(current),
      requested: provider,
      reason: `${capitalize(targetLabel)} is not registered: ${provider}`,
      providers: names,
    };
  }

  return {
    status: "ready",
    ...resultTarget(provider),
    note: `Session default ${targetLabel} updated. API key, external command, shell, and network confirmations still must be passed per task.`,
  };
}


export function capitalize(value = "") {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}


export async function updateDefaultModel({ argv = [], currentProvider = "auto", currentModel, handleProviders } = {}) {
  const requested = argv[0];
  if (!requested) {
    return {
      status: "ready",
      provider: currentProvider,
      model: currentModel,
      note:
        "Use /model <model|provider:model|auto> to set the session default model. Use /provider for provider-only routing.",
    };
  }
  if (requested.startsWith("-")) {
    return {
      status: "blocked",
      provider: currentProvider,
      model: currentModel,
      reason: "Usage: /model <model|provider:model|auto>",
    };
  }
  if (requested === "auto") {
    return {
      status: "ready",
      provider: currentProvider,
      model: undefined,
      note: "Session default model cleared; provider routing is unchanged.",
    };
  }

  const [providerCandidate, ...modelParts] = requested.split(":");
  if (modelParts.length > 0) {
    const model = modelParts.join(":").trim();
    if (!providerCandidate || !model) {
      return {
        status: "blocked",
        provider: currentProvider,
        model: currentModel,
        reason: "Usage: /model <model|provider:model|auto>",
      };
    }
    const providers = await providerNames(handleProviders);
    if (providers.length > 0 && providerCandidate !== "auto" && !providers.includes(providerCandidate)) {
      return {
        status: "blocked",
        provider: currentProvider,
        model: currentModel,
        requested: providerCandidate,
        reason: `Provider is not registered: ${providerCandidate}`,
        providers,
      };
    }
    return {
      status: "ready",
      provider: providerCandidate,
      model,
      selected: `${providerCandidate}:${model}`,
      note:
        "Session default provider and model updated. API key, external command, shell, and network confirmations still must be passed per task.",
    };
  }

  return {
    status: "ready",
    provider: currentProvider,
    model: requested,
    note:
      "Session default model updated. Provider routing is unchanged; API key, external command, shell, and network confirmations still must be passed per task.",
  };
}


export function updateDefaultReasoning({ argv = [], current } = {}) {
  const requested = argv[0];
  if (!requested) {
    return {
      status: "ready",
      reasoning: current,
      note: "Use /reasoning <auto|none|minimal|low|medium|high> to set the session default reasoning depth.",
    };
  }
  if (requested.startsWith("-")) {
    return {
      status: "blocked",
      reasoning: current,
      reason: "Usage: /reasoning <auto|none|minimal|low|medium|high>",
    };
  }
  let reasoning;
  try {
    reasoning = normalizeReasoningDepth(requested);
  } catch (error) {
    return {
      status: "blocked",
      reasoning: current,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: "ready",
    reasoning: reasoning === "auto" ? undefined : reasoning,
    display: reasoning,
    note:
      reasoning === "auto"
        ? "Session reasoning depth cleared; provider/model defaults apply."
        : "Session default reasoning depth updated. Provider support is model-specific.",
  };
}


export function updateDefaultContextWindow({ argv = [], current } = {}) {
  const requested = argv[0];
  if (!requested) {
    return {
      status: "ready",
      contextWindowTokens: current,
      display: formatContextWindowTokens(current),
      note: "Use /context <auto|200k|1m> to set the session default context window budget.",
    };
  }
  if (requested.startsWith("-")) {
    return {
      status: "blocked",
      contextWindowTokens: current,
      reason: "Usage: /context <auto|200k|1m>",
    };
  }
  let tokens;
  try {
    tokens = parseContextWindowTokens(requested);
  } catch (error) {
    return {
      status: "blocked",
      contextWindowTokens: current,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: "ready",
    contextWindowTokens: tokens,
    display: formatContextWindowTokens(tokens),
    note:
      tokens === undefined
        ? "Session context window cleared; provider/model defaults apply."
        : "Session default context window budget updated. Providers still enforce their own hard limits.",
  };
}


export function sessionSettings({
  defaultProvider = "auto",
  defaultModel,
  defaultReasoning,
  defaultContextWindowTokens,
  sessionAuth = {},
} = {}) {
  return {
    status: "ready",
    provider: defaultProvider,
    model: defaultModel || "auto",
    reasoning: defaultReasoning || "auto",
    context: formatContextWindowTokens(defaultContextWindowTokens),
    contextWindowTokens: defaultContextWindowTokens,
    auth: {
      useApiKey: Boolean(sessionAuth.useApiKey),
      useProviderCommand: Boolean(sessionAuth.useProviderCommand),
    },
  };
}


export function isModelSelectArgv(argv = []) {
  return argv.includes("select") || argv.includes("--select");
}


export async function selectSessionModel({ result, selectModel, write } = {}) {
  const choices = Array.isArray(result?.models) ? result.models : [];
  if (choices.length === 0) {
    return {
      status: "blocked",
      reason:
        "No provider returned a model list. Use /auth api-key or /auth provider-command, then retry /models select.",
    };
  }
  if (!selectModel) {
    return {
      status: "blocked",
      reason: "Interactive model selection is not available in this input mode. Use /model <provider>:<model>.",
      models: choices.map((choice) => choice.label),
    };
  }
  const selected = await selectModel(choices, { prompt: "Select model" });
  if (!selected) {
    return {
      status: "blocked",
      reason: "Model selection cancelled.",
      models: choices.map((choice) => choice.label),
    };
  }
  if (selected.available === false && selected.blockedReason) {
    write?.(`selected model provider is not ready: ${selected.blockedReason}`);
  }
  return {
    status: "ready",
    provider: selected.provider,
    model: selected.model,
    selected: selected.label,
    available: Boolean(selected.available),
    blockedReason: selected.blockedReason || "",
    note:
      "Session default provider and model updated. API key, external command, shell, and network confirmations still must be passed per task.",
  };
}


export function formatModelsResult(result = {}, { json = false } = {}) {
  if (json) {
    return formatJson(result);
  }
  const models = Array.isArray(result.models) ? result.models : [];
  const blocked = blockedModelDiscoveries(result.discovery);
  const lines = [
    `status: ${result.status || "unknown"}`,
    `models: ${models.filter((model) => model.available).length}/${models.length} available`,
  ];
  if (models.length === 0) {
    lines.push("No provider returned a model list.");
    const blockedReasons = new Set((result.discovery || []).map((entry) => entry.reason).filter(Boolean));
    if (blockedReasons.has("api_key_requires_explicit_use")) {
      lines.push("A provider has an API key outside .odai/secrets.env; use /auth api-key when you want to probe it.");
    } else if (blockedReasons.has("provider_command_requires_explicit_use")) {
      lines.push("A provider requires an external command; use /auth provider-command when you want to probe it.");
    } else {
      lines.push("Use /models --json for provider-specific discovery diagnostics.");
    }
  } else {
    const width = Math.min(48, Math.max(...models.map((model) => model.label.length), 12));
    for (const model of models) {
      const marker = model.current ? "*" : " ";
      const status = model.available ? "ready" : model.blockedReason || "blocked";
      lines.push(`${marker} ${model.label.padEnd(width)} ${status} ${model.source || ""}`.trimEnd());
    }
  }
  if (blocked.length > 0) {
    lines.push(`blocked providers: ${blocked.length}`);
    for (const entry of blocked.slice(0, 8)) {
      lines.push(`  ${entry.provider}: ${entry.reason || "blocked"}${entry.source ? ` (${entry.source})` : ""}`);
    }
    if (blocked.length > 8) {
      lines.push(`  ... ${blocked.length - 8} more`);
    }
  }
  lines.push("Use /models select to pick with arrow keys, or /model <provider>:<model>.");
  lines.push("Use /models --json for discovery diagnostics and provider details.");
  return lines.join("\n");
}


export function blockedModelDiscoveries(discovery = []) {
  return Array.isArray(discovery)
    ? discovery.filter((entry) => entry && entry.status !== "ready")
    : [];
}


export async function providerNames(handleProviders) {
  const availableProviders = await handleProviders?.([]);
  return Array.isArray(availableProviders?.providers)
    ? availableProviders.providers.map((entry) => entry.name).filter(Boolean)
    : [];
}

