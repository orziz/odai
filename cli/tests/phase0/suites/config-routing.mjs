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
  bindRuntime,
  bindRoots,
  shared,
} from "../fixtures.mjs";


const {
  repoRoot,
  sessionTmp,
  policyRoot,
  sampleFile,
  stopFile,
  patchFile,
  resetFile,
  perceptionFile,
  intentFile,
  secretFile,
  envExampleFile,
  cliAdoptFile,
  agentLoopFile,
  agentLoopNewFile,
  overflowFile,
  checkpointDir,
  rollbackWorkspaceFile,
  rollbackNewFile,
  skillPack,
} = await createBaseFixtures();

const defaultPolicy = loadWorkspacePolicyConfig({ workspaceRoot: policyRoot });
assert.equal(defaultPolicy.shell.allowExecution, false);
assert.deepEqual(defaultPolicy.shell.allowedCommands, []);
assert.deepEqual(defaultPolicy.shell.sandbox, { mode: "none" });
assert.deepEqual(defaultPolicy.network, {
  allowRequests: false,
  allowedHosts: [],
  timeoutMs: 10000,
});

const preferencesRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-preferences-"));
assert.deepEqual(await loadWorkspacePreferences({ workspaceRoot: preferencesRoot }), {});
const writtenPreferences = await writeWorkspacePreferences({
  workspaceRoot: preferencesRoot,
  preferences: {
    language: "zh_CN",
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoning: "high",
    context: "1m",
    auth: {
      useApiKey: true,
      useProviderCommand: true,
      providerCommands: ["claude-cli", "claude-cli"],
    },
    ignored: "nope",
  },
});
assert.deepEqual(writtenPreferences, {
  language: "zh",
  provider: "codex-cli",
  model: "gpt-5.5",
  reasoning: "high",
  contextWindowTokens: 1000000,
  auth: {
    useApiKey: true,
    useProviderCommand: true,
    providerCommands: ["claude-cli"],
  },
});
assert.deepEqual(await loadWorkspacePreferences({ workspaceRoot: preferencesRoot }), writtenPreferences);
assert.equal(preferencesPath(preferencesRoot), path.join(preferencesRoot, ".odai", "preferences.json"));
assert.deepEqual(
  mergeWorkspacePreferences(writtenPreferences, {
    model: undefined,
    reasoning: "auto",
    contextWindowTokens: undefined,
  }),
  {
    language: "zh",
    provider: "codex-cli",
    auth: {
      useApiKey: true,
      useProviderCommand: true,
      providerCommands: ["claude-cli"],
    },
  },
);

const initRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-init-"));
const initResult = await runInit({ repoRoot: initRoot });
assert.equal(initResult.status, "ready");
assert.deepEqual(initResult.skipped, []);
assert.deepEqual(initResult.overwritten, []);
assert.deepEqual(initResult.created.sort(), [
  path.join(".odai", "agents.example.json"),
  path.join(".odai", "agents.json"),
  path.join(".odai", "policy.example.json"),
  path.join(".odai", "policy.json"),
  path.join(".odai", "providers.example.json"),
  path.join(".odai", "providers.json"),
].sort());
assert.deepEqual(loadWorkspacePolicyConfig({ workspaceRoot: initRoot }), defaultPolicy);
assert.deepEqual(loadWorkspaceProviderConfig({ workspaceRoot: initRoot }), { providers: [] });
assert.equal(loadWorkspaceAgentProfiles({ workspaceRoot: initRoot }).get("reviewer").tools, "read_only");
const agentsExample = JSON.parse(await readFile(path.join(initRoot, ".odai", "agents.example.json"), "utf8"));
assert.equal(agentsExample.agents.deep_reviewer.tools, "read_only");
assert.ok(agentsExample.agents.deep_reviewer.providerRequirements.includes("long_context"));
assert.equal(agentsExample.agents.cheap_challenger.tools, "none");
assert.equal(agentsExample.agents.patch_candidate.tools, "virtual_patch_only");
assert.equal(agentsExample.agents.bulk_reader.tools, "read_only");
assert.deepEqual(agentsExample.agents.bulk_reader.providerRequirements, ["long_context"]);
await writeFile(
  path.join(initRoot, ".odai", "agents.json"),
  `${JSON.stringify(
    { agents: { deep_reviewer: agentsExample.agents.deep_reviewer, bulk_reader: agentsExample.agents.bulk_reader } },
    null,
    2,
  )}\n`,
  "utf8",
);
const exampleAgents = loadWorkspaceAgentProfiles({ workspaceRoot: initRoot });
assert.equal(exampleAgents.get("deep_reviewer").tools, "read_only");
assert.deepEqual(exampleAgents.get("deep_reviewer").providerRequirements, ["code", "long_context"]);
assert.equal(exampleAgents.get("bulk_reader").tools, "read_only");
assert.deepEqual(exampleAgents.get("bulk_reader").allowedOutputs, ["evidence_summary", "file_map"]);
const exampleAgentDescriptions = describeWorkspaceAgentProfiles({ workspaceRoot: initRoot });
assert.ok(exampleAgentDescriptions.profiles.some((profile) => profile.name === "deep_reviewer"));
assert.ok(exampleAgentDescriptions.profiles.some((profile) => profile.name === "bulk_reader"));
const providerExample = JSON.parse(await readFile(path.join(initRoot, ".odai", "providers.example.json"), "utf8"));
assert.ok(providerExample.builtInProviders.some((provider) => provider.name === "openai-api"));
assert.ok(providerExample.builtInProviders.some((provider) => provider.name === "claude-agent-sdk"));
assert.ok(providerExample.builtInProviders.some((provider) => provider.name === "deepseek-api"));
assert.match(providerExample.usage, /--model/);
assert.match(providerExample.usage, /\/model/);
assert.ok(
  providerExample.builtInProviders.some(
    (provider) =>
      provider.name === "openai-api" &&
      provider.checkWithModel === "odai doctor --provider openai-api --use-api-key --model <model> --save" &&
      provider.interactiveModel === "/model openai-api:<model>",
  ),
);
assert.ok(
  providerExample.builtInProviders.some(
    (provider) =>
      provider.name === "deepseek-api" &&
      provider.auth === "Run `odai auth provider deepseek-api --api-key-stdin` to store a local key." &&
      provider.checkWithModel === "odai doctor --provider deepseek-api --use-api-key --model <model> --save" &&
      provider.interactiveModel === "/model deepseek-api:<model>",
  ),
);
assert.ok(
  providerExample.builtInProviders.some(
    (provider) =>
      provider.name === "codex-cli" &&
      provider.checkWithModel === "odai doctor --provider codex-cli --use-provider-command --model <model> --save" &&
      provider.interactiveModel === "/model codex-cli:<model>",
  ),
);
assert.ok(
  providerExample.builtInProviders.some(
    (provider) => provider.name === "claude-cli" && provider.optionalEnv?.includes("ODAI_CLAUDE_COMMAND"),
  ),
);
assert.ok(
  providerExample.builtInProviders.some(
    (provider) => provider.name === "codex-cli" && provider.optionalEnv?.includes("ODAI_CODEX_COMMAND"),
  ),
);
assert.ok(
  providerExample.builtInProviders.some(
    (provider) => provider.name === "grok-cli" && provider.optionalEnv?.includes("ODAI_GROK_COMMAND"),
  ),
);
assert.ok(
  providerExample.builtInProviders.some((provider) => /--use-provider-command/.test(provider.check)),
);
assert.ok(providerExample.providers.some((provider) => provider.type === "openai-compatible"));
assert.ok(
  providerExample.providers.some(
    (provider) =>
      provider.type === "openai-compatible" &&
      provider.checkWithModel ===
        "odai doctor --provider my-openai-compatible --use-api-key --model <model> --save" &&
      /\/model my-openai-compatible:<model>/.test(provider.modelOverride) &&
      /odai auth provider my-openai-compatible --api-key-stdin/.test(provider.auth),
  ),
);
assert.ok(
  providerExample.providers.some(
    (provider) =>
      provider.type === "command-json" &&
      provider.name === "my-cli-provider" &&
      provider.modelArgs?.join(" ") === "--model {model}",
  ),
);
assert.ok(providerExample.providers.some((provider) => provider.type === "ollama"));
const policyExample = JSON.parse(await readFile(path.join(initRoot, ".odai", "policy.example.json"), "utf8"));
assert.equal(policyExample.checks.preflight, "odai sandbox");
assert.equal(policyExample.checks.smoke, "odai doctor --sandbox --smoke --allow-shell --save");
assert.equal(policyExample.examples.docker.shell.sandbox.mode, "docker");
assert.equal(policyExample.examples.docker.shell.sandbox.image, "node:22-alpine");
assert.deepEqual(policyExample.examples.docker.shell.allowedCommands, ["node"]);
assert.equal(policyExample.examples.devcontainer.shell.sandbox.mode, "devcontainer");
assert.equal(policyExample.examples.macosSandboxExec.shell.sandbox.mode, "macos-sandbox-exec");
await writeFile(
  path.join(initRoot, ".odai", "policy.json"),
  `${JSON.stringify(policyExample.examples.docker, null, 2)}\n`,
  "utf8",
);
const dockerExamplePolicy = loadWorkspacePolicyConfig({ workspaceRoot: initRoot });
assert.equal(dockerExamplePolicy.shell.allowExecution, true);
assert.equal(dockerExamplePolicy.shell.sandbox.mode, "docker");
assert.equal(dockerExamplePolicy.shell.sandbox.image, "node:22-alpine");
const dockerExampleReadiness = runSandboxReadiness({
  repoRoot: initRoot,
  commandExists: (command) => command === "docker",
});
assert.equal(dockerExampleReadiness.status, "ready");
assert.equal(dockerExampleReadiness.summary.configuredStrong, true);
await writeFile(path.join(initRoot, ".odai", "policy.json"), "not-json\n", "utf8");
const invalidInitPolicy = loadWorkspacePolicyConfig({ workspaceRoot: initRoot });
assert.equal(invalidInitPolicy.shell.allowExecution, false);
assert.deepEqual(invalidInitPolicy.shell.allowedCommands, []);
assert.deepEqual(invalidInitPolicy.network, defaultPolicy.network);
assert.ok(
  invalidInitPolicy.configErrors.some((error) => /Failed to read policy config/.test(error.message)),
);
const initAgain = await runInit({ repoRoot: initRoot });
assert.ok(initAgain.skipped.includes(path.join(".odai", "policy.json")));
assert.equal(await readFile(path.join(initRoot, ".odai", "policy.json"), "utf8"), "not-json\n");
const initForced = await runInit({ repoRoot: initRoot, argv: ["--force"] });
assert.ok(initForced.overwritten.includes(path.join(".odai", "policy.json")));
assert.deepEqual(loadWorkspacePolicyConfig({ workspaceRoot: initRoot }), defaultPolicy);
const setupMissingRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-setup-missing-"));
const setupMissing = await runSetup({ repoRoot: setupMissingRoot });
assert.equal(setupMissing.kind, "setup-guide");
assert.equal(setupMissing.sections.find((section) => section.id === "workspace-config").status, "blocked");
assert.ok(setupMissing.next.some((action) => action.includes("odai init")));
assert.equal(setupMissing.completionPath[0].id, "workspace-config");
assert.equal(setupMissing.completionPath[0].status, "blocked");
const setupInitialized = await runSetup({ repoRoot: initRoot });
assert.equal(setupInitialized.kind, "setup-guide");
assert.equal(setupInitialized.sections.find((section) => section.id === "workspace-config").status, "ready");
assert.equal(setupInitialized.summary.configReady, true);
assert.equal(setupInitialized.commands.interactive, "odai");
assert.equal(setupInitialized.cliSetup.localExecutable, "./cli/bin/odai.mjs");
assert.equal(setupInitialized.cliSetup.packageName, "odai-cli");
assert.equal(setupInitialized.cliSetup.bin.name, "odai");
assert.equal(setupInitialized.cliSetup.linkCommand, "npm --prefix cli link");
assert.equal(setupInitialized.cliSetup.npxCommand, "npx odai-cli");
assert.ok(setupInitialized.providerSetup.builtIn.some((provider) => provider.name === "openai-api"));
assert.ok(setupInitialized.providerSetup.builtIn.some((provider) => provider.name === "claude-agent-sdk"));
assert.ok(setupInitialized.providerSetup.builtIn.some((provider) => provider.name === "deepseek-api"));
assert.ok(
  setupInitialized.providerSetup.builtIn.some(
    (provider) => provider.name === "claude-cli" && provider.optionalEnv?.includes("ODAI_CLAUDE_COMMAND"),
  ),
);
assert.ok(
  setupInitialized.providerSetup.builtIn.some(
    (provider) => provider.name === "codex-cli" && provider.optionalEnv?.includes("ODAI_CODEX_COMMAND"),
  ),
);
assert.ok(
  setupInitialized.providerSetup.builtIn.some(
    (provider) => provider.name === "grok-cli" && provider.optionalEnv?.includes("ODAI_GROK_COMMAND"),
  ),
);
assert.match(setupInitialized.providerSetup.custom, /\.odai\/providers\.json/);
assert.equal(setupInitialized.sandboxSetup.preflight, "odai sandbox");
assert.equal(setupInitialized.sandboxSetup.smoke, "odai doctor --sandbox --smoke --allow-shell --save");
assert.ok(setupInitialized.sandboxSetup.candidates.some((candidate) => candidate.mode === "docker"));
assert.equal(setupInitialized.flags.useProviderCommand, false);
assert.equal(setupInitialized.completionPath.length, 6);
assert.equal(setupInitialized.completionPath[0].status, "ready");
assert.equal(setupInitialized.completionPath[1].id, "provider-prerequisites");
assert.equal(setupInitialized.completionPath[1].status, "blocked");
assert.ok(setupInitialized.next.includes("odai e2e --use-api-key --use-provider-command"));
assert.ok(setupInitialized.next.includes("odai doctor --all --use-api-key --use-provider-command --save"));
assert.ok(setupInitialized.next.includes("odai doctor --provider codex-cli --use-provider-command --save"));
assert.ok(setupInitialized.next.includes("odai sandbox"));
assert.ok(setupInitialized.next.includes("odai doctor --sandbox --smoke --allow-shell --save"));
assert.ok(!setupInitialized.next.some((action) => action.includes("Rerun with --use-provider-command")));
const setupFlagged = await runSetup({ repoRoot: initRoot, argv: ["--use-provider-command=true"] });
assert.equal(setupFlagged.flags.useProviderCommand, true);
const setupWithModel = await runSetup({ repoRoot: initRoot, argv: ["--model", "setup-model"] });
assert.equal(setupWithModel.flags.model, "setup-model");
assert.ok(setupWithModel.next.includes("odai e2e --use-api-key --use-provider-command --model setup-model"));
assert.ok(
  setupWithModel.next.includes("odai doctor --all --use-api-key --use-provider-command --model setup-model --save"),
);
const setupChinese = await runSetup({ repoRoot: initRoot, env: { ODAI_LANG: "zh" } });
assert.ok(setupChinese.note.includes("不会调用真实 provider"));
assert.ok(setupChinese.cliSetup.note.includes("不会修改 PATH"));
assert.ok(setupInitialized.sections.some((section) => section.id === "saved-provider-evidence"));
assert.ok(setupInitialized.sections.some((section) => section.id === "saved-subscription-cli-evidence"));
assert.ok(setupInitialized.note.includes("does not call real providers"));

const defaultAgents = loadWorkspaceAgentProfiles({ workspaceRoot: policyRoot });
assert.equal(defaultAgents.get("reviewer").tools, "read_only");
assert.deepEqual(defaultAgents.get("challenger").providerRequirements, ["reasoning"]);
assert.equal(defaultAgents.get("bulk_reader").tools, "read_only");
assert.deepEqual(defaultAgents.get("bulk_reader").providerRequirements, ["long_context"]);
const agentRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-agents-"));
await mkdir(path.join(agentRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(agentRoot, ".odai", "agents.json"),
  `${JSON.stringify(
    {
      agents: {
        reviewer: {
          providerRequirements: ["code", "long_context"],
          allowedOutputs: ["findings"],
        },
        deep_reviewer: {
          purpose: "large_context_review",
          tools: "read_only",
          providerRequirements: ["long_context"],
          allowedOutputs: ["evidence_summary", "risks"],
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const configuredAgents = loadWorkspaceAgentProfiles({ workspaceRoot: agentRoot });
assert.deepEqual(configuredAgents.get("reviewer").providerRequirements, ["code", "long_context"]);
assert.deepEqual(configuredAgents.get("reviewer").allowedOutputs, ["findings"]);
assert.equal(configuredAgents.get("reviewer").tools, "read_only");
assert.equal(configuredAgents.get("deep_reviewer").source, "workspace");
assert.equal(configuredAgents.get("deep_reviewer").tools, "read_only");
assert.deepEqual(configuredAgents.get("deep_reviewer").providerRequirements, ["long_context"]);
const agentDescription = describeWorkspaceAgentProfiles({ workspaceRoot: agentRoot });
assert.ok(agentDescription.profiles.some((profile) => profile.name === "deep_reviewer"));
const runAgentsDescription = runAgents({ repoRoot: agentRoot });
assert.ok(runAgentsDescription.profiles.some((profile) => profile.name === "reviewer"));
const reviewerRouting = runAgentsDescription.routing.find((routing) => routing.profile === "reviewer");
assert.equal(reviewerRouting.tools, "read_only");
assert.ok(reviewerRouting.toolBoundary.includes("direct write"));
assert.ok(reviewerRouting.candidates.some((provider) => provider.name === "mock-reviewer"));
assert.ok(["mock-fallback", "ready", "ambiguous"].includes(reviewerRouting.auto.status));
const bulkReaderRouting = runAgentsDescription.routing.find((routing) => routing.profile === "bulk_reader");
assert.equal(bulkReaderRouting.tools, "read_only");
assert.deepEqual(bulkReaderRouting.requirements, ["long_context"]);
assert.equal(bulkReaderRouting.auto.selected, "mock-reviewer");
const fakeAgentClaudeBinDir = await mkdtemp(path.join(tmpdir(), "odai-cli-agent-fake-claude-bin-"));
const fakeAgentClaudePath = path.join(fakeAgentClaudeBinDir, process.platform === "win32" ? "claude.cmd" : "claude");
await writeFile(
  fakeAgentClaudePath,
  process.platform === "win32" ? "@echo off\r\necho fake agent claude\r\n" : "#!/bin/sh\nprintf 'fake agent claude\\n'\n",
  "utf8",
);
await chmod(fakeAgentClaudePath, 0o755);
const previousPathForAgentRouting = process.env.PATH;
process.env.PATH = [
  fakeAgentClaudeBinDir,
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(path.delimiter);
try {
  const routedAgents = runAgents({
    repoRoot: agentRoot,
    env: {
      OPENAI_API_KEY: "test-key",
      ODAI_OPENAI_MODEL: "test-model",
      ODAI_CLAUDE_COMMAND: fakeAgentClaudePath,
    },
    argv: ["--use-api-key", "--use-provider-command"],
  });
  const routedChallenger = routedAgents.routing.find((routing) => routing.profile === "challenger");
  assert.equal(routedAgents.flags.useApiKey, true);
  assert.equal(routedAgents.flags.useProviderCommand, true);
  assert.equal(routedChallenger.auto.status, "ambiguous");
  assert.ok(routedChallenger.auto.reason.includes("openai-api"));
  assert.ok(routedChallenger.auto.reason.includes("claude-cli"));
  assert.ok(routedChallenger.candidates.some((provider) => provider.name === "openai-api" && provider.available));
  assert.ok(routedChallenger.candidates.some((provider) => provider.name === "claude-cli" && provider.available));
  const routedAgentsWithMain = runAgents({
    repoRoot: agentRoot,
    env: {
      OPENAI_API_KEY: "test-key",
      ODAI_OPENAI_MODEL: "test-model",
      ODAI_CLAUDE_COMMAND: fakeAgentClaudePath,
    },
    argv: ["--use-api-key", "--use-provider-command", "--main-provider", "openai-api"],
  });
  const routedChallengerWithMain = routedAgentsWithMain.routing.find((routing) => routing.profile === "challenger");
  assert.equal(routedAgentsWithMain.flags.mainProvider, "openai-api");
  assert.deepEqual(routedAgentsWithMain.flags.excludeProviderNames, ["openai-api"]);
  assert.equal(routedChallengerWithMain.auto.status, "ready");
  assert.equal(routedChallengerWithMain.auto.selected, "claude-cli");
  assert.ok(
    routedChallengerWithMain.candidates.some(
      (provider) => provider.name === "openai-api" && provider.available && provider.excluded,
    ),
  );
} finally {
  if (previousPathForAgentRouting === undefined) delete process.env.PATH;
  else process.env.PATH = previousPathForAgentRouting;
}
const badAgentRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-bad-agents-"));
await mkdir(path.join(badAgentRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(badAgentRoot, ".odai", "agents.json"),
  `${JSON.stringify({ agents: [{ name: "bad_agent", tools: "write" }] })}\n`,
  "utf8",
);
const badAgents = loadWorkspaceAgentProfiles({ workspaceRoot: badAgentRoot });
assert.equal(badAgents.get("reviewer").tools, "read_only");
assert.equal(badAgents.has("bad_agent"), false);
assert.ok(badAgents.configErrors.some((error) => /unsupported tools/.test(error.message)));
const badAgentDescription = describeWorkspaceAgentProfiles({ workspaceRoot: badAgentRoot });
assert.ok(badAgentDescription.profiles.some((profile) => profile.name === "reviewer"));
assert.ok(badAgentDescription.configErrors.some((error) => /unsupported tools/.test(error.message)));
const badRunAgentsDescription = runAgents({ repoRoot: badAgentRoot });
assert.ok(badRunAgentsDescription.profiles.some((profile) => profile.name === "reviewer"));
assert.ok(badRunAgentsDescription.configErrors.some((error) => /unsupported tools/.test(error.message)));
const invalidAgentRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-invalid-agents-"));
await mkdir(path.join(invalidAgentRoot, ".odai"), { recursive: true });
await writeFile(path.join(invalidAgentRoot, ".odai", "agents.json"), "{ invalid json\n", "utf8");
const invalidAgentDescription = describeWorkspaceAgentProfiles({ workspaceRoot: invalidAgentRoot });
assert.ok(invalidAgentDescription.profiles.some((profile) => profile.name === "reviewer"));
assert.ok(
  invalidAgentDescription.configErrors.some((error) => /Failed to read agent config/.test(error.message)),
);
const sensitiveAgentRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-sensitive-agents-"));
await mkdir(path.join(sensitiveAgentRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(sensitiveAgentRoot, ".odai", "agents.json"),
  `${JSON.stringify({
    agents: {
      sensitive_reviewer: {
        purpose: "token=agent-purpose-secret",
        tools: "read_only",
      },
      "token=agent-name-secret": {
        tools: "read_only",
      },
    },
  })}\n`,
  "utf8",
);
const sensitiveAgentDescription = describeWorkspaceAgentProfiles({ workspaceRoot: sensitiveAgentRoot });
const sensitiveAgentJson = JSON.stringify(sensitiveAgentDescription);
assert.ok(!sensitiveAgentJson.includes("agent-purpose-secret"));
assert.ok(!sensitiveAgentJson.includes("agent-name-secret"));
assert.ok(sensitiveAgentJson.includes("[redacted]"));

const commandProviderRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-command-provider-"));
await mkdir(path.join(commandProviderRoot, ".odai"), { recursive: true });
await symlinkOrCopyDirectory(path.join(repoRoot, "skills"), path.join(commandProviderRoot, "skills"));
const commandProviderFile = path.join(commandProviderRoot, "command-provider-input.txt");
await writeFile(commandProviderFile, "command-provider-before\n", "utf8");
const commandProviderScript = path.join(sessionTmp, "command-json-provider.mjs");
await writeFile(
  commandProviderScript,
  [
    'import { readFileSync } from "node:fs";',
    'const prompt = readFileSync(0, "utf8");',
    'const marker = "Otherwise return ordinary reviewable text.\\n\\n";',
    'const input = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));',
    'const modelIndex = process.argv.indexOf("--model");',
    "const cliModel = modelIndex >= 0 ? process.argv[modelIndex + 1] : '';",
    "const previousToolResults = Array.isArray(input.previousToolResults) ? input.previousToolResults : [];",
    "const toolIntents = input.mode === 'provider_probe' || previousToolResults.length > 0 ? [] : [{ type: 'read', path: input.files[0] }];",
    "const baseText = input.mode === 'provider_probe' && input.task === 'secret probe' ? 'doctor api_key=doctor-probe-secret' : (input.mode === 'provider_probe' ? 'command provider probe ok' : 'command provider turn ok');",
    "const text = cliModel ? `${baseText} model ${cliModel}` : baseText;",
    "console.log(JSON.stringify({",
    "  text,",
    "  providerSession: { sessionId: 'command-json-session-1' },",
    "  toolIntents,",
    "}));",
  ].join("\n"),
  "utf8",
);
const commandProviderReviewerScript = path.join(sessionTmp, "command-json-provider-reviewer.mjs");
await writeFile(
  commandProviderReviewerScript,
  [
    'import { readFileSync } from "node:fs";',
    'const prompt = readFileSync(0, "utf8");',
    'const marker = "Otherwise return ordinary reviewable text.\\n\\n";',
    'JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));',
    "console.log(JSON.stringify({",
    "  text: 'command reviewer provider ok',",
    "  findings: [{ summary: 'reviewed by alternate command provider' }],",
    "  providerSession: { sessionId: 'command-json-reviewer-session-1' },",
    "}));",
  ].join("\n"),
  "utf8",
);
const failingCommandProviderScript = path.join(sessionTmp, "command-json-provider-fails.mjs");
await writeFile(
  failingCommandProviderScript,
  [
    "console.error('provider failed api_key=provider-error-secret Bearer provider-error-bearer-secret token=provider-error-token-secret');",
    "process.exit(1);",
    "",
  ].join("\n"),
  "utf8",
);
await writeFile(
  path.join(commandProviderRoot, ".odai", "providers.json"),
  `${JSON.stringify(
    {
      providers: [
        {
          type: "openai-compatible",
          name: "test-compatible",
          baseUrl: "https://models.example.test/v1",
          apiKeyEnv: "TEST_COMPATIBLE_API_KEY",
          capabilities: ["reasoning", "code"],
        },
        {
          type: "openai-compatible",
          name: "direct-compatible",
          baseUrl: "https://direct-models.example.test",
          apiKeyEnv: "sk-directcompatibletest1234567890abcdef",
          capabilities: ["reasoning", "code"],
        },
        {
          type: "command-json",
          name: "node-json-e2e",
          command: "node",
          args: [commandProviderScript],
          modelArgs: ["--model", "{model}"],
          capabilities: ["reasoning", "code"],
        },
        {
          type: "command-json",
          name: "node-json-reviewer",
          command: "node",
          args: [commandProviderReviewerScript],
          capabilities: ["reasoning", "code"],
        },
        {
          type: "command-json",
          name: "node-json-fails",
          command: "node",
          args: [failingCommandProviderScript],
          capabilities: ["reasoning"],
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const authStatusBeforeMigration = await runAuthConfig({ repoRoot: commandProviderRoot, argv: ["status"], env: {} });
const deepseekStatusBeforeAuth = authStatusBeforeMigration.providers.find((provider) => provider.name === "deepseek-api");
assert.equal(deepseekStatusBeforeAuth.type, "built-in");
assert.equal(deepseekStatusBeforeAuth.apiKeyEnv, "DEEPSEEK_API_KEY");
assert.equal(deepseekStatusBeforeAuth.modelEnv, "ODAI_DEEPSEEK_MODEL");
assert.equal(deepseekStatusBeforeAuth.secretPresent, false);
const fakeAuthClaudeDir = await mkdtemp(path.join(tmpdir(), "odai-cli-auth-claude-"));
const fakeAuthClaudePath = path.join(fakeAuthClaudeDir, process.platform === "win32" ? "claude.cmd" : "claude");
await writeFile(
  fakeAuthClaudePath,
  process.platform === "win32" ? "@echo off\r\necho fake claude auth\r\n" : "#!/bin/sh\nprintf 'fake claude auth\\n'\n",
  "utf8",
);
await chmod(fakeAuthClaudePath, 0o755);
const commandAuthStatus = await runAuthConfig({
  repoRoot: commandProviderRoot,
  argv: ["status"],
  env: { ODAI_CLAUDE_COMMAND: fakeAuthClaudePath, ODAI_CLAUDE_MODEL: "claude-auth-model" },
});
const claudeCommandAuth = commandAuthStatus.commands.find((provider) => provider.name === "claude-cli");
assert.equal(normalizePathForCompare(claudeCommandAuth.command), normalizePathForCompare(fakeAuthClaudePath));
assert.equal(claudeCommandAuth.commandPresent, true);
assert.equal(claudeCommandAuth.executableEnv, "ODAI_CLAUDE_COMMAND");
assert.equal(claudeCommandAuth.executableConfigured, true);
assert.equal(claudeCommandAuth.modelPresent, true);
assert.match(claudeCommandAuth.next, /\/login/);
assert.equal(
  claudeCommandAuth.probe,
  "odai doctor --provider claude-cli --use-provider-command --model <model> --save",
);
const claudeLoginDryRun = await runAuthConfig({
  repoRoot: commandProviderRoot,
  argv: ["login", "claude-cli", "--dry-run"],
  env: { ODAI_CLAUDE_COMMAND: fakeAuthClaudePath },
});
assert.equal(claudeLoginDryRun.status, "ready");
assert.equal(claudeLoginDryRun.kind, "auth-login");
assert.equal(claudeLoginDryRun.provider, "claude-cli");
assert.equal(claudeLoginDryRun.dryRun, true);
assert.equal(normalizePathForCompare(claudeLoginDryRun.command), normalizePathForCompare(fakeAuthClaudePath));
assert.deepEqual(claudeLoginDryRun.args, []);
assert.equal(claudeLoginDryRun.cwdPolicy, "temporary-empty-directory");
assert.equal(claudeLoginDryRun.interactive, true);
assert.ok(claudeLoginDryRun.note.includes("/login"));
assert.ok(claudeLoginDryRun.next.some((entry) => entry.includes("doctor --provider claude-cli")));
const claudeLoginNoTty = await runAuthConfig({
  repoRoot: commandProviderRoot,
  argv: ["login", "claude-cli"],
  env: { ODAI_CLAUDE_COMMAND: fakeAuthClaudePath },
  inputIsTTY: false,
});
assert.equal(claudeLoginNoTty.status, "blocked");
assert.equal(normalizePathForCompare(claudeLoginNoTty.command), normalizePathForCompare(fakeAuthClaudePath));
assert.match(claudeLoginNoTty.reason, /requires a TTY/);
const codexLoginBlocked = await runAuthConfig({
  repoRoot: commandProviderRoot,
  argv: ["login", "codex-cli", "--dry-run"],
  env: {},
});
assert.equal(codexLoginBlocked.status, "blocked");
assert.match(codexLoginBlocked.reason, /Only claude-cli login/);
const deepseekAuthConfig = await runAuthConfig({
  repoRoot: commandProviderRoot,
  argv: ["provider", "deepseek-api", "--api-key", "sk-deepseektest1234567890abcdef"],
  env: {},
});
assert.equal(deepseekAuthConfig.status, "ready");
assert.equal(deepseekAuthConfig.provider, "deepseek-api");
assert.equal(deepseekAuthConfig.apiKeyEnv, "DEEPSEEK_API_KEY");
const deepseekStatusAfterAuth = await runAuthConfig({ repoRoot: commandProviderRoot, argv: ["status"], env: {} });
assert.equal(
  deepseekStatusAfterAuth.providers.find((provider) => provider.name === "deepseek-api").secretPresent,
  true,
);
const directStatusBeforeMigration = authStatusBeforeMigration.providers.find(
  (provider) => provider.name === "direct-compatible",
);
assert.equal(directStatusBeforeMigration.directSecretInConfig, true);
const authMigration = await runAuthConfig({ repoRoot: commandProviderRoot, argv: ["migrate"], env: {} });
assert.equal(authMigration.status, "ready");
assert.deepEqual(authMigration.migrated, [
  { provider: "direct-compatible", apiKeyEnv: "ODAI_PROVIDER_DIRECT_COMPATIBLE_API_KEY" },
]);
const migratedProviderConfig = JSON.parse(await readFile(path.join(commandProviderRoot, ".odai", "providers.json"), "utf8"));
const migratedDirectProvider = migratedProviderConfig.providers.find((provider) => provider.name === "direct-compatible");
assert.equal(migratedDirectProvider.apiKeyEnv, "ODAI_PROVIDER_DIRECT_COMPATIBLE_API_KEY");
assert.equal(migratedDirectProvider.apiKey, undefined);
assert.ok(
  (await readFile(path.join(commandProviderRoot, ".odai", "secrets.env"), "utf8")).includes(
    "ODAI_PROVIDER_DIRECT_COMPATIBLE_API_KEY=",
  ),
);
const managedSecretModelCatalog = await runModels({
  repoRoot: commandProviderRoot,
  env: {},
  argv: ["--provider", "direct-compatible"],
  fetchImpl: async (url, request = {}) => {
    assert.equal(request.headers.authorization, "Bearer sk-directcompatibletest1234567890abcdef");
    if (url === "https://direct-models.example.test/models") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [] };
        },
      };
    }
    assert.equal(url, "https://direct-models.example.test/v1/models");
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: "managed-secret-live-model" }] };
      },
    };
  },
});
assert.equal(managedSecretModelCatalog.flags.useApiKey, false);
assert.ok(managedSecretModelCatalog.models.some((model) => model.label === "direct-compatible:managed-secret-live-model"));
const deepseekManagedSecretModelCatalog = await runModels({
  repoRoot: commandProviderRoot,
  env: {},
  argv: ["--provider", "deepseek-api"],
  fetchImpl: async (url, request = {}) => {
    assert.equal(request.headers.authorization, "Bearer sk-deepseektest1234567890abcdef");
    assert.equal(url, "https://api.deepseek.com/models");
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] };
      },
    };
  },
});
assert.equal(deepseekManagedSecretModelCatalog.flags.useApiKey, false);
assert.ok(deepseekManagedSecretModelCatalog.models.some((model) => model.label === "deepseek-api:deepseek-v4-flash"));
const modelDiscoveryFetchCalls = [];
const modelCatalog = await runModels({
  repoRoot: commandProviderRoot,
  env: {
    OPENAI_API_KEY: "present",
    ODAI_OPENAI_MODEL: "openai-configured-model",
    TEST_COMPATIBLE_API_KEY: "compatible-key",
  },
  argv: ["--use-api-key", "--use-provider-command", "--model", "session-override-model"],
  fetchImpl: async (url, request = {}) => {
    modelDiscoveryFetchCalls.push({ url, request });
    if (url === "https://api.openai.com/v1/models") {
      assert.equal(request.headers.authorization, "Bearer present");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "openai-live-model" }] };
        },
      };
    }
    if (url === "https://models.example.test/v1/models") {
      assert.equal(request.headers.authorization, "Bearer compatible-key");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "compatible-live-model" }, { id: "compatible-other-model" }] };
        },
      };
    }
    if (url === "https://direct-models.example.test/models") {
      assert.equal(request.headers.authorization, "Bearer sk-directcompatibletest1234567890abcdef");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [] };
        },
      };
    }
    if (url === "https://direct-models.example.test/v1/models") {
      assert.equal(request.headers.authorization, "Bearer sk-directcompatibletest1234567890abcdef");
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "direct-compatible-live-model" }] };
        },
      };
    }
    if (url === "http://localhost:11434/api/tags") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: [{ name: "ollama-live-model" }] };
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async json() {
        return {};
      },
    };
  },
  runCommand: (command, args) => {
    assert.equal(command, "grok");
    assert.deepEqual(args, ["models"]);
    return { status: 0, stdout: "grok-live-model\n" };
  },
});
assert.equal(modelCatalog.kind, "model-catalog");
assert.equal(modelCatalog.flags.useApiKey, true);
assert.equal(modelCatalog.flags.useProviderCommand, true);
assert.equal(modelCatalog.flags.model, "session-override-model");
assert.ok(modelDiscoveryFetchCalls.some((call) => call.url === "https://api.openai.com/v1/models"));
const openaiCatalogEntry = modelCatalog.providers.find((provider) => provider.name === "openai-api");
assert.equal(openaiCatalogEntry.configuredModel, "openai-configured-model");
assert.equal(openaiCatalogEntry.configuredModelSource, "env");
assert.equal(openaiCatalogEntry.effectiveModel, "session-override-model");
assert.equal(openaiCatalogEntry.available, true);
assert.ok(modelCatalog.models.some((model) => model.label === "openai-api:openai-live-model"));
assert.ok(modelCatalog.models.some((model) => model.label === "test-compatible:compatible-live-model"));
assert.ok(modelCatalog.models.some((model) => model.label === "direct-compatible:direct-compatible-live-model"));
assert.ok(modelCatalog.models.some((model) => model.label === "ollama-local:ollama-live-model"));
const codexCliModelCatalog = await runModels({
  repoRoot: commandProviderRoot,
  env: { ODAI_CODEX_COMMAND: process.execPath },
  argv: ["--provider", "codex-cli", "--use-provider-command"],
  runCommand: (command, args) => {
    assert.equal(normalizePathForCompare(command), normalizePathForCompare(process.execPath));
    assert.deepEqual(args, ["doctor", "--json"]);
    return {
      status: 1,
      stdout: [
        "WARNING: local doctor warning",
        JSON.stringify({
          checks: {
            "config.load": {
              details: {
                model: "codex-doctor-model",
              },
            },
          },
        }),
      ].join("\n"),
      stderr: "network warning",
    };
  },
});
assert.ok(codexCliModelCatalog.models.some((model) => model.label === "codex-cli:codex-doctor-model"));
assert.equal(codexCliModelCatalog.providers.find((provider) => provider.name === "codex-cli").modelDiscovery.status, "ready");
const claudeCliModelCatalog = await runModels({
  repoRoot: commandProviderRoot,
  env: { ODAI_CLAUDE_COMMAND: process.execPath, ODAI_CLAUDE_MODEL: "claude-configured-model" },
  argv: ["--provider", "claude-cli", "--use-provider-command"],
});
assert.ok(claudeCliModelCatalog.models.some((model) => model.label === "claude-cli:claude-configured-model"));
const directCatalogEntry = modelCatalog.providers.find((provider) => provider.name === "direct-compatible");
assert.equal(directCatalogEntry.auth, "api_key");
assert.equal(directCatalogEntry.source.apiKeyPresent, true);
const commandCatalogEntry = modelCatalog.providers.find((provider) => provider.name === "node-json-e2e");
assert.deepEqual(commandCatalogEntry.modelArgs, ["--model", "{model}"]);
assert.equal(commandCatalogEntry.configuredModelSource, "runtime-override");
assert.equal(commandCatalogEntry.effectiveModel, "session-override-model");
assert.equal(commandCatalogEntry.available, true);
assert.equal(commandCatalogEntry.modelDiscovery.status, "blocked");
assert.equal(commandCatalogEntry.modelDiscovery.reason, "model_discovery_not_supported");
const blockedModelsText = formatModelsList({
  status: "ready",
  models: [],
  discovery: [
    {
      provider: "blocked-sub",
      status: "blocked",
      source: "openai-compatible",
      reason: "fetch failed: ECONNRESET",
    },
  ],
});
assert.match(blockedModelsText, /blocked providers: 1/);
assert.match(blockedModelsText, /blocked-sub: fetch failed: ECONNRESET/);
const modelCompletion = completeInteractiveLine({
  line: "/model test-compatible:c",
  repoRoot: commandProviderRoot,
  env: {},
  language: "en",
});
assert.deepEqual(modelCompletion[0], []);
assert.equal(modelCompletion[1], "test-compatible:c");
const slashModelCompletions = describeInteractiveCompletions({
  line: "/mo",
  repoRoot: commandProviderRoot,
  env: {},
  language: "en",
});
assert.ok(slashModelCompletions.some((entry) => entry.value === "/model" && /Switch the active model/.test(entry.description)));
const slashModelCompletionsZh = describeInteractiveCompletions({
  line: "/mo",
  repoRoot: commandProviderRoot,
  env: {},
  language: "zh",
});
assert.ok(slashModelCompletionsZh.some((entry) => entry.value === "/model" && /切换当前模型/.test(entry.description)));
assert.deepEqual(
  completeInteractiveLine({
    line: "/mo",
    repoRoot: commandProviderRoot,
    env: {},
    language: "en",
  })[0],
  ["/model", "/models"],
);

const transcript = await createWorkspaceTranscript({ workspaceRoot: sessionTmp, sessionId: "test/session" });
await transcript.append({ type: "session-start" });
await transcript.append({ type: "progress", event: { type: "provider-text", text: "hello" } });
await transcript.append({
  type: "task-submit",
  argv: ["resume me", "--use-api-key", "--use-provider-command", "--allow-shell", "--allow-network", "--agent-loop"],
});
await transcript.append({
  type: "task-result",
  result: {
    status: "ready",
    task: "resume me",
    provider: "mock-main",
    providerSessions: [{ provider: "mock-main", sessionId: "mock-session-1" }],
  },
});
await transcript.flush();
const transcriptLines = (await readFile(transcript.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
assert.equal(transcriptLines[0].sessionId, "test/session");
assert.equal(transcriptLines[1].event.type, "provider-text");
const transcriptLatest = JSON.parse(
  await readFile(path.join(sessionTmp, ".odai", "sessions", "latest.json"), "utf8"),
);
assert.equal(transcriptLatest.sessionId, "test/session");
assert.equal(transcriptLatest.transcriptPath, transcript.path);
const transcriptTail = await runSessions({ repoRoot: sessionTmp, argv: ["--tail", "1"] });
assert.equal(transcriptTail.status, "ready");
assert.equal(transcriptTail.count, 4);
assert.equal(transcriptTail.entries.length, 1);
assert.equal(transcriptTail.entries[0].type, "task-result");
const transcriptContext = await runSessions({ repoRoot: sessionTmp, argv: ["--tail", "2", "--context"] });
assert.equal(transcriptContext.context.sourceSessionId, "test/session");
assert.deepEqual(transcriptContext.context.lastTaskArgv, ["resume me", "--agent-loop"]);
assert.deepEqual(transcriptContext.context.providerSessions, [{ provider: "mock-main", sessionId: "mock-session-1" }]);
assert.ok(transcriptContext.context.notRestored.includes("api-key-confirmation"));
assert.ok(transcriptContext.context.notRestored.includes("network-execution-confirmation"));
const compactTranscriptContext = await runSessions({ repoRoot: sessionTmp, argv: ["--tail", "3", "--compact"] });
assert.equal(compactTranscriptContext.status, "ready");
assert.equal(compactTranscriptContext.context.kind, "session-compact-context");
assert.equal(compactTranscriptContext.context.sourceSessionId, "test/session");
assert.deepEqual(compactTranscriptContext.context.lastTaskArgv, ["resume me", "--agent-loop"]);
assert.deepEqual(compactTranscriptContext.context.recentTasks, [["resume me", "--agent-loop"]]);
assert.deepEqual(compactTranscriptContext.context.providerSessions, [
  { provider: "mock-main", sessionId: "mock-session-1" },
]);
assert.ok(compactTranscriptContext.context.notRestored.includes("shell-execution-confirmation"));
assert.ok(!JSON.stringify(compactTranscriptContext.context).includes("--use-api-key"));
assert.ok(!JSON.stringify(compactTranscriptContext.context).includes("--allow-network"));
const compactTranscriptFile = JSON.parse(await readFile(compactTranscriptContext.contextPath, "utf8"));
assert.equal(compactTranscriptFile.kind, "session-compact-context");
assert.deepEqual(compactTranscriptFile.lastTaskArgv, ["resume me", "--agent-loop"]);
assert.deepEqual(compactTranscriptFile.providerSessions, [{ provider: "mock-main", sessionId: "mock-session-1" }]);
const compactTranscriptLatest = JSON.parse(
  await readFile(path.join(sessionTmp, ".odai", "sessions", "latest.context.json"), "utf8"),
);
assert.equal(compactTranscriptLatest.sessionId, "test/session");
assert.equal(compactTranscriptLatest.contextPath, compactTranscriptContext.contextPath);
const emptyResumeTranscript = await createWorkspaceTranscript({ workspaceRoot: sessionTmp, sessionId: "empty-resume" });
await emptyResumeTranscript.append({ type: "session-start" });
await emptyResumeTranscript.append({ type: "session-resume", context: transcriptContext.context });
await emptyResumeTranscript.append({ type: "session-end", reason: "eof" });
await emptyResumeTranscript.flush();
const inheritedContext = await runSessions({ repoRoot: sessionTmp, argv: ["--context"] });
assert.equal(inheritedContext.context.sourceSessionId, "test/session");
assert.equal(inheritedContext.context.currentSessionId, "empty-resume");
assert.equal(inheritedContext.context.inheritedFromSessionId, "test/session");
assert.deepEqual(inheritedContext.context.providerSessions, [{ provider: "mock-main", sessionId: "mock-session-1" }]);
assert.deepEqual(inheritedContext.context.lastTaskArgv, ["resume me", "--agent-loop"]);

const sensitiveTranscript = await createWorkspaceTranscript({
  workspaceRoot: sessionTmp,
  sessionId: "sensitive-transcript",
});
const sensitiveTranscriptIntent = JSON.stringify({
  type: "network",
  url: "https://example.com/api?token=transcript-token-secret&ok=1",
});
await sensitiveTranscript.append({
  type: "session-start",
  initialTaskArgv: [
    "sensitive transcript",
    "--content",
    "transcript-content-secret",
    "--tool-intent-json",
    sensitiveTranscriptIntent,
  ],
});
await sensitiveTranscript.append({
  type: "input",
  line: `/run sensitive transcript --content transcript-content-secret --tool-intent-json ${sensitiveTranscriptIntent}`,
});
const sensitiveTranscriptProgressPath = path.join(sessionTmp, "progress-transcript.txt");
await sensitiveTranscript.append({
  type: "progress",
  event: {
    type: "provider-text",
    provider: "mock-main",
    text: "progress api_key=transcript-progress-secret",
  },
});
await sensitiveTranscript.append({
  type: "progress",
  event: {
    type: "tool-result",
    result: {
      ok: true,
      type: "read",
      path: sensitiveTranscriptProgressPath,
      content: "raw content should not persist",
    },
  },
});
await sensitiveTranscript.append({
  type: "task-submit",
  argv: [
    "sensitive transcript",
    "--content",
    "transcript-content-secret",
    "--tool-intent-json",
    sensitiveTranscriptIntent,
    "--allow-network",
    "--agent-loop",
  ],
});
await sensitiveTranscript.append({
  type: "task-result",
  result: {
    status: "ready",
    task: "sensitive transcript api_key=transcript-task-secret",
    provider: "mock-main",
    savedRecordPath: "/tmp/odai-run-record-path-secret.json",
    recordPath: "/tmp/odai-run-record-path-secret-local.json",
    providerSessions: [
      { provider: "mock-main", responseId: "resp-token=transcript-provider-session-secret" },
      { secret: "invalid-provider-session-secret" },
    ],
  },
});
await sensitiveTranscript.append({
  type: "session-resume",
  context: {
    status: "ready",
    sourceSessionId: "source-sensitive",
    sourceTranscriptPath: "/tmp/source-transcript-path-secret.jsonl",
    currentTranscriptPath: "/tmp/current-transcript-path-secret.jsonl",
    authorizations: { approvedScopes: ["risk:credential"] },
    lastTaskArgv: ["previous sensitive", "--content", "previous-content-secret"],
    lastResult: {
      status: "ready",
      task: "previous sensitive token=previous-task-secret",
      savedRecordPath: "/tmp/previous-run-record-secret.json",
      providerSessions: [{ provider: "mock-main", responseId: "resp-token=previous-session-secret" }],
    },
    providerSessions: [{ provider: "mock-main", responseId: "resp-token=resume-context-session-secret" }],
  },
});
await sensitiveTranscript.append({ type: "authorization-prompt", scope: "risk:credential", answered: true });
await sensitiveTranscript.append({ type: "authorization-result", scope: "risk:credential", approved: true });
await sensitiveTranscript.append({
  type: "command-result",
  command: "authorize",
  result: {
    ok: true,
    scope: "risk:credential",
    authorizations: ["risk:credential"],
  },
});
await sensitiveTranscript.append({
  type: "command-result",
  command: "context",
  result: {
    status: "ready",
    sessionId: "sensitive-context-session",
    transcriptPath: "/tmp/context-transcript-path-secret.jsonl",
    contextPath: "/tmp/context-artifact-path-secret.json",
    count: 9,
    entries: [
      {
        type: "command-result",
        command: "authorize",
        result: { ok: true, scope: "risk:credential" },
      },
    ],
    context: {
      status: "ready",
      kind: "session-compact-context",
      sourceSessionId: "sensitive-context-source",
      sourceTranscriptPath: "/tmp/context-source-transcript-secret.jsonl",
      currentTranscriptPath: "/tmp/context-current-transcript-secret.jsonl",
      lastTaskArgv: ["context task", "--content", "context-content-secret"],
      lastResult: {
        status: "ready",
        task: "context task",
        savedRecordPath: "/tmp/context-run-record-secret.json",
        requiredAuthorizations: ["risk:credential"],
        providerSessions: [{ provider: "mock-main", responseId: "resp-token=context-session-secret" }],
      },
      providerSessions: [{ provider: "mock-main", responseId: "resp-token=context-provider-session-secret" }],
      authorizations: { approvedScopes: ["risk:credential"] },
      recent: [{ type: "authorization-result", scope: "risk:credential", approved: true }],
    },
  },
});
await sensitiveTranscript.append({
  type: "command-result",
  command: "policy",
  result: {
    shell: {
      allowExecution: true,
      allowedCommands: ["node --token=policy-command-secret"],
      sandbox: { mode: "none" },
    },
    network: {
      allowRequests: true,
      allowedHosts: ["policy-host-secret.internal"],
      timeoutMs: 10000,
    },
    configErrors: [{ file: "/tmp/policy-config-path-secret.json", message: "token=policy-config-secret" }],
  },
});
await sensitiveTranscript.append({
  type: "command-result",
  command: "providers",
  result: {
    providers: [
      {
        name: "sensitive-provider",
        kind: "api",
        auth: "api_key",
        available: true,
        source: {
          type: "openai-compatible",
          baseUrl: "https://example.com/v1?token=provider-url-secret",
          command: "model-cli --token=provider-command-secret",
        },
      },
    ],
    configErrors: [{ file: "/tmp/provider-config-path-secret.json", message: "token=provider-config-secret" }],
  },
});
await sensitiveTranscript.append({
  type: "command-result",
  command: "agents",
  result: {
    profiles: [
      {
        name: "reviewer",
        purpose: "secret=agent-purpose-secret",
        tools: "read_only",
        providerRequirements: ["code"],
        allowedOutputs: ["findings"],
        source: "workspace",
      },
    ],
    configErrors: [{ file: "/tmp/agent-config-path-secret.json", message: "token=agent-config-secret" }],
  },
});
await sensitiveTranscript.append({
  type: "command-result",
  command: "init",
  result: {
    status: "ready",
    created: ["/tmp/init-created-path-secret.json"],
    skipped: ["/tmp/init-skipped-path-secret.json"],
    overwritten: ["/tmp/init-overwritten-path-secret.json"],
  },
});
await sensitiveTranscript.append({
  type: "command-result",
  command: "evidence",
  result: {
    status: "partial",
    kind: "external-evidence",
    workspaceRoot: "/tmp/evidence-workspace-path-secret",
    recordsDirectory: "/tmp/evidence-runs-path-secret",
    summary: {
      recordsScanned: 1,
      parseErrors: 0,
      ready: 0,
      blocked: 2,
      apiProviders: 0,
      claudeRuntimeProviders: 0,
      subscriptionRuntimeProviders: 0,
      strongSandboxSmokes: 0,
    },
    providerEvidence: {
      apiProviders: [
        {
          sourcePath: "/tmp/evidence-provider-path-secret.json",
          provider: {
            name: "source-chat",
            source: { baseUrl: "https://example.com/v1?token=evidence-provider-token-secret" },
          },
        },
      ],
    },
    note: "evidence token=evidence-note-secret",
  },
});
await sensitiveTranscript.append({
  type: "command-result",
  command: "audit",
  result: {
    status: "partial",
    kind: "completion-audit",
    objective: "audit objective /tmp/audit-objective-path-secret token=audit-objective-secret",
    complete: false,
    summary: { ready: 1, blocked: 4, total: 5 },
    requirements: [
      {
        id: "secret-audit-requirement",
        remaining: ["Run odai doctor with token=audit-requirement-secret"],
      },
    ],
    blockers: [{ id: "A02", remaining: ["/tmp/audit-blocker-path-secret"] }],
    next: ["odai doctor --all --use-provider-command --save token=audit-next-secret"],
    note: "audit token=audit-note-secret",
  },
});
await sensitiveTranscript.flush();
const sensitiveTranscriptText = await readFile(sensitiveTranscript.path, "utf8");
assert.ok(!sensitiveTranscriptText.includes("transcript-token-secret"));
assert.ok(!sensitiveTranscriptText.includes("transcript-content-secret"));
assert.ok(!sensitiveTranscriptText.includes("transcript-progress-secret"));
assert.ok(!sensitiveTranscriptText.includes(sensitiveTranscriptProgressPath));
assert.ok(sensitiveTranscriptText.includes("progress-transcript.txt"));
assert.ok(!sensitiveTranscriptText.includes("raw content should not persist"));
assert.ok(!sensitiveTranscriptText.includes("odai-run-record-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("source-transcript-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("current-transcript-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("previous-run-record-secret"));
assert.ok(!sensitiveTranscriptText.includes("previous-content-secret"));
assert.ok(!sensitiveTranscriptText.includes("transcript-task-secret"));
assert.ok(!sensitiveTranscriptText.includes("previous-task-secret"));
assert.ok(!sensitiveTranscriptText.includes("transcript-provider-session-secret"));
assert.ok(!sensitiveTranscriptText.includes("invalid-provider-session-secret"));
assert.ok(!sensitiveTranscriptText.includes("resume-context-session-secret"));
assert.ok(!sensitiveTranscriptText.includes("previous-session-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-transcript-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-artifact-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-source-transcript-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-current-transcript-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-content-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-run-record-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-session-secret"));
assert.ok(!sensitiveTranscriptText.includes("context-provider-session-secret"));
assert.ok(!sensitiveTranscriptText.includes("policy-command-secret"));
assert.ok(!sensitiveTranscriptText.includes("policy-host-secret"));
assert.ok(!sensitiveTranscriptText.includes("policy-config-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("policy-config-secret"));
assert.ok(!sensitiveTranscriptText.includes("provider-url-secret"));
assert.ok(!sensitiveTranscriptText.includes("provider-command-secret"));
assert.ok(!sensitiveTranscriptText.includes("provider-config-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("provider-config-secret"));
assert.ok(!sensitiveTranscriptText.includes("agent-purpose-secret"));
assert.ok(!sensitiveTranscriptText.includes("agent-config-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("agent-config-secret"));
assert.ok(!sensitiveTranscriptText.includes("init-created-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("init-skipped-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("init-overwritten-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("evidence-workspace-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("evidence-runs-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("evidence-provider-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("evidence-provider-token-secret"));
assert.ok(!sensitiveTranscriptText.includes("evidence-note-secret"));
assert.ok(!sensitiveTranscriptText.includes("audit-objective-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("audit-objective-secret"));
assert.ok(!sensitiveTranscriptText.includes("audit-requirement-secret"));
assert.ok(!sensitiveTranscriptText.includes("audit-blocker-path-secret"));
assert.ok(!sensitiveTranscriptText.includes("audit-next-secret"));
assert.ok(!sensitiveTranscriptText.includes("audit-note-secret"));
assert.ok(!sensitiveTranscriptText.includes("risk:credential"));
assert.ok(!sensitiveTranscriptText.includes("--tool-intent-json"));
assert.ok(!sensitiveTranscriptText.includes("--content"));
const sensitiveTranscriptContext = await runSessions({ repoRoot: sessionTmp, argv: ["--context"] });
assert.deepEqual(sensitiveTranscriptContext.context.lastTaskArgv, ["sensitive transcript", "--agent-loop"]);
assert.equal(sensitiveTranscriptContext.context.sourceTranscriptPath, undefined);
assert.equal(sensitiveTranscriptContext.context.currentTranscriptPath, undefined);
assert.equal(sensitiveTranscriptContext.context.lastResult.savedRecordPath, undefined);
assert.equal(sensitiveTranscriptContext.context.lastResult.recordPath, undefined);
assert.ok(!JSON.stringify(sensitiveTranscriptContext.context).includes("transcript-provider-session-secret"));
assert.ok(!JSON.stringify(sensitiveTranscriptContext.context).includes("risk:credential"));
const sensitiveCompactContext = await runSessions({ repoRoot: sessionTmp, argv: ["--compact"] });
assert.equal(sensitiveCompactContext.context.authorizations.approvedCount, 2);
assert.equal(sensitiveCompactContext.context.authorizations.deniedCount, 0);
assert.equal(sensitiveCompactContext.context.authorizations.restoredOnResume, false);
assert.equal(sensitiveCompactContext.context.authorizations.approvedScopes, undefined);
assert.ok(!JSON.stringify(sensitiveCompactContext.context).includes("risk:credential"));

await mkdir(path.join(policyRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(policyRoot, ".odai", "policy.json"),
  JSON.stringify({
    shell: {
      allowExecution: true,
      allowedCommands: ["node"],
      sandbox: { mode: "macos-sandbox-exec" },
    },
    network: {
      allowRequests: true,
      allowedHosts: ["example.com", "*.example.test"],
      timeoutMs: 1234,
    },
  }),
  "utf8",
);
const loadedPolicy = loadWorkspacePolicyConfig({ workspaceRoot: policyRoot });
assert.equal(loadedPolicy.shell.allowExecution, true);
assert.deepEqual(loadedPolicy.shell.allowedCommands, ["node"]);
assert.deepEqual(loadedPolicy.shell.sandbox, { mode: "macos-sandbox-exec" });
assert.deepEqual(loadedPolicy.network, {
  allowRequests: true,
  allowedHosts: ["example.com", "*.example.test"],
  timeoutMs: 1234,
});
const dockerPolicyRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-docker-policy-"));
await mkdir(path.join(dockerPolicyRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(dockerPolicyRoot, ".odai", "policy.json"),
  JSON.stringify({
    shell: {
      allowExecution: true,
      allowedCommands: ["node"],
      sandbox: { mode: "docker", image: "node:22-alpine" },
    },
  }),
  "utf8",
);
const dockerPolicy = loadWorkspacePolicyConfig({ workspaceRoot: dockerPolicyRoot });
assert.deepEqual(dockerPolicy.shell.sandbox, {
  mode: "docker",
  image: "node:22-alpine",
  network: "none",
  readOnlyRoot: true,
  workdir: "/workspace",
});
const devcontainerPolicyRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-devcontainer-policy-"));
await mkdir(path.join(devcontainerPolicyRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(devcontainerPolicyRoot, ".odai", "policy.json"),
  JSON.stringify({
    shell: {
      allowExecution: true,
      allowedCommands: ["node"],
      sandbox: { mode: "devcontainer", workspaceFolder: "/workspaces/odai" },
    },
  }),
  "utf8",
);
const devcontainerPolicy = loadWorkspacePolicyConfig({ workspaceRoot: devcontainerPolicyRoot });
assert.deepEqual(devcontainerPolicy.shell.sandbox, {
  mode: "devcontainer",
  command: "devcontainer",
  workspaceFolder: "/workspaces/odai",
});
const defaultSandboxReadiness = runSandboxReadiness({ repoRoot: initRoot });
assert.equal(defaultSandboxReadiness.status, "partial");
assert.equal(defaultSandboxReadiness.kind, "sandbox-readiness");
assert.equal(defaultSandboxReadiness.configured.mode, "none");
assert.equal(defaultSandboxReadiness.configured.status, "not-isolated");
assert.equal(defaultSandboxReadiness.summary.configuredStrong, false);
const defaultSandboxSmoke = await runSandboxSmoke({ repoRoot: initRoot });
assert.equal(defaultSandboxSmoke.status, "blocked");
assert.equal(defaultSandboxSmoke.kind, "sandbox-smoke");
assert.match(defaultSandboxSmoke.reason, /explicit --allow-shell/);
const policyBlockedSandboxSmoke = await runSandboxSmoke({ repoRoot: initRoot, argv: ["--allow-shell"] });
assert.equal(policyBlockedSandboxSmoke.status, "blocked");
assert.match(policyBlockedSandboxSmoke.reason, /disabled by \.odai\/policy\.json/);
const defaultE2EReadiness = runE2EReadiness({ repoRoot: initRoot, env: {} });
assert.equal(defaultE2EReadiness.status, "partial");
assert.equal(defaultE2EReadiness.kind, "e2e-readiness");
assert.equal(defaultE2EReadiness.summary.total, 4);
assert.equal(defaultE2EReadiness.summary.blocked, 4);
assert.equal(defaultE2EReadiness.flags.useApiKey, false);
assert.equal(defaultE2EReadiness.flags.useProviderCommand, false);
assert.equal(defaultE2EReadiness.requirements.find((item) => item.id === "provider-api").status, "blocked");
assert.equal(defaultE2EReadiness.requirements.find((item) => item.id === "strong-sandbox").status, "blocked");
assert.ok(
  defaultE2EReadiness.requirements
    .find((item) => item.id === "provider-runtime")
    .next.some((item) =>
      item.includes("ODAI_CODEX_COMMAND") && item.includes("ODAI_GROK_COMMAND") && item.includes("ODAI_CLAUDE_COMMAND"),
    ),
);
assert.ok(
  defaultE2EReadiness.requirements
    .find((item) => item.id === "provider-subscription-cli")
    .next.some((item) => item.includes("ODAI_CODEX_COMMAND") && item.includes("ODAI_GROK_COMMAND")),
);
const apiE2EReadiness = runE2EReadiness({
  repoRoot: initRoot,
  env: { OPENAI_API_KEY: "test-key", ODAI_OPENAI_MODEL: "test-model" },
  argv: ["--use-api-key"],
});
assert.equal(apiE2EReadiness.flags.useApiKey, true);
assert.equal(apiE2EReadiness.requirements.find((item) => item.id === "provider-api").status, "ready");
assert.equal(apiE2EReadiness.requirements.find((item) => item.id === "strong-sandbox").status, "blocked");
assert.ok(apiE2EReadiness.runnableCommands.includes("odai doctor --provider openai-api --use-api-key --save"));
const apiE2EProviderEvidence = apiE2EReadiness.requirements
  .find((item) => item.id === "provider-api")
  .evidence.find((provider) => provider.name === "openai-api");
assert.equal(apiE2EProviderEvidence.source.apiKeyEnv, "OPENAI_API_KEY");
assert.equal(apiE2EProviderEvidence.source.modelEnv, "ODAI_OPENAI_MODEL");
const apiE2EModelOverrideReadiness = runE2EReadiness({
  repoRoot: initRoot,
  env: { OPENAI_API_KEY: "test-key" },
  argv: ["--use-api-key", "--model", "test-model"],
});
assert.equal(apiE2EModelOverrideReadiness.flags.model, "test-model");
assert.equal(
  apiE2EModelOverrideReadiness.requirements.find((item) => item.id === "provider-api").status,
  "ready",
);
const apiE2EModelOverrideProvider = apiE2EModelOverrideReadiness.requirements
  .find((item) => item.id === "provider-api")
  .evidence.find((provider) => provider.name === "openai-api");
assert.equal(apiE2EModelOverrideProvider.source.modelOverridePresent, true);
assert.ok(
  apiE2EModelOverrideReadiness.runnableCommands.includes(
    "odai doctor --provider openai-api --use-api-key --model test-model --save",
  ),
);
const inlineFlagE2EReadiness = runE2EReadiness({
  repoRoot: initRoot,
  env: { OPENAI_API_KEY: "test-key", ODAI_OPENAI_MODEL: "test-model" },
  argv: ["--use-api-key=true", "--use-provider-command=true"],
});
assert.equal(inlineFlagE2EReadiness.flags.useApiKey, true);
assert.equal(inlineFlagE2EReadiness.flags.useProviderCommand, true);
const e2eSourceRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-e2e-source-"));
await mkdir(path.join(e2eSourceRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(e2eSourceRoot, ".odai", "providers.json"),
  `${JSON.stringify(
    {
      providers: [
        {
          type: "openai-compatible",
          name: "source-chat",
          baseUrl: "https://user:pass@compat.example/v1?token=e2e-source-token",
          model: "compat-model",
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const sourceE2EReadiness = runE2EReadiness({ repoRoot: e2eSourceRoot, env: {} });
const sourceE2EJson = JSON.stringify(sourceE2EReadiness.requirements.find((item) => item.id === "provider-api"));
const sourceE2EProvider = sourceE2EReadiness.requirements
  .find((item) => item.id === "provider-api")
  .evidence.find((provider) => provider.name === "source-chat");
assert.equal(sourceE2EProvider.source.type, "openai-compatible");
assert.equal(sourceE2EProvider.source.configured, true);
assert.ok(!sourceE2EJson.includes("e2e-source-token"));
assert.ok(!sourceE2EJson.includes("user:pass"));
assert.ok(sourceE2EJson.includes("[redacted]"));
const compatModelOverrideRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-compat-model-override-"));
await mkdir(path.join(compatModelOverrideRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(compatModelOverrideRoot, ".odai", "providers.json"),
  `${JSON.stringify(
    {
      providers: [
        {
          type: "openai-compatible",
          name: "compat-model-required",
          baseUrl: "https://compat.example/v1",
          apiKeyEnv: "COMPAT_API_KEY",
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const compatModelOverrideE2E = runE2EReadiness({
  repoRoot: compatModelOverrideRoot,
  env: { COMPAT_API_KEY: "present" },
  argv: ["--use-api-key", "--model", "compat-model"],
});
const compatModelOverrideProvider = compatModelOverrideE2E.requirements
  .find((item) => item.id === "provider-api")
  .evidence.find((provider) => provider.name === "compat-model-required");
assert.equal(compatModelOverrideProvider.source.modelOverridePresent, true);
assert.ok(
  compatModelOverrideE2E.runnableCommands.includes(
    "odai doctor --provider compat-model-required --use-api-key --model compat-model --save",
  ),
);
const fakeRuntimeCodexBinDir = await mkdtemp(path.join(tmpdir(), "odai-cli-fake-runtime-codex-bin-"));
const fakeRuntimeCodexPath = path.join(fakeRuntimeCodexBinDir, process.platform === "win32" ? "codex.cmd" : "codex");
await writeFile(
  fakeRuntimeCodexPath,
  process.platform === "win32" ? "@echo off\r\necho fake codex\r\n" : "#!/bin/sh\nprintf 'fake codex\\n'\n",
  "utf8",
);
await chmod(fakeRuntimeCodexPath, 0o755);
const previousPathForRuntimeCodex = process.env.PATH;
process.env.PATH = `${fakeRuntimeCodexBinDir}${path.delimiter}${previousPathForRuntimeCodex || ""}`;
try {
  const providerEvidenceReadyE2E = runE2EReadiness({
    repoRoot: initRoot,
    env: {
      OPENAI_API_KEY: "test-key",
      ODAI_OPENAI_MODEL: "test-model",
      ODAI_CODEX_COMMAND: fakeRuntimeCodexPath,
    },
    argv: ["--use-api-key", "--use-provider-command"],
  });
  assert.equal(
    providerEvidenceReadyE2E.requirements.find((item) => item.id === "provider-api").status,
    "ready",
  );
  assert.equal(
    providerEvidenceReadyE2E.requirements.find((item) => item.id === "provider-runtime").status,
    "ready",
  );
  assert.equal(
    providerEvidenceReadyE2E.requirements.find((item) => item.id === "strong-sandbox").status,
    "blocked",
  );
  assert.ok(
    providerEvidenceReadyE2E.runnableCommands.includes(
      "odai doctor --all --use-api-key --use-provider-command --save",
    ),
  );
  assert.ok(
    providerEvidenceReadyE2E.runnableCommands.includes(
      "odai doctor --provider codex-cli --use-provider-command --save",
    ),
  );
  const providerEvidenceReadyStatus = runStatus({
    repoRoot: initRoot,
    env: {
      OPENAI_API_KEY: "test-key",
      ODAI_OPENAI_MODEL: "test-model",
      ODAI_CODEX_COMMAND: fakeRuntimeCodexPath,
    },
    argv: ["--use-api-key", "--use-provider-command"],
  });
  assert.ok(providerEvidenceReadyStatus.next.includes("odai doctor --provider openai-api --use-api-key --save"));
  assert.ok(providerEvidenceReadyStatus.next.includes("odai doctor --provider codex-cli --use-provider-command --save"));
  assert.ok(providerEvidenceReadyStatus.next.includes("odai doctor --all --use-api-key --use-provider-command --save"));
  const providerEvidenceReadyWithModelE2E = runE2EReadiness({
    repoRoot: initRoot,
    env: { OPENAI_API_KEY: "test-key", ODAI_CODEX_COMMAND: fakeRuntimeCodexPath },
    argv: ["--use-api-key", "--use-provider-command", "--model", "test-model"],
  });
  assert.equal(
    providerEvidenceReadyWithModelE2E.requirements.find((item) => item.id === "provider-api").status,
    "ready",
  );
  assert.equal(
    providerEvidenceReadyWithModelE2E.requirements.find((item) => item.id === "provider-runtime").status,
    "ready",
  );
  assert.ok(
    providerEvidenceReadyWithModelE2E.runnableCommands.includes(
      "odai doctor --all --use-api-key --use-provider-command --model test-model --save",
    ),
  );
} finally {
  if (previousPathForRuntimeCodex === undefined) delete process.env.PATH;
  else process.env.PATH = previousPathForRuntimeCodex;
}
const fakeCodexBinDir = await mkdtemp(path.join(tmpdir(), "odai-cli-fake-codex-bin-"));
const fakeCodexPath = path.join(fakeCodexBinDir, process.platform === "win32" ? "codex.cmd" : "codex");
await writeFile(
  fakeCodexPath,
  process.platform === "win32" ? "@echo off\r\necho fake codex\r\n" : "#!/bin/sh\nprintf 'fake codex\\n'\n",
  "utf8",
);
await chmod(fakeCodexPath, 0o755);
const previousPathForCodex = process.env.PATH;
process.env.PATH = [
  fakeCodexBinDir,
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(path.delimiter);
try {
  const codexOnlyStatus = runStatus({
    repoRoot: initRoot,
    env: { ODAI_CODEX_COMMAND: fakeCodexPath },
    argv: ["--use-provider-command"],
  });
  assert.ok(codexOnlyStatus.runnableCommands.includes("odai doctor --provider codex-cli --use-provider-command --save"));
  assert.ok(codexOnlyStatus.next.includes("odai doctor --provider codex-cli --use-provider-command --save"));
} finally {
  if (previousPathForCodex === undefined) delete process.env.PATH;
  else process.env.PATH = previousPathForCodex;
}
const macReadySandboxReadiness = runSandboxReadiness({
  repoRoot: policyRoot,
  platform: "darwin",
  commandExists: (command) => command === "sandbox-exec",
  sandboxProbe: () => true,
});
assert.equal(macReadySandboxReadiness.status, "ready");
assert.equal(macReadySandboxReadiness.configured.status, "ready");
assert.equal(macReadySandboxReadiness.summary.configuredStrong, true);
assert.equal(macReadySandboxReadiness.candidates.find((candidate) => candidate.name === "macos-sandbox-exec").status, "ready");
let sandboxSmokeCommand;
const macReadySandboxSmoke = await runSandboxSmoke({
  repoRoot: policyRoot,
  argv: ["--allow-shell"],
  platform: "darwin",
  commandExists: (command) => command === "sandbox-exec",
  sandboxProbe: () => true,
  runShellCommand: (command, args) => {
    sandboxSmokeCommand = [command, ...args];
    return {
      status: 0,
      stdout: "odai-sandbox-smoke\n",
      stderr: "",
    };
  },
});
assert.equal(macReadySandboxSmoke.status, "ready");
assert.equal(macReadySandboxSmoke.kind, "sandbox-smoke");
assert.equal(macReadySandboxSmoke.result.ok, true);
assert.equal(macReadySandboxSmoke.escapeProbe.hostEscapeCreated, false);
assert.equal(macReadySandboxSmoke.result.sandbox.mode, "macos-sandbox-exec");
assert.equal(sandboxSmokeCommand[0], "sandbox-exec");
assert.ok(sandboxSmokeCommand.includes(process.execPath));
assert.ok(macReadySandboxSmoke.evidence.commands.length >= 2);
const macBlockedSandboxReadiness = runSandboxReadiness({
  repoRoot: policyRoot,
  platform: "darwin",
  commandExists: (command) => command === "sandbox-exec",
  sandboxProbe: () => false,
});
assert.equal(macBlockedSandboxReadiness.status, "partial");
assert.equal(macBlockedSandboxReadiness.configured.status, "blocked");
assert.match(macBlockedSandboxReadiness.configured.reason, /not usable/);
const dockerReadySandboxReadiness = runSandboxReadiness({
  repoRoot: dockerPolicyRoot,
  commandExists: (command) => command === "docker",
});
assert.equal(dockerReadySandboxReadiness.status, "ready");
assert.equal(dockerReadySandboxReadiness.configured.status, "ready");
assert.equal(dockerReadySandboxReadiness.configured.sandbox.image, "node:22-alpine");
assert.ok(dockerReadySandboxReadiness.configured.commandPreview.includes("docker"));
const devcontainerReadySandboxReadiness = runSandboxReadiness({
  repoRoot: devcontainerPolicyRoot,
  commandExists: (command) => command === "devcontainer",
});
assert.equal(devcontainerReadySandboxReadiness.status, "ready");
assert.equal(devcontainerReadySandboxReadiness.configured.status, "ready");
assert.equal(devcontainerReadySandboxReadiness.configured.sandbox.workspaceFolder, "/workspaces/odai");
assert.ok(devcontainerReadySandboxReadiness.configured.commandPreview.includes("devcontainer"));
assert.equal(
  devcontainerReadySandboxReadiness.candidates.find((candidate) => candidate.name === "devcontainer").status,
  "ready",
);
const sandboxApiE2EReadiness = runE2EReadiness({
  repoRoot: devcontainerPolicyRoot,
  env: { OPENAI_API_KEY: "test-key", ODAI_OPENAI_MODEL: "test-model" },
  argv: ["--use-api-key"],
  sandboxOptions: {
    commandExists: (command) => command === "devcontainer",
  },
});
assert.equal(sandboxApiE2EReadiness.requirements.find((item) => item.id === "provider-api").status, "ready");
assert.equal(sandboxApiE2EReadiness.requirements.find((item) => item.id === "strong-sandbox").status, "ready");
assert.ok(sandboxApiE2EReadiness.runnableCommands.includes("odai doctor --sandbox --smoke --allow-shell --save"));
const invalidPolicyRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-invalid-policy-"));
await mkdir(path.join(invalidPolicyRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(invalidPolicyRoot, ".odai", "policy.json"),
  JSON.stringify({ shell: { sandbox: { mode: "token=policy-sandbox-secret" } } }),
  "utf8",
);
const unsupportedSandboxPolicy = loadWorkspacePolicyConfig({
  workspaceRoot: invalidPolicyRoot,
});
assert.equal(unsupportedSandboxPolicy.shell.allowExecution, false);
assert.deepEqual(unsupportedSandboxPolicy.shell.allowedCommands, []);
assert.deepEqual(unsupportedSandboxPolicy.shell.sandbox, { mode: "none" });
assert.ok(
  unsupportedSandboxPolicy.configErrors.some((error) => /Unsupported shell sandbox mode/.test(error.message)),
);
assert.ok(!JSON.stringify(unsupportedSandboxPolicy.configErrors).includes("policy-sandbox-secret"));
assert.ok(JSON.stringify(unsupportedSandboxPolicy.configErrors).includes("[redacted]"));
const invalidPolicySandboxReadiness = runSandboxReadiness({ repoRoot: invalidPolicyRoot });
assert.equal(invalidPolicySandboxReadiness.policy.shell.allowExecution, false);
assert.ok(
  invalidPolicySandboxReadiness.policy.configErrors.some((error) =>
    /Unsupported shell sandbox mode/.test(error.message),
  ),
);
const invalidPolicyE2EReadiness = runE2EReadiness({ repoRoot: invalidPolicyRoot, env: {} });
assert.ok(
  invalidPolicyE2EReadiness.sandbox.policy.configErrors.some((error) =>
    /Unsupported shell sandbox mode/.test(error.message),
  ),
);
const permissiveInvalidPolicyRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-permissive-invalid-policy-"));
await mkdir(path.join(permissiveInvalidPolicyRoot, ".odai"), { recursive: true });
await symlinkOrCopyDirectory(path.join(repoRoot, "skills"), path.join(permissiveInvalidPolicyRoot, "skills"));
await writeFile(
  path.join(permissiveInvalidPolicyRoot, ".odai", "policy.json"),
  JSON.stringify({
    shell: {
      allowExecution: "yes",
      allowedCommands: "node",
    },
    network: {
      allowRequests: "yes",
      allowedHosts: "*",
      timeoutMs: "fast",
    },
  }),
  "utf8",
);
const permissiveInvalidPolicy = loadWorkspacePolicyConfig({
  workspaceRoot: permissiveInvalidPolicyRoot,
});
assert.equal(permissiveInvalidPolicy.shell.allowExecution, false);
assert.deepEqual(permissiveInvalidPolicy.shell.allowedCommands, []);
assert.equal(permissiveInvalidPolicy.network.allowRequests, false);
assert.deepEqual(permissiveInvalidPolicy.network.allowedHosts, []);
assert.ok(
  permissiveInvalidPolicy.configErrors.some((error) => /shell\.allowExecution/.test(error.message)),
);
assert.ok(
  permissiveInvalidPolicy.configErrors.some((error) => /network\.allowRequests/.test(error.message)),
);
const invalidPolicyNetworkRun = await runMockTask({
  repoRoot: permissiveInvalidPolicyRoot,
  sessionTmp,
  argv: [
    "Invalid policy network intent",
    "--agent-loop",
    "--allow-network",
    "--tool-intent-json",
    JSON.stringify({
      type: "network",
      url: "https://example.com/api",
      method: "GET",
    }),
  ],
});
assert.equal(invalidPolicyNetworkRun.status, "ready");
assert.ok(
  invalidPolicyNetworkRun.evidence.denials.some(
    (denial) => denial.intent?.type === "network" && /disabled by project policy/.test(denial.reason),
  ),
);
assert.ok(
  invalidPolicyNetworkRun.policyConfigErrors.some((error) => /network\.allowRequests/.test(error.message)),
);
const sandboxPlan = planShellCommand({
  command: ["node", "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "macos-sandbox-exec" },
  platform: "darwin",
  commandExists: () => true,
  sandboxProbe: () => true,
});
assert.equal(sandboxPlan.ok, true);
assert.equal(sandboxPlan.command[0], "sandbox-exec");
assert.ok(sandboxPlan.command.includes("node"));
const sandboxUnusablePlan = planShellCommand({
  command: ["node", "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "macos-sandbox-exec" },
  platform: "darwin",
  commandExists: () => true,
  sandboxProbe: () => false,
});
assert.equal(sandboxUnusablePlan.ok, false);
assert.match(sandboxUnusablePlan.reason, /not usable/);
const dockerSandboxPlan = planShellCommand({
  command: ["node", "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "docker", image: "node:22-alpine" },
  commandExists: (command) => command === "docker",
});
assert.equal(dockerSandboxPlan.ok, true);
assert.deepEqual(dockerSandboxPlan.command.slice(0, 5), ["docker", "run", "--rm", "--network", "none"]);
assert.ok(dockerSandboxPlan.command.includes("--read-only"));
assert.ok(dockerSandboxPlan.command.includes("node:22-alpine"));
assert.deepEqual(dockerSandboxPlan.command.slice(-2), ["node", "--version"]);
const dockerSandboxNoImage = planShellCommand({
  command: ["node", "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "docker" },
  commandExists: () => true,
});
assert.equal(dockerSandboxNoImage.ok, false);
assert.match(dockerSandboxNoImage.reason, /requires shell\.sandbox\.image/);
const dockerSandboxUnavailable = planShellCommand({
  command: ["node", "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "docker", image: "node:22-alpine" },
  commandExists: () => false,
});
assert.equal(dockerSandboxUnavailable.ok, false);
assert.match(dockerSandboxUnavailable.reason, /docker is not available/);
const devcontainerSandboxPlan = planShellCommand({
  command: ["node", "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "devcontainer", workspaceFolder: "/workspaces/odai" },
  commandExists: (command) => command === "devcontainer",
});
assert.equal(devcontainerSandboxPlan.ok, true);
assert.deepEqual(devcontainerSandboxPlan.command.slice(0, 4), [
  "devcontainer",
  "exec",
  "--workspace-folder",
  "/workspaces/odai",
]);
assert.deepEqual(devcontainerSandboxPlan.command.slice(-2), ["node", "--version"]);
const devcontainerSandboxUnavailable = planShellCommand({
  command: ["node", "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "devcontainer" },
  commandExists: () => false,
});
assert.equal(devcontainerSandboxUnavailable.ok, false);
assert.match(devcontainerSandboxUnavailable.reason, /devcontainer is not available/);

const plainEnvelope = parseToolIntentEnvelope("plain provider text");
assert.equal(plainEnvelope.text, "plain provider text");
assert.equal(plainEnvelope.toolIntents, undefined);
assert.equal(plainEnvelope.providerSession, undefined);
const sessionOnlyEnvelope = parseToolIntentEnvelope(
  JSON.stringify({
    text: "session-only provider text",
    providerSession: {
      sessionId: "session-only-123",
    },
  }),
);
assert.equal(sessionOnlyEnvelope.text, "session-only provider text");
assert.equal(sessionOnlyEnvelope.toolIntents, undefined);
assert.deepEqual(sessionOnlyEnvelope.providerSession, { sessionId: "session-only-123" });
const nonArrayToolIntentEnvelope = parseToolIntentEnvelope(
  JSON.stringify({
    text: "non-array tool intent text",
    providerSession: {
      responseId: "resp-non-array",
    },
    toolIntents: { type: "read", path: "package.json" },
  }),
);
assert.equal(nonArrayToolIntentEnvelope.text, "non-array tool intent text");
assert.equal(nonArrayToolIntentEnvelope.toolIntents, undefined);
assert.deepEqual(nonArrayToolIntentEnvelope.providerSession, { responseId: "resp-non-array" });
const parsedEnvelope = parseToolIntentEnvelope(
  JSON.stringify({
    text: "need controlled tools",
    providerSession: {
      responseId: "resp-123",
      secret: "must-not-be-trusted",
    },
    toolIntents: [
      { type: "list", path: ".", maxEntries: 5 },
      { type: "read", path: "package.json", actor: { kind: "subagent" } },
      { type: "search", pattern: "createProvider", path: "cli/src", maxResults: 3 },
      { type: "write", path: "out.txt", content: "after", extra: "ignored" },
      { type: "shell", command: "node --version" },
      { type: "network", url: "https://example.com/api", method: "post" },
      { type: "ask-user", question: "Can I continue?" },
      { type: "complete", summary: "Done" },
    ],
  }),
);
assert.equal(parsedEnvelope.text, "need controlled tools");
assert.equal(parsedEnvelope.providerSession.responseId, "resp-123");
assert.deepEqual(normalizeProviderSession(parsedEnvelope.providerSession), { responseId: "resp-123" });
assert.deepEqual(
  normalizeProviderSession({
    sessionId: "session:normal-id",
    responseId: "resp-api_key=provider-session-secret",
    requestId: "Bearer provider-session-bearer-secret",
    threadId: "thread-token=provider-session-token-secret",
    conversationId: "conversation-session=provider-session-id-secret",
    privateField: "must-not-be-trusted",
  }),
  {
    sessionId: "session:normal-id",
    responseId: "resp-api_key=[redacted]",
    requestId: "Bearer [redacted]",
    threadId: "thread-token=[redacted]",
    conversationId: "conversation-session=[redacted]",
  },
);
assert.deepEqual(parsedEnvelope.toolIntents, [
  { type: "list", path: ".", maxEntries: 5, risk: undefined },
  { type: "read", path: "package.json", risk: undefined },
  { type: "search", pattern: "createProvider", path: "cli/src", maxResults: 3, risk: undefined },
  {
    type: "write",
    path: "out.txt",
    content: "after",
    risk: undefined,
    perception: false,
    acceptanceEvidence: undefined,
    acceptanceCriteria: undefined,
  },
  {
    type: "network",
    url: "https://example.com/api",
    method: "POST",
    risk: "external",
  },
  {
    type: "ask-user",
    question: "Can I continue?",
    risk: undefined,
  },
  {
    type: "complete",
    summary: "Done",
    risk: undefined,
  },
]);



bindRoots({
  initRoot: typeof initRoot !== "undefined" ? initRoot : undefined,
  commandProviderRoot: typeof commandProviderRoot !== "undefined" ? commandProviderRoot : undefined,
  commandProviderFile: typeof commandProviderFile !== "undefined" ? commandProviderFile : undefined,
  agentRoot: typeof agentRoot !== "undefined" ? agentRoot : undefined,
  compatModelOverrideRoot: typeof compatModelOverrideRoot !== "undefined" ? compatModelOverrideRoot : undefined,
  transcript: typeof transcript !== "undefined" ? transcript : undefined,
});

console.log('suite config-routing ok');
