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
import {
  loadWorkspacePreferences,
  mergeWorkspacePreferences,
  writeWorkspacePreferences,
} from "./core/preferences.mjs";
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
  providerCommandAuthFromArgv,
} from "./core/cli-args.mjs";
import {
  buildCanaryConversationContext,
  buildCanaryTaskArgv,
  normalizeRuntimeCanaryCase,
  parseCanaryArgs,
  summarizeEvidenceCounts,
} from "./core/canary-runner-helpers.mjs";
import { publicError } from "./core/public-summaries.mjs";
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
import { continueLatestRun, parseResumeArgs } from "./core/continue-run.mjs";
import { rollbackLatestRun } from "./core/rollback-run.mjs";
import { formatSkillsReport, listAllSkills } from "./core/skill-discovery.mjs";

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
  continueLatestRun,
} from "./core/continue-run.mjs";
export {
  rollbackLatestRun,
} from "./core/rollback-run.mjs";
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

  if (command === "skills") {
    const skills = listAllSkills({ workspaceRoot: repoRoot });
    const asJson = hasFlag(argv, "--json");
    const result = {
      status: "ready",
      kind: "skills",
      workspaceRoot: repoRoot,
      count: skills.length,
      skills,
    };
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatSkillsReport({ skills, active: [], workspaceRoot: repoRoot }));
    }
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
        "Usage: odai [task] | odai resume [task] | odai run <task> | <init|phase0|providers|models|auth|agents|policy|setup|status|audit|evidence|governance|acceptance|milestones|sandbox|e2e|sessions|skills|doctor|continue|rollback|canary-runner>",
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

function normalizeAuthorizationScope(scope) {
  if (!scope) return "";
  if (scope.startsWith("risk:")) return scope;
  if (["destructive", "external", "production", "credential", "cost"].includes(scope)) {
    return `risk:${scope}`;
  }
  return scope;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
