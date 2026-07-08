import { spawnSync } from "node:child_process";
import { withRegistryModelOverride } from "../orchestrator/provider-model.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadWorkspaceEnvironment,
  loadWorkspaceProviderConfig,
  loadWorkspaceSecretEnv,
} from "../config/provider-config.mjs";
import { redactString } from "../runtime/redaction.mjs";

const defaultRepoRoot = process.cwd();
const BUILT_IN_AUTH_PROVIDERS = new Map([
  [
    "deepseek-api",
    {
      name: "deepseek-api",
      type: "built-in",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      modelEnv: "ODAI_DEEPSEEK_MODEL",
    },
  ],
]);
export async function runModels({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  runCommand = defaultModelDiscoveryRunCommand,
} = {}) {
  const args = parseModelArgs(argv);
  const secretEnv = loadWorkspaceSecretEnv({ workspaceRoot: root });
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: root });
  const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    allowedProviderCommands: args.providerCommandProviders,
    config: providerConfig,
  });
  const effectiveRegistry = withRegistryModelOverride(registry, args.model);
  const providerReport = describeProviders(effectiveRegistry, workspaceEnv);
  const configuredModels = configuredModelMap({ env: workspaceEnv, providerConfig });
  const reportedProviders = (providerReport.providers || []).filter((provider) =>
    args.provider ? provider.name === args.provider : true,
  );
  const discovery = await discoverModelChoices({
    providers: reportedProviders,
    providerConfig,
    env: workspaceEnv,
    secretEnv,
    args,
    fetchImpl,
    runCommand,
  });
  const providers = reportedProviders.map((provider) =>
    modelCatalogProvider({
      provider,
      configured: configuredModels.get(provider.name),
      modelOverride: args.model,
      discovery: discovery.byProvider.get(provider.name),
    }),
  );
  const models = discovery.models;
  return {
    status: "ready",
    kind: "model-catalog",
    flags: {
      useApiKey: args.useApiKey,
      useProviderCommand: args.useProviderCommand,
      providerCommandProviders: args.providerCommandProviders,
      model: args.model ? redactString(args.model) : undefined,
      provider: args.provider ? redactString(args.provider) : undefined,
      select: args.select,
      json: args.json,
    },
    summary: {
      total: providers.length,
      providers: providers.length,
      models: models.length,
      availableModels: models.length,
      configuredModels: providers.filter((provider) => Boolean(provider.configuredModel)).length,
      available: providers.filter((provider) => provider.available).length,
      modelOverrideActive: Boolean(args.model),
      discoveryReady: discovery.results.filter((entry) => entry.status === "ready").length,
      discoveryBlocked: discovery.results.filter((entry) => entry.status !== "ready").length,
    },
    models,
    discovery: discovery.results,
    providers,
    ...(Array.isArray(providerReport.configErrors) && providerReport.configErrors.length > 0
      ? { configErrors: providerReport.configErrors }
      : {}),
    note:
      "This actively discovers model names from provider list endpoints or provider-specific local probes. Managed .odai/secrets.env provider keys are used for model discovery only; other API keys and external provider commands still require explicit /auth or --use-* confirmation.",
  };
}

function configuredModelMap({ env = process.env, providerConfig = {} } = {}) {
  const models = new Map();
  for (const [name, value] of [
    ["openai-api", env.ODAI_OPENAI_MODEL],
    ["anthropic-api", env.ODAI_ANTHROPIC_MODEL],
    ["gemini-api", env.ODAI_GEMINI_MODEL],
    ["deepseek-api", env.ODAI_DEEPSEEK_MODEL],
    ["ollama-local", env.ODAI_OLLAMA_MODEL],
    ["claude-cli", env.ODAI_CLAUDE_MODEL],
    ["claude-agent-sdk", env.ODAI_CLAUDE_MODEL],
    ["codex-cli", env.ODAI_CODEX_MODEL],
    ["grok-cli", env.ODAI_GROK_MODEL],
  ]) {
    if (typeof value === "string" && value.trim()) {
      appendConfiguredModel(models, name, value.trim(), "env");
    }
  }
  for (const provider of providerConfig.providers || []) {
    if (typeof provider?.model === "string" && provider.model.trim()) {
      appendConfiguredModel(models, provider.name, provider.model.trim(), "workspace-config");
    }
    for (const model of provider?.models || []) {
      appendConfiguredModel(models, provider.name, model, "workspace-models");
    }
    if (Array.isArray(provider?.modelArgs) && provider.modelArgs.length > 0) {
      const current = models.get(provider.name) || { sources: [], values: [] };
      current.source ||= "runtime-override";
      current.modelArgs = provider.modelArgs.map((arg) => redactString(String(arg)));
      models.set(provider.name, current);
    }
  }
  return models;
}

function appendConfiguredModel(models, providerName, model, source) {
  if (!providerName || !model) return;
  const current = models.get(providerName) || { sources: [], values: [] };
  const publicModel = redactString(String(model));
  if (!current.values.includes(publicModel)) {
    current.values.push(publicModel);
  }
  if (!current.sources.includes(source)) {
    current.sources.push(source);
  }
  current.value ||= publicModel;
  current.source ||= source;
  models.set(providerName, current);
}

function modelCatalogProvider({ provider = {}, configured, modelOverride, discovery } = {}) {
  const source = provider.source || {};
  const effectiveModel = modelOverride
    ? redactString(modelOverride)
    : configured?.value;
  return {
    name: provider.name,
    kind: provider.kind,
    auth: provider.auth,
    available: Boolean(provider.available),
    blockedReason: provider.blockedReason || "",
    capabilities: provider.capabilities || [],
    cost: provider.cost || "unknown",
    modelEnv: source.modelEnv,
    configuredModel: configured?.value,
    configuredModels: configured?.values,
    configuredModelSource: configured?.source,
    configuredModelSources: configured?.sources,
    modelArgs: configured?.modelArgs,
    acceptsModelOverride: acceptsModelOverride(provider),
    effectiveModel,
    modelChoiceCount: discovery?.models?.length || 0,
    modelDiscovery: discovery
      ? {
          status: discovery.status,
          source: discovery.source,
          count: discovery.models?.length || 0,
          reason: discovery.reason,
        }
      : undefined,
    source,
    next: modelCatalogNext({ provider, source, configured, modelOverride, discovery }),
  };
}

async function discoverModelChoices({
  providers = [],
  providerConfig = {},
  env = process.env,
  secretEnv = {},
  args = {},
  fetchImpl,
  runCommand,
} = {}) {
  const models = [];
  const results = [];
  const byProvider = new Map();
  for (const provider of providers) {
    const result = await discoverProviderModels({
      provider,
      providerConfig: providerConfigForName(providerConfig, provider.name),
      env,
      secretEnv,
      args,
      fetchImpl,
      runCommand,
    });
    results.push(result);
    byProvider.set(provider.name, result);
    for (const model of result.models || []) {
      models.push({
        label: `${provider.name}:${model}`,
        provider: provider.name,
        model,
        available: true,
        blockedReason: "",
        source: result.source,
        command: `/model ${provider.name}:${model}`,
        current: Boolean(args.model && model === redactString(args.model)),
      });
    }
  }
  return { models, results, byProvider };
}

async function discoverProviderModels({
  provider = {},
  providerConfig = {},
  env = {},
  secretEnv = {},
  args = {},
  fetchImpl,
  runCommand,
} = {}) {
  const base = {
    provider: provider.name,
    status: "blocked",
    source: "",
    models: [],
  };
  try {
    if (provider.name === "openai-api") {
      return await discoverOpenAiLikeModels({
        ...base,
        source: "openai-models",
        url: "https://api.openai.com/v1/models",
        apiKey: env.OPENAI_API_KEY,
        requiresApiKey: true,
        allowApiKey: args.useApiKey,
        fetchImpl,
      });
    }
    if (provider.name === "anthropic-api") {
      return await discoverOpenAiLikeModels({
        ...base,
        source: "anthropic-models",
        url: "https://api.anthropic.com/v1/models",
        apiKey: env.ANTHROPIC_API_KEY,
        requiresApiKey: true,
        allowApiKey: args.useApiKey,
        fetchImpl,
        headers: { "anthropic-version": "2023-06-01" },
      });
    }
    if (provider.name === "gemini-api") {
      return await discoverGeminiModels({
        ...base,
        source: "gemini-models",
        apiKey: env.GEMINI_API_KEY,
        allowApiKey: args.useApiKey,
        fetchImpl,
      });
    }
    if (provider.kind === "openai-compatible") {
      const key = resolveProviderApiKey({ provider, providerConfig, env, secretEnv });
      return await discoverOpenAiCompatibleModels({
        ...base,
        baseUrl: providerConfig.baseUrl || provider.source?.baseUrl || "",
        apiKey: key.apiKey,
        requiresApiKey: key.required,
        allowApiKey: args.useApiKey || key.managedSecretPresent,
        fetchImpl,
        warning: key.warning,
        managedSecretPresent: key.managedSecretPresent,
      });
    }
    if (provider.kind === "local-http") {
      return await discoverOllamaModels({
        ...base,
        source: "ollama-tags",
        url: `${trimSlash(providerConfig.baseUrl || provider.source?.baseUrl || "http://localhost:11434")}/api/tags`,
        fetchImpl,
      });
    }
    if (provider.name === "codex-cli") {
      return discoverCodexCliModels({
        ...base,
        source: "codex-doctor",
        command: provider.source?.command || "codex",
        installed: provider.source?.commandPresent,
        allowProviderCommand: providerCommandAllowedForProvider(args, provider.name),
        configuredModel: env.ODAI_CODEX_MODEL,
        runCommand,
      });
    }
    if (provider.name === "claude-cli") {
      return discoverConfiguredCommandModels({
        ...base,
        source: "claude-configured-model",
        installed: provider.source?.commandPresent,
        allowProviderCommand: providerCommandAllowedForProvider(args, provider.name),
        configuredModel: env.ODAI_CLAUDE_MODEL,
      });
    }
    if (provider.name === "grok-cli") {
      return discoverCommandModels({
        ...base,
        source: "grok-models-command",
        command: provider.source?.command || "grok",
        args: ["models"],
        installed: provider.source?.commandPresent,
        allowProviderCommand: providerCommandAllowedForProvider(args, provider.name),
        runCommand,
      });
    }
    return {
      ...base,
      reason: "model_discovery_not_supported",
    };
  } catch (error) {
    return {
      ...base,
      source: base.source || provider.kind || "unknown",
      reason: formatDiscoveryError(error),
    };
  }
}

function providerConfigForName(providerConfig = {}, providerName) {
  return (providerConfig.providers || []).find((provider) => provider?.name === providerName) || {};
}

function acceptsModelOverride(provider = {}) {
  return [
    "api",
    "openai-compatible",
    "local-http",
    "subscription-cli",
    "subscription-sdk",
    "command-json",
    "mock",
  ].includes(provider.kind);
}

function modelCatalogNext({ provider = {}, configured, modelOverride, discovery } = {}) {
  const next = [];
  if (discovery?.reason === "api_key_requires_explicit_use") {
    appendUnique(next, "Use /auth api-key in the interactive CLI or pass --use-api-key for this command.");
  }
  if (discovery?.reason === "provider_command_requires_explicit_use") {
    appendUnique(next, "Use /auth provider-command in the interactive CLI or pass --use-provider-command for this command.");
  }
  if (discovery?.reason === "model_discovery_not_supported" && !configured?.value && !modelOverride) {
    appendUnique(next, `Use /model ${provider.name}:<model> manually; this provider has no supported model-list probe.`);
  }
  if (provider.blockedReason === "api_key_requires_explicit_use") {
    appendUnique(next, "Use /auth api-key in the interactive CLI or pass --use-api-key for this command.");
  }
  if (provider.blockedReason === "provider_command_requires_explicit_use") {
    appendUnique(next, "Use /auth provider-command in the interactive CLI or pass --use-provider-command for this command.");
  }
  if (provider.blockedReason === "api_key_missing") {
    if (BUILT_IN_AUTH_PROVIDERS.has(provider.name)) {
      appendUnique(next, `Run odai auth provider ${provider.name} --api-key-stdin to store a local key.`);
    } else {
      appendUnique(next, "Set the provider API key environment variable or configure an openai-compatible provider.");
    }
  }
  if (provider.blockedReason === "command_not_found") {
    appendUnique(next, "Install the CLI or set the matching ODAI_*_COMMAND environment variable if it is outside PATH.");
  }
  return next;
}

async function discoverOpenAiCompatibleModels({ baseUrl, ...options } = {}) {
  const primary = await discoverOpenAiLikeModels({
    ...options,
    source: "openai-compatible-models",
    url: `${trimSlash(baseUrl || "")}/models`,
  });
  if (primary.status === "ready" && primary.models.length > 0) {
    return primary;
  }
  const fallbackRoot = openAiCompatibleApiRoot(baseUrl);
  if (!fallbackRoot || fallbackRoot === trimSlash(baseUrl || "")) {
    return primary;
  }
  const fallback = await discoverOpenAiLikeModels({
    ...options,
    source: "openai-compatible-v1-models",
    url: `${fallbackRoot}/models`,
  });
  if (fallback.status === "ready" && fallback.models.length > 0) {
    return fallback;
  }
  if (primary.status !== "ready" && fallback.status === "ready") {
    return fallback;
  }
  return primary;
}

async function discoverOpenAiLikeModels({
  provider,
  source,
  url,
  apiKey,
  requiresApiKey = false,
  allowApiKey = false,
  fetchImpl,
  headers = {},
  warning,
} = {}) {
  if (!url || url === "/models") {
    return { provider, status: "blocked", source, models: [], reason: "model_endpoint_missing" };
  }
  if (requiresApiKey && !apiKey) {
    return { provider, status: "blocked", source, models: [], reason: "api_key_missing", warning };
  }
  if (apiKey && !allowApiKey) {
    return { provider, status: "blocked", source, models: [], reason: "api_key_requires_explicit_use", warning };
  }
  if (!fetchImpl) {
    return { provider, status: "blocked", source, models: [], reason: "fetch_unavailable", warning };
  }
  const response = await fetchImpl(url, withDiscoveryTimeout({
    method: "GET",
    headers: {
      accept: "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
  }));
  const body = await readJsonResponse(response);
  if (!response.ok) {
    return {
      provider,
      status: "blocked",
      source,
      models: [],
      reason: `http_${response.status}`,
      warning,
    };
  }
  return {
    provider,
    status: "ready",
    source,
    models: uniqueModels(extractOpenAiLikeModelIds(body)),
    warning,
  };
}

async function discoverGeminiModels({ provider, source, apiKey, allowApiKey = false, fetchImpl } = {}) {
  if (!apiKey) {
    return { provider, status: "blocked", source, models: [], reason: "api_key_missing" };
  }
  if (!allowApiKey) {
    return { provider, status: "blocked", source, models: [], reason: "api_key_requires_explicit_use" };
  }
  if (!fetchImpl) {
    return { provider, status: "blocked", source, models: [], reason: "fetch_unavailable" };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(url, withDiscoveryTimeout({ method: "GET", headers: { accept: "application/json" } }));
  const body = await readJsonResponse(response);
  if (!response.ok) {
    return { provider, status: "blocked", source, models: [], reason: `http_${response.status}` };
  }
  return {
    provider,
    status: "ready",
    source,
    models: uniqueModels(
      (body.models || [])
        .filter((model) => !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes("generateContent"))
        .map((model) => String(model.name || "").replace(/^models\//, "")),
    ),
  };
}

async function discoverOllamaModels({ provider, source, url, fetchImpl } = {}) {
  if (!fetchImpl) {
    return { provider, status: "blocked", source, models: [], reason: "fetch_unavailable" };
  }
  const response = await fetchImpl(url, withDiscoveryTimeout({ method: "GET", headers: { accept: "application/json" } }));
  const body = await readJsonResponse(response);
  if (!response.ok) {
    return { provider, status: "blocked", source, models: [], reason: `http_${response.status}` };
  }
  return {
    provider,
    status: "ready",
    source,
    models: uniqueModels((body.models || []).map((model) => model.name)),
  };
}

function discoverCommandModels({
  provider,
  source,
  command,
  args = [],
  installed = false,
  allowProviderCommand = false,
  runCommand,
} = {}) {
  if (!installed) {
    return { provider, status: "blocked", source, models: [], reason: "command_not_found" };
  }
  if (!allowProviderCommand) {
    return { provider, status: "blocked", source, models: [], reason: "provider_command_requires_explicit_use" };
  }
  const result = runCommand(command, args, { timeoutMs: 30000, maxOutputChars: 200000 });
  if (result.status !== 0) {
    return {
      provider,
      status: "blocked",
      source,
      models: [],
      reason: `command_failed_${result.status}`,
      stderr: redactString(result.stderr || ""),
    };
  }
  return {
    provider,
    status: "ready",
    source,
    models: uniqueModels(extractCommandModelIds(result.stdout || "")),
  };
}

function discoverCodexCliModels({
  provider,
  source,
  command,
  installed = false,
  allowProviderCommand = false,
  configuredModel,
  runCommand,
} = {}) {
  if (!installed) {
    return { provider, status: "blocked", source, models: [], reason: "command_not_found" };
  }
  if (!allowProviderCommand) {
    return { provider, status: "blocked", source, models: [], reason: "provider_command_requires_explicit_use" };
  }
  const configuredModels = uniqueModels([configuredModel]);
  if (!runCommand) {
    return configuredModels.length > 0
      ? { provider, status: "ready", source: "codex-configured-model", models: configuredModels }
      : { provider, status: "blocked", source, models: [], reason: "run_command_unavailable" };
  }
  const result = runCommand(command, ["doctor", "--json"], { timeoutMs: 30000, maxOutputChars: 200000 });
  const models = uniqueModels([...extractCodexDoctorModelIds(result.stdout || ""), ...configuredModels]);
  if (models.length > 0) {
    return {
      provider,
      status: "ready",
      source,
      models,
      ...(result.status === 0 ? {} : { warning: `codex_doctor_failed_${result.status}` }),
    };
  }
  if (result.status !== 0) {
    return {
      provider,
      status: "blocked",
      source,
      models: [],
      reason: `command_failed_${result.status}`,
      stderr: redactString(result.stderr || ""),
    };
  }
  return { provider, status: "blocked", source, models: [], reason: "model_discovery_not_supported" };
}

function discoverConfiguredCommandModels({
  provider,
  source,
  installed = false,
  allowProviderCommand = false,
  configuredModel,
} = {}) {
  if (!installed) {
    return { provider, status: "blocked", source, models: [], reason: "command_not_found" };
  }
  if (!allowProviderCommand) {
    return { provider, status: "blocked", source, models: [], reason: "provider_command_requires_explicit_use" };
  }
  const models = uniqueModels([configuredModel]);
  if (models.length > 0) {
    return { provider, status: "ready", source, models };
  }
  return { provider, status: "blocked", source, models: [], reason: "model_discovery_not_supported" };
}

async function readJsonResponse(response) {
  if (!response) return {};
  if (typeof response.json === "function") {
    return await response.json().catch(() => ({}));
  }
  if (typeof response.text === "function") {
    return JSON.parse(await response.text());
  }
  return {};
}

function extractOpenAiLikeModelIds(body = {}) {
  if (Array.isArray(body)) {
    return body.map((entry) => (typeof entry === "string" ? entry : entry?.id || entry?.name));
  }
  if (Array.isArray(body.data)) {
    return body.data.map((entry) => (typeof entry === "string" ? entry : entry?.id || entry?.name));
  }
  if (Array.isArray(body.models)) {
    return body.models.map((entry) => (typeof entry === "string" ? entry : entry?.id || entry?.name));
  }
  return [];
}

function extractCommandModelIds(output = "") {
  const text = String(output).trim();
  if (!text) return [];
  try {
    return extractOpenAiLikeModelIds(JSON.parse(text));
  } catch {
    return text
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(available\s+)?models:?$/i.test(line))
      .map((line) => line.split(/\s+/)[0])
      .filter((item) => /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(item));
  }
}

function extractCodexDoctorModelIds(output = "") {
  const text = String(output).trim();
  if (!text) return [];
  const models = [];
  const body = parseLooseJsonObject(text);
  if (body) {
    collectJsonModelValues(body, models);
  }
  if (models.length === 0) {
    for (const line of text.split(/\n/)) {
      const match = line.match(/(?:^|\s)model\s+([A-Za-z0-9][A-Za-z0-9._:/+-]*)/i);
      if (match?.[1]) {
        models.push(match[1]);
      }
    }
  }
  return uniqueModels(models);
}

function parseLooseJsonObject(text = "") {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function collectJsonModelValues(value, output) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonModelValues(item, output);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase() === "model" && typeof item === "string" && isModelLikeValue(item)) {
      output.push(item);
      continue;
    }
    if (item && typeof item === "object") {
      collectJsonModelValues(item, output);
    }
  }
}

function isModelLikeValue(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(String(value || ""));
}

function uniqueModels(values = []) {
  const seen = new Set();
  const models = [];
  for (const value of values) {
    const model = redactString(String(value || "").trim());
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models.sort();
}

function resolveProviderApiKey({ provider = {}, providerConfig = {}, env = process.env, secretEnv = {} } = {}) {
  const ref = providerConfig.apiKeyEnv || provider.source?.apiKeyEnv;
  if (!ref) {
    return { apiKey: "", required: false, managedSecretPresent: false };
  }
  if (secretEnv[ref]) {
    return { apiKey: secretEnv[ref], required: true, managedSecretPresent: true };
  }
  if (env[ref]) {
    return { apiKey: env[ref], required: true, managedSecretPresent: false };
  }
  if (looksLikeDirectSecret(ref)) {
    return {
      apiKey: ref,
      required: true,
      managedSecretPresent: false,
      warning: "apiKeyEnv appears to contain a direct secret; prefer an environment variable name.",
    };
  }
  return { apiKey: "", required: true, managedSecretPresent: false };
}

function looksLikeDirectSecret(value = "") {
  const text = String(value);
  if (/^[A-Z_][A-Z0-9_]*$/.test(text)) return false;
  return /\b(?:sk|pk)-[A-Za-z0-9_./+=-]{8,}\b/.test(text) || text.length >= 48;
}

function withDiscoveryTimeout(request = {}) {
  if (request.signal || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return request;
  }
  return {
    ...request,
    signal: AbortSignal.timeout(8000),
  };
}

function trimSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function openAiCompatibleApiRoot(value = "") {
  const trimmed = trimSlash(value);
  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/v1";
      return trimSlash(url.toString());
    }
  } catch {
    // Non-URL values are passed through for test doubles or custom fetch implementations.
  }
  return trimmed;
}

function defaultModelDiscoveryRunCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: truncateForDiscovery(result.stdout || "", options.maxOutputChars),
    stderr: truncateForDiscovery(result.stderr || result.error?.message || "", options.maxOutputChars),
  };
}

function truncateForDiscovery(value = "", limit = 200000) {
  if (!Number.isFinite(limit) || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function formatDiscoveryError(error) {
  const parts = [];
  if (error?.message) parts.push(error.message);
  const cause = error?.cause;
  if (cause?.code) parts.push(cause.code);
  if (cause?.message && cause.message !== error?.message) parts.push(cause.message);
  return redactString(parts.filter(Boolean).join(": ") || String(error || "unknown_error"));
}

function blockedModelDiscoveries(discovery = []) {
  return Array.isArray(discovery)
    ? discovery.filter((entry) => entry && entry.status !== "ready")
    : [];
}

export function formatModelsList(result = {}) {
  const models = Array.isArray(result.models) ? result.models : [];
  const blocked = blockedModelDiscoveries(result.discovery);
  const lines = [
    `status: ${result.status || "unknown"}`,
    `models: ${models.filter((model) => model.available).length}/${models.length} available`,
  ];
  if (result.flags?.model) {
    lines.push(`override: ${result.flags.model}`);
  }
  if (result.flags?.provider) {
    lines.push(`provider: ${result.flags.provider}`);
  }
  if (models.length === 0) {
    lines.push("No provider returned a model list.");
    const blockedReasons = new Set((result.discovery || []).map((entry) => entry.reason).filter(Boolean));
    if (blockedReasons.has("api_key_requires_explicit_use")) {
      lines.push("A provider has an API key outside .odai/secrets.env; use --use-api-key to probe it.");
    } else if (blockedReasons.has("provider_command_requires_explicit_use")) {
      lines.push("A provider requires an external command; use --use-provider-command to probe it.");
    } else {
      lines.push("Check --json discovery diagnostics for the provider-specific reason.");
    }
  } else {
    const maxLabel = Math.min(48, Math.max(...models.map((model) => model.label.length), 12));
    for (const model of models) {
      const marker = model.current ? "*" : " ";
      const status = model.available ? "ready" : model.blockedReason || "blocked";
      lines.push(`${marker} ${model.label.padEnd(maxLabel)} ${status} ${model.source || ""}`.trimEnd());
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
  if (Array.isArray(result.configErrors) && result.configErrors.length > 0) {
    lines.push(`config errors: ${result.configErrors.length}`);
  }
  lines.push("Use /models select in the interactive CLI, or /model <provider>:<model>.");
  lines.push("Use --json for discovery diagnostics and provider readiness.");
  return lines.join("\n");
}


function parseModelArgs(argv = []) {
  const args = {
    useApiKey: false,
    useProviderCommand: false,
    providerCommandProviders: [],
    model: "",
    provider: "",
    select: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      applyProviderCommandOption(args, option);
    } else if (option.name === "--model") {
      args.model = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--provider") {
      args.provider = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--select") {
      args.select = enabledFlagValue(option);
    } else if (option.name === "--json") {
      args.json = enabledFlagValue(option);
    } else if (item === "select") {
      args.select = true;
    }
  }
  return args;
}

function appendUnique(items, value) {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function optionToken(item = "") {
  const value = String(item);
  const separator = value.indexOf("=");
  if (separator <= 0) {
    return {
      name: value,
      value: undefined,
      hasInlineValue: false,
    };
  }
  return {
    name: value.slice(0, separator),
    value: value.slice(separator + 1),
    hasInlineValue: true,
  };
}

function applyProviderCommandOption(args, option = {}) {
  if (!option.hasInlineValue) {
    args.useProviderCommand = true;
    args.providerCommandProviders = [];
    return;
  }

  const value = String(option.value || "").trim();
  const normalized = value.toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(normalized)) {
    args.useProviderCommand = true;
    args.providerCommandProviders = [];
    return;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    args.useProviderCommand = false;
    args.providerCommandProviders = [];
    return;
  }

  args.useProviderCommand = false;
  args.providerCommandProviders = normalizeProviderCommandProviders(value);
}

function providerCommandAllowedForProvider(args = {}, providerName = "") {
  return Boolean(
    args.useProviderCommand
    || normalizeProviderCommandProviders(args.providerCommandProviders).includes(providerName),
  );
}

function normalizeProviderCommandProviders(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(
    items
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )].sort();
}

function enabledFlagValue(option = {}) {
  if (!option.hasInlineValue) return true;
  const value = String(option.value || "").trim().toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return false;
}
