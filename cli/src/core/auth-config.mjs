import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectProviderEnvironment,
  loadWorkspaceEnvironment,
  loadWorkspaceProviderConfig,
  managedProviderApiKeyEnv,
} from "../config/provider-config.mjs";
import { redactString, redactUrl } from "../runtime/redaction.mjs";

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
export async function runAuthConfig({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  inputIsTTY = process.stdin.isTTY,
} = {}) {
  const command = argv[0] || "status";
  if (command === "status") {
    return authConfigStatus({ repoRoot: root, env });
  }
  if (command === "login") {
    return await loginProviderCommandAuth({ repoRoot: root, argv: argv.slice(1), env, inputIsTTY });
  }
  if (command === "migrate") {
    return await migrateProviderAuthConfig({ repoRoot: root, env });
  }
  if (command === "provider") {
    return await configureProviderAuth({ repoRoot: root, argv: argv.slice(1), env });
  }
  return {
    status: "blocked",
    reason:
      "Usage: odai auth status | odai auth login claude-cli [--dry-run] | odai auth migrate | odai auth provider <name> (--api-key-stdin | --api-key-env <ENV> | --clear)",
  };
}

function authConfigStatus({ repoRoot: root = defaultRepoRoot, env = process.env } = {}) {
  const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: root });
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const providerFacts = inspectProviderEnvironment(workspaceEnv);
  const builtInProviders = [...BUILT_IN_AUTH_PROVIDERS.values()].map((provider) => ({
    name: provider.name,
    type: provider.type,
    baseUrl: redactString(redactUrl(provider.baseUrl || "")),
    apiKeyEnv: provider.apiKeyEnv,
    managedApiKeyEnv: provider.apiKeyEnv,
    modelEnv: provider.modelEnv,
    secretPresent: Boolean(workspaceEnv[provider.apiKeyEnv]),
    directSecretInConfig: false,
    next: workspaceEnv[provider.apiKeyEnv]
      ? "Ready. Use /auth api-key or --use-api-key when probing or running this provider."
      : `Run odai auth provider ${provider.name} --api-key-stdin to store a local key in .odai/secrets.env.`,
  }));
  const providers = [
    ...builtInProviders,
    ...(providerConfig.providers || [])
    .filter((provider) => provider?.type === "openai-compatible")
    .map((provider) => {
      const directSecret = providerDirectApiKey(provider);
      const envName = directSecret
        ? undefined
        : typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.trim()
          ? provider.apiKeyEnv.trim()
          : managedProviderApiKeyEnv(provider.name);
      return {
        name: provider.name,
        type: provider.type,
        baseUrl: redactString(redactUrl(provider.baseUrl || "")),
        apiKeyEnv: envName,
        managedApiKeyEnv: managedProviderApiKeyEnv(provider.name),
        secretPresent: Boolean(envName && workspaceEnv[envName]) || Boolean(directSecret),
        directSecretInConfig: Boolean(directSecret),
        next: directSecret
          ? `Run odai auth migrate to move this key into .odai/secrets.env and backfill ${managedProviderApiKeyEnv(provider.name)}.`
          : envName && workspaceEnv[envName]
            ? "Ready. Use /auth api-key or --use-api-key when probing or running this provider."
            : `Run odai auth provider ${provider.name} --api-key-stdin to store a local key and backfill apiKeyEnv.`,
      };
    }),
  ];
  return {
    status: "ready",
    kind: "auth-config",
    providers,
    commands: commandAuthStatuses({ facts: providerFacts, env: workspaceEnv }),
    secretsFile: path.join(".odai", "secrets.env"),
    note:
      "providers.json is user-editable provider metadata. API keys are local machine secrets in .odai/secrets.env; apiKeyEnv is managed by odai auth commands. Subscription CLI login is handled by the provider CLI itself; odai only records command discovery and probe guidance.",
  };
}

function commandAuthStatuses({ facts = {}, env = process.env } = {}) {
  return [
    commandAuthStatus({
      name: "claude-cli",
      command: facts.claudeCliCommand || "claude",
      commandPresent: Boolean(facts.claudeCli),
      executableEnv: facts.claudeCliExecutableEnv,
      executableConfigured: facts.claudeCliExecutableConfigured,
      executableDiscovered: facts.claudeCliExecutableDiscovered,
      modelEnv: "ODAI_CLAUDE_MODEL",
      modelPresent: Boolean(env.ODAI_CLAUDE_MODEL),
      login: "Run the listed Claude CLI command and enter /login, then rerun the odai doctor probe.",
      probe: "odai doctor --provider claude-cli --use-provider-command --model <model> --save",
    }),
    commandAuthStatus({
      name: "codex-cli",
      command: facts.codexCliCommand || "codex",
      commandPresent: Boolean(facts.codexCli),
      executableEnv: facts.codexCliExecutableEnv,
      executableConfigured: facts.codexCliExecutableConfigured,
      modelEnv: "ODAI_CODEX_MODEL",
      modelPresent: Boolean(env.ODAI_CODEX_MODEL),
      login: "Use the Codex CLI's own login/auth flow if this provider probe fails authentication.",
      probe: "odai doctor --provider codex-cli --use-provider-command --model <model> --save",
    }),
    commandAuthStatus({
      name: "grok-cli",
      command: facts.grokCliCommand || "grok",
      commandPresent: Boolean(facts.grokCli),
      executableEnv: facts.grokCliExecutableEnv,
      executableConfigured: facts.grokCliExecutableConfigured,
      modelEnv: "ODAI_GROK_MODEL",
      modelPresent: Boolean(env.ODAI_GROK_MODEL),
      login: "Use the Grok CLI's own login/auth flow if this provider probe fails authentication.",
      probe: "odai doctor --provider grok-cli --use-provider-command --model <model> --save",
    }),
  ];
}

function commandAuthStatus({
  name,
  command,
  commandPresent,
  executableEnv,
  executableConfigured,
  executableDiscovered,
  modelEnv,
  modelPresent,
  login,
  probe,
} = {}) {
  return {
    name,
    type: "subscription-cli",
    command: redactString(redactUrl(command || "")),
    commandPresent: Boolean(commandPresent),
    executableEnv,
    executableConfigured: Boolean(executableConfigured),
    executableDiscovered: Boolean(executableDiscovered),
    modelEnv,
    modelPresent: Boolean(modelPresent),
    next: commandPresent
      ? login
      : `Install ${name} or set ${executableEnv || providerCommandEnvName(name)} to its executable path.`,
    probe,
  };
}

function providerCommandEnvName(providerName = "") {
  if (providerName === "claude-cli") return "ODAI_CLAUDE_COMMAND";
  if (providerName === "codex-cli") return "ODAI_CODEX_COMMAND";
  if (providerName === "grok-cli") return "ODAI_GROK_COMMAND";
  return "ODAI_PROVIDER_COMMAND";
}

async function loginProviderCommandAuth({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  inputIsTTY = process.stdin.isTTY,
} = {}) {
  const providerName = argv[0];
  if (!providerName || providerName.startsWith("-")) {
    return {
      status: "blocked",
      reason: "Usage: odai auth login claude-cli [--dry-run]",
    };
  }

  const args = parseAuthLoginArgs(argv.slice(1));
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const facts = inspectProviderEnvironment(workspaceEnv);
  const target = providerCommandLoginTarget({ providerName, facts });
  if (target.status !== "ready") {
    return target;
  }

  const publicTarget = publicAuthLoginTarget(target);
  if (args.dryRun) {
    return {
      status: "ready",
      kind: "auth-login",
      provider: target.provider,
      dryRun: true,
      ...publicTarget,
      note: target.note,
      next: target.next,
    };
  }

  if (!inputIsTTY) {
    return {
      status: "blocked",
      kind: "auth-login",
      provider: target.provider,
      ...publicTarget,
      reason: "Interactive provider login requires a TTY. Re-run this command in a terminal, or use --dry-run to print the command.",
      next: target.next,
    };
  }

  const cwd = await mkdtemp(path.join(tmpdir(), "odai-auth-login-"));
  const result = await runInteractiveAuthCommand({
    command: target.command,
    args: target.args,
    cwd,
    env: scrubProviderCommandEnv(env),
  });
  return {
    status: result.status === 0 ? "ready" : "failed",
    kind: "auth-login",
    provider: target.provider,
    ...publicTarget,
    exitStatus: result.status,
    signal: result.signal,
    error: result.error,
    note:
      result.status === 0
        ? "Provider login command exited. Rerun the odai doctor probe to save evidence."
        : "Provider login command did not exit cleanly. Check the provider CLI output, then rerun with --dry-run or try the provider CLI directly.",
    next: target.next,
  };
}

function parseAuthLoginArgs(argv = []) {
  return {
    dryRun: hasFlag(argv, "--dry-run") || hasFlag(argv, "--print-command"),
  };
}

function providerCommandLoginTarget({ providerName, facts = {} } = {}) {
  if (providerName !== "claude-cli") {
    return {
      status: "blocked",
      provider: redactString(providerName || ""),
      reason: "Only claude-cli login handoff is currently supported. Use the provider CLI's own auth command directly for this provider.",
      next: [`odai auth status`, `odai doctor --provider ${redactString(providerName || "<provider>")} --use-provider-command --model <model> --save`],
    };
  }
  const command = facts.claudeCliCommand || "claude";
  if (!facts.claudeCli) {
    return {
      status: "blocked",
      provider: "claude-cli",
      reason: `Claude CLI command was not found. Install Claude CLI or set ${facts.claudeCliExecutableEnv || "ODAI_CLAUDE_COMMAND"}.`,
      next: ["odai auth status"],
    };
  }
  return {
    status: "ready",
    provider: "claude-cli",
    command,
    args: [],
    cwdPolicy: "temporary-empty-directory",
    interactive: true,
    note: "This launches the discovered Claude CLI in an empty temporary cwd. Enter /login in the Claude CLI, exit it, then rerun the doctor probe.",
    next: [
      "Enter /login in the launched Claude CLI, then exit it.",
      "odai doctor --provider claude-cli --use-provider-command --model <model> --save",
    ],
  };
}

function publicAuthLoginTarget(target = {}) {
  return {
    command: redactString(redactUrl(target.command || "")),
    args: Array.isArray(target.args) ? target.args.map((arg) => redactString(redactUrl(arg))) : [],
    cwdPolicy: target.cwdPolicy,
    interactive: Boolean(target.interactive),
  };
}

function runInteractiveAuthCommand({ command, args = [], cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (error) => {
      resolve({
        status: 1,
        signal: "",
        error: publicError(error),
      });
    });
    child.on("close", (code, signal) => {
      resolve({
        status: code ?? 1,
        signal: signal || "",
      });
    });
  });
}

function scrubProviderCommandEnv(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|COOKIE|SESSION/i.test(key)) {
      delete next[key];
    }
  }
  return next;
}

async function migrateProviderAuthConfig({ repoRoot: root = defaultRepoRoot, env = process.env } = {}) {
  const { filePath, config } = await readWorkspaceProvidersJson(root);
  const secrets = {};
  const migrated = [];
  for (const provider of config.providers || []) {
    if (provider?.type !== "openai-compatible") continue;
    const directSecret = providerDirectApiKey(provider);
    if (!directSecret) continue;
    const envName = provider.apiKeyEnv && !looksLikeDirectSecret(provider.apiKeyEnv)
      ? provider.apiKeyEnv
      : managedProviderApiKeyEnv(provider.name);
    secrets[envName] = directSecret;
    provider.apiKeyEnv = envName;
    delete provider.apiKey;
    migrated.push({ provider: provider.name, apiKeyEnv: envName });
  }
  if (migrated.length === 0) {
    return {
      status: "ready",
      kind: "auth-migration",
      migrated,
      note: "No direct API keys were found in providers.json.",
    };
  }
  await writeWorkspaceSecrets({ workspaceRoot: root, values: secrets });
  await writeWorkspaceProvidersJson(filePath, config);
  return {
    status: "ready",
    kind: "auth-migration",
    migrated,
    secretsFile: path.join(".odai", "secrets.env"),
    providersFile: path.join(".odai", "providers.json"),
    note: "Moved direct provider keys to local secrets.env and backfilled provider apiKeyEnv names.",
  };
}

async function configureProviderAuth({ repoRoot: root = defaultRepoRoot, argv = [], env = process.env } = {}) {
  const providerName = argv[0];
  if (!providerName || providerName.startsWith("-")) {
    return {
      status: "blocked",
      reason: "Usage: odai auth provider <name> (--api-key-stdin | --api-key-env <ENV> | --clear)",
    };
  }
  const args = parseAuthProviderArgs(argv.slice(1));
  const { filePath, config } = await readWorkspaceProvidersJson(root);
  const provider = (config.providers || []).find((entry) => entry?.name === providerName);
  const builtInProvider = BUILT_IN_AUTH_PROVIDERS.get(providerName);
  if (!provider) {
    if (builtInProvider) {
      return await configureBuiltInProviderAuth({ repoRoot: root, provider: builtInProvider, args });
    }
    return {
      status: "blocked",
      reason: `Provider is not registered: ${redactString(providerName)}`,
      providers: [
        ...BUILT_IN_AUTH_PROVIDERS.keys(),
        ...(config.providers || []).map((entry) => entry?.name).filter(Boolean),
      ],
    };
  }
  if (provider.type !== "openai-compatible") {
    return {
      status: "blocked",
      reason: "Only openai-compatible provider API keys are managed by this command.",
      provider: provider.name,
      type: provider.type,
    };
  }
  if (args.clear) {
    delete provider.apiKey;
    delete provider.apiKeyEnv;
    await writeWorkspaceProvidersJson(filePath, config);
    return {
      status: "ready",
      kind: "auth-provider",
      provider: provider.name,
      cleared: true,
      note: "Removed provider apiKeyEnv reference from providers.json. Existing local secrets.env values were left untouched.",
    };
  }
  if (args.apiKeyEnv) {
    provider.apiKeyEnv = args.apiKeyEnv;
    delete provider.apiKey;
    await writeWorkspaceProvidersJson(filePath, config);
    return {
      status: "ready",
      kind: "auth-provider",
      provider: provider.name,
      apiKeyEnv: provider.apiKeyEnv,
      secretPresent: Boolean(loadWorkspaceEnvironment({ workspaceRoot: root, env })[provider.apiKeyEnv]),
      note: "Updated provider apiKeyEnv. Use your shell or .odai/secrets.env to provide the value.",
    };
  }
  const apiKey = args.apiKeyStdin ? (await readStdin()).trim() : args.apiKey;
  if (!apiKey) {
    return {
      status: "blocked",
      reason: "Pass --api-key-stdin to store a local key, or --api-key-env <ENV> to reference an existing environment variable.",
    };
  }
  const envName = provider.apiKeyEnv && !looksLikeDirectSecret(provider.apiKeyEnv)
    ? provider.apiKeyEnv
    : managedProviderApiKeyEnv(provider.name);
  provider.apiKeyEnv = envName;
  delete provider.apiKey;
  await writeWorkspaceSecrets({ workspaceRoot: root, values: { [envName]: apiKey } });
  await writeWorkspaceProvidersJson(filePath, config);
  return {
    status: "ready",
    kind: "auth-provider",
    provider: provider.name,
    apiKeyEnv: envName,
    secretsFile: path.join(".odai", "secrets.env"),
    providersFile: path.join(".odai", "providers.json"),
    note: "Stored the provider key in local secrets.env and backfilled providers.json with the managed apiKeyEnv name.",
  };
}

async function configureBuiltInProviderAuth({ repoRoot: root = defaultRepoRoot, provider, args = {} } = {}) {
  if (args.clear) {
    return {
      status: "blocked",
      reason: "Built-in provider auth references are fixed; edit .odai/secrets.env if you need to remove the local key.",
      provider: provider.name,
      apiKeyEnv: provider.apiKeyEnv,
    };
  }
  if (args.apiKeyEnv && args.apiKeyEnv !== provider.apiKeyEnv) {
    return {
      status: "blocked",
      reason: `Built-in provider '${provider.name}' uses fixed env ${provider.apiKeyEnv}. Pass --api-key-stdin to store it locally.`,
      provider: provider.name,
      apiKeyEnv: provider.apiKeyEnv,
    };
  }
  const apiKey = args.apiKeyStdin ? (await readStdin()).trim() : args.apiKey;
  if (!apiKey) {
    return {
      status: "blocked",
      reason: `Pass --api-key-stdin to store a local key for ${provider.name}, or set ${provider.apiKeyEnv} yourself.`,
      provider: provider.name,
      apiKeyEnv: provider.apiKeyEnv,
    };
  }
  await writeWorkspaceSecrets({ workspaceRoot: root, values: { [provider.apiKeyEnv]: apiKey } });
  return {
    status: "ready",
    kind: "auth-provider",
    provider: provider.name,
    apiKeyEnv: provider.apiKeyEnv,
    secretsFile: path.join(".odai", "secrets.env"),
    note: "Stored the built-in provider key in local secrets.env.",
  };
}

function parseAuthProviderArgs(argv = []) {
  const args = {
    apiKey: "",
    apiKeyEnv: "",
    apiKeyStdin: false,
    clear: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--api-key") {
      args.apiKey = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--api-key-env") {
      args.apiKeyEnv = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--api-key-stdin") {
      args.apiKeyStdin = enabledFlagValue(option);
    } else if (option.name === "--clear") {
      args.clear = enabledFlagValue(option);
    }
  }
  if (args.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.apiKeyEnv)) {
    throw new Error(`Invalid --api-key-env: ${args.apiKeyEnv}`);
  }
  return args;
}

function providerDirectApiKey(provider = {}) {
  if (typeof provider.apiKey === "string" && provider.apiKey.trim()) {
    return provider.apiKey.trim();
  }
  if (typeof provider.apiKeyEnv === "string" && looksLikeDirectSecret(provider.apiKeyEnv.trim())) {
    return provider.apiKeyEnv.trim();
  }
  return "";
}

async function readWorkspaceProvidersJson(workspaceRoot) {
  const filePath = path.join(workspaceRoot, ".odai", "providers.json");
  try {
    return {
      filePath,
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

async function writeWorkspaceProvidersJson(filePath, config = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function writeWorkspaceSecrets({ workspaceRoot, values = {} } = {}) {
  const filePath = path.join(workspaceRoot, ".odai", "secrets.env");
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
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = [
    "# Managed by odai. Do not commit.",
    ...Object.keys(merged)
      .sort()
      .map((key) => `${key}=${quoteSecretEnvValue(merged[key])}`),
  ];
  await writeFile(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
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


function looksLikeDirectSecret(value = "") {
  const text = String(value);
  if (/^[A-Z_][A-Z0-9_]*$/.test(text)) return false;
  return /\b(?:sk|pk)-[A-Za-z0-9_./+=-]{8,}\b/.test(text) || text.length >= 48;
}

function publicError(error) {
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

function hasFlag(argv = [], name) {
  return argv.some((item) => {
    const option = optionToken(item);
    return option.name === name && enabledFlagValue(option);
  });
}

function enabledFlagValue(option = {}) {
  if (!option.hasInlineValue) return true;
  const value = String(option.value || "").trim().toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return false;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
