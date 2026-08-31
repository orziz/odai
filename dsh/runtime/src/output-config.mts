import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { acquireOwnedStoreLock } from "./store-lock.mjs";
import type { DshAgent, ModelRoute, RuntimeTool, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const STORE_SCHEMA_VERSION = 1;
const POLICY_FIELDS = new Set<string>(["concise", "maxTokens"]);
const OUTPUT_MODES = new Set<string>(["normal", "concise", "economy"]);
const DEFAULT_ECONOMY_MAX_TOKENS = 500;
const SESSION_SCOPE_CUE = /(?:(?:这个|当前|本次|本)(?:会话|对话)|(?:会话|对话)(?:内|里)|\b(?:this|current)\s+(?:chat|conversation|session)\b)/iu;
const OUTPUT_LIMIT_CUE = /(?:(?:输出|回复|回答|token).{0,8}(?:上限|限制)|(?:上限|限制)|\b(?:output|token)?\s*(?:limit|cap|ceiling)\b)/iu;
const SESSION_UNCAP_CUE = /(?:放开|取消|移除|解除|不设|不要|不限|\b(?:remove|lift|disable|drop|clear|uncap)\b)/iu;
const SESSION_INHERIT_CUE = /(?:恢复|重新启用|重启|\b(?:restore|reinstate|re-enable|enable)\b)/iu;
const QUESTION_CUE = /(?:[?？]|请问|能不能|可不可以|可以吗|是否|为什么|为何|怎么|如何|想知道|想了解|告诉我|解释|会发生什么|意味着什么|如果|假如|\b(?:can|could|would|why|how|whether|if|tell me|explain|wonder|want to know|what happens|what would happen|what does .{0,24} mean|is it possible)\b)/iu;

export type SessionOutputCeilingDirective = "uncap" | "inherit";

export function classifySessionOutputCeilingDirective(text: unknown): SessionOutputCeilingDirective | undefined {
  if (typeof text !== "string" || !SESSION_SCOPE_CUE.test(text) || !OUTPUT_LIMIT_CUE.test(text) || QUESTION_CUE.test(text)) {
    return undefined;
  }
  const inherit = SESSION_INHERIT_CUE.test(text);
  const uncap = SESSION_UNCAP_CUE.test(text);
  if (inherit === uncap) return undefined;
  return inherit ? "inherit" : "uncap";
}

export interface OutputPolicy {
  readonly concise: boolean;
  readonly maxTokens?: number;
}

export interface OutputPolicyStore {
  readonly schemaVersion: 1;
  readonly policy?: OutputPolicy;
}

export type OutputPolicySource = "default" | "persisted";
export interface OutputPolicySelection {
  readonly policy: OutputPolicy;
  readonly source: OutputPolicySource;
}

export const DEFAULT_OUTPUT_POLICY: Readonly<OutputPolicy> = Object.freeze({ concise: true });
export class OutputPolicyStoreValidationError extends Error {}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function resolveOutputPolicy(value: unknown, field = "Odai output policy"): Readonly<OutputPolicy> {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  const unknownFields = Object.keys(value).filter((name) => !POLICY_FIELDS.has(name));
  if (unknownFields.length > 0) throw new TypeError(`${field} has unknown fields: ${unknownFields.join(", ")}`);
  if (!Object.hasOwn(value, "concise") || typeof value.concise !== "boolean") {
    throw new TypeError(`${field}.concise must be an own boolean property`);
  }
  if (value.maxTokens !== undefined
    && (typeof value.maxTokens !== "number" || !Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0)) {
    throw new TypeError(`${field}.maxTokens must be a positive integer`);
  }
  return Object.freeze({
    concise: value.concise,
    ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
  });
}

export function resolveOutputConfigPath(
  configuredPath: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.output.configPath must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "output.json");
}

export function readOutputPolicyStore(configPath: string): Readonly<OutputPolicyStore> {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION });
    throw new Error(`cannot read Odai output configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new OutputPolicyStoreValidationError(`Odai output configuration ${configPath} is not valid JSON`, { cause: error });
  }
  try {
    if (!isUnknownRecord(parsed)) throw new TypeError(`Odai output configuration ${configPath} must be an object`);
    const unknownFields = Object.keys(parsed).filter((field) => !["schemaVersion", "policy"].includes(field));
    if (unknownFields.length > 0) {
      throw new TypeError(`Odai output configuration ${configPath} has unknown fields: ${unknownFields.join(", ")}`);
    }
    if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
      throw new TypeError(`Odai output configuration ${configPath} has unsupported schemaVersion ${String(parsed.schemaVersion)}`);
    }
    if (parsed.policy === undefined) return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION });
    return Object.freeze({
      schemaVersion: STORE_SCHEMA_VERSION,
      policy: resolveOutputPolicy(parsed.policy, `Odai output configuration ${configPath}.policy`),
    });
  } catch (error) {
    if (error instanceof OutputPolicyStoreValidationError) throw error;
    throw new OutputPolicyStoreValidationError(
      `Odai output configuration ${configPath} failed validation: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function effectiveOutputPolicy(configPath: string): Readonly<OutputPolicySelection> {
  const stored = readOutputPolicyStore(configPath);
  return Object.freeze({
    policy: stored.policy ?? DEFAULT_OUTPUT_POLICY,
    source: stored.policy ? "persisted" : "default",
  });
}

export const IN_PLACE_OUTPUT_RESPONSIBILITIES = Object.freeze(["planner", "frontend"] as const);
export type InPlaceOutputResponsibility = (typeof IN_PLACE_OUTPUT_RESPONSIBILITIES)[number];
export type OutputBudgetSource = "responsibility-override" | "controller-policy" | "unbounded-by-odai";

export interface ResponsibilityOutputBudget {
  readonly source: OutputBudgetSource;
  readonly maxTokens?: number;
  readonly warning?: "responsibility-inherits-controller-ceiling";
}

export type ResponsibilityOutputBudgets = Readonly<Partial<Record<InPlaceOutputResponsibility, ResponsibilityOutputBudget>>>;

function resolveResponsibilityOutputBudget(
  policy: OutputPolicy | undefined,
  route: Partial<ModelRoute>,
): Readonly<ResponsibilityOutputBudget> {
  if (route.maxTokens !== undefined) {
    return Object.freeze({ source: "responsibility-override", maxTokens: route.maxTokens });
  }
  if (policy?.maxTokens !== undefined) {
    return Object.freeze({
      source: "controller-policy",
      maxTokens: policy.maxTokens,
      warning: "responsibility-inherits-controller-ceiling",
    });
  }
  return Object.freeze({ source: "unbounded-by-odai" });
}

export function resolveInPlaceResponsibilityOutputBudgets(
  policy: OutputPolicy | undefined,
  routes: unknown,
): ResponsibilityOutputBudgets | undefined {
  if (!isUnknownRecord(routes)) return undefined;
  const entries: [InPlaceOutputResponsibility, ResponsibilityOutputBudget][] = [];
  for (const responsibility of IN_PLACE_OUTPUT_RESPONSIBILITIES) {
    const route = routes[responsibility];
    if (isUnknownRecord(route)) entries.push([responsibility, resolveResponsibilityOutputBudget(policy, route)]);
  }
  const budgets: ResponsibilityOutputBudgets = Object.fromEntries(entries);
  return Object.keys(budgets).length > 0 ? Object.freeze(budgets) : undefined;
}

function writeOutputPolicyStore(configPath: string, policy: OutputPolicy): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  const value = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, policy }, null, 2)}\n`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function preserveInvalidStore(configPath: string): boolean {
  try {
    renameSync(configPath, `${configPath}.invalid-${Date.now()}-${randomUUID()}`);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export type OutputConfigAction = "show" | "set" | "remove";

export interface OutputConfigResult {
  action: OutputConfigAction;
  configPath: string;
  policy: OutputPolicy;
  source: OutputPolicySource;
  requiresNextTurn: boolean;
  responsibilityBudgets?: ResponsibilityOutputBudgets;
  recoveredInvalidStore?: true;
}

function resultFor(
  configPath: string,
  action: OutputConfigAction,
  selection: OutputPolicySelection,
  recoveredInvalidStore = false,
  responsibilityRoutes?: unknown,
): OutputConfigResult {
  const responsibilityBudgets = resolveInPlaceResponsibilityOutputBudgets(selection.policy, responsibilityRoutes);
  return {
    action,
    configPath,
    policy: selection.policy,
    source: selection.source,
    requiresNextTurn: action !== "show",
    ...(responsibilityBudgets ? { responsibilityBudgets } : {}),
    ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
  };
}

export function renderOutputPolicyPrompt(policy: OutputPolicy): string {
  if (!policy.concise && policy.maxTokens === undefined) return "";
  return [
    "## Odai controller output policy",
    ...(policy.concise ? [
      "Keep the final user-facing response concise. Include only the result, decisive evidence, unresolved items, and necessary next action; omit routine process narration and repeated context unless the user explicitly asks for detail.",
    ] : []),
    ...(policy.maxTokens === undefined ? [] : [
      `Each controller model request carries a provider output ceiling request of ${policy.maxTokens} tokens, which may include reasoning. Provider enforcement is not guaranteed; prioritize completion and finish before the requested ceiling.`,
    ]),
    "This policy applies only to controller requests and the final user-facing response. It never reduces child-agent, compaction, checkpoint, or other internal context budgets. A user-configured in-place responsibility maxTokens explicitly overrides this ceiling only inside that routed planner or frontend scope; the runtime records that exception.",
    "The policy changes presentation and the requested controller budget only; it never permits omitting required results, evidence, risks, blockers, or verification.",
  ].join("\n");
}

function resolveSetPolicy(arguments_: UnknownRecord): Readonly<OutputPolicy> {
  if (arguments_.mode === undefined) {
    if (arguments_.concise === false && arguments_.maxTokens !== undefined) {
      throw new TypeError("maxTokens requires concise=true or mode=economy");
    }
    return resolveOutputPolicy({
      concise: arguments_.concise,
      ...(arguments_.maxTokens === undefined ? {} : { maxTokens: arguments_.maxTokens }),
    });
  }
  if (typeof arguments_.mode !== "string" || !OUTPUT_MODES.has(arguments_.mode)) {
    throw new TypeError("mode must be normal, concise, or economy");
  }
  if (arguments_.concise !== undefined) {
    throw new TypeError("concise must be omitted when mode is supplied");
  }
  if (arguments_.mode !== "economy" && arguments_.maxTokens !== undefined) {
    throw new TypeError("maxTokens is accepted only with economy mode");
  }
  return resolveOutputPolicy({
    concise: arguments_.mode !== "normal",
    ...(arguments_.mode === "economy"
      ? { maxTokens: arguments_.maxTokens ?? DEFAULT_ECONOMY_MAX_TOKENS }
      : {}),
  });
}

export interface OutputConfiguredEvent {
  action: "set" | "remove";
  policy: OutputPolicy;
  recoveredInvalidStore?: true;
}

export interface OutputConfigToolOptions {
  onConfigured?(agent: DshAgent, event: OutputConfiguredEvent): void;
  responsibilityRoutesFor?(): unknown;
  isChild?(agent: DshAgent): boolean;
}

export function createOutputConfigTool(
  configPath: string,
  options: OutputConfigToolOptions = {},
): RuntimeTool<unknown, OutputConfigResult> {
  const onConfigured = typeof options.onConfigured === "function" ? options.onConfigured : () => {};
  const responsibilityRoutesFor = typeof options.responsibilityRoutesFor === "function" ? options.responsibilityRoutesFor : () => undefined;
  const isChild = typeof options.isChild === "function"
    ? options.isChild
    : (agent: DshAgent) => {
      const header = agent?.session?.header;
      return header?.origin === "subagent"
        || (Number.isSafeInteger(header?.delegationDepth) && (header?.delegationDepth ?? 0) > 0);
    };
  return {
    name: "odai_output_config",
    description: [
      "Inspect, set, or remove the shared Odai controller output policy; the package default is soft concise.",
      "Normal mode is concise=false with no maxTokens; soft concise is concise=true with no maxTokens; economy mode is concise=true with a user-adjustable maxTokens request ceiling and defaults to 500 only when the user names economy without another value.",
      "Use only when the user explicitly requests an output mode or supplies a custom maxTokens; never invent a non-default custom value. Remove restores soft concise.",
      "Changes start next user turn. maxTokens is a provider request ceiling, not locally enforced; providers may include reasoning, exceed or ignore it, or truncate responses. Child-agent, compaction, checkpoint, and other internal budgets stay unchanged.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["show", "set", "remove"] },
        mode: { type: "string", enum: ["normal", "concise", "economy"], description: "Preferred for set; economy defaults maxTokens to 500 unless the user supplies another positive value." },
        concise: { type: "boolean", description: "Backward-compatible alternative for set; omit when mode is supplied." },
        maxTokens: { type: "integer", description: "Optional positive replacement for economy mode's default 500-token provider request ceiling." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "configPath", "policy", "source", "requiresNextTurn"],
        properties: {
          action: { type: "string", enum: ["show", "set", "remove"] },
          configPath: { type: "string" },
          policy: { type: "object", additionalProperties: false, required: ["concise"], properties: { concise: { type: "boolean" }, maxTokens: { type: "integer" } } },
          source: { type: "string", enum: ["default", "persisted"] },
          requiresNextTurn: { type: "boolean" },
          recoveredInvalidStore: { type: "boolean" },
          responsibilityBudgets: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(IN_PLACE_OUTPUT_RESPONSIBILITIES.map((responsibility) => [responsibility, {
              type: "object",
              additionalProperties: false,
              required: ["source"],
              properties: {
                source: { type: "string", enum: ["responsibility-override", "controller-policy", "unbounded-by-odai"] },
                maxTokens: { type: "integer" },
                warning: { type: "string", enum: ["responsibility-inherits-controller-ceiling"] },
              },
            }])),
          },
        },
      },
      render(_arguments, value) {
        const settings = [
          `concise=${value.policy.concise ? "on" : "off"}`,
          ...(value.policy.maxTokens === undefined ? [] : [`maxTokens=${value.policy.maxTokens}`]),
        ].join(", ");
        const responsibilityBudgets = Object.entries(value.responsibilityBudgets ?? {});
        const configuredResponsibilities = responsibilityBudgets.map(([responsibility, budget]) => (
          `${responsibility}=${budget.maxTokens === undefined ? "no Odai maxTokens" : `maxTokens=${budget.maxTokens}`} [${budget.source}]`
        ));
        const inheritedWarnings = responsibilityBudgets
          .filter(([, budget]) => budget.warning === "responsibility-inherits-controller-ceiling")
          .map(([responsibility]) => ` Warning: ${responsibility} has no explicit maxTokens and inherits the controller ceiling when routed in-place; providers may count reasoning and truncate substantial work.`);
        return [{
          type: "text",
          text: [
            `${value.action === "show" ? "Current" : "Updated"} Odai controller output policy (${value.source}): ${settings}.`,
            ...(value.policy.maxTokens === undefined ? [] : [" maxTokens is sent as a provider request ceiling; strict provider compliance is not guaranteed and must be checked from usage."]),
            ...(configuredResponsibilities.length > 0 ? [` In-place responsibility ceilings: ${configuredResponsibilities.join("; ")}.`] : []),
            ...inheritedWarnings,
            ...(value.recoveredInvalidStore ? [" An invalid prior store was preserved and replaced."] : []),
            ...(value.requiresNextTurn ? [" The change applies from the next user turn."] : []),
          ].join(""),
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_output_config requires an owning agent session");
      if (isChild(execution.agent)) throw new Error("child agents may not change Odai output configuration");
      if (!isUnknownRecord(arguments_)) throw new TypeError("arguments must be an object");
      const unknownFields = Object.keys(arguments_).filter((field) => !["action", "mode", "concise", "maxTokens"].includes(field));
      if (unknownFields.length > 0) throw new TypeError(`unknown arguments: ${unknownFields.join(", ")}`);
      const action = arguments_.action;
      if (action !== "show" && action !== "set" && action !== "remove") throw new TypeError("action must be show, set, or remove");
      if (action === "show") {
        if (arguments_.mode !== undefined || arguments_.concise !== undefined || arguments_.maxTokens !== undefined) {
          throw new TypeError("mode, concise, and maxTokens must be omitted for show");
        }
        return Promise.resolve(resultFor(configPath, "show", effectiveOutputPolicy(configPath), false, responsibilityRoutesFor()));
      }
      if (action === "remove"
        && (arguments_.mode !== undefined || arguments_.concise !== undefined || arguments_.maxTokens !== undefined)) {
        throw new TypeError("mode, concise, and maxTokens must be omitted for remove");
      }
      const proposed = action === "set" ? resolveSetPolicy(arguments_) : undefined;

      const releaseLock = acquireOwnedStoreLock(configPath, "Odai output configuration");
      try {
        let recoveredInvalidStore = false;
        try {
          readOutputPolicyStore(configPath);
        } catch (error) {
          if (!(error instanceof OutputPolicyStoreValidationError)) {
            throw new Error("Odai output configuration could not be read safely; no changes were made", { cause: error });
          }
          recoveredInvalidStore = preserveInvalidStore(configPath);
        }
        if (action === "set" && proposed) writeOutputPolicyStore(configPath, proposed);
        else rmSync(configPath, { force: true });
        const selection: OutputPolicySelection = action === "set" && proposed
          ? Object.freeze({ policy: proposed, source: "persisted" })
          : Object.freeze({ policy: DEFAULT_OUTPUT_POLICY, source: "default" });
        onConfigured(execution.agent, {
          action,
          policy: selection.policy,
          ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
        });
        return Promise.resolve(resultFor(configPath, action, selection, recoveredInvalidStore, responsibilityRoutesFor()));
      } finally {
        releaseLock();
      }
    },
  };
}
