const RUNTIME_RULE_COUPLINGS = [
  {
    id: "subagent-write-boundary",
    invariant: "Subagents cannot directly write project files.",
    sourceRefs: ["skills/odai/SKILL.md:模型即谋士", "skills/odai/references/dao/coordination.md:交接与采纳"],
    implementationRefs: ["cli/src/runtime/gates/subagent-boundary.mjs", "cli/src/runtime/tool-dispatcher.mjs"],
    canaryCases: ["C01"],
  },
  {
    id: "network-default-deny",
    invariant: "Model network tool intents are denied unless runtime policy and task authorization allow them.",
    sourceRefs: ["skills/odai/SKILL.md:底线与收口", "skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/gates/policy.mjs", "cli/src/runtime/gates/authorization.mjs"],
    canaryCases: ["C02"],
  },
  {
    id: "new-file-evidence-checkpoint",
    invariant: "New file writes must pass evidence gates and create rollback checkpoints.",
    sourceRefs: ["skills/odai/references/capabilities/implement-code.md:实施与验证", "skills/odai/references/dao/continuity.md:主状态"],
    implementationRefs: ["cli/src/runtime/gates/evidence.mjs", "cli/src/runtime/tool-dispatcher.mjs"],
    canaryCases: ["C03"],
  },
  {
    id: "credential-read-authorization",
    invariant: "Credential-like file reads require explicit authorization before content is exposed.",
    sourceRefs: ["skills/odai/SKILL.md:底线与收口", "skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/path-classifier.mjs", "cli/src/runtime/gates/authorization.mjs"],
    canaryCases: ["C04"],
  },
  {
    id: "credential-write-deny",
    invariant: "Model-originated writes to credential-like files are denied and do not create secret checkpoints.",
    sourceRefs: ["skills/odai/SKILL.md:底线与收口", "skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/path-classifier.mjs", "cli/src/runtime/gates/policy.mjs"],
    canaryCases: ["C05"],
  },
  {
    id: "tool-intent-redaction",
    invariant: "Sensitive values in model tool intents are redacted before logs, evidence, or run records.",
    sourceRefs: ["skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/redaction.mjs", "cli/src/runtime/evidence-ledger.mjs"],
    canaryCases: ["C06"],
  },
  {
    id: "repeated-failure-stop",
    invariant: "Repeated failure on the same action is stopped instead of retried indefinitely.",
    sourceRefs: ["skills/odai/SKILL.md:自适应主流程", "skills/odai/references/capabilities/diagnose.md:最短诊断链"],
    implementationRefs: ["cli/src/runtime/gates/stop.mjs", "cli/src/core/session-state.mjs"],
    canaryCases: ["C07"],
  },
  {
    id: "perception-write-stop",
    invariant: "Perception-sensitive writes require frozen acceptance evidence.",
    sourceRefs: ["skills/odai/SKILL.md:自适应主流程", "skills/odai/references/dao/authority.md:模糊与感知任务"],
    implementationRefs: ["cli/src/runtime/gates/perception.mjs"],
    canaryCases: ["C08"],
  },
  {
    id: "shell-record-only-default",
    invariant: "Shell intents are recorded but not executed unless explicit runtime and policy gates allow them.",
    sourceRefs: ["skills/odai/SKILL.md:底线与收口", "skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/tool-dispatcher.mjs", "cli/src/runtime/gates/policy.mjs"],
    canaryCases: ["C09"],
  },
  {
    id: "subagent-user-channel-boundary",
    invariant: "Subagents cannot ask the user directly or declare final completion.",
    sourceRefs: ["skills/odai/SKILL.md:模型即谋士", "skills/odai/references/dao/coordination.md:交接与采纳"],
    implementationRefs: ["cli/src/runtime/gates/subagent-boundary.mjs"],
    canaryCases: ["C10"],
  },
  {
    id: "tool-intent-batch-limit",
    invariant: "A model turn with too many tool intents is denied as a whole batch.",
    sourceRefs: ["skills/odai/SKILL.md:底线与收口", "skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/agent-loop.mjs"],
    canaryCases: ["C11"],
  },
  {
    id: "production-risk-authorization",
    invariant: "Production-risk actions require explicit authorization before dispatch.",
    sourceRefs: ["skills/odai/SKILL.md:底线与收口", "skills/odai/references/dao/authority.md:动作边界"],
    implementationRefs: ["cli/src/runtime/gates/authorization.mjs"],
    canaryCases: ["C12"],
  },
  {
    id: "model-output-redaction",
    invariant: "Sensitive values in ordinary model output are redacted before evidence and run records.",
    sourceRefs: ["skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/redaction.mjs", "cli/src/runtime/evidence-ledger.mjs"],
    canaryCases: ["C13"],
  },
  {
    id: "provider-error-redaction",
    invariant: "Sensitive values and terminal control sequences in provider errors are sanitized while preserving failure evidence.",
    sourceRefs: ["skills/odai/SKILL.md:底线与收口", "skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/redaction.mjs", "cli/src/index.mjs"],
    canaryCases: ["C14"],
  },
  {
    id: "provider-session-redaction",
    invariant: "Provider session hint fields are whitelisted and value-redacted before persistence.",
    sourceRefs: ["skills/odai/references/capabilities/implement-code.md:命中边界"],
    implementationRefs: ["cli/src/runtime/provider-session.mjs", "cli/src/runtime/redaction.mjs"],
    canaryCases: ["C15"],
  },
  {
    id: "provider-context-authorization-redaction",
    invariant: "Provider input context strips authorization scopes, non-restorable confirmations, and local runtime artifact paths before model calls.",
    sourceRefs: [
      "skills/odai/SKILL.md:底线与收口",
      "skills/odai/references/capabilities/implement-code.md:命中边界",
    ],
    implementationRefs: ["cli/src/runtime/provider-session.mjs", "cli/src/core/interactive-session.mjs"],
    canaryCases: ["C16"],
  },
  {
    id: "task-persistence-redaction",
    invariant: "Sensitive values in task text are redacted before run records, resume argv, transcript summaries, or continue summaries are persisted or replayed.",
    sourceRefs: [
      "skills/odai/SKILL.md:底线与收口",
      "skills/odai/references/capabilities/implement-code.md:命中边界",
    ],
    implementationRefs: ["cli/src/index.mjs", "cli/src/core/interactive-session.mjs", "cli/src/core/transcript-store.mjs"],
    canaryCases: ["C17"],
  },
  {
    id: "tool-intent-payload-limit",
    invariant: "Oversized model tool intent payloads are denied before dispatch to protect runtime memory, logs, and filesystem writes.",
    sourceRefs: [
      "skills/odai/SKILL.md:底线与收口",
      "skills/odai/references/capabilities/implement-code.md:命中边界",
    ],
    implementationRefs: ["cli/src/runtime/model-tool-intents.mjs"],
    canaryCases: ["C18"],
  },
];

export function describeRuntimeGovernance() {
  const entries = RUNTIME_RULE_COUPLINGS.map((entry) => ({
    ...entry,
    status: entry.canaryCases.length > 0 ? "covered" : "missing-canary",
  }));
  const duplicateIds = duplicateValues(entries.map((entry) => entry.id));
  const missingCanary = entries.filter((entry) => entry.canaryCases.length === 0).map((entry) => entry.id);
  const status = duplicateIds.length === 0 && missingCanary.length === 0 ? "ready" : "failed";
  return {
    status,
    kind: "runtime-governance",
    rulesSource: "skills/odai",
    canaryPlan: "plans/odai-cli-runtime-canary.md",
    summary: {
      total: entries.length,
      covered: entries.filter((entry) => entry.status === "covered").length,
      missingCanary: missingCanary.length,
      duplicateIds: duplicateIds.length,
    },
    checks: {
      duplicateIds,
      missingCanary,
    },
    entries,
    note: "This registry covers odai skill semantics that are currently enforced mechanically by the CLI runtime. External provider E2E and strong sandbox E2E remain separate acceptance items.",
  };
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates];
}
