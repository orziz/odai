import type { DshAgent, RuntimeTool } from "./runtime-types.mjs";

export interface HumanSafetyToolOptions {
  contractFor(agent: DshAgent): string;
  isChild?(agent: DshAgent): boolean;
}

export interface HumanSafetyResult {
  priority: "highest";
  principles: readonly ["timely-intervention", "active-guidance", "no-secondary-harm"];
  userChannelOwner: "current-controller" | "controller";
  contract: string;
}

export function createHumanSafetyTool(options: HumanSafetyToolOptions): RuntimeTool<unknown, HumanSafetyResult> {
  if (typeof options.contractFor !== "function") throw new TypeError("createHumanSafetyTool requires contractFor");
  return {
    name: "odai_human_safety",
    description: "Load Odai's highest-priority crisis-safety contract for sustained or worsening low mood, hopelessness, burden, self-harm, suicide, or immediate danger. Invoke proactively; do not diagnose, score, persist state, or change model routing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "principles", "userChannelOwner", "contract"],
        properties: {
          priority: { type: "string", enum: ["highest"] },
          principles: {
            type: "array",
            items: { type: "string", enum: ["timely-intervention", "active-guidance", "no-secondary-harm"] },
          },
          userChannelOwner: { type: "string", enum: ["current-controller", "controller"] },
          contract: { type: "string" },
        },
      },
      render(_arguments, value) {
        return [{
          type: "text",
          text: `Human-safety contract loaded; the ${value.userChannelOwner} owns the user-facing response.\n\n${value.contract}`,
        }];
      },
    },
    execute(arguments_, execution) {
      if (arguments_ === null || typeof arguments_ !== "object" || Array.isArray(arguments_) || Object.keys(arguments_).length > 0) {
        throw new TypeError("odai_human_safety accepts no arguments");
      }
      if (!execution.agent) throw new Error("odai_human_safety requires an owning agent session");
      const contract = options.contractFor(execution.agent);
      if (typeof contract !== "string" || contract.trim() === "") throw new Error("Odai human-safety contract is unavailable");
      return Promise.resolve({
        priority: "highest",
        principles: ["timely-intervention", "active-guidance", "no-secondary-harm"] as const,
        userChannelOwner: options.isChild?.(execution.agent) ? "controller" : "current-controller",
        contract: contract.trim(),
      });
    },
  };
}
