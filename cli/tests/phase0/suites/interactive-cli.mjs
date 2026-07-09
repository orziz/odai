import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeTaskArgv,
  parseInteractiveArgs,
  runInteractiveSession,
} from "../../../src/core/interactive-session.mjs";
import { rollbackRunRecord, rollbackWorkspaceRun } from "../../../src/core/rollback.mjs";
import { loadSkillPack } from "../../../src/core/skill-pack.mjs";
import {
  loadWorkspacePreferences,
  mergeWorkspacePreferences,
  preferencesPath,
  writeWorkspacePreferences,
} from "../../../src/core/preferences.mjs";
import { SessionState } from "../../../src/core/session-state.mjs";
import { createWorkspaceTranscript } from "../../../src/core/transcript-store.mjs";
import { EvidenceLedger } from "../../../src/runtime/evidence-ledger.mjs";
import { runAgentLoop } from "../../../src/runtime/agent-loop.mjs";
import { DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS } from "../../../src/runtime/model-tool-intents.mjs";
import { planShellCommand } from "../../../src/runtime/sandbox-adapter.mjs";
import { parseToolIntentEnvelope } from "../../../src/runtime/tool-intent-codec.mjs";
import { ToolDispatcher } from "../../../src/runtime/tool-dispatcher.mjs";
import { normalizeProviderSession } from "../../../src/runtime/provider-session.mjs";
import { publicTaskArgv, redactString } from "../../../src/runtime/redaction.mjs";
import { UsageLedger } from "../../../src/runtime/usage-ledger.mjs";
import { detectLanguage, normalizeLanguage, t } from "../../../src/runtime/i18n.mjs";
import {
  checkForPackageUpdate,
  compareSemver,
  shouldRunStartupUpdateCheck,
} from "../../../src/runtime/update-check.mjs";
import { createDefaultAgentProfiles } from "../../../src/orchestrator/agent-profiles.mjs";
import { ProviderRegistry } from "../../../src/orchestrator/provider-registry.mjs";
import { withProviderModelOverride } from "../../../src/orchestrator/provider-model.mjs";
import { Scheduler, selectSubagentProvider } from "../../../src/orchestrator/scheduler.mjs";
import { adoptPatchProposal } from "../../../src/orchestrator/result-merger.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadWorkspaceProviderConfig,
} from "../../../src/config/provider-config.mjs";
import {
  continueLatestRun,
  completeInteractiveLine,
  describeInteractiveCompletions,
  doctorSummaryStatus,
  formatModelsList,
  rollbackLatestRun,
  runAudit,
  runCanaryRunner,
  runAgents,
  runAcceptance,
  runAuthConfig,
  runDoctor,
  runE2EReadiness,
  runEvidence,
  runGovernance,
  runInit,
  runMilestones,
  runModels,
  runMockTask,
  runSandboxReadiness,
  runSandboxSmoke,
  runSessions,
  runSetup,
  runStatus,
  selectMainRunProvider,
} from "../../../src/index.mjs";
import {
  createRuntime as createPackageRuntime,
  listProviders as listPackageProviders,
  runTask as runPackageTask,
} from "../../../src/api.mjs";
import { describeWorkspaceAgentProfiles, loadWorkspaceAgentProfiles } from "../../../src/config/agent-config.mjs";
import { loadWorkspacePolicyConfig } from "../../../src/config/policy-config.mjs";
import { describeExternalEvidence } from "../../../src/core/external-evidence.mjs";
import { createAnthropicApiProvider } from "../../../src/providers/anthropic-api.mjs";
import { createClaudeAgentSdkProvider } from "../../../src/providers/claude-agent-sdk.mjs";
import { createClaudeCliProvider } from "../../../src/providers/claude-cli.mjs";
import { createCodexCliProvider } from "../../../src/providers/codex-cli.mjs";
import { createCommandJsonProvider } from "../../../src/providers/command-json.mjs";
import { createGeminiApiProvider } from "../../../src/providers/gemini-api.mjs";
import { createGrokCliProvider } from "../../../src/providers/grok-cli.mjs";
import { createMockProvider } from "../../../src/providers/mock-provider.mjs";
import { createOllamaProvider } from "../../../src/providers/ollama.mjs";
import { createProviderPrompt, createProviderSystemPrompt } from "../../../src/providers/odai-prompt.mjs";
import { createOpenAiCompatibleProvider } from "../../../src/providers/openai-compatible.mjs";
import { createOpenAiApiProvider } from "../../../src/providers/openai-api.mjs";


import {
  streamText,
  runCliBin,
  runCliExecutable,
  sha256,
  normalizePathForCompare,
  normalizeSlashes,
  symlinkOrCopyDirectory,
  trySymlink,
  monorepoRoot,
} from "../helpers.mjs";


import {
  createBaseFixtures,
  shared,
} from "../fixtures.mjs";

const {
  repoRoot,
  sessionTmp,
  skillPack,
} = await createBaseFixtures();

// Optional roots/runtime from prior suites (not all interactive tests need them).
const { session, evidence, dispatcher } = shared.runtime || {};
const {
  initRoot,
  commandProviderRoot,
} = shared;

const scriptedInputs = [
  "/provider mock-reviewer",
  "/model mock-main:mock-session-model",
  "/reasoning high",
  "/context 1m",
  "/settings",
  "hello interactive",
  "/retry",
  "/providers --use-api-key",
  "/agents --use-provider-command=true --main-provider mock-main",
  "/init",
  "/doctor --provider mock-main",
  "/status --use-provider-command=true",
  "/setup --use-provider-command=true",
  "/audit --use-provider-command=true",
  "/evidence",
  "/policy",
  "/sessions --tail 2",
  "/authorize production",
  "/continue --run",
  "/rollback latest",
  "/help",
  "/exit",
];
const scriptedWorkspaceRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-interactive-workspace-"));
const scriptedStreamPath = path.join(scriptedWorkspaceRoot, "stream.txt");
const scriptedMockPath = path.join(scriptedWorkspaceRoot, "mock.txt");
const scriptedRecordPath = path.join(scriptedWorkspaceRoot, ".odai", "runs", "mock-run.json");
const scriptedDoctorRecordPath = path.join(scriptedWorkspaceRoot, ".odai", "runs", "doctor-run.json");
const scriptedContinueRecordPath = path.join(scriptedWorkspaceRoot, ".odai", "runs", "continued.json");
const scriptedOutputs = [];
const scriptedTranscript = [];
const handled = {
  task: [],
  contexts: [],
  providers: [],
  agents: [],
  init: [],
  doctor: [],
  status: [],
  setup: [],
  audit: [],
  evidence: 0,
  policy: 0,
  sessions: [],
  authorize: [],
  continue: [],
  rollback: [],
};
await runInteractiveSession({
  ask: async () => scriptedInputs.shift(),
  write: (message) => scriptedOutputs.push(message),
  initialTaskArgv: ["boot task"],
  transcriptPath: "/tmp/scripted-transcript.jsonl",
  workspaceRoot: scriptedWorkspaceRoot,
  recordTranscript: async (event) => scriptedTranscript.push(event),
  handleTask: async (argv, options) => {
    handled.task.push(argv);
    handled.contexts.push(options?.context);
    options?.onEvent?.({
      type: "agent-turn-start",
      provider: "mock-main",
      turn: 1,
      estimatedInputTokens: 42,
    });
    options?.onEvent?.({ type: "provider-text", text: "streamed api_key=interactive-stream-secret" });
    options?.onEvent?.({
      type: "provider-usage",
      provider: "mock-main",
      usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
    });
    options?.onEvent?.({ type: "tool-result", result: { ok: true, type: "read", path: scriptedStreamPath } });
    return {
      status: "ready",
      task: argv.join(" "),
      agentLoop: {
        agent: { provider: "mock-main" },
        turns: [{ toolResults: [{ type: "read", path: scriptedMockPath }] }],
      },
      subagent: { provider: "mock-reviewer" },
      providerSessions: [{ provider: "mock-main", sessionId: `session:${argv[0]}` }],
      savedRecordPath: scriptedRecordPath,
      note: "scripted",
    };
  },
  handleProviders: async (argv) => {
    handled.providers.push(argv);
    return { providers: [{ name: "mock-reviewer" }, { name: "mock-main" }] };
  },
  handleAgents: async (argv) => {
    handled.agents.push(argv);
    return { profiles: [{ name: "reviewer", tools: "read_only" }] };
  },
  handleInit: async (argv) => {
    handled.init.push(argv);
    return {
      status: "ready",
      created: [path.join(".odai", "policy.json")],
      skipped: [],
      overwritten: [],
    };
  },
  handleDoctor: async (argv) => {
    handled.doctor.push(argv);
    return {
      status: "ready",
      provider: { name: "mock-main" },
      probe: { toolIntentCount: 0 },
      error: { message: "doctor token=doctor-error-secret" },
      savedRecordPath: scriptedDoctorRecordPath,
    };
  },
  handleStatus: async (argv) => {
    handled.status.push(argv);
    return {
      status: "partial",
      kind: "odai-status",
      summary: {
        governanceCovered: 18,
        governanceTotal: 18,
        acceptanceReady: 8,
        acceptanceTotal: 9,
        milestonesReady: 14,
        milestonesTotal: 16,
        e2eReady: 1,
        e2eTotal: 4,
      },
      blockers: [{ id: "A02" }],
      next: ["odai e2e --use-api-key --use-provider-command"],
      note: "scripted status token=status-note-secret",
    };
  },
  handleSetup: async (argv) => {
    handled.setup.push(argv);
    return {
      status: "partial",
      kind: "setup-guide",
      summary: {
        ready: 2,
        blocked: 3,
        total: 5,
        e2eReady: 1,
        e2eTotal: 4,
        savedEvidenceReady: 0,
        savedEvidenceTotal: 2,
      },
      next: ["odai init token=setup-next-secret"],
      note: "scripted setup token=setup-note-secret",
    };
  },
  handleAudit: async (argv) => {
    handled.audit.push(argv);
    return {
      status: "partial",
      kind: "completion-audit",
      complete: false,
      summary: {
        ready: 1,
        blocked: 4,
        total: 5,
      },
      next: ["odai e2e --use-api-key --use-provider-command"],
      note: "scripted audit token=audit-note-secret",
    };
  },
  handleEvidence: async () => {
    handled.evidence += 1;
    return {
      status: "partial",
      kind: "external-evidence",
      summary: {
        ready: 0,
        blocked: 2,
        apiProviders: 0,
        claudeRuntimeProviders: 0,
        strongSandboxSmokes: 0,
      },
      note: "scripted evidence token=evidence-note-secret",
    };
  },
  handlePolicy: async () => {
    handled.policy += 1;
    return { shell: { allowExecution: false, allowedCommands: [] } };
  },
  handleSessions: async (argv) => {
    handled.sessions.push(argv);
    return {
      status: "ready",
      sessionId: "scripted",
      transcriptPath: "/tmp/scripted-transcript.jsonl",
      count: 2,
      entries: [{ type: "session-start" }, { type: "task-submit" }],
    };
  },
  handleAuthorize: async (argv) => {
    handled.authorize.push(argv);
    return { ok: true, scope: argv[0], authorizations: argv };
  },
  handleContinue: async (argv) => {
    handled.continue.push(argv);
    return {
      status: "ready",
      task: "continued",
      recordPath: scriptedContinueRecordPath,
      note: "continued token=continue-note-secret",
    };
  },
  handleRollback: async (argv) => {
    handled.rollback.push(argv);
    return {
      status: "ready",
      confirmRequired: false,
      items: [{}],
      note: "rollback token=rollback-note-secret",
    };
  },
});
assert.deepEqual(handled.task[0], ["boot task", "--save", "--agent-loop", "--provider", "auto"]);
assert.deepEqual(handled.task[1], [
  "hello",
  "interactive",
  "--save",
  "--agent-loop",
  "--provider",
  "mock-main",
  "--model",
  "mock-session-model",
  "--reasoning",
  "high",
  "--context",
  "1000000",
]);
assert.deepEqual(handled.task[2], [
  "hello",
  "interactive",
  "--save",
  "--agent-loop",
  "--provider",
  "mock-main",
  "--model",
  "mock-session-model",
  "--reasoning",
  "high",
  "--context",
  "1000000",
]);
assert.equal(handled.contexts[0], undefined);
assert.deepEqual(handled.contexts[1].lastTaskArgv, ["boot task", "--save", "--agent-loop", "--provider", "auto"]);
assert.equal(handled.contexts[1].lastResult.task, "boot task --save --agent-loop --provider auto");
assert.ok(handled.contexts[1].lastResult.toolActions.some((action) => action.includes("tool: read mock.txt")));
assert.ok(!JSON.stringify(handled.contexts[1]).includes(scriptedWorkspaceRoot));
assert.deepEqual(handled.contexts[1].providerSessions, [{ provider: "mock-main", sessionId: "session:boot task" }]);
assert.deepEqual(handled.contexts[2].lastTaskArgv, [
  "hello",
  "interactive",
  "--save",
  "--agent-loop",
  "--provider",
  "mock-main",
  "--model",
  "mock-session-model",
  "--reasoning",
  "high",
  "--context",
  "1000000",
]);
assert.equal(handled.contexts[2].previous.lastTaskArgv[0], "boot task");
assert.deepEqual(handled.contexts[2].providerSessions, [{ provider: "mock-main", sessionId: "session:hello" }]);
assert.deepEqual(handled.providers[0], []);
assert.deepEqual(handled.providers[1], []);
assert.deepEqual(handled.providers[2], ["--use-api-key"]);
assert.deepEqual(handled.agents, [["--use-provider-command=true", "--main-provider", "mock-main"]]);
assert.deepEqual(handled.init[0], []);
assert.deepEqual(handled.doctor[0], ["--provider", "mock-main"]);
assert.deepEqual(handled.status[0], ["--use-provider-command=true"]);
assert.deepEqual(handled.setup[0], ["--use-provider-command=true"]);
assert.deepEqual(handled.audit[0], ["--use-provider-command=true"]);
assert.equal(handled.evidence, 1);
assert.equal(handled.policy, 1);
assert.deepEqual(handled.sessions[0], ["--tail", "2"]);
assert.deepEqual(handled.authorize[0], ["production"]);
assert.deepEqual(handled.continue[0], ["--run"]);
assert.deepEqual(handled.rollback[0], ["latest"]);
assert.ok(scriptedOutputs.some((message) => message.includes("odai interactive session")));
assert.ok(scriptedOutputs.some((message) => message.includes("transcript: /tmp/scripted-transcript.jsonl")));
assert.ok(scriptedOutputs.some((message) => message === "provider: mock-reviewer"));
assert.ok(scriptedOutputs.some((message) => message === "model: mock-main:mock-session-model"));
assert.ok(scriptedOutputs.some((message) => message === "reasoning: high"));
assert.ok(scriptedOutputs.some((message) => message === "context: 1m"));
assert.ok(scriptedOutputs.some((message) => message.includes("reasoning: high")));
assert.ok(scriptedOutputs.some((message) => message.includes("context: 1m")));
assert.ok(
  scriptedOutputs.some((message) =>
    message.includes(
      "/continue [--run] [--use-api-key] [--use-provider-command] [--allow-shell] [--allow-network]",
    ),
  ),
);
assert.ok(scriptedOutputs.some((message) => message.includes("provider: mock-main")));
assert.ok(scriptedOutputs.some((message) => message.includes('"name": "reviewer"')));
assert.ok(scriptedOutputs.some((message) => message.includes('"created"')));
assert.ok(!scriptedOutputs.join("\n").includes("interactive-stream-secret"));
assert.ok(scriptedOutputs.some((message) => message.includes("assistant: streamed api_key=[redacted]")));
assert.ok(scriptedOutputs.some((message) => message.includes("toolIntents: 0")));
assert.ok(scriptedOutputs.some((message) => message.includes("milestones: 14/16 ready")));
assert.ok(scriptedOutputs.some((message) => message.includes("setup: 2/5 ready")));
assert.ok(scriptedOutputs.some((message) => message.includes("next: odai e2e --use-api-key --use-provider-command")));
assert.ok(scriptedOutputs.some((message) => message.includes("next: odai init token=[redacted]")));
assert.ok(!scriptedOutputs.join("\n").includes("setup-next-secret"));
assert.ok(!scriptedOutputs.join("\n").includes("setup-note-secret"));
assert.ok(!scriptedOutputs.join("\n").includes("status-note-secret"));
assert.ok(!scriptedOutputs.join("\n").includes("audit-note-secret"));
assert.ok(!scriptedOutputs.join("\n").includes("evidence-note-secret"));
assert.ok(!scriptedOutputs.join("\n").includes("continue-note-secret"));
assert.ok(!scriptedOutputs.join("\n").includes("rollback-note-secret"));
assert.ok(!scriptedOutputs.join("\n").includes("doctor-error-secret"));
assert.ok(scriptedOutputs.some((message) => message.includes("error: doctor token=[redacted]")));
assert.ok(scriptedOutputs.some((message) => message.includes("note: scripted status token=[redacted]")));
assert.ok(scriptedOutputs.some((message) => message.includes("note: scripted audit token=[redacted]")));
assert.ok(scriptedOutputs.some((message) => message.includes("note: scripted evidence token=[redacted]")));
assert.ok(scriptedOutputs.some((message) => message.includes("note: rollback token=[redacted]")));
assert.ok(scriptedOutputs.some((message) => message.includes("complete: no")));
assert.ok(scriptedOutputs.some((message) => message.includes("requirements: 1/5 ready")));
assert.ok(scriptedOutputs.some((message) => message.includes("external evidence: 0/2 ready")));
assert.ok(scriptedOutputs.some((message) => message.includes("tool: read stream.txt")));
assert.ok(scriptedOutputs.some((message) => message.includes("tool: read mock.txt")));
assert.ok(scriptedOutputs.some((message) => message === "authorized: production"));
assert.ok(!scriptedOutputs.some((message) => message.includes('"authorizations"') && message.includes("production")));
assert.ok(scriptedOutputs.some((message) => normalizeSlashes(message).includes("saved: .odai/runs/mock-run.json")));
assert.ok(scriptedOutputs.some((message) => normalizeSlashes(message).includes("saved: .odai/runs/doctor-run.json")));
assert.ok(scriptedOutputs.some((message) => normalizeSlashes(message).includes("record: .odai/runs/continued.json")));
assert.ok(
  scriptedOutputs.some(
    (message) =>
      message.includes("tokens: input ~42 tok est") &&
      message.includes("thinking/activity ~") &&
      message.includes("total ~"),
  ),
);
assert.ok(
  scriptedOutputs.some((message) => message.includes("tokens: input 21 tok output 9 tok total 30 tok")),
);
assert.ok(!scriptedOutputs.join("\n").includes(scriptedWorkspaceRoot));
assert.ok(!JSON.stringify(scriptedTranscript).includes("interactive-stream-secret"));
assert.ok(!JSON.stringify(scriptedTranscript).includes(scriptedWorkspaceRoot));
assert.ok(JSON.stringify(scriptedTranscript).includes("stream.txt"));
assert.ok(JSON.stringify(scriptedTranscript).includes("mock.txt"));
assert.ok(JSON.stringify(scriptedTranscript).includes("api_key=[redacted]"));
assert.equal(scriptedTranscript[0].type, "session-start");
assert.ok(scriptedTranscript.some((event) => event.type === "task-submit" && event.argv[0] === "boot task"));
assert.ok(
  scriptedTranscript.some((event) => event.type === "progress" && event.event.type === "provider-text"),
);
assert.ok(
  scriptedTranscript.some((event) => event.type === "progress" && event.event.type === "provider-meter"),
);
assert.ok(
  scriptedTranscript.some(
    (event) =>
      event.type === "progress" &&
      event.event.type === "provider-meter" &&
      Number.isFinite(event.event.estimatedOutputTokens),
  ),
);
assert.ok(scriptedOutputs.some((message) => message.includes("activity ~") && message.includes("tok est")));
assert.ok(
  scriptedTranscript.some(
    (event) =>
      event.type === "progress" &&
      event.event.type === "provider-meter" &&
      Number.isFinite(event.event.estimatedInputTokens) &&
      Number.isFinite(event.event.estimatedThinkingTokens) &&
      Number.isFinite(event.event.estimatedActiveTokens) &&
      Number.isFinite(event.event.estimatedTotalTokens),
  ),
);
assert.ok(
  scriptedTranscript.some(
    (event) =>
      event.type === "progress" &&
      event.event.type === "provider-meter" &&
      event.event.usage?.input_tokens === 21 &&
      event.event.usage?.output_tokens === 9,
  ),
);
assert.ok(scriptedTranscript.some((event) => event.type === "command-result" && event.command === "provider"));
assert.ok(scriptedTranscript.some((event) => event.type === "command-result" && event.command === "model"));
assert.equal(
  scriptedTranscript.find((event) => event.type === "command-result" && event.command === "model")?.result?.model,
  "mock-session-model",
);
assert.ok(scriptedTranscript.some((event) => event.type === "command-result" && event.command === "init"));
assert.equal(
  scriptedTranscript.find((event) => event.type === "command-result" && event.command === "status")?.result
    ?.blockerCount,
  1,
);
assert.equal(
  scriptedTranscript.find((event) => event.type === "command-result" && event.command === "setup")?.result?.summary
    ?.blocked,
  3,
);
assert.equal(
  scriptedTranscript.find((event) => event.type === "command-result" && event.command === "audit")?.result?.summary
    ?.blocked,
  4,
);
assert.equal(
  scriptedTranscript.find((event) => event.type === "command-result" && event.command === "evidence")?.result
    ?.summary?.blocked,
  2,
);
assert.ok(!JSON.stringify(scriptedTranscript).includes("/tmp/scripted-transcript.jsonl"));
assert.ok(!JSON.stringify(scriptedTranscript).includes("setup-next-secret"));
assert.ok(!JSON.stringify(scriptedTranscript).includes("setup-note-secret"));
assert.equal(
  scriptedTranscript.find((event) => event.type === "command-result" && event.command === "authorize")?.result?.scope,
  undefined,
);
assert.equal(scriptedTranscript.filter((event) => event.type === "session-end").length, 1);

const modelOnlyInputs = [
  "/provider mock-main",
  "/model plain-session-model",
  "plain model task",
  "/model auto",
  "cleared model task",
  "/exit",
];
const modelOnlyTasks = [];
const modelOnlyOutputs = [];
await runInteractiveSession({
  ask: async () => modelOnlyInputs.shift(),
  write: (message) => modelOnlyOutputs.push(message),
  readInputLoop: true,
  handleTask: async (argv) => {
    modelOnlyTasks.push(argv);
    const modelFlagIndex = argv.indexOf("--model");
    const model = modelFlagIndex >= 0 ? argv[modelFlagIndex + 1] : undefined;
    return {
      status: "ready",
      task: argv.join(" "),
      agentLoop: {
        agent: { provider: "mock-main" },
        turns: [],
        finalOutput: {
          provider: "mock-main",
          model,
          text: model ? "interactive model answer" : "interactive default answer",
        },
      },
    };
  },
  handleProviders: async () => ({ providers: [{ name: "mock-main" }] }),
  handleContinue: async () => ({ status: "ready" }),
});
assert.deepEqual(modelOnlyTasks[0], [
  "plain",
  "model",
  "task",
  "--save",
  "--agent-loop",
  "--provider",
  "mock-main",
  "--model",
  "plain-session-model",
]);
assert.deepEqual(modelOnlyTasks[1], [
  "cleared",
  "model",
  "task",
  "--save",
  "--agent-loop",
  "--provider",
  "mock-main",
]);
assert.ok(modelOnlyOutputs.some((message) => message === "model: plain-session-model"));
assert.ok(modelOnlyOutputs.some((message) => message === "model: auto"));
assert.ok(modelOnlyOutputs.some((message) => message.includes("model: plain-session-model")));
assert.ok(modelOnlyOutputs.some((message) => message.includes("output:\ninteractive model answer")));
assert.ok(modelOnlyOutputs.some((message) => message.includes("output:\ninteractive default answer")));

const modelSelectInputs = ["/models select", "/exit"];
const modelSelectOutputs = [];
const modelSelectModelsArgs = [];
const modelSelectChoices = [];
await runInteractiveSession({
  ask: async () => modelSelectInputs.shift(),
  write: (message) => modelSelectOutputs.push(message),
  handleTask: async (argv) => ({ status: "ready", task: argv.join(" ") }),
  handleProviders: async () => ({ providers: [{ name: "codex-cli" }] }),
  handleModels: async (argv) => {
    modelSelectModelsArgs.push(argv);
    return {
      status: "ready",
      kind: "model-catalog",
      models: [
        {
          label: "codex-cli:gpt-5.5",
          provider: "codex-cli",
          model: "gpt-5.5",
          available: true,
        },
      ],
      discovery: [],
      providers: [],
    };
  },
  selectModel: async (choices) => {
    modelSelectChoices.push(...choices);
    return choices[0];
  },
  handleContinue: async () => ({ status: "ready" }),
});
assert.deepEqual(modelSelectModelsArgs[0], ["select"]);
assert.equal(modelSelectChoices[0].label, "codex-cli:gpt-5.5");
assert.ok(modelSelectOutputs.some((message) => message === "model: codex-cli:gpt-5.5"));
assert.ok(!modelSelectOutputs.some((message) => /"selected": "codex-cli:gpt-5\.5"/.test(message)));

const preferenceSessionInputs = [
  "preference task",
  "/model auto",
  "/provider grok-cli",
  "/reasoning auto",
  "/context auto",
  "/language en",
  "/auth api-key",
  "/exit",
];
const preferenceSessionTasks = [];
const preferenceSessionOutputs = [];
const preferencePatches = [];
const preferenceLanguageState = { value: "zh" };
await runInteractiveSession({
  ask: async () => preferenceSessionInputs.shift(),
  write: (message) => preferenceSessionOutputs.push(message),
  languageState: preferenceLanguageState,
  initialPreferences: {
    language: "zh",
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoning: "high",
    contextWindowTokens: 1000000,
    auth: {
      useApiKey: false,
      useProviderCommand: true,
    },
  },
  savePreferences: async (patch) => preferencePatches.push(patch),
  handleTask: async (argv) => {
    preferenceSessionTasks.push(argv);
    return {
      status: "ready",
      task: argv.join(" "),
      agentLoop: { agent: { provider: "codex-cli" }, turns: [] },
    };
  },
  handleProviders: async () => ({ providers: [{ name: "codex-cli" }, { name: "grok-cli" }] }),
  handleContinue: async () => ({ status: "ready" }),
});
assert.deepEqual(preferenceSessionTasks[0], [
  "preference",
  "task",
  "--save",
  "--agent-loop",
  "--provider",
  "codex-cli",
  "--model",
  "gpt-5.5",
  "--reasoning",
  "high",
  "--context",
  "1000000",
  "--use-provider-command",
]);
assert.ok(preferenceSessionOutputs.some((message) => message.includes("odai 交互会话")));
assert.ok(preferenceSessionOutputs.some((message) => message === "model: auto"));
assert.ok(preferenceSessionOutputs.some((message) => message === "provider: grok-cli"));
assert.ok(preferenceSessionOutputs.some((message) => message === "reasoning: auto"));
assert.ok(preferenceSessionOutputs.some((message) => message === "context: auto"));
assert.ok(preferenceSessionOutputs.some((message) => message === "Session CLI language updated."));
assert.ok(preferenceSessionOutputs.some((message) => message === "auth: api-key, provider-command"));
assert.ok(preferencePatches.some((patch) => patch.model === undefined && patch.provider === "codex-cli"));
assert.ok(preferencePatches.some((patch) => patch.provider === "grok-cli"));
assert.ok(preferencePatches.some((patch) => patch.reasoning === undefined));
assert.ok(preferencePatches.some((patch) => patch.contextWindowTokens === undefined));
assert.ok(preferencePatches.some((patch) => patch.language === "en"));
assert.ok(
  preferencePatches.some(
    (patch) => patch.auth?.useApiKey === true && patch.auth?.useProviderCommand === true,
  ),
);

const authInputs = [
  "/auth",
  "/auth claude-cli",
  "/models",
  "auth task",
  "/auth clear",
  "cleared auth task",
  "/exit",
];
const authTasks = [];
const authModelsArgs = [];
const authOutputs = [];
await runInteractiveSession({
  ask: async () => authInputs.shift(),
  write: (message) => authOutputs.push(message),
  handleTask: async (argv) => {
    authTasks.push(argv);
    return {
      status: "ready",
      task: argv.join(" "),
      agentLoop: { agent: { provider: "mock-main" }, turns: [] },
    };
  },
  handleProviders: async () => ({ providers: [{ name: "mock-main" }] }),
  handleModels: async (argv) => {
    authModelsArgs.push(argv);
    return {
      status: "ready",
      kind: "model-catalog",
      models: [{ label: "mock-main:test-model", provider: "mock-main", model: "test-model", available: true }],
      discovery: [
        {
          provider: "blocked-sub",
          status: "blocked",
          source: "openai-compatible",
          reason: "fetch failed: ECONNRESET",
        },
      ],
      providers: [],
    };
  },
  handleContinue: async () => ({ status: "ready" }),
});
assert.deepEqual(authModelsArgs[0], ["--use-provider-command=claude-cli"]);
assert.deepEqual(authTasks[0], [
  "auth",
  "task",
  "--save",
  "--agent-loop",
  "--provider",
  "auto",
  "--use-provider-command=claude-cli",
]);
assert.deepEqual(authTasks[1], [
  "cleared",
  "auth",
  "task",
  "--save",
  "--agent-loop",
  "--provider",
  "auto",
]);
assert.ok(authOutputs.some((message) => message === "auth: claude-cli"));
assert.ok(authOutputs.some((message) => message === "auth: none"));
assert.ok(!authOutputs.some((message) => /"useProviderCommand": true/.test(message)));
assert.ok(authOutputs.some((message) => message.includes("models: 1/1 available")));
assert.ok(authOutputs.some((message) => message.includes("blocked-sub: fetch failed: ECONNRESET")));

const languageInputs = ["/help", "/language en", "/help", "/language fr", "/exit"];
const languageOutputs = [];
const languageTranscript = [];
const sharedLanguageState = { value: "zh" };
await runInteractiveSession({
  ask: async () => languageInputs.shift(),
  write: (message) => languageOutputs.push(message),
  recordTranscript: async (event) => languageTranscript.push(event),
  languageState: sharedLanguageState,
  handleTask: async (argv) => ({ status: "ready", task: argv.join(" ") }),
  handleProviders: async () => ({ providers: [{ name: "mock-main" }] }),
  handleContinue: async () => ({ status: "ready" }),
});
assert.equal(sharedLanguageState.value, "en");
assert.ok(languageOutputs.some((message) => message.includes("odai 交互会话")));
assert.ok(languageOutputs.some((message) => message.includes("命令: /providers")));
assert.ok(languageOutputs.some((message) => message.includes("Session CLI language updated")));
assert.ok(languageOutputs.some((message) => message.includes("Commands: /providers")));
assert.ok(languageOutputs.some((message) => message.includes("Usage: /language <zh|en>")));
assert.ok(!languageOutputs.some((message) => /"language": "en"/.test(message)));
assert.ok(!languageOutputs.some((message) => message.trim().startsWith("{")));
assert.ok(
  languageTranscript.some(
    (event) => event.type === "command-result" && event.command === "language" && event.result?.language === "en",
  ),
);

const cliInitialTask = await runCliBin(
  ["spawned initial task", "--file", path.join(repoRoot, "cli", "src", "index.mjs")],
  "/exit\n",
);
assert.equal(cliInitialTask.timedOut, false);
assert.equal(cliInitialTask.code, 0, cliInitialTask.stderr);
assert.match(cliInitialTask.stdout, /odai interactive session/);
assert.match(cliInitialTask.stdout, /status: ready/);
assert.ok(!cliInitialTask.stdout.trimStart().startsWith("{"));
assert.ok(!cliInitialTask.stdout.includes(repoRoot));
const cliInitialTaskStdout = normalizeSlashes(cliInitialTask.stdout);
assert.match(cliInitialTaskStdout, /transcript: \.odai\/sessions\//);
assert.match(cliInitialTaskStdout, /saved: \.odai\/runs\//);
const cliInitialTaskRecord = JSON.parse(await readFile(path.join(repoRoot, ".odai", "runs", "latest.json"), "utf8"));
assert.equal(cliInitialTaskRecord.task, "spawned initial task");
assert.equal(cliInitialTaskRecord.mode, "agent_loop");
assert.deepEqual(cliInitialTaskRecord.providerSelection, { requested: "auto", selected: "mock-main" });
assert.deepEqual(cliInitialTaskRecord.resume.argv.slice(-2, -1), ["--file"]);
assert.equal(
  normalizePathForCompare(cliInitialTaskRecord.resume.argv.at(-1)),
  normalizePathForCompare(path.join(repoRoot, "cli", "src", "index.mjs")),
);

const cliNonTtyInitialTask = await runCliBin(["non tty initial task", "--max-turns", "1"], "");
assert.equal(cliNonTtyInitialTask.timedOut, false);
assert.equal(cliNonTtyInitialTask.code, 0, cliNonTtyInitialTask.stderr);
assert.match(cliNonTtyInitialTask.stdout, /odai interactive session/);
assert.match(cliNonTtyInitialTask.stdout, /status: ready/);
assert.ok(!cliNonTtyInitialTask.stdout.includes("bye"));
const cliNonTtyInitialTaskRecord = JSON.parse(
  await readFile(path.join(repoRoot, ".odai", "runs", "latest.json"), "utf8"),
);
assert.equal(cliNonTtyInitialTaskRecord.task, "non tty initial task");
assert.equal(cliNonTtyInitialTaskRecord.mode, "agent_loop");

const cliEqualsProviderInitialTask = await runCliBin(
  [
    "equals provider initial task",
    "--provider=mock-main",
    `--file=${path.join(repoRoot, "cli", "src", "index.mjs")}`,
    "--max-turns=1",
  ],
  "",
);
assert.equal(cliEqualsProviderInitialTask.timedOut, false);
assert.equal(cliEqualsProviderInitialTask.code, 0, cliEqualsProviderInitialTask.stderr);
const cliEqualsProviderRecord = JSON.parse(await readFile(path.join(repoRoot, ".odai", "runs", "latest.json"), "utf8"));
assert.equal(cliEqualsProviderRecord.task, "equals provider initial task");
assert.equal(cliEqualsProviderRecord.agentLoop.agent.provider, "mock-main");
assert.equal(cliEqualsProviderRecord.providerSelection, undefined);
assert.equal(cliEqualsProviderRecord.agentLoop.stopReason, "max_turns_reached");

const cliEvidence = await runCliBin(["evidence"], "");
assert.equal(cliEvidence.timedOut, false);
assert.equal(cliEvidence.code, 0, cliEvidence.stderr);
const cliEvidenceJson = JSON.parse(cliEvidence.stdout);
assert.equal(cliEvidenceJson.kind, "external-evidence");
assert.ok(["ready", "partial"].includes(cliEvidenceJson.status));

const cliSetup = await runCliBin(["setup"], "");
assert.equal(cliSetup.timedOut, false);
assert.equal(cliSetup.code, 0, cliSetup.stderr);
const cliSetupJson = JSON.parse(cliSetup.stdout);
assert.equal(cliSetupJson.kind, "setup-guide");
assert.ok(["ready", "partial"].includes(cliSetupJson.status));
assert.equal(cliSetupJson.commands.interactive, "odai");
assert.equal(cliSetupJson.cliSetup.localExecutable, "./cli/bin/odai.mjs");
assert.equal(cliSetupJson.cliSetup.packageName, "odai-cli");
assert.equal(cliSetupJson.cliSetup.bin.target, "./bin/odai.mjs");

const cliAudit = await runCliBin(["audit"], "");
assert.equal(cliAudit.timedOut, false);
assert.equal(cliAudit.code, 0, cliAudit.stderr);
const cliAuditJson = JSON.parse(cliAudit.stdout);
assert.equal(cliAuditJson.kind, "completion-audit");
assert.ok(["ready", "partial"].includes(cliAuditJson.status));
assert.equal(cliAuditJson.complete, cliAuditJson.status === "ready");

const cliExecutableHelp = await runCliExecutable(["--help"]);
assert.equal(cliExecutableHelp.timedOut, false);
assert.equal(cliExecutableHelp.code, 0, cliExecutableHelp.stderr);
assert.match(cliExecutableHelp.stdout, /Usage: odai \[task\]/);
assert.match(cliExecutableHelp.stdout, /Script mode: odai run <task>/);

const resumedInputs = ["/retry", "/context", "/exit"];
const resumedOutputs = [];
const resumedTranscript = [];
const resumedTasks = [];
const resumedContexts = [];
await runInteractiveSession({
  ask: async () => resumedInputs.shift(),
  write: (message) => resumedOutputs.push(message),
  resumeContext: {
    status: "ready",
    sourceSessionId: "previous-session",
    sourceTranscriptPath: "/tmp/previous.jsonl",
    eventCount: 5,
    lastTaskArgv: ["previous task", "--agent-loop"],
    lastResult: { status: "ready", task: "previous task" },
    recent: [],
    notRestored: ["api-key-confirmation"],
  },
  recordTranscript: async (event) => resumedTranscript.push(event),
  handleTask: async (argv, options) => {
    resumedTasks.push(argv);
    resumedContexts.push(options?.context);
    return {
      status: "ready",
      task: argv.join(" "),
      agentLoop: { agent: { provider: "mock-main" }, turns: [] },
    };
  },
  handleProviders: async () => ({}),
  handleContinue: async () => ({}),
});
assert.deepEqual(resumedTasks[0], ["previous task", "--agent-loop", "--save", "--provider", "auto"]);
assert.equal(resumedContexts[0].sourceSessionId, "previous-session");
assert.deepEqual(resumedContexts[0].lastTaskArgv, ["previous task", "--agent-loop"]);
assert.ok(resumedOutputs.some((message) => message.includes("resumed: previous-session")));
assert.ok(resumedOutputs.some((message) => message.includes("last task: previous task --agent-loop")));
assert.ok(resumedOutputs.some((message) => message.includes('"sourceSessionId": "previous-session"')));
assert.ok(resumedTranscript.some((event) => event.type === "session-resume"));
assert.ok(!JSON.stringify(resumedTranscript).includes("/tmp/previous.jsonl"));

const authorizationInputs = ["dangerous task", "yes", "/exit"];
const authorizationPrompts = [];
const authorizationOutputs = [];
const authorizationHandled = {
  task: [],
  authorize: [],
};
await runInteractiveSession({
  ask: async (prompt) => {
    authorizationPrompts.push(prompt);
    return authorizationInputs.shift();
  },
  write: (message) => authorizationOutputs.push(message),
  handleTask: async (argv) => {
    authorizationHandled.task.push(argv);
    if (authorizationHandled.task.length === 1) {
      return {
        status: "ready",
        task: argv.join(" "),
        requiredAuthorizations: ["risk:production"],
        note: "needs authorization",
      };
    }
    return {
      status: "ready",
      task: argv.join(" "),
      requiredAuthorizations: [],
      note: "authorized retry",
    };
  },
  handleProviders: async () => ({}),
  handleContinue: async () => ({}),
  handleAuthorize: async (argv) => {
    authorizationHandled.authorize.push(argv);
    return { ok: true, scope: argv[0], authorizations: argv };
  },
});
assert.deepEqual(authorizationHandled.task, [
  ["dangerous", "task", "--save", "--agent-loop", "--provider", "auto"],
  ["dangerous", "task", "--save", "--agent-loop", "--provider", "auto"],
]);
assert.deepEqual(authorizationHandled.authorize, [["risk:production"]]);
assert.ok(authorizationPrompts.includes("authorize risk:production? [y/N] "));
assert.ok(authorizationOutputs.some((message) => message.includes("authorized retry")));

const deniedAuthorizationInputs = ["dangerous task", "no", "/exit"];
const deniedAuthorizationHandled = {
  task: [],
  authorize: [],
};
const deniedAuthorizationOutputs = [];
await runInteractiveSession({
  ask: async () => deniedAuthorizationInputs.shift(),
  write: (message) => deniedAuthorizationOutputs.push(message),
  handleTask: async (argv) => {
    deniedAuthorizationHandled.task.push(argv);
    return {
      status: "ready",
      task: argv.join(" "),
      requiredAuthorizations: ["risk:production"],
      note: "needs authorization",
    };
  },
  handleProviders: async () => ({}),
  handleContinue: async () => ({}),
  handleAuthorize: async (argv) => {
    deniedAuthorizationHandled.authorize.push(argv);
    return { ok: true, scope: argv[0], authorizations: argv };
  },
});
assert.equal(deniedAuthorizationHandled.task.length, 1);
assert.deepEqual(deniedAuthorizationHandled.authorize, []);
assert.ok(deniedAuthorizationOutputs.some((message) => message.includes("authorization denied: risk:production")));

let claudeSdkQueryRequest;
let claudeSdkDeniedTool;
const previousClaudeSdkSecret = process.env.CLAUDE_SDK_SECRET_TOKEN;
process.env.CLAUDE_SDK_SECRET_TOKEN = "claude-sdk-env-secret";
const claudeSdkEvents = [];
const claudeSdkProvider = createClaudeAgentSdkProvider({
  installed: true,
  allowProviderCommand: true,
  timeoutMs: 1234,
  maxOutputChars: 500,
  loadSdk: async () => ({
    query: async function* (request) {
      claudeSdkQueryRequest = request;
      claudeSdkDeniedTool = await request.options.canUseTool("Read", { file_path: "cli/src/index.mjs" }, {
        toolUseID: "sdk-tool-use-1",
      });
      yield {
        type: "assistant",
        uuid: "sdk-message",
        session_id: "sdk-session-1",
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                text: "sdk requested read api_key=claude-sdk-output-secret",
                toolIntents: [{ type: "read", path: "cli/src/index.mjs" }],
              }),
            },
          ],
          usage: { input_tokens: 11, output_tokens: 7 },
        },
      };
    },
  }),
});
const claudeSdkResult = await claudeSdkProvider.run({
  agent: { id: "claude-sdk-test" },
  input: { task: "hello sdk" },
  onEvent: (event) => claudeSdkEvents.push(event),
});
if (previousClaudeSdkSecret === undefined) {
  delete process.env.CLAUDE_SDK_SECRET_TOKEN;
} else {
  process.env.CLAUDE_SDK_SECRET_TOKEN = previousClaudeSdkSecret;
}
assert.equal(claudeSdkResult.text, "sdk requested read api_key=[redacted]");
assert.deepEqual(claudeSdkResult.toolIntents, [{ type: "read", path: "cli/src/index.mjs", risk: undefined }]);
assert.deepEqual(claudeSdkResult.usage, { input_tokens: 11, output_tokens: 7 });
assert.deepEqual(claudeSdkResult.providerSession, {
  provider: "claude-agent-sdk",
  sessionId: "sdk-session-1",
  messageId: "sdk-message",
});
assert.equal(claudeSdkQueryRequest.options.maxTurns, 1);
assert.deepEqual(claudeSdkQueryRequest.options.disallowedTools, ["*"]);
assert.deepEqual(claudeSdkQueryRequest.options.allowedTools, []);
assert.deepEqual(claudeSdkQueryRequest.options.tools, []);
assert.deepEqual(claudeSdkQueryRequest.options.mcpServers, {});
assert.deepEqual(claudeSdkQueryRequest.options.additionalDirectories, []);
assert.equal(claudeSdkQueryRequest.options.strictMcpConfig, true);
assert.equal(claudeSdkQueryRequest.options.permissionMode, "dontAsk");
assert.deepEqual(claudeSdkQueryRequest.options.settingSources, []);
assert.equal(claudeSdkQueryRequest.options.persistSession, false);
assert.equal(claudeSdkQueryRequest.options.cwd.includes("odai-claude-sdk-"), true);
assert.equal(claudeSdkQueryRequest.options.env.CLAUDE_SDK_SECRET_TOKEN, undefined);
assert.deepEqual(claudeSdkDeniedTool, {
  behavior: "deny",
  message: "odai-runtime owns all local tool execution.",
  toolUseID: "sdk-tool-use-1",
});
assert.ok(claudeSdkEvents.some((event) => event.type === "provider-text" && event.provider === "claude-agent-sdk"));
assert.ok(claudeSdkEvents.every((event) => !JSON.stringify(event).includes("claude-sdk-output-secret")));

const blockedClaudeSdkProvider = createClaudeAgentSdkProvider({
  installed: true,
  loadSdk: async () => {
    throw new Error("SDK should not load without explicit confirmation");
  },
});
assert.equal(blockedClaudeSdkProvider.available, false);
assert.equal(blockedClaudeSdkProvider.blockedReason, "provider_command_requires_explicit_use");
await assert.rejects(
  () => blockedClaudeSdkProvider.run({ agent: { id: "blocked-claude-sdk" }, input: { task: "hello sdk" } }),
  /requires explicit --use-provider-command/,
);

let claudeCliRunOptions;
const claudeCliProvider = createClaudeCliProvider({
  installed: true,
  allowProviderCommand: true,
  timeoutMs: 1234,
  maxOutputChars: 40,
  runCommand: (command, args, options) => {
    claudeCliRunOptions = options;
    assert.equal(command, "claude");
    assert.ok(args.includes("--bare"));
    assert.ok(args.includes("--disallowedTools"));
    assert.ok(args.includes("*"));
    return { status: 0, stdout: `${"x".repeat(60)} token=claude-cli-output-secret`, stderr: `${"e".repeat(60)}` };
  },
});
const claudeCliResult = await claudeCliProvider.run({
  agent: { id: "claude-cli-test" },
  input: { task: "hello" },
});
assert.equal(claudeCliResult.text, `${"x".repeat(40)}\n[truncated 51 chars]`);
assert.equal(claudeCliResult.stderr, `${"e".repeat(40)}\n[truncated 20 chars]`);
assert.equal(claudeCliRunOptions.timeoutMs, 1234);
assert.equal(claudeCliRunOptions.maxOutputChars, 40);
assert.ok(claudeCliRunOptions.cwd.includes("odai-claude-cli-"));

const claudeCliEnvProbe = path.join(sessionTmp, "claude-env-probe.mjs");
await writeFile(
  claudeCliEnvProbe,
  [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({",
    "  openai: process.env.OPENAI_API_KEY || '',",
    "  token: process.env.ODAI_TEST_TOKEN || '',",
    "  safe: process.env.ODAI_SAFE_ENV || ''",
    "}));",
    "",
  ].join("\n"),
  "utf8",
);
await chmod(claudeCliEnvProbe, 0o755);
const claudeCliEnvCommand = process.platform === "win32"
  ? path.join(sessionTmp, "claude-env-probe.cmd")
  : claudeCliEnvProbe;
if (process.platform === "win32") {
  await writeFile(claudeCliEnvCommand, `@echo off\r\n"${process.execPath}" "${claudeCliEnvProbe}" %*\r\n`, "utf8");
}
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousToken = process.env.ODAI_TEST_TOKEN;
const previousSafe = process.env.ODAI_SAFE_ENV;
process.env.OPENAI_API_KEY = "sk-should-not-leak";
process.env.ODAI_TEST_TOKEN = "token-should-not-leak";
process.env.ODAI_SAFE_ENV = "visible";
try {
  const claudeCliEnvProvider = createClaudeCliProvider({
    command: claudeCliEnvCommand,
    installed: true,
    allowProviderCommand: true,
  });
  const claudeCliEnvResult = await claudeCliEnvProvider.run({
    agent: { id: "claude-cli-env-test" },
    input: { task: "env probe" },
  });
  assert.deepEqual(JSON.parse(claudeCliEnvResult.text), {
    openai: "",
    token: "",
    safe: "visible",
  });
} finally {
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousToken === undefined) delete process.env.ODAI_TEST_TOKEN;
  else process.env.ODAI_TEST_TOKEN = previousToken;
  if (previousSafe === undefined) delete process.env.ODAI_SAFE_ENV;
  else process.env.ODAI_SAFE_ENV = previousSafe;
}

const blockedClaudeCliProvider = createClaudeCliProvider({ installed: true });
assert.equal(blockedClaudeCliProvider.available, false);
assert.equal(blockedClaudeCliProvider.blockedReason, "provider_command_requires_explicit_use");
await assert.rejects(
  () => blockedClaudeCliProvider.run({ agent: { id: "blocked-claude-cli" }, input: { task: "hello" } }),
  /requires explicit --use-provider-command/,
);

const blockedCodexCliProvider = createCodexCliProvider({ installed: true });
assert.equal(blockedCodexCliProvider.available, false);
assert.equal(blockedCodexCliProvider.blockedReason, "provider_command_requires_explicit_use");
await assert.rejects(
  () => blockedCodexCliProvider.run({ agent: { id: "blocked-codex-cli" }, input: { task: "hello" } }),
  /requires explicit --use-provider-command/,
);
let codexRunOptions;
const codexCliProvider = createCodexCliProvider({
  installed: true,
  allowProviderCommand: true,
  model: "codex-test-model",
  runCommand: (command, args, options) => {
    codexRunOptions = options;
    assert.equal(command, "codex");
    assert.deepEqual(args.slice(0, 4), ["--ask-for-approval", "never", "exec", "--skip-git-repo-check"]);
    assert.ok(args.includes("--ephemeral"));
    assert.ok(args.includes("--ignore-rules"));
    assert.ok(args.includes("--sandbox"));
    assert.ok(args.includes("read-only"));
    assert.ok(args.includes("--cd"));
    assert.ok(args.includes("codex-test-model"));
    assert.equal(args.at(-1), "-");
    assert.ok(options.input.includes("project files are not directly visible"));
    assert.ok(options.input.includes("list, read, search, write, shell, network"));
    return {
      status: 0,
      stdout: JSON.stringify({
        text: "codex cli requested read",
        toolIntents: [{ type: "read", path: "cli/src/index.mjs" }],
      }),
      stderr: "",
    };
  },
});
const codexCliResult = await codexCliProvider.run({
  agent: { id: "codex-cli-test" },
  input: { task: "hello codex" },
});
assert.equal(codexCliResult.text, "codex cli requested read");
assert.deepEqual(codexCliResult.toolIntents, [{ type: "read", path: "cli/src/index.mjs", risk: undefined }]);
assert.ok(codexRunOptions.cwd.includes("odai-codex-cli-"));

const blockedGrokCliProvider = createGrokCliProvider({ installed: true });
assert.equal(blockedGrokCliProvider.available, false);
assert.equal(blockedGrokCliProvider.blockedReason, "provider_command_requires_explicit_use");
await assert.rejects(
  () => blockedGrokCliProvider.run({ agent: { id: "blocked-grok-cli" }, input: { task: "hello" } }),
  /requires explicit --use-provider-command/,
);
let grokRunOptions;
const grokCliProvider = createGrokCliProvider({
  installed: true,
  allowProviderCommand: true,
  model: "grok-test-model",
  runCommand: (command, args, options) => {
    grokRunOptions = options;
    assert.equal(command, "grok");
    assert.ok(args.includes("--prompt-file"));
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("plain"));
    assert.ok(args.includes("--no-subagents"));
    assert.ok(args.includes("--disable-web-search"));
    assert.ok(args.includes("--permission-mode"));
    assert.ok(args.includes("plan"));
    assert.ok(args.includes("--cwd"));
    assert.ok(args.includes("--no-memory"));
    assert.ok(args.includes("--verbatim"));
    assert.ok(args.includes("grok-test-model"));
    return { status: 0, stdout: "grok cli result", stderr: "" };
  },
});
const grokCliResult = await grokCliProvider.run({
  agent: { id: "grok-cli-test" },
  input: { task: "hello grok" },
});
assert.equal(grokCliResult.text, "grok cli result");
assert.ok(grokRunOptions.cwd.includes("odai-grok-cli-"));



console.log('suite interactive-cli ok');
