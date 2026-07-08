import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runInteractiveSession } from "./core/interactive-session.mjs";
import { runAuthConfig } from "./core/auth-config.mjs";
import {
  runAcceptance,
  runAudit,
  runE2EReadiness,
  runEvidence,
  runGovernance,
  runMilestones,
  runSetup,
  runStatus,
} from "./core/status-commands.mjs";
import { runAgents } from "./core/agents.mjs";
import { formatModelsList, runModels } from "./core/model-catalog.mjs";
import {
  canUseInteractivePromptUi,
  completeInteractiveLine,
  createInteractiveCompleter,
  createInteractivePromptAsk,
  describeInteractiveCompletions,
  selectModelChoice,
} from "./core/interactive-ui.mjs";
import { initWorkspace } from "./core/init-workspace.mjs";
import { rollbackWorkspaceRun } from "./core/rollback.mjs";
import {
  loadWorkspacePreferences,
  mergeWorkspacePreferences,
  writeWorkspacePreferences,
} from "./core/preferences.mjs";
import { readLatestWorkspaceRun, writeWorkspaceRunRecord } from "./core/run-store.mjs";
import { SessionState } from "./core/session-state.mjs";
import {
  createWorkspaceTranscript,
  readLatestWorkspaceTranscript,
} from "./core/transcript-store.mjs";
import { runSessions } from "./core/sessions.mjs";
import { runSandboxReadiness, runSandboxSmoke } from "./core/sandbox-commands.mjs";
import { runDoctor } from "./core/doctor.mjs";
import { runPhase0Demo } from "./core/phase0-demo.mjs";
import { runMockTask } from "./core/run-task.mjs";
import {
  hasFlag,
  optionToken,
  providerCommandAuthArgv,
  providerCommandAuthFromArgv,
} from "./core/cli-args.mjs";
import {
  buildCanaryConversationContext,
  buildCanaryTaskArgv,
  normalizeRuntimeCanaryCase,
  parseCanaryArgs,
  summarizeEvidenceCounts,
} from "./core/canary-runner-helpers.mjs";
import { publicError, publicTaskText } from "./core/public-summaries.mjs";
import { detectLanguage, t } from "./runtime/i18n.mjs";
import {
  checkForPackageUpdate,
  readRuntimePackageMetadata,
  shouldRunStartupUpdateCheck,
} from "./runtime/update-check.mjs";
import { EvidenceLedger } from "./runtime/evidence-ledger.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadWorkspaceEnvironment,
  loadWorkspaceProviderConfig,
} from "./config/provider-config.mjs";
import { loadWorkspacePolicyConfig } from "./config/policy-config.mjs";

const repoRoot = process.cwd();
export {
  completeInteractiveLine,
  createInteractiveCompleter,
  describeInteractiveCompletions,
  selectModelChoice,
} from "./core/interactive-ui.mjs";
export {
  runAgents,
} from "./core/agents.mjs";
export {
  runAuthConfig,
} from "./core/auth-config.mjs";
export {
  formatModelsList,
  runModels,
} from "./core/model-catalog.mjs";
export {
  runSessions,
} from "./core/sessions.mjs";
export {
  runSandboxReadiness,
  runSandboxSmoke,
} from "./core/sandbox-commands.mjs";
export {
  doctorSummaryStatus,
  runDoctor,
} from "./core/doctor.mjs";
export {
  runPhase0Demo,
} from "./core/phase0-demo.mjs";
export {
  runMockTask,
  selectMainRunProvider,
} from "./core/run-task.mjs";
export {
  runAcceptance,
  runAudit,
  runE2EReadiness,
  runEvidence,
  runGovernance,
  runMilestones,
  runSetup,
  runStatus,
} from "./core/status-commands.mjs";


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
    const providerCommandAuth = providerCommandAuthFromArgv(argv);
    const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
      allowApiKey: hasFlag(argv, "--use-api-key"),
      allowProviderCommand: providerCommandAuth.useProviderCommand,
      allowedProviderCommands: providerCommandAuth.providerCommandProviders,
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
  let preferences = await loadWorkspacePreferences({ workspaceRoot: root });
  const languageState = {
    value: process.env.ODAI_LANG
      ? detectLanguage({ env: process.env })
      : preferences.language || detectLanguage({ env: process.env }),
  };
  const savePreferences = async (patch = {}) => {
    preferences = mergeWorkspacePreferences(preferences, patch);
    await writeWorkspacePreferences({ workspaceRoot: root, preferences });
  };
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
      initialPreferences: preferences,
      savePreferences,
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
        const providerCommandAuth = providerCommandAuthFromArgv(providerArgv);
        const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
          allowApiKey: hasFlag(providerArgv, "--use-api-key"),
          allowProviderCommand: providerCommandAuth.useProviderCommand,
          allowedProviderCommands: providerCommandAuth.providerCommandProviders,
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

export async function continueLatestRun({
  repoRoot: root = repoRoot,
  argv = [],
  sessionTmp,
  session,
  evidence,
} = {}) {
  const providerCommandAuth = providerCommandAuthFromArgv(argv);
  const args = {
    run: hasFlag(argv, "--run"),
    save: hasFlag(argv, "--save"),
    useApiKey: hasFlag(argv, "--use-api-key"),
    useProviderCommand: providerCommandAuth.useProviderCommand,
    providerCommandProviders: providerCommandAuth.providerCommandProviders,
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
          ...providerCommandAuthArgv(args),
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
        ...providerCommandAuthArgv(args),
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

function fallbackResumeArgv(record = {}) {
  const files = record?.evidence?.reads || [];
  return [
    publicTaskText(record.task || "continue latest task"),
    ...(record.mode === "agent_loop" ? ["--agent-loop"] : []),
    ...files.flatMap((file) => ["--file", file]),
  ];
}

function normalizeAuthorizationScope(scope) {
  if (!scope) return "";
  if (scope.startsWith("risk:")) return scope;
  if (["destructive", "external", "production", "credential", "cost"].includes(scope)) {
    return `risk:${scope}`;
  }
  return scope;
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
