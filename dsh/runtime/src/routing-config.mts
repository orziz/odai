import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { requireModelRoute, sameModelRoute, type ResolveCallConfig } from "./model-route.mjs";
import {
  IN_PLACE_OUTPUT_RESPONSIBILITIES,
  resolveInPlaceResponsibilityOutputBudgets,
  type OutputPolicy,
  type ResponsibilityOutputBudgets,
} from "./output-config.mjs";
import type { DshAgent, ModelRoute, ResponsibilityDispatch, RuntimeTool, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";
import { acquireOwnedStoreLock } from "./store-lock.mjs";

export const CONFIGURABLE_ROLES = Object.freeze(["researcher", "planner", "reviewer", "frontend"] as const);
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];
export type RoleRoutes = Partial<Record<ConfigurableRole, ModelRoute>>;
export type RoleRouteSources = Partial<Record<ConfigurableRole, "persisted-mapping" | "deployment-config">>;
export type RoleDispatches = Partial<Record<ConfigurableRole, ResponsibilityDispatch>>;
export type RoleDispatchSources = Partial<Record<ConfigurableRole, "persisted-config" | "deployment-config">>;

export interface RoutingStore {
  readonly schemaVersion: 1 | 2;
  readonly roles: Readonly<RoleRoutes>;
  readonly dispatch: Readonly<RoleDispatches>;
}

export interface RoutingSnapshot {
  readonly roles: Readonly<RoleRoutes>;
  readonly sources: Readonly<RoleRouteSources>;
  readonly dispatch: Readonly<RoleDispatches>;
  readonly dispatchSources: Readonly<RoleDispatchSources>;
}

export interface LatestRouteReceipt {
  turn?: number;
  step?: number;
  responsibility?: ConfigurableRole;
  responsibilityScopeId?: string;
  status?: "applied" | "mismatch" | "unverified" | "fallback";
  taskStatus?: "completed" | "fallback";
  routeMode?: "inline" | "same-turn" | "child";
  routeSource?: "persisted-mapping" | "deployment-config";
  fallbackUsed?: boolean;
  requestedRoute?: ModelRoute;
  actualRoute?: ModelRoute;
  stopReason?: string;
  error?: string;
  taskStopReason?: string;
  taskError?: string;
}

export const ROUTING_CONFIG_PROMPT = [
  "## Odai responsibility model configuration",
  "When the user naturally asks to inspect, set, change, or remove the research/investigation, planning/planner, review/acceptance/reviewer, or frontend design/implementation model, use odai_routing_config.",
  "Translate the user's natural responsibility wording into the tool's responsibility field. Do not require internal routing terms or a special prompt form.",
  "For a model set, call the tool only after the user explicitly supplies both provider and model. Pass reasoningEffort or maxTokens only when the user supplies them; otherwise omit them.",
  "A user may independently set or reset one responsibility's dispatch. researcher, planner, reviewer, and frontend accept same-turn or child. Do not require provider/model again for a dispatch-only change.",
  "Never infer, recommend as chosen, or silently select any provider, model, effort, token limit, dispatch, or price. Ask a concise clarification when a requested value is ambiguous.",
  "Researcher routing is task-gated but not price-aware. A researcher mapping enables the narrow trigger but does not guarantee lower cost; compare actual provider prices and measured usage without inventing either.",
  "A generic subagent is not proof that a configured responsibility ran. When a real responsibility gap emerges after initial routing and manual delegation is necessary, begin the subagent label with `odai-<responsibility>` followed by a space or colon; otherwise keep it generic and do not claim the responsibility mapping was used.",
  "Do not ask the user to edit YAML, JSON, managed Agent files, or Plugin configuration. The tool owns persistence. A set/remove change applies from the next user turn.",
  "Base controller selection remains host-owned and is not changed by this tool.",
].join("\n");

const ROLE_ROUTE_FIELDS = new Set<string>(["provider", "model", "reasoningEffort", "maxTokens"]);
const RETIRED_STORE_ROLES = new Set(["executor"]);
const STORE_SCHEMA_VERSION = 2;
const SUPPORTED_STORE_SCHEMA_VERSIONS = new Set([1, STORE_SCHEMA_VERSION]);
const DISPATCH_VALUES = new Set<ResponsibilityDispatch>(["same-turn", "child"]);

function isConfigurableRole(value: unknown): value is ConfigurableRole {
  return typeof value === "string" && (CONFIGURABLE_ROLES as readonly string[]).includes(value);
}

export function resolveRoleRoute(value: unknown, role: unknown): Readonly<ModelRoute> | undefined {
  if (value === undefined) return undefined;
  if (!isConfigurableRole(role)) throw new TypeError(`unknown odai routing responsibility: ${String(role)}`);
  if (!isUnknownRecord(value)) throw new TypeError(`routing role ${role} must be an object`);
  const unknownFields = Object.keys(value).filter((field) => !ROLE_ROUTE_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new TypeError(`routing role ${role} has unknown fields: ${unknownFields.join(", ")}`);
  }
  if (typeof value.provider !== "string" || value.provider.trim() === "") {
    throw new TypeError(`routing role ${role}.provider must be a non-empty string`);
  }
  if (typeof value.model !== "string" || value.model.trim() === "") {
    throw new TypeError(`routing role ${role}.model must be a non-empty string`);
  }
  if (value.reasoningEffort !== undefined
    && (typeof value.reasoningEffort !== "string" || value.reasoningEffort.trim() === "")) {
    throw new TypeError(`routing role ${role}.reasoningEffort must be a non-empty string`);
  }
  if (value.maxTokens !== undefined
    && (typeof value.maxTokens !== "number" || !Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0)) {
    throw new TypeError(`routing role ${role}.maxTokens must be a positive integer`);
  }

  return Object.freeze({
    provider: value.provider.trim(),
    model: value.model.trim(),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort.trim() } : {}),
    ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
  });
}

export function resolveRoleDispatch(value: unknown, role: unknown): ResponsibilityDispatch | undefined {
  if (value === undefined) return undefined;
  if (!isConfigurableRole(role)) throw new TypeError(`unknown odai routing responsibility: ${String(role)}`);
  if (typeof value !== "string" || !DISPATCH_VALUES.has(value as ResponsibilityDispatch)) {
    throw new TypeError(`routing dispatch ${role} must be same-turn or child`);
  }
  return value as ResponsibilityDispatch;
}

export function resolveRoutingConfigPath(
  configuredPath: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.routing.configPath must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "routing.json");
}

export function readRoutingStore(configPath: string): Readonly<RoutingStore> {
  if (!existsSync(configPath)) {
    return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION, roles: Object.freeze({}), dispatch: Object.freeze({}) });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read odai routing config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isUnknownRecord(parsed)) throw new TypeError(`odai routing config ${configPath} must be an object`);
  if (typeof parsed.schemaVersion !== "number" || !SUPPORTED_STORE_SCHEMA_VERSIONS.has(parsed.schemaVersion)) {
    throw new TypeError(`odai routing config ${configPath} has unsupported schemaVersion ${String(parsed.schemaVersion)}`);
  }
  const allowedStoreFields = parsed.schemaVersion === 1 ? ["schemaVersion", "roles"] : ["schemaVersion", "roles", "dispatch"];
  const unknownStoreFields = Object.keys(parsed).filter((field) => !allowedStoreFields.includes(field));
  if (unknownStoreFields.length > 0) {
    throw new TypeError(`odai routing config ${configPath} has unknown fields: ${unknownStoreFields.join(", ")}`);
  }
  if (!isUnknownRecord(parsed.roles)) throw new TypeError(`odai routing config ${configPath}.roles must be an object`);
  const rawRoles = parsed.roles;
  const rawDispatch = parsed.schemaVersion === 1
    ? {}
    : parsed.dispatch === undefined
      ? {}
      : isUnknownRecord(parsed.dispatch)
        ? parsed.dispatch
        : (() => { throw new TypeError(`odai routing config ${configPath}.dispatch must be an object`); })();
  const unknownRoles = Object.keys(rawRoles)
    .filter((role) => !isConfigurableRole(role) && !RETIRED_STORE_ROLES.has(role));
  const unknownDispatchRoles = Object.keys(rawDispatch)
    .filter((role) => !isConfigurableRole(role) && !RETIRED_STORE_ROLES.has(role));
  if (unknownRoles.length > 0) {
    throw new TypeError(`odai routing config ${configPath} has unknown roles: ${unknownRoles.join(", ")}`);
  }
  if (unknownDispatchRoles.length > 0) {
    throw new TypeError(`odai routing config ${configPath} has unknown dispatch roles: ${unknownDispatchRoles.join(", ")}`);
  }
  const entries: [ConfigurableRole, ModelRoute][] = [];
  const dispatchEntries: [ConfigurableRole, ResponsibilityDispatch][] = [];
  for (const role of CONFIGURABLE_ROLES) {
    const route = resolveRoleRoute(rawRoles[role], role);
    const dispatch = resolveRoleDispatch(rawDispatch[role], role);
    if (route) entries.push([role, route]);
    if (dispatch) dispatchEntries.push([role, dispatch]);
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion as 1 | 2,
    roles: Object.freeze(Object.fromEntries(entries)),
    dispatch: Object.freeze(Object.fromEntries(dispatchEntries)),
  });
}

export function effectiveRoleRoute(
  configPath: string,
  configuredRoles: Readonly<RoleRoutes>,
  role: ConfigurableRole,
): ModelRoute | undefined {
  return effectiveRoutingSnapshot(configPath, configuredRoles).roles[role];
}

export function effectiveRoutingSnapshot(
  configPath: string,
  configuredRoles: Readonly<RoleRoutes> = {},
  configuredDispatch: Readonly<RoleDispatches> = {},
): Readonly<RoutingSnapshot> {
  const persisted = readRoutingStore(configPath);
  const roles: RoleRoutes = {};
  const sources: RoleRouteSources = {};
  const dispatch: RoleDispatches = {};
  const dispatchSources: RoleDispatchSources = {};
  for (const role of CONFIGURABLE_ROLES) {
    const route = persisted.roles[role] ?? configuredRoles[role];
    const roleDispatch = persisted.dispatch[role] ?? configuredDispatch[role];
    if (route) {
      roles[role] = route;
      sources[role] = persisted.roles[role] ? "persisted-mapping" : "deployment-config";
    }
    if (roleDispatch) {
      dispatch[role] = roleDispatch;
      dispatchSources[role] = persisted.dispatch[role] ? "persisted-config" : "deployment-config";
    }
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    sources: Object.freeze(sources),
    dispatch: Object.freeze(dispatch),
    dispatchSources: Object.freeze(dispatchSources),
  });
}

function writeRoutingStore(configPath: string, roles: Readonly<RoleRoutes>, dispatch: Readonly<RoleDispatches>): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  const value = `${JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, roles, dispatch }, null, 2)}\n`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function preserveInvalidRoutingStore(configPath: string): void {
  if (!existsSync(configPath)) return;
  renameSync(configPath, `${configPath}.invalid-${Date.now()}-${randomUUID()}`);
}

export type RoleRouteInvalidationResult =
  | { readonly invalidated: false; readonly reason: "mapping-changed-or-not-persisted" }
  | { readonly invalidated: true; readonly backupPath: string; readonly route: ModelRoute };

export function invalidatePersistedRoleRoute(
  configPath: string,
  role: unknown,
  expectedRoute: ModelRoute,
): RoleRouteInvalidationResult {
  if (!isConfigurableRole(role)) throw new TypeError(`unknown odai routing responsibility: ${String(role)}`);
  const releaseLock = acquireOwnedStoreLock(configPath, "Odai routing configuration");
  try {
    const current = readRoutingStore(configPath);
    const persisted = current.roles[role];
    if (!sameModelRoute(persisted, expectedRoute) || !persisted) {
      return Object.freeze({ invalidated: false, reason: "mapping-changed-or-not-persisted" });
    }
    const backupPath = `${configPath}.invalidated-${Date.now()}-${randomUUID()}`;
    copyFileSync(configPath, backupPath);
    const roles: RoleRoutes = { ...current.roles };
    delete roles[role];
    writeRoutingStore(configPath, roles, current.dispatch);
    return Object.freeze({ invalidated: true, backupPath, route: persisted });
  } finally {
    releaseLock();
  }
}

function routeSchema(required: boolean): UnknownRecord {
  return {
    type: "object",
    additionalProperties: false,
    ...(required ? { required: ["provider", "model"] } : {}),
    properties: {
      provider: { type: "string" },
      model: { type: "string" },
      reasoningEffort: { type: "string" },
      maxTokens: { type: "integer" },
    },
  };
}

export type RoutingConfigAction = "show" | "set" | "remove" | "set-dispatch" | "reset-dispatch";

export interface RoutingConfigResult {
  action: RoutingConfigAction;
  responsibility?: ConfigurableRole;
  configPath: string;
  roles: Readonly<RoleRoutes>;
  sources: Readonly<RoleRouteSources>;
  dispatch: Readonly<RoleDispatches>;
  dispatchSources: Readonly<RoleDispatchSources>;
  requiresNextTurn: boolean;
  responsibilityBudgets?: ResponsibilityOutputBudgets;
  recoveredInvalidStore?: true;
  latestRoute?: LatestRouteReceipt;
}

function resultFor(
  configPath: string,
  action: RoutingConfigAction,
  snapshot: RoutingSnapshot,
  responsibility?: ConfigurableRole,
  recoveredInvalidStore = false,
  latestRoute?: LatestRouteReceipt,
  outputPolicy?: OutputPolicy,
): RoutingConfigResult {
  const responsibilityBudgets = resolveInPlaceResponsibilityOutputBudgets(outputPolicy, snapshot.roles);
  return {
    action,
    ...(responsibility ? { responsibility } : {}),
    configPath,
    roles: snapshot.roles,
    sources: snapshot.sources,
    dispatch: snapshot.dispatch,
    dispatchSources: snapshot.dispatchSources,
    requiresNextTurn: action !== "show",
    ...(responsibilityBudgets ? { responsibilityBudgets } : {}),
    ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
    ...(latestRoute ? { latestRoute } : {}),
  };
}

export interface RoutingConfiguredEvent {
  action: "set" | "remove" | "set-dispatch" | "reset-dispatch";
  responsibility: ConfigurableRole;
  route?: ModelRoute;
  dispatch?: ResponsibilityDispatch;
  validationStatus?: "verified";
  recoveredInvalidStore?: true;
}

export interface RoutingConfigToolOptions {
  onConfigured?(agent: DshAgent, event: RoutingConfiguredEvent): void;
  configuredRoles?: Readonly<RoleRoutes>;
  configuredDispatch?: Readonly<RoleDispatches>;
  latestRouteFor?(agent: DshAgent): LatestRouteReceipt | undefined;
  outputPolicyFor?(): OutputPolicy | undefined;
  resolveCallConfig?: ResolveCallConfig;
}

export interface RoutingConfigActionOptions {
  configuredRoles?: Readonly<RoleRoutes>;
  configuredDispatch?: Readonly<RoleDispatches>;
  latestRoute?: LatestRouteReceipt;
  outputPolicy?: OutputPolicy;
  resolveCallConfig?: ResolveCallConfig;
  signal?: AbortSignal;
  onConfigured?(event: RoutingConfiguredEvent): void;
}

export async function applyRoutingConfigAction(
  configPath: string,
  arguments_: unknown,
  options: RoutingConfigActionOptions = {},
): Promise<RoutingConfigResult> {
  if (!isUnknownRecord(arguments_)) throw new TypeError("arguments must be an object");
  const action = arguments_.action;
  if (!["show", "set", "remove", "set-dispatch", "reset-dispatch"].includes(String(action))) {
    throw new TypeError("action must be show, set, remove, set-dispatch, or reset-dispatch");
  }

  const routingAction = action as RoutingConfigAction;
  const configuredRoles = options.configuredRoles ?? {};
  const configuredDispatch = options.configuredDispatch ?? {};
  if (routingAction === "show") {
    return resultFor(
      configPath,
      "show",
      effectiveRoutingSnapshot(configPath, configuredRoles, configuredDispatch),
      undefined,
      false,
      options.latestRoute,
      options.outputPolicy,
    );
  }
  if (!isConfigurableRole(arguments_.responsibility)) {
    throw new TypeError("responsibility must be researcher, planner, reviewer, or frontend for configuration changes");
  }
  const responsibility = arguments_.responsibility;
  const proposedRoute = routingAction === "set" ? resolveRoleRoute({
    provider: arguments_.provider,
    model: arguments_.model,
    ...(arguments_.reasoningEffort === undefined ? {} : { reasoningEffort: arguments_.reasoningEffort }),
    ...(arguments_.maxTokens === undefined ? {} : { maxTokens: arguments_.maxTokens }),
  }, responsibility) : undefined;
  const proposedDispatch = routingAction === "set-dispatch"
    ? resolveRoleDispatch(arguments_.dispatch, responsibility)
    : undefined;

  if (routingAction === "set" && proposedRoute) {
    await requireModelRoute(
      options.resolveCallConfig,
      proposedRoute,
      options.signal,
      `${responsibility} responsibility route`,
    );
  }

  const releaseLock = acquireOwnedStoreLock(configPath, "Odai routing configuration");
  try {
    let current: Pick<RoutingStore, "roles" | "dispatch">;
    let recoveredInvalidStore = false;
    try {
      current = readRoutingStore(configPath);
    } catch (error) {
      if (routingAction !== "set") {
        throw new Error("Odai routing configuration is invalid; set a responsibility mapping to repair it automatically", { cause: error });
      }
      preserveInvalidRoutingStore(configPath);
      current = { roles: {}, dispatch: {} };
      recoveredInvalidStore = true;
    }

    const roles: RoleRoutes = { ...current.roles };
    const dispatch: RoleDispatches = { ...current.dispatch };
    if (routingAction === "remove") {
      delete roles[responsibility];
    } else if (routingAction === "set" && proposedRoute) {
      roles[responsibility] = proposedRoute;
    } else if (routingAction === "set-dispatch" && proposedDispatch) {
      dispatch[responsibility] = proposedDispatch;
    } else if (routingAction === "reset-dispatch") {
      delete dispatch[responsibility];
    }
    writeRoutingStore(configPath, roles, dispatch);
    const event: RoutingConfiguredEvent = {
      action: routingAction,
      responsibility,
      ...(roles[responsibility] ? { route: roles[responsibility] } : {}),
      ...(dispatch[responsibility] ? { dispatch: dispatch[responsibility] } : {}),
      validationStatus: routingAction === "set" && proposedRoute ? "verified" : undefined,
      ...(recoveredInvalidStore ? { recoveredInvalidStore: true } : {}),
    };
    options.onConfigured?.(event);
    return resultFor(
      configPath,
      routingAction,
      effectiveRoutingSnapshot(configPath, configuredRoles, configuredDispatch),
      responsibility,
      recoveredInvalidStore,
      undefined,
      options.outputPolicy,
    );
  } finally {
    releaseLock();
  }
}

export function createRoutingConfigTool(
  configPath: string,
  options: RoutingConfigToolOptions = {},
): RuntimeTool<unknown, RoutingConfigResult> {
  const onConfigured = typeof options.onConfigured === "function" ? options.onConfigured : () => {};
  const configuredRoles = options.configuredRoles ?? {};
  const configuredDispatch = options.configuredDispatch ?? {};
  const latestRouteFor = typeof options.latestRouteFor === "function" ? options.latestRouteFor : () => undefined;
  const outputPolicyFor = typeof options.outputPolicyFor === "function" ? options.outputPolicyFor : () => undefined;
  const resolveCallConfig = typeof options.resolveCallConfig === "function" ? options.resolveCallConfig : undefined;
  return {
    name: "odai_routing_config",
    description: [
      "Inspect effective Odai model mappings, per-responsibility dispatch overrides, and the latest current-session route receipt; set/remove mappings or set/reset dispatch for researcher, planner, reviewer, and frontend responsibilities.",
      "Use this only when the user naturally and explicitly asks to inspect/remove a mapping, names the provider/model to set, or explicitly chooses same-turn/child dispatch.",
      "Never choose a provider, model, reasoning effort, token limit, or price on the user's behalf. Never choose a dispatch mode on the user's behalf.",
      "Researcher routing is task-gated but not price-aware; its mapping does not guarantee lower cost.",
      "For every configuration change, handle one responsibility per call. Persisted model mappings and dispatch overrides are shared by the Odai DSH Plugin and Agent and apply from the next user turn.",
      "Results expose configured in-place responsibility ceilings and warn when planner or frontend mappings without maxTokens inherit the controller ceiling; never invent an override.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["show", "set", "remove", "set-dispatch", "reset-dispatch"], description: "Show configuration, set/remove one model mapping, or set/reset one dispatch override." },
        responsibility: { type: "string", enum: [...CONFIGURABLE_ROLES], description: "Required for every action except show." },
        provider: { type: "string", description: "Provider id explicitly supplied by the user; required for set." },
        model: { type: "string", description: "Model id explicitly supplied by the user; required for set." },
        reasoningEffort: { type: "string", description: "Optional reasoning effort explicitly supplied by the user." },
        maxTokens: { type: "integer", description: "Optional positive output limit explicitly supplied by the user. It limits routed child requests and explicitly overrides the global controller ceiling only inside the same planner or frontend responsibility scope when that responsibility runs in-place." },
        dispatch: { type: "string", enum: ["same-turn", "child"], description: "Required for set-dispatch. Every responsibility accepts same-turn or child." },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "configPath", "roles", "sources", "dispatch", "dispatchSources", "requiresNextTurn"],
        properties: {
          action: { type: "string", enum: ["show", "set", "remove", "set-dispatch", "reset-dispatch"] },
          responsibility: { type: "string", enum: [...CONFIGURABLE_ROLES] },
          configPath: { type: "string" },
          roles: { type: "object", additionalProperties: false, properties: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, routeSchema(true)])) },
          sources: { type: "object", additionalProperties: false, properties: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, { type: "string", enum: ["persisted-mapping", "deployment-config"] }])) },
          dispatch: { type: "object", additionalProperties: false, properties: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, { type: "string", enum: ["same-turn", "child"] }])) },
          dispatchSources: { type: "object", additionalProperties: false, properties: Object.fromEntries(CONFIGURABLE_ROLES.map((role) => [role, { type: "string", enum: ["persisted-config", "deployment-config"] }])) },
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
          latestRoute: {
            type: "object",
            additionalProperties: false,
            required: ["turn", "step", "responsibility", "status", "routeSource", "fallbackUsed"],
            properties: {
              turn: { type: "integer" }, step: { type: "integer" }, responsibility: { type: "string", enum: [...CONFIGURABLE_ROLES] },
              responsibilityScopeId: { type: "string" },
              status: { type: "string", enum: ["applied", "mismatch", "unverified", "fallback"] },
              taskStatus: { type: "string", enum: ["completed", "fallback"] }, routeMode: { type: "string", enum: ["inline", "same-turn", "child"] },
              routeSource: { type: "string", enum: ["persisted-mapping", "deployment-config"] }, fallbackUsed: { type: "boolean" },
              requestedRoute: routeSchema(true), actualRoute: routeSchema(true), stopReason: { type: "string" }, error: { type: "string" },
              taskStopReason: { type: "string" }, taskError: { type: "string" },
            },
          },
        },
      },
      render(_arguments, value) {
        const mapping = Object.entries(value.roles)
          .map(([role, route]) => {
            const options = [
              ...(route.reasoningEffort ? [`reasoningEffort=${route.reasoningEffort}`] : []),
              ...(route.maxTokens ? [`maxTokens=${route.maxTokens}`] : []),
            ];
            return `${role}: ${route.provider}/${route.model}${options.length > 0 ? ` (${options.join(", ")})` : ""} [${value.sources[role as ConfigurableRole]}]`;
          })
          .join("\n") || "No Odai responsibility models are configured.";
        const dispatch = Object.entries(value.dispatch)
          .map(([role, mode]) => `${role}: ${mode} [${value.dispatchSources[role as ConfigurableRole]}]`)
          .join("\n") || "No per-responsibility dispatch overrides are configured; legacy defaults apply.";
        const responsibilityBudgets = Object.entries(value.responsibilityBudgets ?? {});
        const configuredResponsibilities = responsibilityBudgets.length > 0
          ? `\nIn-place responsibility ceilings: ${responsibilityBudgets.map(([responsibility, budget]) => (
              `${responsibility}=${budget.maxTokens === undefined ? "no Odai maxTokens" : `maxTokens=${budget.maxTokens}`} [${budget.source}]`
            )).join("; ")}.`
          : "";
        const inheritedWarnings = responsibilityBudgets
          .filter(([, budget]) => budget.warning === "responsibility-inherits-controller-ceiling")
          .map(([responsibility]) => `\nWarning: ${responsibility} has no explicit maxTokens and inherits the controller ceiling when routed in-place; providers may count reasoning and truncate substantial work.`)
          .join("");
        const latestRoute = value.latestRoute
          ? [
              "\nLatest current-session responsibility route receipt:",
              `responsibility=${value.latestRoute.responsibility} status=${value.latestRoute.status} mode=${value.latestRoute.routeMode ?? "unknown"}`,
              `routeSource=${value.latestRoute.routeSource} fallbackUsed=${String(value.latestRoute.fallbackUsed)}`,
              ...(value.latestRoute.responsibilityScopeId ? [`responsibilityScope=${value.latestRoute.responsibilityScopeId}`] : []),
              ...(value.latestRoute.taskStatus ? [`taskStatus=${value.latestRoute.taskStatus}`] : []),
              ...(value.latestRoute.taskStopReason ? [`taskStopReason=${value.latestRoute.taskStopReason}`] : []),
              ...(value.latestRoute.error ? [`routeError=${value.latestRoute.error}`] : []),
              ...(value.latestRoute.taskError ? [`taskError=${value.latestRoute.taskError}`] : []),
              ...(value.latestRoute.actualRoute
                ? [`actual=${value.latestRoute.actualRoute.provider}/${value.latestRoute.actualRoute.model} (${[
                    `reasoningEffort=${value.latestRoute.actualRoute.reasoningEffort ?? "unspecified"}`,
                    ...(value.latestRoute.actualRoute.maxTokens === undefined ? [] : [`maxTokens=${value.latestRoute.actualRoute.maxTokens}`]),
                  ].join(", ")})`]
                : ["actual=<unverified>"]),
            ].join("\n")
          : value.action === "show"
            ? "\nNo mapped responsibility route receipt is recorded in this session."
            : "";
        return [{
          type: "text",
          text: [
            `${value.action === "show" ? "Current" : "Updated"} Odai routing configuration:\n${mapping}\nDispatch overrides:\n${dispatch}`,
            ...(value.recoveredInvalidStore ? ["\nAn invalid prior store was preserved and replaced."] : []),
            configuredResponsibilities,
            inheritedWarnings,
            ...(value.roles.researcher ? ["\nResearcher routing is task-gated but not price-aware. This mapping does not guarantee lower cost; compare actual provider prices and measured usage."] : []),
            latestRoute,
            ...(value.requiresNextTurn ? ["\nThe change applies from the next user turn."] : []),
          ].join(""),
        }];
      },
    },
    execute(arguments_, execution) {
      if (!execution.agent) throw new Error("odai_routing_config requires an owning agent session");
      const agent = execution.agent;
      const header = agent.session?.header;
      if (header?.origin === "subagent" || (Number.isSafeInteger(header?.delegationDepth) && (header?.delegationDepth ?? 0) > 0)) {
        throw new Error("child agents may not change Odai routing configuration");
      }
      return applyRoutingConfigAction(configPath, arguments_, {
        configuredRoles,
        configuredDispatch,
        latestRoute: latestRouteFor(agent),
        outputPolicy: outputPolicyFor(),
        resolveCallConfig,
        signal: execution.signal,
        onConfigured: (event) => onConfigured(agent, event),
      });
    },
  };
}
