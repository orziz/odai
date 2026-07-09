import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import {
  loadProviderConfig,
  managedProviderApiKeyEnv,
  providerConfigPaths,
} from "../config/provider-config.mjs";
import { redactString, redactUrl } from "../runtime/redaction.mjs";
import {
  enabledFlagValue,
  optionToken,
} from "./cli-args.mjs";
import { preferencesPath } from "./preferences.mjs";

const defaultRepoRoot = process.cwd();

export async function runProviderConfigCommand({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  input = defaultInput,
  output = defaultOutput,
  inputIsTTY = input?.isTTY,
  ask,
  askSecret,
  stdinText,
} = {}) {
  const command = argv[0] || "path";
  if (command === "path" || command === "config") {
    return providerConfigPath({ repoRoot: root, env });
  }
  if (command === "add") {
    return await addProviderConfig({
      repoRoot: root,
      argv: argv.slice(1),
      env,
      input,
      output,
      inputIsTTY,
      ask,
      askSecret,
      stdinText,
    });
  }
  if (command === "set") {
    return await addProviderConfig({
      repoRoot: root,
      argv: argv.slice(1),
      env,
      input,
      output,
      inputIsTTY,
      ask,
      askSecret,
      stdinText,
      forceReplace: true,
      preserveExisting: true,
      commandName: "set",
    });
  }
  if (command === "remove" || command === "delete" || command === "rm") {
    return await removeProviderConfig({
      repoRoot: root,
      argv: argv.slice(1),
      env,
      input,
      output,
      inputIsTTY,
      ask,
    });
  }
  if (command === "clear") {
    return await clearProviderConfigAuth({
      repoRoot: root,
      argv: argv.slice(1),
      env,
      input,
      output,
      inputIsTTY,
      ask,
    });
  }
  return {
    status: "blocked",
    reason:
      "Usage: odai provider path | odai provider add|set [openai-compatible] [--name <name> --base-url <url> --model <model>] [--workspace] | odai provider remove <name> [--workspace] | odai provider clear <name> [--workspace]",
  };
}

function providerConfigPath({ repoRoot: root = defaultRepoRoot, env = process.env } = {}) {
  const paths = providerConfigPaths({ workspaceRoot: root, env });
  return {
    status: "ready",
    kind: "provider-config-path",
    workspaceRoot: root,
    globalRoot: paths.globalRoot,
    providersFile: paths.globalProvidersFile,
    secretsFile: paths.globalSecretsFile,
    workspaceProvidersFile: paths.workspaceProvidersFile,
    workspaceSecretsFile: paths.workspaceSecretsFile,
    preferencesFile: preferencesPath(root),
    note:
      "Provider channels and keys are global by default. Workspace .odai/providers.json can still override or add project-specific providers.",
  };
}

async function addProviderConfig({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  input,
  output,
  inputIsTTY = input?.isTTY,
  ask,
  askSecret,
  stdinText,
  forceReplace = false,
  preserveExisting = false,
  commandName = "add",
} = {}) {
  let args = parseProviderAddArgs(argv);
  if (forceReplace) {
    args.replace = true;
  }
  if (shouldPromptProviderAdd({ argv, args, inputIsTTY })) {
    args = await promptProviderAddArgs({
      args,
      ask: ask || createPromptAsk({ input, output }),
      askSecret,
    });
  }
  if (!args.name) {
    return {
      status: "blocked",
      reason: `Usage: odai provider ${commandName} --name <name> --base-url <url> [--model <model>]`,
    };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(args.name)) {
    return {
      status: "blocked",
      reason: `Invalid provider name: ${args.name}. Use letters, numbers, '-' or '_'.`,
    };
  }
  const paths = providerConfigPaths({ workspaceRoot: root, env });
  const filePath = args.workspace ? paths.workspaceProvidersFile : paths.globalProvidersFile;
  const secretsFile = args.workspace ? paths.workspaceSecretsFile : paths.globalSecretsFile;
  const { config } = await readProvidersJson(filePath);
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const existingIndex = providers.findIndex((provider) => provider?.name === args.name);
  const existingProvider = existingIndex >= 0 ? providers[existingIndex] : undefined;
  const type = args.type || (preserveExisting ? existingProvider?.type : "") || "openai-compatible";
  if (type !== "openai-compatible") {
    return {
      status: "blocked",
      reason: `Only openai-compatible provider ${commandName} is supported by this command today.`,
      type,
    };
  }
  if (!args.baseUrl && preserveExisting && existingProvider?.type === "openai-compatible") {
    args.baseUrl = existingProvider.baseUrl || "";
  }
  if (!args.baseUrl) {
    return {
      status: "blocked",
      reason: `OpenAI-compatible provider ${commandName} requires --base-url <url>.`,
    };
  }
  if (existingIndex >= 0 && !args.replace) {
    return {
      status: "blocked",
      reason: `Provider already exists: ${args.name}. Pass --replace to update it.`,
      provider: args.name,
      providersFile: displayConfigPath(filePath, { repoRoot: root }),
    };
  }

  const apiKey = args.apiKeyStdin
    ? (typeof stdinText === "string" ? stdinText : await readStdin()).trim()
    : args.apiKey;
  const apiKeyEnv = apiKey
    ? args.apiKeyEnv || existingProvider?.apiKeyEnv || managedProviderApiKeyEnv(args.name)
    : args.apiKeyEnv || (preserveExisting ? existingProvider?.apiKeyEnv : "");
  const directApiKey = !apiKey && !apiKeyEnv && preserveExisting ? existingProvider?.apiKey || "" : "";
  const models = normalizeList(args.models, preserveExisting ? existingProvider?.models || [] : []);
  const model = args.model || models[0] || (preserveExisting ? existingProvider?.model : "") || "";
  const provider = {
    type: "openai-compatible",
    name: args.name,
    baseUrl: args.baseUrl,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(directApiKey ? { apiKey: directApiKey } : {}),
    ...(model ? { model } : {}),
    ...(models.length > 0 ? { models } : {}),
    capabilities: normalizeList(
      args.capabilities,
      preserveExisting ? existingProvider?.capabilities || ["reasoning", "code"] : ["reasoning", "code"],
    ),
  };

  const nextProviders = [...providers];
  if (existingIndex >= 0) {
    nextProviders[existingIndex] = provider;
  } else {
    nextProviders.push(provider);
  }
  const nextConfig = {
    ...config,
    providers: nextProviders,
  };
  await writeProvidersJson(filePath, nextConfig);
  if (apiKey) {
    await writeSecretsFile({ filePath: secretsFile, values: { [apiKeyEnv]: apiKey } });
  }

  const normalized = loadProviderConfig({ workspaceRoot: root, env });
  const configError = (normalized.errors || []).find((error) => error.provider === args.name);
  if (configError) {
    return {
      status: "blocked",
      reason: configError.message,
      provider: args.name,
      providersFile: displayConfigPath(filePath, { repoRoot: root }),
      field: configError.field,
    };
  }

  return {
    status: "ready",
    kind: "provider-config",
    action: existingIndex >= 0 ? "updated" : "created",
    provider: args.name,
    type: provider.type,
    baseUrl: redactString(redactUrl(provider.baseUrl)),
    model: provider.model,
    models: provider.models || [],
    apiKeyEnv: provider.apiKeyEnv,
    secretStored: Boolean(apiKey),
    scope: args.workspace ? "workspace" : "global",
    providersFile: displayConfigPath(filePath, { repoRoot: root }),
    secretsFile: apiKey ? displayConfigPath(secretsFile, { repoRoot: root }) : undefined,
    next: [
      apiKey || apiKeyEnv
        ? `odai doctor --provider ${args.name} --use-api-key${provider.model ? ` --model ${provider.model}` : ""} --save`
        : `odai auth provider ${args.name} --api-key-stdin`,
      `odai provider path`,
      `interactive: /auth api-key then /provider ${args.name}`,
    ],
  };
}

async function removeProviderConfig({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  input,
  output,
  inputIsTTY = input?.isTTY,
  ask,
} = {}) {
  const args = await providerTargetArgs({
    argv,
    inputIsTTY,
    ask: ask || createPromptAsk({ input, output }),
    prompt: "Provider name to remove: ",
  });
  if (!args.name) {
    return {
      status: "blocked",
      reason: "Usage: odai provider remove <name> [--workspace]",
    };
  }
  const target = await readProviderConfigTarget({ repoRoot: root, env, workspace: args.workspace });
  const providers = Array.isArray(target.config.providers) ? target.config.providers : [];
  const index = providers.findIndex((provider) => provider?.name === args.name);
  if (index < 0) {
    return providerMissingResult({ name: args.name, target, action: "remove" });
  }
  const provider = providers[index];
  const secretKeys = providerSecretKeys(provider);
  providers.splice(index, 1);
  await writeProvidersJson(target.filePath, { ...target.config, providers });
  const secretRemoved = await removeSecretsFileKeys({ filePath: target.secretsFile, keys: secretKeys });
  return {
    status: "ready",
    kind: "provider-config",
    action: "removed",
    provider: args.name,
    scope: target.scope,
    providersFile: displayConfigPath(target.filePath, { repoRoot: root }),
    secretsFile: secretRemoved ? displayConfigPath(target.secretsFile, { repoRoot: root }) : undefined,
    secretRemoved,
  };
}

async function clearProviderConfigAuth({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  input,
  output,
  inputIsTTY = input?.isTTY,
  ask,
} = {}) {
  const args = await providerTargetArgs({
    argv,
    inputIsTTY,
    ask: ask || createPromptAsk({ input, output }),
    prompt: "Provider name to clear: ",
  });
  if (!args.name) {
    return {
      status: "blocked",
      reason: "Usage: odai provider clear <name> [--workspace]",
    };
  }
  const target = await readProviderConfigTarget({ repoRoot: root, env, workspace: args.workspace });
  const providers = Array.isArray(target.config.providers) ? target.config.providers : [];
  const provider = providers.find((entry) => entry?.name === args.name);
  if (!provider) {
    return providerMissingResult({ name: args.name, target, action: "clear" });
  }
  const secretKeys = providerSecretKeys(provider);
  delete provider.apiKey;
  delete provider.apiKeyEnv;
  await writeProvidersJson(target.filePath, { ...target.config, providers });
  const secretRemoved = await removeSecretsFileKeys({ filePath: target.secretsFile, keys: secretKeys });
  return {
    status: "ready",
    kind: "provider-config",
    action: "cleared",
    provider: args.name,
    scope: target.scope,
    providersFile: displayConfigPath(target.filePath, { repoRoot: root }),
    secretsFile: secretRemoved ? displayConfigPath(target.secretsFile, { repoRoot: root }) : undefined,
    secretRemoved,
    note: "Cleared provider API key binding. The provider remains configured.",
  };
}

function parseProviderAddArgs(argv = []) {
  const args = {
    type: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    apiKeyStdin: false,
    model: "",
    models: [],
    capabilities: [],
    workspace: false,
    replace: false,
  };
  const items = [...argv];
  if (items[0] && !items[0].startsWith("-")) {
    const first = items.shift();
    if (first === "openai-compatible") {
      args.type = first;
    } else {
      args.name = first;
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    const option = optionToken(items[i]);
    if (option.name === "--type") {
      args.type = option.hasInlineValue ? option.value : items[++i];
    } else if (option.name === "--name") {
      args.name = option.hasInlineValue ? option.value : items[++i];
    } else if (option.name === "--base-url" || option.name === "--baseUrl") {
      args.baseUrl = option.hasInlineValue ? option.value : items[++i];
    } else if (option.name === "--api-key") {
      args.apiKey = option.hasInlineValue ? option.value : items[++i];
    } else if (option.name === "--api-key-env") {
      args.apiKeyEnv = option.hasInlineValue ? option.value : items[++i];
    } else if (option.name === "--api-key-stdin") {
      args.apiKeyStdin = enabledFlagValue(option);
    } else if (option.name === "--model") {
      args.model = option.hasInlineValue ? option.value : items[++i];
    } else if (option.name === "--models") {
      args.models.push(option.hasInlineValue ? option.value : items[++i]);
    } else if (option.name === "--capabilities") {
      args.capabilities.push(option.hasInlineValue ? option.value : items[++i]);
    } else if (option.name === "--workspace") {
      args.workspace = enabledFlagValue(option);
    } else if (option.name === "--replace") {
      args.replace = enabledFlagValue(option);
    }
  }
  args.type = normalizeString(args.type);
  args.name = normalizeString(args.name);
  args.baseUrl = normalizeString(args.baseUrl);
  args.apiKey = normalizeString(args.apiKey);
  args.apiKeyEnv = normalizeString(args.apiKeyEnv);
  args.model = normalizeString(args.model);
  if (args.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.apiKeyEnv)) {
    throw new Error(`Invalid --api-key-env: ${args.apiKeyEnv}`);
  }
  return args;
}

async function providerTargetArgs({ argv = [], inputIsTTY = false, ask, prompt = "Provider name: " } = {}) {
  const args = {
    name: "",
    workspace: false,
  };
  const items = [...argv];
  if (items[0] && !items[0].startsWith("-")) {
    args.name = items.shift();
  }
  for (let i = 0; i < items.length; i += 1) {
    const option = optionToken(items[i]);
    if (option.name === "--name") {
      args.name = option.hasInlineValue ? option.value : items[++i];
    } else if (option.name === "--workspace") {
      args.workspace = enabledFlagValue(option);
    }
  }
  args.name = normalizeString(args.name);
  if (!args.name && inputIsTTY) {
    args.name = normalizeString(await ask(prompt));
    const scope = normalizeString(await ask("Scope global or workspace? [global]: ")).toLowerCase();
    args.workspace = scope === "workspace" || scope === "project";
  }
  return args;
}

async function readProviderConfigTarget({ repoRoot: root = defaultRepoRoot, env = process.env, workspace = false } = {}) {
  const paths = providerConfigPaths({ workspaceRoot: root, env });
  const filePath = workspace ? paths.workspaceProvidersFile : paths.globalProvidersFile;
  return {
    filePath,
    secretsFile: workspace ? paths.workspaceSecretsFile : paths.globalSecretsFile,
    scope: workspace ? "workspace" : "global",
    ...(await readProvidersJson(filePath)),
  };
}

function providerMissingResult({ name, target, action }) {
  return {
    status: "blocked",
    reason: `Provider is not registered in ${target.scope} config: ${name}`,
    action,
    provider: name,
    scope: target.scope,
    providersFile: target.filePath,
    providers: (target.config.providers || []).map((provider) => provider?.name).filter(Boolean),
  };
}

function shouldPromptProviderAdd({ argv = [], args = {}, inputIsTTY = false } = {}) {
  return Boolean(inputIsTTY && argv.length === 0 && (!args.name || !args.baseUrl));
}

async function promptProviderAddArgs({ args = {}, ask, askSecret } = {}) {
  const next = { ...args };
  next.type = next.type || "openai-compatible";
  next.name = normalizeString(next.name || await ask("Provider name: "));
  next.baseUrl = normalizeString(next.baseUrl || await ask("Base URL (OpenAI-compatible): "));
  next.model = normalizeString(next.model || await ask("Default model (optional): "));
  const modelHints = normalizeString(await ask("Model hints, comma separated (optional): "));
  if (modelHints) {
    next.models = [modelHints];
  }
  const scope = normalizeString(await ask("Scope global or workspace? [global]: ")).toLowerCase();
  next.workspace = scope === "workspace" || scope === "project";
  const storeKey = normalizeString(await ask("Store API key now? [y/N]: ")).toLowerCase();
  if (["y", "yes"].includes(storeKey)) {
    const readKey = askSecret || ask;
    next.apiKey = normalizeString(await readKey("API key: "));
  }
  return next;
}

function createPromptAsk({ input = defaultInput, output = defaultOutput } = {}) {
  return async (question) => {
    const rl = readline.createInterface({ input, output });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

function normalizeList(value = [], fallback = []) {
  const source = Array.isArray(value) ? value : [value];
  const values = source
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : [...fallback];
}

function normalizeString(value) {
  return String(value || "").trim();
}

async function readProvidersJson(filePath) {
  try {
    return {
      config: JSON.parse(await readFile(filePath, "utf8")),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        filePath,
        config: { providers: [] },
      };
    }
    throw error;
  }
}

async function writeProvidersJson(filePath, config = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function writeSecretsFile({ filePath, values = {} } = {}) {
  let current = {};
  try {
    current = parseSecretEnvText(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const merged = {
    ...current,
    ...values,
  };
  await writeSecretEnvValues(filePath, merged);
}

async function writeSecretEnvValues(filePath, values = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = [
    "# Managed by odai. Do not commit.",
    ...Object.keys(values)
      .sort()
      .map((key) => `${key}=${quoteSecretEnvValue(values[key])}`),
  ];
  await writeFile(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function removeSecretsFileKeys({ filePath, keys = [] } = {}) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) return false;
  let current = {};
  try {
    current = parseSecretEnvText(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  let changed = false;
  for (const key of uniqueKeys) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      delete current[key];
      changed = true;
    }
  }
  if (!changed) return false;
  await writeSecretEnvValues(filePath, current);
  return true;
}

function providerSecretKeys(provider = {}) {
  const keys = [];
  if (typeof provider.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)) {
    keys.push(provider.apiKeyEnv);
  }
  return keys;
}

function displayConfigPath(filePath, { repoRoot: root = defaultRepoRoot } = {}) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function parseSecretEnvText(text = "") {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = unquoteSecretEnvValue(match[2]);
  }
  return result;
}

function quoteSecretEnvValue(value = "") {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function unquoteSecretEnvValue(raw = "") {
  const value = String(raw).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
