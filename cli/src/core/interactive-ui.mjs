import * as readlineCore from "node:readline";
import { detectLanguage, t } from "../runtime/i18n.mjs";
import { redactString } from "../runtime/redaction.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadProviderConfig,
  loadWorkspaceEnvironment,
} from "../config/provider-config.mjs";
import { discoverSkillsSync } from "./skill-discovery.mjs";

const defaultRepoRoot = process.cwd();
function slashCommandItems(language = "en", { repoRoot: root = defaultRepoRoot, env = process.env } = {}) {
  const runtimeCommands = [
    completionItem("/model", t(language, "slash.model")),
    completionItem("/models", t(language, "slash.models")),
    completionItem("/provider", t(language, "slash.provider")),
    completionItem("/reasoning", t(language, "slash.reasoning")),
    completionItem("/context", t(language, "slash.context")),
    completionItem("/settings", t(language, "slash.settings")),
    completionItem("/language", t(language, "slash.language")),
    completionItem("/auth", t(language, "slash.auth")),
    completionItem("/agents", t(language, "slash.agents")),
    completionItem("/doctor", t(language, "slash.doctor")),
    completionItem("/setup", t(language, "slash.setup")),
    completionItem("/status", t(language, "slash.status")),
    completionItem("/audit", t(language, "slash.audit")),
    completionItem("/evidence", t(language, "slash.evidence")),
    completionItem("/sessions", t(language, "slash.sessions")),
    completionItem("/continue", t(language, "slash.continue")),
    completionItem("/rollback", t(language, "slash.rollback")),
    completionItem("/authorize", t(language, "slash.authorize")),
    completionItem("/run", t(language, "slash.run")),
    completionItem("/init", t(language, "slash.init")),
    completionItem("/policy", t(language, "slash.policy")),
    completionItem("/skills", t(language, "slash.skills")),
    completionItem("/help", t(language, "slash.help")),
    completionItem("/retry", t(language, "slash.retry")),
    completionItem("/exit", t(language, "slash.exit")),
  ];
  // Direct /skill-name entries (Claude-style), never overriding reserved runtime commands.
  const skillItems = discoverSkillsSync({ workspaceRoot: root, env })
    .filter((skill) => !skill.reservedClash)
    .map((skill) =>
      completionItem(
        `/${skill.name}`,
        skill.system
          ? t(language, "slash.skillSystem")
          : skill.description || t(language, "slash.skill", { name: skill.name }),
      ),
    );
  return [...runtimeCommands, ...skillItems];
}

function completionItem(value, description = "") {
  return { value, description };
}

function reasoningCompletionItems(language = "en") {
  return [
    completionItem("auto", t(language, "completion.autoDefault")),
    completionItem("none", t(language, "completion.reasoning.none")),
    completionItem("minimal", t(language, "completion.reasoning.minimal")),
    completionItem("low", t(language, "completion.reasoning.low")),
    completionItem("medium", t(language, "completion.reasoning.medium")),
    completionItem("high", t(language, "completion.reasoning.high")),
  ];
}

function contextCompletionItems(language = "en") {
  return [
    completionItem("auto", t(language, "completion.autoDefault")),
    completionItem("128k", t(language, "completion.context.128k")),
    completionItem("200k", t(language, "completion.context.200k")),
    completionItem("1m", t(language, "completion.context.1m")),
  ];
}

export function canUseInteractivePromptUi({ input, output } = {}) {
  return Boolean(input?.isTTY && output?.isTTY && typeof input.setRawMode === "function");
}

export function createInteractivePromptAsk({
  input,
  output,
  repoRoot: root = defaultRepoRoot,
  env = process.env,
  language,
  languageState,
} = {}) {
  return async (prompt = "odai> ") =>
    await new Promise((resolve) => {
      let line = "";
      let selected = 0;
      let renderedLines = 0;
      let closed = false;
      const wasRaw = input.isRaw;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        input.off("keypress", onKeypress);
        if (!wasRaw) {
          input.setRawMode(false);
        }
        input.pause?.();
        output.write("\x1b[?25h");
      };

      const finish = (value, { echo = true } = {}) => {
        clearPromptRender({ output, renderedLines });
        if (echo && value !== undefined) {
          output.write(`${prompt}${value}\n`);
        }
        cleanup();
        resolve(value);
      };

      const render = () => {
        const activeLanguage = currentPromptLanguage({ env, language, languageState });
        const entries = describeInteractiveCompletions({ line, repoRoot: root, env, language: activeLanguage });
        if (selected >= entries.length) selected = Math.max(0, entries.length - 1);
        const rows = promptRows({
          prompt,
          line,
          entries,
          selected,
          columns: output.columns || 100,
          terminalRows: output.rows || 24,
          language: activeLanguage,
        });
        replacePromptRender({ output, rows, renderedLines });
        renderedLines = rows.length;
      };

      const acceptCompletion = () => {
        const entries = describeInteractiveCompletions({
          line,
          repoRoot: root,
          env,
          language: currentPromptLanguage({ env, language, languageState }),
        });
        if (entries.length === 0) return;
        line = applyCompletionValue(line, entries[selected]?.value || entries[0].value);
        selected = 0;
      };

      const onKeypress = (chunk, key = {}) => {
        if (key.ctrl && key.name === "c") {
          finish(undefined, { echo: false });
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          finish(line);
          return;
        }
        if (key.name === "backspace") {
          line = line.slice(0, -1);
          selected = 0;
          render();
          return;
        }
        if (key.name === "tab") {
          acceptCompletion();
          render();
          return;
        }
        if (key.name === "up") {
          const count = describeInteractiveCompletions({
            line,
            repoRoot: root,
            env,
            language: currentPromptLanguage({ env, language, languageState }),
          }).length;
          if (count > 0) selected = (selected - 1 + count) % count;
          render();
          return;
        }
        if (key.name === "down") {
          const count = describeInteractiveCompletions({
            line,
            repoRoot: root,
            env,
            language: currentPromptLanguage({ env, language, languageState }),
          }).length;
          if (count > 0) selected = (selected + 1) % count;
          render();
          return;
        }
        if (key.name === "escape") {
          line = "";
          selected = 0;
          render();
          return;
        }
        const text = printableChunk(chunk);
        if (text) {
          line += text;
          selected = 0;
          render();
        }
      };

      output.write("\x1b[?25h");
      readlineCore.emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKeypress);
      render();
    });
}

function currentPromptLanguage({ env = process.env, language, languageState } = {}) {
  return languageState?.value || language || detectLanguage({ env });
}

function promptRows({
  prompt,
  line,
  entries = [],
  selected = 0,
  columns = 100,
  terminalRows = 24,
  language = "en",
} = {}) {
  const maxSuggestions = promptSuggestionLimit({ terminalRows });
  const { visible, start, total } = visibleWindow(entries, {
    selected,
    maxVisible: maxSuggestions,
  });
  const rows = [];
  if (visible.length > 0) {
    rows.push(fitPromptRow("─".repeat(Math.max(20, Math.min(columns - 1, 80))), columns));
    const valueWidth = Math.min(28, Math.max(...visible.map((entry) => entry.value.length), 8));
    for (let i = 0; i < visible.length; i += 1) {
      const entry = visible[i];
      const entryIndex = start + i;
      const marker = entryIndex === selected ? "›" : " ";
      const value = entry.value.padEnd(valueWidth);
      const row = `${marker} ${value} ${entry.description || ""}`.trimEnd();
      rows.push(entryIndex === selected ? `\x1b[7m${fitPromptRow(row, columns)}\x1b[0m` : fitPromptRow(row, columns));
    }
    if (total > visible.length) {
      rows.push(fitPromptRow(`  ${start + 1}-${start + visible.length}/${total}`, columns));
    }
  }
  rows.push(fitPromptRow(t(language, "prompt.footer"), columns));
  rows.push(fitPromptRow(`${prompt}${line}`, columns));
  return rows;
}

function promptSuggestionLimit({ terminalRows = 24 } = {}) {
  const rows = Number(terminalRows || 24);
  if (!Number.isFinite(rows) || rows <= 0) return 4;
  // Keep room for the prompt, the key-hint footer, and nearby command output.
  return Math.max(1, Math.min(6, rows - 6));
}

function visibleWindow(items = [], { selected = 0, maxVisible = 6 } = {}) {
  const total = items.length;
  if (total === 0) {
    return { visible: [], start: 0, total: 0 };
  }
  const safeMax = Math.max(1, Math.min(total, Number(maxVisible) || 1));
  const safeSelected = Math.max(0, Math.min(Number(selected) || 0, total - 1));
  const half = Math.floor(safeMax / 2);
  const start = Math.max(0, Math.min(safeSelected - half, total - safeMax));
  return {
    visible: items.slice(start, start + safeMax),
    start,
    total,
  };
}

function replacePromptRender({ output, rows = [], renderedLines = 0 } = {}) {
  clearPromptRender({ output, renderedLines });
  output.write(rows.join("\n"));
}

function clearPromptRender({ output, renderedLines = 0 } = {}) {
  if (renderedLines <= 0) return;
  output.write("\r");
  if (renderedLines > 1) {
    output.write(`\x1b[${renderedLines - 1}A`);
  }
  for (let i = 0; i < renderedLines; i += 1) {
    output.write("\r\x1b[2K");
    if (i < renderedLines - 1) output.write("\x1b[1B");
  }
  if (renderedLines > 1) {
    output.write(`\x1b[${renderedLines - 1}A`);
  }
}

function applyCompletionValue(line = "", value = "") {
  const text = String(line);
  const word = currentCompletionWord(text);
  const prefix = word ? text.slice(0, -word.length) : text;
  return `${prefix}${value} `;
}

function printableChunk(chunk) {
  const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8") || "";
  if (!text || /[\x00-\x08\x0E-\x1F\x7F]/.test(text)) return "";
  return text;
}

function fitPromptRow(value = "", columns = 100) {
  const text = String(value || "");
  const width = Number(columns || 100);
  if (!Number.isFinite(width) || width <= 10 || text.length < width) return text;
  return `${text.slice(0, Math.max(0, width - 4))}...`;
}

export function createInteractiveCompleter({
  repoRoot: root = defaultRepoRoot,
  env = process.env,
  language,
  languageState,
} = {}) {
  return (line = "") =>
    completeInteractiveLine({
      line,
      repoRoot: root,
      env,
      language: currentPromptLanguage({ env, language, languageState }),
    });
}

export function completeInteractiveLine({
  line = "",
  repoRoot: root = defaultRepoRoot,
  env = process.env,
  language,
} = {}) {
  const word = currentCompletionWord(String(line));
  const entries = describeInteractiveCompletions({ line, repoRoot: root, env, language });
  return [entries.map((entry) => entry.value), word];
}

export function describeInteractiveCompletions({
  line = "",
  repoRoot: root = defaultRepoRoot,
  env = process.env,
  language,
} = {}) {
  const text = String(line);
  const word = currentCompletionWord(text);
  const items = interactiveCompletionItems(text, {
    repoRoot: root,
    env,
    language: language || detectLanguage({ env }),
  });
  const matches = items.filter((item) => item.value.startsWith(word));
  return matches.length > 0 ? matches : word ? [] : items;
}

function currentCompletionWord(line = "") {
  if (/\s$/.test(line)) return "";
  return String(line).split(/\s+/).at(-1) || "";
}

function interactiveCompletionItems(
  line = "",
  { repoRoot: root = defaultRepoRoot, env = process.env, language = "en" } = {},
) {
  const trimmed = String(line).trimStart();
  if (!trimmed.startsWith("/")) {
    return [];
  }
  const tokens = trimmed.split(/\s+/);
  const command = tokens[0] || "";
  if (tokens.length <= 1 && !/\s$/.test(trimmed)) {
    return slashCommandItems(language, { repoRoot: root, env });
  }

  const catalog = safeCompletionCatalog({ repoRoot: root, env });
  const previous = tokens.at(-2) || "";
  if (previous === "--provider" || previous === "--main-provider" || previous === "--exclude-provider") {
    return catalog.providers.map((provider) => completionItem(provider, t(language, "completion.provider")));
  }
  if (previous === "--model") {
    return catalog.models.map((model) => completionItem(model, t(language, "completion.configuredModel")));
  }
  if (previous === "--reasoning" || previous === "--reasoning-depth" || previous === "--reasoning-effort") {
    return reasoningCompletionItems(language);
  }
  if (previous === "--context" || previous === "--context-size" || previous === "--context-window") {
    return contextCompletionItems(language);
  }

  if (command === "/auth") {
    return [
      completionItem("select", t(language, "completion.auth.select")),
      completionItem("api-key", t(language, "completion.auth.apiKey")),
      completionItem("claude-cli", t(language, "completion.auth.claudeCli")),
      completionItem("claude-agent-sdk", t(language, "completion.auth.claudeAgentSdk")),
      completionItem("provider-command", t(language, "completion.auth.providerCommand")),
      completionItem("shell", t(language, "completion.auth.shell")),
      completionItem("network", t(language, "completion.auth.network")),
      completionItem("all", t(language, "completion.auth.all")),
      completionItem("clear", t(language, "completion.auth.clear")),
    ];
  }
  if (command === "/provider") {
    if (tokens[1] === "add" || tokens[1] === "set") {
      return providerAddCompletionItems(language);
    }
    if (["remove", "delete", "rm", "clear"].includes(tokens[1])) {
      return providerTargetCompletionItems(catalog, language);
    }
    return [
      completionItem("add", t(language, "completion.provider.add")),
      completionItem("set", t(language, "completion.provider.set")),
      completionItem("remove", t(language, "completion.provider.remove")),
      completionItem("clear", t(language, "completion.provider.clear")),
      completionItem("path", t(language, "completion.provider.path")),
      completionItem("select", t(language, "completion.provider.select")),
      completionItem("auto", t(language, "completion.provider.auto")),
      ...catalog.providers.map((provider) => completionItem(provider, t(language, "completion.provider"))),
    ];
  }
  if (command === "/model") {
    return [
      completionItem("auto", t(language, "completion.model.auto")),
      completionItem("select", t(language, "completion.model.select")),
      ...catalog.models.map((model) => completionItem(model, t(language, "completion.configuredModel"))),
    ];
  }
  if (command === "/reasoning") {
    return reasoningCompletionItems(language);
  }
  if (command === "/context") {
    return contextCompletionItems(language);
  }
  if (command === "/language" || command === "/lang") {
    return [
      completionItem("zh", t(language, "completion.language.zh")),
      completionItem("en", t(language, "completion.language.en")),
    ];
  }
  if (command === "/models") {
    return [
      completionItem("select", t(language, "completion.models.select")),
      completionItem("--json", t(language, "completion.models.json")),
      completionItem("--provider", t(language, "completion.models.provider")),
      completionItem("--model", t(language, "completion.models.model")),
      completionItem("--use-api-key", t(language, "completion.models.useApiKey")),
      completionItem("--use-provider-command", t(language, "completion.models.useProviderCommand")),
      ...catalog.models.map((model) => completionItem(model, t(language, "completion.configuredModel"))),
    ];
  }
  if (command === "/providers") {
    if (tokens[1] === "add" || tokens[1] === "set") {
      return providerAddCompletionItems(language);
    }
    if (["remove", "delete", "rm", "clear"].includes(tokens[1])) {
      return providerTargetCompletionItems(catalog, language);
    }
    return [
      completionItem("add", t(language, "completion.provider.add")),
      completionItem("set", t(language, "completion.provider.set")),
      completionItem("remove", t(language, "completion.provider.remove")),
      completionItem("clear", t(language, "completion.provider.clear")),
      completionItem("path", t(language, "completion.provider.path")),
      completionItem("--json", t(language, "completion.providers.json")),
      completionItem("--use-api-key", t(language, "completion.providers.useApiKey")),
      completionItem("--use-provider-command", t(language, "completion.providers.useProviderCommand")),
    ];
  }
  if (command === "/agents") {
    return [
      completionItem("--use-api-key", t(language, "completion.agents.useApiKey")),
      completionItem("--use-provider-command", t(language, "completion.agents.useProviderCommand")),
      completionItem("--main-provider", t(language, "completion.agents.mainProvider")),
      completionItem("--exclude-provider", t(language, "completion.agents.excludeProvider")),
    ];
  }
  if (command === "/doctor" || command === "/setup" || command === "/status" || command === "/audit") {
    return [
      completionItem("--all", t(language, "completion.doctor.all")),
      completionItem("--provider", t(language, "completion.doctor.provider")),
      completionItem("--model", t(language, "completion.doctor.model")),
      completionItem("--use-api-key", t(language, "completion.doctor.useApiKey")),
      completionItem("--use-provider-command", t(language, "completion.doctor.useProviderCommand")),
      completionItem("--save", t(language, "completion.doctor.save")),
      completionItem("--stream", t(language, "completion.doctor.stream")),
      ...catalog.providers.map((provider) => completionItem(provider, t(language, "completion.provider"))),
    ];
  }
  if (command === "/continue") {
    return [
      completionItem("--run", t(language, "completion.continue.run")),
      completionItem("--use-api-key", t(language, "completion.continue.useApiKey")),
      completionItem("--use-provider-command", t(language, "completion.continue.useProviderCommand")),
      completionItem("--allow-shell", t(language, "completion.continue.allowShell")),
      completionItem("--allow-network", t(language, "completion.continue.allowNetwork")),
    ];
  }
  if (command === "/run") {
    return [
      completionItem("--provider", t(language, "completion.run.provider")),
      completionItem("--model", t(language, "completion.run.model")),
      completionItem("--reasoning", t(language, "completion.run.reasoning")),
      completionItem("--context", t(language, "completion.run.context")),
      completionItem("--subagent", t(language, "completion.run.subagent")),
      completionItem("--exclude-provider", t(language, "completion.run.excludeProvider")),
      completionItem("--use-api-key", t(language, "completion.run.useApiKey")),
      completionItem("--use-provider-command", t(language, "completion.run.useProviderCommand")),
      completionItem("--allow-shell", t(language, "completion.run.allowShell")),
      completionItem("--allow-network", t(language, "completion.run.allowNetwork")),
      ...catalog.models.map((model) => completionItem(model, t(language, "completion.configuredModel"))),
    ];
  }
  if (command === "/sessions") {
    return [
      completionItem("--tail", t(language, "completion.sessions.tail")),
      completionItem("--context", t(language, "completion.sessions.context")),
      completionItem("--compact", t(language, "completion.sessions.compact")),
    ];
  }
  return [];
}

function providerAddCompletionItems(language = "en") {
  return [
    completionItem("openai-compatible", t(language, "completion.provider.openaiCompatible")),
    completionItem("--name", t(language, "completion.provider.name")),
    completionItem("--base-url", t(language, "completion.provider.baseUrl")),
    completionItem("--model", t(language, "completion.provider.model")),
    completionItem("--models", t(language, "completion.provider.models")),
    completionItem("--api-key-env", t(language, "completion.provider.apiKeyEnv")),
    completionItem("--workspace", t(language, "completion.provider.workspace")),
    completionItem("--replace", t(language, "completion.provider.replace")),
  ];
}

function providerTargetCompletionItems(catalog = {}, language = "en") {
  const providers = catalog.configuredProviders?.length ? catalog.configuredProviders : catalog.providers || [];
  return [
    ...providers.map((provider) => completionItem(provider, t(language, "completion.provider"))),
    completionItem("--name", t(language, "completion.provider.name")),
    completionItem("--workspace", t(language, "completion.provider.workspace")),
  ];
}

function safeCompletionCatalog({ repoRoot: root = defaultRepoRoot, env = process.env } = {}) {
  try {
    const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
    const providerConfig = loadProviderConfig({ workspaceRoot: root, env });
    const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
      allowApiKey: false,
      allowProviderCommand: false,
      config: providerConfig,
    });
    const providerReport = describeProviders(registry, workspaceEnv);
    const configuredModels = configuredCompletionModelMap({ env: workspaceEnv, providerConfig });
    const modelLabels = [];
    for (const provider of providerReport.providers || []) {
      const configured = configuredModels.get(provider.name);
      for (const model of configured?.values || []) {
        modelLabels.push(`${provider.name}:${model}`);
      }
      for (const model of completionProviderConfigForName(providerConfig, provider.name).models || []) {
        modelLabels.push(`${provider.name}:${redactString(model)}`);
      }
    }
    const configuredProviders = (providerConfig.providers || [])
      .map((provider) => provider?.name)
      .filter(Boolean);
    return {
      providers: (providerReport.providers || []).map((provider) => provider.name).filter(Boolean),
      configuredProviders: [...new Set(configuredProviders)],
      models: [...new Set(modelLabels)].filter(Boolean),
    };
  } catch {
    return {
      providers: [],
      configuredProviders: [],
      models: [],
    };
  }
}

export async function selectModelChoice({ input, output, rl, choices = [], prompt = "Select model" } = {}) {
  const models = choices.filter((choice) => choice?.label);
  return selectTtyChoice({
    input,
    output,
    rl,
    choices: models,
    prompt,
    emptyValue: undefined,
    formatChoice: (choice) => ({
      label: choice.label,
      status: choice.available ? "ready" : choice.blockedReason || "blocked",
      current: choice.current,
    }),
  });
}

export async function selectProviderChoice({ input, output, rl, choices = [], prompt = "Select provider" } = {}) {
  return selectTtyChoice({
    input,
    output,
    rl,
    choices: choices.filter((choice) => choice?.label || choice?.value),
    prompt,
    emptyValue: undefined,
    formatChoice: (choice) => ({
      label: choice.label || choice.value,
      status: choice.status || (choice.available === false ? choice.blockedReason || "blocked" : "ready"),
      detail: choice.description || choice.kind || "",
      current: choice.current,
    }),
  });
}

export async function selectAuthChoice({ input, output, rl, choices = [], prompt = "Select auth" } = {}) {
  return selectTtyChoice({
    input,
    output,
    rl,
    choices: choices.filter((choice) => choice?.label || choice?.value),
    prompt,
    emptyValue: undefined,
    formatChoice: (choice) => ({
      label: choice.label || choice.value,
      status: choice.status || "",
      detail: choice.description || "",
      current: choice.current,
    }),
  });
}

async function selectTtyChoice({
  input,
  output,
  rl,
  choices = [],
  prompt = "Select",
  emptyValue,
  formatChoice = (choice) => ({ label: choice?.label || String(choice || "") }),
} = {}) {
  const items = choices;
  if (items.length === 0) {
    return emptyValue;
  }
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    return emptyValue;
  }

  return await new Promise((resolve) => {
    let index = Math.max(0, items.findIndex((choice) => choice.current));
    let renderedLines = 0;
    const wasRaw = input.isRaw;
    const maxVisible = modelChoiceLimit({ terminalRows: output.rows || 24 });

    const clearRender = () => {
      if (renderedLines <= 0) return;
      output.write(`\x1b[${renderedLines}A\r\x1b[J`);
      renderedLines = 0;
    };

    const cleanup = () => {
      clearRender();
      input.off("keypress", onKeypress);
      if (!wasRaw) {
        input.setRawMode(false);
      }
      output.write("\x1b[?25h");
      rl?.resume?.();
    };

    const render = () => {
      const { visible, start, total } = visibleWindow(items, {
        selected: index,
        maxVisible,
      });
      const labels = visible.map((choice) => formatChoice(choice).label || "");
      const labelWidth = Math.min(36, Math.max(...labels.map((label) => label.length), 8));
      const rows = [
        `${prompt} (${index + 1}/${total})`,
        ...visible.map((choice, offset) => {
          const choiceIndex = start + offset;
          const marker = choiceIndex === index ? ">" : " ";
          const formatted = formatChoice(choice);
          const current = formatted.current ? "*" : " ";
          const label = String(formatted.label || "").padEnd(labelWidth);
          const status = formatted.status ? ` ${formatted.status}` : "";
          const detail = formatted.detail ? `  ${formatted.detail}` : "";
          return fitPromptRow(`${marker}${current} ${label}${status}${detail}`, output.columns || 100);
        }),
        "Enter selects, Esc cancels.",
      ];
      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A`);
      }
      for (const row of rows) {
        output.write(`\r\x1b[2K${row}\n`);
      }
      renderedLines = rows.length;
    };

    const finish = (choice) => {
      cleanup();
      resolve(choice);
    };

    const onKeypress = (_chunk, key = {}) => {
      if (key.ctrl && key.name === "c") {
        finish(undefined);
        return;
      }
      if (key.name === "escape") {
        finish(undefined);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(items[index]);
        return;
      }
      if (key.name === "up") {
        index = (index - 1 + items.length) % items.length;
        render();
        return;
      }
      if (key.name === "down" || key.name === "tab") {
        index = (index + 1) % items.length;
        render();
      }
    };

    rl?.pause?.();
    readlineCore.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");
    input.on("keypress", onKeypress);
    render();
  });
}

function modelChoiceLimit({ terminalRows = 24 } = {}) {
  const rows = Number(terminalRows || 24);
  if (!Number.isFinite(rows) || rows <= 0) return 8;
  return Math.max(3, Math.min(12, rows - 5));
}


function configuredCompletionModelMap({ env = process.env, providerConfig = {} } = {}) {
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
      appendCompletionConfiguredModel(models, name, value.trim());
    }
  }
  for (const provider of providerConfig.providers || []) {
    if (typeof provider?.model === "string" && provider.model.trim()) {
      appendCompletionConfiguredModel(models, provider.name, provider.model.trim());
    }
    for (const model of provider?.models || []) {
      appendCompletionConfiguredModel(models, provider.name, model);
    }
  }
  return models;
}

function appendCompletionConfiguredModel(models, providerName, model) {
  if (!providerName || !model) return;
  const current = models.get(providerName) || { values: [] };
  const publicModel = redactString(String(model));
  if (!current.values.includes(publicModel)) {
    current.values.push(publicModel);
  }
  models.set(providerName, current);
}

function completionProviderConfigForName(providerConfig = {}, providerName) {
  return (providerConfig.providers || []).find((provider) => provider?.name === providerName) || {};
}
