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


import { sha256 } from "../helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
process.env.ODAI_LANG = "en";

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
assert.equal(packageManifest.version, "0.0.2");
assert.equal(packageManifest.private, undefined);
assert.equal(packageManifest.license, "MIT");
assert.deepEqual(packageManifest.repository, {
  type: "git",
  url: "git+https://github.com/orziz/odai.git",
  directory: "cli",
});
assert.equal(packageManifest.homepage, "https://github.com/orziz/odai#readme");
assert.equal(packageManifest.bugs.url, "https://github.com/orziz/odai/issues");
assert.equal(packageManifest.bin.odai, "bin/odai.mjs");
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


console.log('suite early-meta ok');
