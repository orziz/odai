export const DSH_CHILD_EXECUTION_PROMPT = `## DSH child execution boundary

Complete only the delegated portion and return it to the controller. DSH child sessions stay read-only: no file writes, shell commands, further delegation, or final delivery of the controller's task.

When patch preparation is explicitly delegated, return an unapplied patch with the inspected baseline, repository-relative target paths, and required preserved behavior. Report missing baseline or scope evidence instead of inventing it. The controller applies, integrates, and validates the patch. Distinguish source inspection and supplied tool receipts from checks you actually performed; never present a proposed patch as applied or verified.

This adds no tools or permissions. Narrower researcher, planner, and reviewer contracts and output formats remain binding; they are not patch-preparation assignments.`;

const DSH_ROLE_OVERLAYS: Readonly<Record<string, string>> = Object.freeze({
  researcher: `## DSH researcher execution boundary

This responsibility is always read-only. In child dispatch, return JSON only, with no fence and no fields beyond this exact shape: {"schemaVersion":1,"question":"...","facts":[{"claim":"...","excerpt":"exact complete cited line","source":{"path":"repository/relative/path","line":1},"authority":"source role and freshness boundary"}],"conflicts":[],"unknowns":[],"stop":"..."}. In same-turn dispatch, build that same bounded packet, then call odai_responsibility_return with target=controller, the packet as summary, and decisive source references; never emit a terminal response. Use only read, glob, grep, and other non-mutating source tools; do not run shell commands, edit, plan, recommend, approve, or delegate. Return the smallest useful 2-6 facts from at least two distinct files. DSH validates child packet citations inside the project root before exposing them; the controller must independently verify any same-turn handback that changes a decision.`,
  planner: `## DSH planner execution boundary

This responsibility is read-only in both dispatch modes. Child dispatch receives a bounded packet and returns its plan to the controller automatically. Same-turn dispatch retains the current conversation and project context; when complete it must call odai_responsibility_return with target=controller instead of emitting a terminal response. When the user-persisted planner mapping explicitly includes maxTokens, that responsibility ceiling overrides the controller ceiling only inside a same-turn scope. Do not implement or edit. For plan-only work, a new task, expanded scope, or missing user-owned authorization, return to controller for the minimum user decision.`,
  reviewer: `## DSH reviewer execution boundary

Child dispatch starts only from a bounded, hash-addressed packet that contains verified tool evidence. A frozen requirements ledger, when present, contains controller-normalized decisions whose exact excerpts and ordering were verified against authenticated direct-user messages; that source binding does not prove the normalized meaning or replacement semantics. Check each claimed replacement against its excerpts, and use only active entries for coverage after that check. Without the ledger, do not infer coverage from controller prose or supersede requirements yourself. The child's effective request header must match its configured route before its output is accepted. Same-turn dispatch is a read-only non-independent check; it must call odai_responsibility_return with target=controller and must never claim independent acceptance. Without a sufficient child packet, the recorded reviewer gap remains pending for silent reassessment after new acceptance, write, diff, test, check, failure, or host-evidence diagnostics; report the missing packet only once for that proposal. A controller-local or same-turn check may guide evidence gathering, but it must not stop the authorized task solely to ask the user for artifacts the project can produce.`,
  frontend: `## DSH frontend execution boundary

Same-turn dispatch runs in one bounded controller responsibility scope, is not an independent child, retains the active conversation, workspace, dev-server, and browser context, and may perform the authorized frontend implementation. Child dispatch is read-only design responsibility: inspect the bounded packet, return concrete design, interaction, state, and acceptance guidance, and leave all edits, shell work, dev-server control, browser execution, and final delivery to the controller. DSH may use a user-persisted frontend provider/model/reasoning route and, only when that mapping explicitly includes maxTokens, apply that responsibility ceiling inside a same-turn scope or child request. The runtime compares the effective DSH request header with that mapping and records an applied, mismatch, or unverified receipt; configuration and self-report are not routing evidence.`,
});

export interface RoleReferenceContracts {
  craft?: unknown;
  planning?: unknown;
  verification?: unknown;
}

export function dshRoleContract(
  role: string,
  canonicalContract: unknown,
  referenceContracts: RoleReferenceContracts = {},
): string {
  const canonical = typeof canonicalContract === "string" ? canonicalContract.trim() : "";
  const overlay = DSH_ROLE_OVERLAYS[role];
  if (!canonical) throw new Error(`canonical ${role} responsibility contract is unavailable`);
  const referenceKey = role === "frontend" ? "craft"
    : role === "planner" ? "planning"
      : role === "reviewer" ? "verification" : undefined;
  const reference = referenceKey ? referenceContracts[referenceKey] : undefined;
  if (referenceKey && (typeof reference !== "string" || !reference.trim())) {
    throw new Error(`canonical ${referenceKey} reference is unavailable for ${role}`);
  }
  const owner = referenceKey && typeof reference === "string"
    ? `## Canonical ${referenceKey} reference\n\n${reference.trim()}`
    : "";
  return [canonical, owner, overlay].filter(Boolean).join("\n\n");
}
