import { access } from "node:fs/promises";
import path from "node:path";
import { describeAcceptance } from "./acceptance-registry.mjs";
import { describeE2EReadiness } from "./e2e-readiness.mjs";
import { describeExternalEvidence } from "./external-evidence.mjs";
import { describeRuntimeGovernance } from "./governance-registry.mjs";
import { describeMilestones } from "./milestone-registry.mjs";
import { loadWorkspaceEnvironment } from "../config/provider-config.mjs";
import { detectLanguage, t } from "../runtime/i18n.mjs";

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


function parseE2EArgs(argv = []) {
  const providerCommandAuth = providerCommandAuthFromArgv(argv);
  const args = {
    useApiKey: hasFlag(argv, "--use-api-key"),
    useProviderCommand: providerCommandAuth.useProviderCommand,
    providerCommandProviders: providerCommandAuth.providerCommandProviders,
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

function providerCommandAuthFromArgv(argv = []) {
  const args = {
    useProviderCommand: false,
    providerCommandProviders: [],
  };
  for (const item of argv) {
    const option = optionToken(item);
    if (option.name === "--use-provider-command") {
      applyProviderCommandOption(args, option);
    }
  }
  return args;
}

function applyProviderCommandOption(args, option = {}) {
  if (!option.hasInlineValue) {
    args.useProviderCommand = true;
    args.providerCommandProviders = [];
    return;
  }

  const value = String(option.value || "").trim();
  const normalized = value.toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(normalized)) {
    args.useProviderCommand = true;
    args.providerCommandProviders = [];
    return;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    args.useProviderCommand = false;
    args.providerCommandProviders = [];
    return;
  }

  args.useProviderCommand = false;
  args.providerCommandProviders = normalizeProviderCommandProviders(value);
}

function normalizeProviderCommandProviders(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(
    items
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )].sort();
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
