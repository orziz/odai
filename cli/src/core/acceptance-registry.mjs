const ACCEPTANCE_ITEMS = [
  {
    id: "A01",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "Multiple credentials are present at startup.",
    must: "Report provider/auth source and fail closed on cost/auth ambiguity.",
    mustNot: "Silently choose an API key or subscription path.",
    status: "ready",
    evidence: [
      "cli/tests/phase0/smoke.mjs: API key providers require --use-api-key.",
      "cli/tests/phase0/smoke.mjs: provider auto routing is ambiguous when multiple real providers are available.",
      "cli/src/config/provider-config.mjs: provider descriptions include auth, source metadata, availability, blockedReason, and capabilities.",
    ],
    remaining: [],
  },
  {
    id: "A02",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "An API-key provider and a subscription CLI/SDK runtime provider are both available.",
    must: "Provider registry can list capability, unknown cost, and availability state.",
    mustNot: "Infer provider cost or capability from memory.",
    status: "needs-external-evidence",
    evidence: [
      "cli/tests/phase0/smoke.mjs: fake Claude SDK, Claude CLI, OpenAI, Anthropic, Gemini, Ollama, and command-json adapters expose structured provider metadata.",
      "cli/src/runtime/usage-ledger.mjs: cost remains unknown unless provider evidence exists.",
      "cli/tests/phase0/smoke.mjs: e2e/doctor --model covers model-required API provider readiness and probe resume without bypassing --use-api-key.",
    ],
    remaining: [
      "Run odai doctor --all --use-api-key --use-provider-command --save with an actually available API provider and subscription CLI/SDK runtime provider.",
    ],
  },
  {
    id: "A03",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "Any provider requests Write/Edit.",
    must: "The request passes through the odai evidence gate first.",
    mustNot: "Provider writes directly to disk.",
    status: "ready",
    evidence: [
      "plans/odai-cli-runtime-canary.md:C01",
      "plans/odai-cli-runtime-canary.md:C03",
      "cli/tests/phase0/smoke.mjs: patch adoption without prior read is denied by evidence gate.",
    ],
    remaining: [],
  },
  {
    id: "A04",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "A subagent returns a patch.",
    must: "Treat it as a candidate and let the main flow verify/adopt it.",
    mustNot: "Let the subagent write files directly or declare completion.",
    status: "ready",
    evidence: [
      "cli/src/orchestrator/result-merger.mjs: patch proposal adoption is routed through the dispatcher.",
      "cli/tests/phase0/smoke.mjs: adoptPatchProposal requires evidence and marks adopted provider calls.",
      "plans/odai-cli-runtime-canary.md:C01",
    ],
    remaining: [],
  },
  {
    id: "A05",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "A subagent tries to ask the user or expand scope.",
    must: "Boundary gate intercepts and returns control to the main flow.",
    mustNot: "Subagent owns the user channel or keeps guessing.",
    status: "ready",
    evidence: [
      "plans/odai-cli-runtime-canary.md:C10",
      "cli/src/runtime/gates/subagent-boundary.mjs",
      "cli/tests/phase0/smoke.mjs: ask-user and complete intents are denied for subagents.",
    ],
    remaining: [],
  },
  {
    id: "A06",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "The same failing action exceeds the retry threshold.",
    must: "Stop gate asks for a different direction or stabilized acceptance.",
    mustNot: "Retry indefinitely.",
    status: "ready",
    evidence: [
      "plans/odai-cli-runtime-canary.md:C07",
      "cli/src/runtime/gates/stop.mjs",
      "cli/src/core/session-state.mjs",
    ],
    remaining: [],
  },
  {
    id: "A07",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "skills/odai text changes.",
    must: "A new session prompt pack uses the new text and avoids a second rule copy in CLI code.",
    mustNot: "Keep long odai rules copied inside CLI code.",
    status: "ready",
    evidence: [
      "cli/src/core/skill-pack.mjs: loadSkillPack reads SKILL.md from disk and records entrySha256.",
      "cli/tests/phase0/smoke.mjs: temporary skill root mutation changes rendered prompt text and digest.",
      "cli/src/index.mjs: run records include skill.entrySha256 and supportFileCount.",
    ],
    remaining: [],
  },
  {
    id: "A08",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "Canary smoke uses odai CLI as the runner.",
    must: "Complete all cases and produce transcript/provider/evidence records.",
    mustNot: "Produce results that cannot be compared with the existing harness.",
    status: "ready",
    evidence: [
      "plans/odai-cli-runtime-canary.md:C01-C18",
      "scripts/odai-canary-harness.mjs: runner-cmd integration.",
      "cli/tests/phase0/smoke.mjs: runCanaryRunner writes last-message output and run records.",
    ],
    remaining: [],
  },
  {
    id: "A09",
    planRef: "plans/odai-cli-plan.md#11",
    scenario: "Interactive model switching and heterogeneous subagent orchestration.",
    must: "Support /model and --model for the session main model/provider and record heterogeneous multi-subagent provider/model evidence.",
    mustNot: "Persist high-risk confirmations or collapse distinct subagent providers into one unverified path.",
    status: "ready",
    evidence: [
      "cli/src/core/interactive-session.mjs: /model <model|provider:model|auto> updates the session default model separately from /provider and emits --model on subsequent tasks.",
      "cli/src/index.mjs: --model applies before main provider auto selection, doctor probes, and E2E readiness; --subagent supports profile:provider:model specs.",
      "cli/src/orchestrator/scheduler.mjs: subagent auto routing applies model overrides before availability filtering.",
      "cli/tests/phase0/smoke.mjs: /model affects subsequent tasks, --model reaches provider usage, auto routing honors model-required providers, and reviewer/challenger subagents can run with distinct provider/model choices.",
    ],
    remaining: [],
  },
];

export function describeAcceptance({ e2eReadiness, externalEvidence } = {}) {
  const items = ACCEPTANCE_ITEMS.map((item) => enrichAcceptanceItem({ item, e2eReadiness, externalEvidence }));
  const summary = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { total: 0, ready: 0, "needs-external-evidence": 0 },
  );
  return {
    status: summary["needs-external-evidence"] > 0 ? "partial" : "ready",
    kind: "plan-acceptance",
    plan: "plans/odai-cli-plan.md",
    summary,
    items,
    externalReadiness: summarizeE2EReadiness(e2eReadiness),
    externalEvidence: summarizeExternalEvidence(externalEvidence),
    note: summary["needs-external-evidence"] > 0
      ? "This audit maps the plan section 11 acceptance matrix to current executable evidence. Real provider E2E requires saved external evidence in .odai/runs."
      : "This audit maps the plan section 11 acceptance matrix to current executable evidence, including saved external provider evidence from .odai/runs.",
  };
}

function enrichAcceptanceItem({ item, e2eReadiness, externalEvidence }) {
  const next = { ...item, evidence: [...item.evidence], remaining: [...item.remaining] };
  if (next.id !== "A02") {
    return next;
  }
  next.evidence.push(
    "cli/src/core/e2e-readiness.mjs: provider-api and provider-runtime requirements make the real-provider prerequisite explicit without requiring Claude specifically.",
  );
  next.remaining = [
    "Run odai e2e --use-api-key --use-provider-command to confirm real API provider and subscription runtime prerequisites are ready; add --model <name> if no provider model env is configured.",
    "Then run odai doctor --all --use-api-key --use-provider-command --save with an actually available API provider and subscription CLI/SDK runtime provider; add --model <name> if no provider model env is configured.",
  ];
  const summary = summarizeE2EReadiness(e2eReadiness);
  if (summary) {
    next.externalReadiness = summary;
  }
  const savedEvidence = summarizeExternalRequirement(externalEvidence, "provider-api-and-runtime");
  if (savedEvidence) {
    next.externalEvidence = savedEvidence;
    const externalRemaining = externalRequirementRemaining(externalEvidence, "provider-api-and-runtime");
    if (externalRemaining.length > 0) {
      next.remaining = [
        ...(!e2eRequirementsReady(e2eReadiness, ["provider-api", "provider-runtime"])
          ? [
              "Run odai e2e --use-api-key --use-provider-command to confirm real API provider and subscription runtime prerequisites are ready; add --model <name> if no provider model env is configured.",
            ]
          : []),
        ...externalRemaining,
      ];
    }
  }
  if (savedEvidence?.status === "ready") {
    next.status = "ready";
    next.evidence.push(
      "cli/src/core/external-evidence.mjs: saved doctor provider probes include both a real API provider and a subscription CLI/SDK runtime provider.",
    );
    next.remaining = [];
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

function summarizeE2EReadiness(e2eReadiness) {
  if (!e2eReadiness || e2eReadiness.kind !== "e2e-readiness") {
    return undefined;
  }
  return {
    kind: e2eReadiness.kind,
    status: e2eReadiness.status,
    summary: e2eReadiness.summary,
    requirements: (e2eReadiness.requirements || [])
      .filter((requirement) =>
        ["provider-api", "provider-runtime", "provider-subscription-cli", "strong-sandbox"].includes(
          requirement.id,
        ),
      )
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
