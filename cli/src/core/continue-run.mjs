import path from "node:path";
import {
  hasFlag,
  optionToken,
  providerCommandAuthArgv,
  providerCommandAuthFromArgv,
} from "./cli-args.mjs";
import { publicError, publicTaskText } from "./public-summaries.mjs";
import { readLatestWorkspaceRun, writeWorkspaceRunRecord } from "./run-store.mjs";
import { runMockTask } from "./run-task.mjs";
import { runDoctor } from "./doctor.mjs";
import {
  runAcceptance,
  runAudit,
  runE2EReadiness,
  runEvidence,
  runGovernance,
  runMilestones,
  runSetup,
  runStatus,
} from "./status-commands.mjs";
import { runSandboxReadiness, runSandboxSmoke } from "./sandbox-commands.mjs";

const defaultRepoRoot = process.cwd();

export async function continueLatestRun({
  repoRoot: root = defaultRepoRoot,
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


function fallbackResumeArgv(record = {}) {
  const files = record?.evidence?.reads || [];
  return [
    publicTaskText(record.task || "continue latest task"),
    ...(record.mode === "agent_loop" ? ["--agent-loop"] : []),
    ...files.flatMap((file) => ["--file", file]),
  ];
}


export function parseResumeArgs(argv) {
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

