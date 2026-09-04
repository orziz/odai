import { createHash } from "node:crypto";

import { CONFIGURABLE_ROLES } from "./routing-config.mjs";
import type { DshAgent, RuntimeTool, ToolExecution } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export const RESPONSIBILITY_GAP_PROMPT = [
  "## Odai responsibility gaps",
  "Users own goals, constraints, materials, and acceptance; they never request internal roles.",
  "Keep direct when the controller can close. Call odai_responsibility_gap only for an evidence-grounded independent capability or user-decision gap that can change the result; keywords, complexity, risk, model config, or price do not qualify. Runtime chooses dispatch.",
  "Independently deployed contracts, auth/state-machine changes, rollout compatibility, and rollback boundaries are planner gaps when separate planning can change implementation or acceptance.",
  "evidenceRefs deduplicate and audit the proposal; they never replace native acceptance, write, diff, or test evidence for review.",
  "For coverage-sensitive planner/reviewer gaps, include exact user excerpts; replace only explicit conflicts and keep other requirements active. Runtime verifies source/order, never prose conflicts.",
  "Runtime binds the proposal to the latest authenticated direct-user task; later text must be a pure continuation, while an explicit revision supersedes it.",
  "Use responsibility=user only for a missing user-owned choice, priority, or unacceptable outcome, then ask the accepted concise question. Never ask repository facts or resubmit unchanged state.",
].join("\n");

const RESPONSIBILITIES = Object.freeze([...CONFIGURABLE_ROLES, "user"]);
const REQUIREMENT_STATUSES = Object.freeze(["active", "superseded"] as const);
const REQUIREMENT_FIELDS = Object.freeze(["id", "statement", "status", "sourceExcerpt", "supersededBy"] as const);
const BOUND_REQUIREMENT_FIELDS = new Set([...REQUIREMENT_FIELDS, "sourceMessageId", "sourceOrder"]);
const MAX_REQUIREMENT_CHARS = 4_000;
export type Responsibility = (typeof RESPONSIBILITIES)[number];
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface RequirementDecision {
  readonly id: string;
  readonly statement: string;
  readonly status: RequirementStatus;
  readonly sourceExcerpt: string;
  readonly supersededBy?: string;
  readonly sourceMessageId?: string;
  readonly sourceOrder?: number;
}

export interface RequirementSourceCandidate {
  readonly messageId: string;
  readonly text: string;
  readonly order: number;
}

export function isBoundRequirementLedger(value: unknown): value is readonly RequirementDecision[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return false;
  const requirements = value.filter(isUnknownRecord);
  if (requirements.length !== value.length
    || new Set(requirements.map((requirement) => requirement.id)).size !== requirements.length
    || JSON.stringify(requirements).length > MAX_REQUIREMENT_CHARS) return false;
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const orderByMessageId = new Map<string, number>();
  const messageIdByOrder = new Map<number, string>();
  for (const requirement of requirements) {
    if (Object.keys(requirement).some((key) => !BOUND_REQUIREMENT_FIELDS.has(key))
      || typeof requirement.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(requirement.id) || requirement.id.length > 64
      || typeof requirement.statement !== "string" || requirement.statement.trim() === "" || requirement.statement.length > 1_200
      || !["active", "superseded"].includes(String(requirement.status))
      || typeof requirement.sourceExcerpt !== "string" || requirement.sourceExcerpt.trim() === "" || requirement.sourceExcerpt.length > 1_200
      || typeof requirement.sourceMessageId !== "string" || requirement.sourceMessageId.trim() === ""
      || !Number.isSafeInteger(requirement.sourceOrder) || Number(requirement.sourceOrder) < 0) return false;
    const sourceMessageId = String(requirement.sourceMessageId);
    const sourceOrder = Number(requirement.sourceOrder);
    const priorOrder = orderByMessageId.get(sourceMessageId);
    const priorMessageId = messageIdByOrder.get(sourceOrder);
    if ((priorOrder !== undefined && priorOrder !== sourceOrder)
      || (priorMessageId !== undefined && priorMessageId !== sourceMessageId)) return false;
    orderByMessageId.set(sourceMessageId, sourceOrder);
    messageIdByOrder.set(sourceOrder, sourceMessageId);
    if (requirement.status === "active" && requirement.supersededBy !== undefined) return false;
    if (requirement.status === "superseded") {
      const replacement = byId.get(requirement.supersededBy);
      if (typeof requirement.supersededBy !== "string"
        || requirement.supersededBy.trim() === "" || requirement.supersededBy.length > 64
        || requirement.supersededBy === requirement.id
        || !replacement
        || Number(requirement.sourceOrder) >= Number(replacement.sourceOrder)) return false;
    }
  }
  return true;
}

export interface ResponsibilityGapProposal {
  readonly responsibility: Responsibility;
  readonly gap: string;
  readonly evidenceRefs: readonly string[];
  readonly expectedChange: string;
  readonly requirements?: readonly RequirementDecision[];
  readonly question?: string;
  readonly taskMessageId?: string;
  readonly stateDigest: string;
}

export interface ResponsibilityGapResult {
  recorded: true;
  responsibility: Responsibility;
  stateDigest: string;
  next: string;
}

function nonEmpty(value: unknown, field: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${field} must be at most ${maxLength} characters`);
  return normalized;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${field} has unknown fields: ${unknown.join(", ")}`);
}

function requirementDecisions(value: unknown): readonly RequirementDecision[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw new TypeError("requirements must contain 1 to 12 decisions");
  }
  const requirements = value.map((raw, index) => {
    if (!isUnknownRecord(raw)) throw new TypeError(`requirements[${index}] must be an object`);
    exactFields(raw, REQUIREMENT_FIELDS, `requirements[${index}]`);
    const id = nonEmpty(raw.id, `requirements[${index}].id`, 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(id)) {
      throw new TypeError(`requirements[${index}].id must start with a letter and contain only letters, digits, _ or -`);
    }
    const statement = nonEmpty(raw.statement, `requirements[${index}].statement`, 1_200);
    const sourceExcerpt = nonEmpty(raw.sourceExcerpt, `requirements[${index}].sourceExcerpt`, 1_200);
    if (typeof raw.status !== "string" || !(REQUIREMENT_STATUSES as readonly string[]).includes(raw.status)) {
      throw new TypeError(`requirements[${index}].status must be active or superseded`);
    }
    const status = raw.status as RequirementStatus;
    const supersededBy = raw.supersededBy === undefined
      ? undefined
      : nonEmpty(raw.supersededBy, `requirements[${index}].supersededBy`, 64);
    if (status === "active" && supersededBy !== undefined) {
      throw new TypeError(`requirements[${index}] active decisions cannot set supersededBy`);
    }
    if (status === "superseded" && supersededBy === undefined) {
      throw new TypeError(`requirements[${index}] superseded decisions require supersededBy`);
    }
    return Object.freeze({ id, statement, status, sourceExcerpt, ...(supersededBy ? { supersededBy } : {}) });
  });
  if (JSON.stringify(requirements).length > MAX_REQUIREMENT_CHARS) {
    throw new TypeError("requirements must contain at most 4000 serialized characters");
  }
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  if (byId.size !== requirements.length) throw new TypeError("requirements ids must be unique");
  for (const requirement of requirements) {
    if (requirement.status !== "superseded") continue;
    const seen = new Set<string>();
    let current = requirement;
    while (current.status === "superseded") {
      if (seen.has(current.id)) {
        throw new TypeError(`requirement ${requirement.id}.supersededBy must form an acyclic chain ending at an active requirement`);
      }
      seen.add(current.id);
      const replacement = byId.get(current.supersededBy ?? "");
      if (!replacement || replacement.id === current.id) {
        throw new TypeError(`requirement ${requirement.id}.supersededBy must form an acyclic chain ending at an active requirement`);
      }
      current = replacement;
    }
  }
  return Object.freeze(requirements);
}

function stateDigest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isResponsibility(value: unknown): value is Responsibility {
  return typeof value === "string" && (RESPONSIBILITIES as readonly string[]).includes(value);
}

export function resolveResponsibilityGap(value: unknown): Readonly<ResponsibilityGapProposal> {
  if (!isUnknownRecord(value)) throw new TypeError("responsibility gap must be an object");
  const unknownFields = Object.keys(value).filter((field) => !["responsibility", "gap", "evidenceRefs", "expectedChange", "requirements", "question"].includes(field));
  if (unknownFields.length > 0) throw new TypeError(`responsibility gap has unknown fields: ${unknownFields.join(", ")}`);
  if (!isResponsibility(value.responsibility)) throw new TypeError(`responsibility must be ${RESPONSIBILITIES.join(", ")}`);
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0 || value.evidenceRefs.length > 12) {
    throw new TypeError("evidenceRefs must contain 1 to 12 evidence references");
  }
  const evidenceRefs = value.evidenceRefs.map((entry, index) => nonEmpty(entry, `evidenceRefs[${index}]`));
  const gap = nonEmpty(value.gap, "gap");
  const expectedChange = nonEmpty(value.expectedChange, "expectedChange");
  const requirements = requirementDecisions(value.requirements);
  if (requirements && value.responsibility !== "planner" && value.responsibility !== "reviewer") {
    throw new TypeError("requirements are only valid for planner or reviewer gaps");
  }
  const question = value.question === undefined ? undefined : nonEmpty(value.question, "question");
  if (value.responsibility === "user" && question === undefined) throw new TypeError("question is required for a user decision gap");
  if (value.responsibility !== "user" && question !== undefined) throw new TypeError("question is only valid for a user decision gap");
  const proposal = {
    responsibility: value.responsibility,
    gap,
    evidenceRefs: Object.freeze(evidenceRefs),
    expectedChange,
    ...(requirements === undefined ? {} : { requirements }),
    ...(question === undefined ? {} : { question }),
  };
  return Object.freeze({ ...proposal, stateDigest: stateDigest(proposal) });
}

export function bindResponsibilityGapToTask(
  proposal: Readonly<ResponsibilityGapProposal>,
  taskMessageId: string,
  sources: readonly RequirementSourceCandidate[] = [],
): Readonly<ResponsibilityGapProposal> {
  const normalizedTaskMessageId = nonEmpty(taskMessageId, "taskMessageId", 200);
  const requirements = proposal.requirements?.map((requirement) => {
    const matches = sources.filter((source) => source.text.includes(requirement.sourceExcerpt));
    if (matches.length !== 1) {
      throw new TypeError(`requirement ${requirement.id}.sourceExcerpt must match exactly one authenticated direct-user message; found ${matches.length}`);
    }
    const source = matches[0] as RequirementSourceCandidate;
    return Object.freeze({
      ...requirement,
      sourceMessageId: source.messageId,
      sourceOrder: source.order,
    });
  });
  if (requirements) {
    if (JSON.stringify(requirements).length > MAX_REQUIREMENT_CHARS) {
      throw new TypeError("bound requirements must contain at most 4000 serialized characters");
    }
    const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
    for (const requirement of requirements) {
      if (requirement.status !== "superseded") continue;
      const replacement = byId.get(requirement.supersededBy ?? "");
      if (!replacement || (requirement.sourceOrder ?? -1) >= (replacement.sourceOrder ?? -1)) {
        throw new TypeError(`requirement ${requirement.id} must precede its replacement ${requirement.supersededBy}`);
      }
    }
    if (!isBoundRequirementLedger(requirements)) throw new TypeError("bound requirements contain inconsistent source provenance");
  }
  const { stateDigest: _stateDigest, requirements: _requirements, ...unbound } = proposal;
  const bound = {
    ...unbound,
    taskMessageId: normalizedTaskMessageId,
    ...(requirements === undefined ? {} : { requirements: Object.freeze(requirements) }),
  };
  return Object.freeze({ ...bound, stateDigest: stateDigest(bound) });
}

export interface ResponsibilityGapToolOptions {
  isChild?(agent: DshAgent): boolean;
  bindToTask?(agent: DshAgent, proposal: Readonly<ResponsibilityGapProposal>): Readonly<ResponsibilityGapProposal>;
  onProposed?(agent: DshAgent, proposal: Readonly<ResponsibilityGapProposal>, execution: ToolExecution): void;
}

export function createResponsibilityGapTool(
  options: ResponsibilityGapToolOptions = {},
): RuntimeTool<unknown, ResponsibilityGapResult> {
  const isChild = typeof options.isChild === "function" ? options.isChild : () => false;
  const bindToTask = typeof options.bindToTask === "function" ? options.bindToTask : (_agent: DshAgent, proposal: Readonly<ResponsibilityGapProposal>) => proposal;
  const onProposed = typeof options.onProposed === "function" ? options.onProposed : () => {};
  return {
    name: "odai_responsibility_gap",
    description: "Record a controller-owned responsibility or user-decision gap that can change the result.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["responsibility", "gap", "evidenceRefs", "expectedChange"],
      properties: {
        responsibility: { type: "string", enum: [...RESPONSIBILITIES] },
        gap: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        expectedChange: { type: "string" },
        requirements: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "statement", "status", "sourceExcerpt"],
            properties: {
              id: { type: "string" },
              statement: { type: "string" },
              status: { type: "string", enum: [...REQUIREMENT_STATUSES] },
              sourceExcerpt: { type: "string" },
              supersededBy: { type: "string" },
            },
          },
        },
        question: { type: "string" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["recorded", "responsibility", "stateDigest", "next"],
        properties: {
          recorded: { type: "boolean" },
          responsibility: { type: "string", enum: [...RESPONSIBILITIES] },
          stateDigest: { type: "string" },
          next: { type: "string" },
        },
      },
      render(_arguments, value) {
        return [{
          type: "text",
          text: `Recorded ${value.responsibility} gap (${value.stateDigest}); this responsibility has not been routed or started. ${value.next}`,
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_responsibility_gap requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not own Odai responsibility or user-decision gaps");
      const proposal = bindToTask(execution.agent, resolveResponsibilityGap(arguments_));
      onProposed(execution.agent, proposal, execution);
      return Promise.resolve({
        recorded: true,
        responsibility: proposal.responsibility,
        stateDigest: proposal.stateDigest,
        next: proposal.responsibility === "user"
          ? "Ask exactly the accepted concise question and wait for the user's decision."
          : "The runtime will reassess the recorded proposal before the next affected model step and will report separately whether it routed or started.",
      });
    },
  };
}
