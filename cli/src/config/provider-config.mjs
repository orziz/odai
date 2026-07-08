import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ProviderRegistry } from "../orchestrator/provider-registry.mjs";
import { createAnthropicApiProvider } from "../providers/anthropic-api.mjs";
import { createClaudeAgentSdkProvider } from "../providers/claude-agent-sdk.mjs";
import { createClaudeCliProvider } from "../providers/claude-cli.mjs";
import { createCodexCliProvider } from "../providers/codex-cli.mjs";
import { createCommandJsonProvider } from "../providers/command-json.mjs";
import { createGeminiApiProvider } from "../providers/gemini-api.mjs";
import { createGrokCliProvider } from "../providers/grok-cli.mjs";
import { createMockProvider } from "../providers/mock-provider.mjs";
import { createOllamaProvider } from "../providers/ollama.mjs";
import { createOpenAiCompatibleProvider } from "../providers/openai-compatible.mjs";
import { createOpenAiApiProvider } from "../providers/openai-api.mjs";
import { redactString, redactUrl } from "../runtime/redaction.mjs";

const require = createRequire(import.meta.url);
const CLAUDE_CLI_COMMAND_ENV = "ODAI_CLAUDE_COMMAND";
const CODEX_CLI_COMMAND_ENV = "ODAI_CODEX_COMMAND";
const GROK_CLI_COMMAND_ENV = "ODAI_GROK_COMMAND";
const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
const DEEPSEEK_MODEL_ENV = "ODAI_DEEPSEEK_MODEL";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export function inspectProviderEnvironment(env = process.env) {
  const claudeCliCommand = resolveCliCommand(env, "claude", CLAUDE_CLI_COMMAND_ENV);
  const codexCliCommand = resolveCliCommand(env, "codex", CODEX_CLI_COMMAND_ENV);
  const grokCliCommand = resolveCliCommand(env, "grok", GROK_CLI_COMMAND_ENV);
  return {
    anthropicApiKey: Boolean(env.ANTHROPIC_API_KEY),
    openaiApiKey: Boolean(env.OPENAI_API_KEY),
    geminiApiKey: Boolean(env.GEMINI_API_KEY),
    deepseekApiKey: Boolean(env[DEEPSEEK_API_KEY_ENV]),
    ollamaModel: Boolean(env.ODAI_OLLAMA_MODEL),
    claudeCli: commandExists(claudeCliCommand.command),
    claudeCliCommand: claudeCliCommand.command,
    claudeCliExecutableEnv: claudeCliCommand.executableEnv,
    claudeCliExecutableConfigured: claudeCliCommand.executableConfigured,
    claudeCliExecutableDiscovered: claudeCliCommand.executableDiscovered,
    codexCli: commandExists(codexCliCommand.command),
    codexCliCommand: codexCliCommand.command,
    codexCliExecutableEnv: codexCliCommand.executableEnv,
    codexCliExecutableConfigured: codexCliCommand.executableConfigured,
    grokCli: commandExists(grokCliCommand.command),
    grokCliCommand: grokCliCommand.command,
    grokCliExecutableEnv: grokCliCommand.executableEnv,
    grokCliExecutableConfigured: grokCliCommand.executableConfigured,
    claudeAgentSdk: packageExists("@anthropic-ai/claude-agent-sdk"),
  };
}

export function createProviderRegistryFromEnvironment(env = process.env, options = {}) {
  const registry = new ProviderRegistry();
  const facts = inspectProviderEnvironment(env);
  registry.register(createMockProvider("mock-main", ["reasoning", "code"]));
  registry.register(createMockProvider("mock-reviewer", ["reasoning", "code", "long_context"]));
  registry.register(
    createOpenAiApiProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.ODAI_OPENAI_MODEL,
      allowApiKey: options.allowApiKey,
    }),
  );
  registry.register(
    createAnthropicApiProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ODAI_ANTHROPIC_MODEL,
      maxTokens: Number(env.ODAI_ANTHROPIC_MAX_TOKENS || 2048),
      allowApiKey: options.allowApiKey,
    }),
  );
  registry.register(
    createGeminiApiProvider({
      apiKey: env.GEMINI_API_KEY,
      model: env.ODAI_GEMINI_MODEL,
      allowApiKey: options.allowApiKey,
    }),
  );
  registry.register(
    createOpenAiCompatibleProvider({
      name: "deepseek-api",
      baseUrl: DEEPSEEK_BASE_URL,
      apiKey: env[DEEPSEEK_API_KEY_ENV],
      apiKeyEnv: DEEPSEEK_API_KEY_ENV,
      modelEnv: DEEPSEEK_MODEL_ENV,
      model: env[DEEPSEEK_MODEL_ENV],
      capabilities: ["reasoning", "code"],
      allowApiKey: options.allowApiKey,
      requiresApiKey: true,
      fetchImpl: options.fetchImpl,
    }),
  );
  registry.register(
    createOllamaProvider({
      model: env.ODAI_OLLAMA_MODEL,
      baseUrl: env.ODAI_OLLAMA_BASE_URL || "http://localhost:11434",
      fetchImpl: options.fetchImpl,
    }),
  );
  registry.register(
    createClaudeCliProvider({
      command: facts.claudeCliCommand,
      installed: facts.claudeCli,
      allowProviderCommand: providerCommandAllowed(options, "claude-cli"),
      model: env.ODAI_CLAUDE_MODEL,
      executableEnv: facts.claudeCliExecutableEnv,
      executableConfigured: facts.claudeCliExecutableConfigured,
      executableDiscovered: facts.claudeCliExecutableDiscovered,
    }),
  );
  registry.register(
    createCodexCliProvider({
      command: facts.codexCliCommand,
      installed: facts.codexCli,
      allowProviderCommand: providerCommandAllowed(options, "codex-cli"),
      model: env.ODAI_CODEX_MODEL,
      executableEnv: facts.codexCliExecutableEnv,
      executableConfigured: facts.codexCliExecutableConfigured,
    }),
  );
  registry.register(
    createGrokCliProvider({
      command: facts.grokCliCommand,
      installed: facts.grokCli,
      allowProviderCommand: providerCommandAllowed(options, "grok-cli"),
      model: env.ODAI_GROK_MODEL,
      executableEnv: facts.grokCliExecutableEnv,
      executableConfigured: facts.grokCliExecutableConfigured,
    }),
  );
  registry.register(
    createClaudeAgentSdkProvider({
      installed: facts.claudeAgentSdk,
      allowProviderCommand: providerCommandAllowed(options, "claude-agent-sdk"),
      pathToClaudeCodeExecutable: env.CLAUDE_CODE_EXECUTABLE,
      model: env.ODAI_CLAUDE_MODEL,
    }),
  );
  const configErrors = Array.isArray(options.config?.errors) ? [...options.config.errors] : [];
  for (const providerConfig of options.config?.providers || []) {
    try {
      if (registry.has(providerConfig.name)) {
        configErrors.push({
          provider: providerConfig.name,
          type: providerConfig.type,
          message: `Workspace provider cannot override built-in provider: ${providerConfig.name}`,
        });
        continue;
      }
      registry.register(createProviderFromConfig(providerConfig, env, options));
    } catch (error) {
      configErrors.push({
        provider: providerConfig?.name,
        type: providerConfig?.type,
        message: error?.message || String(error),
      });
    }
  }
  if (configErrors.length > 0) {
    registry.configErrors = configErrors;
  }
  return registry;
}

export function loadWorkspaceProviderConfig({ workspaceRoot }) {
  const filePath = path.join(workspaceRoot, ".odai", "providers.json");
  try {
    return normalizeWorkspaceProviderConfig(JSON.parse(readFileSync(filePath, "utf8")), filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    return {
      providers: [],
      errors: [
        {
          file: filePath,
          message: `Failed to read provider config: ${error.message}`,
        },
      ],
    };
  }
}

export function loadWorkspaceSecretEnv({ workspaceRoot }) {
  const filePath = path.join(workspaceRoot, ".odai", "secrets.env");
  try {
    return parseWorkspaceSecretEnv(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    return {};
  }
}

export function loadWorkspaceEnvironment({ workspaceRoot, env = process.env } = {}) {
  return {
    ...loadWorkspaceSecretEnv({ workspaceRoot }),
    ...env,
  };
}

export function managedProviderApiKeyEnv(providerName = "") {
  const suffix = String(providerName)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `ODAI_PROVIDER_${suffix || "CUSTOM"}_API_KEY`;
}

export function describeProviders(registry, env = process.env) {
  const facts = inspectProviderEnvironment(env);
  return {
    credentials: {
      anthropicApiKey: facts.anthropicApiKey,
      openaiApiKey: facts.openaiApiKey,
      geminiApiKey: facts.geminiApiKey,
      deepseekApiKey: facts.deepseekApiKey,
    },
    local: {
      ollamaModel: facts.ollamaModel,
    },
    commands: {
      claude: facts.claudeCli,
      codex: facts.codexCli,
      grok: facts.grokCli,
    },
    packages: {
      claudeAgentSdk: facts.claudeAgentSdk,
    },
    providers: registry.list().map((provider) => ({
      name: provider.name,
      kind: provider.kind,
      auth: provider.auth || "unknown",
      source: publicProviderSource(provider.source),
      available: Boolean(provider.available),
      blockedReason: provider.blockedReason || "",
      capabilities: provider.capabilities || [],
      cost: "unknown",
    })),
    ...(Array.isArray(registry.configErrors) && registry.configErrors.length > 0
      ? { configErrors: registry.configErrors.map(publicProviderConfigError) }
      : {}),
  };
}

export function publicProviderSource(source = {}) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
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
    "executableDiscovered",
  ]) {
    if (source[key] !== undefined) {
      allowed[key] = publicSourceValue(source[key]);
    }
  }
  return Object.keys(allowed).length > 0 ? allowed : undefined;
}

function publicSourceValue(value) {
  if (typeof value === "string") {
    return redactString(redactUrl(value));
  }
  return value;
}

export function publicProviderConfigError(error = {}) {
  if (!error || typeof error !== "object") {
    return {
      message: redactString(redactUrl(String(error))),
    };
  }
  const result = {};
  for (const key of ["file", "field", "provider", "type", "message"]) {
    if (error[key] !== undefined) {
      result[key] = publicSourceValue(error[key]);
    }
  }
  return result;
}

function normalizeWorkspaceProviderConfig(config, filePath) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      providers: [],
      errors: [
        {
          file: filePath,
          message: "Provider config must be a JSON object.",
        },
      ],
    };
  }

  if (config.providers === undefined) {
    return {};
  }
  if (!Array.isArray(config.providers)) {
    return {
      providers: [],
      errors: [
        {
          file: filePath,
          field: "providers",
          message: "Provider config field 'providers' must be an array.",
        },
      ],
    };
  }

  const providers = [];
  const names = new Set();
  for (let index = 0; index < config.providers.length; index += 1) {
    const providerConfig = config.providers[index];
    const normalized = normalizeProviderEntry(providerConfig, { filePath, index, names });
    if (normalized.error) {
      errors.push(normalized.error);
    } else {
      providers.push(normalized.provider);
    }
  }

  return errors.length > 0 ? { providers, errors } : { providers };
}

function normalizeProviderEntry(providerConfig, { filePath, index, names }) {
  const prefix = `providers[${index}]`;
  if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
    return providerError(filePath, prefix, "Provider entry must be an object.");
  }

  const type = normalizeNonEmptyString(providerConfig.type);
  if (!type) {
    return providerError(filePath, `${prefix}.type`, "Provider entry requires a non-empty type.");
  }
  if (!["openai-compatible", "command-json", "ollama"].includes(type)) {
    return providerError(filePath, `${prefix}.type`, `Unsupported provider config type: ${type}`);
  }

  const name = normalizeNonEmptyString(providerConfig.name);
  if (!name) {
    return providerError(filePath, `${prefix}.name`, "Provider entry requires a non-empty name.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return providerError(filePath, `${prefix}.name`, `Invalid provider name: ${name}`);
  }
  if (names.has(name)) {
    return providerError(filePath, `${prefix}.name`, `Duplicate provider name: ${name}`);
  }
  names.add(name);

  if (providerConfig.capabilities !== undefined && !isStringArray(providerConfig.capabilities)) {
    return providerError(filePath, `${prefix}.capabilities`, "Provider capabilities must be an array of strings.");
  }
  if (providerConfig.models !== undefined && !isStringArray(providerConfig.models)) {
    return providerError(filePath, `${prefix}.models`, "Provider models must be an array of strings.");
  }

  if (type === "openai-compatible") {
    if (!normalizeNonEmptyString(providerConfig.baseUrl)) {
      return providerError(filePath, `${prefix}.baseUrl`, "OpenAI-compatible provider requires a non-empty baseUrl.");
    }
    if (providerConfig.apiKeyEnv !== undefined && !normalizeNonEmptyString(providerConfig.apiKeyEnv)) {
      return providerError(filePath, `${prefix}.apiKeyEnv`, "apiKeyEnv must be a non-empty string when provided.");
    }
    if (providerConfig.apiKey !== undefined && !normalizeNonEmptyString(providerConfig.apiKey)) {
      return providerError(filePath, `${prefix}.apiKey`, "apiKey must be a non-empty string when provided.");
    }
  }

  if (type === "command-json") {
    if (!normalizeNonEmptyString(providerConfig.command)) {
      return providerError(filePath, `${prefix}.command`, "Command provider requires a non-empty command.");
    }
    if (providerConfig.args !== undefined && !isStringArray(providerConfig.args)) {
      return providerError(filePath, `${prefix}.args`, "Command provider args must be an array of strings.");
    }
    if (providerConfig.modelArgs !== undefined && !isStringArray(providerConfig.modelArgs)) {
      return providerError(
        filePath,
        `${prefix}.modelArgs`,
        "Command provider modelArgs must be an array of strings.",
      );
    }
    if (
      providerConfig.inputMode !== undefined &&
      !["stdin", "append-arg"].includes(String(providerConfig.inputMode))
    ) {
      return providerError(filePath, `${prefix}.inputMode`, "Command provider inputMode must be 'stdin' or 'append-arg'.");
    }
  }

  return {
    provider: {
      ...providerConfig,
      type,
      name,
    },
  };
}

function providerError(file, field, message) {
  return {
    error: {
      file,
      field,
      message,
    },
  };
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");
}

function resolveCliCommand(env = process.env, defaultCommand, executableEnv) {
  const configured = normalizeNonEmptyString(env[executableEnv]);
  const discovered = configured ? "" : discoverCliCommand({ env, defaultCommand });
  return {
    command: configured || discovered || defaultCommand,
    executableEnv: configured ? executableEnv : undefined,
    executableConfigured: Boolean(configured),
    executableDiscovered: Boolean(discovered),
  };
}

function commandExists(command) {
  if (!command) {
    return false;
  }
  if (String(command).includes(path.sep)) {
    return isExecutableFile(command);
  }
  const result = spawnSync("which", [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function discoverCliCommand({ env = process.env, defaultCommand } = {}) {
  if (defaultCommand !== "claude") {
    return "";
  }
  return discoverClaudeCodeExtensionBinary(env);
}

function discoverClaudeCodeExtensionBinary(env = process.env) {
  const home = normalizeNonEmptyString(env.HOME);
  if (!home) {
    return "";
  }
  const extensionRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".qoder", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".windsurf", "extensions"),
    path.join(home, ".trae", "extensions"),
  ];
  const candidates = [];
  for (const root of extensionRoots) {
    for (const entry of safeReadDir(root)) {
      if (!entry.isDirectory() || !entry.name.startsWith("anthropic.claude-code-")) {
        continue;
      }
      for (const candidateName of claudeNativeBinaryNames()) {
        const candidate = path.join(root, entry.name, "resources", "native-binary", candidateName);
        if (isExecutableFile(candidate)) {
          candidates.push({
            path: candidate,
            mtimeMs: safeMtimeMs(candidate),
          });
        }
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  return candidates[0]?.path || "";
}

function safeReadDir(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function isExecutableFile(filePath) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return [".bat", ".cmd", ".com", ".exe", ".ps1"].includes(path.extname(filePath).toLowerCase())
        || (stat.mode & 0o111) !== 0;
    }
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function claudeNativeBinaryNames() {
  return process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
}

function packageExists(packageName) {
  try {
    require.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function createProviderFromConfig(providerConfig, env, options) {
  if (providerConfig.type === "openai-compatible") {
    const apiKey = resolveConfiguredApiKey(providerConfig, env);
    return createOpenAiCompatibleProvider({
      name: providerConfig.name,
      baseUrl: providerConfig.baseUrl,
      apiKey: apiKey.value,
      apiKeyEnv: providerConfig.apiKeyEnv,
      modelEnv: providerConfig.modelEnv,
      model: providerConfig.model,
      capabilities: providerConfig.capabilities,
      requiresApiKey: Boolean(providerConfig.apiKeyEnv || providerConfig.apiKey),
      allowApiKey: options.allowApiKey,
      fetchImpl: options.fetchImpl,
    });
  }

  if (providerConfig.type === "command-json") {
    return createCommandJsonProvider({
      name: providerConfig.name,
      command: providerConfig.command,
      args: providerConfig.args,
      modelArgs: providerConfig.modelArgs,
      inputMode: providerConfig.inputMode,
      capabilities: providerConfig.capabilities,
      installed: commandExists(providerConfig.command),
      allowProviderCommand: providerCommandAllowed(options, providerConfig.name),
      runCommand: options.runCommand,
    });
  }

  if (providerConfig.type === "ollama") {
    return createOllamaProvider({
      name: providerConfig.name,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      capabilities: providerConfig.capabilities,
      fetchImpl: options.fetchImpl,
    });
  }

  throw new Error(`Unsupported provider config type: ${providerConfig.type}`);
}

function providerCommandAllowed(options = {}, providerName = "") {
  if (options.allowProviderCommand) return true;
  if (typeof options.allowProviderCommandFor === "function") {
    return Boolean(options.allowProviderCommandFor(providerName));
  }
  return normalizeProviderCommandAllowList(
    options.allowedProviderCommands ?? options.providerCommandProviders,
  ).has(providerName);
}

function normalizeProviderCommandAllowList(value) {
  if (value instanceof Set) {
    return new Set([...value].map(normalizeNonEmptyString).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return new Set(value.map(normalizeNonEmptyString).filter(Boolean));
  }
  if (typeof value === "string") {
    return new Set(value.split(",").map(normalizeNonEmptyString).filter(Boolean));
  }
  return new Set();
}

function resolveConfiguredApiKey(providerConfig = {}, env = process.env) {
  if (normalizeNonEmptyString(providerConfig.apiKey)) {
    return { value: providerConfig.apiKey };
  }
  const ref = normalizeNonEmptyString(providerConfig.apiKeyEnv);
  if (!ref) {
    return { value: undefined };
  }
  if (env[ref]) {
    return { value: env[ref] };
  }
  if (looksLikeDirectSecret(ref)) {
    return { value: ref };
  }
  return { value: undefined };
}

function looksLikeDirectSecret(value = "") {
  const text = String(value);
  if (/^[A-Z_][A-Z0-9_]*$/.test(text)) return false;
  return /\b(?:sk|pk)-[A-Za-z0-9_./+=-]{8,}\b/.test(text) || text.length >= 48;
}

function parseWorkspaceSecretEnv(text = "") {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = parseSecretEnvValue(match[2]);
  }
  return result;
}

function parseSecretEnvValue(raw = "") {
  const value = String(raw).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}
