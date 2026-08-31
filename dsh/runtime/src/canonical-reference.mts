import { ODAI_REFERENCE_NAMES } from "./skill-bundle.mjs";
import type { OdaiReferenceName, SkillBundle } from "./skill-bundle.mjs";
import type { DshAgent, RuntimeTool } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export interface CanonicalReferenceToolOptions {
  bundleFor(agent: DshAgent): SkillBundle;
  isUnavailable?(agent: DshAgent): boolean;
}

export interface CanonicalReferenceResult {
  reference: OdaiReferenceName;
  skillVersion: string;
  runtimeContract: number;
  digest: string;
  contract: string;
}

function isReferenceName(value: unknown): value is OdaiReferenceName {
  return typeof value === "string" && (ODAI_REFERENCE_NAMES as readonly string[]).includes(value);
}

export function createCanonicalReferenceTool(
  options: CanonicalReferenceToolOptions,
): RuntimeTool<unknown, CanonicalReferenceResult> {
  if (typeof options.bundleFor !== "function") throw new TypeError("createCanonicalReferenceTool requires bundleFor");
  return {
    name: "odai_reference",
    description: "Load one canonical Odai reference named by SKILL.md when it can change the current controller decision. Read-only; never changes state, routing, or authorization.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["reference"],
      properties: {
        reference: { type: "string", enum: ODAI_REFERENCE_NAMES },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["reference", "skillVersion", "runtimeContract", "digest", "contract"],
        properties: {
          reference: { type: "string", enum: ODAI_REFERENCE_NAMES },
          skillVersion: { type: "string" },
          runtimeContract: { type: "number" },
          digest: { type: "string" },
          contract: { type: "string" },
        },
      },
      render(_arguments, value) {
        return [{
          type: "text",
          text: `Canonical ${value.reference} reference from skill ${value.skillVersion}, contract ${value.runtimeContract}, digest ${value.digest}.\n\n${value.contract}`,
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_reference requires an owning agent session");
      if (options.isUnavailable?.(execution.agent)) {
        throw new Error("odai_reference is available only to the controller outside a responsibility scope");
      }
      if (!isUnknownRecord(arguments_) || !isReferenceName(arguments_.reference)) {
        throw new TypeError(`reference must be ${ODAI_REFERENCE_NAMES.join(", ")}`);
      }
      const bundle = options.bundleFor(execution.agent);
      const contract = bundle.referenceContracts[arguments_.reference];
      if (typeof contract !== "string" || contract.trim() === "") {
        throw new Error(`Odai canonical ${arguments_.reference} reference is unavailable`);
      }
      return Promise.resolve({
        reference: arguments_.reference,
        skillVersion: bundle.manifest.skillVersion,
        runtimeContract: bundle.manifest.runtimeContract,
        digest: bundle.digest,
        contract: contract.trim(),
      });
    },
  };
}
