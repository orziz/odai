
import {
  classifyResponsibilityInterruptionText,
  decideResearchPrefetch,
  decideRoute,
  extractLatestUserText,
  extractRoutingText,
  renderMissingRouteConfigNotice,
  renderRouteFailureNotice,
  renderRouteNotice,
  requiresFailClosedProtection,
} from "./router.mjs";
import type { RouteDecision } from "./router.mjs";
import type { ResponsibilityGapProposal } from "./responsibility-gap.mjs";
import { classifyModelRouteFailure, probeModelRoute } from "./model-route.mjs";
import { selectSharedOutputPolicyForTurn } from "./output-policy-state.mjs";
import { prepareSessionOutputControl } from "./output-session.mjs";
import {
  isSubagentSession, outputText, pluginMessage,
  renderOutputLimitInterruptionNotice, renderResearchTaskContract, routeFromConfig,
  routeMismatchFor, routedRoleOf, runRoutedRole, sameRequestModelRoute,
} from "./runtime-support.mjs";
import type { RoutedRoleOutcome, SubagentsService } from "./runtime-support.mjs";
import {
  claimResponsibilityScope,
  createResponsibilityScope,
  latestStoppedResponsibilityScope,
  pendingResponsibilityInterruption,
  pendingResponsibilityScopeRestoration,
  responsibilityScopeClaimedEvent,
  responsibilityScopeOwnsRequest,
  responsibilityScopeStartedEvent,
  responsibilityScopeStopReason,
} from "./responsibility-scope.mjs";
import type { InPlaceResponsibility, ResponsibilityScope } from "./responsibility-scope.mjs";
export type { ResponsibilityScope } from "./responsibility-scope.mjs";
import { buildRoleContextPacket, renderRoleContextPacket } from "./routing-context.mjs";
import {
  parseResearchPacket,
  renderResearchPacket,
  verifyResearchPacketSources,
} from "./research-packet.mjs";
import { dshRoleContract } from "./role-overlays.mjs";
import { sharedSkillSelection } from "./skill-selection-state.mjs";
import type { SkillBundle } from "./skill-bundle.mjs";
import type { SkillSelection } from "./runtime-support.mjs";
import {
  captureAutomaticMemories,
  claimSemanticMemoryTurn,
  latestDirectUserMessage,
  memoryPacketMessage,
  renderSemanticMemoryPacket,
  retrieveSemanticMemories,
} from "./semantic-memory.mjs";
import type { SemanticMemorySummary } from "./semantic-memory.mjs";
import type {
  DshAgent,
  DshEvent,
  DshMessage,
  DshRuntimeContext,
  DshSession,
  ModelRoute,
  ResponsibilityDispatch,
  RuntimeConfig,
  RuntimeEventData,
  RuntimeLogger,
  UnknownRecord,
} from "./runtime-types.mjs";
import { sessionEvents } from "./runtime-types.mjs";

interface AgentRequestEvent { agent: DshAgent; turn: number; step: number; signal: AbortSignal }
interface AgentRequestErrorEvent extends AgentRequestEvent { provider: string; failure: UnknownRecord }
interface AgentTurnEvent { agent: DshAgent; turn: number }
interface RequestOptions extends UnknownRecord, Partial<ModelRoute> { messages?: readonly DshMessage[] }
interface StepResult extends UnknownRecord { kind: string; messages: readonly DshMessage[] }
interface RouteFailure { kind: string; code: string; message: string }
interface RoleState { route?: ModelRoute; source?: string; dispatch?: ResponsibilityDispatch; dispatchSource?: string; error?: string; detail?: string; id?: string; baseRoute?: ModelRoute }
export interface RouteProtection extends UnknownRecord { scopeId?: string }

function effectiveRoleDispatch(
  role: string,
  configured: ResponsibilityDispatch | undefined,
  routingMode: RuntimeConfig["routing"]["mode"],
): ResponsibilityDispatch {
  if (configured) return configured;
  if (role === "researcher" || role === "reviewer") return "child";
  if (role === "planner") return routingMode === "auto" ? "same-turn" : "child";
  return "same-turn";
}
export interface PendingRouteReceipt extends UnknownRecord { agent: DshAgent; turn: number; step: number; responsibility: string; responsibilityScopeId?: string; routeMode: string; routeSource?: string; requestedRoute: ModelRoute; expectedRoute: ModelRoute; resumeOfScopeId?: string }
export interface PendingRestoration extends UnknownRecord { agent: DshAgent; scopeId: string; turn: number; step: number; role: string; expectedRoute: ModelRoute }
export interface OutputUsage extends UnknownRecord { turn?: number; usage?: { outputTokens?: number } }
interface MemorySettings { mode: "auto" | "off"; source: string }
function isInPlaceResponsibility(value: unknown): value is InPlaceResponsibility {
  return value === "researcher" || value === "planner" || value === "reviewer" || value === "frontend";
}

function isSubagentsService(value: unknown): value is SubagentsService {
  return value !== null && typeof value === "object" && "start" in value && typeof value.start === "function";
}

function hasReviewerDeferral(events: readonly DshEvent[], stateDigest: string): boolean {
  return events.some((event) => (
    event?.type === "odai/responsibility-gap-deferred"
    && event.data?.stateDigest === stateDigest
  ));
}

interface LifecycleDependencies {
  appendEvent(agent: DshAgent, type: string, data: object): void;
  bundled: SkillBundle;
  config: RuntimeConfig;
  configuredRole(agent: DshAgent, role: string, turn?: number): RoleState;
  ctx: DshRuntimeContext;
  evidence: { events(agent: DshAgent): DshEvent[] };
  hasSessionEvent(agent: DshAgent, type: string, predicate: (data: RuntimeEventData) => boolean): boolean;
  invalidateFailedRoleRoute(agent: DshAgent, role: string, route: ModelRoute, source: string | undefined, failure: RouteFailure, position?: RuntimeEventData): UnknownRecord;
  logger: RuntimeLogger;
  memorySettingsFor(agent: DshAgent, turn?: number): MemorySettings;
  outputUsageBySession: WeakMap<DshSession, OutputUsage>;
  pendingResponsibilityGap(agent: DshAgent, turn: number | undefined, step: number): ResponsibilityGapProposal | undefined;
  pendingRouteReceipts: WeakMap<DshSession, PendingRouteReceipt>;
  pendingScopeRestorations: WeakMap<DshSession, PendingRestoration>;
  responsibilityScopeOwners: WeakMap<DshSession, DshAgent>;
  responsibilityScopes: WeakMap<DshAgent, ResponsibilityScope>;
  routeProtections: WeakMap<DshAgent, RouteProtection>;
  selectOutputForAgent(agent?: DshAgent, turn?: number): { policy: { maxTokens?: number } };
  stopDanglingResponsibilityScope(agent: DshAgent, reason: string): RuntimeEventData | undefined;
  stopResponsibilityScope(agent: DshAgent, reason: string, position?: RuntimeEventData): ResponsibilityScope | undefined;
}

export function installLifecycleRuntime(deps: LifecycleDependencies): void {
  const { appendEvent, bundled, config, configuredRole, ctx, evidence, hasSessionEvent, invalidateFailedRoleRoute, logger, memorySettingsFor, outputUsageBySession, pendingResponsibilityGap, pendingRouteReceipts, pendingScopeRestorations, responsibilityScopeOwners, responsibilityScopes, routeProtections, selectOutputForAgent, stopDanglingResponsibilityScope, stopResponsibilityScope } = deps;
  ctx.on("agent/request", async (
    { agent, turn, step, signal }: AgentRequestEvent,
    next: () => Promise<RequestOptions>,
  ) => {
    let proposed = await next();
    const childRole = routedRoleOf(agent);
    if (!childRole && !isSubagentSession(agent)) {
      if (agent.session) responsibilityScopeOwners.set(agent.session, agent);
      const directMessage = latestDirectUserMessage(agent);
      prepareSessionOutputControl({
        events: evidence.events(agent),
        text: directMessage ? extractLatestUserText([directMessage]) : "",
        turn,
        step,
        userMessageId: typeof directMessage?.id === "string" ? directMessage.id : undefined,
        append(type, data) { appendEvent(agent, type, data); },
      });
    }
    const childRoleState = childRole ? configuredRole(agent, childRole, turn) : undefined;
    if (childRole && !childRoleState?.route) {
      throw new Error(childRoleState?.error
        ? `Odai ${childRole} child route is unavailable: ${childRoleState.detail}`
        : `Odai ${childRole} child route is not configured`);
    }
    let scope = responsibilityScopes.get(agent);
    if (scope && !responsibilityScopeOwnsRequest(scope, turn, step)) {
      stopResponsibilityScope(agent, "ownership-boundary", { step });
      scope = undefined;
    }
    if (!childRole && (!scope || scope.state === "pending")) {
      const restoration = pendingResponsibilityScopeRestoration(evidence.events(agent));
      if (restoration && sameRequestModelRoute(proposed, restoration.temporaryRoute)) {
        const { reasoningEffort: _temporaryEffort, maxTokens: _temporaryMaxTokens, ...withoutTemporaryRoute } = proposed;
        proposed = Object.freeze({ ...withoutTemporaryRoute, ...restoration.baseRoute });
        if (scope?.state === "pending") {
          appendEvent(agent, "odai/responsibility-scope-restored", {
            scopeId: restoration.scopeId,
            turn,
            step,
            role: restoration.role,
            status: "chained",
            baseRoute: restoration.baseRoute,
            nextScopeId: scope.id,
          });
        } else {
          appendEvent(agent, "odai/responsibility-scope-restoration-requested", {
            scopeId: restoration.scopeId,
            turn,
            step,
            role: restoration.role,
            requestedRoute: restoration.baseRoute,
          });
          if (agent?.session) {
            pendingScopeRestorations.set(agent.session, Object.freeze({
              agent,
              scopeId: restoration.scopeId,
              turn,
              step,
              role: restoration.role,
              expectedRoute: restoration.baseRoute,
            }));
          }
        }
      }
    }
    const upgradeRole = scope?.role;
    let roleRoute = childRole
      ? childRoleState?.route
      : scope
        ? scope.route
        : undefined;
    const routeSource = childRole ? childRoleState?.source : scope?.source;
    let routeMode = childRole ? "child" : sameRequestModelRoute(proposed, roleRoute) ? "inline" : "same-turn";
    let scopedResponsibilityMaxTokens = upgradeRole ? roleRoute?.maxTokens : undefined;
    const finalize = <T extends RequestOptions>(finalRequest: T): T => {
      if (roleRoute && agent?.session && Number.isSafeInteger(turn) && Number.isSafeInteger(step)) {
        const expectedRoute = roleRoute;
        const receiptScope = responsibilityScopeOwnsRequest(responsibilityScopes.get(agent), turn, step)
          ? responsibilityScopes.get(agent)
          : scope;
        const responsibility = childRole ?? upgradeRole;
        if (!responsibility) throw new Error("routed request is missing its responsibility");
        pendingRouteReceipts.set(agent.session, Object.freeze({
          agent,
          turn,
          step,
          responsibility,
          routeMode,
          routeSource,
          ...(receiptScope?.id ? { responsibilityScopeId: receiptScope.id } : {}),
          ...(receiptScope?.resumeOfScopeId ? { resumeOfScopeId: receiptScope.resumeOfScopeId } : {}),
          requestedRoute: expectedRoute,
          expectedRoute,
        }));
      }
      return finalRequest;
    };
    let request = proposed;
    if (roleRoute) {
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = proposed;
      request = Object.freeze({
        ...withoutInheritedEffort,
        provider: roleRoute.provider,
        model: roleRoute.model,
        ...(roleRoute.reasoningEffort === undefined ? {} : { reasoningEffort: roleRoute.reasoningEffort }),
        ...((childRole || scopedResponsibilityMaxTokens !== undefined) && roleRoute.maxTokens !== undefined
          ? { maxTokens: roleRoute.maxTokens }
          : {}),
      });
      if (!childRole && scope?.state === "pending") {
        const baseRoute = routeFromConfig(proposed);
        const temporaryRoute = routeFromConfig(request);
        if (!baseRoute || !temporaryRoute) throw new Error("responsibility scope claim requires complete request routes");
        scope = claimResponsibilityScope(scope, {
          step,
          baseRoute,
          temporaryRoute,
          routeMode,
        });
        responsibilityScopes.set(agent, scope);
        appendEvent(agent, "odai/responsibility-scope-claimed", responsibilityScopeClaimedEvent(scope));
      }
      const validation = scope?.routeValidated
        ? Object.freeze({ status: "verified" })
        : await probeModelRoute(
            (candidate: ModelRoute, candidateSignal?: AbortSignal) => ctx.llm.resolveCallConfig(candidate, candidateSignal),
            routeFromConfig(request) ?? roleRoute,
            signal,
          );
      if (validation.status === "rejected") {
        const responsibility = childRole ?? upgradeRole;
        if (!responsibility) throw new Error("route validation failure is missing its responsibility");
        const invalidation = invalidateFailedRoleRoute(
          agent,
          responsibility,
          roleRoute,
          routeSource,
          validation.failure,
          { turn, step },
        );
        appendEvent(agent, "odai/route-fallback", {
          turn,
          step,
          responsibility,
          ...(scope?.id ? { responsibilityScopeId: scope.id } : {}),
          routeMode,
          routeSource,
          requestedRoute: roleRoute,
          fallbackUsed: true,
          fallbackRoute: routeFromConfig(proposed),
          failureKind: validation.failure.kind,
          errorCode: validation.failure.code,
          error: validation.failure.message,
          invalidated: invalidation.invalidated,
        });
        if (childRole) {
          const error = new Error(`Odai ${childRole} route failed validation: ${validation.failure.code}: ${validation.failure.message}`) as Error & {
            code: string;
            routeFailureKind: string;
          };
          error.code = validation.failure.code;
          error.routeFailureKind = validation.failure.kind;
          throw error;
        }
        stopResponsibilityScope(agent, "route-validation-failed", { step });
        if (scope?.decision && requiresFailClosedProtection(scope.decision)) {
          protectController(agent, turn, step, scope.decision, "route-validation", validation.failure.message);
        }
        roleRoute = undefined;
        routeMode = "same-turn";
        scopedResponsibilityMaxTokens = undefined;
        request = proposed;
      }
    }
    if (childRole || isSubagentSession(agent)) return finalize(request);

    const outputSelection = await selectSharedOutputPolicyForTurn(agent, turn, () => selectOutputForAgent(agent, turn));
    const configuredMaxTokens = outputSelection.policy.maxTokens;
    if (scopedResponsibilityMaxTokens !== undefined) {
      if (!hasSessionEvent(agent, "odai/output-budget-overridden", (data) => data?.turn === turn && data?.step === step)) {
        appendEvent(agent, "odai/output-budget-overridden", {
          turn,
          ...(step === undefined ? {} : { step }),
          responsibility: upgradeRole,
          responsibilityMaxTokens: scopedResponsibilityMaxTokens,
          ...(configuredMaxTokens === undefined ? {} : { configuredControllerMaxTokens: configuredMaxTokens }),
          effectiveMaxTokens: scopedResponsibilityMaxTokens,
          budgetSource: "responsibility-override",
          semantics: "explicit-responsibility-override",
        });
      }
      return finalize(Object.freeze({ ...request, maxTokens: scopedResponsibilityMaxTokens }));
    }
    if (configuredMaxTokens === undefined) return finalize(request);
    const priorMaxTokens = request.maxTokens;
    const effectiveMaxTokens = priorMaxTokens === undefined
      ? configuredMaxTokens
      : Math.min(priorMaxTokens, configuredMaxTokens);
    const budgetSource = priorMaxTokens !== undefined && priorMaxTokens < configuredMaxTokens
      ? "preexisting-request-ceiling"
      : "controller-policy";
    if (!hasSessionEvent(agent, "odai/output-budget-applied", (data) => data?.turn === turn && data?.step === step)) {
      appendEvent(agent, "odai/output-budget-applied", {
        turn,
        ...(step === undefined ? {} : { step }),
        ...(upgradeRole === undefined ? {} : { responsibility: upgradeRole }),
        configuredMaxTokens,
        ...(priorMaxTokens === undefined ? {} : { priorMaxTokens }),
        effectiveMaxTokens,
        budgetSource,
        semantics: "provider-request-ceiling",
      });
    }
    return finalize(Object.freeze({ ...request, maxTokens: effectiveMaxTokens }));
  }, { prepend: true });

  const routeFallbackAttempts = new WeakMap<DshAgent, Set<string>>();
  ctx.on("agent/request-error", async (
    { agent, turn, step, provider, failure, signal }: AgentRequestErrorEvent,
    next: () => Promise<unknown>,
  ) => {
    const childRole = routedRoleOf(agent);
    const scope = responsibilityScopes.get(agent);
    if (!childRole && scope && (signal.aborted || failure?.code === "CONTEXT_WINDOW_EXCEEDED")) {
      if (agent?.session) pendingRouteReceipts.delete(agent.session);
      stopResponsibilityScope(agent, signal.aborted ? "request-aborted" : "context-window-exceeded", { step });
      return next();
    }
    if (signal.aborted || failure?.code === "CONTEXT_WINDOW_EXCEEDED") return next();
    const active = childRole
      ? { role: childRole, ...configuredRole(agent, childRole, turn) }
      : responsibilityScopeOwnsRequest(scope, turn, step)
        ? scope
        : undefined;
    if (!active?.route || provider !== active.route.provider) return next();

    const classified = classifyModelRouteFailure(failure);
    const invalidation = invalidateFailedRoleRoute(
      agent,
      active.role,
      active.route,
      active.source,
      classified,
      { turn, step },
    );
    appendEvent(agent, "odai/route-fallback", {
      turn,
      step,
      responsibility: active.role,
      ...(active.id ? { responsibilityScopeId: active.id } : {}),
      routeMode: childRole ? "child" : "same-turn",
      routeSource: active.source,
      requestedRoute: active.route,
      fallbackUsed: !childRole,
      fallbackRoute: childRole ? undefined : active.baseRoute ?? routeFromConfig(agent?.options),
      failureKind: classified.kind,
      errorCode: classified.code,
      error: classified.message,
      invalidated: invalidation.invalidated,
    });
    if (childRole) return next();
    if (agent?.session) pendingRouteReceipts.delete(agent.session);
    stopResponsibilityScope(agent, classified.kind === "cancelled" ? "request-cancelled" : "route-request-failed", { step });
    if (scope?.decision && requiresFailClosedProtection(scope.decision)) {
      protectController(agent, turn, step, scope.decision, "route-request-failure", classified.message);
    }
    if (classified.kind === "cancelled") return next();

    let attempts = routeFallbackAttempts.get(agent);
    if (!attempts) {
      attempts = new Set();
      routeFallbackAttempts.set(agent, attempts);
    }
    const key = `${turn}:${step}`;
    if (attempts.has(key)) return next();
    attempts.add(key);
    return { kind: "retry" };
  });

  const protectController = (
    agent: DshAgent,
    turn: number,
    step: number,
    decision: Pick<RouteDecision, "reasonCode">,
    source: string,
    failure: string | undefined = undefined,
    scopeId: string | undefined = undefined,
  ): void => {
    const protection = Object.freeze({
      turn,
      step,
      mode: "read-only",
      reasonCode: decision.reasonCode,
      source,
      ...(failure ? { failure } : {}),
      ...(scopeId ? { scopeId } : {}),
    });
    routeProtections.set(agent, protection);
    appendEvent(agent, "odai/route-protection", protection);
  };

  ctx.on("session/event", (session: DshSession, event: DshEvent) => {
    const owner = responsibilityScopeOwners.get(session);
    const activeScope = owner ? responsibilityScopes.get(owner) : undefined;
    const eventMatchesRequestPosition = (position: RuntimeEventData) => Number.isSafeInteger(event.data.turn)
      && Number.isSafeInteger(event?.data?.step)
      && event.data.turn === position?.turn
      && event.data.step === position?.step;
    const scopeStopReason = responsibilityScopeStopReason(activeScope, event);
    if (scopeStopReason && owner && activeScope) {
      stopResponsibilityScope(owner, scopeStopReason, {
        scopeId: activeScope.id,
        ...(Number.isSafeInteger(event.data?.step) ? { step: event.data.step } : {}),
      });
      if (scopeStopReason === "terminal-response"
        && ["researcher", "planner", "reviewer"].includes(activeScope.role)) {
        appendEvent(owner, "odai/responsibility-return-missing", {
          scopeId: activeScope.id,
          turn: activeScope.turn,
          step: event.data?.step ?? activeScope.startStep,
          responsibility: activeScope.role,
          target: "controller",
          status: typeof owner.inject === "function" ? "recovery-injected" : "recovery-unavailable",
        });
        owner.inject?.(pluginMessage([
          `The same-turn ${activeScope.role} responsibility emitted a terminal response without odai_responsibility_return.`,
          "Its text is an unverified read-only draft, not final delivery or independent acceptance.",
          "The runtime restored the controller route. Verify the decisive claims, continue the authorized task, and keep controller ownership of final delivery.",
        ].join("\n"), `${activeScope.role} handback recovery`));
      }
    }

    if (event?.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
      outputUsageBySession.set(session, {
        turn: event.data.turn,
        step: event.data.step,
        usage: event.data.chunk.usage,
      });
    } else if (event?.type === "assistant/message" && event.data?.usage) {
      outputUsageBySession.set(session, {
        turn: event.data.turn,
        step: event.data.step,
        usage: event.data.usage,
      });
    }

    if (event.type === "turn/end") {
      const usage = outputUsageBySession.get(session);
      const finishReason = event.data.reason;
      if (typeof finishReason === "object" && finishReason?.kind === "max-tokens" && owner) {
        const events = evidence.events(owner);
        const stopped = latestStoppedResponsibilityScope(events, event.data?.turn);
        const receipt = stopped && events.findLast((candidate) => (
          candidate?.type === "odai/route-applied"
            && candidate.data?.status === "applied"
            && candidate.data?.responsibilityScopeId === stopped.scopeId
        ))?.data;
        const observedOutputTokens = usage?.turn === stopped?.turn
          && usage?.step === stopped?.stopStep
          && Number.isSafeInteger(usage?.usage?.outputTokens)
          ? usage?.usage?.outputTokens
          : undefined;
        const usageStep = usage?.step;
        const rawControllerOutputTokens = usage?.usage?.outputTokens;
        const controllerBudget = usage?.turn === event.data.turn
          && Number.isSafeInteger(usageStep) && Number.isSafeInteger(rawControllerOutputTokens)
          ? events.findLast((candidate) => (
            candidate.type === "odai/output-budget-applied"
            && candidate.data?.turn === event.data.turn
            && candidate.data?.step === usageStep
            && candidate.data?.budgetSource === "controller-policy"
            && candidate.data?.responsibility === undefined
            && Number.isSafeInteger(candidate.data?.effectiveMaxTokens)
          ))?.data
          : undefined;
        const controllerOutputTokens = controllerBudget ? rawControllerOutputTokens : undefined;
        if (controllerBudget && !events.some((candidate) => (
          candidate.type === "odai/controller-output-interrupted"
          && candidate.data?.turn === controllerBudget.turn
          && candidate.data?.step === controllerBudget.step
        ))) {
          appendEvent(owner, "odai/controller-output-interrupted", {
            turn: controllerBudget.turn,
            step: controllerBudget.step,
            reason: "max-tokens",
            configuredMaxTokens: controllerBudget.configuredMaxTokens,
            effectiveMaxTokens: controllerBudget.effectiveMaxTokens,
            ...(typeof controllerOutputTokens === "number" ? { outputTokens: controllerOutputTokens } : {}),
            budgetSource: "controller-policy",
            scope: "turn",
          });
        }
        if (stopped?.reason === "terminal-response"
          && Number.isSafeInteger(stopped.stopStep)
          && receipt?.step === stopped.stopStep
          && typeof observedOutputTokens === "number"
          && Number.isSafeInteger(observedOutputTokens)
          && isInPlaceResponsibility(receipt?.responsibility)
          && receipt.responsibility !== "reviewer"
          && receipt.requestedRoute) {
          const effectiveRoute = receipt.actualRoute ?? receipt.requestedRoute;
          appendEvent(owner, "odai/responsibility-interrupted", {
            scopeId: stopped.scopeId,
            turn: stopped.turn,
            step: stopped.stopStep ?? stopped.startStep,
            responsibility: receipt.responsibility,
            reason: "max-tokens",
            routeMode: receipt.routeMode,
            routeSource: receipt.routeSource,
            requestedRoute: receipt.requestedRoute,
            ...(effectiveRoute ? { effectiveRoute } : {}),
            ...(effectiveRoute?.maxTokens === undefined ? {} : { effectiveMaxTokens: effectiveRoute.maxTokens }),
            outputTokens: observedOutputTokens,
          });
        }
      }
      outputUsageBySession.delete(session);
    }

    const pendingRestoration = pendingScopeRestorations.get(session);
    if (pendingRestoration && event?.type === "turn/end" && event.data?.turn === pendingRestoration.turn) {
      appendEvent(pendingRestoration.agent, "odai/responsibility-scope-restored", {
        scopeId: pendingRestoration.scopeId,
        turn: pendingRestoration.turn,
        step: pendingRestoration.step,
        role: pendingRestoration.role,
        status: "unverified",
        requestedRoute: pendingRestoration.expectedRoute,
        stopReason: "no-effective-request",
      });
      pendingScopeRestorations.delete(session);
    }
    if (pendingRestoration
      && ["request/header", "assistant/chunk", "assistant/message"].includes(event?.type)
      && eventMatchesRequestPosition(pendingRestoration)) {
      let actualRoute;
      try {
        actualRoute = event.type === "request/header"
          ? routeFromConfig(event.data?.header?.config)
          : routeFromConfig(session.requestHeader?.()?.config);
      } catch {}
      if (actualRoute || event.type !== "request/header") {
        const mismatch = routeMismatchFor(pendingRestoration.expectedRoute, actualRoute, "base-route restoration");
        appendEvent(pendingRestoration.agent, "odai/responsibility-scope-restored", {
          scopeId: pendingRestoration.scopeId,
          turn: pendingRestoration.turn,
          step: pendingRestoration.step,
          role: pendingRestoration.role,
          status: mismatch ? "mismatch" : "applied",
          requestedRoute: pendingRestoration.expectedRoute,
          ...(actualRoute ? { actualRoute } : {}),
          ...(mismatch ? { error: mismatch } : {}),
        });
        if (mismatch) {
          protectController(
            pendingRestoration.agent,
            pendingRestoration.turn,
            pendingRestoration.step,
            { reasonCode: "RESPONSIBILITY_BASE_ROUTE_RESTORATION_MISMATCH" },
            "scope-restoration-mismatch",
            mismatch,
            pendingRestoration.scopeId,
          );
        }
        pendingScopeRestorations.delete(session);
      }
    }

    const pending = pendingRouteReceipts.get(session);
    if (!pending) return;
    if (event?.type === "turn/end" && event.data?.turn === pending.turn) {
      appendEvent(pending.agent, "odai/route-applied", {
        turn: pending.turn,
        step: pending.step,
        responsibility: pending.responsibility,
        ...(pending.responsibilityScopeId ? { responsibilityScopeId: pending.responsibilityScopeId } : {}),
        status: "unverified",
        routeMode: pending.routeMode,
        routeSource: pending.routeSource,
        fallbackUsed: true,
        requestedRoute: pending.requestedRoute,
        stopReason: "no-effective-request",
      });
      stopResponsibilityScope(pending.agent, "no-effective-request", {
        scopeId: pending.responsibilityScopeId,
        step: pending.step,
      });
      pendingRouteReceipts.delete(session);
      return;
    }
    if (!["request/header", "assistant/chunk", "assistant/message"].includes(event?.type)) return;
    if (!eventMatchesRequestPosition(pending)) return;
    let actualRoute;
    try {
      actualRoute = event.type === "request/header"
        ? routeFromConfig(event.data?.header?.config)
        : routeFromConfig(session.requestHeader?.()?.config);
    } catch {}
    if (!actualRoute && event.type === "request/header") return;
    const mismatch = routeMismatchFor(pending.expectedRoute, actualRoute, pending.routeMode);
    appendEvent(pending.agent, "odai/route-applied", {
      turn: pending.turn,
      step: pending.step,
      responsibility: pending.responsibility,
      ...(pending.responsibilityScopeId ? { responsibilityScopeId: pending.responsibilityScopeId } : {}),
      status: mismatch ? "mismatch" : "applied",
      routeMode: pending.routeMode,
      routeSource: pending.routeSource,
      fallbackUsed: Boolean(mismatch),
      requestedRoute: pending.requestedRoute,
      ...(actualRoute ? { actualRoute } : {}),
      ...(mismatch ? { stopReason: "route-mismatch", error: mismatch } : {}),
    });
    if (mismatch && pending.routeMode === "same-turn") {
      stopResponsibilityScope(pending.agent, "route-mismatch", {
        scopeId: pending.responsibilityScopeId,
        step: pending.step,
      });
    }
    if (!mismatch && pending.resumeOfScopeId) {
      appendEvent(pending.agent, "odai/responsibility-interruption-consumed", {
        scopeId: pending.resumeOfScopeId,
        turn: pending.turn,
        step: pending.step,
        responsibility: pending.responsibility,
        resumedScopeId: pending.responsibilityScopeId,
      });
    }
    pendingRouteReceipts.delete(session);
    if (mismatch && pending.routeMode === "same-turn") {
      protectController(
        pending.agent,
        pending.turn,
        pending.step,
        { reasonCode: `${pending.responsibility.toUpperCase()}_ROUTE_MISMATCH` },
        "route-mismatch",
        mismatch,
      );
    }
  });

  ctx.on("agent/turn-stopping", ({ agent, turn }: AgentTurnEvent) => {
    stopResponsibilityScope(agent, "turn-stopping");
    const role = routedRoleOf(agent);
    if (!role) return;
    const receipts = evidence.events(agent)
      .filter((event) => event.type === "odai/route-applied"
        && event.data?.turn === turn
        && event.data?.responsibility === role
        && event.data?.routeMode === "child")
      .map((event) => event.data);
    const failed = receipts.find((receipt) => receipt.status !== "applied");
    if (receipts.length > 0 && !failed) return;
    const detail = failed?.error ?? failed?.stopReason ?? "no verified child route receipt";
    throw new Error(`Odai ${role} child route was not verified: ${detail}`);
  });

  {
    const routedSteps = new WeakMap<DshAgent, Set<string>>();
    ctx.on("agent/pre-step", async (
      { agent, turn, step, signal }: AgentRequestEvent,
      next: () => Promise<StepResult>,
    ) => {
      const subagentSession = isSubagentSession(agent);
      if (!subagentSession) {
        if (step === 1) {
          stopResponsibilityScope(agent, "new-turn");
          routeProtections.delete(agent);
        }
        stopDanglingResponsibilityScope(agent, "runtime-resume");
      }
      let downstream = await next();
      if (downstream.kind === "reject" || signal.aborted) return downstream;
      const responsibilityGap = subagentSession ? undefined : pendingResponsibilityGap(agent, turn, step);
      const authenticatedDirectMessage = latestDirectUserMessage(agent, undefined, { turn });
      const suppliedDirectMessages = Array.isArray(downstream.messages)
        ? downstream.messages.filter((message) => message?.role === "user" && message?.source?.kind === "user")
        : [];
      const directMessage = latestDirectUserMessage(agent, suppliedDirectMessages, { turn });
      const authenticatedDirectText = authenticatedDirectMessage
        ? extractLatestUserText([authenticatedDirectMessage])
        : "";
      const responsibilityEvents = subagentSession ? [] : evidence.events(agent);
      const interruption = !subagentSession && step === 1
        ? pendingResponsibilityInterruption(responsibilityEvents)
        : undefined;
      let responsibilityContinuation;
      let interruptionNotice;
      if (interruption && authenticatedDirectMessage) {
        const disposition = classifyResponsibilityInterruptionText(authenticatedDirectText);
        if (disposition === "continue" && directMessage) {
          responsibilityContinuation = Object.freeze({ ...interruption, continuationText: authenticatedDirectText });
          appendEvent(agent, "odai/responsibility-interruption-resume-requested", {
            scopeId: interruption.scopeId,
            turn,
            step,
            responsibility: interruption.responsibility,
          });
        } else if (disposition === "preserve") {
          if (directMessage) {
            interruptionNotice = pluginMessage(
              renderOutputLimitInterruptionNotice(interruption),
              `odai verified ${interruption.responsibility} output-limit interruption`,
            );
          }
          appendEvent(agent, "odai/responsibility-interruption-preserved", {
            scopeId: interruption.scopeId,
            turn,
            step,
            responsibility: interruption.responsibility,
            reason: "output-limit-diagnostic",
          });
        } else if (disposition === "clear") {
          appendEvent(agent, "odai/responsibility-interruption-cleared", {
            scopeId: interruption.scopeId,
            turn,
            step,
            responsibility: interruption.responsibility,
            reason: "superseded-by-user-task",
          });
        }
      }
      if (interruptionNotice) {
        downstream = { ...downstream, messages: [...downstream.messages, interruptionNotice] };
      }
      if (subagentSession) return downstream;
      if (step !== 1 && !responsibilityGap) return downstream;

      if (step === 1 && claimSemanticMemoryTurn(agent, turn, step)) {
        const settings = memorySettingsFor(agent, turn);
        const message = directMessage;
        const query = extractRoutingText(downstream.messages, sessionEvents(agent?.session)).slice(0, config.routing.maxInputChars);
        let retrieved: readonly SemanticMemorySummary[] = [];
        let captured: readonly UnknownRecord[] = [];
        let error;
        if (settings.mode === "auto" && message) {
          try {
            retrieved = retrieveSemanticMemories({
              storePath: config.memory.storePath,
              query,
              cwd: agent?.session?.header?.cwd,
              limit: config.memory.maxRetrieved,
            });
            captured = captureAutomaticMemories({
              storePath: config.memory.storePath,
              mode: settings.mode,
              agent,
              message,
              turn,
              cwd: agent?.session?.header?.cwd,
            });
          } catch (memoryError) {
            error = memoryError instanceof Error ? memoryError.message : String(memoryError);
            logger.warn(`Odai semantic memory processing failed closed for this turn: ${error}`);
            retrieved = [];
            captured = [];
          }
        }
        const captureEvidence = captured.filter((result) => result.changed);
        if (retrieved.length > 0 || captureEvidence.length > 0 || error) {
          appendEvent(agent, "odai/memory-processed", {
            turn,
            step,
            mode: settings.mode,
            source: settings.source,
            retrievedIds: retrieved.map((entry) => entry.id),
            captures: captureEvidence.map((result) => ({
              changed: true,
              reasonCode: result.reasonCode,
              ...(result.id ? { id: result.id } : {}),
              ...(result.status ? { status: result.status } : {}),
              ...(result.scope ? { scope: result.scope } : {}),
            })),
            ...(error ? { status: "fallback", error: "memory-store-unavailable" } : { status: "completed" }),
          });
        }
        const packet = renderSemanticMemoryPacket(retrieved);
        if (packet) {
          downstream = {
            ...downstream,
            messages: [...downstream.messages, memoryPacketMessage(packet)],
          };
        }
      }

      if (config.routing.mode === "off") return downstream;
      if (hasSessionEvent(agent, "odai/route-decided", (data) => data?.turn === turn && data?.step === step)) {
        return downstream;
      }

      let routed = routedSteps.get(agent);
      if (!routed) {
        routed = new Set();
        routedSteps.set(agent, routed);
      }
      const routeKey = `${turn}:${step}`;
      if (routed.has(routeKey)) return downstream;
      routed.add(routeKey);

      const taskText = extractRoutingText(downstream.messages, sessionEvents(agent?.session)).slice(0, config.routing.maxInputChars);
      let routedDownstream = downstream;
      let researchPacketText = "";
      let sameTurnResearchDecision: RouteDecision | undefined;
      const researchDecision = decideResearchPrefetch({ text: taskText, proposal: responsibilityGap });
      if (researchDecision.action === "delegate") {
        appendEvent(agent, "odai/research-decided", {
          turn,
          step,
          role: "researcher",
          action: "delegate",
          mode: config.routing.mode,
          reasonCode: researchDecision.reasonCode,
          signals: researchDecision.signals,
        });
        if (config.routing.mode === "observe") {
          appendEvent(agent, "odai/research-result", {
            turn,
            step,
            role: "researcher",
            status: "observed",
            stopReason: "observe-mode",
          });
        } else {
          const researchState = configuredRole(agent, "researcher", turn);
          const researchRoute = researchState.route;
          if (!researchRoute) {
            appendEvent(agent, "odai/research-result", {
              turn,
              step,
              role: "researcher",
              status: "fallback",
              stopReason: researchState.error ? "route-config-invalid" : "route-config-missing",
              ...(researchState.error ? { error: researchState.detail } : {}),
            });
          } else if (effectiveRoleDispatch("researcher", researchState.dispatch, config.routing.mode) === "same-turn") {
            sameTurnResearchDecision = Object.freeze({
              ...researchDecision,
              role: "controller",
              mode: "upgrade",
              action: "upgrade",
              targetRole: "researcher",
            });
          } else {
            const researchBundle = sharedSkillSelection<SkillSelection>(agent, turn)?.bundle ?? bundled;
            const researchContract = dshRoleContract(
              "researcher",
              researchBundle.roleContracts.researcher,
              researchBundle.referenceContracts,
            );
            const subagents = isSubagentsService(ctx.subagents) ? ctx.subagents : undefined;
            const result: Readonly<RoutedRoleOutcome> = subagents
              ? await runRoutedRole({
                  subagents,
                  provider: config.routing.provider,
                  decision: researchDecision,
                  taskText: renderResearchTaskContract(taskText),
                  roleContract: researchContract,
                  agent,
                  signal,
                  roleRoute: researchRoute,
                })
              : Object.freeze({
                  status: "fallback",
                  stopReason: "infrastructure-error",
                  output: [],
                  error: "dsh subagents service unavailable",
                });
            let packet;
            let packetError;
            if (result.status === "completed") {
              try {
                packet = verifyResearchPacketSources(
                  parseResearchPacket(outputText(result.output)),
                  agent?.session?.header?.cwd,
                );
              } catch (error) {
                packetError = error instanceof Error ? error.message : String(error);
              }
            }
            const completed = result.status === "completed" && packet !== undefined;
            appendEvent(agent, "odai/research-result", {
              turn,
              step,
              role: "researcher",
              status: completed ? "completed" : "fallback",
              stopReason: completed ? result.stopReason : (packetError ? "packet-invalid" : result.stopReason),
              routeSource: researchState.source,
              fallbackUsed: !completed,
              routeReceiptStatus: result.routeReceiptStatus,
              requestedRoute: researchRoute,
              ...(result.routeReceiptError ? { routeReceiptError: result.routeReceiptError } : {}),
              ...(result.actualRoute ? { actualRoute: result.actualRoute } : {}),
              ...(packet ? { packetDigest: packet.digest, sourceCount: packet.sourceCount } : {}),
              ...(packetError ? { error: packetError } : result.taskError ? { error: result.taskError } : {}),
            });
            if (completed && packet) {
              researchPacketText = renderResearchPacket(packet);
              routedDownstream = {
                ...downstream,
                messages: [
                  ...routedDownstream.messages,
                  pluginMessage(
                    researchPacketText,
                    `odai completed researcher evidence compression (${packet.sourceCount} sources)`,
                  ),
                ],
              };
            }
          }
        }
      }

      let decision = sameTurnResearchDecision ?? decideRoute({
        text: taskText,
        proposal: responsibilityGap,
        interruption: responsibilityContinuation,
      });
      let routeRole = decision.targetRole ?? decision.role;
      const responsibilityTaskText = responsibilityGap?.responsibility === routeRole
        ? [
            "# Evidence-grounded responsibility gap",
            JSON.stringify({
              responsibility: responsibilityGap.responsibility,
              gap: responsibilityGap.gap,
              expectedChange: responsibilityGap.expectedChange,
              evidenceRefs: responsibilityGap.evidenceRefs,
            }, undefined, 2),
            "",
            "# Direct user task",
            taskText,
          ].join("\n")
        : taskText;
      const roleTaskText = researchPacketText ? `${responsibilityTaskText}\n\n${researchPacketText}` : responsibilityTaskText;
      let roleContext = decision.action === "direct"
        ? undefined
        : buildRoleContextPacket(agent, routeRole, roleTaskText, {
            ...(responsibilityGap?.requirements ? { requirements: responsibilityGap.requirements } : {}),
          });
      const reviewerAlreadyDeferred = responsibilityGap?.responsibility === "reviewer"
        && hasReviewerDeferral(evidence.events(agent), responsibilityGap.stateDigest);
      let localReviewerCoverage;
      if (config.routing.mode === "auto"
        && routeRole === "reviewer"
        && decision.action === "delegate"
        && effectiveRoleDispatch("reviewer", configuredRole(agent, "reviewer", turn).dispatch, config.routing.mode) === "child"
        && roleContext
        && !roleContext.sufficient) {
        localReviewerCoverage = roleContext.coverage;
        decision = Object.freeze({
          ...decision,
          role: "controller",
          mode: "direct",
          action: "direct",
          targetRole: "reviewer",
          signals: Object.freeze([...decision.signals, "review-evidence-packet-missing", "controller-local-review"]),
        });
        routeRole = "reviewer";
      }
      const reviewerCanAwaitEvidence = config.routing.mode === "auto"
        || (config.routing.mode === "execute"
          && Boolean(routeRole === "reviewer" ? configuredRole(agent, routeRole, turn).route : undefined));
      const reviewerEvidenceIncomplete = routeRole === "reviewer" && roleContext !== undefined
        && !roleContext.sufficient && reviewerCanAwaitEvidence;
      const reviewerDeferralAlreadyReported = reviewerEvidenceIncomplete && reviewerAlreadyDeferred;
      appendEvent(agent, "odai/route-decided", {
        turn,
        step,
        role: decision.role,
        action: decision.action,
        ...(decision.targetRole ? { targetRole: decision.targetRole } : {}),
        mode: config.routing.mode,
        reasonCode: decision.reasonCode,
        signals: decision.signals,
        ...(responsibilityGap ? {
          stateDigest: responsibilityGap.stateDigest,
          gap: responsibilityGap.gap,
          evidenceRefs: responsibilityGap.evidenceRefs,
          expectedChange: responsibilityGap.expectedChange,
        } : {}),
        ...(decision.considerations ? { considerations: decision.considerations } : {}),
      });
      if (responsibilityGap && !reviewerEvidenceIncomplete) {
        appendEvent(agent, "odai/responsibility-gap-consumed", {
          turn,
          step,
          responsibility: responsibilityGap.responsibility,
          stateDigest: responsibilityGap.stateDigest,
          routeAction: decision.action,
          reasonCode: decision.reasonCode,
        });
      }

      if (decision.action === "direct") {
        if (!localReviewerCoverage) return routedDownstream;
        if (!roleContext) throw new Error("reviewer fallback is missing its context packet");
        if (reviewerDeferralAlreadyReported) return routedDownstream;
        appendEvent(agent, "odai/route-context", {
          turn,
          step,
          role: "reviewer",
          mode: "controller-local",
          digest: roleContext.digest,
          evidenceDigest: roleContext.evidenceDigest,
          evidenceCount: roleContext.evidenceCount,
          toolEvidenceCount: roleContext.toolEvidenceCount,
          acceptanceCount: localReviewerCoverage.acceptanceCount,
          diffCount: localReviewerCoverage.diffCount,
          testCount: localReviewerCoverage.testCount,
          checkCount: localReviewerCoverage.checkCount,
          diagnostics: roleContext.diagnostics,
          truncated: roleContext.truncated,
          sufficient: false,
        });
        appendEvent(agent, "odai/route-result", {
          turn,
          step,
          role: "reviewer",
          action: "direct",
          status: "fallback",
          stopReason: "evidence-packet-missing",
          independent: false,
        });
        if (responsibilityGap?.responsibility === "reviewer") {
          appendEvent(agent, "odai/responsibility-gap-deferred", {
            turn,
            step,
            responsibility: "reviewer",
            stateDigest: responsibilityGap.stateDigest,
            contextDigest: roleContext.digest,
            evidenceDigest: roleContext.evidenceDigest,
            reasonCode: "REVIEWER_EVIDENCE_PACKET_PENDING",
          });
        }
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              [
                `An independent reviewer was not started because the bounded packet is incomplete (${JSON.stringify(localReviewerCoverage)}).`,
                `Evidence diagnostics: ${JSON.stringify(roleContext.diagnostics)}.`,
                responsibilityGap?.responsibility === "reviewer"
                  ? "The recorded reviewer gap remains pending and will be reassessed once new acceptance, write, diff, test, check, failure, or host-evidence diagnostics change the evidence state; do not resubmit it unchanged."
                  : "Gather project-available acceptance, diff, tests or read-only checks, and matching native tool evidence before submitting a reviewer gap.",
                "Remain on the current controller route only to gather or fix that evidence. A controller-local read-only check is not independent acceptance; do not claim reviewer approval or release on its basis.",
              ].join("\n"),
              "odai reviewer evidence is incomplete; controller continues locally",
            ),
          ],
        };
      }

      if (config.routing.mode === "observe") {
        if (requiresFailClosedProtection(decision)) {
          protectController(agent, turn, step, decision, "observe");
        }
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              renderRouteNotice(decision, "observe"),
              `odai observed ${routeRole} gap (${decision.reasonCode})`,
            ),
          ],
        };
      }

      const roleState = configuredRole(agent, routeRole, turn);
      const roleRoute = roleState.route;
      if (!roleRoute) {
        const invalidConfig = Boolean(roleState.error);
        appendEvent(agent, "odai/route-config-missing", {
          turn,
          step,
          role: routeRole,
          action: decision.action,
          mode: config.routing.mode,
          status: invalidConfig ? "invalid" : "unconfigured",
          ...(invalidConfig ? { error: roleState.detail } : {}),
        });
        if (requiresFailClosedProtection(decision)) {
          protectController(
            agent,
            turn,
            step,
            decision,
            invalidConfig ? "route-config-invalid" : "route-config-missing",
          );
        }
        if (routeRole === "frontend") return routedDownstream;
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              renderMissingRouteConfigNotice(decision, config.routing.mode, roleState.error),
              `odai ${routeRole} route is ${invalidConfig ? "invalid" : "not configured"}`,
            ),
          ],
        };
      }

      const roleBundle = sharedSkillSelection<SkillSelection>(agent, turn)?.bundle ?? bundled;
      const canonicalRoleContract = roleBundle.roleContracts[routeRole];
      const roleContract = dshRoleContract(routeRole, canonicalRoleContract, roleBundle.referenceContracts);
      let rolePreflightVerified = false;
      if (routeRole === "frontend" && decision.action === "upgrade") {
        const health = await probeModelRoute(
          (candidate: ModelRoute, candidateSignal?: AbortSignal) => ctx.llm.resolveCallConfig(candidate, candidateSignal),
          roleRoute,
          signal,
        );
        if (health.status === "rejected") {
          const invalidation = invalidateFailedRoleRoute(
            agent,
            routeRole,
            roleRoute,
            roleState.source,
            health.failure,
            { turn, step, position: "pre-step" },
          );
          appendEvent(agent, "odai/route-result", {
            turn,
            step,
            role: routeRole,
            action: "upgrade",
            status: "fallback",
            stopReason: "route-preflight-failed",
            routeSource: roleState.source,
            fallbackUsed: true,
            requestedRoute: roleRoute,
            failureKind: health.failure.kind,
            error: health.failure.message,
            invalidated: invalidation.invalidated,
          });
          return {
            kind: "enter",
            messages: [
              ...routedDownstream.messages,
              pluginMessage(
                [
                  `The configured frontend route failed preflight (${health.failure.kind}: ${health.failure.message}).`,
                  "Continue locally as the current controller for this turn using the canonical frontend and craft contract below. Do not claim the configured frontend responsibility ran; no routed receipt exists.",
                  "",
                  "frontend local-fallback responsibility contract:",
                  roleContract,
                ].join("\n"),
                "odai frontend route unavailable; explicit local fallback",
              ),
            ],
          };
        }
        rolePreflightVerified = health.status === "verified";
      }
      roleContext ??= buildRoleContextPacket(agent, routeRole, roleTaskText, {
        ...(responsibilityGap?.requirements ? { requirements: responsibilityGap.requirements } : {}),
      });
      const roleDispatch = effectiveRoleDispatch(routeRole, roleState.dispatch, config.routing.mode);
      const inPlaceUpgrade = roleDispatch === "same-turn";
      const contextMode = inPlaceUpgrade ? "same-turn" : "bounded-packet";
      appendEvent(agent, "odai/route-context", {
        turn,
        step,
        role: routeRole,
        mode: contextMode,
        digest: roleContext.digest,
        evidenceDigest: roleContext.evidenceDigest,
        evidenceCount: roleContext.evidenceCount,
        toolEvidenceCount: roleContext.toolEvidenceCount,
        requirementDecisionCount: roleContext.coverage.requirementDecisionCount,
        activeRequirementCount: roleContext.coverage.activeRequirementCount,
        supersededRequirementCount: roleContext.coverage.supersededRequirementCount,
        requirementProvenance: roleContext.coverage.requirementProvenance,
        acceptanceCount: roleContext.coverage.acceptanceCount,
        diffCount: roleContext.coverage.diffCount,
        testCount: roleContext.coverage.testCount,
        checkCount: roleContext.coverage.checkCount,
        diagnostics: roleContext.diagnostics,
        truncated: roleContext.truncated,
        sufficient: roleContext.sufficient,
      });

      if (routeRole === "reviewer" && roleDispatch === "child" && decision.action === "delegate" && !roleContext.sufficient) {
        if (reviewerDeferralAlreadyReported) return routedDownstream;
        appendEvent(agent, "odai/route-result", {
          turn,
          step,
          role: "reviewer",
          action: "delegate",
          status: "fallback",
          stopReason: "evidence-packet-missing",
          contextDigest: roleContext.digest,
        });
        if (responsibilityGap?.responsibility === "reviewer") {
          appendEvent(agent, "odai/responsibility-gap-deferred", {
            turn,
            step,
            responsibility: "reviewer",
            stateDigest: responsibilityGap.stateDigest,
            contextDigest: roleContext.digest,
            evidenceDigest: roleContext.evidenceDigest,
            reasonCode: "REVIEWER_EVIDENCE_PACKET_PENDING",
          });
        }
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              [
                `odai reviewer child was not started because the bounded packet is incomplete (${JSON.stringify(roleContext.coverage)}).`,
                `Evidence diagnostics: ${JSON.stringify(roleContext.diagnostics)}.`,
                responsibilityGap?.responsibility === "reviewer"
                  ? "The recorded reviewer gap remains pending for reassessment after the evidence state changes; do not resubmit it unchanged."
                  : "Gather acceptance, an actual patch diff, successful tests or read-only checks, and matching native tool evidence before submitting a reviewer gap.",
                "Do not claim independent acceptance.",
              ].join("\n"),
              "odai reviewer evidence packet is incomplete",
            ),
          ],
        };
      }

      if (inPlaceUpgrade) {
        if (!isInPlaceResponsibility(routeRole)) throw new Error(`unsupported in-place responsibility: ${routeRole}`);
        stopResponsibilityScope(agent, "superseded", { step });
        const responsibilityScope = createResponsibilityScope({
          turn,
          startStep: step,
          role: routeRole,
          route: roleRoute,
          source: roleState.source,
          decision,
          routeValidated: rolePreflightVerified,
          ...(responsibilityContinuation ? { resumeOfScopeId: responsibilityContinuation.scopeId } : {}),
        });
        responsibilityScopes.set(agent, responsibilityScope);
        if (agent?.session) responsibilityScopeOwners.set(agent.session, agent);
        appendEvent(agent, "odai/responsibility-scope-started", responsibilityScopeStartedEvent(responsibilityScope));
        if (["researcher", "planner", "reviewer"].includes(routeRole)) {
          protectController(agent, turn, step, decision, `responsibility-scope-${routeRole}`, undefined, responsibilityScope.id);
        }
        appendEvent(agent, "odai/route-upgrade", {
          turn,
          step,
          role: decision.role,
          targetRole: routeRole,
          status: "requested",
          responsibilityScopeId: responsibilityScope.id,
          ...(responsibilityContinuation ? { resumeOfScopeId: responsibilityContinuation.scopeId } : {}),
          continuationPolicy: responsibilityScope.continuationPolicy,
          stopPolicy: responsibilityScope.stopPolicy,
          routeSource: roleState.source,
          requestedRoute: roleRoute,
          contextDigest: roleContext.digest,
          contextMode,
          ...(routeRole === "reviewer" ? { independent: false } : {}),
        });
        const contextBoundary = routeRole === "reviewer"
          ? `The bounded packet is not independently reviewable (${JSON.stringify(roleContext.coverage)}). Perform a same-turn read-only check and do not claim independent acceptance.`
          : "Retain the current controller conversation and workspace context; do not reconstruct it through a child handoff.";
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              [
                renderRouteNotice(decision, config.routing.mode, roleRoute, roleDispatch),
                "",
                `Context digest: sha256:${roleContext.digest}`,
                contextBoundary,
                "",
                `${routeRole} responsibility contract:`,
                roleContract,
              ].join("\n"),
              `odai upgraded controller route (${decision.reasonCode})`,
            ),
          ],
        };
      }

      const delegationDecision = decision.role === routeRole
        ? decision
        : Object.freeze({ ...decision, role: routeRole, mode: "delegate", action: "delegate" });
      const subagents = isSubagentsService(ctx.subagents) ? ctx.subagents : undefined;
      const result: Readonly<RoutedRoleOutcome> = subagents
        ? await runRoutedRole({
            subagents,
            provider: config.routing.provider,
            decision: delegationDecision,
            taskText: renderRoleContextPacket(roleContext),
            roleContract,
            agent,
            signal,
            roleRoute,
          })
        : Object.freeze({
            status: "fallback",
            stopReason: "infrastructure-error",
            output: [],
            error: "dsh subagents service unavailable",
          });
      appendEvent(agent, "odai/route-result", {
        turn,
        step,
        role: routeRole,
        action: "delegate",
        status: result.status,
        stopReason: result.stopReason,
        routeSource: roleState.source,
        fallbackUsed: result.status !== "completed",
        routeReceiptStatus: result.routeReceiptStatus,
        requestedRoute: roleRoute,
        contextDigest: roleContext.digest,
        ...(result.routeReceiptError ? { routeReceiptError: result.routeReceiptError } : {}),
        ...(result.actualRoute ? { actualRoute: result.actualRoute } : {}),
        ...(result.taskError ? { error: result.taskError } : {}),
      });

      if (result.status === "completed") {
        const childText = outputText(result.output);
        const heading = renderRouteNotice(delegationDecision, config.routing.mode, result.actualRoute);
        return {
          kind: "enter",
          messages: [
            ...routedDownstream.messages,
            pluginMessage(
              childText ? `${heading}\ncontext digest: sha256:${roleContext.digest}\n\n${routeRole} output:\n${childText}` : heading,
              `odai completed ${routeRole} route`,
              result.output.filter((block) => block?.type !== "text"),
            ),
          ],
        };
      }

      const failure = result.error ?? result.stopReason;
      if (requiresFailClosedProtection(delegationDecision)) {
        protectController(agent, turn, step, delegationDecision, "route-failure", failure);
      }
      return {
        kind: "enter",
        messages: [
          ...routedDownstream.messages,
          pluginMessage(
            renderRouteFailureNotice(delegationDecision, failure),
            requiresFailClosedProtection(delegationDecision)
              ? `odai blocked high-impact ${routeRole} fallback`
              : `odai fell back from ${routeRole} route`,
          ),
        ],
      };
    }, { prepend: true });
  }


}
