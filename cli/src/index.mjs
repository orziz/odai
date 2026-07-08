import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as readlineCore from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runInteractiveSession } from "./core/interactive-session.mjs";
import { initWorkspace } from "./core/init-workspace.mjs";
import { rollbackWorkspaceRun } from "./core/rollback.mjs";
import { loadSkillPack } from "./core/skill-pack.mjs";
import { readLatestWorkspaceRun, writeRunRecord, writeWorkspaceRunRecord } from "./core/run-store.mjs";
import { SessionState } from "./core/session-state.mjs";
import {
  compactLatestWorkspaceTranscript,
  createWorkspaceTranscript,
  readLatestWorkspaceTranscript,
} from "./core/transcript-store.mjs";
import { describeRuntimeGovernance } from "./core/governance-registry.mjs";
import { describeAcceptance } from "./core/acceptance-registry.mjs";
import { describeSandboxReadiness, runSandboxSmoke as executeSandboxSmoke } from "./core/sandbox-readiness.mjs";
import { describeE2EReadiness } from "./core/e2e-readiness.mjs";
import { describeMilestones } from "./core/milestone-registry.mjs";
import { describeExternalEvidence } from "./core/external-evidence.mjs";
import { publicModelList, publicToolResult, publicUsage, redactString, redactUrl } from "./runtime/redaction.mjs";
import { runAgentLoop } from "./runtime/agent-loop.mjs";
import {
  normalizeModelOptions,
  parseContextWindowTokens,
} from "./runtime/model-options.mjs";
import { detectLanguage, t } from "./runtime/i18n.mjs";
import {
  checkForPackageUpdate,
  readRuntimePackageMetadata,
  shouldRunStartupUpdateCheck,
} from "./runtime/update-check.mjs";
import { DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS } from "./runtime/model-tool-intents.mjs";
import { EvidenceLedger } from "./runtime/evidence-ledger.mjs";
import { ToolDispatcher } from "./runtime/tool-dispatcher.mjs";
import { UsageLedger } from "./runtime/usage-ledger.mjs";
import { collectProviderSessions, normalizeProviderSession } from "./runtime/provider-session.mjs";
import { Scheduler } from "./orchestrator/scheduler.mjs";
import { withProviderModelOverride, withRegistryModelOverride } from "./orchestrator/provider-model.mjs";
import { adoptPatchProposal, summarizeMerge } from "./orchestrator/result-merger.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  inspectProviderEnvironment,
  loadWorkspaceEnvironment,
  loadWorkspaceProviderConfig,
  loadWorkspaceSecretEnv,
  managedProviderApiKeyEnv,
  publicProviderSource,
} from "./config/provider-config.mjs";
import { loadWorkspacePolicyConfig } from "./config/policy-config.mjs";
import { describeWorkspaceAgentProfiles, loadWorkspaceAgentProfiles } from "./config/agent-config.mjs";

const repoRoot = process.cwd();
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

export async function main(argv) {
  const command = argv[0];
  if (!command) {
    await runCliSession({ repoRoot });
    return;
  }

  if (command === "phase0") {
    const result = await runPhase0Demo({
      repoRoot,
      allowApiKey: hasFlag(argv, "--use-api-key"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "providers") {
    const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: repoRoot, env: process.env });
    const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: repoRoot });
    const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
      allowApiKey: hasFlag(argv, "--use-api-key"),
      allowProviderCommand: hasFlag(argv, "--use-provider-command"),
      config: providerConfig,
    });
    console.log(JSON.stringify(describeProviders(registry, workspaceEnv), null, 2));
    return;
  }

  if (command === "models") {
    const modelResult = await runModels({ repoRoot, argv: argv.slice(1) });
    console.log(hasFlag(argv, "--json") ? JSON.stringify(modelResult, null, 2) : formatModelsList(modelResult));
    return;
  }

  if (command === "auth") {
    console.log(JSON.stringify(await runAuthConfig({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "agents") {
    console.log(JSON.stringify(runAgents({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "init") {
    const result = await runInit({ repoRoot, argv: argv.slice(1) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "policy") {
    console.log(JSON.stringify(loadWorkspacePolicyConfig({ workspaceRoot: repoRoot }), null, 2));
    return;
  }

  if (command === "governance") {
    console.log(JSON.stringify(runGovernance(), null, 2));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify(runStatus({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "setup") {
    console.log(JSON.stringify(await runSetup({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "audit") {
    console.log(JSON.stringify(runAudit({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "evidence") {
    console.log(JSON.stringify(runEvidence({ repoRoot }), null, 2));
    return;
  }

  if (command === "acceptance") {
    console.log(JSON.stringify(runAcceptance({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "milestones") {
    console.log(JSON.stringify(runMilestones({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "sandbox") {
    const result = argv.includes("--smoke")
      ? await runSandboxSmoke({
          repoRoot,
          argv: argv.slice(1),
        })
      : runSandboxReadiness({ repoRoot });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "e2e") {
    console.log(JSON.stringify(runE2EReadiness({ repoRoot, argv: argv.slice(1) }), null, 2));
    return;
  }

  if (command === "sessions") {
    const result = await runSessions({ repoRoot, argv: argv.slice(1) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "resume") {
    const args = parseResumeArgs(argv.slice(1));
    const resumeContext = await loadLatestSessionResumeContext({ repoRoot, tail: args.tail });
    await runCliSession({
      repoRoot,
      initialTaskArgv: args.initialTaskArgv,
      resumeContext,
    });
    return;
  }

  if (command === "doctor") {
    const result = await runDoctor({ repoRoot, argv: argv.slice(1) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "run") {
    const result = await runMockTask({ repoRoot, argv: argv.slice(1) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "canary-runner") {
    const result = await runCanaryRunner({ repoRoot, argv: argv.slice(1) });
    console.log(result.message);
    return;
  }

  if (command === "continue") {
    const result = await continueLatestRun({ repoRoot, argv: argv.slice(1) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "rollback") {
    const result = await rollbackLatestRun({ repoRoot, argv: argv.slice(1) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "--help" || command === "-h") {
    console.log(
      [
        "Usage: odai [task] | odai resume [task] | odai run <task> | <init|phase0|providers|models|auth|agents|policy|setup|status|audit|evidence|governance|acceptance|milestones|sandbox|e2e|sessions|doctor|continue|rollback|canary-runner>",
        "Default: odai <task> starts the interactive CLI, runs the task with --provider auto, then stays at odai>.",
        "Script mode: odai run <task> executes once and prints JSON for automation.",
        "Model options: use --model <model>, --reasoning <minimal|low|medium|high>, and --context <200k|1m>; in the interactive CLI use /model, /reasoning, /context, and /settings.",
        "Init: odai init scaffolds safe .odai config files without overwriting existing files unless --force is used.",
        "Setup: odai setup summarizes workspace config, provider readiness, saved evidence gaps, and next commands without calling external providers.",
        "Sessions: odai sessions --context reads resume context; odai sessions --compact writes a sanitized context snapshot.",
        "Doctor: odai doctor --all probes all explicitly available providers without local tools; --model <name> supplies a task-level model for this probe; odai doctor --setup --save stores the setup guide for continue.",
        "Status: odai status summarizes local gates, saved external evidence, and next runnable checks.",
        "Models: odai models [--provider <name>] [--use-api-key] [--use-provider-command] actively discovers available model names; add --json for provider readiness details.",
        "Auth config: odai auth status | odai auth login claude-cli | odai auth migrate | odai auth provider <name> --api-key-stdin manages local secrets and subscription CLI login handoff.",
        "Audit: odai audit reports whether the current plan-backed completion claim is proven by executable evidence.",
        "Evidence: odai evidence audits saved real provider and strong sandbox evidence from .odai/runs without running anything.",
        "Governance: odai governance reports runtime rule-code coupling coverage.",
        "Acceptance: odai acceptance reports plan acceptance evidence and external gaps.",
        "Milestones: odai milestones reports plan Phase 0/1/2 executable milestone evidence.",
        "Sandbox: odai sandbox reports shell sandbox preflight status; odai sandbox --smoke --allow-shell runs an explicit strong-sandbox smoke.",
        "E2E: odai e2e reports real-provider and sandbox prerequisites without calling external models; --model <name> can satisfy model-required provider readiness for this check.",
        "Agents: odai agents [--use-api-key] [--use-provider-command] [--main-provider <name>|--exclude-provider <name>] lists subagent profiles and provider routing readiness.",
        "Run routing: odai run <task> --provider <name|auto> --model <model> --subagent reviewer:auto[:model] --exclude-provider <name>.",
        "Flags: --use-api-key, --use-provider-command, --agent-loop, --model, --allow-shell, --allow-network",
      ].join("\n"),
    );
    return;
  }

  await runCliSession({ repoRoot, initialTaskArgv: argv });
}

export async function runCliSession({ repoRoot: root = repoRoot, initialTaskArgv, resumeContext } = {}) {
  const languageState = { value: detectLanguage({ env: process.env }) };
  await writeStartupUpdateNotice({ output, env: process.env, language: languageState.value });
  const promptUi = canUseInteractivePromptUi({ input, output })
    ? createInteractivePromptAsk({ input, output, repoRoot: root, env: process.env, languageState })
    : undefined;
  const rl = promptUi
    ? undefined
    : readline.createInterface({
        input,
        output,
        completer: createInteractiveCompleter({ repoRoot: root, env: process.env, languageState }),
      });
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "odai-cli-session-"));
  const session = new SessionState({ id: `interactive-${Date.now()}` });
  const evidence = new EvidenceLedger();
  const transcript = await createWorkspaceTranscript({ workspaceRoot: root, sessionId: session.id });
  const hasInitialTask = Array.isArray(initialTaskArgv) && initialTaskArgv.length > 0;
  const readInputLoop = input.isTTY !== false || !hasInitialTask;
  try {
    await runInteractiveSession({
      initialTaskArgv,
      readInputLoop,
      resumeContext,
      transcriptPath: transcript.path,
      workspaceRoot: root,
      languageState,
      recordTranscript: transcript.append,
      ask: promptUi || ((prompt) => rl.question(prompt)),
      handleTask: (taskArgv, options = {}) =>
        runMockTask({
          repoRoot: root,
          argv: taskArgv,
          sessionTmp,
          session,
          evidence,
          onEvent: options.onEvent,
          conversationContext: options.context,
        }),
      handleProviders: (providerArgv = []) => {
        const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env: process.env });
        const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: root });
        const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
          allowApiKey: hasFlag(providerArgv, "--use-api-key"),
          allowProviderCommand: hasFlag(providerArgv, "--use-provider-command"),
          config: providerConfig,
        });
        return describeProviders(registry, workspaceEnv);
      },
      handleModels: (modelsArgv = []) => runModels({ repoRoot: root, argv: modelsArgv }),
      selectModel: (choices, options = {}) =>
        selectModelChoice({
          input,
          output,
          rl,
          choices,
          prompt: options.prompt,
        }),
      handleAgents: (agentsArgv = []) => runAgents({ repoRoot: root, argv: agentsArgv }),
      handleInit: (initArgv = []) =>
        runInit({
          repoRoot: root,
          argv: initArgv,
        }),
      handleDoctor: (doctorArgv = []) =>
        runDoctor({
          repoRoot: root,
          argv: doctorArgv,
        }),
      handleStatus: (statusArgv = []) =>
        runStatus({
          repoRoot: root,
          argv: statusArgv,
        }),
      handleSetup: (setupArgv = []) =>
        runSetup({
          repoRoot: root,
          argv: setupArgv,
        }),
      handleAudit: (auditArgv = []) =>
        runAudit({
          repoRoot: root,
          argv: auditArgv,
        }),
      handleEvidence: () => runEvidence({ repoRoot: root }),
      handlePolicy: () => loadWorkspacePolicyConfig({ workspaceRoot: root }),
      handleSessions: (sessionsArgv) =>
        runSessions({
          repoRoot: root,
          argv: sessionsArgv,
        }),
      handleContinue: (continueArgv) =>
        continueLatestRun({
          repoRoot: root,
          argv: continueArgv,
          sessionTmp,
          session,
          evidence,
        }),
      handleRollback: (rollbackArgv) =>
        rollbackLatestRun({
          repoRoot: root,
          argv: rollbackArgv,
        }),
      handleAuthorize: (authorizeArgv) => {
        const scope = normalizeAuthorizationScope(authorizeArgv[0] || "");
        if (!scope) {
          return {
            ok: false,
            reason: "Usage: /authorize <scope>, for example /authorize risk:production",
            authorizations: session.authorizationScopes(),
          };
        }
        session.authorize(scope);
        return {
          ok: true,
          scope,
          authorizations: session.authorizationScopes(),
        };
      },
    });
  } finally {
    await transcript.flush();
    rl?.close();
  }
}

async function writeStartupUpdateNotice({ output, env = process.env, language = "en" } = {}) {
  if (!shouldRunStartupUpdateCheck({ env, outputIsTTY: output?.isTTY })) return;
  try {
    const metadata = await readRuntimePackageMetadata();
    const result = await checkForPackageUpdate({
      packageName: metadata.name,
      currentVersion: metadata.version,
      registryUrl: env.ODAI_UPDATE_REGISTRY_URL || undefined,
      timeoutMs: env.ODAI_UPDATE_CHECK_TIMEOUT_MS || undefined,
    });
    if (result.status !== "available") return;
    output.write(
      `${t(language, "update.notice", {
        packageName: result.packageName,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        installCommand: result.installCommand,
      })}\n`,
    );
  } catch {
    // Update checks must never block local/offline CLI startup.
  }
}

function slashCommandItems(language = "en") {
  return [
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
    completionItem("/help", t(language, "slash.help")),
    completionItem("/retry", t(language, "slash.retry")),
    completionItem("/exit", t(language, "slash.exit")),
  ];
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

function canUseInteractivePromptUi({ input, output } = {}) {
  return Boolean(input?.isTTY && output?.isTTY && typeof input.setRawMode === "function");
}

function createInteractivePromptAsk({
  input,
  output,
  repoRoot: root = repoRoot,
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

function promptRows({ prompt, line, entries = [], selected = 0, columns = 100, language = "en" } = {}) {
  const maxSuggestions = 6;
  const visible = entries.slice(0, maxSuggestions);
  const rows = [];
  if (visible.length > 0) {
    rows.push(fitPromptRow("─".repeat(Math.max(20, Math.min(columns - 1, 80))), columns));
    const valueWidth = Math.min(28, Math.max(...visible.map((entry) => entry.value.length), 8));
    for (let i = 0; i < visible.length; i += 1) {
      const entry = visible[i];
      const marker = i === selected ? "›" : " ";
      const value = entry.value.padEnd(valueWidth);
      const row = `${marker} ${value} ${entry.description || ""}`.trimEnd();
      rows.push(i === selected ? `\x1b[7m${fitPromptRow(row, columns)}\x1b[0m` : fitPromptRow(row, columns));
    }
  }
  rows.push(fitPromptRow(t(language, "prompt.footer"), columns));
  rows.push(fitPromptRow(`${prompt}${line}`, columns));
  return rows;
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
  repoRoot: root = repoRoot,
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
  repoRoot: root = repoRoot,
  env = process.env,
  language,
} = {}) {
  const word = currentCompletionWord(String(line));
  const entries = describeInteractiveCompletions({ line, repoRoot: root, env, language });
  return [entries.map((entry) => entry.value), word];
}

export function describeInteractiveCompletions({
  line = "",
  repoRoot: root = repoRoot,
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
  { repoRoot: root = repoRoot, env = process.env, language = "en" } = {},
) {
  const trimmed = String(line).trimStart();
  if (!trimmed.startsWith("/")) {
    return [];
  }
  const tokens = trimmed.split(/\s+/);
  const command = tokens[0] || "";
  if (tokens.length <= 1 && !/\s$/.test(trimmed)) {
    return slashCommandItems(language);
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
      completionItem("api-key", t(language, "completion.auth.apiKey")),
      completionItem("provider-command", t(language, "completion.auth.providerCommand")),
      completionItem("all", t(language, "completion.auth.all")),
      completionItem("clear", t(language, "completion.auth.clear")),
    ];
  }
  if (command === "/provider") {
    return [
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
    return [
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

function safeCompletionCatalog({ repoRoot: root = repoRoot, env = process.env } = {}) {
  try {
    const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
    const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: root });
    const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
      allowApiKey: false,
      allowProviderCommand: false,
      config: providerConfig,
    });
    const providerReport = describeProviders(registry, workspaceEnv);
    const configuredModels = configuredModelMap({ env: workspaceEnv, providerConfig });
    const modelLabels = [];
    for (const provider of providerReport.providers || []) {
      const configured = configuredModels.get(provider.name);
      for (const model of configured?.values || []) {
        modelLabels.push(`${provider.name}:${model}`);
      }
      for (const model of providerConfigForName(providerConfig, provider.name).models || []) {
        modelLabels.push(`${provider.name}:${redactString(model)}`);
      }
    }
    return {
      providers: (providerReport.providers || []).map((provider) => provider.name).filter(Boolean),
      models: [...new Set(modelLabels)].filter(Boolean),
    };
  } catch {
    return {
      providers: [],
      models: [],
    };
  }
}

export async function selectModelChoice({ input, output, rl, choices = [], prompt = "Select model" } = {}) {
  const models = choices.filter((choice) => choice?.label);
  if (models.length === 0) {
    return undefined;
  }
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    return undefined;
  }

  return await new Promise((resolve) => {
    let index = Math.max(0, models.findIndex((choice) => choice.current));
    let renderedLines = 0;
    const wasRaw = input.isRaw;
    const maxVisible = 12;

    const cleanup = () => {
      input.off("keypress", onKeypress);
      if (!wasRaw) {
        input.setRawMode(false);
      }
      output.write("\x1b[?25h");
      rl?.resume?.();
    };

    const render = () => {
      const half = Math.floor(maxVisible / 2);
      const start = Math.max(0, Math.min(index - half, models.length - maxVisible));
      const visible = models.slice(start, start + maxVisible);
      const rows = [
        `${prompt} (${index + 1}/${models.length})`,
        ...visible.map((choice, offset) => {
          const choiceIndex = start + offset;
          const marker = choiceIndex === index ? ">" : " ";
          const status = choice.available ? "ready" : choice.blockedReason || "blocked";
          return `${marker} ${choice.label}  ${status}`;
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
        finish(models[index]);
        return;
      }
      if (key.name === "up") {
        index = (index - 1 + models.length) % models.length;
        render();
        return;
      }
      if (key.name === "down" || key.name === "tab") {
        index = (index + 1) % models.length;
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

export async function runSessions({ repoRoot: root = repoRoot, argv = [] } = {}) {
  const args = parseSessionsArgs(argv);
  try {
    if (args.compact) {
      return await compactLatestWorkspaceTranscript({
        workspaceRoot: root,
        tail: args.tail,
      });
    }
    return await readLatestWorkspaceTranscript({
      workspaceRoot: root,
      tail: args.tail,
      includeContext: args.context,
    });
  } catch (error) {
    return {
      status: "blocked",
      error: publicError(error),
      note: "No session transcript is available yet.",
    };
  }
}

export async function runAuthConfig({
  repoRoot: root = repoRoot,
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

function authConfigStatus({ repoRoot: root = repoRoot, env = process.env } = {}) {
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
  repoRoot: root = repoRoot,
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

async function migrateProviderAuthConfig({ repoRoot: root = repoRoot, env = process.env } = {}) {
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

async function configureProviderAuth({ repoRoot: root = repoRoot, argv = [], env = process.env } = {}) {
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

async function configureBuiltInProviderAuth({ repoRoot: root = repoRoot, provider, args = {} } = {}) {
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

export function runAgents({ repoRoot: root = repoRoot, argv = [], env = process.env } = {}) {
  const args = parseAgentsArgs(argv);
  const description = describeWorkspaceAgentProfiles({ workspaceRoot: root });
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: root });
  const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    config: providerConfig,
  });
  const providers = describeProviders(registry, workspaceEnv).providers || [];
  return {
    ...description,
    flags: {
      useApiKey: args.useApiKey,
      useProviderCommand: args.useProviderCommand,
      mainProvider: args.mainProvider ? redactString(args.mainProvider) : undefined,
      excludeProviderNames: args.excludeProviderNames.map(redactString),
    },
    routing: description.profiles.map((profile) =>
      agentRoutingSummary({
        profile,
        providers,
        excludeProviderNames: args.excludeProviderNames,
      }),
    ),
  };
}

export async function runModels({
  repoRoot: root = repoRoot,
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
        allowProviderCommand: args.useProviderCommand,
        configuredModel: env.ODAI_CODEX_MODEL,
        runCommand,
      });
    }
    if (provider.name === "claude-cli") {
      return discoverConfiguredCommandModels({
        ...base,
        source: "claude-configured-model",
        installed: provider.source?.commandPresent,
        allowProviderCommand: args.useProviderCommand,
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
        allowProviderCommand: args.useProviderCommand,
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

export function runGovernance() {
  return describeRuntimeGovernance();
}

function agentRoutingSummary({ profile = {}, providers = [], excludeProviderNames = [] } = {}) {
  const requirements = Array.isArray(profile.providerRequirements) ? profile.providerRequirements : [];
  const excluded = new Set(excludeProviderNames);
  const candidates = providers
    .filter((provider) => requirements.every((capability) => (provider.capabilities || []).includes(capability)))
    .map((provider) => publicProviderRoutingCandidate(provider, { excluded: excluded.has(provider.name) }));
  const effectiveCandidates = candidates.filter((provider) => !provider.excluded);
  const available = effectiveCandidates.filter((provider) => provider.available);
  const nonMockAvailable = available.filter((provider) => provider.kind !== "mock");
  const selected = selectAutoProviderSummary({ available, nonMockAvailable });
  return {
    profile: profile.name,
    requirements,
    tools: profile.tools,
    toolBoundary: toolBoundarySummary(profile.tools),
    auto: autoRoutingStatus({
      candidates: effectiveCandidates,
      available,
      nonMockAvailable,
      selected,
      excludedProviderNames: excludeProviderNames,
    }),
    candidates,
  };
}

function publicProviderRoutingCandidate(provider = {}, { excluded = false } = {}) {
  return {
    name: provider.name,
    kind: provider.kind,
    available: Boolean(provider.available),
    excluded,
    blockedReason: provider.blockedReason || "",
    capabilities: provider.capabilities || [],
    source: publicProviderSource(provider.source),
  };
}

function selectAutoProviderSummary({ available = [], nonMockAvailable = [] } = {}) {
  if (nonMockAvailable.length === 1) {
    return nonMockAvailable[0].name;
  }
  if (nonMockAvailable.length === 0 && available.length > 0) {
    return available[0].name;
  }
  return undefined;
}

function autoRoutingStatus({
  candidates = [],
  available = [],
  nonMockAvailable = [],
  selected,
  excludedProviderNames = [],
} = {}) {
  const exclusionNote = excludedProviderNames.length > 0
    ? ` Excluded providers: ${excludedProviderNames.map(redactString).join(", ")}.`
    : "";
  if (nonMockAvailable.length > 1) {
    return {
      status: "ambiguous",
      selected,
      reason: `Multiple available non-mock providers match: ${nonMockAvailable.map((provider) => provider.name).join(", ")}.${exclusionNote}`,
    };
  }
  if (selected) {
    const selectedProvider = available.find((provider) => provider.name === selected);
    return {
      status: selectedProvider?.kind === "mock" ? "mock-fallback" : "ready",
      selected,
      reason: selectedProvider?.kind === "mock"
        ? `Only mock providers are currently available for this profile.${exclusionNote}`
        : `Exactly one available non-mock provider matches this profile.${exclusionNote}`,
    };
  }
  if (candidates.length > 0) {
    return {
      status: "blocked",
      selected,
      reason: `Matching providers exist, but none are currently available under the active flags, environment, and exclusions.${exclusionNote}`,
    };
  }
  return {
    status: "blocked",
    selected,
    reason: `No provider advertises all required capabilities for this profile after exclusions.${exclusionNote}`,
  };
}

function toolBoundarySummary(tools) {
  if (tools === "read_only") {
    return "Read-only dispatcher tools are exposed; direct write, shell, network, user-channel, and completion intents are denied.";
  }
  if (tools === "virtual_patch_only") {
    return "The subagent may return a virtual patch proposal; the main flow must adopt it through runtime gates.";
  }
  return "No runtime tools are exposed to this subagent.";
}

export function runStatus({ repoRoot: root = repoRoot, argv = [], env = process.env } = {}) {
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const e2eReadiness = runE2EReadiness({ repoRoot: root, argv, env: workspaceEnv });
  const externalEvidence = describeExternalEvidence({ workspaceRoot: root });
  const governance = runGovernance();
  const acceptance = describeAcceptance({
    e2eReadiness,
    externalEvidence,
  });
  const milestones = describeMilestones({
    e2eReadiness,
    externalEvidence,
  });
  const blockers = statusBlockers({ acceptance, milestones });
  const runnableCommands = relevantRunnableCommands({ e2eReadiness, externalEvidence });
  const next = statusNextActions({ blockers, e2eReadiness, externalEvidence });
  const ready = governance.status === "ready" && acceptance.status === "ready" && milestones.status === "ready";
  return {
    status: ready ? "ready" : "partial",
    kind: "odai-status",
    summary: {
      governance: governance.status,
      governanceCovered: governance.summary?.covered || 0,
      governanceTotal: governance.summary?.total || 0,
      acceptance: acceptance.status,
      acceptanceReady: acceptance.summary?.ready || 0,
      acceptanceTotal: acceptance.summary?.total || 0,
      milestones: milestones.status,
      milestonesReady: milestones.summary?.ready || 0,
      milestonesTotal: milestones.summary?.total || 0,
      e2eReadiness: e2eReadiness.status,
      e2eReady: e2eReadiness.summary?.ready || 0,
      e2eTotal: e2eReadiness.summary?.total || 0,
      savedExternalEvidence: externalEvidence.status,
    },
    blockers,
    externalReadiness: summarizeStatusE2E(e2eReadiness),
    externalEvidence: summarizeStatusExternalEvidence(externalEvidence),
    runnableCommands,
    next,
    note: ready
      ? "Local governance, acceptance, and milestone audits are ready. Current E2E readiness may still depend on the active machine credentials/runtime."
      : "Local status is not fully ready. The blockers list separates saved-evidence gaps from current readiness prerequisites.",
  };
}

export function runAudit({ repoRoot: root = repoRoot, argv = [], env = process.env } = {}) {
  const status = runStatus({ repoRoot: root, argv, env });
  const externalEvidence = describeExternalEvidence({ workspaceRoot: root });
  const requirements = [
    auditRequirement({
      id: "runtime-governance",
      title: "Runtime governance coverage",
      status: status.summary.governance === "ready" ? "ready" : "blocked",
      evidence: [`${status.summary.governanceCovered}/${status.summary.governanceTotal} rule-code couplings covered.`],
      remaining: status.summary.governance === "ready" ? [] : ["Run odai governance and fix missing runtime canary coverage."],
    }),
    auditRequirement({
      id: "plan-acceptance",
      title: "Plan acceptance matrix",
      status: status.summary.acceptance === "ready" ? "ready" : "blocked",
      evidence: [`${status.summary.acceptanceReady}/${status.summary.acceptanceTotal} acceptance scenarios ready.`],
      remaining: status.blockers
        .filter((blocker) => blocker.source === "acceptance")
        .flatMap((blocker) => blocker.remaining || []),
    }),
    auditRequirement({
      id: "executable-milestones",
      title: "Executable milestone audit",
      status: status.summary.milestones === "ready" ? "ready" : "blocked",
      evidence: [`${status.summary.milestonesReady}/${status.summary.milestonesTotal} executable milestones ready.`],
      remaining: status.blockers
        .filter((blocker) => blocker.source === "milestone")
        .flatMap((blocker) => blocker.remaining || []),
    }),
    ...externalEvidenceRequirements(externalEvidence),
  ];
  const ready = requirements.filter((requirement) => requirement.status === "ready").length;
  const blocked = requirements.length - ready;
  return {
    status: blocked === 0 ? "ready" : "partial",
    kind: "completion-audit",
    objective: "Build the odai CLI agent runtime through the plan's executable milestones.",
    complete: blocked === 0,
    summary: {
      ready,
      blocked,
      total: requirements.length,
      governance: status.summary.governance,
      acceptance: status.summary.acceptance,
      milestones: status.summary.milestones,
      savedExternalEvidence: status.summary.savedExternalEvidence,
    },
    requirements,
    blockers: status.blockers,
    next: status.next,
    note: blocked === 0
      ? "The current completion claim is backed by runtime governance, acceptance, milestone, and saved external evidence reports."
      : "Completion is not proven yet. Remaining blockers require saved external evidence before the goal can be marked complete.",
  };
}

export function runEvidence({ repoRoot: root = repoRoot } = {}) {
  return describeExternalEvidence({ workspaceRoot: root });
}

export async function runSetup({ repoRoot: root = repoRoot, argv = [], env = process.env } = {}) {
  const args = parseE2EArgs(argv);
  const language = detectLanguage({ env });
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const e2eReadiness = runE2EReadiness({ repoRoot: root, argv, env: workspaceEnv });
  const externalEvidence = describeExternalEvidence({ workspaceRoot: root });
  const configFiles = await inspectSetupConfigFiles(root);
  const sections = [
    setupSection({
      id: "workspace-config",
      title: "Workspace .odai config scaffold",
      status: configFiles.missingRequired.length === 0 ? "ready" : "blocked",
      evidence: [
        `${configFiles.presentRequired.length}/${configFiles.required.length} required config files are present.`,
        `${configFiles.presentExamples.length}/${configFiles.examples.length} example config files are present.`,
      ],
      remaining: configFiles.missingRequired.length === 0
        ? []
        : ["Run odai init to create safe .odai policy/provider/agent scaffolds without overwriting existing files."],
    }),
    setupReadinessSection({
      id: "provider-readiness",
      title: "Current API provider and subscription runtime readiness",
      requirements: e2eReadiness.requirements,
      requirementIds: ["provider-api", "provider-runtime"],
      fallback: "Run odai e2e --use-api-key --use-provider-command after configuring real provider credentials and a subscription CLI/SDK runtime.",
    }),
    setupEvidenceSection({
      id: "saved-provider-evidence",
      title: "Saved real API provider and subscription runtime probe evidence",
      externalEvidence,
      requirementId: "provider-api-and-runtime",
    }),
    setupEvidenceSection({
      id: "saved-subscription-cli-evidence",
      title: "Saved subscription CLI provider probe evidence",
      externalEvidence,
      requirementId: "provider-subscription-cli",
    }),
    setupReadinessSection({
      id: "strong-sandbox-readiness",
      title: "Current strong shell sandbox readiness",
      requirements: e2eReadiness.requirements,
      requirementIds: ["strong-sandbox"],
      fallback: "Configure .odai/policy.json with a non-none sandbox, then run odai sandbox until configuredStrong is true.",
    }),
    setupEvidenceSection({
      id: "saved-strong-sandbox-smoke",
      title: "Saved non-none strong sandbox smoke evidence",
      externalEvidence,
      requirementId: "strong-sandbox-smoke",
    }),
  ];
  const ready = sections.filter((section) => section.status === "ready").length;
  const blocked = sections.length - ready;
  const completionPath = setupCompletionPath({ sections, model: args.model });
  const next = setupNextActions({ completionPath });
  return {
    status: blocked === 0 ? "ready" : "partial",
    kind: "setup-guide",
    summary: {
      ready,
      blocked,
      total: sections.length,
      configReady: sections.find((section) => section.id === "workspace-config")?.status === "ready",
      e2eReady: e2eReadiness.summary?.ready || 0,
      e2eTotal: e2eReadiness.summary?.total || 0,
      savedEvidenceReady: externalEvidence.summary?.ready || 0,
      savedEvidenceTotal: (externalEvidence.summary?.ready || 0) + (externalEvidence.summary?.blocked || 0),
    },
    flags: {
      useApiKey: args.useApiKey,
      useProviderCommand: args.useProviderCommand,
      model: args.model || undefined,
    },
    commands: {
      interactive: "odai",
      task: 'odai "<task>"',
      script: 'odai run "<task>"',
      resume: "odai resume",
      init: "odai init",
      status: [
        "odai",
        "status",
        "--use-api-key",
        "--use-provider-command",
        ...(args.model ? ["--model", args.model] : []),
      ].join(" "),
      audit: [
        "odai",
        "audit",
        "--use-api-key",
        "--use-provider-command",
        ...(args.model ? ["--model", args.model] : []),
      ].join(" "),
    },
    cliSetup: cliSetupGuide({ language }),
    providerSetup: providerSetupGuide(),
    sandboxSetup: sandboxSetupGuide(),
    sections,
    completionPath,
    next,
    note: t(language, "setup.note"),
  };
}

function cliSetupGuide({ language = "en" } = {}) {
  return {
    packageFile: "cli/package.json",
    packageName: "odai-cli",
    bin: {
      name: "odai",
      target: "./bin/odai.mjs",
    },
    localExecutable: "./cli/bin/odai.mjs",
    linkCommand: "npm --prefix cli link",
    npxCommand: "npx odai-cli",
    globalInstallCommand: "npm install -g odai-cli",
    note: t(language, "setup.cliSetup.note"),
  };
}

function providerSetupGuide() {
  return {
    builtIn: [
      {
        name: "openai-api",
        env: ["OPENAI_API_KEY", "ODAI_OPENAI_MODEL"],
        check: "odai doctor --provider openai-api --use-api-key --save",
      },
      {
        name: "anthropic-api",
        env: ["ANTHROPIC_API_KEY", "ODAI_ANTHROPIC_MODEL"],
        check: "odai doctor --provider anthropic-api --use-api-key --save",
      },
      {
        name: "gemini-api",
        env: ["GEMINI_API_KEY", "ODAI_GEMINI_MODEL"],
        check: "odai doctor --provider gemini-api --use-api-key --save",
      },
      {
        name: "deepseek-api",
        env: ["DEEPSEEK_API_KEY", "ODAI_DEEPSEEK_MODEL"],
        auth: "odai auth provider deepseek-api --api-key-stdin",
        check: "odai doctor --provider deepseek-api --use-api-key --save",
      },
      {
        name: "claude-agent-sdk",
        package: "@anthropic-ai/claude-agent-sdk",
        optionalEnv: ["CLAUDE_CODE_EXECUTABLE", "ODAI_CLAUDE_MODEL"],
        check: "odai doctor --provider claude-agent-sdk --use-provider-command --save",
      },
      {
        name: "claude-cli",
        command: "claude",
        optionalEnv: ["ODAI_CLAUDE_COMMAND", "ODAI_CLAUDE_MODEL"],
        check: "odai doctor --provider claude-cli --use-provider-command --save",
      },
      {
        name: "codex-cli",
        command: "codex",
        optionalEnv: ["ODAI_CODEX_COMMAND", "ODAI_CODEX_MODEL"],
        check: "odai doctor --provider codex-cli --use-provider-command --save",
      },
      {
        name: "grok-cli",
        command: "grok",
        optionalEnv: ["ODAI_GROK_COMMAND", "ODAI_GROK_MODEL"],
        check: "odai doctor --provider grok-cli --use-provider-command --save",
      },
    ],
    custom:
      "Use .odai/providers.json for openai-compatible, command-json, or ollama providers; see .odai/providers.example.json.",
  };
}

function sandboxSetupGuide() {
  return {
    policyFile: ".odai/policy.json",
    exampleFile: ".odai/policy.example.json",
    preflight: "odai sandbox",
    smoke: "odai doctor --sandbox --smoke --allow-shell --save",
    candidates: [
      {
        mode: "docker",
        requires: ["docker command", "local sandbox image such as node:22-alpine"],
        policyExample: "examples.docker",
      },
      {
        mode: "devcontainer",
        requires: ["devcontainer command", "workspace devcontainer configuration"],
        policyExample: "examples.devcontainer",
      },
      {
        mode: "macos-sandbox-exec",
        requires: ["macOS", "usable sandbox-exec"],
        policyExample: "examples.macosSandboxExec",
      },
    ],
    note:
      "Copy one policy example only after confirming the command allowlist and sandbox match this workspace; smoke still requires --allow-shell.",
  };
}

function setupSection({ id, title, status, evidence = [], remaining = [] } = {}) {
  return {
    id,
    title,
    status,
    evidence: evidence.filter(Boolean),
    remaining: status === "ready" ? [] : uniqueStatusActions(remaining),
  };
}

function setupReadinessSection({ id, title, requirements = [], requirementIds = [], fallback } = {}) {
  const matched = requirements.filter((requirement) => requirementIds.includes(requirement.id));
  const ready = matched.length > 0 && matched.every((requirement) => requirement.status === "ready");
  return setupSection({
    id,
    title,
    status: ready ? "ready" : "blocked",
    evidence: matched.map((requirement) => `${requirement.id}: ${requirement.status}`),
    remaining: ready ? [] : uniqueStatusActions([...matched.flatMap((requirement) => requirement.next || []), fallback]),
  });
}

function setupEvidenceSection({ id, title, externalEvidence, requirementId } = {}) {
  const requirement = (externalEvidence?.requirements || []).find((item) => item.id === requirementId);
  const ready = requirement?.status === "ready";
  return setupSection({
    id,
    title,
    status: ready ? "ready" : "blocked",
    evidence: requirement ? [`${countStatusEvidence(requirement)} saved evidence item(s).`] : [],
    remaining: ready ? [] : requirement?.remaining || [],
  });
}

function setupCompletionPath({ sections = [], model = "" } = {}) {
  const byId = new Map(sections.map((section) => [section.id, section]));
  return [
    setupCompletionStep({
      id: "workspace-config",
      title: "Create safe workspace config scaffolds.",
      section: byId.get("workspace-config"),
      next: ["odai init"],
    }),
    setupCompletionStep({
      id: "provider-prerequisites",
      title: "Make one API provider and one subscription runtime available.",
      section: byId.get("provider-readiness"),
      next: [
        "Configure OPENAI_API_KEY + ODAI_OPENAI_MODEL, or set an API key and pass --model <name>, or configure an openai-compatible provider.",
        "Install and authenticate a supported subscription CLI/SDK provider such as Codex CLI, Grok CLI, Claude CLI, or Claude Agent SDK.",
        [
          "odai",
          "e2e",
          "--use-api-key",
          "--use-provider-command",
          ...(model ? ["--model", model] : []),
        ].join(" "),
      ],
    }),
    setupCompletionStep({
      id: "provider-evidence",
      title: "Save real API provider and subscription runtime probe evidence.",
      section: byId.get("saved-provider-evidence"),
      next: [
        [
          "odai",
          "doctor",
          "--all",
          "--use-api-key",
          "--use-provider-command",
          ...(model ? ["--model", model] : []),
          "--save",
        ].join(" "),
      ],
    }),
    setupCompletionStep({
      id: "subscription-cli-evidence",
      title: "Save at least one subscription CLI provider probe.",
      section: byId.get("saved-subscription-cli-evidence"),
      next: ["odai doctor --provider codex-cli --use-provider-command --save"],
    }),
    setupCompletionStep({
      id: "strong-sandbox-prerequisites",
      title: "Configure a ready non-none shell sandbox.",
      section: byId.get("strong-sandbox-readiness"),
      next: [
        "Configure .odai/policy.json shell.sandbox.mode with a ready strong sandbox.",
        "odai sandbox",
      ],
    }),
    setupCompletionStep({
      id: "strong-sandbox-evidence",
      title: "Save a strong sandbox smoke through the odai dispatcher.",
      section: byId.get("saved-strong-sandbox-smoke"),
      next: ["odai doctor --sandbox --smoke --allow-shell --save"],
    }),
  ];
}

function setupCompletionStep({ id, title, section, next = [] } = {}) {
  const status = section?.status === "ready" ? "ready" : "blocked";
  return {
    id,
    title,
    status,
    evidence: section?.evidence || [],
    next: status === "ready" ? [] : next,
  };
}

function setupNextActions({ completionPath = [] } = {}) {
  return uniqueStatusActions(completionPath.flatMap((step) => step.next || [])).slice(0, 10);
}

async function inspectSetupConfigFiles(root) {
  const required = [
    path.join(".odai", "policy.json"),
    path.join(".odai", "providers.json"),
    path.join(".odai", "agents.json"),
  ];
  const examples = [
    path.join(".odai", "policy.example.json"),
    path.join(".odai", "providers.example.json"),
    path.join(".odai", "agents.example.json"),
  ];
  const presentRequired = [];
  const missingRequired = [];
  const presentExamples = [];
  const missingExamples = [];
  for (const relativePath of required) {
    if (await fileExists(path.join(root, relativePath))) {
      presentRequired.push(relativePath);
    } else {
      missingRequired.push(relativePath);
    }
  }
  for (const relativePath of examples) {
    if (await fileExists(path.join(root, relativePath))) {
      presentExamples.push(relativePath);
    } else {
      missingExamples.push(relativePath);
    }
  }
  return {
    required,
    examples,
    presentRequired,
    missingRequired,
    presentExamples,
    missingExamples,
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function auditRequirement({ id, title, status, evidence = [], remaining = [] } = {}) {
  return {
    id,
    title,
    status,
    evidence,
    remaining: status === "ready" ? [] : uniqueStatusActions(remaining),
  };
}

function externalEvidenceRequirements(externalEvidence) {
  const requirements = [];
  for (const requirement of externalEvidence?.requirements || []) {
    requirements.push(
      auditRequirement({
        id: `saved-${requirement.id}`,
        title: requirement.need,
        status: requirement.status === "ready" ? "ready" : "blocked",
        evidence: [`${countStatusEvidence(requirement)} saved evidence item(s).`],
        remaining: requirement.remaining || [],
      }),
    );
  }
  return requirements;
}

function statusBlockers({ acceptance, milestones } = {}) {
  const blockers = [];
  for (const item of acceptance?.items || []) {
    if (item.status === "ready") continue;
    blockers.push({
      source: "acceptance",
      id: item.id,
      status: item.status,
      title: item.scenario,
      remaining: item.remaining || [],
    });
  }
  for (const item of milestones?.items || []) {
    if (item.status === "ready") continue;
    blockers.push({
      source: "milestone",
      id: item.id,
      status: item.status,
      title: item.title,
      remaining: item.remaining || [],
    });
  }
  return blockers;
}

function statusNextActions({ blockers = [], e2eReadiness, externalEvidence } = {}) {
  const actions = [];
  for (const action of authPreparationActions({ e2eReadiness, externalEvidence })) {
    actions.push(action);
  }
  for (const command of relevantRunnableCommands({ e2eReadiness, externalEvidence })) {
    actions.push(command);
  }
  for (const blocker of blockers) {
    for (const remaining of blocker.remaining || []) {
      actions.push(remaining);
    }
  }
  for (const requirement of externalEvidence?.requirements || []) {
    for (const remaining of requirement.remaining || []) {
      actions.push(remaining);
    }
  }
  return uniqueStatusActions(actions).slice(0, 12);
}

function authPreparationActions({ e2eReadiness, externalEvidence } = {}) {
  return [];
}

function relevantRunnableCommands({ e2eReadiness, externalEvidence } = {}) {
  const providerEvidenceNeeded = externalRequirementBlocked(externalEvidence, "provider-api-and-runtime");
  const providerEvidenceGaps = providerApiAndRuntimeEvidenceGaps(externalEvidence);
  const subscriptionEvidenceNeeded = externalRequirementBlocked(externalEvidence, "provider-subscription-cli");
  const sandboxEvidenceNeeded = externalRequirementBlocked(externalEvidence, "strong-sandbox-smoke");
  const providers = e2eReadiness?.providers?.providers || [];
  const commands = e2eReadiness?.runnableCommands || [];
  return commands.filter((command) => {
    if (command.includes("doctor --all")) {
      return (
        providerEvidenceNeeded &&
        providerEvidenceGaps.api &&
        providerEvidenceGaps.runtime &&
        readinessRequirementReady(e2eReadiness, "provider-api") &&
        readinessRequirementReady(e2eReadiness, "provider-runtime")
      );
    }
    if (command.includes("doctor --sandbox")) {
      return sandboxEvidenceNeeded && readinessRequirementReady(e2eReadiness, "strong-sandbox");
    }

    const providerName = providerNameFromDoctorCommand(command);
    if (!providerName) return false;
    const provider = providers.find((item) => item.name === providerName);
    if (!provider?.available) return false;
    if (subscriptionEvidenceNeeded && provider.kind === "subscription-cli") {
      return true;
    }
    if (!providerEvidenceNeeded) return false;
    if (providerEvidenceGaps.api && ["api", "openai-compatible"].includes(provider.kind)) {
      return true;
    }
    if (providerEvidenceGaps.runtime && ["subscription-cli", "subscription-sdk"].includes(provider.kind)) {
      return true;
    }
    return false;
  });
}

function providerApiAndRuntimeEvidenceGaps(externalEvidence) {
  const requirement = (externalEvidence?.requirements || []).find((item) => item.id === "provider-api-and-runtime");
  const evidence = requirement?.evidence || {};
  return {
    api: !Array.isArray(evidence.apiProviders) || evidence.apiProviders.length === 0,
    runtime: !Array.isArray(evidence.runtimeProviders) || evidence.runtimeProviders.length === 0,
  };
}

function externalRequirementBlocked(externalEvidence, id) {
  return (externalEvidence?.requirements || []).some((requirement) => requirement.id === id && requirement.status !== "ready");
}

function readinessRequirementReady(e2eReadiness, id) {
  return (e2eReadiness?.requirements || []).some((requirement) => requirement.id === id && requirement.status === "ready");
}

function providerNameFromDoctorCommand(command = "") {
  const parts = String(command).split(/\s+/);
  const index = parts.indexOf("--provider");
  return index >= 0 ? parts[index + 1] : undefined;
}

function summarizeStatusE2E(e2eReadiness) {
  if (!e2eReadiness || e2eReadiness.kind !== "e2e-readiness") {
    return undefined;
  }
  return {
    kind: e2eReadiness.kind,
    status: e2eReadiness.status,
    summary: e2eReadiness.summary,
    requirements: (e2eReadiness.requirements || []).map((requirement) => ({
      id: requirement.id,
      status: requirement.status,
      evidenceCount: Array.isArray(requirement.evidence) ? requirement.evidence.length : 0,
      blockedCount: Array.isArray(requirement.blocked) ? requirement.blocked.length : 0,
    })),
  };
}

function summarizeStatusExternalEvidence(externalEvidence) {
  if (!externalEvidence || externalEvidence.kind !== "external-evidence") {
    return undefined;
  }
  return {
    kind: externalEvidence.kind,
    status: externalEvidence.status,
    summary: externalEvidence.summary,
    requirements: (externalEvidence.requirements || []).map((requirement) => ({
      id: requirement.id,
      status: requirement.status,
      evidenceCount: countStatusEvidence(requirement),
      remainingCount: Array.isArray(requirement.remaining) ? requirement.remaining.length : 0,
    })),
  };
}

function countStatusEvidence(requirement) {
  if (Array.isArray(requirement?.evidence)) {
    return requirement.evidence.length;
  }
  if (requirement?.evidence && typeof requirement.evidence === "object") {
    return Object.values(requirement.evidence).reduce(
      (total, value) => total + (Array.isArray(value) ? value.length : 0),
      0,
    );
  }
  return 0;
}

function uniqueStatusActions(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const action = value.trim();
    if (action === "") continue;
    const key = statusActionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function statusActionKey(action) {
  const command = extractOdaiCommand(action);
  if (command) {
    return `command:${command}`;
  }
  return `text:${action.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function extractOdaiCommand(action) {
  const tokens = String(action)
    .replace(/[.,;:]+$/g, "")
    .split(/\s+/)
    .map((token) => token.replace(/^[("'`]+|[)"'`,.;:]+$/g, ""))
    .filter(Boolean);
  const start = tokens.findIndex((token) => token.toLowerCase() === "odai");
  if (start < 0 || start + 1 >= tokens.length) {
    return "";
  }

  const stopWords = new Set([
    "against",
    "and",
    "before",
    "then",
    "to",
    "under",
    "until",
    "with",
  ]);
  const commandTokens = [tokens[start].toLowerCase(), tokens[start + 1].toLowerCase()];
  for (const token of tokens.slice(start + 2)) {
    const normalized = token.toLowerCase();
    if (stopWords.has(normalized)) {
      break;
    }
    commandTokens.push(normalized);
  }
  return commandTokens.join(" ");
}

export function runAcceptance({ repoRoot: root = repoRoot, argv = [], env = process.env } = {}) {
  const args = parseE2EArgs(argv);
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  return describeAcceptance({
    e2eReadiness: describeE2EReadiness({
      workspaceRoot: root,
      env: workspaceEnv,
      allowApiKey: args.useApiKey,
      allowProviderCommand: args.useProviderCommand,
      modelOverride: args.model,
    }),
    externalEvidence: describeExternalEvidence({
      workspaceRoot: root,
    }),
  });
}

export function runMilestones({
  repoRoot: root = repoRoot,
  argv = [],
  env = process.env,
} = {}) {
  const args = parseE2EArgs(argv);
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  return describeMilestones({
    e2eReadiness: describeE2EReadiness({
      workspaceRoot: root,
      env: workspaceEnv,
      allowApiKey: args.useApiKey,
      allowProviderCommand: args.useProviderCommand,
      modelOverride: args.model,
    }),
    externalEvidence: describeExternalEvidence({
      workspaceRoot: root,
    }),
  });
}

export function runSandboxReadiness({
  repoRoot: root = repoRoot,
  platform,
  commandExists,
  sandboxProbe,
} = {}) {
  return describeSandboxReadiness({
    workspaceRoot: root,
    platform,
    commandExists,
    sandboxProbe,
  });
}

export async function runSandboxSmoke({
  repoRoot: root = repoRoot,
  argv = [],
  platform,
  commandExists,
  sandboxProbe,
  runShellCommand,
} = {}) {
  return executeSandboxSmoke({
    workspaceRoot: root,
    allowShell: hasFlag(argv, "--allow-shell"),
    platform,
    commandExists,
    sandboxProbe,
    runShellCommand,
  });
}

export function runE2EReadiness({
  repoRoot: root = repoRoot,
  argv = [],
  env = process.env,
  sandboxOptions,
} = {}) {
  const args = parseE2EArgs(argv);
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  return describeE2EReadiness({
    workspaceRoot: root,
    env: workspaceEnv,
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    modelOverride: args.model,
    sandboxOptions,
  });
}

export async function runInit({ repoRoot: root = repoRoot, argv = [] } = {}) {
  return initWorkspace({
    workspaceRoot: root,
    force: argv.includes("--force"),
  });
}

async function loadLatestSessionResumeContext({ repoRoot: root = repoRoot, tail = 20 } = {}) {
  try {
    const latest = await readLatestWorkspaceTranscript({
      workspaceRoot: root,
      tail,
      includeContext: true,
    });
    return latest.context;
  } catch (error) {
    return {
      status: "blocked",
      error: publicError(error),
      note: "No previous session transcript is available to resume.",
    };
  }
}

export async function runCanaryRunner({ repoRoot: root = repoRoot, argv = [], stdinText } = {}) {
  const args = parseCanaryArgs(argv);
  const runtimeCase = normalizeRuntimeCanaryCase(args.runtimeCase);
  const prompt = typeof stdinText === "string" ? stdinText : await readStdin();
  const taskArgv = buildCanaryTaskArgv({ args: { ...args, runtimeCase }, prompt, root });
  const conversationContext = buildCanaryConversationContext({ runtimeCase });
  const run = await runMockTask({
    repoRoot: root,
    argv: taskArgv,
    conversationContext,
  });
  const evidence = summarizeEvidenceCounts(run.evidence);
  const selectedProvider =
    run.agentLoop?.agent?.provider || run.subagent?.provider || run.providerSelection?.selected || args.provider || "mock-main";
  const explicitProvider = Boolean(args.provider);
  const message = [
    "状态：ready",
    explicitProvider
      ? "odai CLI canary runner executed the odai runtime with an explicit provider request."
      : "odai CLI canary runner executed the mock odai runtime.",
    explicitProvider
      ? "Provider execution is governed by the same odai runtime gates; no local tools bypassed odai."
      : "No real model was called; no project files were intentionally changed.",
    `runStatus: ${run.status}`,
    `mode: ${run.mode}`,
    runtimeCase ? `runtimeCase: ${runtimeCase}` : "",
    `provider: ${selectedProvider}`,
    `events: ${evidence.events}`,
    `denials: ${evidence.denials}`,
    `commands: ${evidence.commands}`,
    `checkpoints: ${evidence.checkpoints}`,
    `recordPath: ${run.recordPath}`,
  ].join("\n");
  if (args.lastMessage) {
    await writeFile(args.lastMessage, `${message}\n`, "utf8");
  }
  return { message, run };
}

function buildCanaryTaskArgv({ args, prompt, root }) {
  const riskFlags = [
    ...(args.useApiKey ? ["--use-api-key"] : []),
    ...(args.useProviderCommand ? ["--use-provider-command"] : []),
  ];
  const maxTurnFlags = Number.isFinite(args.maxTurns) && args.maxTurns !== 4
    ? ["--max-turns", String(args.maxTurns)]
    : [];
  const providerFlags = args.provider ? ["--provider", args.provider] : [];
  const runtimeCase = normalizeRuntimeCanaryCase(args.runtimeCase);

  if (runtimeCase === "subagent-write-denied") {
    return [
      prompt || "runtime canary: subagent write denied",
      "--profile",
      "reviewer",
      "--provider",
      args.provider || "mock-reviewer",
      "--tool-intent-json",
      JSON.stringify({
        type: "write",
        path: path.join(root, "src", "app.js"),
        content: "subagent should not write\n",
      }),
      ...riskFlags,
    ];
  }

  if (runtimeCase === "network-default-denied") {
    return [
      prompt || "runtime canary: network denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "network",
        url: "https://example.com/odai-runtime-canary",
        method: "GET",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "new-file-checkpoint") {
    return [
      prompt || "runtime canary: new file checkpoint",
      "--agent-loop",
      ...providerFlags,
      "--target",
      path.join(root, ".odai", "runs", `runtime-canary-created-${process.pid}-${Date.now()}.txt`),
      "--content",
      "runtime canary created\n",
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "secret-read-denied") {
    return [
      prompt || "runtime canary: secret read denied",
      "--agent-loop",
      ...providerFlags,
      "--file",
      path.join(root, ".env"),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "secret-write-denied") {
    return [
      prompt || "runtime canary: secret write denied",
      "--agent-loop",
      ...providerFlags,
      "--target",
      path.join(root, ".env"),
      "--content",
      "ODAI_RUNTIME_CANARY_SECRET=must-not-be-written\n",
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "sensitive-intent-redaction") {
    return [
      prompt || "runtime canary: sensitive intent redaction",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "network",
        url: "https://example.com/odai-runtime-canary?token=odai-runtime-secret&ok=1",
        method: "GET",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "stop-repeated-failure") {
    const target = path.join(root, "runtime-canary-stop-target.txt");
    const repeatedWrite = {
      type: "write",
      path: target,
      content: "stop canary should not write\n",
    };
    return [
      prompt || "runtime canary: stop repeated failure",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify(repeatedWrite),
      "--tool-intent-json",
      JSON.stringify(repeatedWrite),
      "--tool-intent-json",
      JSON.stringify(repeatedWrite),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "perception-write-denied") {
    return [
      prompt || "runtime canary: perception write denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "write",
        path: path.join(root, "runtime-canary-perception-target.txt"),
        content: "perception canary should not write\n",
        risk: "perception",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "shell-intent-record-only") {
    const target = path.join(root, "runtime-canary-shell-target.txt");
    return [
      prompt || "runtime canary: shell intent record only",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "shell",
        command: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(target)}, "shell canary executed\\n")`,
          "Authorization: Bearer odai-shell-secret-token",
          "TOKEN=odai-shell-env-secret",
        ],
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "subagent-user-channel-denied") {
    return [
      prompt || "runtime canary: subagent user channel denied",
      "--profile",
      "reviewer",
      "--provider",
      args.provider || "mock-reviewer",
      "--tool-intent-json",
      JSON.stringify({
        type: "ask-user",
        question: "Can the subagent ask the user directly?",
      }),
      "--tool-intent-json",
      JSON.stringify({
        type: "complete",
        summary: "Subagent claims the task is complete.",
      }),
      ...riskFlags,
    ];
  }

  if (runtimeCase === "tool-intent-overflow-denied") {
    const readIntent = {
      type: "read",
      path: path.join(root, "src", "app.js"),
    };
    return [
      prompt || "runtime canary: tool intent overflow denied",
      "--agent-loop",
      ...providerFlags,
      ...Array.from({ length: 21 }, () => ["--tool-intent-json", JSON.stringify(readIntent)]).flat(),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "tool-intent-payload-denied") {
    return [
      prompt || "runtime canary: tool intent payload denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "write",
        path: path.join(root, ".odai", "runs", "runtime-canary-payload-target.txt"),
        content: "x".repeat(DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS + 1),
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "production-authorization-denied") {
    return [
      prompt || "runtime canary: production authorization denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "shell",
        command: ["deploy", "production"],
        risk: "production",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "model-output-redaction") {
    return [
      prompt || "runtime canary: model output redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "provider-error-redaction") {
    return [
      prompt || "runtime canary: provider error redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "provider-session-redaction") {
    return [
      prompt || "runtime canary: provider session redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "provider-context-redaction") {
    return [
      prompt || "runtime canary: provider context redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "task-persistence-redaction") {
    return [
      prompt || "runtime canary: task persistence redaction api_key=odai-task-secret Bearer odai-task-bearer-secret token=odai-task-token-secret",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  return [
    prompt || "canary prompt",
    "--agent-loop",
    ...providerFlags,
    ...args.files.flatMap((file) => ["--file", file]),
    ...maxTurnFlags,
    ...riskFlags,
  ];
}

function buildCanaryConversationContext({ runtimeCase } = {}) {
  if (runtimeCase !== "provider-context-redaction") {
    return undefined;
  }
  return {
    status: "ready",
    kind: "session-compact-context",
    sourceSessionId: "runtime-canary-context-source",
    sourceTranscriptPath: "/tmp/odai-runtime-canary-context-transcript-secret.jsonl",
    currentTranscriptPath: "/tmp/odai-runtime-canary-current-transcript-secret.jsonl",
    notRestored: ["api-key-confirmation", "provider-command-confirmation"],
    authorizations: {
      approvedScopes: ["risk:production"],
      deniedScopes: ["risk:external"],
    },
    providerSessions: [
      { provider: "other-provider", sessionId: "other-context-session-should-not-leak" },
      { provider: "mock-main", sessionId: "mock-main-context-session" },
    ],
    lastResult: {
      status: "ready",
      task: "previous provider context canary",
      savedRecordPath: "/tmp/odai-runtime-canary-run-record-secret.json",
      requiredAuthorizations: ["risk:credential"],
      requiredAuthorizationCount: 1,
      providerSessions: [{ provider: "mock-main", sessionId: "mock-main-last-result-session" }],
    },
    recent: [
      { type: "authorization-result", scope: "risk:billing", approved: true, answered: true },
    ],
  };
}

function normalizeRuntimeCanaryCase(value = "") {
  const item = String(value || "").trim();
  if (!item) return "";
  const aliases = {
    "1": "subagent-write-denied",
    "subagent-write": "subagent-write-denied",
    "subagent-write-denied": "subagent-write-denied",
    "2": "network-default-denied",
    "network-deny": "network-default-denied",
    "network-default-denied": "network-default-denied",
    "3": "new-file-checkpoint",
    "new-file": "new-file-checkpoint",
    "new-file-checkpoint": "new-file-checkpoint",
    "4": "secret-read-denied",
    "secret-read": "secret-read-denied",
    "secret-read-denied": "secret-read-denied",
    "5": "secret-write-denied",
    "secret-write": "secret-write-denied",
    "secret-write-denied": "secret-write-denied",
    "6": "sensitive-intent-redaction",
    "redaction": "sensitive-intent-redaction",
    "sensitive-intent-redaction": "sensitive-intent-redaction",
    "7": "stop-repeated-failure",
    "stop": "stop-repeated-failure",
    "stop-repeated-failure": "stop-repeated-failure",
    "8": "perception-write-denied",
    "perception": "perception-write-denied",
    "perception-write-denied": "perception-write-denied",
    "9": "shell-intent-record-only",
    "shell": "shell-intent-record-only",
    "shell-record-only": "shell-intent-record-only",
    "shell-intent-record-only": "shell-intent-record-only",
    "10": "subagent-user-channel-denied",
    "subagent-user-channel": "subagent-user-channel-denied",
    "subagent-ask-complete": "subagent-user-channel-denied",
    "subagent-user-channel-denied": "subagent-user-channel-denied",
    "11": "tool-intent-overflow-denied",
    "overflow": "tool-intent-overflow-denied",
    "tool-intent-overflow": "tool-intent-overflow-denied",
    "tool-intent-overflow-denied": "tool-intent-overflow-denied",
    "12": "production-authorization-denied",
    "production": "production-authorization-denied",
    "production-authorization": "production-authorization-denied",
    "production-authorization-denied": "production-authorization-denied",
    "13": "model-output-redaction",
    "model-output": "model-output-redaction",
    "model-output-redaction": "model-output-redaction",
    "14": "provider-error-redaction",
    "provider-error": "provider-error-redaction",
    "provider-error-redaction": "provider-error-redaction",
    "15": "provider-session-redaction",
    "provider-session": "provider-session-redaction",
    "provider-session-redaction": "provider-session-redaction",
    "16": "provider-context-redaction",
    "provider-context": "provider-context-redaction",
    "provider-context-redaction": "provider-context-redaction",
    "17": "task-persistence-redaction",
    "task-persistence": "task-persistence-redaction",
    "task-persistence-redaction": "task-persistence-redaction",
    "18": "tool-intent-payload-denied",
    "payload": "tool-intent-payload-denied",
    "tool-intent-payload": "tool-intent-payload-denied",
    "tool-intent-payload-denied": "tool-intent-payload-denied",
  };
  const normalized = aliases[item];
  if (!normalized) {
    throw new Error(`Unknown --runtime-case: ${value}`);
  }
  return normalized;
}

function summarizeEvidenceCounts(evidence = {}) {
  return {
    events: Array.isArray(evidence.events) ? evidence.events.length : 0,
    denials: Array.isArray(evidence.denials) ? evidence.denials.length : 0,
    commands: Array.isArray(evidence.commands) ? evidence.commands.length : 0,
    checkpoints: Array.isArray(evidence.checkpoints) ? evidence.checkpoints.length : 0,
  };
}

export async function runDoctor({
  repoRoot: root = repoRoot,
  argv = [],
  env = process.env,
  onEvent,
  fetchImpl,
} = {}) {
  const args = parseDoctorArgs(argv);
  args.onEvent = onEvent;
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });

  if (args.governance) {
    const result = runGovernance();
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.status) {
    const result = runStatus({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.setup) {
    const result = await runSetup({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.audit) {
    const result = runAudit({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.evidence) {
    const result = runEvidence({ repoRoot: root });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.acceptance) {
    const result = runAcceptance({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.milestones) {
    const result = runMilestones({
      repoRoot: root,
      argv: buildE2EArgvFromDoctorArgs(args),
      env: workspaceEnv,
    });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.sandbox) {
    const result = args.smoke
      ? await runSandboxSmoke({
          repoRoot: root,
          argv: [
            "--smoke",
            ...(args.allowShell ? ["--allow-shell"] : []),
          ],
        })
      : runSandboxReadiness({ repoRoot: root });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  if (args.e2e) {
    const result = runE2EReadiness({
      repoRoot: root,
      argv: buildE2EArgvFromDoctorArgs(args),
      env: workspaceEnv,
    });
    if (args.save) {
      result.savedRecordPath = await writeWorkspaceRunRecord({
        workspaceRoot: root,
        record: {
          ...result,
          mode: "doctor",
          resume: {
            argv: buildDoctorResumeArgv(args),
          },
        },
      });
    }
    return result;
  }

  const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: root });
  const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    config: providerConfig,
    fetchImpl,
  });

  const providerReport = describeProviders(withRegistryModelOverride(registry, args.model), workspaceEnv);
  let result;
  if (args.all) {
    const probes = [];
    for (const provider of registry.list()) {
      probes.push(await probeDoctorProvider({ provider, args }));
    }
    const summary = summarizeDoctorProbes(probes);
    result = {
      status: doctorSummaryStatus(summary),
      providers: providerReport,
      probes,
      summary,
      note: "Only providers marked available were probed. Blocked providers were not called.",
    };
  } else if (!args.provider) {
    return {
      status: "ready",
      providers: providerReport,
      note: "Use `odai doctor --provider <name>` or `odai doctor --all` to run no-tool provider probes.",
    };
  } else {
    try {
      const provider = registry.get(args.provider);
      result = await probeDoctorProvider({ provider, args });
    } catch (error) {
      result = {
        status: "failed",
        provider: args.provider,
        error: publicError(error),
      };
    }
  }

  if (args.save) {
    result.savedRecordPath = await writeWorkspaceRunRecord({
      workspaceRoot: root,
      record: {
        ...result,
        mode: "doctor",
        resume: {
          argv: buildDoctorResumeArgv(args),
        },
      },
    });
  }
  return result;
}

async function probeDoctorProvider({ provider, args }) {
  const effectiveProvider = withProviderModelOverride(provider, args.model);
  if (effectiveProvider.available === false) {
    return {
      status: "blocked",
      provider: summarizeProvider(effectiveProvider),
      probe: undefined,
      error: {
        name: "ProviderUnavailable",
        message: effectiveProvider.blockedReason || `Provider is not available: ${effectiveProvider.name}`,
      },
    };
  }

  try {
    const probeEvents = [];
    const usageLedger = new UsageLedger();
    const probeOnEvent = args.stream
      ? (event) => {
          probeEvents.push(event);
          args.onEvent?.(event);
        }
      : undefined;
    const agent = {
      id: `doctor:${provider.name}:${Date.now()}`,
      role: "doctor",
      provider: effectiveProvider.name,
    };
    const { output } = await usageLedger.trackProviderCall({
      provider: effectiveProvider,
      agent,
      profile: "doctor",
      mode: "provider_probe",
      run: () =>
        effectiveProvider.run({
          agent,
          input: {
            task: args.prompt,
            mode: "provider_probe",
            constraints: [
              "Do not request local tools.",
              "Return a short health-check response.",
              "Do not claim that files, shell commands, or network tools were executed.",
            ],
          },
          tools: {},
          onEvent: probeOnEvent,
        }),
    });
    const usageSnapshot = usageLedger.snapshot();
    return {
      status: "ready",
      provider: summarizeProvider(effectiveProvider),
      probe: summarizeProviderProbe(output),
      events: args.stream ? summarizeProgressEvents(probeEvents) : undefined,
      providerSessions: collectProviderSessions(usageSnapshot.calls),
      usage: usageSnapshot,
    };
  } catch (error) {
    return {
      status: "failed",
      provider: summarizeProvider(effectiveProvider),
      error: publicError(error),
      next: doctorFailureNext({ provider: effectiveProvider, error, args }),
    };
  }
}

function doctorFailureNext({ provider, error, args } = {}) {
  const message = String(error?.message || "");
  if (provider?.name === "claude-cli" && /not logged in|\/login/i.test(message)) {
    const command = provider.source?.command || "claude";
    return [
      `Run ${redactString(redactUrl(command))} and enter /login.`,
      [
        "odai",
        "doctor",
        "--provider",
        "claude-cli",
        "--use-provider-command",
        ...(args?.model ? ["--model", args.model] : ["--model", "<model>"]),
        "--save",
      ].join(" "),
    ];
  }
  return [];
}

function summarizeDoctorProbes(probes = []) {
  return probes.reduce(
    (summary, probe) => {
      summary.total += 1;
      summary[probe.status] = (summary[probe.status] || 0) + 1;
      return summary;
    },
    { total: 0, ready: 0, blocked: 0, failed: 0 },
  );
}

export function doctorSummaryStatus(summary = {}) {
  if ((summary.failed || 0) > 0) return "failed";
  if ((summary.blocked || 0) > 0) return "partial";
  return "ready";
}

export async function runPhase0Demo({ repoRoot: root = repoRoot, allowApiKey = false } = {}) {
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "odai-cli-phase0-"));
  const sampleFile = path.join(sessionTmp, "sample.txt");
  await writeFile(sampleFile, "before\n", "utf8");

  const skillPack = await loadSkillPack({ repoRoot: root });
  const session = new SessionState({ id: "phase0-demo" });
  const evidence = new EvidenceLedger();
  const usageLedger = new UsageLedger({ evidence });
  const dispatcher = new ToolDispatcher({
    workspaceRoot: root,
    sessionTmp,
    evidence,
    session,
    checkpointDir: path.join(sessionTmp, "checkpoints"),
  });

  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env: process.env });
  const providers = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey,
    allowProviderCommand: false,
    config: loadWorkspaceProviderConfig({ workspaceRoot: root }),
  });

  const scheduler = new Scheduler({
    providers,
    agentProfiles: loadWorkspaceAgentProfiles({ workspaceRoot: root }),
    dispatcher,
    evidence,
    usageLedger,
  });

  const blockedWrite = await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "write",
    path: sampleFile,
    content: "blocked\n",
  });

  await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "read",
    path: sampleFile,
  });

  const allowedWrite = await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "write",
    path: sampleFile,
    content: "after\n",
  });

  const subagentResult = await scheduler.runSubagent({
    profileName: "reviewer",
    providerName: "mock-reviewer",
    input: {
      task: "Review a phase0 patch proposal.",
      files: [sampleFile],
    },
  });

  const patchCandidate = await scheduler.runSubagent({
    profileName: "implementer_candidate",
    providerName: "mock-main",
    input: {
      task: "Propose a patch for phase0.",
      target: sampleFile,
      content: "candidate after\n",
    },
  });

  const subagentBlockedWrite = await dispatcher.dispatch({
    actor: { kind: "subagent", id: subagentResult.agent.id },
    type: "write",
    path: sampleFile,
    content: "subagent direct write\n",
  });

  const usageSnapshot = usageLedger.snapshot();
  return {
    status: "ok",
    skill: {
      name: skillPack.name,
      entry: skillPack.entry,
      bytes: skillPack.entryText.length,
      entrySha256: skillPack.entrySha256,
      supportFileCount: skillPack.supportFiles.length,
    },
    providers: providers.list().map((provider) => ({
      name: provider.name,
      capabilities: provider.capabilities,
    })),
    gates: {
      blockedWrite,
      allowedWrite,
      subagentBlockedWrite,
    },
    subagent: subagentResult,
    patchCandidate,
    providerSessions: collectProviderSessions(usageSnapshot.calls),
    usage: usageSnapshot,
    evidence: evidence.snapshot(),
  };
}

export async function runMockTask({
  repoRoot: root = repoRoot,
  argv = [],
  sessionTmp: providedSessionTmp,
  session: providedSession,
  evidence: providedEvidence,
  onEvent,
  conversationContext,
} = {}) {
  const args = parseRunArgs(argv);
  const sessionTmp = providedSessionTmp || (await mkdtemp(path.join(tmpdir(), "odai-cli-run-")));
  const skillPack = await loadSkillPack({ repoRoot: root });
  const promptPack = await skillPack.render({
    references: ["references/modules/dao.md", "references/dao/interaction-contract.md"],
  });

  const session = providedSession || new SessionState({ id: `run-${Date.now()}` });
  const evidence = providedEvidence || new EvidenceLedger();
  const usageLedger = new UsageLedger({ evidence });
  const initialDenialCount = evidence.denials.length;
  const policy = loadWorkspacePolicyConfig({ workspaceRoot: root });
  const dispatcher = new ToolDispatcher({
    workspaceRoot: root,
    sessionTmp,
    evidence,
    session,
    allowShellExecution: Boolean(args.allowShell && policy.shell.allowExecution),
    allowedShellCommands: policy.shell.allowedCommands,
    shellSandbox: policy.shell.sandbox,
    allowNetworkRequests: Boolean(args.allowNetwork),
    networkPolicy: policy.network,
    checkpointDir: args.save
      ? path.join(root, ".odai", "runs", "checkpoints", session.id)
      : path.join(sessionTmp, "checkpoints"),
  });
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env: process.env });
  const providers = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    config: loadWorkspaceProviderConfig({ workspaceRoot: root }),
  });
  const scheduler = new Scheduler({
    providers,
    agentProfiles: loadWorkspaceAgentProfiles({ workspaceRoot: root }),
    dispatcher,
    evidence,
    usageLedger,
  });
  const modelOptions = normalizeModelOptions({
    reasoning: args.reasoning,
    contextWindowTokens: args.contextWindowTokens,
  });

  let agentLoopRun;
  let subagentRun;
  let effectivePrimaryProviderName = args.provider;
  const subagentReviews = [];
  let subagentFailures = [];
  let runError;
  let patchAdoption;
  try {
    if (args.agentLoop) {
      const provider = selectMainRunProvider({
        providers,
        providerName: args.provider,
        modelOverride: args.model,
      });
      effectivePrimaryProviderName = provider.name;
      agentLoopRun = await runAgentLoop({
        provider,
        task: args.task,
        input: {
          files: args.files,
          target: args.target,
          content: args.content,
          toolIntents: args.toolIntents,
          promptPack,
          promptPackBytes: promptPack.length,
          conversationContext,
          modelOptions,
        },
        dispatcher,
        evidence,
        usageLedger,
        maxTurns: args.maxTurns,
        onEvent,
      });
    } else {
      subagentRun = await scheduler.runSubagent({
        profileName: args.profile,
        providerName: args.provider,
        modelOverride: args.model,
        input: {
          task: args.task,
          files: args.files,
          target: args.target,
          content: args.content,
          promptPack,
          promptPackBytes: promptPack.length,
          toolIntents: args.toolIntents,
          conversationContext,
          modelOptions,
        },
      });
      effectivePrimaryProviderName = subagentRun?.agent?.provider || effectivePrimaryProviderName;
    }

    if (args.subagents.length > 0) {
      const reviewBatch = await runSubagentReviewBatch({
        specs: args.subagents,
        scheduler,
        mainProviderName: effectivePrimaryProviderName,
        excludeProviderNames: args.excludeProviderNames,
        input: {
          task: args.task,
          files: args.files,
          target: args.target,
          content: args.content,
          promptPack,
          promptPackBytes: promptPack.length,
          mainMode: args.agentLoop ? "agent_loop" : "subagent",
          conversationContext,
          modelOptions,
        },
        evidence,
      });
      subagentReviews.push(...reviewBatch.reviews);
      subagentFailures = reviewBatch.failures;
      if (subagentFailures.length > 0) {
        const error = new Error(`Subagent review batch failed: ${subagentFailures.length} failed`);
        error.failures = subagentFailures;
        throw error;
      }
    }

    if (args.adoptPatch) {
      if (!args.target) {
        throw new Error("Usage: --adopt-patch requires --target <path>.");
      }
      const evidenceRead = await dispatcher.dispatch({
        actor: { kind: "main", id: "main" },
        type: "read",
        path: args.target,
      });
      patchAdoption = await adoptPatchProposal({
        result: subagentRun,
        dispatcher,
      });
      patchAdoption.evidenceRead = publicToolResult(evidenceRead);
      if (patchAdoption.adopted && subagentRun?.agent?.id) {
        usageLedger.markAgentAdopted(subagentRun.agent.id);
      }
    }
  } catch (error) {
    runError = publicError(error);
    if (Array.isArray(error?.failures)) {
      runError.failures = error.failures;
    }
    evidence.recordError(error);
  }

  const usageSnapshot = usageLedger.snapshot();
  const publicTask = publicTaskText(args.task);
  const result = {
    status: runError ? "failed" : "ready",
    task: publicTask,
    model: args.model || undefined,
    modelOptions,
    skill: {
      name: skillPack.name,
      promptPackBytes: promptPack.length,
      entrySha256: skillPack.entrySha256,
      supportFileCount: skillPack.supportFiles.length,
    },
    mode: args.agentLoop ? "agent_loop" : "subagent",
    providerSelection: args.provider === "auto"
      ? {
          requested: "auto",
          selected: effectivePrimaryProviderName,
        }
      : undefined,
    policyConfigErrors: Array.isArray(policy.configErrors) && policy.configErrors.length > 0
      ? policy.configErrors
      : undefined,
    resume: {
      argv: buildResumeArgv(args),
    },
    agentLoop: agentLoopRun,
    subagent: subagentRun ? summarizeMerge(subagentRun) : undefined,
    subagentReviews,
    subagentFailures,
    patchAdoption,
    providerSessions: collectProviderSessions(usageSnapshot.calls),
    usage: usageSnapshot,
    error: runError,
    evidence: evidence.snapshot(),
    requiredAuthorizations: requiredAuthorizationsFromDenials(evidence.denials.slice(initialDenialCount)),
    note: resultNote({ agentLoopRun, subagentRun, patchAdoption, runError, usageSnapshot }),
  };
  result.recordPath = await writeRunRecord({
    directory: sessionTmp,
    record: result,
  });
  if (args.save) {
    result.savedRecordPath = await writeWorkspaceRunRecord({
      workspaceRoot: root,
      record: result,
    });
  }
  return result;
}

export function selectMainRunProvider({ providers, providerName, modelOverride } = {}) {
  if (providerName === "auto") {
    const candidates = providers
      .list()
      .filter((provider) => ["reasoning", "code"].every((capability) => provider.capabilities.includes(capability)));
    const available = candidates.map((provider) => withProviderModelOverride(provider, modelOverride))
      .filter((provider) => provider.available !== false);
    const nonMockAvailable = available.filter((provider) => provider.kind !== "mock");
    if (nonMockAvailable.length > 1) {
      throw new Error(
        `Provider auto selection is ambiguous: ${nonMockAvailable.map((provider) => provider.name).join(", ")}. Use --provider <name> to choose explicitly.`,
      );
    }
    const provider = nonMockAvailable[0] || available[0];
    if (!provider) {
      throw new Error("No provider satisfies main agent requirements.");
    }
    return provider;
  }
  return withProviderModelOverride(providers.get(providerName), modelOverride);
}

async function runSubagentReviewBatch({ specs = [], scheduler, mainProviderName, excludeProviderNames = [], input, evidence }) {
  const excluded = [mainProviderName, ...excludeProviderNames].filter(Boolean);
  const settled = await Promise.allSettled(
    specs.map((spec) =>
      scheduler.runSubagent({
        profileName: spec.profile,
        providerName: spec.provider,
        modelOverride: spec.model,
        excludeProviderNames: [...new Set(excluded)],
        input,
      }),
    ),
  );

  const reviews = [];
  const failures = [];
  for (let i = 0; i < settled.length; i += 1) {
    const spec = specs[i];
    const result = settled[i];
    if (result.status === "fulfilled") {
      reviews.push(summarizeMerge(result.value));
    } else {
      failures.push({
        profile: spec.profile,
        provider: spec.provider,
        error: publicError(result.reason),
      });
      reviews.push({
        adopted: false,
        requiresMainReview: true,
        profile: spec.profile,
        provider: spec.provider,
        status: "failed",
        error: publicError(result.reason),
      });
    }
  }

  const providers = uniqueProviderNames(reviews.map((review) => review.provider));
  const requestedProviders = uniqueProviderNames(specs.map((spec) => spec.provider || "auto"));
  evidence?.recordEvent("subagent-batch", {
    parallel: true,
    requested: specs.length,
    succeeded: reviews.length - failures.length,
    failed: failures.length,
    providers,
    requestedProviders,
    heterogeneousProviders: providers.length > 1,
  });

  return { reviews, failures };
}

function uniqueProviderNames(names = []) {
  return [...new Set(names.filter((name) => typeof name === "string" && name.trim() !== ""))];
}

export async function continueLatestRun({
  repoRoot: root = repoRoot,
  argv = [],
  sessionTmp,
  session,
  evidence,
} = {}) {
  const args = {
    run: hasFlag(argv, "--run"),
    save: hasFlag(argv, "--save"),
    useApiKey: hasFlag(argv, "--use-api-key"),
    useProviderCommand: hasFlag(argv, "--use-provider-command"),
    allowShell: hasFlag(argv, "--allow-shell"),
    allowNetwork: hasFlag(argv, "--allow-network"),
  };
  const latest = await readLatestWorkspaceRun({ workspaceRoot: root });
  if (args.run) {
    if (latest.record?.mode === "rollback") {
      return {
        status: "blocked",
        latestPath: latest.path,
        previousStatus: latest.record.status,
        sourceRecordPath: latest.record.sourceRecordPath,
        note: "Latest record is a rollback audit. Re-run rollback explicitly with the source record path if needed.",
      };
    }

    if (latest.record?.mode === "doctor") {
      const resumeArgv = latest.record?.resume?.argv || [];
      return runDoctor({
        repoRoot: root,
        argv: [
          ...stripLeadingCommand(resumeArgv, "doctor"),
          ...(args.save ? ["--save"] : []),
          ...(args.useApiKey ? ["--use-api-key"] : []),
          ...(args.useProviderCommand ? ["--use-provider-command"] : []),
          ...(args.allowShell ? ["--allow-shell"] : []),
        ],
      });
    }

    const resumeArgv = latest.record?.resume?.argv || fallbackResumeArgv(latest.record);
    return runMockTask({
      repoRoot: root,
      sessionTmp,
      session,
      evidence,
      argv: [
        ...resumeArgv,
        ...(args.save ? ["--save"] : []),
        ...(args.useApiKey ? ["--use-api-key"] : []),
        ...(args.useProviderCommand ? ["--use-provider-command"] : []),
        ...(args.allowShell ? ["--allow-shell"] : []),
        ...(args.allowNetwork ? ["--allow-network"] : []),
      ],
    });
  }

  const resumeSummary = buildContinueResumeSummary(latest.record);
  return {
    status: "ready",
    latestPath: latest.path,
    task: publicTaskText(latest.record.task),
    previousStatus: latest.record.status,
    note: latest.record.mode === "rollback"
      ? "Latest record is a rollback audit; use the source record path for any further rollback."
      : latest.record.mode === "doctor"
        ? resumeSummary.note || "Use `odai continue --run` to re-run the latest provider probe."
        : resumeSummary.note || "Use `odai continue --run` to re-run the latest mock task.",
    notRestored: resumeSummary.notRestored,
    rerun: resumeSummary.rerun,
    rollback: latest.record.mode === "rollback"
      ? {
          sourceRecordPath: latest.record.sourceRecordPath,
          items: latest.record.items,
        }
      : undefined,
    doctor: latest.record.mode === "doctor" ? latest.record.probe || latest.record.error : undefined,
    subagent: latest.record.subagent,
    agentLoop: latest.record.agentLoop
      ? {
          completed: latest.record.agentLoop.completed,
          stopReason: latest.record.agentLoop.stopReason,
          provider: latest.record.agentLoop.agent?.provider,
          turns: latest.record.agentLoop.turns?.length || 0,
        }
      : undefined,
  };
}

function buildContinueResumeSummary(record = {}) {
  const notRestored = collectNotRestoredConfirmations(record);
  const flags = confirmationFlags(notRestored);
  const base = "odai continue --run";
  const command = flags.length > 0 ? `${base} ${flags.join(" ")}` : base;
  const target = continueRerunTarget(record);
  const targetText = target ? ` the latest ${target}` : "";
  return {
    notRestored,
    rerun: {
      command,
      flags,
    },
    note: notRestored.length > 0
      ? `Use \`${command}\` to re-run${targetText}. High-risk confirmations are not restored from saved records.`
      : target
        ? `Use \`${command}\` to re-run${targetText}.`
        : "",
  };
}

function continueRerunTarget(record = {}) {
  if (record.mode !== "doctor") {
    return "";
  }
  if (record.kind === "runtime-governance") return "runtime governance audit";
  if (record.kind === "setup-guide") return "setup guide";
  if (record.kind === "odai-status") return "odai status audit";
  if (record.kind === "completion-audit") return "completion audit";
  if (record.kind === "external-evidence") return "saved external evidence audit";
  if (record.kind === "plan-acceptance") return "plan acceptance audit";
  if (record.kind === "plan-milestones") return "plan milestones audit";
  if (record.kind === "sandbox-readiness") return "sandbox readiness audit";
  if (record.kind === "sandbox-smoke") return "sandbox smoke";
  if (record.kind === "e2e-readiness") return "E2E readiness audit";
  return "provider probe";
}

function collectNotRestoredConfirmations(record = {}) {
  const confirmations = new Set();
  collectAuthorizationConfirmations(record, confirmations);
  collectProviderConfirmations(record, confirmations);
  collectExecutionConfirmations(record, confirmations);
  return [...confirmations].sort();
}

function collectAuthorizationConfirmations(record = {}, confirmations) {
  if (
    Array.isArray(record.requiredAuthorizations) && record.requiredAuthorizations.length > 0
    || (record.evidence?.denials || []).some((denial) => denial?.gate === "authorization")
  ) {
    confirmations.add("authorizations");
  }
}

function collectProviderConfirmations(record = {}, confirmations) {
  if (
    record.kind === "odai-status" ||
    record.kind === "completion-audit" ||
    record.kind === "plan-acceptance" ||
    record.kind === "plan-milestones"
  ) {
    confirmations.add("api-key-confirmation");
    confirmations.add("provider-command-confirmation");
  }
  if (record.kind === "e2e-readiness" || record.kind === "setup-guide") {
    if (record.flags?.useApiKey) confirmations.add("api-key-confirmation");
    if (record.flags?.useProviderCommand) confirmations.add("provider-command-confirmation");
  }

  for (const provider of collectRecordProviderSummaries(record)) {
    addProviderConfirmation(provider, confirmations);
  }
  for (const call of record.usage?.calls || []) {
    addProviderConfirmation(call, confirmations);
  }
}

function collectExecutionConfirmations(record = {}, confirmations) {
  if (record.kind === "sandbox-smoke" || record.resume?.argv?.includes("--smoke")) {
    confirmations.add("shell-execution-confirmation");
  }
  if ((record.evidence?.commands || []).length > 0) {
    confirmations.add("shell-execution-confirmation");
  }
  if ((record.evidence?.network || []).length > 0) {
    confirmations.add("network-execution-confirmation");
  }
}

function collectRecordProviderSummaries(record = {}) {
  const providers = [];
  if (record.provider && typeof record.provider === "object") {
    providers.push(record.provider);
  }
  for (const probe of record.probes || []) {
    if (probe?.provider && typeof probe.provider === "object") {
      providers.push(probe.provider);
    }
  }
  for (const provider of record.providers?.providers || []) {
    if (provider && typeof provider === "object") {
      providers.push(provider);
    }
  }
  return providers;
}

function addProviderConfirmation(provider = {}, confirmations) {
  const kind = provider.providerKind || provider.kind;
  const auth = provider.auth;
  const source = provider.source || {};
  if (["api", "openai-compatible"].includes(kind) || auth === "api_key" || Boolean(source.apiKeyEnv)) {
    confirmations.add("api-key-confirmation");
  }
  if (
    ["subscription-cli", "subscription-sdk", "command-json"].includes(kind)
    || auth === "external_command"
    || source.confirmationFlag === "--use-provider-command"
  ) {
    confirmations.add("provider-command-confirmation");
  }
}

function confirmationFlags(confirmations = []) {
  const mapping = {
    "api-key-confirmation": "--use-api-key",
    "provider-command-confirmation": "--use-provider-command",
    "shell-execution-confirmation": "--allow-shell",
    "network-execution-confirmation": "--allow-network",
  };
  return confirmations.map((confirmation) => mapping[confirmation]).filter(Boolean);
}

function stripLeadingCommand(argv = [], command = "") {
  return argv[0] === command ? argv.slice(1) : argv;
}

export async function rollbackLatestRun({ repoRoot: root = repoRoot, argv = [] } = {}) {
  const args = parseRollbackArgs(argv);
  const result = await rollbackWorkspaceRun({
    workspaceRoot: root,
    selector: args.selector,
    confirm: args.confirm,
    deleteNewFiles: args.deleteNewFiles,
    paths: args.paths,
    checkpointIds: args.checkpointIds,
  });
  if (args.confirm) {
    result.auditRecordPath = await writeWorkspaceRunRecord({
      workspaceRoot: root,
      record: buildRollbackAuditRecord({ result, args }),
    });
  }
  return publicRollbackResult(result);
}

function buildRollbackAuditRecord({ result = {}, args = {} } = {}) {
  return {
    mode: "rollback",
    status: result.status,
    sourceRecordPath: result.recordPath,
    task: publicTaskText(result.task),
    confirmRequired: result.confirmRequired,
    restored: result.restored,
    items: publicRollbackItems(result.items),
    evidence: result.reverseRecord?.evidence,
    resume: {
      argv: buildRollbackResumeArgv(args),
    },
  };
}

function publicRollbackResult(result = {}) {
  return {
    status: result.status,
    recordPath: result.recordPath,
    task: publicTaskText(result.task),
    confirmRequired: result.confirmRequired,
    restored: result.restored,
    items: publicRollbackItems(result.items),
    auditRecordPath: result.auditRecordPath,
    note: result.note,
  };
}

function publicRollbackItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: item.id,
    path: item.path,
    existed: item.existed,
    action: item.action,
    ok: item.ok,
    reason: item.reason,
  }));
}

function parseRollbackArgs(argv = []) {
  const args = {
    selector: "latest",
    confirm: false,
    deleteNewFiles: false,
    paths: [],
    checkpointIds: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (item === "--confirm") {
      args.confirm = true;
    } else if (item === "--delete-new-files") {
      args.deleteNewFiles = true;
    } else if (option.name === "--path") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.paths.push(value);
    } else if (option.name === "--checkpoint") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.checkpointIds.push(value);
    } else if (!item.startsWith("-") && args.selector === "latest") {
      args.selector = item;
    }
  }
  return args;
}

function buildRollbackResumeArgv(args) {
  return [
    "rollback",
    args.selector,
    ...args.paths.flatMap((filePath) => ["--path", filePath]),
    ...args.checkpointIds.flatMap((checkpointId) => ["--checkpoint", checkpointId]),
    ...(args.deleteNewFiles ? ["--delete-new-files"] : []),
  ];
}

function buildResumeArgv(args) {
  return [
    publicTaskText(args.task),
    "--provider",
    args.provider,
    ...(args.model ? ["--model", args.model] : []),
    ...(args.reasoning ? ["--reasoning", args.reasoning] : []),
    ...(Number.isFinite(args.contextWindowTokens) ? ["--context", String(args.contextWindowTokens)] : []),
    "--profile",
    args.profile,
    ...(args.agentLoop ? ["--agent-loop"] : []),
    ...args.files.flatMap((file) => ["--file", file]),
    ...(args.target ? ["--target", args.target] : []),
    ...(args.adoptPatch ? ["--adopt-patch"] : []),
    ...(Number.isFinite(args.maxTurns) && args.maxTurns !== 4 ? ["--max-turns", String(args.maxTurns)] : []),
    ...args.subagents.flatMap((subagent) => ["--subagent", formatSubagentSpec(subagent)]),
    ...args.excludeProviderNames.flatMap((provider) => ["--exclude-provider", provider]),
  ];
}

function fallbackResumeArgv(record = {}) {
  const files = record?.evidence?.reads || [];
  return [
    publicTaskText(record.task || "continue latest task"),
    ...(record.mode === "agent_loop" ? ["--agent-loop"] : []),
    ...files.flatMap((file) => ["--file", file]),
  ];
}

function publicTaskText(task = "") {
  return redactString(String(task || ""));
}

function resultNote({ agentLoopRun, subagentRun, patchAdoption, runError, usageSnapshot }) {
  if (runError) {
    return "Run failed before completion; see error and evidence events.";
  }
  const providerName = agentLoopRun?.agent?.provider || subagentRun?.agent?.provider;
  const providerKind = usageSnapshot?.calls?.find((call) => call.provider === providerName)?.providerKind;
  if (patchAdoption?.adopted) {
    return providerKind === "mock"
      ? "Mock patch proposal adopted by the main flow after an evidence read."
      : "Provider patch proposal adopted by the main flow after an evidence read.";
  }
  if (agentLoopRun) {
    return providerKind === "mock"
      ? "Mock agent loop dispatched tool intents through odai runtime; no real model was called."
      : "Provider agent loop dispatched model output through odai runtime gates; local tools remained under odai control.";
  }
  return providerKind === "mock"
    ? "Mock run only; no real provider output has been adopted."
    : "Provider output was captured as odai evidence; no direct tool authority was granted.";
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

function summarizeProvider(provider = {}) {
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

function summarizeProviderProbe(output = {}) {
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

function summarizeProgressEvents(events = []) {
  return {
    count: events.length,
    providerText: events.filter((event) => event.type === "provider-text").length,
    toolResults: events.filter((event) => event.type === "tool-result").length,
  };
}

function truncateText(value = "", limit = 2000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function normalizeAuthorizationScope(scope) {
  if (!scope) return "";
  if (scope.startsWith("risk:")) return scope;
  if (["destructive", "external", "production", "credential", "cost"].includes(scope)) {
    return `risk:${scope}`;
  }
  return scope;
}

function parseRunArgs(argv) {
  const args = {
    task: "",
    provider: "mock-reviewer",
    profile: "reviewer",
    files: [],
    save: false,
    useApiKey: false,
    useProviderCommand: false,
    allowShell: false,
    allowNetwork: false,
    target: "",
    content: undefined,
    adoptPatch: false,
    agentLoop: false,
    maxTurns: 4,
    subagents: [],
    toolIntents: [],
    excludeProviderNames: [],
    providerExplicit: false,
    profileExplicit: false,
    model: "",
    reasoning: "",
    contextWindowTokens: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--provider") {
      args.provider = option.hasInlineValue ? option.value : argv[++i];
      args.providerExplicit = true;
    } else if (option.name === "--model") {
      args.model = option.hasInlineValue ? option.value : argv[++i];
    } else if (
      option.name === "--reasoning"
      || option.name === "--reasoning-depth"
      || option.name === "--reasoning-effort"
    ) {
      const value = option.hasInlineValue ? option.value : argv[++i];
      const normalized = normalizeModelOptions({ reasoning: value })?.reasoning;
      args.reasoning = normalized || "";
    } else if (
      option.name === "--context"
      || option.name === "--context-size"
      || option.name === "--context-window"
    ) {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.contextWindowTokens = parseContextWindowTokens(value);
    } else if (option.name === "--profile") {
      args.profile = option.hasInlineValue ? option.value : argv[++i];
      args.profileExplicit = true;
    } else if (option.name === "--file") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.files.push(path.resolve(value));
    } else if (option.name === "--target") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.target = path.resolve(value);
    } else if (option.name === "--content") {
      args.content = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--adopt-patch") {
      args.adoptPatch = enabledFlagValue(option);
    } else if (option.name === "--agent-loop") {
      args.agentLoop = enabledFlagValue(option);
    } else if (option.name === "--max-turns") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.maxTurns = Number(value);
    } else if (option.name === "--subagent") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.subagents.push(parseSubagentSpec(value));
    } else if (option.name === "--exclude-provider") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      if (value) {
        appendUnique(args.excludeProviderNames, String(value));
      }
    } else if (option.name === "--tool-intent-json") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.toolIntents.push(parseToolIntentArg(value));
    } else if (option.name === "--save") {
      args.save = enabledFlagValue(option);
    } else if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      args.useProviderCommand = enabledFlagValue(option);
    } else if (option.name === "--allow-shell") {
      args.allowShell = enabledFlagValue(option);
    } else if (option.name === "--allow-network") {
      args.allowNetwork = enabledFlagValue(option);
    } else if (!args.task) {
      args.task = item;
    } else {
      args.task += ` ${item}`;
    }
  }

  if (!args.task) {
    throw new Error('Usage: odai run "<task>" [--provider mock-reviewer] [--profile reviewer] [--file path]');
  }

  if ((args.target || args.content || args.adoptPatch) && !args.profileExplicit) {
    args.profile = "implementer_candidate";
  }
  if ((args.agentLoop || args.target || args.content || args.adoptPatch) && !args.providerExplicit) {
    args.provider = "mock-main";
  }

  return args;
}

function parseDoctorArgs(argv) {
  const args = {
    provider: "",
    all: false,
    prompt: "odai provider health check. Reply with a short plain-text response only.",
    model: "",
    useApiKey: false,
    useProviderCommand: false,
    save: false,
    stream: false,
    governance: false,
    status: false,
    setup: false,
    audit: false,
    evidence: false,
    acceptance: false,
    milestones: false,
    sandbox: false,
    e2e: false,
    smoke: false,
    allowShell: false,
    onEvent: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--all") {
      args.all = enabledFlagValue(option);
    } else if (option.name === "--provider") {
      args.provider = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--prompt") {
      args.prompt = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--model") {
      args.model = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      args.useProviderCommand = enabledFlagValue(option);
    } else if (option.name === "--save") {
      args.save = enabledFlagValue(option);
    } else if (option.name === "--stream") {
      args.stream = enabledFlagValue(option);
    } else if (option.name === "--governance") {
      args.governance = enabledFlagValue(option);
    } else if (option.name === "--status") {
      args.status = enabledFlagValue(option);
    } else if (option.name === "--setup") {
      args.setup = enabledFlagValue(option);
    } else if (option.name === "--audit") {
      args.audit = enabledFlagValue(option);
    } else if (option.name === "--evidence") {
      args.evidence = enabledFlagValue(option);
    } else if (option.name === "--acceptance") {
      args.acceptance = enabledFlagValue(option);
    } else if (option.name === "--milestones") {
      args.milestones = enabledFlagValue(option);
    } else if (option.name === "--sandbox") {
      args.sandbox = enabledFlagValue(option);
    } else if (option.name === "--e2e") {
      args.e2e = enabledFlagValue(option);
    } else if (option.name === "--smoke") {
      args.smoke = enabledFlagValue(option);
    } else if (option.name === "--allow-shell") {
      args.allowShell = enabledFlagValue(option);
    }
  }

  return args;
}

function parseE2EArgs(argv = []) {
  const args = {
    useApiKey: hasFlag(argv, "--use-api-key"),
    useProviderCommand: hasFlag(argv, "--use-provider-command"),
    model: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--model") {
      args.model = option.hasInlineValue ? option.value : argv[++i];
    }
  }
  return args;
}

function parseModelArgs(argv = []) {
  const args = {
    useApiKey: false,
    useProviderCommand: false,
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
      args.useProviderCommand = enabledFlagValue(option);
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

function buildE2EArgvFromDoctorArgs(args) {
  return [
    ...(args.useApiKey ? ["--use-api-key"] : []),
    ...(args.useProviderCommand ? ["--use-provider-command"] : []),
    ...(args.model ? ["--model", args.model] : []),
  ];
}

function parseSessionsArgs(argv) {
  const args = {
    tail: 20,
    context: false,
    compact: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--tail") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.tail = Math.max(0, Number(value || 20));
    } else if (item === "--context") {
      args.context = true;
    } else if (item === "--compact") {
      args.compact = true;
    }
  }
  return args;
}

function parseResumeArgs(argv) {
  const args = {
    tail: 20,
    initialTaskArgv: undefined,
  };
  const taskArgv = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--tail") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.tail = Math.max(0, Number(value || 20));
    } else {
      taskArgv.push(item);
    }
  }
  if (taskArgv.length > 0) {
    args.initialTaskArgv = taskArgv;
  }
  return args;
}

function parseAgentsArgs(argv = []) {
  const args = {
    useApiKey: false,
    useProviderCommand: false,
    mainProvider: "",
    excludeProviderNames: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      args.useProviderCommand = enabledFlagValue(option);
    } else if (option.name === "--main-provider") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      if (value) {
        args.mainProvider = String(value);
        appendUnique(args.excludeProviderNames, String(value));
      }
    } else if (option.name === "--exclude-provider") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      if (value) {
        appendUnique(args.excludeProviderNames, String(value));
      }
    }
  }
  return args;
}

function appendUnique(items, value) {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function buildDoctorResumeArgv(args) {
  return [
    "doctor",
    ...(args.governance ? ["--governance"] : []),
    ...(args.status ? ["--status"] : []),
    ...(args.setup ? ["--setup"] : []),
    ...(args.audit ? ["--audit"] : []),
    ...(args.evidence ? ["--evidence"] : []),
    ...(args.acceptance ? ["--acceptance"] : []),
    ...(args.milestones ? ["--milestones"] : []),
    ...(args.sandbox ? ["--sandbox"] : []),
    ...(args.e2e ? ["--e2e"] : []),
    ...(args.smoke ? ["--smoke"] : []),
    ...(args.all ? ["--all"] : []),
    ...(args.provider ? ["--provider", args.provider] : []),
    ...(args.prompt ? ["--prompt", args.prompt] : []),
    ...(args.model ? ["--model", args.model] : []),
    ...(args.stream ? ["--stream"] : []),
  ];
}

function requiredAuthorizationsFromDenials(denials) {
  const scopes = new Set();
  for (const denial of denials || []) {
    if (denial.gate === "authorization" && denial.intent?.risk) {
      scopes.add(`risk:${denial.intent.risk}`);
    }
  }
  return [...scopes];
}

function parseToolIntentArg(value = "") {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid --tool-intent-json: ${error.message}`);
  }
}

function parseSubagentSpec(spec = "") {
  const [profile, provider, ...modelParts] = spec.split(":");
  if (!profile) {
    throw new Error("Usage: --subagent <profile[:provider[:model]]>");
  }
  return {
    profile,
    provider: provider || undefined,
    model: modelParts.length > 0 ? modelParts.join(":") || undefined : undefined,
  };
}

function formatSubagentSpec(spec = {}) {
  if (!spec.provider && !spec.model) {
    return spec.profile;
  }
  if (!spec.model) {
    return `${spec.profile}:${spec.provider}`;
  }
  return `${spec.profile}:${spec.provider || "auto"}:${spec.model}`;
}

function parseCanaryArgs(argv) {
  const args = {
    lastMessage: "",
    provider: "",
    runtimeCase: "",
    files: [],
    maxTurns: 4,
    useApiKey: false,
    useProviderCommand: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--last-message") {
      args.lastMessage = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--runtime-case") {
      args.runtimeCase = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--provider") {
      args.provider = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--file") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.files.push(path.resolve(value));
    } else if (option.name === "--max-turns") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.maxTurns = Number(value);
    } else if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      args.useProviderCommand = enabledFlagValue(option);
    }
  }
  return args;
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
