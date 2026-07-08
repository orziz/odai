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
} from "../../src/core/interactive-session.mjs";
import { rollbackRunRecord, rollbackWorkspaceRun } from "../../src/core/rollback.mjs";
import { loadSkillPack } from "../../src/core/skill-pack.mjs";
import {
  loadWorkspacePreferences,
  mergeWorkspacePreferences,
  preferencesPath,
  writeWorkspacePreferences,
} from "../../src/core/preferences.mjs";
import { SessionState } from "../../src/core/session-state.mjs";
import { createWorkspaceTranscript } from "../../src/core/transcript-store.mjs";
import { EvidenceLedger } from "../../src/runtime/evidence-ledger.mjs";
import { runAgentLoop } from "../../src/runtime/agent-loop.mjs";
import { DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS } from "../../src/runtime/model-tool-intents.mjs";
import { planShellCommand } from "../../src/runtime/sandbox-adapter.mjs";
import { parseToolIntentEnvelope } from "../../src/runtime/tool-intent-codec.mjs";
import { ToolDispatcher } from "../../src/runtime/tool-dispatcher.mjs";
import { normalizeProviderSession } from "../../src/runtime/provider-session.mjs";
import { publicTaskArgv, redactString } from "../../src/runtime/redaction.mjs";
import { UsageLedger } from "../../src/runtime/usage-ledger.mjs";
import { detectLanguage, normalizeLanguage, t } from "../../src/runtime/i18n.mjs";
import {
  checkForPackageUpdate,
  compareSemver,
  shouldRunStartupUpdateCheck,
} from "../../src/runtime/update-check.mjs";
import { createDefaultAgentProfiles } from "../../src/orchestrator/agent-profiles.mjs";
import { ProviderRegistry } from "../../src/orchestrator/provider-registry.mjs";
import { withProviderModelOverride } from "../../src/orchestrator/provider-model.mjs";
import { Scheduler, selectSubagentProvider } from "../../src/orchestrator/scheduler.mjs";
import { adoptPatchProposal } from "../../src/orchestrator/result-merger.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadWorkspaceProviderConfig,
} from "../../src/config/provider-config.mjs";
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
} from "../../src/index.mjs";
import {
  createRuntime as createPackageRuntime,
  listProviders as listPackageProviders,
  runTask as runPackageTask,
} from "../../src/api.mjs";
import { describeWorkspaceAgentProfiles, loadWorkspaceAgentProfiles } from "../../src/config/agent-config.mjs";
import { loadWorkspacePolicyConfig } from "../../src/config/policy-config.mjs";
import { describeExternalEvidence } from "../../src/core/external-evidence.mjs";
import { createAnthropicApiProvider } from "../../src/providers/anthropic-api.mjs";
import { createClaudeAgentSdkProvider } from "../../src/providers/claude-agent-sdk.mjs";
import { createClaudeCliProvider } from "../../src/providers/claude-cli.mjs";
import { createCodexCliProvider } from "../../src/providers/codex-cli.mjs";
import { createCommandJsonProvider } from "../../src/providers/command-json.mjs";
import { createGeminiApiProvider } from "../../src/providers/gemini-api.mjs";
import { createGrokCliProvider } from "../../src/providers/grok-cli.mjs";
import { createMockProvider } from "../../src/providers/mock-provider.mjs";
import { createOllamaProvider } from "../../src/providers/ollama.mjs";
import { createProviderPrompt, createProviderSystemPrompt } from "../../src/providers/odai-prompt.mjs";
import { createOpenAiCompatibleProvider } from "../../src/providers/openai-compatible.mjs";
import { createOpenAiApiProvider } from "../../src/providers/openai-api.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
process.env.ODAI_LANG = "en";
const sessionTmp = await mkdtemp(path.join(tmpdir(), "odai-cli-smoke-"));
const policyRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-policy-"));
const sampleFile = path.join(sessionTmp, "sample.txt");
const stopFile = path.join(sessionTmp, "stop.txt");
const patchFile = path.join(sessionTmp, "patch.txt");
const resetFile = path.join(sessionTmp, "reset.txt");
const perceptionFile = path.join(sessionTmp, "perception.txt");
const intentFile = path.join(sessionTmp, "intent.txt");
const secretFile = path.join(sessionTmp, ".env");
const envExampleFile = path.join(sessionTmp, ".env.example");
const cliAdoptFile = path.join(sessionTmp, "cli-adopt.txt");
const agentLoopFile = path.join(sessionTmp, "agent-loop.txt");
const agentLoopNewFile = path.join(sessionTmp, "agent-loop-new-file.txt");
const overflowFile = path.join(sessionTmp, "overflow.txt");
const checkpointDir = path.join(sessionTmp, "checkpoints");
const rollbackWorkspaceFile = path.join(repoRoot, ".odai", "runs", "rollback-smoke.txt");
const rollbackNewFile = path.join(repoRoot, ".odai", "runs", "rollback-new-file-smoke.txt");
await writeFile(sampleFile, "before\n", "utf8");
await writeFile(stopFile, "stop\n", "utf8");
await writeFile(patchFile, "patch-before\n", "utf8");
await writeFile(resetFile, "reset-before\n", "utf8");
await writeFile(perceptionFile, "perception-before\n", "utf8");
await writeFile(intentFile, "intent-before\n", "utf8");
await writeFile(secretFile, "OPENAI_API_KEY=should-not-enter-model-context\n", "utf8");
await writeFile(envExampleFile, "OPENAI_API_KEY=\n", "utf8");
await writeFile(cliAdoptFile, "cli-before\n", "utf8");
await writeFile(agentLoopFile, "agent-before\n", "utf8");
await writeFile(overflowFile, "overflow-before\n", "utf8");
await mkdir(path.dirname(rollbackWorkspaceFile), { recursive: true });
await writeFile(rollbackWorkspaceFile, "rollback-before\n", "utf8");
await writeFile(rollbackNewFile, "new file content\n", "utf8");

assert.equal(
  redactString("\u001b[31merror\u001b[0m token=terminal-control-secret\u0007"),
  "error token=[redacted]",
);

const skillPack = await loadSkillPack({ repoRoot });
assert.equal(skillPack.name, "odai");
assert.ok(skillPack.entryText.includes("name: odai"));
assert.ok(skillPack.entryText.includes("description:"));
assert.equal(skillPack.entrySha256, sha256(skillPack.entryText));
assert.ok(skillPack.supportFiles.includes("references/modules/dao.md"));
const skillFreshnessRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-skill-freshness-"));
await mkdir(path.join(skillFreshnessRoot, "skills", "odai", "references", "modules"), { recursive: true });
await writeFile(
  path.join(skillFreshnessRoot, "skills", "odai", "SKILL.md"),
  "---\nname: odai\n---\n\nfirst skill marker\n",
  "utf8",
);
await writeFile(
  path.join(skillFreshnessRoot, "skills", "odai", "references", "modules", "dao.md"),
  "# dao\nfirst reference marker\n",
  "utf8",
);
const firstSkillPack = await loadSkillPack({ repoRoot: skillFreshnessRoot });
const firstPromptPack = await firstSkillPack.render({ references: ["references/modules/dao.md"] });
assert.ok(firstPromptPack.includes("first skill marker"));
assert.ok(firstPromptPack.includes("first reference marker"));
await writeFile(
  path.join(skillFreshnessRoot, "skills", "odai", "SKILL.md"),
  "---\nname: odai\n---\n\nsecond skill marker\n",
  "utf8",
);
const secondSkillPack = await loadSkillPack({ repoRoot: skillFreshnessRoot });
const secondPromptPack = await secondSkillPack.render({ references: ["references/modules/dao.md"] });
assert.ok(secondPromptPack.includes("second skill marker"));
assert.ok(!secondPromptPack.includes("first skill marker"));
assert.notEqual(secondSkillPack.entrySha256, firstSkillPack.entrySha256);
const packageFallbackRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-skill-package-fallback-"));
const packageFallbackSkillPack = await loadSkillPack({ repoRoot: packageFallbackRoot });
assert.ok(packageFallbackSkillPack.root.endsWith(path.join("cli", "skills", "odai")));
assert.equal(packageFallbackSkillPack.entrySha256, skillPack.entrySha256);
assert.deepEqual(packageFallbackSkillPack.supportFiles, skillPack.supportFiles);
const packageFallbackPromptPack = await packageFallbackSkillPack.render({
  references: ["references/modules/dao.md", "references/dao/interaction-contract.md"],
});
const rootInteractionContract = await readFile(
  path.join(repoRoot, "skills", "odai", "references", "dao", "interaction-contract.md"),
  "utf8",
);
assert.ok(packageFallbackPromptPack.includes(rootInteractionContract.trimEnd()));

const packageManifest = JSON.parse(await readFile(path.join(repoRoot, "cli", "package.json"), "utf8"));
assert.equal(packageManifest.name, "odai-cli");
assert.equal(packageManifest.version, "0.0.1");
assert.equal(packageManifest.private, undefined);
assert.equal(packageManifest.license, "MIT");
assert.deepEqual(packageManifest.repository, {
  type: "git",
  url: "git+https://github.com/orziz/odai.git",
  directory: "cli",
});
assert.equal(packageManifest.homepage, "https://github.com/orziz/odai#readme");
assert.equal(packageManifest.bugs.url, "https://github.com/orziz/odai/issues");
assert.equal(packageManifest.bin.odai, "./bin/odai.mjs");
assert.equal(packageManifest.main, "./src/api.mjs");
assert.equal(packageManifest.exports["."], "./src/api.mjs");
assert.equal(packageManifest.exports["./cli"], "./src/index.mjs");
assert.ok(packageManifest.files.includes("bin"));
assert.ok(packageManifest.files.includes("src"));
assert.ok(packageManifest.files.includes("skills"));
assert.ok(!packageManifest.files.includes("tests"));
assert.equal(packageManifest.exports["./i18n"], "./src/runtime/i18n.mjs");
assert.equal(packageManifest.exports["./update-check"], "./src/runtime/update-check.mjs");
assert.equal(normalizeLanguage("zh_CN.UTF-8"), "zh");
assert.equal(normalizeLanguage("english"), "en");
assert.equal(detectLanguage({ env: { ODAI_LANG: "zh" } }), "zh");
assert.equal(t("zh", "slash.model"), "切换当前模型");
assert.equal(compareSemver("0.0.2", "0.0.1"), 1);
assert.equal(compareSemver("0.0.1", "0.0.1"), 0);
assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.1"), 1);
assert.equal(compareSemver("1.0.0-beta.1", "1.0.0"), -1);
assert.equal(shouldRunStartupUpdateCheck({ outputIsTTY: false, env: {} }), false);
assert.equal(shouldRunStartupUpdateCheck({ outputIsTTY: true, env: { ODAI_DISABLE_UPDATE_CHECK: "1" } }), false);
assert.equal(shouldRunStartupUpdateCheck({ outputIsTTY: true, env: {} }), true);
const updateAvailable = await checkForPackageUpdate({
  packageName: "odai-cli",
  currentVersion: "0.0.1",
  fetchImpl: async (url) => {
    assert.equal(url, "https://registry.npmjs.org/odai-cli/latest");
    return {
      ok: true,
      async json() {
        return { version: "0.0.2" };
      },
    };
  },
});
assert.equal(updateAvailable.status, "available");
assert.equal(updateAvailable.latestVersion, "0.0.2");
assert.equal(updateAvailable.installCommand, "npm install -g odai-cli");
const updateCurrent = await checkForPackageUpdate({
  packageName: "odai-cli",
  currentVersion: "0.0.2",
  fetchImpl: async () => ({
    ok: true,
    async json() {
      return { version: "0.0.2" };
    },
  }),
});
assert.equal(updateCurrent.status, "current");

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

const session = new SessionState({ id: "smoke" });
const evidence = new EvidenceLedger();
const dispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  checkpointDir,
});
const relativeWorkspaceRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-relative-workspace-"));
await writeFile(path.join(relativeWorkspaceRoot, "relative.txt"), "relative workspace read\n", "utf8");
await mkdir(path.join(relativeWorkspaceRoot, "src"), { recursive: true });
await writeFile(path.join(relativeWorkspaceRoot, "src", "index.txt"), "alpha\nneedle hit\n", "utf8");
await writeFile(path.join(relativeWorkspaceRoot, ".env"), "needle secret should not be searched\n", "utf8");
const relativeWorkspaceDispatcher = new ToolDispatcher({
  workspaceRoot: relativeWorkspaceRoot,
  sessionTmp,
  evidence: new EvidenceLedger(),
  session: new SessionState({ id: "relative-workspace" }),
});
const relativeWorkspaceRead = await relativeWorkspaceDispatcher.dispatch({
  type: "read",
  path: "relative.txt",
});
assert.equal(relativeWorkspaceRead.ok, true);
assert.equal(relativeWorkspaceRead.content, "relative workspace read\n");
const relativeWorkspaceList = await relativeWorkspaceDispatcher.dispatch({
  type: "list",
  path: ".",
  maxEntries: 20,
});
assert.equal(relativeWorkspaceList.ok, true);
assert.ok(relativeWorkspaceList.entries.some((entry) => entry.path === "relative.txt" && entry.type === "file"));
assert.ok(relativeWorkspaceList.entries.some((entry) => entry.path === "src" && entry.type === "directory"));
assert.ok(!relativeWorkspaceList.entries.some((entry) => entry.path === ".env"));
assert.equal(relativeWorkspaceList.truncated, false);
const relativeWorkspaceExactList = await relativeWorkspaceDispatcher.dispatch({
  type: "list",
  path: ".",
  maxEntries: 2,
});
assert.equal(relativeWorkspaceExactList.entries.length, 2);
assert.equal(relativeWorkspaceExactList.truncated, false);
const relativeWorkspaceTruncatedList = await relativeWorkspaceDispatcher.dispatch({
  type: "list",
  path: ".",
  maxEntries: 1,
});
assert.equal(relativeWorkspaceTruncatedList.entries.length, 1);
assert.equal(relativeWorkspaceTruncatedList.truncated, true);
const relativeWorkspaceSearch = await relativeWorkspaceDispatcher.dispatch({
  type: "search",
  path: ".",
  pattern: "needle",
  maxResults: 10,
});
assert.equal(relativeWorkspaceSearch.ok, true);
assert.deepEqual(relativeWorkspaceSearch.matches, [{ path: "src/index.txt", line: 2, text: "needle hit" }]);
assert.equal(relativeWorkspaceSearch.truncated, false);
const relativeWorkspaceExactSearch = await relativeWorkspaceDispatcher.dispatch({
  type: "search",
  path: ".",
  pattern: "needle",
  maxResults: 1,
});
assert.equal(relativeWorkspaceExactSearch.matches.length, 1);
assert.equal(relativeWorkspaceExactSearch.truncated, false);
const relativeWorkspaceProtectedSearch = await relativeWorkspaceDispatcher.dispatch({
  type: "search",
  path: ".env",
  pattern: "needle",
});
assert.equal(relativeWorkspaceProtectedSearch.ok, false);
assert.equal(relativeWorkspaceProtectedSearch.gate, "policy");
assert.equal(relativeWorkspaceRead.path, path.join(relativeWorkspaceRoot, "relative.txt"));
const shellExecCalls = [];
const shellDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowShellExecution: true,
  allowedShellCommands: [process.execPath],
  shellTimeoutMs: 5000,
  maxOutputChars: 4,
  runShellCommand: (command, args, options) => {
    shellExecCalls.push({ command, args, options });
    return { status: 0, stdout: "v-test-output\n", stderr: "" };
  },
});
const shellSensitiveOutputDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowShellExecution: true,
  allowedShellCommands: [process.execPath],
  runShellCommand: () => ({
    status: 1,
    stdout: "stdout token=shell-stdout-secret\n",
    stderr: "stderr Bearer shell-stderr-bearer-secret\n",
  }),
});
const shellDenyDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowShellExecution: true,
});
const sandboxUnavailableDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowShellExecution: true,
  allowedShellCommands: [process.execPath],
  shellSandbox: { mode: "macos-sandbox-exec" },
  shellSandboxPlatform: "darwin",
  shellSandboxCommandExists: () => false,
});
const dockerSandboxUnavailableDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowShellExecution: true,
  allowedShellCommands: [process.execPath],
  shellSandbox: { mode: "docker", image: "node:22-alpine" },
  shellSandboxCommandExists: () => false,
});
let networkFetchCalls = 0;
const networkDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowNetworkRequests: true,
  networkPolicy: {
    allowRequests: true,
    allowedHosts: ["example.com"],
    timeoutMs: 1000,
  },
  maxOutputChars: 12,
  fetchImpl: async (url, request) => {
    networkFetchCalls += 1;
    assert.equal(url, "https://example.com/api");
    assert.equal(request.method, "GET");
    return {
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"], ["set-cookie", "secret=1"]]),
      async text() {
        return "network response body";
      },
    };
  },
});
const networkNoTaskFlagDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowNetworkRequests: false,
  networkPolicy: {
    allowRequests: true,
    allowedHosts: ["example.com"],
    timeoutMs: 1000,
  },
  fetchImpl: async () => {
    throw new Error("fetch should not run without --allow-network");
  },
});

const blocked = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: sampleFile,
  content: "should not write\n",
});
assert.equal(blocked.ok, false);
assert.equal(blocked.gate, "evidence");
assert.equal(await readFile(sampleFile, "utf8"), "before\n");

const blockedAgain = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: stopFile,
  content: "should not write\n",
});
assert.equal(blockedAgain.ok, false);
assert.equal(blockedAgain.gate, "evidence");

await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: stopFile,
  content: "should not write\n",
});

const stopped = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: stopFile,
  content: "should not write\n",
});
assert.equal(stopped.ok, false);
assert.equal(stopped.gate, "stop");

await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: resetFile,
  content: "reset-after\n",
});
await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: resetFile,
  content: "reset-after\n",
});
const resetRead = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: resetFile,
});
assert.equal(resetRead.ok, true);
const resetWrite = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: resetFile,
  content: "reset-after\n",
});
assert.equal(resetWrite.ok, true);
assert.equal(await readFile(resetFile, "utf8"), "reset-after\n");

const perceptionRead = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: perceptionFile,
});
assert.equal(perceptionRead.ok, true);
const perceptionDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: perceptionFile,
  content: "perception-after\n",
  risk: "perception",
});
assert.equal(perceptionDenied.ok, false);
assert.equal(perceptionDenied.gate, "perception");
assert.equal(await readFile(perceptionFile, "utf8"), "perception-before\n");
const perceptionAllowed = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: perceptionFile,
  content: "perception-after\n",
  risk: "perception",
  acceptanceEvidence: { criteria: "frozen visual acceptance sample" },
});
assert.equal(perceptionAllowed.ok, true);
assert.equal(await readFile(perceptionFile, "utf8"), "perception-after\n");

const outsideRoot = path.join(tmpdir(), "odai-cli-outside-root.txt");
const outsideDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: outsideRoot,
});
assert.equal(outsideDenied.ok, false);
assert.equal(outsideDenied.gate, "policy");

const outsideSymlinkTargetDir = await mkdtemp(path.join(tmpdir(), "odai-cli-outside-target-"));
const outsideSymlinkTargetFile = path.join(outsideSymlinkTargetDir, "secret.txt");
await writeFile(outsideSymlinkTargetFile, "secret\n", "utf8");
const symlinkedFile = path.join(sessionTmp, "linked-secret.txt");
if (await trySymlink(outsideSymlinkTargetFile, symlinkedFile)) {
  const symlinkFileDenied = await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "read",
    path: symlinkedFile,
  });
  assert.equal(symlinkFileDenied.ok, false);
  assert.equal(symlinkFileDenied.gate, "policy");
  assert.match(symlinkFileDenied.reason, /outside allowed roots/);
}
const symlinkedDir = path.join(sessionTmp, "linked-dir");
if (await trySymlink(outsideSymlinkTargetDir, symlinkedDir, "dir")) {
  const symlinkDirReadDenied = await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "read",
    path: path.join(symlinkedDir, "secret.txt"),
  });
  assert.equal(symlinkDirReadDenied.ok, false);
  assert.equal(symlinkDirReadDenied.gate, "policy");
  const symlinkDirWriteDenied = await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "write",
    path: path.join(symlinkedDir, "created-by-model.txt"),
    content: "escape\n",
  });
  assert.equal(symlinkDirWriteDenied.ok, false);
  assert.equal(symlinkDirWriteDenied.gate, "policy");
  await assert.rejects(() => readFile(path.join(outsideSymlinkTargetDir, "created-by-model.txt"), "utf8"), /ENOENT/);
}

const secretReadDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: secretFile,
});
assert.equal(secretReadDenied.ok, false);
assert.equal(secretReadDenied.gate, "authorization");
assert.equal(secretReadDenied.intent.risk, "credential");
assert.ok(!evidence.snapshot().reads.includes(secretFile));
assert.ok(!JSON.stringify(secretReadDenied).includes("should-not-enter-model-context"));

const privateRunRecordReadDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: path.join(repoRoot, ".odai", "runs", "latest.json"),
});
assert.equal(privateRunRecordReadDenied.ok, false);
assert.equal(privateRunRecordReadDenied.gate, "authorization");
assert.equal(privateRunRecordReadDenied.intent.risk, "credential");

const envExampleRead = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: envExampleFile,
});
assert.equal(envExampleRead.ok, true);
assert.equal(envExampleRead.content, "OPENAI_API_KEY=\n");

session.authorize("risk:credential");
const subagentSecretReadDenied = await dispatcher.dispatch({
  actor: { kind: "subagent", id: "secret-reviewer" },
  type: "read",
  path: secretFile,
});
assert.equal(subagentSecretReadDenied.ok, false);
assert.equal(subagentSecretReadDenied.gate, "subagent-boundary");
assert.ok(!JSON.stringify(subagentSecretReadDenied).includes("should-not-enter-model-context"));

const secretReadAllowed = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: secretFile,
});
assert.equal(secretReadAllowed.ok, true);
assert.equal(secretReadAllowed.content, "OPENAI_API_KEY=should-not-enter-model-context\n");

const checkpointCountBeforeSecretWrite = evidence.snapshot().checkpoints.length;
const secretWriteDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: secretFile,
  content: "OPENAI_API_KEY=changed-by-model\n",
});
assert.equal(secretWriteDenied.ok, false);
assert.equal(secretWriteDenied.gate, "policy");
assert.match(secretWriteDenied.reason, /cannot be modified by model tool intents/);
assert.equal(await readFile(secretFile, "utf8"), "OPENAI_API_KEY=should-not-enter-model-context\n");
assert.equal(evidence.snapshot().checkpoints.length, checkpointCountBeforeSecretWrite);
assert.ok(!JSON.stringify(secretWriteDenied).includes("changed-by-model"));
assert.ok(!JSON.stringify(evidence.snapshot().checkpoints).includes("should-not-enter-model-context"));

const networkDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "network",
  url: "https://example.com/api",
  method: "GET",
});
assert.equal(networkDenied.ok, false);
assert.equal(networkDenied.gate, "policy");
assert.equal(networkDenied.intent.url, "https://example.com/api");
assert.match(networkDenied.reason, /--allow-network/);

const sensitiveNetworkDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "network",
  url: "https://example.com/api?token=network-secret-token&ok=1",
  method: "GET",
});
assert.equal(sensitiveNetworkDenied.ok, false);
assert.equal(sensitiveNetworkDenied.gate, "policy");
assert.ok(!JSON.stringify(sensitiveNetworkDenied).includes("network-secret-token"));
assert.ok(!JSON.stringify(evidence.snapshot().denials).includes("network-secret-token"));

const networkNoTaskFlagDenied = await networkNoTaskFlagDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "network",
  url: "https://example.com/api",
  method: "GET",
});
assert.equal(networkNoTaskFlagDenied.ok, false);
assert.equal(networkNoTaskFlagDenied.gate, "policy");
assert.match(networkNoTaskFlagDenied.reason, /--allow-network/);

const networkHostDenied = await networkDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "network",
  url: "https://not-example.com/api",
  method: "GET",
});
assert.equal(networkHostDenied.ok, false);
assert.equal(networkHostDenied.gate, "policy");
assert.match(networkHostDenied.reason, /allowlist/);

const networkAuthorizationDenied = await networkDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "network",
  url: "https://example.com/api",
  method: "GET",
});
assert.equal(networkAuthorizationDenied.ok, false);
assert.equal(networkAuthorizationDenied.gate, "authorization");
assert.equal(networkFetchCalls, 0);
session.authorize("risk:external");
const networkAllowed = await networkDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "network",
  url: "https://example.com/api",
  method: "GET",
});
assert.equal(networkAllowed.ok, true);
assert.equal(networkAllowed.status, 200);
assert.equal(networkAllowed.body, "network resp\n[truncated 9 chars]");
assert.deepEqual(networkAllowed.headers, { "content-type": "text/plain" });
assert.equal(networkFetchCalls, 1);
assert.ok(evidence.snapshot().network.some((entry) => entry.url === "https://example.com/api" && entry.status === 200));
const networkFailingDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
  allowNetworkRequests: true,
  networkPolicy: {
    allowRequests: true,
    allowedHosts: ["example.com"],
    timeoutMs: 1000,
  },
  fetchImpl: async () => {
    throw new Error(
      "fetch failed https://example.com/api?token=network-error-secret Bearer network-error-bearer-secret",
    );
  },
});
const networkFetchFailed = await networkFailingDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "network",
  url: "https://example.com/api",
  method: "GET",
});
assert.equal(networkFetchFailed.ok, false);
assert.ok(!JSON.stringify(networkFetchFailed).includes("network-error-secret"));
assert.ok(!JSON.stringify(networkFetchFailed).includes("network-error-bearer-secret"));
assert.match(networkFetchFailed.error, /token=\[redacted\]/);
assert.ok(!JSON.stringify(evidence.snapshot().network).includes("network-error-secret"));
assert.ok(!JSON.stringify(evidence.snapshot().network).includes("network-error-bearer-secret"));

const askUserDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "ask-user",
  question: "Should I ask the user?",
});
assert.equal(askUserDenied.ok, false);
assert.equal(askUserDenied.gate, "policy");
assert.equal(askUserDenied.intent.question, "Should I ask the user?");

const completeDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "complete",
  summary: "Finished",
});
assert.equal(completeDenied.ok, false);
assert.equal(completeDenied.gate, "policy");
assert.equal(completeDenied.intent.summary, "Finished");
const sensitiveAskUserDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "ask-user",
  question: "Can I use token=ask-user-secret?",
});
assert.equal(sensitiveAskUserDenied.intent.question, "Can I use token=[redacted]");
const sensitiveCompleteDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "complete",
  summary: "Done with Bearer complete-summary-secret",
});
assert.equal(sensitiveCompleteDenied.intent.summary, "Done with Bearer [redacted]");
assert.ok(!JSON.stringify(sensitiveAskUserDenied).includes("ask-user-secret"));
assert.ok(!JSON.stringify(sensitiveCompleteDenied).includes("complete-summary-secret"));
assert.ok(!JSON.stringify(evidence.snapshot().denials).includes("ask-user-secret"));
assert.ok(!JSON.stringify(evidence.snapshot().denials).includes("complete-summary-secret"));

const subagentNetworkDenied = await dispatcher.dispatch({
  actor: { kind: "subagent", id: "network-reviewer" },
  type: "network",
  url: "https://example.com/api",
  method: "GET",
});
assert.equal(subagentNetworkDenied.ok, false);
assert.equal(subagentNetworkDenied.gate, "subagent-boundary");

const subagentCompleteDenied = await dispatcher.dispatch({
  actor: { kind: "subagent", id: "network-reviewer" },
  type: "complete",
  summary: "I am done",
});
assert.equal(subagentCompleteDenied.ok, false);
assert.equal(subagentCompleteDenied.gate, "subagent-boundary");

const destructiveDenied = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: "deploy production",
  risk: "production",
});
assert.equal(destructiveDenied.ok, false);
assert.equal(destructiveDenied.gate, "authorization");
session.authorize("risk:production");
const destructiveAuthorized = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: ["deploy", "production"],
  risk: "production",
});
assert.equal(destructiveAuthorized.ok, true);
assert.equal(destructiveAuthorized.skipped, true);

const shellIntentOnly = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: [process.execPath, "--version"],
});
assert.equal(shellIntentOnly.ok, true);
assert.equal(shellIntentOnly.skipped, true);

const sensitiveShellIntentOnly = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: [
    "curl",
    "-H",
    "Authorization: Bearer shell-secret-token",
    "https://example.com/api?api_key=url-secret-token",
    "--token",
    "flag-secret-token",
    "TOKEN=env-secret-token",
  ],
});
assert.equal(sensitiveShellIntentOnly.ok, true);
assert.equal(sensitiveShellIntentOnly.skipped, true);
assert.ok(!JSON.stringify(sensitiveShellIntentOnly).includes("shell-secret-token"));
assert.ok(!JSON.stringify(sensitiveShellIntentOnly).includes("url-secret-token"));
assert.ok(!JSON.stringify(sensitiveShellIntentOnly).includes("flag-secret-token"));
assert.ok(!JSON.stringify(sensitiveShellIntentOnly).includes("env-secret-token"));
assert.ok(!JSON.stringify(evidence.snapshot().commands).includes("shell-secret-token"));
assert.ok(!JSON.stringify(evidence.snapshot().commands).includes("url-secret-token"));
assert.ok(!JSON.stringify(evidence.snapshot().commands).includes("flag-secret-token"));
assert.ok(!JSON.stringify(evidence.snapshot().commands).includes("env-secret-token"));

const shellStringDenied = await shellDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: "node --version",
});
assert.equal(shellStringDenied.ok, false);
assert.equal(shellStringDenied.gate, "policy");

const shellNotAllowlisted = await shellDenyDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: [process.execPath, "--version"],
});
assert.equal(shellNotAllowlisted.ok, false);
assert.equal(shellNotAllowlisted.gate, "policy");

const shellExecuted = await shellDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: [process.execPath, "--version"],
});
assert.equal(shellExecuted.ok, true);
assert.match(shellExecuted.stdout, /^v/);
assert.ok(shellExecuted.stdout.length < 80);
assert.equal(shellExecCalls.length, 1);
assert.equal(shellExecCalls[0].command, process.execPath);
assert.deepEqual(shellExecCalls[0].args, ["--version"]);
const shellSensitiveOutput = await shellSensitiveOutputDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: [process.execPath, "--version"],
});
assert.equal(shellSensitiveOutput.ok, false);
assert.ok(!JSON.stringify(shellSensitiveOutput).includes("shell-stdout-secret"));
assert.ok(!JSON.stringify(shellSensitiveOutput).includes("shell-stderr-bearer-secret"));
assert.match(shellSensitiveOutput.stdout, /token=\[redacted\]/);
assert.match(shellSensitiveOutput.stderr, /Bearer \[redacted\]/);

const sandboxUnavailable = await sandboxUnavailableDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: [process.execPath, "--version"],
});
assert.equal(sandboxUnavailable.ok, false);
assert.equal(sandboxUnavailable.gate, "policy");
assert.match(sandboxUnavailable.reason, /sandbox-exec is not available/);
const dockerSandboxUnavailableShell = await dockerSandboxUnavailableDispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "shell",
  command: [process.execPath, "--version"],
});
assert.equal(dockerSandboxUnavailableShell.ok, false);
assert.equal(dockerSandboxUnavailableShell.gate, "policy");
assert.match(dockerSandboxUnavailableShell.reason, /docker is not available/);

const realMacSandboxPlan = planShellCommand({
  command: [process.execPath, "--version"],
  workspaceRoot: repoRoot,
  sessionTmp,
  sandbox: { mode: "macos-sandbox-exec" },
});
if (realMacSandboxPlan.ok && process.platform === "darwin") {
  const realSandboxDispatcher = new ToolDispatcher({
    workspaceRoot: repoRoot,
    sessionTmp,
    evidence,
    session,
    allowShellExecution: true,
    allowedShellCommands: [process.execPath],
    shellSandbox: { mode: "macos-sandbox-exec" },
  });
  const sandboxAllowedFile = path.join(sessionTmp, "sandbox-exec-allowed.txt");
  const sandboxAllowedShell = await realSandboxDispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "shell",
    command: [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(sandboxAllowedFile)}, "allowed\\n")`,
    ],
  });
  assert.equal(sandboxAllowedShell.ok, true);
  assert.equal(await readFile(sandboxAllowedFile, "utf8"), "allowed\n");
  const sandboxDeniedFile = path.join(tmpdir(), "odai-cli-sandbox-denied.txt");
  const sandboxDeniedShell = await realSandboxDispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "shell",
    command: [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(sandboxDeniedFile)}, "denied\\n")`,
    ],
  });
  assert.equal(sandboxDeniedShell.ok, false);
  await assert.rejects(() => readFile(sandboxDeniedFile, "utf8"), /ENOENT|EPERM|EACCES/);
}

const read = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: sampleFile,
});
assert.equal(read.ok, true);

const allowed = await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "write",
  path: sampleFile,
  content: "after\n",
});
assert.equal(allowed.ok, true);
assert.ok(allowed.checkpoint);
assert.equal(await readFile(sampleFile, "utf8"), "after\n");
const sampleCheckpoint = evidence
  .snapshot()
  .checkpoints.findLast((checkpoint) => checkpoint.path === sampleFile);
assert.ok(sampleCheckpoint);
const sampleCheckpointRecord = JSON.parse(await readFile(sampleCheckpoint.checkpointPath, "utf8"));
assert.equal(sampleCheckpointRecord.existed, true);
assert.equal(sampleCheckpointRecord.content, "before\n");

const providers = new ProviderRegistry();
providers.register(createMockProvider("mock-main", ["reasoning", "code"]));
providers.register(createMockProvider("mock-reviewer", ["reasoning", "code", "long_context"]));
assert.equal(providers.list().length, 2);
assert.equal(describeProviders(providers).providers.length, 2);
assert.equal(providers.findByCapabilities(["code"], { excludeNames: ["mock-main"] }).name, "mock-reviewer");
const autoSelectProviders = new ProviderRegistry();
autoSelectProviders.register(createMockProvider("mock-auto", ["reasoning", "code"]));
autoSelectProviders.register(
  createOllamaProvider({
    name: "ollama-auto",
    model: "llama3.2",
    fetchImpl: async () => {
      throw new Error("auto selection test should not call provider");
    },
  }),
);
assert.equal(autoSelectProviders.findByCapabilities(["code"]).name, "mock-auto");
assert.equal(autoSelectProviders.findByCapabilities(["code"], { preferNonMock: true }).name, "ollama-auto");
const mainAutoFallbackProviders = new ProviderRegistry();
mainAutoFallbackProviders.register(createMockProvider("mock-main", ["reasoning", "code"]));
assert.equal(selectMainRunProvider({ providers: mainAutoFallbackProviders, providerName: "auto" }).name, "mock-main");
const mainAutoOneRealProviders = new ProviderRegistry();
mainAutoOneRealProviders.register(createMockProvider("mock-main", ["reasoning", "code"]));
mainAutoOneRealProviders.register({
  name: "real-one",
  kind: "api",
  available: true,
  capabilities: ["reasoning", "code"],
});
assert.equal(selectMainRunProvider({ providers: mainAutoOneRealProviders, providerName: "auto" }).name, "real-one");
const mainAutoModelOverrideProviders = new ProviderRegistry();
mainAutoModelOverrideProviders.register(createMockProvider("mock-main", ["reasoning", "code"]));
mainAutoModelOverrideProviders.register(
  createOpenAiApiProvider({
    apiKey: "present",
    allowApiKey: true,
    fetchImpl: async () => {
      throw new Error("main auto model override selection should not call provider");
    },
  }),
);
assert.equal(selectMainRunProvider({ providers: mainAutoModelOverrideProviders, providerName: "auto" }).name, "mock-main");
const mainAutoModelOverrideSelected = selectMainRunProvider({
  providers: mainAutoModelOverrideProviders,
  providerName: "auto",
  modelOverride: "override-model",
});
assert.equal(mainAutoModelOverrideSelected.name, "openai-api");
assert.equal(mainAutoModelOverrideSelected.available, true);
assert.equal(mainAutoModelOverrideSelected.source.modelOverridePresent, true);
const mainAutoCompatibleModelOverrideProviders = new ProviderRegistry();
mainAutoCompatibleModelOverrideProviders.register(createMockProvider("mock-main", ["reasoning", "code"]));
mainAutoCompatibleModelOverrideProviders.register(
  createOpenAiCompatibleProvider({
    name: "compat-auto",
    baseUrl: "https://compat.example/v1",
    apiKey: "present",
    allowApiKey: true,
    fetchImpl: async () => {
      throw new Error("compatible auto model override selection should not call provider");
    },
  }),
);
const mainAutoCompatibleModelOverrideSelected = selectMainRunProvider({
  providers: mainAutoCompatibleModelOverrideProviders,
  providerName: "auto",
  modelOverride: "compat-model",
});
assert.equal(mainAutoCompatibleModelOverrideSelected.name, "compat-auto");
assert.equal(mainAutoCompatibleModelOverrideSelected.available, true);
assert.equal(mainAutoCompatibleModelOverrideSelected.source.modelOverridePresent, true);
const mainAutoAmbiguousProviders = new ProviderRegistry();
mainAutoAmbiguousProviders.register(createMockProvider("mock-main", ["reasoning", "code"]));
mainAutoAmbiguousProviders.register({
  name: "real-one",
  kind: "api",
  available: true,
  capabilities: ["reasoning", "code"],
});
mainAutoAmbiguousProviders.register({
  name: "real-two",
  kind: "subscription-cli",
  available: true,
  capabilities: ["reasoning", "code"],
});
assert.throws(
  () => selectMainRunProvider({ providers: mainAutoAmbiguousProviders, providerName: "auto" }),
  /Provider auto selection is ambiguous: real-one, real-two/,
);
const mainAutoModelOverrideAmbiguousProviders = new ProviderRegistry();
mainAutoModelOverrideAmbiguousProviders.register(createMockProvider("mock-main", ["reasoning", "code"]));
mainAutoModelOverrideAmbiguousProviders.register(
  createOpenAiApiProvider({
    apiKey: "present",
    allowApiKey: true,
    fetchImpl: async () => {
      throw new Error("main auto ambiguous model override selection should not call OpenAI provider");
    },
  }),
);
mainAutoModelOverrideAmbiguousProviders.register(
  createAnthropicApiProvider({
    apiKey: "present",
    allowApiKey: true,
    fetchImpl: async () => {
      throw new Error("main auto ambiguous model override selection should not call Anthropic provider");
    },
  }),
);
assert.throws(
  () =>
    selectMainRunProvider({
      providers: mainAutoModelOverrideAmbiguousProviders,
      providerName: "auto",
      modelOverride: "override-model",
    }),
  /Provider auto selection is ambiguous: openai-api, anthropic-api/,
);
const reviewerProfileForAuto = createDefaultAgentProfiles().get("reviewer");
const subagentAutoFallbackProviders = new ProviderRegistry();
subagentAutoFallbackProviders.register(createMockProvider("mock-main", ["reasoning", "code"]));
subagentAutoFallbackProviders.register(createMockProvider("mock-reviewer", ["reasoning", "code"]));
assert.equal(
  selectSubagentProvider({
    providers: subagentAutoFallbackProviders,
    profile: reviewerProfileForAuto,
    providerName: "auto",
    excludeProviderNames: ["mock-main"],
  }).name,
  "mock-reviewer",
);
const subagentAutoOneRealProviders = new ProviderRegistry();
subagentAutoOneRealProviders.register(createMockProvider("mock-reviewer", ["reasoning", "code"]));
subagentAutoOneRealProviders.register({
  name: "real-reviewer",
  kind: "api",
  available: true,
  capabilities: ["reasoning", "code"],
});
assert.equal(
  selectSubagentProvider({
    providers: subagentAutoOneRealProviders,
    profile: reviewerProfileForAuto,
    providerName: "auto",
  }).name,
  "real-reviewer",
);
assert.equal(
  selectSubagentProvider({
    providers: subagentAutoOneRealProviders,
    profile: reviewerProfileForAuto,
  }).name,
  "real-reviewer",
);
const subagentAutoModelOverrideProviders = new ProviderRegistry();
subagentAutoModelOverrideProviders.register(createMockProvider("mock-reviewer", ["reasoning", "code"]));
subagentAutoModelOverrideProviders.register(
  createOpenAiApiProvider({
    apiKey: "present",
    allowApiKey: true,
    fetchImpl: async () => {
      throw new Error("subagent auto model override selection should not call provider");
    },
  }),
);
assert.equal(
  selectSubagentProvider({
    providers: subagentAutoModelOverrideProviders,
    profile: reviewerProfileForAuto,
    providerName: "auto",
  }).name,
  "mock-reviewer",
);
const subagentAutoModelOverrideSelected = selectSubagentProvider({
  providers: subagentAutoModelOverrideProviders,
  profile: reviewerProfileForAuto,
  providerName: "auto",
  modelOverride: "override-model",
});
assert.equal(subagentAutoModelOverrideSelected.name, "openai-api");
assert.equal(subagentAutoModelOverrideSelected.available, true);
assert.equal(subagentAutoModelOverrideSelected.source.modelOverridePresent, true);
const subagentAutoCompatibleModelOverrideProviders = new ProviderRegistry();
subagentAutoCompatibleModelOverrideProviders.register(createMockProvider("mock-reviewer", ["reasoning", "code"]));
subagentAutoCompatibleModelOverrideProviders.register(
  createOpenAiCompatibleProvider({
    name: "compat-reviewer-auto",
    baseUrl: "https://compat.example/v1",
    apiKey: "present",
    allowApiKey: true,
    fetchImpl: async () => {
      throw new Error("compatible subagent auto model override selection should not call provider");
    },
  }),
);
const subagentAutoCompatibleModelOverrideSelected = selectSubagentProvider({
  providers: subagentAutoCompatibleModelOverrideProviders,
  profile: reviewerProfileForAuto,
  providerName: "auto",
  modelOverride: "compat-model",
});
assert.equal(subagentAutoCompatibleModelOverrideSelected.name, "compat-reviewer-auto");
assert.equal(subagentAutoCompatibleModelOverrideSelected.available, true);
assert.equal(subagentAutoCompatibleModelOverrideSelected.source.modelOverridePresent, true);
const subagentAutoAmbiguousProviders = new ProviderRegistry();
subagentAutoAmbiguousProviders.register(createMockProvider("mock-reviewer", ["reasoning", "code"]));
subagentAutoAmbiguousProviders.register({
  name: "real-reviewer-one",
  kind: "api",
  available: true,
  capabilities: ["reasoning", "code"],
});
subagentAutoAmbiguousProviders.register({
  name: "real-reviewer-two",
  kind: "subscription-cli",
  available: true,
  capabilities: ["reasoning", "code"],
});
assert.throws(
  () =>
    selectSubagentProvider({
      providers: subagentAutoAmbiguousProviders,
      profile: reviewerProfileForAuto,
      providerName: "auto",
    }),
  /Subagent provider auto selection is ambiguous for profile 'reviewer': real-reviewer-one, real-reviewer-two/,
);
assert.throws(
  () =>
    selectSubagentProvider({
      providers: subagentAutoAmbiguousProviders,
      profile: reviewerProfileForAuto,
    }),
  /Subagent provider auto selection is ambiguous for profile 'reviewer': real-reviewer-one, real-reviewer-two/,
);
assert.equal(
  selectSubagentProvider({
    providers: subagentAutoAmbiguousProviders,
    profile: reviewerProfileForAuto,
    providerName: "real-reviewer-two",
  }).name,
  "real-reviewer-two",
);

const gatedProviders = createProviderRegistryFromEnvironment({ OPENAI_API_KEY: "present" });
const missingCredentialProviders = createProviderRegistryFromEnvironment({});
assert.equal(missingCredentialProviders.get("openai-api").blockedReason, "api_key_missing");
assert.equal(missingCredentialProviders.get("anthropic-api").blockedReason, "api_key_missing");
assert.equal(missingCredentialProviders.get("gemini-api").blockedReason, "api_key_missing");
assert.equal(missingCredentialProviders.get("deepseek-api").blockedReason, "api_key_missing");
const missingCredentialDescription = describeProviders(missingCredentialProviders, {});
assert.equal(
  missingCredentialDescription.providers.find((provider) => provider.name === "openai-api").blockedReason,
  "api_key_missing",
);
assert.deepEqual(missingCredentialDescription.providers.find((provider) => provider.name === "openai-api").source, {
  type: "env",
  apiKeyEnv: "OPENAI_API_KEY",
  modelEnv: "ODAI_OPENAI_MODEL",
  apiKeyPresent: false,
  modelPresent: false,
});
assert.deepEqual(missingCredentialDescription.providers.find((provider) => provider.name === "deepseek-api").source, {
  type: "openai-compatible",
  baseUrl: "https://api.deepseek.com/",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  modelEnv: "ODAI_DEEPSEEK_MODEL",
  apiKeyPresent: false,
  modelPresent: false,
  configured: true,
});
const gatedOpenai = gatedProviders.get("openai-api");
assert.equal(gatedOpenai.available, false);
assert.equal(gatedOpenai.blockedReason, "api_key_requires_explicit_use");
const providerDescription = describeProviders(gatedProviders);
assert.equal(
  JSON.stringify(providerDescription.providers.find((provider) => provider.name === "openai-api")),
  JSON.stringify({
    name: "openai-api",
    kind: "api",
    auth: "api_key",
    source: {
      type: "env",
      apiKeyEnv: "OPENAI_API_KEY",
      modelEnv: "ODAI_OPENAI_MODEL",
      apiKeyPresent: true,
      modelPresent: false,
    },
    available: false,
    blockedReason: "api_key_requires_explicit_use",
    capabilities: ["reasoning", "structured_output", "code", "tool_calling"],
    cost: "unknown",
  }),
);
assert.ok(!JSON.stringify(providerDescription).includes("present"));
assert.equal(typeof providerDescription.packages.claudeAgentSdk, "boolean");
assert.equal(typeof providerDescription.commands.claude, "boolean");
assert.equal(typeof providerDescription.commands.codex, "boolean");
assert.equal(typeof providerDescription.commands.grok, "boolean");
assert.equal(providerDescription.local.ollamaModel, false);
assert.equal(gatedProviders.get("claude-agent-sdk").kind, "subscription-sdk");
assert.equal(gatedProviders.get("claude-agent-sdk").available, false);
assert.equal(
  gatedProviders.get("claude-agent-sdk").blockedReason,
  providerDescription.packages.claudeAgentSdk
    ? "provider_command_requires_explicit_use"
    : "sdk_package_not_installed",
);
assert.equal(
  providerDescription.providers.find((provider) => provider.name === "claude-agent-sdk").source.package,
  "@anthropic-ai/claude-agent-sdk",
);
assert.equal(gatedProviders.get("claude-cli").available, false);
assert.equal(providerDescription.providers.find((provider) => provider.name === "claude-cli").source.command, "claude");
assert.equal(
  providerDescription.providers.find((provider) => provider.name === "claude-cli").source.confirmationFlag,
  "--use-provider-command",
);
const configuredClaudeCliProviders = createProviderRegistryFromEnvironment(
  { ODAI_CLAUDE_COMMAND: process.execPath },
  { allowProviderCommand: true },
);
const configuredClaudeCliDescription = describeProviders(configuredClaudeCliProviders, {
  ODAI_CLAUDE_COMMAND: process.execPath,
});
assert.equal(configuredClaudeCliProviders.get("claude-cli").available, true);
assert.equal(configuredClaudeCliDescription.commands.claude, true);
const configuredClaudeCliSource = configuredClaudeCliDescription.providers.find((provider) => provider.name === "claude-cli").source;
const { command: configuredClaudeCliCommand, ...configuredClaudeCliSourceWithoutCommand } = configuredClaudeCliSource;
assert.equal(normalizePathForCompare(configuredClaudeCliCommand), normalizePathForCompare(process.execPath));
assert.deepEqual(configuredClaudeCliSourceWithoutCommand, {
  type: "command",
  commandPresent: true,
  modelEnv: "ODAI_CLAUDE_MODEL",
  modelPresent: false,
  confirmationFlag: "--use-provider-command",
  executableEnv: "ODAI_CLAUDE_COMMAND",
  executableConfigured: true,
});
const scopedProviderCommandProviders = createProviderRegistryFromEnvironment(
  {
    ODAI_CLAUDE_COMMAND: process.execPath,
    ODAI_CODEX_COMMAND: process.execPath,
  },
  { allowedProviderCommands: ["claude-cli"] },
);
assert.equal(scopedProviderCommandProviders.get("claude-cli").available, true);
assert.equal(scopedProviderCommandProviders.get("codex-cli").available, false);
assert.equal(
  scopedProviderCommandProviders.get("codex-cli").blockedReason,
  "provider_command_requires_explicit_use",
);
const failingAuthClaudeDir = await mkdtemp(path.join(tmpdir(), "odai-cli-failing-auth-claude-"));
const failingAuthClaudePath = path.join(failingAuthClaudeDir, process.platform === "win32" ? "claude.cmd" : "claude");
await writeFile(
  failingAuthClaudePath,
  process.platform === "win32"
    ? "@echo off\r\necho Not logged in - Please run /login 1>&2\r\nexit /b 1\r\n"
    : "#!/bin/sh\nprintf 'Not logged in - Please run /login\\n' >&2\nexit 1\n",
  "utf8",
);
await chmod(failingAuthClaudePath, 0o755);
const failingAuthClaudeDoctor = await runDoctor({
  repoRoot: commandProviderRoot,
  env: { ODAI_CLAUDE_COMMAND: failingAuthClaudePath, ODAI_CLAUDE_MODEL: "claude-fail-model" },
  argv: ["--provider", "claude-cli", "--use-provider-command", "--model", "claude-fail-model"],
});
assert.equal(failingAuthClaudeDoctor.status, "failed");
assert.match(failingAuthClaudeDoctor.error.message, /Not logged in/);
assert.ok(failingAuthClaudeDoctor.next.some((action) => action.includes("/login")));
assert.ok(
  failingAuthClaudeDoctor.next.includes(
    "odai doctor --provider claude-cli --use-provider-command --model claude-fail-model --save",
  ),
);
const discoveredClaudeHome = await mkdtemp(path.join(tmpdir(), "odai-cli-claude-home-"));
const discoveredClaudeBinary = path.join(
  discoveredClaudeHome,
  ".vscode",
  "extensions",
  "anthropic.claude-code-9.9.9-darwin-arm64",
  "resources",
  "native-binary",
  process.platform === "win32" ? "claude.cmd" : "claude",
);
await mkdir(path.dirname(discoveredClaudeBinary), { recursive: true });
await writeFile(
  discoveredClaudeBinary,
  process.platform === "win32" ? "@echo off\r\necho fake claude\r\n" : "#!/bin/sh\nprintf 'fake claude\\n'\n",
  "utf8",
);
await chmod(discoveredClaudeBinary, 0o755);
const discoveredClaudeCliProviders = createProviderRegistryFromEnvironment(
  { HOME: discoveredClaudeHome },
  { allowProviderCommand: true },
);
const discoveredClaudeCliDescription = describeProviders(discoveredClaudeCliProviders, {
  HOME: discoveredClaudeHome,
});
assert.equal(discoveredClaudeCliProviders.get("claude-cli").available, true);
assert.equal(discoveredClaudeCliDescription.commands.claude, true);
const discoveredClaudeCliSource = discoveredClaudeCliDescription.providers.find((provider) => provider.name === "claude-cli").source;
const { command: discoveredClaudeCliCommand, ...discoveredClaudeCliSourceWithoutCommand } = discoveredClaudeCliSource;
assert.equal(normalizePathForCompare(discoveredClaudeCliCommand), normalizePathForCompare(discoveredClaudeBinary));
assert.deepEqual(discoveredClaudeCliSourceWithoutCommand, {
  type: "command",
  commandPresent: true,
  modelEnv: "ODAI_CLAUDE_MODEL",
  modelPresent: false,
  confirmationFlag: "--use-provider-command",
  executableDiscovered: true,
});
const configuredCodexCliProviders = createProviderRegistryFromEnvironment(
  { ODAI_CODEX_COMMAND: process.execPath, ODAI_CODEX_MODEL: "gpt-test" },
  { allowProviderCommand: true },
);
const configuredCodexCliDescription = describeProviders(configuredCodexCliProviders, {
  ODAI_CODEX_COMMAND: process.execPath,
  ODAI_CODEX_MODEL: "gpt-test",
});
assert.equal(configuredCodexCliProviders.get("codex-cli").available, true);
assert.equal(configuredCodexCliDescription.commands.codex, true);
const configuredCodexCliSource = configuredCodexCliDescription.providers.find((provider) => provider.name === "codex-cli").source;
const { command: configuredCodexCliCommand, ...configuredCodexCliSourceWithoutCommand } = configuredCodexCliSource;
assert.equal(normalizePathForCompare(configuredCodexCliCommand), normalizePathForCompare(process.execPath));
assert.deepEqual(configuredCodexCliSourceWithoutCommand, {
  type: "command",
  commandPresent: true,
  modelEnv: "ODAI_CODEX_MODEL",
  modelPresent: true,
  confirmationFlag: "--use-provider-command",
  executableEnv: "ODAI_CODEX_COMMAND",
  executableConfigured: true,
});
const configuredGrokCliProviders = createProviderRegistryFromEnvironment(
  { ODAI_GROK_COMMAND: process.execPath, ODAI_GROK_MODEL: "grok-test" },
  { allowProviderCommand: true },
);
const configuredGrokCliDescription = describeProviders(configuredGrokCliProviders, {
  ODAI_GROK_COMMAND: process.execPath,
  ODAI_GROK_MODEL: "grok-test",
});
assert.equal(configuredGrokCliProviders.get("grok-cli").available, true);
assert.equal(configuredGrokCliDescription.commands.grok, true);
const configuredGrokCliSource = configuredGrokCliDescription.providers.find((provider) => provider.name === "grok-cli").source;
const { command: configuredGrokCliCommand, ...configuredGrokCliSourceWithoutCommand } = configuredGrokCliSource;
assert.equal(normalizePathForCompare(configuredGrokCliCommand), normalizePathForCompare(process.execPath));
assert.deepEqual(configuredGrokCliSourceWithoutCommand, {
  type: "command",
  commandPresent: true,
  modelEnv: "ODAI_GROK_MODEL",
  modelPresent: true,
  confirmationFlag: "--use-provider-command",
  executableEnv: "ODAI_GROK_COMMAND",
  executableConfigured: true,
});
assert.equal(gatedProviders.get("codex-cli").available, false);
assert.equal(gatedProviders.get("grok-cli").available, false);
assert.equal(gatedProviders.get("ollama-local").available, false);
assert.equal(gatedProviders.get("ollama-local").blockedReason, "model_required");
const allowedProviders = createProviderRegistryFromEnvironment(
  { OPENAI_API_KEY: "present" },
  { allowApiKey: true },
);
assert.equal(allowedProviders.get("openai-api").available, false);
assert.equal(allowedProviders.get("openai-api").blockedReason, "model_required");
const allowedModeledProviders = createProviderRegistryFromEnvironment(
  { OPENAI_API_KEY: "present", ODAI_OPENAI_MODEL: "test-model" },
  { allowApiKey: true },
);
assert.equal(allowedModeledProviders.get("openai-api").available, true);
const anthropicGatedProviders = createProviderRegistryFromEnvironment({ ANTHROPIC_API_KEY: "present" });
assert.equal(anthropicGatedProviders.get("anthropic-api").available, false);
assert.equal(anthropicGatedProviders.get("anthropic-api").blockedReason, "api_key_requires_explicit_use");
const anthropicAllowedProviders = createProviderRegistryFromEnvironment(
  { ANTHROPIC_API_KEY: "present", ODAI_ANTHROPIC_MODEL: "test-model" },
  { allowApiKey: true },
);
assert.equal(anthropicAllowedProviders.get("anthropic-api").available, true);
const geminiGatedProviders = createProviderRegistryFromEnvironment({ GEMINI_API_KEY: "present" });
assert.equal(geminiGatedProviders.get("gemini-api").available, false);
assert.equal(geminiGatedProviders.get("gemini-api").blockedReason, "api_key_requires_explicit_use");
const geminiAllowedProviders = createProviderRegistryFromEnvironment(
  { GEMINI_API_KEY: "present", ODAI_GEMINI_MODEL: "gemini-test" },
  { allowApiKey: true },
);
assert.equal(geminiAllowedProviders.get("gemini-api").available, true);
const deepseekGatedProviders = createProviderRegistryFromEnvironment({
  DEEPSEEK_API_KEY: "present",
  ODAI_DEEPSEEK_MODEL: "deepseek-v4-flash",
});
assert.equal(deepseekGatedProviders.get("deepseek-api").available, false);
assert.equal(deepseekGatedProviders.get("deepseek-api").blockedReason, "api_key_requires_explicit_use");
const deepseekAllowedProviders = createProviderRegistryFromEnvironment(
  { DEEPSEEK_API_KEY: "present", ODAI_DEEPSEEK_MODEL: "deepseek-v4-flash" },
  { allowApiKey: true },
);
assert.equal(deepseekAllowedProviders.get("deepseek-api").available, true);
const ollamaModeledProviders = createProviderRegistryFromEnvironment({ ODAI_OLLAMA_MODEL: "llama3.2" });
assert.equal(ollamaModeledProviders.get("ollama-local").available, true);
assert.equal(describeProviders(ollamaModeledProviders, { ODAI_OLLAMA_MODEL: "llama3.2" }).local.ollamaModel, true);
const configuredProviders = createProviderRegistryFromEnvironment(
  { CUSTOM_PROVIDER_KEY: "present" },
  {
    config: {
      providers: [
        {
          type: "openai-compatible",
          name: "custom-chat",
          baseUrl: "https://compat.example/v1",
          apiKeyEnv: "CUSTOM_PROVIDER_KEY",
          model: "compat-model",
        },
      ],
    },
  },
);
const configuredProvider = configuredProviders.get("custom-chat");
assert.equal(configuredProvider.available, false);
assert.equal(configuredProvider.blockedReason, "api_key_requires_explicit_use");
const configuredProviderDescription = describeProviders(configuredProviders, { CUSTOM_PROVIDER_KEY: "present" });
assert.deepEqual(configuredProviderDescription.providers.find((provider) => provider.name === "custom-chat").source, {
  type: "openai-compatible",
  baseUrl: "https://compat.example/v1",
  apiKeyEnv: "CUSTOM_PROVIDER_KEY",
  apiKeyPresent: true,
  modelPresent: true,
  configured: true,
});
assert.ok(!JSON.stringify(configuredProviderDescription).includes("CUSTOM_PROVIDER_KEY=present"));
const configuredProviderMissingModel = createProviderRegistryFromEnvironment(
  { CUSTOM_PROVIDER_KEY: "present" },
  {
    config: {
      providers: [
        {
          type: "openai-compatible",
          name: "custom-chat-missing-model",
          baseUrl: "https://compat.example/v1",
          apiKeyEnv: "CUSTOM_PROVIDER_KEY",
        },
      ],
    },
  },
).get("custom-chat-missing-model");
assert.equal(configuredProviderMissingModel.available, false);
assert.equal(configuredProviderMissingModel.blockedReason, "api_key_requires_explicit_use");
const configuredProviderMissingModelOverride = withProviderModelOverride(
  configuredProviderMissingModel,
  "compat-override",
);
assert.equal(configuredProviderMissingModelOverride.available, false);
assert.equal(configuredProviderMissingModelOverride.blockedReason, "api_key_requires_explicit_use");
const builtInOverrideProviders = createProviderRegistryFromEnvironment(
  {},
  {
    config: {
      providers: [
        {
          type: "command-json",
          name: "openai-api",
          command: "node",
        },
      ],
    },
  },
);
assert.equal(builtInOverrideProviders.get("openai-api").kind, "api");
const builtInOverrideDescription = describeProviders(builtInOverrideProviders, {});
assert.equal(
  builtInOverrideDescription.providers.find((provider) => provider.name === "openai-api").kind,
  "api",
);
assert.ok(
  builtInOverrideDescription.configErrors.some((error) =>
    /cannot override built-in provider: openai-api/.test(error.message),
  ),
);
const sensitiveSourceProviders = createProviderRegistryFromEnvironment(
  {},
  {
    config: {
      providers: [
        {
          type: "openai-compatible",
          name: "sensitive-source-chat",
          baseUrl: "https://user:pass@compat.example/v1?token=source-secret-token",
          model: "compat-model",
        },
        {
          type: "command-json",
          name: "sensitive-command-source",
          command: "sk-source-command-secret",
        },
      ],
    },
  },
);
const sensitiveSourceDescription = describeProviders(sensitiveSourceProviders, {});
const sensitiveSourceJson = JSON.stringify(sensitiveSourceDescription);
assert.ok(!sensitiveSourceJson.includes("source-secret-token"));
assert.ok(!sensitiveSourceJson.includes("sk-source-command-secret"));
assert.ok(sensitiveSourceJson.includes("[redacted]"));
const sensitiveConfigErrorDescription = describeProviders(
  createProviderRegistryFromEnvironment(
    {},
    {
      config: {
        providers: [],
        errors: [
          {
            file: "/tmp/provider-token=provider-config-secret.json",
            field: "providers[0].token",
            provider: "provider-token=provider-name-secret",
            type: "command-json",
            message: "token=provider-config-secret Bearer provider-config-bearer-secret",
            raw: "must-not-be-exposed",
          },
        ],
      },
    },
  ),
  {},
);
const sensitiveConfigErrorJson = JSON.stringify(sensitiveConfigErrorDescription.configErrors);
assert.ok(!sensitiveConfigErrorJson.includes("provider-config-secret"));
assert.ok(!sensitiveConfigErrorJson.includes("provider-name-secret"));
assert.ok(!sensitiveConfigErrorJson.includes("provider-config-bearer-secret"));
assert.ok(!sensitiveConfigErrorJson.includes("must-not-be-exposed"));
assert.ok(sensitiveConfigErrorJson.includes("[redacted]"));
assert.equal(sensitiveConfigErrorDescription.configErrors[0].type, "command-json");
const modelMissingConfiguredProviders = createProviderRegistryFromEnvironment(
  {},
  {
    allowApiKey: true,
    config: {
      providers: [
        {
          type: "openai-compatible",
          name: "model-missing-chat",
          baseUrl: "https://compat.example/v1",
        },
      ],
    },
  },
);
assert.equal(modelMissingConfiguredProviders.get("model-missing-chat").available, false);
assert.equal(modelMissingConfiguredProviders.get("model-missing-chat").blockedReason, "model_required");
const providerCauseRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-provider-cause-"));
await mkdir(path.join(providerCauseRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(providerCauseRoot, ".odai", "providers.json"),
  `${JSON.stringify({
    providers: [
      {
        type: "openai-compatible",
        name: "cause-chat",
        baseUrl: "https://cause.example/v1",
        apiKeyEnv: "CAUSE_CHAT_API_KEY",
      },
    ],
  })}\n`,
  "utf8",
);
const fetchCause = new Error("connect ECONNRESET token=provider-cause-secret");
fetchCause.code = "ECONNRESET";
const fetchError = new TypeError("fetch failed");
fetchError.cause = fetchCause;
const providerCauseDoctor = await runDoctor({
  repoRoot: providerCauseRoot,
  env: { CAUSE_CHAT_API_KEY: "present" },
  argv: ["--provider", "cause-chat", "--use-api-key", "--model", "cause-model"],
  fetchImpl: async () => {
    throw fetchError;
  },
});
assert.equal(providerCauseDoctor.status, "failed");
assert.equal(providerCauseDoctor.error.message, "fetch failed");
assert.equal(providerCauseDoctor.error.cause.code, "ECONNRESET");
assert.ok(!JSON.stringify(providerCauseDoctor).includes("provider-cause-secret"));
assert.ok(JSON.stringify(providerCauseDoctor.error.cause).includes("[redacted]"));
const commandConfiguredProviders = createProviderRegistryFromEnvironment(
  {},
  {
    config: {
      providers: [
        {
          type: "command-json",
          name: "local-command-model",
          command: "node",
          args: ["--version"],
          modelArgs: ["--model", "{model}"],
        },
      ],
    },
  },
);
const commandConfiguredProvider = commandConfiguredProviders.get("local-command-model");
assert.equal(commandConfiguredProvider.available, false);
assert.equal(commandConfiguredProvider.blockedReason, "provider_command_requires_explicit_use");
assert.deepEqual(
  describeProviders(commandConfiguredProviders, {}).providers.find((provider) => provider.name === "local-command-model")
    .source,
  {
    type: "command",
    command: "node",
    commandPresent: true,
    inputMode: "stdin",
    modelArgsPresent: true,
    configured: true,
    confirmationFlag: "--use-provider-command",
  },
);
const commandAllowedProviders = createProviderRegistryFromEnvironment(
  {},
  {
    allowProviderCommand: true,
    config: {
      providers: [
        {
          type: "command-json",
          name: "local-command-model",
          command: "node",
          args: ["--version"],
        },
      ],
    },
  },
);
assert.equal(commandAllowedProviders.get("local-command-model").available, true);
const mixedProviderConfigRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-mixed-provider-config-"));
await mkdir(path.join(mixedProviderConfigRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(mixedProviderConfigRoot, ".odai", "providers.json"),
  `${JSON.stringify(
    {
      providers: [
        {
          type: "command-json",
          name: "valid-command-config",
          command: "node",
          args: ["--version"],
        },
        {
          type: "unknown-provider",
          name: "bad-type",
        },
        {
          type: "command-json",
          name: "missing-command",
        },
        {
          type: "command-json",
          name: "bad-model-args",
          command: "node",
          modelArgs: ["--model", ""],
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const mixedProviderConfig = loadWorkspaceProviderConfig({ workspaceRoot: mixedProviderConfigRoot });
assert.equal(mixedProviderConfig.providers.length, 1);
assert.equal(mixedProviderConfig.providers[0].name, "valid-command-config");
assert.equal(mixedProviderConfig.errors.length, 3);
assert.ok(mixedProviderConfig.errors.some((error) => /Unsupported provider config type/.test(error.message)));
assert.ok(mixedProviderConfig.errors.some((error) => /requires a non-empty command/.test(error.message)));
assert.ok(mixedProviderConfig.errors.some((error) => /modelArgs must be an array of strings/.test(error.message)));
const mixedProviderRegistry = createProviderRegistryFromEnvironment(
  {},
  {
    config: mixedProviderConfig,
  },
);
assert.equal(mixedProviderRegistry.get("valid-command-config").blockedReason, "provider_command_requires_explicit_use");
const mixedProviderDescription = describeProviders(mixedProviderRegistry, {});
assert.ok(mixedProviderDescription.configErrors.some((error) => error.field === "providers[1].type"));
const tokenLikeProviderNameRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-token-like-provider-name-"));
await mkdir(path.join(tokenLikeProviderNameRoot, ".odai"), { recursive: true });
await writeFile(
  path.join(tokenLikeProviderNameRoot, ".odai", "providers.json"),
  `${JSON.stringify(
    {
      providers: [
        {
          type: "command-json",
          name: "token=provider-name-secret",
          command: "node",
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const tokenLikeProviderConfig = loadWorkspaceProviderConfig({ workspaceRoot: tokenLikeProviderNameRoot });
assert.deepEqual(tokenLikeProviderConfig.providers, []);
assert.equal(tokenLikeProviderConfig.errors[0].field, "providers[0].name");
const tokenLikeProviderDescription = describeProviders(
  createProviderRegistryFromEnvironment({}, { config: tokenLikeProviderConfig }),
  {},
);
const tokenLikeProviderDescriptionJson = JSON.stringify(tokenLikeProviderDescription);
assert.ok(tokenLikeProviderDescription.configErrors.some((error) => /Invalid provider name/.test(error.message)));
assert.ok(!tokenLikeProviderDescription.providers.some((provider) => provider.name === "token=provider-name-secret"));
assert.ok(!tokenLikeProviderDescriptionJson.includes("provider-name-secret"));
assert.ok(tokenLikeProviderDescriptionJson.includes("[redacted]"));
const invalidProviderConfigRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-invalid-provider-config-"));
await mkdir(path.join(invalidProviderConfigRoot, ".odai"), { recursive: true });
await writeFile(path.join(invalidProviderConfigRoot, ".odai", "providers.json"), "{ invalid json\n", "utf8");
const invalidProviderConfig = loadWorkspaceProviderConfig({ workspaceRoot: invalidProviderConfigRoot });
assert.deepEqual(invalidProviderConfig.providers, []);
assert.match(invalidProviderConfig.errors[0].message, /Failed to read provider config/);
const invalidProviderDescription = describeProviders(
  createProviderRegistryFromEnvironment({}, { config: invalidProviderConfig }),
  {},
);
assert.match(invalidProviderDescription.configErrors[0].message, /Failed to read provider config/);
const ollamaConfiguredProviders = createProviderRegistryFromEnvironment(
  {},
  {
    config: {
      providers: [
        {
          type: "ollama",
          name: "local-llama",
          baseUrl: "http://localhost:11434",
          model: "llama3.2",
        },
      ],
    },
  },
);
assert.equal(ollamaConfiguredProviders.get("local-llama").available, true);

const doctorList = await runDoctor({ repoRoot, env: {} });
assert.equal(doctorList.status, "ready");
assert.ok(Array.isArray(doctorList.providers.providers));
assert.match(doctorList.note, /--provider/);
const governance = runGovernance();
assert.equal(governance.status, "ready");
assert.equal(governance.kind, "runtime-governance");
assert.equal(governance.rulesSource, "skills/odai");
assert.equal(governance.summary.total, 18);
assert.equal(governance.summary.covered, 18);
assert.equal(governance.summary.missingCanary, 0);
assert.deepEqual(governance.checks.duplicateIds, []);
assert.deepEqual(governance.checks.missingCanary, []);
assert.ok(governance.entries.every((entry) => entry.status === "covered"));
assert.deepEqual(
  governance.entries.flatMap((entry) => entry.canaryCases),
  [
    "C01",
    "C02",
    "C03",
    "C04",
    "C05",
    "C06",
    "C07",
    "C08",
    "C09",
    "C10",
    "C11",
    "C12",
    "C13",
    "C14",
    "C15",
    "C16",
    "C17",
    "C18",
  ],
);
const doctorGovernance = await runDoctor({ repoRoot, env: {}, argv: ["--governance"] });
assert.equal(doctorGovernance.status, "ready");
assert.equal(doctorGovernance.kind, "runtime-governance");
assert.equal(doctorGovernance.summary.covered, 18);
const savedDoctorGovernance = await runDoctor({ repoRoot, env: {}, argv: ["--governance", "--save"] });
assert.ok(savedDoctorGovernance.savedRecordPath);
const continuedDoctorGovernanceSummary = await continueLatestRun({ repoRoot });
assert.match(continuedDoctorGovernanceSummary.note, /runtime governance audit/);
const continuedDoctorGovernance = await continueLatestRun({ repoRoot, argv: ["--run"] });
assert.equal(continuedDoctorGovernance.status, "ready");
assert.equal(continuedDoctorGovernance.kind, "runtime-governance");
assert.equal(continuedDoctorGovernance.summary.covered, 18);
const doctorStatus = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--status"] });
assert.equal(doctorStatus.status, "partial");
assert.equal(doctorStatus.kind, "odai-status");
assert.equal(doctorStatus.summary.governance, "ready");
const savedDoctorStatus = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--status", "--save"] });
assert.ok(savedDoctorStatus.savedRecordPath);
const continuedDoctorStatusSummary = await continueLatestRun({ repoRoot: initRoot });
assert.match(continuedDoctorStatusSummary.note, /odai status audit/);
assert.ok(continuedDoctorStatusSummary.notRestored.includes("api-key-confirmation"));
assert.ok(continuedDoctorStatusSummary.notRestored.includes("provider-command-confirmation"));
const continuedDoctorStatus = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorStatus.status, "partial");
assert.equal(continuedDoctorStatus.kind, "odai-status");
assert.equal(continuedDoctorStatus.summary.governance, "ready");
const doctorSetup = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--setup", "--use-provider-command=true"] });
assert.equal(doctorSetup.status, "partial");
assert.equal(doctorSetup.kind, "setup-guide");
assert.equal(doctorSetup.flags.useProviderCommand, true);
const savedDoctorSetup = await runDoctor({
  repoRoot: initRoot,
  env: {},
  argv: ["--setup", "--use-provider-command=true", "--save"],
});
assert.ok(savedDoctorSetup.savedRecordPath);
const continuedDoctorSetupSummary = await continueLatestRun({ repoRoot: initRoot });
assert.match(continuedDoctorSetupSummary.note, /setup guide/);
assert.deepEqual(continuedDoctorSetupSummary.notRestored, ["provider-command-confirmation"]);
assert.deepEqual(continuedDoctorSetupSummary.rerun.flags, ["--use-provider-command"]);
const continuedDoctorSetup = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorSetup.status, "partial");
assert.equal(continuedDoctorSetup.kind, "setup-guide");
assert.equal(continuedDoctorSetup.flags.useProviderCommand, false);
const continuedDoctorSetupWithFlag = await continueLatestRun({
  repoRoot: initRoot,
  argv: ["--run", "--use-provider-command"],
});
assert.equal(continuedDoctorSetupWithFlag.flags.useProviderCommand, true);
const doctorAudit = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--audit"] });
assert.equal(doctorAudit.status, "partial");
assert.equal(doctorAudit.kind, "completion-audit");
assert.equal(doctorAudit.complete, false);
assert.equal(doctorAudit.summary.total, 6);
const savedDoctorAudit = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--audit", "--save"] });
assert.ok(savedDoctorAudit.savedRecordPath);
const continuedDoctorAuditSummary = await continueLatestRun({ repoRoot: initRoot });
assert.match(continuedDoctorAuditSummary.note, /completion audit/);
assert.ok(continuedDoctorAuditSummary.notRestored.includes("api-key-confirmation"));
assert.ok(continuedDoctorAuditSummary.notRestored.includes("provider-command-confirmation"));
const continuedDoctorAudit = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorAudit.status, "partial");
assert.equal(continuedDoctorAudit.kind, "completion-audit");
assert.equal(continuedDoctorAudit.complete, false);
const doctorEvidence = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--evidence"] });
assert.equal(doctorEvidence.status, "partial");
assert.equal(doctorEvidence.kind, "external-evidence");
assert.equal(doctorEvidence.summary.ready, 0);
const savedDoctorEvidence = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--evidence", "--save"] });
assert.ok(savedDoctorEvidence.savedRecordPath);
const continuedDoctorEvidenceSummary = await continueLatestRun({ repoRoot: initRoot });
assert.match(continuedDoctorEvidenceSummary.note, /saved external evidence audit/);
const continuedDoctorEvidence = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorEvidence.status, "partial");
assert.equal(continuedDoctorEvidence.kind, "external-evidence");
assert.equal(continuedDoctorEvidence.summary.ready, 0);
const acceptance = runAcceptance();
assert.equal(acceptance.status, "partial");
assert.equal(acceptance.kind, "plan-acceptance");
assert.equal(acceptance.summary.total, 9);
assert.equal(acceptance.summary.ready, 8);
assert.equal(acceptance.summary["needs-external-evidence"], 1);
assert.equal(acceptance.items.find((item) => item.id === "A02").status, "needs-external-evidence");
assert.equal(acceptance.items.find((item) => item.id === "A09").status, "ready");
assert.equal(acceptance.externalReadiness.kind, "e2e-readiness");
assert.equal(acceptance.items.find((item) => item.id === "A02").externalReadiness.kind, "e2e-readiness");
assert.ok(acceptance.items.find((item) => item.id === "A02").remaining[0].includes("odai e2e"));
assert.ok(acceptance.items.find((item) => item.id === "A02").remaining[1].includes("odai doctor --all"));
const flaggedAcceptance = runAcceptance({
  repoRoot: initRoot,
  env: {
    OPENAI_API_KEY: "test",
    ODAI_OPENAI_MODEL: "test-model",
  },
  argv: ["--use-api-key", "--use-provider-command"],
});
assert.equal(flaggedAcceptance.externalReadiness.status, "partial");
assert.ok(flaggedAcceptance.externalReadiness.summary.ready >= 1);
assert.equal(
  flaggedAcceptance.externalReadiness.requirements.find((item) => item.id === "provider-api").status,
  "ready",
);
assert.equal(flaggedAcceptance.items.find((item) => item.id === "A02").status, "needs-external-evidence");
const doctorAcceptance = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--acceptance"] });
assert.equal(doctorAcceptance.status, "partial");
assert.equal(doctorAcceptance.kind, "plan-acceptance");
assert.equal(doctorAcceptance.summary.ready, 8);
assert.equal(doctorAcceptance.externalReadiness.status, "partial");
const flaggedDoctorAcceptance = await runDoctor({
  repoRoot: initRoot,
  env: {
    OPENAI_API_KEY: "test",
    ODAI_OPENAI_MODEL: "test-model",
  },
  argv: ["--acceptance", "--use-api-key", "--use-provider-command"],
});
assert.equal(
  flaggedDoctorAcceptance.externalReadiness.requirements.find((item) => item.id === "provider-api").status,
  "ready",
);
assert.equal(flaggedDoctorAcceptance.items.find((item) => item.id === "A02").status, "needs-external-evidence");
const modelOverrideAcceptance = runAcceptance({
  repoRoot: initRoot,
  env: { OPENAI_API_KEY: "test" },
  argv: ["--use-api-key", "--model", "test-model"],
});
assert.equal(
  modelOverrideAcceptance.externalReadiness.requirements.find((item) => item.id === "provider-api").status,
  "ready",
);
const modelOverrideMilestones = runMilestones({
  repoRoot: initRoot,
  env: { OPENAI_API_KEY: "test" },
  argv: ["--use-api-key", "--model", "test-model"],
});
assert.equal(
  modelOverrideMilestones.items
    .find((item) => item.id === "P0-1")
    .externalReadiness.requirements.find((item) => item.id === "provider-api").status,
  "ready",
);
const savedDoctorAcceptance = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--acceptance", "--save"] });
assert.ok(savedDoctorAcceptance.savedRecordPath);
const continuedDoctorAcceptanceSummary = await continueLatestRun({ repoRoot: initRoot });
assert.match(continuedDoctorAcceptanceSummary.note, /plan acceptance audit/);
const continuedDoctorAcceptance = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorAcceptance.status, "partial");
assert.equal(continuedDoctorAcceptance.kind, "plan-acceptance");
assert.equal(continuedDoctorAcceptance.summary["needs-external-evidence"], 1);
assert.equal(continuedDoctorAcceptance.externalReadiness.status, "partial");
const milestones = runMilestones({ repoRoot: initRoot, env: {} });
assert.equal(milestones.status, "partial");
assert.equal(milestones.kind, "plan-milestones");
assert.equal(milestones.summary.total, 16);
assert.equal(milestones.summary.ready, 14);
assert.equal(milestones.summary.partial, 1);
assert.equal(milestones.summary["needs-external-evidence"], 1);
assert.equal(milestones.summary.byPhase["Phase 0"].total, 5);
assert.equal(milestones.summary.byPhase["Phase 1"].ready, 6);
assert.equal(milestones.summary.byPhase["Phase 2"].partial, 1);
assert.equal(milestones.items.find((item) => item.id === "P0-1").status, "needs-external-evidence");
assert.equal(milestones.items.find((item) => item.id === "P0-1").externalReadiness.kind, "e2e-readiness");
assert.equal(milestones.items.find((item) => item.id === "P2-5").status, "partial");
assert.ok(milestones.items.find((item) => item.id === "P2-5").remaining[0].includes("odai sandbox"));
const doctorMilestones = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--milestones"] });
assert.equal(doctorMilestones.status, "partial");
assert.equal(doctorMilestones.kind, "plan-milestones");
assert.equal(doctorMilestones.summary.total, 16);
const savedDoctorMilestones = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--milestones", "--save"] });
assert.ok(savedDoctorMilestones.savedRecordPath);
const continuedDoctorMilestonesSummary = await continueLatestRun({ repoRoot: initRoot });
assert.match(continuedDoctorMilestonesSummary.note, /plan milestones audit/);
const continuedDoctorMilestones = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorMilestones.status, "partial");
assert.equal(continuedDoctorMilestones.kind, "plan-milestones");
assert.equal(continuedDoctorMilestones.summary.total, 16);
const status = runStatus({ repoRoot: initRoot, env: {} });
assert.equal(status.status, "partial");
assert.equal(status.kind, "odai-status");
assert.equal(status.summary.governance, "ready");
assert.equal(status.summary.governanceCovered, 18);
assert.equal(status.summary.acceptanceReady, 8);
assert.equal(status.summary.acceptanceTotal, 9);
assert.equal(status.summary.milestonesReady, 14);
assert.equal(status.summary.e2eReadiness, "partial");
assert.ok(status.blockers.some((blocker) => blocker.id === "A02"));
assert.ok(status.blockers.some((blocker) => blocker.id === "P0-1"));
assert.ok(status.blockers.some((blocker) => blocker.id === "P2-5"));
assert.ok(status.next.some((action) => action.includes("odai e2e")));
assert.equal(
  status.next.filter((action) => action.includes("odai e2e --use-api-key --use-provider-command")).length,
  1,
);
assert.equal(
  status.next.filter((action) => action.includes("odai doctor --all --use-api-key --use-provider-command --save"))
    .length,
  1,
);
assert.equal(
  status.next.filter((action) => action.includes("odai doctor --sandbox --smoke --allow-shell --save")).length,
  1,
);
const audit = runAudit({ repoRoot: initRoot, env: {} });
assert.equal(audit.status, "partial");
assert.equal(audit.kind, "completion-audit");
assert.equal(audit.complete, false);
assert.equal(audit.summary.ready, 1);
assert.equal(audit.summary.blocked, 5);
assert.ok(audit.requirements.some((requirement) => requirement.id === "runtime-governance" && requirement.status === "ready"));
assert.ok(audit.requirements.some((requirement) => requirement.id === "plan-acceptance" && requirement.status === "blocked"));
assert.ok(audit.requirements.some((requirement) => requirement.id === "executable-milestones" && requirement.status === "blocked"));
assert.ok(
  audit.requirements.some((requirement) => requirement.id === "saved-provider-api-and-runtime" && requirement.status === "blocked"),
);
assert.ok(
  audit.requirements.some((requirement) => requirement.id === "saved-provider-subscription-cli" && requirement.status === "blocked"),
);
assert.ok(
  audit.requirements.some((requirement) => requirement.id === "saved-strong-sandbox-smoke" && requirement.status === "blocked"),
);
const externalEvidenceRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-external-evidence-"));
const externalRunsDir = path.join(externalEvidenceRoot, ".odai", "runs");
await mkdir(externalRunsDir, { recursive: true });
await writeFile(
  path.join(externalRunsDir, "provider-evidence.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      status: "ready",
      probes: [
        {
          status: "ready",
          provider: {
            name: "openai-api",
            kind: "api",
            auth: "api_key",
            source: {
              type: "env",
              apiKeyEnv: "OPENAI_API_KEY",
              modelEnv: "ODAI_OPENAI_MODEL",
              baseUrl: "https://user:pass@api.example/v1?token=saved-source-token",
              apiKeyPresent: true,
              modelPresent: true,
            },
            available: true,
            capabilities: ["reasoning"],
            cost: "unknown",
          },
          probe: { text: "ok" },
        },
        {
          status: "ready",
          provider: {
            name: "claude-agent-sdk",
            kind: "subscription-sdk",
            auth: "subscription_or_api_key",
            source: {
              type: "package",
              package: "@anthropic-ai/claude-agent-sdk",
              packagePresent: true,
              confirmationFlag: "--use-provider-command",
            },
            available: true,
            capabilities: ["tool_loop"],
            cost: "unknown",
          },
          probe: { text: "ok" },
        },
        {
          status: "ready",
          provider: {
            name: "mock-main",
            kind: "mock",
            auth: "none",
            available: true,
          },
          probe: { text: "ignored mock" },
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await writeFile(
  path.join(externalRunsDir, "provider-token=saved-record-id-secret.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      status: "ready",
      provider: {
        name: "codex-cli",
        kind: "subscription-cli",
        auth: "subscription_or_api_key",
        source: {
          type: "command",
          command: "codex",
          commandPresent: true,
          confirmationFlag: "--use-provider-command",
        },
        available: true,
        capabilities: ["reasoning", "code"],
      },
      probe: { text: "ok" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await writeFile(
  path.join(externalRunsDir, "sandbox-smoke.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      kind: "sandbox-smoke",
      status: "ready",
      result: {
        ok: true,
        type: "shell",
        command: [
          process.execPath,
          "-e",
          "console.log('odai-sandbox-smoke')",
          "--token",
          "saved-sandbox-token",
          "API_KEY=saved-sandbox-api-key",
          "https://example.test/?token=saved-url-token",
        ],
        status: 0,
        sandbox: { mode: "docker", image: "node:22-alpine" },
      },
      escapeProbe: {
        hostEscapeCreated: false,
        result: {
          ok: false,
          status: 1,
          sandbox: { mode: "docker", image: "node:22-alpine" },
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const externalEvidence = describeExternalEvidence({ workspaceRoot: externalEvidenceRoot });
const externalEvidenceJson = JSON.stringify(externalEvidence);
assert.equal(externalEvidence.status, "ready");
assert.equal(externalEvidence.summary.apiProviders, 1);
assert.equal(externalEvidence.summary.claudeRuntimeProviders, 1);
assert.equal(externalEvidence.summary.subscriptionRuntimeProviders, 2);
assert.equal(externalEvidence.summary.subscriptionCliProviders, 1);
assert.equal(externalEvidence.summary.strongSandboxSmokes, 1);
assert.equal(externalEvidence.providerEvidence.apiProviders[0].recordId, "provider-evidence.json");
assert.ok(externalEvidence.providerEvidence.subscriptionCliProviders[0].recordId.includes("[redacted]"));
assert.equal(externalEvidence.providerEvidence.apiProviders[0].provider.source.apiKeyEnv, "OPENAI_API_KEY");
assert.ok(!externalEvidenceJson.includes(externalEvidenceRoot));
assert.ok(!externalEvidenceJson.includes(externalRunsDir));
assert.ok(!externalEvidenceJson.includes("sourcePath"));
assert.ok(!externalEvidenceJson.includes("recordsDirectory"));
assert.ok(!externalEvidenceJson.includes("workspaceRoot"));
assert.ok(!externalEvidenceJson.includes("saved-record-id-secret"));
assert.ok(!externalEvidenceJson.includes("saved-source-token"));
assert.ok(!externalEvidenceJson.includes("user:pass"));
assert.ok(!externalEvidenceJson.includes("saved-sandbox-token"));
assert.ok(!externalEvidenceJson.includes("saved-sandbox-api-key"));
assert.ok(!externalEvidenceJson.includes("saved-url-token"));
assert.ok(externalEvidenceJson.includes("[redacted]"));
assert.equal(externalEvidence.providerEvidence.claudeRuntimeProviders[0].provider.source.package, "@anthropic-ai/claude-agent-sdk");
assert.ok(externalEvidence.providerEvidence.subscriptionRuntimeProviders.some((item) => item.provider.name === "codex-cli"));
assert.equal(
  externalEvidence.requirements.find((requirement) => requirement.id === "provider-api-and-runtime").status,
  "ready",
);
assert.equal(
  externalEvidence.requirements.find((requirement) => requirement.id === "strong-sandbox-smoke").status,
  "ready",
);
const runEvidenceReport = runEvidence({ repoRoot: externalEvidenceRoot });
assert.equal(runEvidenceReport.status, "ready");
assert.equal(runEvidenceReport.kind, "external-evidence");
assert.equal(runEvidenceReport.summary.apiProviders, 1);
assert.equal(runEvidenceReport.summary.claudeRuntimeProviders, 1);
assert.equal(runEvidenceReport.summary.subscriptionRuntimeProviders, 2);
assert.equal(runEvidenceReport.summary.strongSandboxSmokes, 1);
const upgradedAcceptance = runAcceptance({ repoRoot: externalEvidenceRoot, env: {} });
assert.equal(upgradedAcceptance.status, "ready");
assert.equal(upgradedAcceptance.summary.ready, 9);
assert.equal(upgradedAcceptance.summary["needs-external-evidence"], 0);
assert.equal(upgradedAcceptance.items.find((item) => item.id === "A02").status, "ready");
assert.equal(upgradedAcceptance.items.find((item) => item.id === "A09").status, "ready");
assert.equal(upgradedAcceptance.items.find((item) => item.id === "A02").externalEvidence.status, "ready");
const upgradedMilestones = runMilestones({ repoRoot: externalEvidenceRoot, env: {} });
assert.equal(upgradedMilestones.status, "ready");
assert.equal(upgradedMilestones.summary.ready, 16);
assert.equal(upgradedMilestones.summary.partial, 0);
assert.equal(upgradedMilestones.summary["needs-external-evidence"], 0);
assert.equal(upgradedMilestones.items.find((item) => item.id === "P0-1").status, "ready");
assert.equal(upgradedMilestones.items.find((item) => item.id === "P2-5").status, "ready");
const upgradedStatus = runStatus({ repoRoot: externalEvidenceRoot, env: {} });
assert.equal(upgradedStatus.status, "ready");
assert.equal(upgradedStatus.summary.acceptance, "ready");
assert.equal(upgradedStatus.summary.milestones, "ready");
assert.equal(upgradedStatus.summary.savedExternalEvidence, "ready");
assert.deepEqual(upgradedStatus.blockers, []);
const upgradedAudit = runAudit({ repoRoot: externalEvidenceRoot, env: {} });
assert.equal(upgradedAudit.status, "ready");
assert.equal(upgradedAudit.complete, true);
assert.equal(upgradedAudit.summary.ready, upgradedAudit.summary.total);
assert.deepEqual(upgradedAudit.blockers, []);
const separateProviderEvidenceRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-separate-provider-evidence-"));
const separateProviderRunsDir = path.join(separateProviderEvidenceRoot, ".odai", "runs");
await mkdir(separateProviderRunsDir, { recursive: true });
await writeFile(
  path.join(separateProviderRunsDir, "api-provider.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      status: "ready",
      provider: {
        name: "openai-api",
        kind: "api",
        auth: "api_key",
        source: {
          type: "env",
          apiKeyEnv: "OPENAI_API_KEY",
          modelEnv: "ODAI_OPENAI_MODEL",
          apiKeyPresent: true,
          modelPresent: true,
        },
        available: true,
        capabilities: ["reasoning"],
        cost: "unknown",
      },
      probe: { text: "api ok" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await writeFile(
  path.join(separateProviderRunsDir, "claude-provider.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      status: "ready",
      provider: {
        name: "claude-cli",
        kind: "subscription-cli",
        auth: "subscription_or_api_key",
        source: {
          type: "command",
          command: "claude",
          commandPresent: true,
          confirmationFlag: "--use-provider-command",
        },
        available: true,
        capabilities: ["reasoning", "code"],
        cost: "unknown",
      },
      probe: { text: "claude ok" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const separateProviderEvidence = describeExternalEvidence({ workspaceRoot: separateProviderEvidenceRoot });
assert.equal(
  separateProviderEvidence.requirements.find((requirement) => requirement.id === "provider-api-and-runtime").status,
  "ready",
);
assert.equal(
  separateProviderEvidence.requirements.find((requirement) => requirement.id === "strong-sandbox-smoke").status,
  "blocked",
);
const separateProviderAcceptance = runAcceptance({ repoRoot: separateProviderEvidenceRoot, env: {} });
assert.equal(separateProviderAcceptance.status, "ready");
assert.equal(separateProviderAcceptance.items.find((item) => item.id === "A02").status, "ready");
const separateProviderMilestones = runMilestones({ repoRoot: separateProviderEvidenceRoot, env: {} });
assert.equal(separateProviderMilestones.status, "partial");
assert.equal(separateProviderMilestones.items.find((item) => item.id === "P0-1").status, "ready");
assert.equal(separateProviderMilestones.items.find((item) => item.id === "P2-5").status, "partial");
const skippedClaudeCompleteRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-skipped-claude-complete-"));
const skippedClaudeCompleteRunsDir = path.join(skippedClaudeCompleteRoot, ".odai", "runs");
await mkdir(skippedClaudeCompleteRunsDir, { recursive: true });
await writeFile(
  path.join(skippedClaudeCompleteRunsDir, "api-provider.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      status: "ready",
      provider: {
        name: "openai-api",
        kind: "api",
        auth: "api_key",
        source: {
          type: "env",
          apiKeyEnv: "OPENAI_API_KEY",
          modelEnv: "ODAI_OPENAI_MODEL",
          apiKeyPresent: true,
          modelPresent: true,
        },
        available: true,
        capabilities: ["reasoning"],
        cost: "unknown",
      },
      probe: { text: "api ok" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await writeFile(
  path.join(skippedClaudeCompleteRunsDir, "codex-provider.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      status: "ready",
      provider: {
        name: "codex-cli",
        kind: "subscription-cli",
        auth: "subscription_or_api_key",
        source: {
          type: "command",
          command: "codex",
          commandPresent: true,
          confirmationFlag: "--use-provider-command",
        },
        available: true,
        capabilities: ["reasoning", "code"],
      },
      probe: { text: "codex ok" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await writeFile(
  path.join(skippedClaudeCompleteRunsDir, "sandbox-smoke.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      kind: "sandbox-smoke",
      status: "ready",
      result: {
        ok: true,
        type: "shell",
        status: 0,
        sandbox: { mode: "docker", image: "node:22-alpine" },
      },
      escapeProbe: {
        hostEscapeCreated: false,
        result: {
          ok: false,
          status: 1,
          sandbox: { mode: "docker", image: "node:22-alpine" },
        },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const skippedClaudeCompleteStatus = runStatus({
  repoRoot: skippedClaudeCompleteRoot,
  env: { OPENAI_API_KEY: "test-key", ODAI_OPENAI_MODEL: "test-model" },
  argv: ["--use-api-key", "--use-provider-command"],
});
assert.equal(
  skippedClaudeCompleteStatus.externalEvidence.requirements.find(
    (requirement) => requirement.id === "provider-api-and-runtime",
  ).status,
  "ready",
);
assert.equal(skippedClaudeCompleteStatus.status, "ready");
assert.deepEqual(skippedClaudeCompleteStatus.runnableCommands, []);
assert.deepEqual(skippedClaudeCompleteStatus.next, []);
assert.ok(!JSON.stringify(skippedClaudeCompleteStatus).includes("auth login claude-cli"));
assert.ok(!JSON.stringify(skippedClaudeCompleteStatus).includes("claude-cli --use-provider-command"));
const readinessOnlyEvidenceRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-readiness-only-evidence-"));
const readinessOnlyRunsDir = path.join(readinessOnlyEvidenceRoot, ".odai", "runs");
await mkdir(readinessOnlyRunsDir, { recursive: true });
await writeFile(
  path.join(readinessOnlyRunsDir, "readiness-only.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      kind: "sandbox-readiness",
      status: "ready",
      summary: { configuredStrong: true },
      configured: { status: "ready", sandbox: { mode: "docker" } },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const readinessOnlyEvidence = describeExternalEvidence({ workspaceRoot: readinessOnlyEvidenceRoot });
assert.equal(readinessOnlyEvidence.status, "partial");
assert.equal(readinessOnlyEvidence.summary.strongSandboxSmokes, 0);
assert.equal(
  readinessOnlyEvidence.requirements.find((requirement) => requirement.id === "strong-sandbox-smoke").status,
  "blocked",
);
const readinessOnlyMilestones = runMilestones({ repoRoot: readinessOnlyEvidenceRoot, env: {} });
assert.equal(readinessOnlyMilestones.items.find((item) => item.id === "P2-5").status, "partial");
const weakSandboxSmokeEvidenceRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-weak-sandbox-smoke-evidence-"));
const weakSandboxSmokeRunsDir = path.join(weakSandboxSmokeEvidenceRoot, ".odai", "runs");
await mkdir(weakSandboxSmokeRunsDir, { recursive: true });
await writeFile(
  path.join(weakSandboxSmokeRunsDir, "weak-sandbox-smoke.json"),
  `${JSON.stringify(
    {
      mode: "doctor",
      kind: "sandbox-smoke",
      status: "ready",
      result: {
        ok: true,
        type: "shell",
        status: 0,
        sandbox: { mode: "docker", image: "node:22-alpine" },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const weakSandboxSmokeEvidence = describeExternalEvidence({ workspaceRoot: weakSandboxSmokeEvidenceRoot });
assert.equal(weakSandboxSmokeEvidence.summary.strongSandboxSmokes, 0);
assert.equal(
  weakSandboxSmokeEvidence.requirements.find((requirement) => requirement.id === "strong-sandbox-smoke").status,
  "blocked",
);
const doctorSandbox = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--sandbox"] });
assert.equal(doctorSandbox.status, "partial");
assert.equal(doctorSandbox.kind, "sandbox-readiness");
assert.equal(doctorSandbox.configured.status, "not-isolated");
const doctorSandboxSmoke = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--sandbox", "--smoke"] });
assert.equal(doctorSandboxSmoke.status, "blocked");
assert.equal(doctorSandboxSmoke.kind, "sandbox-smoke");
assert.match(doctorSandboxSmoke.reason, /explicit --allow-shell/);
const savedDoctorSandbox = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--sandbox", "--save"] });
assert.ok(savedDoctorSandbox.savedRecordPath);
const doctorSandboxSummary = await continueLatestRun({ repoRoot: initRoot });
assert.match(doctorSandboxSummary.note, /sandbox readiness audit/);
const continuedDoctorSandbox = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorSandbox.status, "partial");
assert.equal(continuedDoctorSandbox.kind, "sandbox-readiness");
assert.equal(continuedDoctorSandbox.configured.status, "not-isolated");
const savedDoctorSandboxSmoke = await runDoctor({
  repoRoot: initRoot,
  env: {},
  argv: ["--sandbox", "--smoke", "--save"],
});
assert.ok(savedDoctorSandboxSmoke.savedRecordPath);
const doctorSandboxSmokeSummary = await continueLatestRun({ repoRoot: initRoot });
assert.deepEqual(doctorSandboxSmokeSummary.notRestored, ["shell-execution-confirmation"]);
assert.deepEqual(doctorSandboxSmokeSummary.rerun.flags, ["--allow-shell"]);
assert.match(doctorSandboxSmokeSummary.note, /High-risk confirmations are not restored/);
const continuedDoctorSandboxSmoke = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorSandboxSmoke.status, "blocked");
assert.equal(continuedDoctorSandboxSmoke.kind, "sandbox-smoke");
assert.match(continuedDoctorSandboxSmoke.reason, /explicit --allow-shell/);
const continuedDoctorSandboxSmokeAllowed = await continueLatestRun({
  repoRoot: initRoot,
  argv: ["--run", "--allow-shell"],
});
assert.equal(continuedDoctorSandboxSmokeAllowed.status, "blocked");
assert.equal(continuedDoctorSandboxSmokeAllowed.kind, "sandbox-smoke");
assert.match(continuedDoctorSandboxSmokeAllowed.reason, /disabled by \.odai\/policy\.json/);
const doctorE2E = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--e2e"] });
assert.equal(doctorE2E.status, "partial");
assert.equal(doctorE2E.kind, "e2e-readiness");
assert.equal(doctorE2E.summary.total, 4);
assert.equal(doctorE2E.requirements.find((item) => item.id === "provider-api").status, "blocked");
const savedDoctorE2E = await runDoctor({ repoRoot: initRoot, env: {}, argv: ["--e2e", "--save"] });
assert.ok(savedDoctorE2E.savedRecordPath);
const continuedDoctorE2E = await continueLatestRun({ repoRoot: initRoot, argv: ["--run"] });
assert.equal(continuedDoctorE2E.status, "partial");
assert.equal(continuedDoctorE2E.kind, "e2e-readiness");
assert.equal(continuedDoctorE2E.summary.total, 4);
const doctorAll = await runDoctor({ repoRoot, env: {}, argv: ["--all"] });
assert.equal(doctorAll.status, "partial");
assert.ok(doctorAll.summary.ready >= 2);
assert.ok(doctorAll.summary.blocked >= 1);
assert.equal(doctorSummaryStatus({ ready: 2, blocked: 0, failed: 0 }), "ready");
assert.equal(doctorSummaryStatus({ ready: 2, blocked: 1, failed: 0 }), "partial");
assert.equal(doctorSummaryStatus({ ready: 2, blocked: 1, failed: 1 }), "failed");
assert.ok(doctorAll.probes.some((probe) => probe.status === "ready" && probe.provider.name === "mock-main"));
assert.ok(doctorAll.probes.some((probe) => probe.status === "blocked" && probe.provider.name === "openai-api"));
assert.equal(
  doctorAll.probes.find((probe) => probe.provider.name === "openai-api").provider.source.apiKeyEnv,
  "OPENAI_API_KEY",
);
assert.equal(doctorAll.probes.find((probe) => probe.provider.name === "mock-main").usage.calls[0].mode, "provider_probe");
const doctorMock = await runDoctor({
  repoRoot,
  env: {},
  argv: ["--provider=mock-main", "--prompt=health"],
});
assert.equal(doctorMock.status, "ready");
assert.equal(doctorMock.provider.name, "mock-main");
assert.equal(doctorMock.probe.provider, "mock-main");
assert.equal(doctorMock.probe.toolIntentCount, 0);
assert.equal(doctorMock.usage.calls.length, 1);
assert.equal(doctorMock.usage.calls[0].mode, "provider_probe");
assert.equal(doctorMock.usage.calls[0].provider, "mock-main");
assert.equal(doctorMock.usage.calls[0].providerSession.provider, "mock-main");
assert.equal(doctorMock.probe.providerSession.provider, "mock-main");
assert.equal(doctorMock.providerSessions[0].provider, "mock-main");
const doctorMockModel = await runDoctor({
  repoRoot,
  env: {},
  argv: ["--provider=mock-main", "--prompt=health", "--model", "doctor-model"],
});
assert.equal(doctorMockModel.status, "ready");
assert.equal(doctorMockModel.provider.source.modelOverridePresent, true);
assert.equal(doctorMockModel.probe.model, "doctor-model");
assert.equal(doctorMockModel.usage.calls[0].model, "doctor-model");
const savedDoctorModel = await runDoctor({
  repoRoot,
  env: {},
  argv: ["--provider=mock-main", "--prompt=health", "--model", "doctor-model", "--save"],
});
assert.ok(savedDoctorModel.savedRecordPath);
const savedDoctorModelSummary = await continueLatestRun({ repoRoot });
assert.deepEqual(savedDoctorModelSummary.notRestored, []);
const continuedDoctorModel = await continueLatestRun({ repoRoot, argv: ["--run"] });
assert.equal(continuedDoctorModel.status, "ready");
assert.equal(continuedDoctorModel.probe.model, "doctor-model");
const doctorBlocked = await runDoctor({
  repoRoot,
  env: { OPENAI_API_KEY: "present", ODAI_OPENAI_MODEL: "test-model" },
  argv: ["--provider", "openai-api"],
});
assert.equal(doctorBlocked.status, "blocked");
assert.equal(doctorBlocked.error.message, "api_key_requires_explicit_use");
const doctorBlockedWithModel = await runDoctor({
  repoRoot,
  env: { OPENAI_API_KEY: "present" },
  argv: ["--provider", "openai-api", "--model", "test-model"],
});
assert.equal(doctorBlockedWithModel.status, "blocked");
assert.equal(doctorBlockedWithModel.error.message, "api_key_requires_explicit_use");
assert.equal(doctorBlockedWithModel.provider.source.modelOverridePresent, true);
const previousFetchForCompatDoctor = globalThis.fetch;
globalThis.fetch = async (url, request) => {
  assert.equal(url, "https://compat.example/v1/chat/completions");
  const payload = JSON.parse(request.body);
  assert.equal(payload.model, "compat-model");
  return {
    ok: true,
    async json() {
      return {
        id: "compat-doctor-response",
        choices: [{ message: { content: "compat doctor ok" } }],
      };
    },
  };
};
try {
  const compatDoctorModel = await runDoctor({
    repoRoot: compatModelOverrideRoot,
    env: { COMPAT_API_KEY: "present" },
    argv: ["--provider", "compat-model-required", "--use-api-key", "--model", "compat-model"],
  });
  assert.equal(compatDoctorModel.status, "ready");
  assert.equal(compatDoctorModel.provider.source.modelOverridePresent, true);
  assert.equal(compatDoctorModel.probe.model, "compat-model");
  assert.equal(compatDoctorModel.probe.text, "compat doctor ok");
  assert.equal(compatDoctorModel.usage.calls[0].model, "compat-model");
} finally {
  globalThis.fetch = previousFetchForCompatDoctor;
}

const commandDoctorBlocked = await runDoctor({
  repoRoot: commandProviderRoot,
  env: {},
  argv: ["--provider", "node-json-e2e"],
});
assert.equal(commandDoctorBlocked.status, "blocked");
assert.equal(commandDoctorBlocked.error.message, "provider_command_requires_explicit_use");
const commandDoctorReady = await runDoctor({
  repoRoot: commandProviderRoot,
  env: {},
  argv: ["--provider", "node-json-e2e", "--use-provider-command=true"],
});
assert.equal(commandDoctorReady.status, "ready");
assert.equal(commandDoctorReady.provider.name, "node-json-e2e");
assert.equal(commandDoctorReady.provider.kind, "command-json");
assert.equal(commandDoctorReady.probe.toolIntentCount, 0);
assert.equal(commandDoctorReady.probe.providerSession.sessionId, "command-json-session-1");
assert.equal(commandDoctorReady.usage.calls[0].providerKind, "command-json");
const commandDoctorModeled = await runDoctor({
  repoRoot: commandProviderRoot,
  env: {},
  argv: ["--provider", "node-json-e2e", "--use-provider-command=true", "--model", "command-json-model"],
});
assert.equal(commandDoctorModeled.status, "ready");
assert.equal(commandDoctorModeled.provider.source.modelArgsPresent, true);
assert.equal(commandDoctorModeled.provider.source.modelOverridePresent, true);
assert.equal(commandDoctorModeled.probe.model, "command-json-model");
assert.match(commandDoctorModeled.probe.text, /model command-json-model/);
assert.equal(commandDoctorModeled.usage.calls[0].model, "command-json-model");
const commandDoctorSecretProbe = await runDoctor({
  repoRoot: commandProviderRoot,
  env: {},
  argv: ["--provider", "node-json-e2e", "--use-provider-command", "--prompt", "secret probe"],
});
assert.equal(commandDoctorSecretProbe.status, "ready");
assert.ok(!JSON.stringify(commandDoctorSecretProbe.probe).includes("doctor-probe-secret"));
assert.match(commandDoctorSecretProbe.probe.text, /\[redacted\]/);

const savedDoctor = await runDoctor({
  repoRoot,
  env: {},
  argv: ["--provider", "mock-main", "--save"],
});
assert.ok(savedDoctor.savedRecordPath);
const savedDoctorSummary = await continueLatestRun({ repoRoot });
assert.deepEqual(savedDoctorSummary.notRestored, []);
assert.equal(savedDoctorSummary.rerun.command, "odai continue --run");
assert.match(savedDoctorSummary.note, /provider probe/);
const continuedDoctor = await continueLatestRun({ repoRoot, argv: ["--run"] });
assert.equal(continuedDoctor.status, "ready");
assert.equal(continuedDoctor.provider.name, "mock-main");
const savedDoctorAll = await runDoctor({
  repoRoot,
  env: {},
  argv: ["--all", "--save"],
});
assert.ok(savedDoctorAll.savedRecordPath);
const savedDoctorAllSummary = await continueLatestRun({ repoRoot });
assert.ok(savedDoctorAllSummary.notRestored.includes("api-key-confirmation"));
assert.ok(savedDoctorAllSummary.notRestored.includes("provider-command-confirmation"));
assert.ok(savedDoctorAllSummary.rerun.flags.includes("--use-api-key"));
assert.ok(savedDoctorAllSummary.rerun.flags.includes("--use-provider-command"));
const continuedDoctorAll = await continueLatestRun({ repoRoot, argv: ["--run"] });
assert.equal(continuedDoctorAll.status, "partial");
assert.ok(continuedDoctorAll.summary.ready >= 2);
assert.ok(continuedDoctorAll.summary.blocked >= 1);

const scheduler = new Scheduler({
  providers,
  agentProfiles: createDefaultAgentProfiles(),
  dispatcher,
  evidence,
});

const subagentResult = await scheduler.runSubagent({
  profileName: "reviewer",
  providerName: "mock-reviewer",
  input: {
    task: "Review phase0 file.",
    files: [sampleFile],
  },
});
assert.equal(subagentResult.agent.profile, "reviewer");
assert.equal(subagentResult.adopted, false);
assert.equal(subagentResult.output.findings.length, 1);
assert.equal(subagentResult.output.providerSession.provider, "mock-reviewer");
assert.ok(evidence.events.some((event) => event.type === "subagent" && event.providerSession?.provider === "mock-reviewer"));

let subagentToolReadResult;
let subagentProtectedToolReadResult;
const subagentToolPrivateRunRecord = path.join(repoRoot, ".odai", "runs", "subagent-tool-private.json");
await mkdir(path.dirname(subagentToolPrivateRunRecord), { recursive: true });
await writeFile(subagentToolPrivateRunRecord, '{"token":"subagent-tool-secret"}\n', "utf8");
const subagentToolProviders = new ProviderRegistry();
subagentToolProviders.register({
  name: "tool-calling-subagent",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input, tools }) {
    subagentToolReadResult = await tools.read(input.files[0]);
    subagentProtectedToolReadResult = await tools.read(input.protectedFile);
    return {
      provider: "tool-calling-subagent",
      observations: [subagentToolReadResult, subagentProtectedToolReadResult],
      findings: [{ severity: "info", message: "tool result captured" }],
    };
  },
});
const subagentToolScheduler = new Scheduler({
  providers: subagentToolProviders,
  agentProfiles: createDefaultAgentProfiles(),
  dispatcher,
  evidence,
});
await subagentToolScheduler.runSubagent({
  profileName: "reviewer",
  providerName: "tool-calling-subagent",
  input: {
    task: "Read through subagent tool API.",
    files: [path.join(repoRoot, "cli", "src", "index.mjs")],
    protectedFile: subagentToolPrivateRunRecord,
  },
});
assert.equal(subagentToolReadResult.ok, true);
assert.equal(subagentToolReadResult.path, "cli/src/index.mjs");
assert.ok(!JSON.stringify(subagentToolReadResult).includes(repoRoot));
assert.equal(subagentProtectedToolReadResult.ok, false);
assert.equal(subagentProtectedToolReadResult.gate, "subagent-boundary");
assert.ok(!JSON.stringify(subagentProtectedToolReadResult).includes(repoRoot));
assert.ok(!JSON.stringify(subagentProtectedToolReadResult).includes("subagent-tool-secret"));

const secretSubagentProviders = new ProviderRegistry();
secretSubagentProviders.register({
  name: "secret-subagent-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run() {
    return {
      provider: "secret-subagent-provider",
      text: "Subagent text api_key=subagent-output-secret",
      observations: ["Observation token=subagent-observation-secret"],
      findings: [{ summary: "Finding Bearer subagent-finding-secret" }],
      risks: [{ summary: "Allowed risk output" }],
      evidence_summary: "Unexpected summary token=subagent-unexpected-secret",
      "token=subagent-output-key-secret": "unexpected key value should not leak",
      patchProposal: {
        ok: true,
        type: "patch-proposal",
        patch: {
          summary: "Patch password=subagent-patch-secret",
          edits: [{ path: sampleFile, content: "secret subagent content should not be persisted in evidence" }],
        },
      },
      unverified: ["Subagent unverified token=subagent-unverified-secret"],
    };
  },
});
const secretSubagentScheduler = new Scheduler({
  providers: secretSubagentProviders,
  agentProfiles: createDefaultAgentProfiles(),
  dispatcher,
  evidence,
});
const secretSubagentRun = await secretSubagentScheduler.runSubagent({
  profileName: "reviewer",
  providerName: "secret-subagent-provider",
  input: { task: "Secret subagent output should be sanitized." },
});
assert.ok(secretSubagentRun.outputPolicy.allowedKeys.includes("findings"));
assert.ok(secretSubagentRun.outputPolicy.allowedKeys.includes("risks"));
assert.ok(secretSubagentRun.outputPolicy.unexpectedKeys.includes("observations"));
assert.ok(secretSubagentRun.outputPolicy.unexpectedKeys.includes("evidence_summary"));
assert.ok(secretSubagentRun.outputPolicy.unexpectedKeys.includes("patchProposal"));
assert.ok(!JSON.stringify(secretSubagentRun.outputPolicy).includes("subagent-output-key-secret"));
const secretSubagentEvidenceJson = JSON.stringify(evidence.snapshot().subagents);
assert.ok(!secretSubagentEvidenceJson.includes("subagent-output-secret"));
assert.ok(!secretSubagentEvidenceJson.includes("subagent-observation-secret"));
assert.ok(!secretSubagentEvidenceJson.includes("subagent-finding-secret"));
assert.ok(!secretSubagentEvidenceJson.includes("subagent-patch-secret"));
assert.ok(!secretSubagentEvidenceJson.includes("subagent-unverified-secret"));
assert.ok(!secretSubagentEvidenceJson.includes("subagent-unexpected-secret"));
assert.ok(!secretSubagentEvidenceJson.includes("subagent-output-key-secret"));
assert.ok(!secretSubagentEvidenceJson.includes("secret subagent content should not be persisted"));
assert.ok(secretSubagentEvidenceJson.includes("[redacted]"));

const subagentIntentResult = await scheduler.runSubagent({
  profileName: "reviewer",
  providerName: "mock-reviewer",
  input: {
    task: "Try direct model write intent.",
    toolIntents: [
      {
        type: "write",
        path: intentFile,
        content: "intent-after\n",
      },
    ],
  },
});
assert.equal(subagentIntentResult.output.toolIntentResults[0].ok, false);
assert.equal(subagentIntentResult.output.toolIntentResults[0].gate, "subagent-boundary");
assert.equal(await readFile(intentFile, "utf8"), "intent-before\n");

const patchCandidate = await scheduler.runSubagent({
  profileName: "implementer_candidate",
  providerName: "mock-main",
  input: {
    task: "Propose patch only.",
    target: sampleFile,
    content: "candidate content\n",
  },
});
assert.equal(patchCandidate.output.patchProposal.ok, true);
assert.equal(patchCandidate.output.patchProposal.type, "patch-proposal");
assert.equal(await readFile(sampleFile, "utf8"), "after\n");

const patchAdoptionWithoutEvidence = await adoptPatchProposal({
  result: await scheduler.runSubagent({
    profileName: "implementer_candidate",
    providerName: "mock-main",
    input: {
      task: "Propose patch adoption.",
      target: patchFile,
      content: "patch-after\n",
    },
  }),
  dispatcher,
});
assert.equal(patchAdoptionWithoutEvidence.adopted, false);
assert.equal(patchAdoptionWithoutEvidence.results[0].gate, "evidence");
assert.equal(await readFile(patchFile, "utf8"), "patch-before\n");

await dispatcher.dispatch({
  actor: { kind: "main", id: "main" },
  type: "read",
  path: patchFile,
});
const patchAdoption = await adoptPatchProposal({
  result: await scheduler.runSubagent({
    profileName: "implementer_candidate",
    providerName: "mock-main",
    input: {
      task: "Propose patch adoption.",
      target: patchFile,
      content: "patch-after\n",
    },
  }),
  dispatcher,
});
assert.equal(patchAdoption.adopted, true);
assert.equal(await readFile(patchFile, "utf8"), "patch-after\n");

await writeFile(cliAdoptFile, "token=patch-adoption-read-secret\n", "utf8");
const cliAdoptRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Adopt a mock patch",
    "--target",
    cliAdoptFile,
    "--content",
    "cli-after\n",
    "--adopt-patch",
  ],
});
assert.equal(cliAdoptRun.patchAdoption.adopted, true);
assert.equal(await readFile(cliAdoptFile, "utf8"), "cli-after\n");
assert.equal(cliAdoptRun.patchAdoption.evidenceRead.content, undefined);
assert.equal(cliAdoptRun.patchAdoption.evidenceRead.bytes, "token=patch-adoption-read-secret\n".length);
assert.ok(!JSON.stringify(cliAdoptRun).includes("patch-adoption-read-secret"));
assert.ok(cliAdoptRun.evidence.reads.includes(cliAdoptFile));
assert.ok(cliAdoptRun.evidence.writes.some((write) => write.path === cliAdoptFile));
assert.equal(cliAdoptRun.usage.calls.length, 1);
assert.equal(cliAdoptRun.skill.entrySha256, skillPack.entrySha256);
assert.equal(cliAdoptRun.skill.supportFileCount, skillPack.supportFiles.length);
assert.equal(cliAdoptRun.usage.calls[0].adopted, true);
assert.ok(cliAdoptRun.evidence.events.some((event) => event.type === "provider-call-adopted"));
const cliAdoptRecordJson = await readFile(cliAdoptRun.recordPath, "utf8");
assert.ok(!cliAdoptRecordJson.includes("patch-adoption-read-secret"));

const agentLoopRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Agent loop write",
    "--agent-loop",
    "--target",
    agentLoopFile,
    "--content",
    "agent-after\n",
  ],
});
assert.equal(agentLoopRun.mode, "agent_loop");
assert.equal(agentLoopRun.agentLoop.completed, true);
assert.equal(agentLoopRun.agentLoop.turns.length, 3);
assert.equal(agentLoopRun.agentLoop.turns[0].toolResults[0].type, "read");
assert.equal(agentLoopRun.agentLoop.turns[1].toolResults[0].type, "write");
assert.equal(await readFile(agentLoopFile, "utf8"), "agent-after\n");
assert.ok(agentLoopRun.evidence.reads.includes(agentLoopFile));
assert.ok(agentLoopRun.evidence.writes.some((write) => write.path === agentLoopFile));
assert.ok(agentLoopRun.evidence.events.some((event) => event.type === "agent-turn" && event.turn === 1));
assert.ok(agentLoopRun.evidence.events.some((event) => event.type === "agent-turn" && event.turn === 2));
assert.equal(agentLoopRun.usage.calls.length, 3);
assert.equal(agentLoopRun.usage.totals.byProvider["mock-main"].calls, 3);
assert.equal(agentLoopRun.providerSessions[0].provider, "mock-main");
assert.equal(agentLoopRun.usage.calls[0].providerSession.provider, "mock-main");
assert.equal(agentLoopRun.agentLoop.turns[0].output.providerSession.provider, "mock-main");
assert.ok(agentLoopRun.evidence.events.some((event) => event.type === "provider-call" && event.provider === "mock-main"));
assert.ok(
  agentLoopRun.evidence.events.some(
    (event) => event.type === "provider-call" && event.providerSession?.provider === "mock-main",
  ),
);
assert.match(agentLoopRun.note, /Mock agent loop/);

let resumeAwareMainInput;
const resumeAwareMainProvider = {
  name: "resume-aware-main",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    resumeAwareMainInput = input;
    return {
      provider: "resume-aware-main",
      text: "resume-aware main ok",
      toolIntents: [],
      providerSession: {
        provider: "resume-aware-main",
        sessionId: "fresh-main-session",
      },
    };
  },
};
const providerResumeContext = {
  status: "ready",
  sourceTranscriptPath: "/tmp/odai-session-transcript-secret.jsonl",
  currentTranscriptPath: "/tmp/current-transcript-secret.jsonl",
  authorizations: {
    approvedScopes: ["risk:production"],
    deniedScopes: ["risk:external"],
  },
  providerSessions: [
    { provider: "other-provider", sessionId: "other-current-session" },
    { provider: "resume-aware-main", sessionId: "main-current-session" },
  ],
  lastResult: {
    recordPath: "/tmp/private-run-record.json",
    savedRecordPath: "/tmp/private-saved-run-record.json",
    requiredAuthorizations: ["risk:credential"],
    requiredAuthorizationCount: 1,
    providerSessions: [
      { provider: "resume-aware-main", sessionId: "main-last-result-session" },
      { provider: "other-provider", sessionId: "other-last-result-session" },
    ],
  },
  previous: {
    providerSessions: [{ provider: "resume-aware-main", sessionId: "main-previous-session" }],
    recent: [{ type: "authorization-result", scope: "risk:billing", approved: true, answered: true }],
  },
  notRestored: ["api-key-confirmation", "provider-command-confirmation"],
};
const resumeAwareMainRun = await runAgentLoop({
  provider: resumeAwareMainProvider,
  task: "resume aware main",
  input: {
    conversationContext: providerResumeContext,
  },
  evidence: new EvidenceLedger(),
  maxTurns: 1,
});
assert.equal(resumeAwareMainRun.completed, true);
assert.deepEqual(resumeAwareMainInput.resumeProviderSession, {
  provider: "resume-aware-main",
  providerKind: "test",
  sessionId: "main-current-session",
});
assert.equal(resumeAwareMainInput.conversationContext.providerSessions, undefined);
assert.ok(!JSON.stringify(resumeAwareMainInput.conversationContext).includes("other-current-session"));
assert.ok(!JSON.stringify(resumeAwareMainInput.conversationContext).includes("main-current-session"));
assert.ok(!JSON.stringify(resumeAwareMainInput.conversationContext).includes("odai-session-transcript-secret"));
assert.ok(!JSON.stringify(resumeAwareMainInput.conversationContext).includes("private-run-record"));
assert.ok(!JSON.stringify(resumeAwareMainInput.conversationContext).includes("risk:production"));
assert.ok(!JSON.stringify(resumeAwareMainInput.conversationContext).includes("risk:credential"));
assert.ok(!JSON.stringify(resumeAwareMainInput.conversationContext).includes("risk:billing"));
assert.equal(resumeAwareMainInput.conversationContext.notRestored, undefined);
assert.equal(resumeAwareMainInput.conversationContext.lastResult.requiredAuthorizations, undefined);
assert.equal(resumeAwareMainInput.conversationContext.lastResult.requiredAuthorizationCount, undefined);

let resumeAwareSubagentInput;
const resumeAwareSubagentProvider = {
  name: "resume-aware-subagent",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["code"],
  async run({ input }) {
    resumeAwareSubagentInput = input;
    return {
      provider: "resume-aware-subagent",
      findings: [],
      providerSession: {
        provider: "resume-aware-subagent",
        sessionId: "fresh-subagent-session",
      },
    };
  },
};
const resumeAwareSubagentProviders = new ProviderRegistry();
resumeAwareSubagentProviders.register(resumeAwareSubagentProvider);
const resumeAwareSubagentEvidence = new EvidenceLedger();
const resumeAwareSubagentScheduler = new Scheduler({
  providers: resumeAwareSubagentProviders,
  agentProfiles: createDefaultAgentProfiles(),
  dispatcher,
  evidence: resumeAwareSubagentEvidence,
  usageLedger: new UsageLedger({ evidence: resumeAwareSubagentEvidence }),
});
const resumeAwareSubagentRun = await resumeAwareSubagentScheduler.runSubagent({
  profileName: "reviewer",
  providerName: "resume-aware-subagent",
  input: {
    task: "resume aware subagent",
    conversationContext: {
      transcriptPath: "/tmp/subagent-transcript-secret.jsonl",
      authorizations: { approvedScopes: ["risk:credential"] },
      notRestored: ["api-key-confirmation"],
      recent: [{ type: "authorization-prompt", scope: "risk:external", answered: true }],
      providerSessions: [
        { provider: "resume-aware-main", sessionId: "main-should-not-leak" },
        { provider: "resume-aware-subagent", sessionId: "subagent-current-session" },
      ],
    },
  },
});
assert.equal(resumeAwareSubagentRun.output.providerSession.sessionId, "fresh-subagent-session");
assert.deepEqual(resumeAwareSubagentInput.resumeProviderSession, {
  provider: "resume-aware-subagent",
  providerKind: "test",
  sessionId: "subagent-current-session",
});
assert.equal(resumeAwareSubagentInput.conversationContext.providerSessions, undefined);
assert.ok(!JSON.stringify(resumeAwareSubagentInput.conversationContext).includes("main-should-not-leak"));
assert.ok(!JSON.stringify(resumeAwareSubagentInput.conversationContext).includes("subagent-transcript-secret"));
assert.ok(!JSON.stringify(resumeAwareSubagentInput.conversationContext).includes("risk:credential"));
assert.ok(!JSON.stringify(resumeAwareSubagentInput.conversationContext).includes("risk:external"));
assert.equal(resumeAwareSubagentInput.conversationContext.notRestored, undefined);

const secretTextProvider = {
  name: "secret-text-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run() {
    return {
      provider: "secret-text-provider",
      text: "Model text api_key=agent-loop-output-secret and Bearer agent-loop-bearer-secret",
      findings: [
        "Finding contains token=agent-loop-finding-secret",
        { summary: "Nested password=agent-loop-nested-secret" },
      ],
      unverified: ["Unverified contains token=agent-loop-unverified-secret"],
      toolIntents: [],
    };
  },
};
const secretTextLoop = await runAgentLoop({
  provider: secretTextProvider,
  task: "Secret text should be sanitized before persistence.",
  dispatcher,
  evidence,
  maxTurns: 1,
});
const secretTextLoopJson = JSON.stringify(secretTextLoop);
const secretTextEventsJson = JSON.stringify(evidence.snapshot().events.filter((event) => event.provider === "secret-text-provider"));
assert.ok(!secretTextLoopJson.includes("agent-loop-output-secret"));
assert.ok(!secretTextLoopJson.includes("agent-loop-bearer-secret"));
assert.ok(!secretTextLoopJson.includes("agent-loop-finding-secret"));
assert.ok(!secretTextLoopJson.includes("agent-loop-nested-secret"));
assert.ok(!secretTextLoopJson.includes("agent-loop-unverified-secret"));
assert.ok(!secretTextEventsJson.includes("agent-loop-output-secret"));
assert.ok(!secretTextEventsJson.includes("agent-loop-unverified-secret"));
assert.ok(secretTextLoopJson.includes("[redacted]"));

const secretUsageEvidence = new EvidenceLedger();
const secretUsageLedger = new UsageLedger({ evidence: secretUsageEvidence });
const secretUsageProvider = {
  name: "secret-usage-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run() {
    return {
      provider: "secret-usage-provider",
      text: "usage ok",
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        billing_token: "usage-token-should-not-persist",
        nested: {
          cached_tokens: 2,
          secret: "nested-usage-secret-should-not-persist",
        },
        details: [
          { accepted_prediction_tokens: 1, api_key: "array-usage-secret-should-not-persist" },
        ],
      },
      unverified: ["Usage call token=usage-unverified-secret-should-not-persist"],
      toolIntents: [],
    };
  },
};
const secretUsageLoop = await runAgentLoop({
  provider: secretUsageProvider,
  task: "Provider usage metadata should be sanitized before persistence.",
  dispatcher,
  evidence: secretUsageEvidence,
  usageLedger: secretUsageLedger,
  maxTurns: 1,
});
assert.deepEqual(secretUsageLoop.finalOutput.usage, {
  input_tokens: 12,
  output_tokens: 3,
  nested: { cached_tokens: 2 },
  details: [{ accepted_prediction_tokens: 1 }],
});
const secretUsageSnapshot = secretUsageLedger.snapshot();
assert.deepEqual(secretUsageSnapshot.calls[0].usage, secretUsageLoop.finalOutput.usage);
const secretUsageJson = JSON.stringify({
  loop: secretUsageLoop,
  usage: secretUsageSnapshot,
  events: secretUsageEvidence.snapshot().events,
});
assert.ok(!secretUsageJson.includes("usage-token-should-not-persist"));
assert.ok(!secretUsageJson.includes("nested-usage-secret-should-not-persist"));
assert.ok(!secretUsageJson.includes("array-usage-secret-should-not-persist"));
assert.ok(!secretUsageJson.includes("usage-unverified-secret-should-not-persist"));

const modelReadFile = path.join(sessionTmp, "model-read-context.txt");
await writeFile(modelReadFile, "model-read-before\n", "utf8");
const modelReadEvidence = new EvidenceLedger();
const modelReadSession = new SessionState({ id: "model-read-context" });
const modelReadDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence: modelReadEvidence,
  session: modelReadSession,
});
const modelReadInputs = [];
const modelReadProvider = {
  name: "model-read-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    modelReadInputs.push(input);
    if (input.turn === 1) {
      return {
        provider: "model-read-provider",
        text: "read requested",
        toolIntents: [{ type: "read", path: modelReadFile }],
      };
    }
    return {
      provider: "model-read-provider",
      text: "done",
      toolIntents: [],
    };
  },
};
const modelReadLoop = await runAgentLoop({
  provider: modelReadProvider,
  task: "Read content should be available to the next provider turn.",
  dispatcher: modelReadDispatcher,
  evidence: modelReadEvidence,
  maxTurns: 2,
});
assert.equal(modelReadLoop.completed, true);
assert.equal(modelReadInputs.length, 2);
assert.equal(modelReadInputs[1].previousToolResults[0].result.content, "model-read-before\n");
assert.equal(modelReadLoop.turns[0].toolResults[0].content, undefined);
assert.equal(modelReadLoop.turns[0].toolResults[0].bytes, "model-read-before\n".length);
assert.ok(!JSON.stringify(modelReadLoop).includes("model-read-before\\n"));

const providerVisibleWorkspacePath = path.join(repoRoot, "cli", "src", "index.mjs");
const providerVisiblePathInputs = [];
const providerVisiblePathProvider = {
  name: "provider-visible-path-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    providerVisiblePathInputs.push(input);
    return {
      provider: "provider-visible-path-provider",
      text: "path visibility check",
      toolIntents: input.turn === 1
        ? [{ type: "read", path: providerVisibleWorkspacePath }]
        : [],
    };
  },
};
const providerVisiblePathLoop = await runAgentLoop({
  provider: providerVisiblePathProvider,
  task: "Workspace absolute paths should not enter provider-visible input.",
  input: {
    files: [providerVisibleWorkspacePath],
    target: providerVisibleWorkspacePath,
    toolIntents: [{ type: "read", path: providerVisibleWorkspacePath }],
    conversationContext: {
      lastTaskArgv: ["previous", "--file", providerVisibleWorkspacePath],
      lastResult: {
        toolActions: [`tool: read ${providerVisibleWorkspacePath}`],
      },
    },
  },
  dispatcher: modelReadDispatcher,
  evidence: new EvidenceLedger(),
  maxTurns: 2,
});
assert.equal(providerVisiblePathLoop.completed, true);
assert.equal(providerVisiblePathInputs[0].files[0], "cli/src/index.mjs");
assert.equal(providerVisiblePathInputs[0].target, "cli/src/index.mjs");
assert.equal(providerVisiblePathInputs[0].toolIntents[0].path, "cli/src/index.mjs");
assert.ok(!JSON.stringify(providerVisiblePathInputs).includes(repoRoot));
assert.equal(providerVisiblePathInputs[1].previousToolResults[0].intent.path, "cli/src/index.mjs");
assert.equal(providerVisiblePathInputs[1].previousToolResults[0].result.path, "cli/src/index.mjs");

const modelSecretEvidence = new EvidenceLedger();
const modelSecretSession = new SessionState({ id: "model-secret-context" });
modelSecretSession.authorize("risk:credential");
const modelSecretDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence: modelSecretEvidence,
  session: modelSecretSession,
});
const modelSecretInputs = [];
const modelSecretProvider = {
  name: "model-secret-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    modelSecretInputs.push(input);
    if (input.turn === 1) {
      return {
        provider: "model-secret-provider",
        text: "secret read requested",
        toolIntents: [{ type: "read", path: secretFile }],
      };
    }
    return {
      provider: "model-secret-provider",
      text: "done",
      toolIntents: [],
    };
  },
};
const modelSecretLoop = await runAgentLoop({
  provider: modelSecretProvider,
  task: "Credential content must not enter model context.",
  dispatcher: modelSecretDispatcher,
  evidence: modelSecretEvidence,
  maxTurns: 2,
});
assert.equal(modelSecretLoop.completed, true);
assert.ok(modelSecretEvidence.snapshot().reads.includes(secretFile));
assert.equal(modelSecretInputs[1].previousToolResults[0].result.privateContent, true);
assert.equal(modelSecretInputs[1].previousToolResults[0].result.content, "[withheld from model context]");
assert.ok(!JSON.stringify(modelSecretInputs).includes("should-not-enter-model-context"));
assert.ok(!JSON.stringify(modelSecretLoop).includes("should-not-enter-model-context"));

const protectedContentEvidence = new EvidenceLedger();
const protectedContentSession = new SessionState({ id: "protected-content-context" });
const protectedContentDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence: protectedContentEvidence,
  session: protectedContentSession,
});
const protectedContentInputs = [];
const protectedContentProvider = {
  name: "protected-content-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    protectedContentInputs.push(input);
    if (input.turn === 1) {
      return {
        provider: "protected-content-provider",
        text: "protected write requested",
        toolIntents: [{ type: "write", path: input.target, content: input.content }],
      };
    }
    return {
      provider: "protected-content-provider",
      text: "done",
      toolIntents: [],
    };
  },
};
const protectedContentLoop = await runAgentLoop({
  provider: protectedContentProvider,
  task: "Protected target content must not enter provider context.",
  input: {
    target: secretFile,
    content: "OPENAI_API_KEY=protected-target-content-secret\n",
  },
  dispatcher: protectedContentDispatcher,
  evidence: protectedContentEvidence,
  maxTurns: 2,
});
assert.equal(protectedContentInputs[0].content, "[withheld from model context]");
assert.equal(protectedContentLoop.turns[0].toolResults[0].gate, "policy");
assert.ok(!JSON.stringify(protectedContentInputs).includes("protected-target-content-secret"));
assert.ok(!JSON.stringify(protectedContentLoop).includes("protected-target-content-secret"));
assert.ok(!JSON.stringify(protectedContentEvidence.snapshot()).includes("protected-target-content-secret"));

const protectedRuntimeRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-protected-runtime-root-"));
const protectedRuntimeTarget = path.join(protectedRuntimeRoot, ".odai", "runs", "private.json");
await mkdir(path.dirname(protectedRuntimeTarget), { recursive: true });
const protectedRuntimeEvidence = new EvidenceLedger();
const protectedRuntimeInputs = [];
const protectedRuntimeProvider = {
  name: "protected-runtime-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    protectedRuntimeInputs.push(input);
    return {
      provider: "protected-runtime-provider",
      text: "protected runtime ok",
      toolIntents: [],
    };
  },
};
const protectedRuntimeLoop = await runAgentLoop({
  provider: protectedRuntimeProvider,
  task: "Private .odai runtime target content must not enter provider context outside cwd workspace.",
  input: {
    target: protectedRuntimeTarget,
    content: '{"token":"protected-runtime-content-secret"}',
  },
  dispatcher: new ToolDispatcher({
    workspaceRoot: protectedRuntimeRoot,
    sessionTmp,
    evidence: protectedRuntimeEvidence,
    session: new SessionState({ id: "protected-runtime-context" }),
  }),
  evidence: protectedRuntimeEvidence,
  maxTurns: 1,
});
assert.equal(protectedRuntimeLoop.completed, true);
assert.equal(protectedRuntimeInputs[0].target, ".odai/runs/private.json");
assert.equal(protectedRuntimeInputs[0].content, "[withheld from model context]");
assert.ok(!JSON.stringify(protectedRuntimeInputs).includes("protected-runtime-content-secret"));

const protectedIntentEvidence = new EvidenceLedger();
const protectedIntentSession = new SessionState({ id: "protected-intent-context" });
const protectedIntentDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence: protectedIntentEvidence,
  session: protectedIntentSession,
});
const protectedIntentInputs = [];
const protectedIntentProvider = {
  name: "protected-intent-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    protectedIntentInputs.push(input);
    if (input.turn === 1) {
      return {
        provider: "protected-intent-provider",
        text: "protected intent requested",
        toolIntents: input.toolIntents,
      };
    }
    return {
      provider: "protected-intent-provider",
      text: "done",
      toolIntents: [],
    };
  },
};
const protectedIntentLoop = await runAgentLoop({
  provider: protectedIntentProvider,
  task: "Protected tool intent content must not enter provider context.",
  input: {
    toolIntents: [
      {
        type: "write",
        path: secretFile,
        content: "OPENAI_API_KEY=protected-intent-content-secret\n",
      },
    ],
  },
  dispatcher: protectedIntentDispatcher,
  evidence: protectedIntentEvidence,
  maxTurns: 2,
});
assert.equal(protectedIntentInputs[0].toolIntents[0].content, "[withheld from model context]");
assert.equal(protectedIntentLoop.turns[0].toolResults[0].gate, "policy");
assert.ok(!JSON.stringify(protectedIntentInputs).includes("protected-intent-content-secret"));
assert.ok(!JSON.stringify(protectedIntentLoop).includes("protected-intent-content-secret"));
assert.ok(!JSON.stringify(protectedIntentEvidence.snapshot()).includes("protected-intent-content-secret"));

const modelShellEvidence = new EvidenceLedger();
const modelShellSession = new SessionState({ id: "model-shell-context" });
const modelShellDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence: modelShellEvidence,
  session: modelShellSession,
  allowShellExecution: true,
  allowedShellCommands: [process.execPath],
  runShellCommand: () => ({
    status: 1,
    stdout: "Assertion failed\ntoken=model-shell-stdout-secret\n",
    stderr: "Bearer model-shell-stderr-secret\n",
  }),
});
const modelShellInputs = [];
const modelShellProvider = {
  name: "model-shell-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    modelShellInputs.push(input);
    if (input.turn === 1) {
      return {
        provider: "model-shell-provider",
        text: "shell requested",
        toolIntents: [{ type: "shell", command: [process.execPath, "-e", "process.exit(1)"] }],
      };
    }
    return {
      provider: "model-shell-provider",
      text: "done",
      toolIntents: [],
    };
  },
};
const modelShellLoop = await runAgentLoop({
  provider: modelShellProvider,
  task: "Shell output should be available to the next provider turn.",
  dispatcher: modelShellDispatcher,
  evidence: modelShellEvidence,
  maxTurns: 2,
});
assert.equal(modelShellLoop.completed, true);
assert.equal(modelShellInputs[1].previousToolResults[0].result.stdout, "Assertion failed\ntoken=[redacted]\n");
assert.equal(modelShellInputs[1].previousToolResults[0].result.stderr, "Bearer [redacted]\n");
assert.equal(modelShellLoop.turns[0].toolResults[0].stdout, undefined);
assert.equal(modelShellLoop.turns[0].toolResults[0].stderr, undefined);
assert.ok(!JSON.stringify(modelShellInputs).includes("model-shell-stdout-secret"));
assert.ok(!JSON.stringify(modelShellInputs).includes("model-shell-stderr-secret"));

const modelNetworkEvidence = new EvidenceLedger();
const modelNetworkSession = new SessionState({ id: "model-network-context" });
modelNetworkSession.authorize("risk:external");
const modelNetworkDispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence: modelNetworkEvidence,
  session: modelNetworkSession,
  allowNetworkRequests: true,
  networkPolicy: {
    allowRequests: true,
    allowedHosts: ["example.com"],
    timeoutMs: 1000,
  },
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    headers: {
      forEach(callback) {
        callback("text/plain", "content-type");
        callback("Bearer model-network-header-secret", "authorization");
      },
    },
    async text() {
      return "network body token=model-network-body-secret\n";
    },
  }),
});
const modelNetworkInputs = [];
const modelNetworkProvider = {
  name: "model-network-provider",
  kind: "test",
  auth: "none",
  available: true,
  capabilities: ["reasoning", "code"],
  async run({ input }) {
    modelNetworkInputs.push(input);
    if (input.turn === 1) {
      return {
        provider: "model-network-provider",
        text: "network requested",
        toolIntents: [{ type: "network", url: "https://example.com/runtime-check", method: "GET" }],
      };
    }
    return {
      provider: "model-network-provider",
      text: "done",
      toolIntents: [],
    };
  },
};
const modelNetworkLoop = await runAgentLoop({
  provider: modelNetworkProvider,
  task: "Network body should be available to the next provider turn as untrusted data.",
  dispatcher: modelNetworkDispatcher,
  evidence: modelNetworkEvidence,
  maxTurns: 2,
});
assert.equal(modelNetworkLoop.completed, true);
assert.equal(modelNetworkInputs[1].previousToolResults[0].result.body, "network body token=[redacted]\n");
assert.equal(modelNetworkInputs[1].previousToolResults[0].result.untrusted, true);
assert.equal(modelNetworkInputs[1].previousToolResults[0].result.headers.authorization, undefined);
assert.equal(modelNetworkLoop.turns[0].toolResults[0].body, undefined);
assert.ok(!JSON.stringify(modelNetworkInputs).includes("model-network-body-secret"));
assert.ok(!JSON.stringify(modelNetworkInputs).includes("model-network-header-secret"));

const agentLoopNewFileRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Agent loop create new file",
    "--agent-loop",
    "--target",
    agentLoopNewFile,
    "--content",
    "new-agent-file\n",
  ],
});
assert.equal(agentLoopNewFileRun.status, "ready");
assert.equal(agentLoopNewFileRun.agentLoop.turns[0].toolResults[0].ok, false);
assert.equal(agentLoopNewFileRun.agentLoop.turns[0].toolResults[0].error, "file_not_found");
assert.equal(agentLoopNewFileRun.agentLoop.turns[1].toolResults[0].type, "write");
assert.equal(await readFile(agentLoopNewFile, "utf8"), "new-agent-file\n");
assert.ok(agentLoopNewFileRun.evidence.locations.some((entry) => entry.path === agentLoopNewFile));
assert.ok(agentLoopNewFileRun.evidence.events.some((event) => event.type === "location" && event.path === agentLoopNewFile));
const agentLoopNewFileCheckpoint = agentLoopNewFileRun.evidence.checkpoints.find(
  (checkpoint) => checkpoint.path === agentLoopNewFile,
);
assert.ok(agentLoopNewFileCheckpoint);
assert.equal(agentLoopNewFileCheckpoint.existed, false);

const secretTaskRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Secret task api_key=task-record-secret Bearer task-bearer-secret token=task-token-secret",
    "--agent-loop",
    "--max-turns",
    "1",
    "--save",
  ],
});
assert.equal(secretTaskRun.status, "ready");
const secretTaskRunJson = JSON.stringify(secretTaskRun);
assert.ok(!secretTaskRunJson.includes("task-record-secret"));
assert.ok(!secretTaskRunJson.includes("task-bearer-secret"));
assert.ok(!secretTaskRunJson.includes("task-token-secret"));
assert.ok(secretTaskRunJson.includes("[redacted]"));
assert.ok(secretTaskRun.savedRecordPath);
const secretTaskSavedJson = await readFile(secretTaskRun.savedRecordPath, "utf8");
const secretTaskLatestJson = await readFile(path.join(repoRoot, ".odai", "runs", "latest.json"), "utf8");
assert.ok(!secretTaskSavedJson.includes("task-record-secret"));
assert.ok(!secretTaskSavedJson.includes("task-bearer-secret"));
assert.ok(!secretTaskSavedJson.includes("task-token-secret"));
assert.ok(!secretTaskLatestJson.includes("task-record-secret"));
assert.ok(!secretTaskLatestJson.includes("task-bearer-secret"));
assert.ok(!secretTaskLatestJson.includes("task-token-secret"));
assert.ok(secretTaskRun.resume.argv[0].includes("[redacted]"));
const secretTaskContinueSummary = await continueLatestRun({ repoRoot });
assert.ok(!JSON.stringify(secretTaskContinueSummary).includes("task-record-secret"));
assert.ok(!JSON.stringify(secretTaskContinueSummary).includes("task-bearer-secret"));
assert.ok(!JSON.stringify(secretTaskContinueSummary).includes("task-token-secret"));

const secretAgentLoopRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Agent loop secret read", "--agent-loop", "--file", secretFile],
});
assert.equal(secretAgentLoopRun.status, "ready");
assert.deepEqual(secretAgentLoopRun.requiredAuthorizations, ["risk:credential"]);
assert.ok(secretAgentLoopRun.evidence.denials.some((denial) => denial.intent?.path === secretFile));
assert.ok(!secretAgentLoopRun.evidence.reads.includes(secretFile));
assert.ok(!JSON.stringify(secretAgentLoopRun.agentLoop.turns).includes("should-not-enter-model-context"));

const sensitiveNetworkAgentLoopRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Agent loop sensitive network intent",
    "--agent-loop",
    "--tool-intent-json",
    JSON.stringify({
      type: "network",
      url: "https://example.com/api?token=agent-loop-network-secret&ok=1",
      method: "GET",
    }),
  ],
});
assert.equal(sensitiveNetworkAgentLoopRun.status, "ready");
assert.ok(
  sensitiveNetworkAgentLoopRun.evidence.denials.some(
    (denial) => denial.intent?.type === "network" && !denial.intent.url.includes("agent-loop-network-secret"),
  ),
);
assert.ok(!JSON.stringify(sensitiveNetworkAgentLoopRun.agentLoop.turns).includes("agent-loop-network-secret"));
assert.ok(!JSON.stringify(sensitiveNetworkAgentLoopRun.evidence.denials).includes("agent-loop-network-secret"));
assert.ok(!JSON.stringify(sensitiveNetworkAgentLoopRun).includes("agent-loop-network-secret"));
assert.ok(!sensitiveNetworkAgentLoopRun.resume.argv.includes("--tool-intent-json"));

const overflowToolIntentArgs = Array.from({ length: 21 }, () => [
  "--tool-intent-json",
  JSON.stringify({ type: "read", path: overflowFile }),
]).flat();
const overflowToolIntentRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Too many tool intents", "--agent-loop", ...overflowToolIntentArgs],
});
assert.equal(overflowToolIntentRun.status, "ready");
assert.equal(overflowToolIntentRun.agentLoop.completed, false);
assert.equal(overflowToolIntentRun.agentLoop.stopReason, "tool_intent_limit_exceeded");
assert.equal(overflowToolIntentRun.agentLoop.turns[0].toolIntentOverflow.count, 21);
assert.equal(overflowToolIntentRun.agentLoop.turns[0].toolIntents.length, 0);
assert.equal(overflowToolIntentRun.agentLoop.turns[0].toolResults[0].gate, "policy");
assert.ok(!overflowToolIntentRun.evidence.reads.includes(overflowFile));
assert.ok(
  overflowToolIntentRun.evidence.denials.some(
    (denial) => denial.intent?.type === "tool-intent-batch" && denial.intent.count === 21,
  ),
);

const payloadQuestionMarker = "odai-payload-question-marker";
const oversizedQuestionRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Oversized tool intent question",
    "--agent-loop",
    "--tool-intent-json",
    JSON.stringify({
      type: "ask-user",
      question: `${payloadQuestionMarker}${"q".repeat(DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS + 1)}`,
    }),
  ],
});
assert.equal(oversizedQuestionRun.status, "ready");
assert.ok(
  oversizedQuestionRun.evidence.denials.some(
    (denial) =>
      denial.gate === "policy" &&
      denial.intent?.type === "tool-intent-payload" &&
      denial.intent?.originalType === "ask-user",
  ),
);
assert.ok(!JSON.stringify(oversizedQuestionRun.agentLoop.turns).includes(payloadQuestionMarker));
assert.ok(!JSON.stringify(oversizedQuestionRun.evidence.denials).includes(payloadQuestionMarker));
assert.ok(!JSON.stringify(oversizedQuestionRun).includes(payloadQuestionMarker));

const commandProviderRun = await runMockTask({
  repoRoot: commandProviderRoot,
  sessionTmp,
  argv: [
    "Command provider agent loop",
    "--agent-loop",
    "--provider",
    "node-json-e2e",
    "--use-provider-command=true",
    "--file",
    commandProviderFile,
    "--save",
  ],
});
assert.equal(commandProviderRun.status, "ready");
assert.equal(commandProviderRun.agentLoop.agent.provider, "node-json-e2e");
assert.equal(commandProviderRun.agentLoop.completed, true);
assert.equal(commandProviderRun.agentLoop.turns[0].toolResults[0].type, "read");
assert.ok(commandProviderRun.evidence.reads.includes(commandProviderFile));
assert.equal(commandProviderRun.usage.calls[0].providerKind, "command-json");
assert.equal(commandProviderRun.providerSessions[0].sessionId, "command-json-session-1");
assert.match(commandProviderRun.note, /Provider agent loop dispatched model output through odai runtime gates/);
assert.doesNotMatch(commandProviderRun.note, /no real model was called/);
assert.ok(!commandProviderRun.resume.argv.includes("--use-provider-command"));
assert.ok(!commandProviderRun.resume.argv.some((arg) => String(arg).startsWith("--use-provider-command")));
const commandProviderContinueSummary = await continueLatestRun({
  repoRoot: commandProviderRoot,
});
assert.deepEqual(commandProviderContinueSummary.notRestored, ["provider-command-confirmation"]);
assert.deepEqual(commandProviderContinueSummary.rerun.flags, ["--use-provider-command"]);
assert.equal(commandProviderContinueSummary.rerun.command, "odai continue --run --use-provider-command");

const failingCommandProviderRun = await runMockTask({
  repoRoot: commandProviderRoot,
  sessionTmp,
  argv: [
    "Failing command provider",
    "--agent-loop",
    "--provider",
    "node-json-fails",
    "--use-provider-command",
  ],
});
assert.equal(failingCommandProviderRun.status, "failed");
const failingCommandProviderJson = JSON.stringify(failingCommandProviderRun);
assert.ok(!failingCommandProviderJson.includes("provider-error-secret"));
assert.ok(!failingCommandProviderJson.includes("provider-error-bearer-secret"));
assert.ok(!failingCommandProviderJson.includes("provider-error-token-secret"));
assert.ok(failingCommandProviderJson.includes("[redacted]"));
assert.match(failingCommandProviderRun.error.message, /api_key=\[redacted\]/);
assert.match(failingCommandProviderRun.usage.calls[0].error.message, /Bearer \[redacted\]/);
assert.ok(
  failingCommandProviderRun.evidence.events.some(
    (event) => event.type === "error" && /token=\[redacted\]/.test(event.message || ""),
  ),
);

const commandContinueWithoutConfirmation = await continueLatestRun({
  repoRoot: commandProviderRoot,
  argv: ["--run"],
});
assert.equal(commandContinueWithoutConfirmation.status, "failed");
assert.match(commandContinueWithoutConfirmation.error.message, /Provider is not available: node-json-e2e/);
const commandContinueWithConfirmation = await continueLatestRun({
  repoRoot: commandProviderRoot,
  argv: ["--run", "--use-provider-command=true"],
});
assert.equal(commandContinueWithConfirmation.status, "ready");
assert.equal(commandContinueWithConfirmation.agentLoop.agent.provider, "node-json-e2e");

const commandProviderSubagentAutoRun = await runMockTask({
  repoRoot: commandProviderRoot,
  sessionTmp,
  argv: [
    "Command provider subagent auto excludes main",
    "--agent-loop",
    "--provider",
    "node-json-e2e",
    "--use-provider-command",
    "--file",
    commandProviderFile,
    "--subagent",
    "reviewer:auto",
    "--exclude-provider",
    "codex-cli",
    "--exclude-provider",
    "grok-cli",
    "--exclude-provider",
    "claude-cli",
  ],
});
assert.equal(commandProviderSubagentAutoRun.status, "ready");
assert.equal(commandProviderSubagentAutoRun.agentLoop.agent.provider, "node-json-e2e");
assert.equal(commandProviderSubagentAutoRun.subagentReviews[0].provider, "node-json-reviewer");
assert.equal(commandProviderSubagentAutoRun.subagentReviews[0].providerSession.sessionId, "command-json-reviewer-session-1");
assert.ok(commandProviderSubagentAutoRun.resume.argv.includes("--exclude-provider"));
assert.ok(
  commandProviderSubagentAutoRun.usage.calls.some(
    (call) => call.mode === "subagent" && call.provider === "node-json-reviewer",
  ),
);

const autoProviderRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Auto provider agent loop", "--agent-loop", "--provider", "auto", "--file", sampleFile],
});
assert.equal(autoProviderRun.status, "ready");
assert.deepEqual(autoProviderRun.providerSelection, {
  requested: "auto",
  selected: "mock-main",
});
assert.equal(autoProviderRun.agentLoop.agent.provider, "mock-main");
assert.ok(autoProviderRun.resume.argv.includes("--provider"));
assert.ok(autoProviderRun.resume.argv.includes("auto"));

const modelOverrideRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Model override agent loop", "--agent-loop", "--provider", "mock-main", "--model", "mock-model"],
});
assert.equal(modelOverrideRun.status, "ready");
assert.equal(modelOverrideRun.model, "mock-model");
assert.equal(modelOverrideRun.agentLoop.finalOutput.model, "mock-model");
assert.equal(modelOverrideRun.usage.calls[0].model, "mock-model");
assert.ok(modelOverrideRun.resume.argv.includes("--model"));
assert.ok(modelOverrideRun.resume.argv.includes("mock-model"));

const modelOptionsRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Model options agent loop", "--agent-loop", "--provider", "mock-main", "--reasoning", "high", "--context", "1m"],
});
assert.equal(modelOptionsRun.status, "ready");
assert.deepEqual(modelOptionsRun.modelOptions, { reasoning: "high", contextWindowTokens: 1000000 });
assert.ok(modelOptionsRun.resume.argv.includes("--reasoning"));
assert.ok(modelOptionsRun.resume.argv.includes("high"));
assert.ok(modelOptionsRun.resume.argv.includes("--context"));
assert.ok(modelOptionsRun.resume.argv.includes("1000000"));

const packageProviderReport = listPackageProviders({ repoRoot, env: {} });
assert.ok(packageProviderReport.providers.some((provider) => provider.name === "mock-main"));
const packageRuntime = createPackageRuntime({ repoRoot, env: {} });
assert.equal(packageRuntime.repoRoot, repoRoot);
assert.ok(packageRuntime.listProviders().providers.some((provider) => provider.name === "mock-reviewer"));
const packageApiRun = await runPackageTask({
  repoRoot,
  sessionTmp,
  argv: ["Package API agent loop", "--agent-loop", "--provider", "mock-main"],
});
assert.equal(packageApiRun.status, "ready");
assert.equal(packageApiRun.agentLoop.agent.provider, "mock-main");

const autoSubagentRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Auto subagent provider", "--agent-loop", "--file", sampleFile, "--subagent", "reviewer:auto"],
});
assert.equal(autoSubagentRun.status, "ready");
assert.equal(autoSubagentRun.subagentReviews[0].provider, "mock-reviewer");

const streamedAgentEvents = [];
const streamedAgentRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Streamed agent loop", "--agent-loop", "--file", sampleFile],
  onEvent: (event) => streamedAgentEvents.push(event),
});
assert.equal(streamedAgentRun.status, "ready");
assert.ok(streamedAgentEvents.some((event) => event.type === "agent-turn-start" && event.turn === 1));
assert.ok(
  streamedAgentEvents.some(
    (event) =>
      event.type === "agent-turn-start" &&
      event.turn === 1 &&
      Number.isFinite(event.estimatedInputTokens) &&
      event.estimatedInputTokens > 0,
  ),
);
assert.ok(streamedAgentEvents.some((event) => event.type === "provider-text" && /Mock agent loop/.test(event.text)));
assert.ok(
  streamedAgentEvents.some(
    (event) => event.type === "tool-result" && event.result?.type === "read" && event.result?.path === sampleFile,
  ),
);

const rollbackSourceRun = await runMockTask({
  repoRoot,
  argv: [
    "Rollback checkpoint write",
    "--agent-loop",
    "--target",
    rollbackWorkspaceFile,
    "--content",
    "rollback-after\n",
    "--save",
  ],
});
assert.equal(rollbackSourceRun.status, "ready");
assert.equal(await readFile(rollbackWorkspaceFile, "utf8"), "rollback-after\n");
assert.ok(rollbackSourceRun.evidence.checkpoints.some((checkpoint) => checkpoint.path === rollbackWorkspaceFile));
const rollbackPreview = await rollbackWorkspaceRun({ workspaceRoot: repoRoot, selector: "latest" });
assert.equal(rollbackPreview.confirmRequired, true);
assert.ok(rollbackPreview.items.some((item) => item.path === rollbackWorkspaceFile && item.action === "would_restore"));
assert.equal(await readFile(rollbackWorkspaceFile, "utf8"), "rollback-after\n");
const rollbackPathPreview = await rollbackWorkspaceRun({
  workspaceRoot: repoRoot,
  selector: rollbackSourceRun.savedRecordPath,
  paths: [rollbackWorkspaceFile],
});
assert.equal(rollbackPathPreview.items.length, 1);
assert.equal(rollbackPathPreview.items[0].path, rollbackWorkspaceFile);
const rollbackFilteredOutPreview = await rollbackWorkspaceRun({
  workspaceRoot: repoRoot,
  selector: rollbackSourceRun.savedRecordPath,
  paths: [sampleFile],
});
assert.equal(rollbackFilteredOutPreview.items.length, 0);
const checkpointSelectFile = path.join(repoRoot, ".odai", "runs", "rollback-checkpoint-select.txt");
const checkpointSelectDir = path.join(repoRoot, ".odai", "runs", "checkpoints", "checkpoint-select-smoke");
const checkpointSelectOldPath = path.join(checkpointSelectDir, "select-old.json");
const checkpointSelectNewPath = path.join(checkpointSelectDir, "select-new.json");
await mkdir(checkpointSelectDir, { recursive: true });
await writeFile(checkpointSelectFile, "select-current\n", "utf8");
await writeFile(
  checkpointSelectOldPath,
  JSON.stringify({
    id: "select-old",
    path: checkpointSelectFile,
    existed: true,
    content: "select-old\n",
  }),
  "utf8",
);
await writeFile(
  checkpointSelectNewPath,
  JSON.stringify({
    id: "select-new",
    path: checkpointSelectFile,
    existed: true,
    content: "select-new\n",
  }),
  "utf8",
);
const checkpointSelectRecord = {
  task: "Checkpoint select",
  evidence: {
    checkpoints: [
      {
        id: "select-old",
        path: checkpointSelectFile,
        existed: true,
        checkpointPath: checkpointSelectOldPath,
      },
      {
        id: "select-new",
        path: checkpointSelectFile,
        existed: true,
        checkpointPath: checkpointSelectNewPath,
      },
    ],
  },
};
const checkpointSelectPreview = await rollbackRunRecord({
  workspaceRoot: repoRoot,
  recordPath: "/tmp/checkpoint-select.json",
  record: checkpointSelectRecord,
  checkpointIds: ["select-old"],
});
assert.equal(checkpointSelectPreview.items.length, 1);
assert.equal(checkpointSelectPreview.items[0].id, "select-old");
const checkpointSelectConfirmed = await rollbackRunRecord({
  workspaceRoot: repoRoot,
  recordPath: "/tmp/checkpoint-select.json",
  record: checkpointSelectRecord,
  checkpointIds: ["select-new"],
  confirm: true,
});
assert.equal(await readFile(checkpointSelectFile, "utf8"), "select-new\n");
assert.equal(checkpointSelectConfirmed.reverseCheckpoints.length, 1);
assert.ok(checkpointSelectConfirmed.reverseRecord.evidence.checkpoints[0].checkpointPath);
const checkpointSelectReverse = await rollbackRunRecord({
  workspaceRoot: repoRoot,
  recordPath: "/tmp/checkpoint-select-reverse.json",
  record: checkpointSelectConfirmed.reverseRecord,
  confirm: true,
});
assert.equal(checkpointSelectReverse.items[0].action, "restored");
assert.equal(await readFile(checkpointSelectFile, "utf8"), "select-current\n");
const rollbackConfirmed = await rollbackWorkspaceRun({
  workspaceRoot: repoRoot,
  selector: "latest",
  confirm: true,
});
assert.equal(rollbackConfirmed.restored, true);
assert.ok(rollbackConfirmed.items.some((item) => item.path === rollbackWorkspaceFile && item.action === "restored"));
assert.equal(await readFile(rollbackWorkspaceFile, "utf8"), "rollback-before\n");

const rollbackCliAuditTarget = path.join(repoRoot, ".odai", "runs", "rollback-cli-audit.txt");
await writeFile(rollbackCliAuditTarget, "audit-before\n", "utf8");
const rollbackCliSource = await runMockTask({
  repoRoot,
  argv: [
    "Rollback audit source",
    "--agent-loop",
    "--target",
    rollbackCliAuditTarget,
    "--content",
    "audit-after\n",
    "--save",
  ],
});
const rollbackCliConfirmed = await rollbackLatestRun({
  repoRoot,
  argv: ["latest", "--confirm"],
});
assert.ok(rollbackCliConfirmed.auditRecordPath);
assert.equal(rollbackCliConfirmed.reverseRecord, undefined);
assert.equal(rollbackCliConfirmed.reverseCheckpoints, undefined);
assert.equal(rollbackCliConfirmed.items[0].checkpointPath, undefined);
assert.equal(await readFile(rollbackCliAuditTarget, "utf8"), "audit-before\n");
const rollbackCliAuditRecord = JSON.parse(await readFile(rollbackCliConfirmed.auditRecordPath, "utf8"));
assert.equal(rollbackCliAuditRecord.reverseRecord, undefined);
assert.equal(rollbackCliAuditRecord.reverseCheckpoints, undefined);
assert.equal(rollbackCliAuditRecord.items[0].checkpointPath, undefined);
assert.ok(rollbackCliAuditRecord.evidence.checkpoints[0].checkpointPath);
const rollbackLatestAfterAudit = await continueLatestRun({ repoRoot });
assert.equal(rollbackLatestAfterAudit.rollback.sourceRecordPath, rollbackCliSource.savedRecordPath);
assert.equal(rollbackLatestAfterAudit.rollback.items[0].checkpointPath, undefined);
const rollbackContinueRun = await continueLatestRun({ repoRoot, argv: ["--run"] });
assert.equal(rollbackContinueRun.status, "blocked");
assert.match(rollbackContinueRun.note, /rollback audit/);
const rollbackCliReverse = await rollbackWorkspaceRun({
  workspaceRoot: repoRoot,
  selector: rollbackCliConfirmed.auditRecordPath,
  confirm: true,
});
assert.equal(rollbackCliReverse.restored, true);
assert.equal(await readFile(rollbackCliAuditTarget, "utf8"), "audit-after\n");

const newFileCheckpointDir = path.join(repoRoot, ".odai", "runs", "checkpoints", "new-file-smoke");
const newFileCheckpointPath = path.join(newFileCheckpointDir, "new-file.json");
await mkdir(newFileCheckpointDir, { recursive: true });
await writeFile(
  newFileCheckpointPath,
  JSON.stringify({
    id: "new-file",
    path: rollbackNewFile,
    existed: false,
    content: "",
  }),
  "utf8",
);
const newFileRecord = {
  task: "Rollback new file",
  evidence: {
    checkpoints: [
      {
        id: "new-file",
        path: rollbackNewFile,
        existed: false,
        checkpointPath: newFileCheckpointPath,
      },
    ],
  },
};
const newFileDefaultRollback = await rollbackRunRecord({
  workspaceRoot: repoRoot,
  recordPath: "/tmp/new-file-record.json",
  record: newFileRecord,
});
assert.equal(newFileDefaultRollback.items[0].action, "skip");
assert.equal(await readFile(rollbackNewFile, "utf8"), "new file content\n");
const newFileDeletePreview = await rollbackRunRecord({
  workspaceRoot: repoRoot,
  recordPath: "/tmp/new-file-record.json",
  record: newFileRecord,
  deleteNewFiles: true,
});
assert.equal(newFileDeletePreview.items[0].action, "would_delete");
assert.equal(await readFile(rollbackNewFile, "utf8"), "new file content\n");
const newFileDeleteConfirmed = await rollbackRunRecord({
  workspaceRoot: repoRoot,
  recordPath: "/tmp/new-file-record.json",
  record: newFileRecord,
  confirm: true,
  deleteNewFiles: true,
});
assert.equal(newFileDeleteConfirmed.items[0].action, "deleted");
await assert.rejects(() => readFile(rollbackNewFile, "utf8"), /ENOENT/);

const autoProviderSubagentRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Auto provider subagent", "--agent-loop", "--file", sampleFile, "--subagent", "reviewer"],
});
assert.equal(autoProviderSubagentRun.agentLoop.agent.provider, "mock-main");
assert.equal(autoProviderSubagentRun.subagentReviews[0].provider, "mock-reviewer");

await symlinkOrCopyDirectory(path.join(repoRoot, "skills"), path.join(agentRoot, "skills"));
const configuredProfileRun = await runMockTask({
  repoRoot: agentRoot,
  sessionTmp,
  argv: ["Configured profile subagent", "--agent-loop", "--file", sampleFile, "--subagent", "deep_reviewer:auto"],
});
assert.equal(configuredProfileRun.status, "ready");
assert.equal(configuredProfileRun.subagentReviews[0].profile, "deep_reviewer");
assert.equal(configuredProfileRun.subagentReviews[0].provider, "mock-reviewer");
assert.ok(configuredProfileRun.resume.argv.includes("deep_reviewer:auto"));

const bulkReaderRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Bulk reader subagent", "--agent-loop", "--file", sampleFile, "--subagent", "bulk_reader:auto"],
});
assert.equal(bulkReaderRun.status, "ready");
assert.equal(bulkReaderRun.subagentReviews[0].profile, "bulk_reader");
assert.equal(bulkReaderRun.subagentReviews[0].provider, "mock-reviewer");
assert.ok(bulkReaderRun.evidence.subagents.some((event) => event.agent.profile === "bulk_reader"));

const multiSubagentRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Multi subagent review",
    "--agent-loop",
    "--file",
    sampleFile,
    "--subagent",
    "reviewer:mock-reviewer",
    "--subagent",
    "challenger:mock-main:challenger-model",
  ],
});
assert.equal(multiSubagentRun.mode, "agent_loop");
assert.equal(multiSubagentRun.subagentReviews.length, 2);
assert.ok(multiSubagentRun.resume.argv.includes("--agent-loop"));
assert.ok(multiSubagentRun.resume.argv.includes("--subagent"));
assert.ok(!multiSubagentRun.resume.argv.includes("--use-api-key"));
assert.ok(!multiSubagentRun.resume.argv.includes("--use-provider-command"));
assert.ok(!multiSubagentRun.resume.argv.includes("--allow-shell"));
assert.deepEqual(
  multiSubagentRun.subagentReviews.map((review) => review.profile),
  ["reviewer", "challenger"],
);
assert.equal(multiSubagentRun.subagentReviews[1].model, "challenger-model");
assert.ok(multiSubagentRun.resume.argv.includes("challenger:mock-main:challenger-model"));
assert.ok(multiSubagentRun.evidence.subagents.length >= 2);
assert.ok(multiSubagentRun.subagentReviews.every((review) => review.adopted === false));
const multiSubagentBatchEvent = multiSubagentRun.evidence.events.find((event) => event.type === "subagent-batch");
assert.equal(multiSubagentBatchEvent.parallel, true);
assert.equal(multiSubagentBatchEvent.requested, 2);
assert.equal(multiSubagentBatchEvent.heterogeneousProviders, true);
assert.deepEqual(multiSubagentBatchEvent.providers.sort(), ["mock-main", "mock-reviewer"]);

const failedSubagentBatchRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: [
    "Partial subagent failure",
    "--agent-loop",
    "--file",
    sampleFile,
    "--subagent",
    "reviewer:mock-reviewer",
    "--subagent",
    "missing-profile:mock-main",
  ],
});
assert.equal(failedSubagentBatchRun.status, "failed");
assert.equal(failedSubagentBatchRun.subagentReviews.length, 2);
assert.equal(failedSubagentBatchRun.subagentReviews[0].profile, "reviewer");
assert.equal(failedSubagentBatchRun.subagentReviews[1].status, "failed");
assert.equal(failedSubagentBatchRun.subagentFailures.length, 1);
assert.match(failedSubagentBatchRun.error.message, /Subagent review batch failed/);
assert.ok(failedSubagentBatchRun.evidence.subagents.some((event) => event.agent.profile === "reviewer"));
assert.ok(
  failedSubagentBatchRun.evidence.events.some(
    (event) => event.type === "subagent-batch" && event.succeeded === 1 && event.failed === 1,
  ),
);

const authSession = new SessionState({ id: "auth-smoke" });
const authEvidence = new EvidenceLedger();
const productionIntentArg = JSON.stringify({
  type: "shell",
  command: ["deploy", "production"],
  risk: "production",
});
const authDeniedRun = await runMockTask({
  repoRoot,
  sessionTmp,
  session: authSession,
  evidence: authEvidence,
  argv: ["Needs authorization", "--agent-loop", "--tool-intent-json", productionIntentArg],
});
assert.deepEqual(authDeniedRun.requiredAuthorizations, ["risk:production"]);
assert.ok(authDeniedRun.evidence.denials.some((denial) => denial.gate === "authorization"));
authSession.authorize("risk:production");
const authRetryRun = await runMockTask({
  repoRoot,
  sessionTmp,
  session: authSession,
  evidence: authEvidence,
  argv: ["Needs authorization", "--agent-loop", "--tool-intent-json", productionIntentArg],
});
assert.deepEqual(authRetryRun.requiredAuthorizations, []);
assert.ok(authRetryRun.evidence.commands.some((command) => command.command[0] === "deploy"));

const failedRun = await runMockTask({
  repoRoot,
  sessionTmp,
  argv: ["Unavailable provider", "--agent-loop", "--provider", "openai-api"],
});
assert.equal(failedRun.status, "failed");
assert.match(failedRun.error.message, /Provider is not available: openai-api/);
assert.ok(failedRun.evidence.events.some((event) => event.type === "error"));
assert.ok(failedRun.recordPath);

const canaryLastMessage = path.join(sessionTmp, "canary-last-message.txt");
const canaryRun = await runCanaryRunner({
  repoRoot,
  argv: ["--last-message", canaryLastMessage],
  stdinText: "canary smoke",
});
assert.equal(canaryRun.run.mode, "agent_loop");
assert.match(canaryRun.message, /runStatus: ready/);
assert.match(canaryRun.message, /mode: agent_loop/);
assert.match(canaryRun.message, /provider: mock-main/);
assert.match(canaryRun.message, /events: \d+/);
assert.match(await readFile(canaryLastMessage, "utf8"), /odai CLI canary runner executed the mock odai runtime/);

const commandCanaryLastMessage = path.join(sessionTmp, "command-canary-last-message.txt");
const commandCanaryRun = await runCanaryRunner({
  repoRoot: commandProviderRoot,
  argv: [
    `--last-message=${commandCanaryLastMessage}`,
    "--provider=node-json-e2e",
    "--use-provider-command",
    `--file=${commandProviderFile}`,
  ],
  stdinText: "command canary smoke",
});
assert.equal(commandCanaryRun.run.status, "ready");
assert.equal(commandCanaryRun.run.agentLoop.agent.provider, "node-json-e2e");
assert.ok(commandCanaryRun.run.evidence.reads.includes(commandProviderFile));
assert.match(commandCanaryRun.message, /explicit provider request/);
assert.match(commandCanaryRun.message, /provider: node-json-e2e/);
assert.match(await readFile(commandCanaryLastMessage, "utf8"), /provider: node-json-e2e/);

const runtimeSubagentCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "1"],
  stdinText: "runtime subagent write canary",
});
assert.equal(runtimeSubagentCanary.run.mode, "subagent");
assert.equal(runtimeSubagentCanary.run.subagent.provider, "mock-reviewer");
assert.ok(runtimeSubagentCanary.run.evidence.denials.some((denial) => denial.gate === "subagent-boundary"));
assert.match(runtimeSubagentCanary.message, /runtimeCase: subagent-write-denied/);
assert.match(runtimeSubagentCanary.message, /denials: [1-9]\d*/);

const runtimeNetworkCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "network-deny"],
  stdinText: "runtime network canary",
});
assert.equal(runtimeNetworkCanary.run.mode, "agent_loop");
assert.ok(
  runtimeNetworkCanary.run.evidence.denials.some(
    (denial) =>
      denial.intent?.type === "network" &&
      /Network tool intents require explicit --allow-network/.test(denial.reason || ""),
  ),
);
assert.deepEqual(runtimeNetworkCanary.run.evidence.network, []);
assert.match(runtimeNetworkCanary.message, /runtimeCase: network-default-denied/);
assert.match(runtimeNetworkCanary.message, /denials: [1-9]\d*/);

const runtimeNewFileCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "new-file"],
  stdinText: "runtime new file canary",
});
assert.equal(runtimeNewFileCanary.run.mode, "agent_loop");
assert.equal(runtimeNewFileCanary.run.status, "ready");
assert.ok(runtimeNewFileCanary.run.evidence.locations.length >= 1);
assert.ok(runtimeNewFileCanary.run.evidence.checkpoints.some((checkpoint) => checkpoint.existed === false));
assert.equal(runtimeNewFileCanary.run.evidence.denials.length, 0);
assert.match(runtimeNewFileCanary.message, /runtimeCase: new-file-checkpoint/);
assert.match(runtimeNewFileCanary.message, /checkpoints: [1-9]\d*/);

const runtimeSecretReadCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "4"],
  stdinText: "runtime secret read canary",
});
assert.equal(runtimeSecretReadCanary.run.mode, "agent_loop");
assert.deepEqual(runtimeSecretReadCanary.run.requiredAuthorizations, ["risk:credential"]);
assert.ok(
  runtimeSecretReadCanary.run.evidence.denials.some(
    (denial) => denial.intent?.type === "read" && denial.intent?.risk === "credential",
  ),
);
assert.match(runtimeSecretReadCanary.message, /runtimeCase: secret-read-denied/);
assert.match(runtimeSecretReadCanary.message, /denials: [1-9]\d*/);

const runtimeSecretWriteCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "5"],
  stdinText: "runtime secret write canary",
});
assert.equal(runtimeSecretWriteCanary.run.mode, "agent_loop");
assert.ok(
  runtimeSecretWriteCanary.run.evidence.denials.some(
    (denial) =>
      denial.intent?.type === "write" &&
      denial.intent?.risk === "credential" &&
      denial.gate === "policy",
  ),
);
assert.equal(runtimeSecretWriteCanary.run.evidence.checkpoints.length, 0);
assert.ok(!JSON.stringify(runtimeSecretWriteCanary.run).includes("ODAI_RUNTIME_CANARY_SECRET"));
assert.match(runtimeSecretWriteCanary.message, /runtimeCase: secret-write-denied/);
assert.match(runtimeSecretWriteCanary.message, /denials: [1-9]\d*/);
assert.match(runtimeSecretWriteCanary.message, /checkpoints: 0/);

const runtimeRedactionCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "6"],
  stdinText: "runtime redaction canary",
});
assert.equal(runtimeRedactionCanary.run.mode, "agent_loop");
assert.ok(
  runtimeRedactionCanary.run.evidence.denials.some(
    (denial) => denial.intent?.type === "network" && !denial.intent.url.includes("odai-runtime-secret"),
  ),
);
assert.ok(!JSON.stringify(runtimeRedactionCanary.run).includes("odai-runtime-secret"));
assert.match(runtimeRedactionCanary.message, /runtimeCase: sensitive-intent-redaction/);
assert.match(runtimeRedactionCanary.message, /denials: [1-9]\d*/);

const runtimeModelOutputRedactionCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "13"],
  stdinText: "",
});
assert.equal(runtimeModelOutputRedactionCanary.run.mode, "agent_loop");
assert.equal(runtimeModelOutputRedactionCanary.run.status, "ready");
assert.ok(!JSON.stringify(runtimeModelOutputRedactionCanary.run).includes("odai-model-output-secret"));
assert.ok(!JSON.stringify(runtimeModelOutputRedactionCanary.run).includes("odai-model-bearer-secret"));
assert.ok(!JSON.stringify(runtimeModelOutputRedactionCanary.run).includes("odai-model-finding-secret"));
assert.ok(!runtimeModelOutputRedactionCanary.message.includes("odai-model-output-secret"));
assert.ok(JSON.stringify(runtimeModelOutputRedactionCanary.run).includes("[redacted]"));
assert.match(runtimeModelOutputRedactionCanary.message, /runtimeCase: model-output-redaction/);

const runtimeProviderErrorRedactionCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "14"],
  stdinText: "",
});
assert.equal(runtimeProviderErrorRedactionCanary.run.mode, "agent_loop");
assert.equal(runtimeProviderErrorRedactionCanary.run.status, "failed");
assert.ok(!JSON.stringify(runtimeProviderErrorRedactionCanary.run).includes("odai-provider-error-secret"));
assert.ok(!JSON.stringify(runtimeProviderErrorRedactionCanary.run).includes("odai-provider-error-bearer-secret"));
assert.ok(!JSON.stringify(runtimeProviderErrorRedactionCanary.run).includes("odai-provider-error-token-secret"));
assert.ok(!JSON.stringify(runtimeProviderErrorRedactionCanary.run).includes("\\u001b"));
assert.ok(!JSON.stringify(runtimeProviderErrorRedactionCanary.run).includes("\u001b"));
assert.ok(!runtimeProviderErrorRedactionCanary.message.includes("odai-provider-error-secret"));
assert.ok(JSON.stringify(runtimeProviderErrorRedactionCanary.run).includes("[redacted]"));
assert.match(runtimeProviderErrorRedactionCanary.message, /runtimeCase: provider-error-redaction/);

const runtimeProviderSessionRedactionCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "15"],
  stdinText: "",
});
assert.equal(runtimeProviderSessionRedactionCanary.run.mode, "agent_loop");
assert.equal(runtimeProviderSessionRedactionCanary.run.status, "ready");
const runtimeProviderSessionJson = JSON.stringify(runtimeProviderSessionRedactionCanary.run);
assert.ok(!runtimeProviderSessionJson.includes("odai-provider-session-secret"));
assert.ok(!runtimeProviderSessionJson.includes("odai-provider-session-bearer-secret"));
assert.ok(!runtimeProviderSessionJson.includes("odai-provider-session-token-secret"));
assert.ok(runtimeProviderSessionJson.includes("session:normal-id"));
assert.ok(runtimeProviderSessionJson.includes("[redacted]"));
assert.match(runtimeProviderSessionRedactionCanary.message, /runtimeCase: provider-session-redaction/);

const runtimeProviderContextRedactionCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "16"],
  stdinText: "",
});
assert.equal(runtimeProviderContextRedactionCanary.run.mode, "agent_loop");
assert.equal(runtimeProviderContextRedactionCanary.run.status, "ready");
const runtimeProviderContextJson = JSON.stringify(runtimeProviderContextRedactionCanary.run);
assert.ok(!runtimeProviderContextJson.includes("risk:production"));
assert.ok(!runtimeProviderContextJson.includes("risk:credential"));
assert.ok(!runtimeProviderContextJson.includes("risk:billing"));
assert.ok(!runtimeProviderContextJson.includes("api-key-confirmation"));
assert.ok(!runtimeProviderContextJson.includes("provider-command-confirmation"));
assert.ok(!runtimeProviderContextJson.includes("odai-runtime-canary-context-transcript-secret"));
assert.ok(!runtimeProviderContextJson.includes("odai-runtime-canary-current-transcript-secret"));
assert.ok(!runtimeProviderContextJson.includes("odai-runtime-canary-run-record-secret"));
assert.ok(!runtimeProviderContextJson.includes("other-context-session-should-not-leak"));
assert.ok(!runtimeProviderContextJson.includes("mock-main-context-session"));
assert.ok(!runtimeProviderContextRedactionCanary.message.includes("risk:production"));
assert.match(runtimeProviderContextRedactionCanary.message, /runtimeCase: provider-context-redaction/);

const runtimeTaskPersistenceRedactionCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "17"],
  stdinText: "",
});
assert.equal(runtimeTaskPersistenceRedactionCanary.run.mode, "agent_loop");
assert.equal(runtimeTaskPersistenceRedactionCanary.run.status, "ready");
const runtimeTaskPersistenceJson = JSON.stringify(runtimeTaskPersistenceRedactionCanary.run);
assert.ok(!runtimeTaskPersistenceJson.includes("odai-task-secret"));
assert.ok(!runtimeTaskPersistenceJson.includes("odai-task-bearer-secret"));
assert.ok(!runtimeTaskPersistenceJson.includes("odai-task-token-secret"));
assert.ok(runtimeTaskPersistenceJson.includes("[redacted]"));
assert.ok(!runtimeTaskPersistenceRedactionCanary.message.includes("odai-task-secret"));
assert.match(runtimeTaskPersistenceRedactionCanary.message, /runtimeCase: task-persistence-redaction/);

const runtimeStopCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "7"],
  stdinText: "runtime stop canary",
});
assert.equal(runtimeStopCanary.run.mode, "agent_loop");
assert.ok(runtimeStopCanary.run.evidence.denials.some((denial) => denial.gate === "evidence"));
assert.ok(runtimeStopCanary.run.evidence.denials.some((denial) => denial.gate === "stop"));
assert.equal(runtimeStopCanary.run.evidence.checkpoints.length, 0);
assert.match(runtimeStopCanary.message, /runtimeCase: stop-repeated-failure/);
assert.match(runtimeStopCanary.message, /denials: [1-9]\d*/);

const runtimePerceptionCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "8"],
  stdinText: "runtime perception canary",
});
assert.equal(runtimePerceptionCanary.run.mode, "agent_loop");
assert.ok(
  runtimePerceptionCanary.run.evidence.denials.some(
    (denial) => denial.gate === "perception" && denial.intent?.risk === "perception",
  ),
);
assert.equal(runtimePerceptionCanary.run.evidence.checkpoints.length, 0);
assert.match(runtimePerceptionCanary.message, /runtimeCase: perception-write-denied/);
assert.match(runtimePerceptionCanary.message, /denials: [1-9]\d*/);

const runtimeShellCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "9"],
  stdinText: "runtime shell canary",
});
assert.equal(runtimeShellCanary.run.mode, "agent_loop");
assert.ok(runtimeShellCanary.run.evidence.commands.length >= 1);
assert.ok(
  runtimeShellCanary.run.agentLoop.turns.some((turn) =>
    turn.toolResults.some((result) => result.type === "shell" && result.skipped === true),
  ),
);
assert.equal(runtimeShellCanary.run.evidence.denials.length, 0);
assert.equal(runtimeShellCanary.run.evidence.checkpoints.length, 0);
assert.equal(existsSync(path.join(repoRoot, "runtime-canary-shell-target.txt")), false);
assert.ok(!JSON.stringify(runtimeShellCanary.run).includes("odai-shell-secret-token"));
assert.ok(!JSON.stringify(runtimeShellCanary.run).includes("odai-shell-env-secret"));
assert.ok(!runtimeShellCanary.message.includes("odai-shell-secret-token"));
assert.ok(!runtimeShellCanary.message.includes("odai-shell-env-secret"));
assert.match(runtimeShellCanary.message, /runtimeCase: shell-intent-record-only/);
assert.match(runtimeShellCanary.message, /commands: [1-9]\d*/);

const runtimeSubagentUserChannelCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "10"],
  stdinText: "runtime subagent user channel canary",
});
assert.equal(runtimeSubagentUserChannelCanary.run.mode, "subagent");
assert.equal(runtimeSubagentUserChannelCanary.run.subagent.provider, "mock-reviewer");
assert.ok(
  runtimeSubagentUserChannelCanary.run.evidence.denials.some(
    (denial) => denial.gate === "subagent-boundary" && denial.intent?.type === "ask-user",
  ),
);
assert.ok(
  runtimeSubagentUserChannelCanary.run.evidence.denials.some(
    (denial) => denial.gate === "subagent-boundary" && denial.intent?.type === "complete",
  ),
);
assert.match(runtimeSubagentUserChannelCanary.message, /runtimeCase: subagent-user-channel-denied/);
assert.match(runtimeSubagentUserChannelCanary.message, /denials: [2-9]\d*/);

const runtimeOverflowCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "11"],
  stdinText: "runtime overflow canary",
});
assert.equal(runtimeOverflowCanary.run.mode, "agent_loop");
assert.equal(runtimeOverflowCanary.run.agentLoop.completed, false);
assert.equal(runtimeOverflowCanary.run.agentLoop.stopReason, "tool_intent_limit_exceeded");
assert.equal(runtimeOverflowCanary.run.agentLoop.turns[0].toolIntentOverflow.count, 21);
assert.equal(runtimeOverflowCanary.run.agentLoop.turns[0].toolIntents.length, 0);
assert.equal(runtimeOverflowCanary.run.evidence.reads.length, 0);
assert.ok(
  runtimeOverflowCanary.run.evidence.denials.some(
    (denial) => denial.intent?.type === "tool-intent-batch" && denial.intent.count === 21,
  ),
);
assert.match(runtimeOverflowCanary.message, /runtimeCase: tool-intent-overflow-denied/);
assert.match(runtimeOverflowCanary.message, /denials: [1-9]\d*/);

const runtimePayloadLimitCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "18"],
  stdinText: "runtime payload limit canary",
});
assert.equal(runtimePayloadLimitCanary.run.mode, "agent_loop");
assert.equal(runtimePayloadLimitCanary.run.status, "ready");
assert.ok(
  runtimePayloadLimitCanary.run.evidence.denials.some(
    (denial) =>
      denial.gate === "policy" &&
      denial.intent?.type === "tool-intent-payload" &&
      denial.intent?.originalType === "write",
  ),
);
assert.equal(runtimePayloadLimitCanary.run.evidence.checkpoints.length, 0);
assert.equal(existsSync(path.join(repoRoot, ".odai", "runs", "runtime-canary-payload-target.txt")), false);
assert.ok(!JSON.stringify(runtimePayloadLimitCanary.run).includes("x".repeat(1000)));
assert.match(runtimePayloadLimitCanary.message, /runtimeCase: tool-intent-payload-denied/);
assert.match(runtimePayloadLimitCanary.message, /denials: [1-9]\d*/);

const runtimeProductionAuthCanary = await runCanaryRunner({
  repoRoot,
  argv: ["--runtime-case", "12"],
  stdinText: "runtime production auth canary",
});
assert.equal(runtimeProductionAuthCanary.run.mode, "agent_loop");
assert.deepEqual(runtimeProductionAuthCanary.run.requiredAuthorizations, ["risk:production"]);
assert.ok(
  runtimeProductionAuthCanary.run.evidence.denials.some(
    (denial) =>
      denial.gate === "authorization" &&
      denial.intent?.type === "shell" &&
      denial.intent?.risk === "production",
  ),
);
assert.equal(runtimeProductionAuthCanary.run.evidence.commands.length, 0);
assert.equal(runtimeProductionAuthCanary.run.evidence.checkpoints.length, 0);
assert.match(runtimeProductionAuthCanary.message, /runtimeCase: production-authorization-denied/);
assert.match(runtimeProductionAuthCanary.message, /denials: [1-9]\d*/);

const subagentWrite = await dispatcher.dispatch({
  actor: { kind: "subagent", id: subagentResult.agent.id },
  type: "write",
  path: sampleFile,
  content: "subagent wrote\n",
});
assert.equal(subagentWrite.ok, false);
assert.equal(subagentWrite.gate, "subagent-boundary");
assert.equal(await readFile(sampleFile, "utf8"), "after\n");

const ledgerEvents = evidence.snapshot().events;
assert.ok(ledgerEvents.some((event) => event.type === "read"));
assert.ok(ledgerEvents.some((event) => event.type === "write"));
assert.ok(ledgerEvents.some((event) => event.type === "denial" && event.gate === "subagent-boundary"));
assert.ok(ledgerEvents.some((event) => event.type === "subagent"));
const rawSubagentEvidence = new EvidenceLedger();
rawSubagentEvidence.recordSubagent({
  agent: { id: "raw-subagent", profile: "reviewer" },
  adopted: false,
  output: {
    provider: "raw-provider",
    text: "raw provider text",
    raw: { secret: "do-not-log-raw-provider-secret" },
    "api_key=raw-output-key-secret": "do-not-log-key-secret",
    patchProposal: {
      ok: true,
      type: "patch-proposal",
      patch: {
        summary: "patch summary",
        edits: [{ path: "safe.txt", content: "do-not-log-patch-content" }],
      },
    },
    unverified: ["raw output token=raw-unverified-secret"],
  },
});
const rawSubagentSnapshotText = JSON.stringify(rawSubagentEvidence.snapshot());
assert.ok(!rawSubagentSnapshotText.includes("do-not-log-raw-provider-secret"));
assert.ok(!rawSubagentSnapshotText.includes("do-not-log-patch-content"));
assert.ok(!rawSubagentSnapshotText.includes("raw-unverified-secret"));
assert.ok(!rawSubagentSnapshotText.includes("raw-output-key-secret"));
assert.ok(!rawSubagentSnapshotText.includes("do-not-log-key-secret"));
assert.ok(rawSubagentSnapshotText.includes("api_key=[redacted]"));
assert.equal(rawSubagentEvidence.snapshot().subagents[0].output.patchProposal.editPaths[0], "safe.txt");

const mainProviderPrompt = createProviderPrompt({
  agent: { role: "main", id: "main:test" },
  input: { mode: "agent_loop", task: "inspect project" },
  providerName: "prompt-test",
});
assert.ok(mainProviderPrompt.includes("main odai CLI agent"));
assert.ok(!mainProviderPrompt.includes("You are an odai subagent"));
assert.ok(mainProviderPrompt.includes("list, read, search, write, shell, network"));
assert.ok(mainProviderPrompt.includes("project files are not directly visible"));
assert.ok(mainProviderPrompt.includes("backend routing details"));
assert.ok(mainProviderPrompt.includes("say you are the odai CLI agent"));
assert.ok(mainProviderPrompt.includes('"type":"list"'));
assert.ok(mainProviderPrompt.includes('"type":"search"'));
const subagentProviderPrompt = createProviderSystemPrompt({
  agent: { profile: "reviewer", id: "reviewer:test" },
  input: { task: "review" },
  providerName: "prompt-test",
});
assert.ok(subagentProviderPrompt.includes("odai subagent for profile 'reviewer'"));
assert.ok(subagentProviderPrompt.includes("Subagents may request list/read/search only"));

const openaiProvider = createOpenAiApiProvider({
  apiKey: "test-key",
  model: "test-model",
  fetchImpl: async (url, request) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer test-key");
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, "test-model");
    assert.deepEqual(payload.reasoning, { effort: "high" });
    assert.deepEqual(JSON.parse(payload.input).modelOptions, { reasoning: "high", contextWindowTokens: 1000000 });
    return {
      ok: true,
      async json() {
        return {
          id: "resp-openai-1",
          output_text: "structured provider result",
          usage: { input_tokens: 3, output_tokens: 4 },
        };
      },
    };
  },
  allowApiKey: true,
});
const openaiResult = await openaiProvider.run({
  agent: { id: "provider-test" },
  input: { task: "hello", modelOptions: { reasoning: "high", contextWindowTokens: 1000000 } },
});
assert.equal(openaiResult.text, "structured provider result");
assert.deepEqual(openaiResult.usage, { input_tokens: 3, output_tokens: 4 });
assert.deepEqual(openaiResult.providerSession, {
  provider: "openai-api",
  model: "test-model",
  responseId: "resp-openai-1",
});

const openaiModelRequiredProvider = createOpenAiApiProvider({
  apiKey: "test-key",
  fetchImpl: async (url, request) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, "override-model");
    return {
      ok: true,
      async json() {
        return {
          id: "resp-openai-override",
          output_text: "override provider result",
        };
      },
    };
  },
  allowApiKey: true,
});
assert.equal(openaiModelRequiredProvider.available, false);
assert.equal(openaiModelRequiredProvider.blockedReason, "model_required");
const openaiOverriddenProvider = withProviderModelOverride(openaiModelRequiredProvider, "override-model");
assert.equal(openaiOverriddenProvider.available, true);
assert.equal(openaiOverriddenProvider.source.modelOverridePresent, true);
const openaiOverrideResult = await openaiOverriddenProvider.run({
  agent: { id: "provider-override-test" },
  input: { task: "hello override" },
});
assert.equal(openaiOverrideResult.model, "override-model");
assert.equal(openaiOverrideResult.providerSession.model, "override-model");

const openaiToolIntentProvider = createOpenAiApiProvider({
  apiKey: "test-key",
  model: "test-model",
  fetchImpl: async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({
          text: "read requested",
          toolIntents: [{ type: "read", path: "cli/src/index.mjs" }],
        }),
      };
    },
  }),
  allowApiKey: true,
});
const openaiToolIntentResult = await openaiToolIntentProvider.run({
  agent: { id: "provider-tool-test" },
  input: { task: "read" },
});
assert.equal(openaiToolIntentResult.text, "read requested");
assert.deepEqual(openaiToolIntentResult.toolIntents, [
  { type: "read", path: "cli/src/index.mjs", risk: undefined },
]);

const openaiStreamEvents = [];
let openaiStreamRequestBody;
const openaiStreamingProvider = createOpenAiApiProvider({
  apiKey: "test-key",
  model: "test-model",
  fetchImpl: async (_url, request) => {
    openaiStreamRequestBody = JSON.parse(request.body);
    return {
      ok: true,
      status: 200,
      body: streamText([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"text\\":\\"stream "}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok\\",\\"toolIntents\\":[{\\"type\\":\\"read\\",\\"path\\":\\"cli/src/index.mjs\\"}]}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-stream-1","usage":{"input_tokens":5,"output_tokens":6}}}\n\n',
      ]),
    };
  },
  allowApiKey: true,
});
const openaiStreamingResult = await openaiStreamingProvider.run({
  agent: { id: "provider-stream-test" },
  input: { task: "stream" },
  onEvent: (event) => openaiStreamEvents.push(event),
});
assert.equal(openaiStreamRequestBody.stream, true);
assert.equal(openaiStreamingResult.text, "stream ok");
assert.deepEqual(openaiStreamingResult.toolIntents, [
  { type: "read", path: "cli/src/index.mjs", risk: undefined },
]);
assert.deepEqual(openaiStreamingResult.usage, { input_tokens: 5, output_tokens: 6 });
assert.equal(openaiStreamingResult.providerSession.responseId, "resp-stream-1");
assert.ok(openaiStreamEvents.some((event) => event.type === "provider-text" && event.provider === "openai-api"));
assert.ok(
  openaiStreamEvents.some(
    (event) =>
      event.type === "provider-usage" &&
      event.provider === "openai-api" &&
      event.usage?.input_tokens === 5 &&
      event.usage?.output_tokens === 6,
  ),
);

const anthropicProvider = createAnthropicApiProvider({
  apiKey: "anthropic-key",
  model: "anthropic-model",
  fetchImpl: async (url, request) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-api-key"], "anthropic-key");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, "anthropic-model");
    assert.equal(payload.max_tokens, 2048);
    assert.equal(payload.messages[0].role, "user");
    return {
      ok: true,
      async json() {
        return {
          id: "msg-anthropic-1",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                text: "anthropic read requested",
                toolIntents: [{ type: "read", path: "cli/src/index.mjs" }],
              }),
            },
          ],
          usage: { input_tokens: 5, output_tokens: 6 },
        };
      },
    };
  },
  allowApiKey: true,
});
const anthropicResult = await anthropicProvider.run({
  agent: { id: "anthropic-test" },
  input: { task: "hello" },
});
assert.equal(anthropicResult.text, "anthropic read requested");
assert.deepEqual(anthropicResult.toolIntents, [{ type: "read", path: "cli/src/index.mjs", risk: undefined }]);
assert.deepEqual(anthropicResult.usage, { input_tokens: 5, output_tokens: 6 });
assert.deepEqual(anthropicResult.providerSession, {
  provider: "anthropic-api",
  model: "anthropic-model",
  messageId: "msg-anthropic-1",
});

const anthropicStreamEvents = [];
let anthropicStreamRequestBody;
const anthropicStreamingProvider = createAnthropicApiProvider({
  apiKey: "anthropic-key",
  model: "anthropic-model",
  fetchImpl: async (_url, request) => {
    anthropicStreamRequestBody = JSON.parse(request.body);
    return {
      ok: true,
      status: 200,
      body: streamText([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-stream-1","usage":{"input_tokens":2}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"text\\":\\"anthropic "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream\\",\\"toolIntents\\":[{\\"type\\":\\"read\\",\\"path\\":\\"cli/src/index.mjs\\"}]}"} }\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    };
  },
  allowApiKey: true,
});
const anthropicStreamingResult = await anthropicStreamingProvider.run({
  agent: { id: "anthropic-stream-test" },
  input: { task: "stream" },
  onEvent: (event) => anthropicStreamEvents.push(event),
});
assert.equal(anthropicStreamRequestBody.stream, true);
assert.equal(anthropicStreamingResult.text, "anthropic stream");
assert.deepEqual(anthropicStreamingResult.toolIntents, [
  { type: "read", path: "cli/src/index.mjs", risk: undefined },
]);
assert.deepEqual(anthropicStreamingResult.usage, { input_tokens: 2, output_tokens: 4 });
assert.equal(anthropicStreamingResult.providerSession.messageId, "msg-stream-1");
assert.ok(anthropicStreamEvents.some((event) => event.type === "provider-text" && event.provider === "anthropic-api"));
assert.ok(
  anthropicStreamEvents.some(
    (event) =>
      event.type === "provider-usage" &&
      event.provider === "anthropic-api" &&
      event.usage?.input_tokens === 2 &&
      event.usage?.output_tokens === 4,
  ),
);

const geminiProvider = createGeminiApiProvider({
  apiKey: "gemini-key",
  model: "gemini-test",
  fetchImpl: async (url, request) => {
    assert.equal(
      url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=gemini-key",
    );
    assert.equal(request.method, "POST");
    const payload = JSON.parse(request.body);
    assert.equal(payload.contents[0].role, "user");
    assert.ok(payload.systemInstruction.parts[0].text.includes("strict JSON"));
    return {
      ok: true,
      async json() {
        return {
          responseId: "gemini-response-1",
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      text: "gemini result",
                      toolIntents: [{ type: "read", path: "cli/src/index.mjs" }],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 },
        };
      },
    };
  },
  allowApiKey: true,
});
const geminiResult = await geminiProvider.run({
  agent: { id: "gemini-test" },
  input: { task: "hello" },
});
assert.equal(geminiResult.text, "gemini result");
assert.deepEqual(geminiResult.toolIntents, [{ type: "read", path: "cli/src/index.mjs", risk: undefined }]);
assert.deepEqual(geminiResult.usage, { promptTokenCount: 7, candidatesTokenCount: 8 });
assert.equal(geminiResult.providerSession.responseId, "gemini-response-1");

const ollamaProvider = createOllamaProvider({
  name: "ollama-test",
  baseUrl: "http://localhost:11434/",
  model: "llama3.2",
  fetchImpl: async (url, request) => {
    assert.equal(url, "http://localhost:11434/api/chat");
    assert.equal(request.method, "POST");
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, "llama3.2");
    assert.equal(payload.stream, false);
    assert.equal(payload.messages[0].role, "system");
    assert.ok(payload.messages[0].content.includes("strict JSON"));
    assert.equal(payload.messages[1].role, "user");
    return {
      ok: true,
      async json() {
        return {
          model: "llama3.2",
          created_at: "2026-07-06T00:00:00Z",
          message: {
            role: "assistant",
            content: JSON.stringify({
              text: "ollama result",
              toolIntents: [{ type: "read", path: "cli/src/index.mjs" }],
            }),
          },
          done: true,
          prompt_eval_count: 9,
          eval_count: 10,
          total_duration: 100,
        };
      },
    };
  },
});
const ollamaResult = await ollamaProvider.run({
  agent: { id: "ollama-test" },
  input: { task: "hello" },
});
assert.equal(ollamaResult.text, "ollama result");
assert.deepEqual(ollamaResult.toolIntents, [{ type: "read", path: "cli/src/index.mjs", risk: undefined }]);
assert.deepEqual(ollamaResult.usage, {
  total_duration: 100,
  prompt_eval_count: 9,
  eval_count: 10,
});
assert.equal(ollamaResult.providerSession.createdAt, "2026-07-06T00:00:00Z");

const openaiBlockedProvider = createOpenAiApiProvider({
  apiKey: "test-key",
  fetchImpl: async () => {
    throw new Error("fetch should not be called without --use-api-key");
  },
});
assert.equal(openaiBlockedProvider.available, false);
await assert.rejects(
  () => openaiBlockedProvider.run({ agent: { id: "blocked" }, input: { task: "hello" } }),
  /requires explicit --use-api-key/,
);

const compatibleProvider = createOpenAiCompatibleProvider({
  name: "compat-provider",
  baseUrl: "https://compat.example/v1/",
  apiKey: "compat-key",
  model: "compat-model",
  allowApiKey: true,
  fetchImpl: async (url, request) => {
    assert.equal(url, "https://compat.example/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer compat-key");
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, "compat-model");
    assert.equal(payload.reasoning_effort, "medium");
    assert.equal(payload.messages[0].role, "system");
    assert.deepEqual(JSON.parse(payload.messages[1].content).modelOptions, { reasoning: "medium" });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: "compat result" } }] };
      },
    };
  },
});
const compatibleResult = await compatibleProvider.run({
  agent: { id: "compat-test" },
  input: { task: "hello", modelOptions: { reasoning: "medium" } },
});
assert.equal(compatibleResult.text, "compat result");
const compatibleStreamEvents = [];
let compatibleStreamRequestBody;
const compatibleStreamingProvider = createOpenAiCompatibleProvider({
  name: "compat-stream-provider",
  baseUrl: "https://compat-stream.example/v1/",
  apiKey: "compat-key",
  model: "compat-stream-model",
  allowApiKey: true,
  fetchImpl: async (url, request) => {
    assert.equal(url, "https://compat-stream.example/v1/chat/completions");
    compatibleStreamRequestBody = JSON.parse(request.body);
    return {
      ok: true,
      status: 200,
      body: streamText([
        'data: {"id":"chatcmpl-stream-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"{\\"text\\":\\"compat "}}]}\n\n',
        'data: {"id":"chatcmpl-stream-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"stream\\",\\"toolIntents\\":[{\\"type\\":\\"read\\",\\"path\\":\\"cli/src/index.mjs\\"}]}"},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chatcmpl-stream-1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":8,"total_tokens":15}}\n\n',
        "data: [DONE]\n\n",
      ]),
    };
  },
});
const compatibleStreamingResult = await compatibleStreamingProvider.run({
  agent: { id: "compat-stream-test" },
  input: { task: "stream" },
  onEvent: (event) => compatibleStreamEvents.push(event),
});
assert.equal(compatibleStreamRequestBody.stream, true);
assert.deepEqual(compatibleStreamRequestBody.stream_options, { include_usage: true });
assert.equal(compatibleStreamingResult.text, "compat stream");
assert.deepEqual(compatibleStreamingResult.toolIntents, [
  { type: "read", path: "cli/src/index.mjs", risk: undefined },
]);
assert.deepEqual(compatibleStreamingResult.usage, {
  prompt_tokens: 7,
  completion_tokens: 8,
  total_tokens: 15,
});
assert.equal(compatibleStreamingResult.providerSession.responseId, "chatcmpl-stream-1");
assert.ok(
  compatibleStreamEvents.some(
    (event) => event.type === "provider-text" && event.provider === "compat-stream-provider",
  ),
);
assert.ok(
  compatibleStreamEvents.some(
    (event) =>
      event.type === "provider-usage" &&
      event.provider === "compat-stream-provider" &&
      event.usage?.prompt_tokens === 7 &&
      event.usage?.completion_tokens === 8 &&
      event.usage?.total_tokens === 15,
  ),
);
const compatibleRootProvider = createOpenAiCompatibleProvider({
  name: "compat-root-provider",
  baseUrl: "https://compat-root.example",
  apiKey: "compat-key",
  model: "compat-model",
  allowApiKey: true,
  fetchImpl: async (url, request) => {
    assert.equal(url, "https://compat-root.example/v1/chat/completions");
    assert.equal(request.method, "POST");
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: "compat root result" } }] };
      },
    };
  },
});
const compatibleRootResult = await compatibleRootProvider.run({
  agent: { id: "compat-root-test" },
  input: { task: "hello" },
});
assert.equal(compatibleRootResult.text, "compat root result");
const compatibleErrorProvider = createOpenAiCompatibleProvider({
  name: "compat-error-provider",
  baseUrl: "https://compat-error.example",
  apiKey: "compat-key",
  model: "compat-model",
  allowApiKey: true,
  fetchImpl: async () => ({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    async text() {
      return JSON.stringify({ error: { message: "official clients only" } });
    },
  }),
});
await assert.rejects(
  () => compatibleErrorProvider.run({ agent: { id: "compat-error-test" }, input: { task: "hello" } }),
  /official clients only/,
);

const commandProvider = createCommandJsonProvider({
  name: "command-provider",
  command: "fake-model",
  installed: true,
  allowProviderCommand: true,
  runCommand: (command, args, options) => {
    assert.equal(command, "fake-model");
    assert.deepEqual(args, []);
    assert.match(options.input, /You are an odai provider process/);
    assert.match(options.input, /project files are not directly visible/);
    assert.match(options.input, /list, read, search, write, shell, network/);
    assert.match(options.input, /"task": "hello"/);
    assert.equal(options.cwd.includes("odai-command-json-"), true);
    assert.equal(options.timeoutMs, 120000);
    assert.equal(options.maxOutputChars, 200000);
    return {
      status: 0,
      stdout: JSON.stringify({
        text: "command result",
        toolIntents: [{ type: "read", path: "cli/src/index.mjs" }],
      }),
      stderr: "",
    };
  },
});
const commandResult = await commandProvider.run({
  agent: { id: "command-test" },
  input: { task: "hello" },
});
assert.equal(commandResult.text, "command result");
assert.deepEqual(commandResult.toolIntents, [{ type: "read", path: "cli/src/index.mjs", risk: undefined }]);
const asyncCommandProviderScript = path.join(sessionTmp, "command-json-provider-async.mjs");
await writeFile(
  asyncCommandProviderScript,
  [
    "setTimeout(() => {",
    "  console.log(JSON.stringify({ text: 'async command result' }));",
    "}, 150);",
    "",
  ].join("\n"),
  "utf8",
);
const asyncCommandProvider = createCommandJsonProvider({
  name: "async-command-provider",
  command: process.execPath,
  args: [asyncCommandProviderScript],
  installed: true,
  allowProviderCommand: true,
  timeoutMs: 5000,
});
let asyncCommandSettled = false;
const asyncCommandRun = asyncCommandProvider
  .run({
    agent: { id: "async-command-test" },
    input: { task: "hello async" },
  })
  .finally(() => {
    asyncCommandSettled = true;
  });
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(asyncCommandSettled, false);
const asyncCommandResult = await asyncCommandRun;
assert.equal(asyncCommandResult.text, "async command result");

const commandProviderWithModelArgs = createCommandJsonProvider({
  name: "command-provider-with-model",
  command: "fake-model",
  args: ["--json"],
  modelArgs: ["--model", "{model}", "--label={model}"],
  installed: true,
  allowProviderCommand: true,
  runCommand: (command, args, options) => {
    assert.equal(command, "fake-model");
    assert.deepEqual(args, ["--json", "--model", "cli-model", "--label=cli-model"]);
    assert.match(options.input, /"modelOverride": "cli-model"/);
    return {
      status: 0,
      stdout: JSON.stringify({
        text: "modeled command result",
      }),
      stderr: "",
    };
  },
});
assert.equal(commandProviderWithModelArgs.source.modelArgsPresent, true);
const commandModelResult = await commandProviderWithModelArgs.run({
  agent: { id: "command-model-test" },
  input: { task: "hello", modelOverride: "cli-model" },
});
assert.equal(commandModelResult.model, "cli-model");
assert.equal(commandModelResult.text, "modeled command result");

const commandBlockedProvider = createCommandJsonProvider({
  name: "blocked-command-provider",
  command: "fake-model",
  installed: true,
  runCommand: () => {
    throw new Error("command should not run without explicit confirmation");
  },
});
assert.equal(commandBlockedProvider.available, false);
assert.equal(commandBlockedProvider.blockedReason, "provider_command_requires_explicit_use");
await assert.rejects(
  () => commandBlockedProvider.run({ agent: { id: "blocked-command" }, input: { task: "hello" } }),
  /requires explicit --use-provider-command/,
);

assert.deepEqual(parseInteractiveArgs('task "two words" --file path\\ with\\ spaces'), [
  "task",
  "two words",
  "--file",
  "path with spaces",
]);
assert.deepEqual(normalizeTaskArgv(["initial task"]), [
  "initial task",
  "--save",
  "--agent-loop",
  "--provider",
  "auto",
]);
assert.deepEqual(normalizeTaskArgv(["initial task", "--save", "--agent-loop"]), [
  "initial task",
  "--save",
  "--agent-loop",
  "--provider",
  "auto",
]);
assert.deepEqual(normalizeTaskArgv(["initial task", "--provider", "mock-main"]), [
  "initial task",
  "--provider",
  "mock-main",
  "--save",
  "--agent-loop",
]);
assert.deepEqual(normalizeTaskArgv(["initial task", "--provider=mock-main"]), [
  "initial task",
  "--provider=mock-main",
  "--save",
  "--agent-loop",
]);
assert.deepEqual(normalizeTaskArgv(["initial task"], { defaultProvider: "mock-main", defaultModel: "mock-session-model" }), [
  "initial task",
  "--save",
  "--agent-loop",
  "--provider",
  "mock-main",
  "--model",
  "mock-session-model",
]);
assert.deepEqual(
  normalizeTaskArgv(["initial task"], {
    defaultProvider: "mock-main",
    defaultReasoning: "high",
    defaultContextWindowTokens: 1000000,
  }),
  [
    "initial task",
    "--save",
    "--agent-loop",
    "--provider",
    "mock-main",
    "--reasoning",
    "high",
    "--context",
    "1000000",
  ],
);
assert.deepEqual(
  normalizeTaskArgv(["initial task"], {
    defaultProvider: "mock-main",
    sessionAuth: { useApiKey: true, useProviderCommand: true },
  }),
  [
    "initial task",
    "--save",
    "--agent-loop",
    "--provider",
    "mock-main",
    "--use-api-key",
    "--use-provider-command",
  ],
);
assert.deepEqual(
  normalizeTaskArgv(["initial task"], {
    defaultProvider: "claude-cli",
    sessionAuth: { providerCommands: ["claude-cli"] },
  }),
  [
    "initial task",
    "--save",
    "--agent-loop",
    "--provider",
    "claude-cli",
    "--use-provider-command=claude-cli",
  ],
);
assert.deepEqual(
  normalizeTaskArgv(["initial task", "--use-api-key=false"], {
    defaultProvider: "mock-main",
    sessionAuth: { useApiKey: true, useProviderCommand: true },
  }),
  [
    "initial task",
    "--use-api-key=false",
    "--save",
    "--agent-loop",
    "--provider",
    "mock-main",
    "--use-provider-command",
  ],
);
const publicInitialTaskArgv = publicTaskArgv([
  "initial task",
  "--use-api-key=true",
  "--use-provider-command=true",
  "--allow-shell=true",
  "--allow-network=true",
  "--file",
  sampleFile,
]);
assert.deepEqual(publicInitialTaskArgv.slice(0, 2), ["initial task", "--file"]);
assert.equal(normalizePathForCompare(publicInitialTaskArgv[2]), normalizePathForCompare(sampleFile));

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

function streamText(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

console.log("phase0 smoke ok");

async function runCliBin(args = [], stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "cli", "bin", "odai.mjs"), ...args], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH || "",
        TMPDIR: process.env.TMPDIR || tmpdir(),
        ODAI_LANG: "en",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(stdinText);
  });
}

async function runCliExecutable(args = [], stdinText = "") {
  return new Promise((resolve, reject) => {
    const executablePath = path.join(repoRoot, "cli", "bin", "odai.mjs");
    const command = process.platform === "win32" ? process.execPath : executablePath;
    const commandArgs = process.platform === "win32" ? [executablePath, ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH || "",
        TMPDIR: process.env.TMPDIR || tmpdir(),
        ODAI_LANG: "en",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(stdinText);
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePathForCompare(value) {
  const normalized = path.resolve(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeSlashes(value) {
  return String(value).replaceAll("\\", "/");
}

async function symlinkOrCopyDirectory(source, target) {
  try {
    await symlink(source, target, "dir");
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOSYS"].includes(error?.code)) {
      throw error;
    }
    await cp(source, target, { recursive: true });
  }
}

async function trySymlink(source, target, type) {
  try {
    await symlink(source, target, type);
    return true;
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOSYS"].includes(error?.code)) {
      throw error;
    }
    return false;
  }
}
