import type { DshAgent, DshEvent, RuntimeTool, ToolExecution } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";
import type { ContextActivation } from "./context-activation.mjs";

export const ODAI_CONTEXT_CAPABILITIES = Object.freeze([
  "routing-config",
  "human-care",
  "human-safety",
  "skill-source",
  "output-config",
  "compaction-config",
  "memory",
  "safety-continuity",
] as const);

export type ContextCapability = (typeof ODAI_CONTEXT_CAPABILITIES)[number];
type ContextActivationField = keyof ContextActivation;
type MutableContextActivation = { -readonly [Field in ContextActivationField]: boolean };

const CAPABILITY_FIELDS: Readonly<Record<ContextCapability, ContextActivationField>> = Object.freeze({
  "routing-config": "routingConfig",
  "human-care": "care",
  "human-safety": "safety",
  "skill-source": "skillSource",
  "output-config": "outputConfig",
  "compaction-config": "compactionConfig",
  memory: "memory",
  "safety-continuity": "continuity",
});

function isContextCapability(value: unknown): value is ContextCapability {
  return typeof value === "string" && (ODAI_CONTEXT_CAPABILITIES as readonly string[]).includes(value);
}

export function requestedContextCapabilities(events: readonly DshEvent[] | undefined, turn: number | undefined): readonly ContextCapability[] {
  if (!Number.isSafeInteger(turn)) return Object.freeze([]);
  const capabilities = new Set<ContextCapability>();
  for (const event of Array.isArray(events) ? events : []) {
    const capability = event.data?.capability;
    if (event.type === "odai/context-capability-requested"
      && event.data?.turn === turn
      && isContextCapability(capability)) {
      capabilities.add(capability);
    }
  }
  return Object.freeze([...capabilities]);
}

export function activateRequestedCapabilities(
  activation: ContextActivation,
  capabilities: Iterable<ContextCapability>,
): Readonly<ContextActivation> {
  const merged: MutableContextActivation = { ...activation };
  for (const capability of capabilities) {
    merged[CAPABILITY_FIELDS[capability]] = true;
  }
  if (merged.safety) merged.care = false;
  return Object.freeze(merged);
}

export interface ContextCapabilityToolOptions {
  isChild?(agent: DshAgent): boolean;
  onRequested?(agent: DshAgent, capability: ContextCapability, execution: ToolExecution): void;
}

export interface ContextCapabilityResult {
  capability: ContextCapability;
  status: "available-next-step";
}

export function createContextCapabilityTool(
  options: ContextCapabilityToolOptions = {},
): RuntimeTool<unknown, ContextCapabilityResult> {
  const isChild = typeof options.isChild === "function" ? options.isChild : () => false;
  const onRequested = typeof options.onRequested === "function" ? options.onRequested : () => {};
  return {
    name: "odai_context_capability",
    description: "Request one Odai capability when its specialized tool is not currently visible. Use this only as a discovery fallback for routing configuration, non-crisis care, crisis safety, skill source, output, compaction, memory, or safety continuity. The real tool and its complete constraints appear on the next step; this request performs no configuration, persistence, diagnosis, or model switch.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["capability"],
      properties: {
        capability: { type: "string", enum: ODAI_CONTEXT_CAPABILITIES },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["capability", "status"],
        properties: {
          capability: { type: "string", enum: ODAI_CONTEXT_CAPABILITIES },
          status: { type: "string", enum: ["available-next-step"] },
        },
      },
      render(_arguments, value) {
        return [{ type: "text", text: `Odai ${value.capability} capability is available on the next step.` }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_context_capability requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not request Odai controller capabilities");
      if (!isUnknownRecord(arguments_) || !isContextCapability(arguments_.capability)) {
        throw new TypeError(`capability must be ${ODAI_CONTEXT_CAPABILITIES.join(", ")}`);
      }
      onRequested(execution.agent, arguments_.capability, execution);
      return Promise.resolve({ capability: arguments_.capability, status: "available-next-step" });
    },
  };
}
