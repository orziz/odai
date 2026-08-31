import type { ResponsibilityScope } from "./responsibility-scope.mjs";
import type { DshAgent, RuntimeTool, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export type ResponsibilityReturnTarget = "controller";

export interface ResponsibilityReturnResult extends UnknownRecord {
  returned: true;
  scopeId: string;
  responsibility: string;
  target: ResponsibilityReturnTarget;
  summary: string;
  evidenceRefs: readonly string[];
}

interface ResponsibilityReturnOptions {
  activeScopeFor(agent: DshAgent): ResponsibilityScope | undefined;
  onReturned(agent: DshAgent, result: ResponsibilityReturnResult): void;
}

const RETURNABLE_RESPONSIBILITIES = new Set(["researcher", "planner", "reviewer"]);

function nonEmpty(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function evidenceReferences(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new TypeError("evidenceRefs must contain 1 to 12 references");
  }
  return Object.freeze(value.map((entry, index) => nonEmpty(entry, `evidenceRefs[${index}]`, 500)));
}

export function createResponsibilityReturnTool(
  options: ResponsibilityReturnOptions,
): RuntimeTool<unknown, ResponsibilityReturnResult> {
  return {
    name: "odai_responsibility_return",
    description: "Return a completed same-turn read-only researcher, planner, or reviewer responsibility to the preserved controller route. This mechanically ends the responsibility scope; a terminal response does not.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target", "summary", "evidenceRefs"],
      properties: {
        target: { type: "string", enum: ["controller"] },
        summary: { type: "string", description: "Bounded result for the controller; at most 12000 characters." },
        evidenceRefs: { type: "array", items: { type: "string" }, description: "One to twelve decisive evidence references." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["returned", "scopeId", "responsibility", "target", "summary", "evidenceRefs"],
        properties: {
          returned: { type: "boolean", const: true },
          scopeId: { type: "string" },
          responsibility: { type: "string", enum: ["researcher", "planner", "reviewer"] },
          target: { type: "string", enum: ["controller"] },
          summary: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
      render(_arguments, value) {
        return [{
          type: "text",
          text: [
            `Returned ${value.responsibility} responsibility to the controller.`,
            `scopeId=${value.scopeId}`,
            "",
            value.summary,
            "",
            `Evidence: ${value.evidenceRefs.join("; ")}`,
          ].join("\n"),
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_responsibility_return requires an owning agent session");
      if (!isUnknownRecord(arguments_)) throw new TypeError("arguments must be an object");
      const scope = options.activeScopeFor(execution.agent);
      if (!scope || scope.continuationPolicy !== "read-only-tool-chain" || !RETURNABLE_RESPONSIBILITIES.has(scope.role)) {
        throw new Error("odai_responsibility_return requires an active same-turn read-only researcher, planner, or reviewer scope");
      }
      if (arguments_.target !== "controller") throw new TypeError("target must be controller");
      const result = Object.freeze({
        returned: true as const,
        scopeId: scope.id,
        responsibility: scope.role,
        target: "controller" as const,
        summary: nonEmpty(arguments_.summary, "summary", 12_000),
        evidenceRefs: evidenceReferences(arguments_.evidenceRefs),
      });
      options.onReturned(execution.agent, result);
      return Promise.resolve(result);
    },
  };
}
