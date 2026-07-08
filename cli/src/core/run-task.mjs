import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillPack } from "./skill-pack.mjs";
import { writeRunRecord, writeWorkspaceRunRecord } from "./run-store.mjs";
import { SessionState } from "./session-state.mjs";
import { appendUnique, applyProviderCommandOption, enabledFlagValue, optionToken } from "./cli-args.mjs";
import { publicError, publicTaskText } from "./public-summaries.mjs";
import { publicToolResult } from "../runtime/redaction.mjs";
import { runAgentLoop } from "../runtime/agent-loop.mjs";
import { normalizeModelOptions, parseContextWindowTokens } from "../runtime/model-options.mjs";
import { EvidenceLedger } from "../runtime/evidence-ledger.mjs";
import { ToolDispatcher } from "../runtime/tool-dispatcher.mjs";
import { UsageLedger } from "../runtime/usage-ledger.mjs";
import { collectProviderSessions } from "../runtime/provider-session.mjs";
import { Scheduler } from "../orchestrator/scheduler.mjs";
import { withProviderModelOverride } from "../orchestrator/provider-model.mjs";
import { adoptPatchProposal, summarizeMerge } from "../orchestrator/result-merger.mjs";
import { createProviderRegistryFromEnvironment, loadWorkspaceEnvironment, loadWorkspaceProviderConfig } from "../config/provider-config.mjs";
import { loadWorkspacePolicyConfig } from "../config/policy-config.mjs";
import { loadWorkspaceAgentProfiles } from "../config/agent-config.mjs";

export async function runMockTask({
  repoRoot: root = process.cwd(),
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
    allowedProviderCommands: args.providerCommandProviders,
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

function parseRunArgs(argv) {
  const args = {
    task: "",
    provider: "mock-reviewer",
    profile: "reviewer",
    files: [],
    save: false,
    useApiKey: false,
    useProviderCommand: false,
    providerCommandProviders: [],
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
      applyProviderCommandOption(args, option);
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
