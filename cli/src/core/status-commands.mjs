import { describeAcceptance } from "./acceptance-registry.mjs";
import { describeE2EReadiness } from "./e2e-readiness.mjs";
import { describeExternalEvidence } from "./external-evidence.mjs";
import { describeRuntimeGovernance } from "./governance-registry.mjs";
import { describeMilestones } from "./milestone-registry.mjs";
import { loadWorkspaceEnvironment } from "../config/provider-config.mjs";
import { detectLanguage, t } from "../runtime/i18n.mjs";
import {
  auditRequirement,
  authPreparationActions,
  cliSetupGuide,
  externalEvidenceRequirements,
  inspectSetupConfigFiles,
  parseE2EArgs,
  providerSetupGuide,
  relevantRunnableCommands,
  sandboxSetupGuide,
  setupCompletionPath,
  setupEvidenceSection,
  setupNextActions,
  setupReadinessSection,
  setupSection,
  statusBlockers,
  statusNextActions,
  summarizeStatusE2E,
  summarizeStatusExternalEvidence,
} from "./status-helpers.mjs";

const defaultRepoRoot = process.cwd();

export function runGovernance() {
  return describeRuntimeGovernance();
}


export function runStatus({ repoRoot: root = defaultRepoRoot, argv = [], env = process.env } = {}) {
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


export function runAudit({ repoRoot: root = defaultRepoRoot, argv = [], env = process.env } = {}) {
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


export function runEvidence({ repoRoot: root = defaultRepoRoot } = {}) {
  return describeExternalEvidence({ workspaceRoot: root });
}


export async function runSetup({ repoRoot: root = defaultRepoRoot, argv = [], env = process.env } = {}) {
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
      providerCommandProviders: args.providerCommandProviders,
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


export function runAcceptance({ repoRoot: root = defaultRepoRoot, argv = [], env = process.env } = {}) {
  const args = parseE2EArgs(argv);
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  return describeAcceptance({
    e2eReadiness: describeE2EReadiness({
      workspaceRoot: root,
      env: workspaceEnv,
      allowApiKey: args.useApiKey,
      allowProviderCommand: args.useProviderCommand,
      allowedProviderCommands: args.providerCommandProviders,
      modelOverride: args.model,
    }),
    externalEvidence: describeExternalEvidence({
      workspaceRoot: root,
    }),
  });
}


export function runMilestones({
  repoRoot: root = defaultRepoRoot,
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
      allowedProviderCommands: args.providerCommandProviders,
      modelOverride: args.model,
    }),
    externalEvidence: describeExternalEvidence({
      workspaceRoot: root,
    }),
  });
}


export function runE2EReadiness({
  repoRoot: root = defaultRepoRoot,
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
    allowedProviderCommands: args.providerCommandProviders,
    modelOverride: args.model,
    sandboxOptions,
  });
}


