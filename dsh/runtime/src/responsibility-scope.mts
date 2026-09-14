import { randomUUID } from "node:crypto";

import type { DshAgent, DshEvent, DshMessage, DshSession, ModelRoute, RuntimeEventData, UnknownRecord } from "./runtime-types.mjs";
import type { RouteDecision } from "./router.mjs";

export type InPlaceResponsibility = "researcher" | "planner" | "reviewer" | "frontend";
export type ResponsibilityContinuationPolicy = "read-only-tool-chain" | "bounded-work-tool-chain";
export type ResponsibilityScopeState = "pending" | "active";

const SHORT_SCOPE_ROLES = new Set<InPlaceResponsibility>(["researcher", "planner", "reviewer"]);
const WORK_SCOPE_ROLES = new Set<InPlaceResponsibility>(["frontend"]);

export interface ResponsibilityScope {
  readonly id: string;
  readonly state: ResponsibilityScopeState;
  readonly turn: number;
  readonly startStep: number;
  readonly role: InPlaceResponsibility;
  readonly route: Readonly<ModelRoute>;
  readonly source?: string;
  readonly decision?: RouteDecision;
  readonly continuationPolicy: ResponsibilityContinuationPolicy;
  readonly stopPolicy: "terminal-response-or-ownership-boundary";
  readonly routeValidated: boolean;
  readonly resumeOfScopeId?: string;
  readonly claimedStep?: number;
  readonly baseRoute?: Readonly<ModelRoute>;
  readonly temporaryRoute?: Readonly<ModelRoute>;
  readonly routeMode?: string;
}

export interface CreateResponsibilityScopeOptions {
  turn: number;
  startStep: number;
  role: InPlaceResponsibility;
  route: ModelRoute;
  source?: string;
  decision?: RouteDecision;
  routeValidated?: boolean;
  resumeOfScopeId?: string;
}

export type ResponsibilityInterruption = RuntimeEventData & {
  scopeId: string;
  responsibility: InPlaceResponsibility;
  reason: string;
};

export interface ResponsibilityScopeRestoration extends RuntimeEventData {
  scopeId: string;
  role: InPlaceResponsibility;
  baseRoute: ModelRoute;
  temporaryRoute: ModelRoute;
}

export interface ClaimResponsibilityScopeOptions {
  step: number;
  baseRoute: ModelRoute;
  temporaryRoute: ModelRoute;
  routeMode: string;
}

function routeSnapshot(value: Partial<ModelRoute> | undefined): Readonly<ModelRoute> | undefined {
  if (typeof value?.provider !== "string" || typeof value?.model !== "string") return undefined;
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
  });
}

function rolePolicy(role: InPlaceResponsibility): ResponsibilityContinuationPolicy {
  if (SHORT_SCOPE_ROLES.has(role)) return "read-only-tool-chain";
  if (WORK_SCOPE_ROLES.has(role)) return "bounded-work-tool-chain";
  throw new TypeError(`unsupported in-place responsibility: ${role}`);
}

export function createResponsibilityScope(options: CreateResponsibilityScopeOptions): Readonly<ResponsibilityScope> {
  const { turn, startStep, role, route, source, decision, routeValidated = false, resumeOfScopeId } = options;
  if (!Number.isSafeInteger(turn) || turn < 1) throw new TypeError("scope turn must be a positive integer");
  if (!Number.isSafeInteger(startStep) || startStep < 1) throw new TypeError("scope startStep must be a positive integer");
  const requestedRoute = routeSnapshot(route);
  if (!requestedRoute) throw new TypeError("scope route must contain provider and model");
  if (resumeOfScopeId !== undefined && (typeof resumeOfScopeId !== "string" || resumeOfScopeId === "")) {
    throw new TypeError("resumeOfScopeId must be a non-empty string");
  }
  return Object.freeze({
    id: randomUUID(),
    state: "pending",
    turn,
    startStep,
    role,
    route: requestedRoute,
    source,
    decision,
    continuationPolicy: rolePolicy(role),
    stopPolicy: "terminal-response-or-ownership-boundary",
    routeValidated: routeValidated === true,
    ...(resumeOfScopeId ? { resumeOfScopeId } : {}),
  });
}

export function claimResponsibilityScope(
  scope: ResponsibilityScope,
  options: ClaimResponsibilityScopeOptions,
): Readonly<ResponsibilityScope> {
  const { step, baseRoute, temporaryRoute, routeMode } = options;
  if (scope?.state !== "pending") return scope;
  if (step !== scope.startStep) throw new Error("responsibility scope may only be claimed by its start step");
  const base = routeSnapshot(baseRoute);
  const temporary = routeSnapshot(temporaryRoute);
  if (!base || !temporary) throw new TypeError("claimed responsibility scope requires base and temporary routes");
  return Object.freeze({
    ...scope,
    state: "active",
    claimedStep: step,
    baseRoute: base,
    temporaryRoute: temporary,
    routeMode,
  });
}

export function responsibilityScopeOwnsRequest(
  scope: ResponsibilityScope | undefined,
  turn: number,
  step: number,
): boolean {
  return Boolean(scope
    && (scope.state === "pending" || scope.state === "active")
    && scope.turn === turn
    && Number.isSafeInteger(step)
    && step >= scope.startStep);
}

export function isDirectHumanMessage(message: DshMessage | undefined): boolean {
  return message?.role === "user" && message?.source?.kind === "user";
}

function assistantHasToolCalls(event: DshEvent): boolean {
  return Array.isArray(event?.data?.message?.content)
    && event.data.message.content.some((block) => block?.type === "tool-call");
}

export function responsibilityScopeStopReason(
  scope: ResponsibilityScope | undefined,
  event: DshEvent | undefined,
): string | undefined {
  if (!scope || !event) return undefined;
  if (event.type === "agent/inbox/spliced"
    && Array.isArray(event.data?.inserted)
    && event.data.inserted.some(isDirectHumanMessage)) {
    return "direct-user-input";
  }
  if (event.type === "assistant/message"
    && event.data?.turn === scope.turn
    && Number.isSafeInteger(event.data?.step)
    && (event.data.step ?? -1) >= scope.startStep
    && !assistantHasToolCalls(event)) {
    return "terminal-response";
  }
  if (event.type === "turn/end" && event.data?.turn === scope.turn) return "turn-ended";
  return undefined;
}

function scopeEventData(scope: ResponsibilityScope): Readonly<UnknownRecord> {
  return Object.freeze({
    scopeId: scope.id,
    turn: scope.turn,
    startStep: scope.startStep,
    role: scope.role,
    requestedRoute: scope.route,
    continuationPolicy: scope.continuationPolicy,
    stopPolicy: scope.stopPolicy,
    ...(scope.source ? { routeSource: scope.source } : {}),
    ...(scope.resumeOfScopeId ? { resumeOfScopeId: scope.resumeOfScopeId } : {}),
    ...(scope.baseRoute ? { baseRoute: scope.baseRoute } : {}),
    ...(scope.temporaryRoute ? { temporaryRoute: scope.temporaryRoute } : {}),
    ...(scope.routeMode ? { routeMode: scope.routeMode } : {}),
  });
}

export function responsibilityScopeStartedEvent(scope: ResponsibilityScope): Readonly<UnknownRecord> {
  return scopeEventData(scope);
}

export function responsibilityScopeClaimedEvent(scope: ResponsibilityScope): Readonly<UnknownRecord> {
  if (scope?.state !== "active") throw new TypeError("only an active responsibility scope can be recorded as claimed");
  return scopeEventData(scope);
}

export function responsibilityScopeStoppedEvent(
  scope: ResponsibilityScope,
  reason: string,
  position: { step?: number } = {},
): Readonly<UnknownRecord> {
  return Object.freeze({
    ...scopeEventData(scope),
    ...(Number.isSafeInteger(position.step) ? { stopStep: position.step } : {}),
    reason,
  });
}

export function latestDanglingResponsibilityScope(events: readonly DshEvent[] | undefined): RuntimeEventData | undefined {
  const states = new Map<string, { state: "started" | "claimed" | "stopped"; data: RuntimeEventData }>();
  for (const event of Array.isArray(events) ? events : []) {
    const scopeId = event?.data?.scopeId;
    if (typeof scopeId !== "string") continue;
    if (event.type === "odai/responsibility-scope-started") states.set(scopeId, { state: "started", data: event.data });
    else if (event.type === "odai/responsibility-scope-claimed") states.set(scopeId, { state: "claimed", data: event.data });
    else if (event.type === "odai/responsibility-scope-stopped") states.set(scopeId, { state: "stopped", data: event.data });
  }
  return [...states.values()].findLast((entry) => entry.state === "claimed")?.data;
}

export function latestStoppedResponsibilityScope(events: readonly DshEvent[] | undefined, turn: number | undefined): RuntimeEventData | undefined {
  if (turn === undefined) return undefined;
  return (Array.isArray(events) ? events : []).findLast((event) => (
    event?.type === "odai/responsibility-scope-stopped"
      && event.data?.turn === turn
      && typeof event.data?.scopeId === "string"
  ))?.data;
}

function isInPlaceResponsibility(value: unknown): value is InPlaceResponsibility {
  return value === "researcher" || value === "planner" || value === "reviewer" || value === "frontend";
}

function isResponsibilityInterruption(data: RuntimeEventData): data is ResponsibilityInterruption {
  return typeof data.scopeId === "string"
    && isInPlaceResponsibility(data.responsibility)
    && typeof data.reason === "string";
}

export function pendingResponsibilityInterruption(events: readonly DshEvent[] | undefined): ResponsibilityInterruption | undefined {
  const settled = new Set<string>();
  for (let index = (Array.isArray(events) ? events.length : 0) - 1; index >= 0; index -= 1) {
    const event = events?.[index];
    const scopeId = event?.data?.scopeId;
    if (!event || typeof scopeId !== "string") continue;
    if (["odai/responsibility-interruption-consumed", "odai/responsibility-interruption-cleared"].includes(event.type)) {
      settled.add(scopeId);
      continue;
    }
    if (event.type === "odai/responsibility-interrupted") {
      return event.data?.reason === "max-tokens" && !settled.has(scopeId) && isResponsibilityInterruption(event.data)
        ? event.data
        : undefined;
    }
  }
  return undefined;
}

function isModelRoute(value: unknown): value is ModelRoute {
  return value !== null && typeof value === "object"
    && "provider" in value && typeof value.provider === "string"
    && "model" in value && typeof value.model === "string";
}

function isResponsibilityScopeRestoration(data: RuntimeEventData): data is ResponsibilityScopeRestoration {
  return typeof data.scopeId === "string"
    && isInPlaceResponsibility(data.role)
    && isModelRoute(data.baseRoute)
    && isModelRoute(data.temporaryRoute);
}

export function pendingResponsibilityScopeRestoration(events: readonly DshEvent[] | undefined): ResponsibilityScopeRestoration | undefined {
  let candidate: ResponsibilityScopeRestoration | undefined;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === "odai/responsibility-scope-stopped"
      && isResponsibilityScopeRestoration(event.data)) {
      candidate = event.data;
      continue;
    }
    if (candidate
      && event?.type === "odai/responsibility-scope-restored"
      && event.data?.scopeId === candidate.scopeId
      && (event.data?.status === "applied" || event.data?.status === "chained")) candidate = undefined;
  }
  return candidate;
}

interface ResponsibilityScopeOwnerDependencies {
  appendEvent(agent: DshAgent, type: string, data: object): void;
  events(agent: DshAgent): readonly DshEvent[];
  routeProtections: Pick<WeakMap<DshAgent, { scopeId?: string }>, "get" | "delete">;
}

export type ResponsibilityScopeOwner = ReturnType<typeof createResponsibilityScopeOwner>;

type StopScope = (agent: DshAgent, reason: string, position?: RuntimeEventData) => ResponsibilityScope | undefined;
interface LiveScope {
  owner: { active: boolean };
  scope: ResponsibilityScope;
  stop: StopScope;
}
// Agent and Plugin can load separate copies of this module in one process.
// Only the originating owner mutates its scope and releases its protection.
const sharedScopes = globalThis as typeof globalThis & { __odaiLiveResponsibilityScopes?: WeakMap<DshAgent, LiveScope> };
const liveScopes = sharedScopes.__odaiLiveResponsibilityScopes ??= new WeakMap<DshAgent, LiveScope>();

export function createResponsibilityScopeOwner(deps: ResponsibilityScopeOwnerDependencies) {
  const { appendEvent, events, routeProtections } = deps;
  const identity = { active: true };
  const live = (agent: DshAgent): LiveScope | undefined => {
    const entry = liveScopes.get(agent);
    return entry?.owner.active ? entry : undefined;
  };
  const isOwnedElsewhere = (agent: DshAgent): boolean => {
    const entry = live(agent);
    return entry !== undefined && entry.owner !== identity;
  };
  const owners = new WeakMap<DshSession, DshAgent>();
  const bindOwner = (agent: DshAgent): void => { owners.set(agent.session, agent); };
  const stop: StopScope = (agent, reason, position = {}) => {
    const entry = live(agent);
    if (!entry) return undefined;
    if (entry.owner !== identity) return entry.stop(agent, reason, position);
    const scope = entry.scope;
    if (position.scopeId && position.scopeId !== scope.id) return undefined;
    liveScopes.delete(agent);
    const protection = routeProtections.get(agent);
    if (protection?.scopeId === scope.id) routeProtections.delete(agent);
    appendEvent(agent, "odai/route-protection-released", { scopeId: scope.id, turn: scope.turn, reason });
    appendEvent(agent, "odai/responsibility-scope-stopped", responsibilityScopeStoppedEvent(scope, reason, position));
    return scope;
  };
  return Object.freeze({
    get: (agent: DshAgent) => live(agent)?.scope,
    has: (agent: DshAgent) => live(agent) !== undefined,
    isOwnedElsewhere,
    dispose: () => { identity.active = false; },
    bindOwner,
    ownerFor(session: DshSession) {
      const agent = owners.get(session);
      return agent && !isOwnedElsewhere(agent) ? agent : undefined;
    },
    start(agent: DshAgent, options: CreateResponsibilityScopeOptions) {
      if (!identity.active) throw new Error("cannot start a scope through a disposed owner");
      stop(agent, "superseded", { step: options.startStep });
      const scope = createResponsibilityScope(options);
      liveScopes.set(agent, { owner: identity, scope, stop });
      if (agent?.session) bindOwner(agent);
      appendEvent(agent, "odai/responsibility-scope-started", responsibilityScopeStartedEvent(scope));
      return scope;
    },
    claim(agent: DshAgent, scope: ResponsibilityScope, options: ClaimResponsibilityScopeOptions) {
      const entry = live(agent);
      if (entry?.owner !== identity || entry.scope !== scope) throw new Error("cannot claim a stale responsibility scope");
      const claimed = claimResponsibilityScope(scope, options);
      liveScopes.set(agent, { owner: identity, scope: claimed, stop });
      appendEvent(agent, "odai/responsibility-scope-claimed", responsibilityScopeClaimedEvent(claimed));
      return claimed;
    },
    stop,
    stopDangling(agent: DshAgent, reason: string): RuntimeEventData | undefined {
      if (live(agent)) return undefined;
      liveScopes.delete(agent);
      const dangling = latestDanglingResponsibilityScope(events(agent));
      if (!dangling) return undefined;
      appendEvent(agent, "odai/route-protection-released", { scopeId: dangling.scopeId, turn: dangling.turn, reason });
      appendEvent(agent, "odai/responsibility-scope-stopped", { ...dangling, reason });
      return dangling;
    },
  });
}
