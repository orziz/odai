const MILESTONE_ITEMS = [
  {
    id: "P0-1",
    phase: "Phase 0",
    title: "Provider registry spike",
    requirement: "Connect at least one API-key provider path and one subscription CLI/SDK runtime provider path.",
    status: "needs-external-evidence",
    evidence: [
      "cli/src/config/provider-config.mjs: registers Claude Agent SDK, Claude CLI, OpenAI, Anthropic, Gemini, OpenAI-compatible, Ollama, command-json, Codex CLI, and Grok CLI providers.",
      "cli/tests/phase0/smoke.mjs: fake SDK/API/subprocess adapters expose provider metadata and fail closed without explicit authorization.",
      "cli/src/core/e2e-readiness.mjs: reports real provider/API/subscription runtime prerequisites and accepts --model for model-required readiness.",
    ],
    remaining: [
      "Run odai e2e --use-api-key --use-provider-command with real credentials/runtime available; add --model <name> if no provider model env is configured.",
      "Run odai doctor --all --use-api-key --use-provider-command --save against real API-key and subscription CLI/SDK runtime providers; add --model <name> if no provider model env is configured.",
    ],
    e2eRequirementIds: ["provider-api", "provider-runtime"],
  },
  {
    id: "P0-2",
    phase: "Phase 0",
    title: "Unified tool dispatcher spike",
    requirement: "Simulate Write/Edit/Bash intents and route every provider through odai gates.",
    status: "ready",
    evidence: [
      "cli/src/runtime/tool-dispatcher.mjs: central read/write/shell/network dispatcher.",
      "cli/tests/phase0/smoke.mjs: write, shell, network, evidence, policy, authorization, and stop gates are covered.",
      "plans/odai-cli-runtime-canary.md:C01-C12",
    ],
    remaining: [],
  },
  {
    id: "P0-3",
    phase: "Phase 0",
    title: "Subagent scheduler spike",
    requirement: "Main agent can invoke a different provider reviewer/challenger and keep main-flow review authority.",
    status: "ready",
    evidence: [
      "cli/src/orchestrator/scheduler.mjs: schedules subagents with profile capability matching and boundary dispatch.",
      "cli/tests/phase0/smoke.mjs: reviewer/challenger subagents run and subagent direct writes are denied.",
      "cli/src/orchestrator/result-merger.mjs: patch proposal adoption remains in the main flow.",
    ],
    remaining: [],
  },
  {
    id: "P0-4",
    phase: "Phase 0",
    title: "Skill loader spike",
    requirement: "Render prompt packs from skills/odai without copying long rules into CLI code.",
    status: "ready",
    evidence: [
      "cli/src/core/skill-pack.mjs: loads SKILL.md and support files from disk.",
      "cli/tests/phase0/smoke.mjs: mutating a temporary SKILL.md changes rendered prompt text and entrySha256.",
      "cli/src/index.mjs: run records include skill.entrySha256 and supportFileCount.",
    ],
    remaining: [],
  },
  {
    id: "P0-5",
    phase: "Phase 0",
    title: "Canary spike",
    requirement: "Prove subagents cannot write directly, announce completion, or bypass the main flow.",
    status: "ready",
    evidence: [
      "plans/odai-cli-runtime-canary.md:C01",
      "plans/odai-cli-runtime-canary.md:C10",
      "scripts/odai-canary-harness.mjs: canary runner integration.",
    ],
    remaining: [],
  },
  {
    id: "P1-1",
    phase: "Phase 1",
    title: "Single command entry",
    requirement: "odai \"<task>\" starts the default interactive CLI path.",
    status: "ready",
    evidence: [
      "cli/src/index.mjs: unknown commands are treated as initialTaskArgv for runCliSession.",
      "cli/tests/phase0/smoke.mjs: child process odai \"spawned initial task\" enters interactive session and writes an agent_loop run record.",
      "cli/tests/phase0/smoke.mjs: child process odai \"non tty initial task\" exits after the initial task when stdin is closed.",
    ],
    remaining: [],
  },
  {
    id: "P1-2",
    phase: "Phase 1",
    title: "Provider config and environment detection",
    requirement: "Detect provider config files, env vars, auth sources, availability, and blocked reasons.",
    status: "ready",
    evidence: [
      "cli/src/config/provider-config.mjs: built-in and workspace providers with configErrors.",
      "cli/tests/phase0/smoke.mjs: env/config detection, source metadata, invalid config handling, built-in provider override rejection, and explicit API/command gates.",
    ],
    remaining: [],
  },
  {
    id: "P1-3",
    phase: "Phase 1",
    title: "Main agent plus optional subagent",
    requirement: "Run one main agent and optional subagents.",
    status: "ready",
    evidence: [
      "cli/src/runtime/agent-loop.mjs: main agent tool-intent loop.",
      "cli/src/index.mjs: --subagent profile[:provider[:model]] handling and batch review integration.",
      "cli/tests/phase0/smoke.mjs: agent loop, subagent review, and fail-closed workspace agent config coverage.",
    ],
    remaining: [],
  },
  {
    id: "P1-4",
    phase: "Phase 1",
    title: "First hard gates",
    requirement: "Implement evidence, authorization, stop, and subagent boundary gates.",
    status: "ready",
    evidence: [
      "cli/src/runtime/gates/evidence.mjs",
      "cli/src/runtime/gates/authorization.mjs",
      "cli/src/runtime/gates/stop.mjs",
      "cli/src/runtime/gates/subagent-boundary.mjs",
      "cli/src/config/policy-config.mjs and cli/src/index.mjs: workspace policy config fails closed and run records preserve configErrors instead of enabling shell/network on invalid input.",
      "cli/src/core/governance-registry.mjs: C01-C18 rule-code coupling coverage.",
    ],
    remaining: [],
  },
  {
    id: "P1-5",
    phase: "Phase 1",
    title: "Evidence ledger and transcript storage",
    requirement: "Persist evidence and session transcript artifacts.",
    status: "ready",
    evidence: [
      "cli/src/runtime/evidence-ledger.mjs: records reads/writes/checkpoints/commands/subagents/denials/provider calls.",
      "cli/src/core/transcript-store.mjs: session jsonl, latest.json, and compact context artifacts.",
      "cli/tests/phase0/smoke.mjs: run records, transcript context, and compact context coverage.",
    ],
    remaining: [],
  },
  {
    id: "P1-6",
    phase: "Phase 1",
    title: "CLI as canary harness runner",
    requirement: "Use odai CLI as the canary runner and produce comparable records.",
    status: "ready",
    evidence: [
      "cli/src/index.mjs: canary-runner command.",
      "plans/odai-cli-runtime-canary.md:C01-C18",
      "cli/tests/phase0/smoke.mjs: canary runner last-message and explicit provider path coverage.",
    ],
    remaining: [],
  },
  {
    id: "P2-1",
    phase: "Phase 2",
    title: "Parallel multi-subagent orchestration",
    requirement: "Run multiple heterogeneous reviewer/challenger subagents in parallel and preserve review ordering.",
    status: "ready",
    evidence: [
      "cli/src/index.mjs: runSubagentReviewBatch uses Promise.allSettled.",
      "cli/src/index.mjs: subagent batch evidence records actual provider sets and heterogeneousProviders.",
      "cli/tests/phase0/smoke.mjs: parallel subagents, heterogeneous provider/model evidence, and partial subagent failure coverage.",
    ],
    remaining: [],
  },
  {
    id: "P2-2",
    phase: "Phase 2",
    title: "Virtual patch only and main-flow adoption",
    requirement: "Let subagents propose candidate patches while the main flow adopts through gates.",
    status: "ready",
    evidence: [
      "cli/src/orchestrator/agent-profiles.mjs: implementer_candidate uses virtual_patch_only.",
      "cli/src/orchestrator/result-merger.mjs: adoptPatchProposal.",
      "cli/tests/phase0/smoke.mjs: candidate patch adoption requires evidence and marks provider call adopted.",
    ],
    remaining: [],
  },
  {
    id: "P2-3",
    phase: "Phase 2",
    title: "Cost and capability routing",
    requirement: "Route by provider capability while keeping unknown cost explicit and ambiguity fail-closed.",
    status: "ready",
    evidence: [
      "cli/src/orchestrator/provider-registry.mjs: capability lookup.",
      "cli/src/index.mjs: main provider auto routing applies model overrides before availability filtering and keeps ambiguity fail-closed.",
      "cli/src/orchestrator/scheduler.mjs: subagent provider auto routing applies model overrides before availability filtering for explicit auto and omitted provider specs.",
      "cli/src/runtime/usage-ledger.mjs: cost remains unknown unless provider evidence exists.",
    ],
    remaining: [],
  },
  {
    id: "P2-4",
    phase: "Phase 2",
    title: "Session resume and continue",
    requirement: "Resume/continue runs and carry safe context across CLI sessions without restoring high-risk confirmations.",
    status: "ready",
    evidence: [
      "cli/src/core/transcript-store.mjs: resume and compact context generation.",
      "cli/src/index.mjs: resume and continue commands.",
      "cli/src/runtime/provider-session.mjs: same-provider resumeProviderSession hints without cross-provider leakage.",
      "cli/tests/phase0/smoke.mjs: interactive context, resume, continue, and provider session hint coverage.",
    ],
    remaining: [],
  },
  {
    id: "P2-5",
    phase: "Phase 2",
    title: "Devcontainer or stronger sandbox adapter",
    requirement: "Provide a stronger sandbox adapter path for shell execution.",
    status: "partial",
    evidence: [
      "cli/src/runtime/sandbox-adapter.mjs: macOS sandbox-exec, Docker, and devcontainer command planning.",
      "cli/src/config/policy-config.mjs and cli/src/core/sandbox-readiness.mjs: unsupported sandbox policy falls back to default deny and readiness reports preserve configErrors.",
      "cli/src/core/sandbox-readiness.mjs: fail-closed preflight for configured and candidate strong sandboxes.",
      "cli/src/core/sandbox-readiness.mjs: runSandboxSmoke executes a success probe and host escape probe only after explicit --allow-shell, project policy, allowlist, and strong sandbox readiness.",
      "cli/tests/phase0/smoke.mjs: fake ready/blocked sandbox coverage.",
    ],
    remaining: [
      "Configure a real strong sandbox and run odai sandbox until configuredStrong is true.",
      "Run odai doctor --sandbox --smoke --allow-shell --save under the configured strong sandbox.",
    ],
    e2eRequirementIds: ["strong-sandbox"],
  },
];

export function describeMilestones({ e2eReadiness, externalEvidence } = {}) {
  const items = MILESTONE_ITEMS.map((item) => enrichMilestoneItem({ item, e2eReadiness, externalEvidence }));
  const summary = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      acc.byPhase[item.phase] ||= { total: 0, ready: 0, partial: 0, "needs-external-evidence": 0 };
      acc.byPhase[item.phase].total += 1;
      acc.byPhase[item.phase][item.status] = (acc.byPhase[item.phase][item.status] || 0) + 1;
      return acc;
    },
    {
      total: 0,
      ready: 0,
      partial: 0,
      "needs-external-evidence": 0,
      byPhase: {},
    },
  );
  return {
    status: summary.ready === summary.total ? "ready" : "partial",
    kind: "plan-milestones",
    plan: "plans/odai-cli-plan.md",
    summary,
    items,
    externalReadiness: summarizeE2EReadiness(e2eReadiness),
    externalEvidence: summarizeExternalEvidence(externalEvidence),
    note: summary.ready === summary.total
      ? "This audit maps the plan section 10 executable milestones to current runtime evidence, including saved external provider and strong sandbox smoke evidence from .odai/runs."
      : "This audit maps the plan section 10 executable milestones to current runtime evidence. External provider and strong sandbox E2E still require saved real credentials/runtime/sandbox evidence.",
  };
}

function enrichMilestoneItem({ item, e2eReadiness, externalEvidence }) {
  const next = {
    ...item,
    evidence: [...item.evidence],
    remaining: [...item.remaining],
  };
  if (Array.isArray(item.e2eRequirementIds) && item.e2eRequirementIds.length > 0) {
    next.externalReadiness = summarizeE2EReadiness(e2eReadiness, item.e2eRequirementIds);
  }
  if (item.id === "P0-1") {
    const savedEvidence = summarizeExternalRequirement(externalEvidence, "provider-api-and-runtime");
    if (savedEvidence) {
      next.externalEvidence = savedEvidence;
      const externalRemaining = externalRequirementRemaining(externalEvidence, "provider-api-and-runtime");
      if (externalRemaining.length > 0) {
        next.remaining = [
          ...(!e2eRequirementsReady(e2eReadiness, ["provider-api", "provider-runtime"])
            ? [
                "Run odai e2e --use-api-key --use-provider-command with real credentials/runtime available; add --model <name> if no provider model env is configured.",
              ]
            : []),
          ...externalRemaining,
        ];
      }
    }
    if (savedEvidence?.status === "ready") {
      next.status = "ready";
      next.evidence.push(
        "cli/src/core/external-evidence.mjs: saved doctor probes include real API and subscription CLI/SDK runtime provider evidence.",
      );
      next.remaining = [];
    }
  }
  if (item.id === "P2-5") {
    const savedEvidence = summarizeExternalRequirement(externalEvidence, "strong-sandbox-smoke");
    if (savedEvidence) {
      next.externalEvidence = savedEvidence;
    }
    if (savedEvidence?.status === "ready") {
      next.status = "ready";
      next.evidence.push(
        "cli/src/core/external-evidence.mjs: saved sandbox smoke evidence proves a non-none strong sandbox path and host escape probe executed through odai dispatcher.",
      );
      next.remaining = [];
    }
  }
  return next;
}

function externalRequirementRemaining(externalEvidence, id) {
  if (!externalEvidence || externalEvidence.kind !== "external-evidence") {
    return [];
  }
  const requirement = (externalEvidence.requirements || []).find((entry) => entry.id === id);
  return Array.isArray(requirement?.remaining) ? requirement.remaining : [];
}

function e2eRequirementsReady(e2eReadiness, ids = []) {
  if (!e2eReadiness || e2eReadiness.kind !== "e2e-readiness") {
    return false;
  }
  return ids.every((id) =>
    (e2eReadiness.requirements || []).some((requirement) => requirement.id === id && requirement.status === "ready"),
  );
}

function summarizeE2EReadiness(e2eReadiness, requirementIds) {
  if (!e2eReadiness || e2eReadiness.kind !== "e2e-readiness") {
    return undefined;
  }
  const allowed = Array.isArray(requirementIds) && requirementIds.length > 0
    ? new Set(requirementIds)
    : undefined;
  return {
    kind: e2eReadiness.kind,
    status: e2eReadiness.status,
    summary: e2eReadiness.summary,
    requirements: (e2eReadiness.requirements || [])
      .filter((requirement) => !allowed || allowed.has(requirement.id))
      .map((requirement) => ({
        id: requirement.id,
        status: requirement.status,
        evidenceCount: Array.isArray(requirement.evidence) ? requirement.evidence.length : 0,
        blockedCount: Array.isArray(requirement.blocked) ? requirement.blocked.length : 0,
      })),
    runnableCommands: e2eReadiness.runnableCommands || [],
  };
}

function summarizeExternalEvidence(externalEvidence) {
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
      evidenceCount: countRequirementEvidence(requirement),
      remainingCount: Array.isArray(requirement.remaining) ? requirement.remaining.length : 0,
    })),
  };
}

function summarizeExternalRequirement(externalEvidence, id) {
  if (!externalEvidence || externalEvidence.kind !== "external-evidence") {
    return undefined;
  }
  const requirement = (externalEvidence.requirements || []).find((entry) => entry.id === id);
  if (!requirement) {
    return undefined;
  }
  return {
    id: requirement.id,
    status: requirement.status,
    evidenceCount: countRequirementEvidence(requirement),
    remainingCount: Array.isArray(requirement.remaining) ? requirement.remaining.length : 0,
  };
}

function countRequirementEvidence(requirement) {
  if (Array.isArray(requirement.evidence)) {
    return requirement.evidence.length;
  }
  if (requirement.evidence && typeof requirement.evidence === "object") {
    return Object.values(requirement.evidence).reduce(
      (total, value) => total + (Array.isArray(value) ? value.length : 0),
      0,
    );
  }
  return 0;
}
