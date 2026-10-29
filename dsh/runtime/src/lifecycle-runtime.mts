import { recognizeLeadSwitch, leadState, leadTaskId, leadGap, parseLeadVerdict } from "./lead-mode.mjs";

import {
  classifyResponsibilityInterruptionText,
  decideResearchPrefetch,
  decideRoute,
  extractLatestUserText,
  extractRoutingText,
  renderMissingRouteConfigNotice,
  renderRouteFailureNotice,
  renderRouteNotice,
} from "./router.mjs";
import type { RouteDecision } from "./router.mjs";
import { recognizeNamedRequests, resolveResponsibilityGap } from "./responsibility-gap.mjs";
import type { ResponsibilityGapProposal, Responsibility } from "./responsibility-gap.mjs";
import { CONFIGURABLE_ROLES } from "./routing-config.mjs";
import { classifyPendingReviewerText } from "./router.mjs";
import { classifyModelRouteFailure, probeModelRoute } from "./model-route.mjs";
import { selectSharedOutputPolicyForTurn } from "./output-policy-state.mjs";
import { prepareSessionOutputControl, previewSessionOutputControl } from "./output-session.mjs";
import type { SessionOutputSelection } from "./output-session.mjs";
import {
  isSubagentSession, isManagedRoleChild, outputText, pluginMessage,
  renderOutputLimitInterruptionNotice, renderResearchTaskContract, routeFromConfig,
  routeMismatchFor, routedRoleOf, runRoutedRole, sameRequestModelRoute,
} from "./runtime-support.mjs";
import type { RoutedRoleOutcome, SubagentsService } from "./runtime-support.mjs";
import {
  latestStoppedResponsibilityScope,
  pendingResponsibilityInterruption,
  pendingResponsibilityScopeRestoration,
  responsibilityScopeOwnsRequest,
  responsibilityScopeStopReason,
} from "./responsibility-scope.mjs";
import type { InPlaceResponsibility, ResponsibilityScopeOwner } from "./responsibility-scope.mjs";
export type { ResponsibilityScope } from "./responsibility-scope.mjs";
import { buildRoleContextPacket, renderRoleContextPacket, reviewEvidenceSnapshot } from "./routing-context.mjs";
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
  currentDirectInput,
  invalidateNativeDirectInput,
  observeNativeDirectInput,
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

const DIRECT_USER_TASK_HEADING = "\n# Direct user task";

interface AgentRequestEvent { agent: DshAgent; turn: number; step: number; signal: AbortSignal }
interface AgentRequestErrorEvent extends AgentRequestEvent { provider: string; failure: UnknownRecord }
interface AgentTurnEvent { agent: DshAgent; turn: number }
interface RequestOptions extends UnknownRecord {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  messages?: readonly DshMessage[];
}
interface StepResult extends UnknownRecord { kind: string; messages: readonly DshMessage[] }
interface RouteFailure { kind: string; code: string; message: string }
interface RoleState { route?: ModelRoute; source?: string; dispatch?: ResponsibilityDispatch; dispatchSource?: string; error?: string; detail?: string; id?: string; baseRoute?: ModelRoute }
export interface RouteProtection extends UnknownRecord { scopeId?: string }

function effectiveRoleDispatch(
  role: string,
  configured: ResponsibilityDispatch | undefined,
  routingMode: RuntimeConfig["routing"]["mode"],
): ResponsibilityDispatch {
  if (role === "creative" || role === "writer") return "child";
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
  refreshExecutionSurface(agent: DshAgent): Promise<void>;
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
  pendingResponsibilityGap(agent: DshAgent, turn: number | undefined, step: number): ResponsibilityGapProposal | undefined;
  responsibilityScopes: ResponsibilityScopeOwner;
  routeProtections: WeakMap<DshAgent, RouteProtection>;
  selectOutputForAgent(agent?: DshAgent, turn?: number): SessionOutputSelection;
}

export function installLifecycleRuntime(deps: LifecycleDependencies): void {
  const { appendEvent, bundled, config, configuredRole, ctx, evidence, hasSessionEvent, invalidateFailedRoleRoute, logger, memorySettingsFor, pendingResponsibilityGap, responsibilityScopes, routeProtections, selectOutputForAgent } = deps;
  const { stop: stopResponsibilityScope, stopDangling: stopDanglingResponsibilityScope } = responsibilityScopes;
  const pendingRouteReceipts = new WeakMap<DshSession, PendingRouteReceipt>();
  const pendingScopeRestorations = new WeakMap<DshSession, PendingRestoration>();
  const outputUsageBySession = new WeakMap<DshSession, OutputUsage>();
  const inputRequests = new WeakMap<DshAgent, { token: object; turn: number; signal: AbortSignal }>();
  const inputGuards = new WeakSet<DshAgent>();
  const namedGaps = (agent: DshAgent) => evidence.events(agent).filter(event => event.type === "odai/responsibility-gap" && event.data.userNamed === true);
  const gapConsumed = (agent: DshAgent, digest: unknown) => evidence.events(agent).some(event => event.type === "odai/responsibility-gap-consumed" && event.data.stateDigest === digest);
  const promptNamedRequests = ({ agent, turn, signal }: AgentTurnEvent & { signal: AbortSignal }) => {
    if (signal.aborted || isSubagentSession(agent) || config.routing.mode === "off" || namedGaps(agent).length === 0) return;
    pendingResponsibilityGap(agent, turn, Number.MAX_SAFE_INTEGER);
    const events = evidence.events(agent);
    const prompts: string[] = [];
    for (const { data } of namedGaps(agent).sort((left, right) => Number(left.data.timing === "completion") - Number(right.data.timing === "completion"))) {
      if (gapConsumed(agent, data.stateDigest)) continue;
      const message = latestDirectUserMessage(agent);
      if (!message || (message.id !== data.taskMessageId && classifyPendingReviewerText(extractLatestUserText([message])) !== "continue")) {
        appendEvent(agent, "odai/responsibility-gap-consumed", { turn, stateDigest: data.stateDigest, responsibility: data.responsibility, reason: "SUPERSEDED_BY_DIRECT_USER_TASK" });
        continue;
      }
      const step = agent.phase?.step ?? sessionEvents(agent.session).findLast(event => event.type === "step/start")?.data.step ?? 0;
      const prompted = events.find(event => event.type === "odai/named-request-prompted" && event.data.stateDigest === data.stateDigest);
      if (prompted) {
        // Coexisting Plugin/Agent listeners can observe the same stop. Only a
        // later native step may conclude that the one reminder was ineffective.
        if (prompted.data.turn === turn && prompted.data.step === step) return;
        appendEvent(agent, "odai/responsibility-gap-consumed", { turn, step, stateDigest: data.stateDigest, responsibility: data.responsibility, reason: "NAMED_REQUEST_INCOMPLETE_AFTER_PROMPT" });
        continue;
      }
      appendEvent(agent, "odai/named-request-prompted", { turn, step, stateDigest: data.stateDigest, responsibility: data.responsibility });
      prompts.push(String(data.responsibility));
      break;
    }
    if (prompts.length && !signal.aborted) agent.steer?.(pluginMessage(`用户点名尚待运行：${prompts.join("、")}。运行时将在下一步按顺序派发；不要重复提交同项。最终答复逐项说明实际模型与结果，未完成时说明原因，不替换模型或配置。`, "odai named responsibility request"));
  };
  const checkedNamedInputs = new WeakMap<DshAgent, Set<string>>();
  const recognizeDirectNames = (agent: DshAgent, turn: number, step: number, message: DshMessage | undefined): DshMessage | undefined => {
    if (!message?.id || isSubagentSession(agent) || config.routing.mode === "off" || checkedNamedInputs.get(agent)?.has(message.id) || hasSessionEvent(agent, "odai/named-input-checked", data => data.taskMessageId === message.id)) return;
    let checked = checkedNamedInputs.get(agent);
    if (!checked) { checked = new Set(); checkedNamedInputs.set(agent, checked); }
    checked.add(message.id);
    const text = extractLatestUserText([message]);
    const routes: Partial<Record<Responsibility, ModelRoute>> = {};
    for (const role of CONFIGURABLE_ROLES) { const route = configuredRole(agent, role, turn).route; if (route) routes[role] = route; }
    const change = recognizeLeadSwitch(text, {
      ...(routes.planner ? { planner: routes.planner } : {}),
      ...(routes.reviewer ? { reviewer: routes.reviewer } : {}),
    });
    if (change && !hasSessionEvent(agent, "odai/lead-switch-checked", data => data.taskMessageId === message.id)) {
      appendEvent(agent, "odai/lead-switch-checked", { taskMessageId: message.id });
      if (!change.issue) {
        appendEvent(agent, "odai/lead-mode", { taskMessageId: message.id, ...change });
        if (!change.enabled) for (const event of namedGaps(agent)) if (event.data.source === "lead-mode" && !gapConsumed(agent, event.data.stateDigest)) appendEvent(agent, "odai/responsibility-gap-consumed", { stateDigest: event.data.stateDigest, reason: "LEAD_MODE_DISABLED" });
      }
      agent.inject?.(pluginMessage(`主导模式：${change.issue ?? (change.enabled ? "已开启" : "已关闭")}。规划与审查插槽：${JSON.stringify(Object.fromEntries(change.roles.map(role => [role, routes[role as Responsibility] ?? "继承当前会话模型"])))}。未启用的插槽不调用；关闭说“关闭主导模式”。请向用户说明。`, "odai lead mode"));
    }
    const taskMessageId = leadTaskId(evidence.events(agent), message.id, classifyPendingReviewerText(text) === "continue");
    if (leadState(evidence.events(agent))?.enabled && !hasSessionEvent(agent, "odai/lead-task", data => data.taskMessageId === taskMessageId)) appendEvent(agent, "odai/lead-task", { taskMessageId });
    const requests = recognizeNamedRequests(text, routes);
    if (requests.length) appendEvent(agent, "odai/named-input-checked", { turn, step, taskMessageId: message.id });
    const notices: string[] = [];
    for (const request of requests) {
      if (request.canceled) {
        for (const { data } of namedGaps(agent)) if (data.responsibility === request.responsibility && !gapConsumed(agent, data.stateDigest)) appendEvent(agent, "odai/responsibility-gap-consumed", { turn, step, responsibility: data.responsibility, stateDigest: data.stateDigest, reason: "CANCELED_BY_USER" });
        continue;
      }
      if (request.issue) {
        appendEvent(agent, "odai/named-request-unfulfilled", { turn, step, taskMessageId: message.id, ...request, configuredRoute: routes[request.responsibility] });
        notices.push(`${request.responsibility}（${request.name}）：${request.issue}；当前映射 ${JSON.stringify(routes[request.responsibility] ?? null)}`);
        if (request.issue === "unconfigured") {
          const proposal = resolveResponsibilityGap({ responsibility: request.responsibility, gap: request.excerpt, evidenceRefs: [`user-message:${message.id}`], expectedChange: "完成用户点名职责" });
          notices.push(renderMissingRouteConfigNotice(decideRoute({ text, proposal, writerConfigured: true, creativeConfigured: true }), config.routing.mode));
        }
        continue;
      }
      const proposal = resolveResponsibilityGap({ responsibility: request.responsibility, gap: `用户明确点名：${request.excerpt}`, evidenceRefs: [`user-message:${message.id}`], expectedChange: `按用户指定的${request.timing}时机完成该职责并回交` });
      appendEvent(agent, "odai/responsibility-gap", { ...proposal, stateDigest: `user-named:${proposal.stateDigest}:${message.id}:${request.timing}`, taskMessageId: message.id, turn, step: step - 1, userNamed: true, timing: request.timing, sourceExcerpt: request.excerpt, requestedName: request.name, requestedRoute: routes[request.responsibility] });
      notices.push(`${request.responsibility}：${request.timing === "start" ? "开始时" : "完成时"}`);
    }
    return notices.length ? pluginMessage(`用户点名：${notices.join("；")}。由运行时负责按顺序派发；总控不要自己再派同一项。最终答复必须逐项说明哪个实际模型做了什么，以及未完成的原因；不得替换职责、模型或修改配置。`, "odai user named responsibilities") : undefined;
  };
  ctx.on("agent/inbox/claimed", ({ agent, turn, message }: { agent: DshAgent; turn: number; message: DshMessage }) => {
    if (isSubagentSession(agent) || typeof agent.ctx?.on !== "function" || !agent.session.id) return;
    if (!inputGuards.has(agent)) {
      agent.ctx.on("llm/stream", (options: UnknownRecord, next: () => unknown) => {
        const expected = inputRequests.get(agent);
        if (!expected || options.sessionId !== agent.session.id || options.purpose === "compaction") return next();
        const committed = currentDirectInput(agent, { turn: expected.turn, signal: expected.signal });
        if (!committed || committed.token !== expected.token) {
          invalidateNativeDirectInput(agent);
          throw new DOMException("ODAI_INPUT_NOT_COMMITTED: claimed input changed or was canceled before model dispatch", "AbortError");
        }
        return next();
      });
      inputGuards.add(agent);
    }
    responsibilityScopes.bindOwner(agent);
    observeNativeDirectInput(agent, turn, message);
  });
  ctx.on("agent/disposed", ({ agent }: { agent: DshAgent }) => {
    invalidateNativeDirectInput(agent, true);
    inputRequests.delete(agent);
  });
  ctx.on("agent/request", async (
    { agent, turn, step, signal }: AgentRequestEvent,
    next: () => Promise<RequestOptions>,
  ) => {
    const input = currentDirectInput(agent, { turn, signal, minimum: "claimed" });
    if (input?.phase === "claimed" && input.token) inputRequests.set(agent, { token: input.token, turn, signal });
    else inputRequests.delete(agent);
    let proposed = await next();
    if (responsibilityScopes.isOwnedElsewhere(agent)) return proposed;
    const childRole = routedRoleOf(agent);
    if (!childRole && !isSubagentSession(agent)) {
      if (agent.session) responsibilityScopes.bindOwner(agent);
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
    if (["researcher", "reviewer"].includes(childRole ?? "") && !isManagedRoleChild(agent)) {
      throw new Error(`ODAI_MANAGED_RESPONSIBILITY_REQUIRED: ${childRole} requires odai_responsibility_gap and managed evidence validation; a native description label cannot bypass it`);
    }
    if (childRoleState?.route?.backend === "local-cli") {
      throw new Error(`ODAI_LOCAL_CLI_MANAGED_DISPATCH_REQUIRED: ${childRole} uses local-cli; use odai_responsibility_gap instead of a native odai-${childRole}: label`);
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
    if (roleRoute?.backend === "local-cli") {
      throw new Error("ODAI_LOCAL_CLI_CHILD_REQUIRED: local-cli cannot upgrade a same-turn request; use odai_responsibility_gap");
    }
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
        scope = responsibilityScopes.claim(agent, scope, { step, baseRoute, temporaryRoute, routeMode });
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
        roleRoute = undefined;
        routeMode = "same-turn";
        scopedResponsibilityMaxTokens = undefined;
        request = proposed;
      }
    }
    if (childRole || isSubagentSession(agent)) return finalize(request);

    const requestInput = currentDirectInput(agent, { turn, signal, minimum: "claimed" });
    const outputSelection = previewSessionOutputControl(
      await selectSharedOutputPolicyForTurn(agent, turn, () => selectOutputForAgent(agent, turn)),
      { events: evidence.events(agent), text: requestInput ? extractLatestUserText([requestInput.message]) : "", turn, step,
        userMessageId: typeof requestInput?.message.id === "string" ? requestInput.message.id : undefined },
    );
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
    if (responsibilityScopes.isOwnedElsewhere(agent)) return next();
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
    const owner = responsibilityScopes.ownerFor(session);
    if (owner && event.type === "turn/end") invalidateNativeDirectInput(owner);
    if (owner && event.type === "user/message" && !isSubagentSession(owner)) {
      const message = latestDirectUserMessage(owner);
      const position = sessionEvents(session).findLast((entry) => entry.type === "step/start")?.data;
      const turn = position?.turn;
      const step = position?.step;
      if (message && message.id === event.data.id && typeof turn === "number" && typeof step === "number") {
        const notice = recognizeDirectNames(owner, turn, step, message);
        if (notice) session.append("user/message", notice, { surfaceOp: "append" });
        prepareSessionOutputControl({
          events: evidence.events(owner), text: extractLatestUserText([message]), turn, step,
          userMessageId: typeof message.id === "string" ? message.id : undefined,
          append(type, data) { appendEvent(owner, type, data); },
        });
        const settings = memorySettingsFor(owner, turn);
        if (step === 1 && settings.mode === "auto" && claimSemanticMemoryTurn(owner, turn, step, `capture:${message.id}`)) {
          try {
            const captured = captureAutomaticMemories({ storePath: config.memory.storePath, mode: settings.mode,
              agent: owner, message, turn, cwd: session.header.cwd }).filter((entry) => entry.changed);
            if (captured.length) appendEvent(owner, "odai/memory-processed", {
              turn, step, mode: settings.mode, source: settings.source, retrievedIds: [],
              captures: captured, status: "completed",
            });
          } catch (error) {
            logger.warn(`Odai committed memory capture failed closed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
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
          status: "recovery-pending",
        });
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
  });

  ctx.on("agent/turn-stopping", ({ agent, turn, signal }: AgentTurnEvent & { signal?: AbortSignal }) => {
    stopResponsibilityScope(agent, "turn-stopping");
    const missing = evidence.events(agent).findLast(event => event.type === "odai/responsibility-return-missing" && event.data.turn === turn);
    const recovered = missing && evidence.events(agent).some(event => event.type === "odai/responsibility-recovery" && event.data.scopeId === missing.data.scopeId);
    if (missing && !recovered && !signal?.aborted && typeof agent.steer === "function") {
      agent.steer(pluginMessage([
        `The same-turn ${missing.data.responsibility} responsibility emitted a terminal response without odai_responsibility_return.`,
        "Its text is an unverified read-only draft, not final delivery or independent acceptance.",
        "The runtime restored the controller route. Verify the decisive claims, continue the authorized task, and keep controller ownership of final delivery.",
      ].join("\n"), "responsibility handback recovery"));
      appendEvent(agent, "odai/responsibility-recovery", { turn, scopeId: missing.data.scopeId, status: "recovery-steered" });
      // Recovery already wakes the controller; defer completion prompting to its next stop.
    } else if (signal) {
      if (!signal.aborted && !isSubagentSession(agent) && config.routing.mode !== "off" && leadState(evidence.events(agent))?.enabled) {
        const message = latestDirectUserMessage(agent);
        const events = evidence.events(agent);
        const taskId = message && leadTaskId(events, message.id, classifyPendingReviewerText(extractLatestUserText([message])) === "continue");
        const state = leadState(events);
        if (taskId && Array.isArray(state?.roles) && state.roles.includes("reviewer") && events.some(event => event.type === "odai/lead-write" && event.data.taskMessageId === taskId)) {
          const gaps = namedGaps(agent).filter(event => event.data.taskMessageId === taskId && event.data.responsibility === "reviewer" && event.data.timing === "completion");
          const last = gaps.at(-1);
          const prior = events.filter(event => event.type === "odai/lead-review" && event.data.taskMessageId === taskId);
          const step = agent.phase?.step ?? sessionEvents(agent.session).findLast(event => event.type === "step/start")?.data.step ?? 0;
          if (!last && configuredRole(agent, "reviewer", turn).route) appendEvent(agent, "odai/responsibility-gap", leadGap("reviewer", taskId, turn, step));
          else if (last && gapConsumed(agent, last.data.stateDigest)) {
            const result = events.findLast(event => event.type === "odai/route-result" && event.data.stateDigest === last.data.stateDigest);
            const decision = events.findLast(event => event.type === "odai/route-decided" && event.data.stateDigest === last.data.stateDigest);
            const scope = decision && events.find(event => event.type === "odai/responsibility-scope-started" && event.data.startStep === decision.data.step && event.data.turn === decision.data.turn);
            const returned = scope && events.find(event => event.type === "odai/responsibility-returned" && event.data.scopeId === scope.data.scopeId);
            if ((result || returned) && !prior.some(event => event.data.stateDigest === last.data.stateDigest)) {
              const text = String(result?.data.outputText ?? returned?.data.summary ?? "");
              const success = (returned && events.some(event => event.type === "odai/route-applied" && event.data.responsibilityScopeId === scope?.data.scopeId && event.data.status === "applied")) || (result?.data.status === "completed" && result.data.routeReceiptStatus === "applied");
              const verdict = success ? parseLeadVerdict(text) : "failed";
              appendEvent(agent, "odai/lead-review", { taskMessageId: taskId, stateDigest: last.data.stateDigest, turn, step, verdict, round: prior.length });
              if (verdict === "changes-requested" && prior.length < 2) {
                agent.steer?.(pluginMessage(`主导模式审查要求修正（最多再审2轮）：\n${text}\n请完成修正，下一次结束时再审。`, "odai lead correction"));
                return;
              }
              if (verdict !== "pass") agent.steer?.(pluginMessage(`主导模式审查未通过或未完成（${verdict}）；不再重试。最终答复说明未解决问题及原因。\n${text}`, "odai lead review incomplete"));
            } else if (prior.at(-1)?.data.verdict === "changes-requested" && prior.length <= 2 && prior.at(-1)?.data.stateDigest === last.data.stateDigest && (prior.at(-1)?.data.turn !== turn || prior.at(-1)?.data.step !== step)) {
              appendEvent(agent, "odai/responsibility-gap", leadGap("reviewer", taskId, turn, step, prior.length));
            }
          }
        }
      }
      promptNamedRequests({ agent, turn, signal });
    }
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
    const routePreStep = async (
      { agent, turn, step, signal }: AgentRequestEvent,
      next: () => Promise<StepResult>,
    ) => {
      const subagentSession = isSubagentSession(agent);
      if (responsibilityScopes.isOwnedElsewhere(agent) && responsibilityScopes.get(agent)?.turn === turn) return next();
      if (!subagentSession) {
        if (step === 1) {
          stopResponsibilityScope(agent, "new-turn");
          routeProtections.delete(agent);
        }
        stopDanglingResponsibilityScope(agent, "runtime-resume");
      }
      let downstream = await next();
      if (downstream.kind === "reject" || signal.aborted) {
        invalidateNativeDirectInput(agent);
        return downstream;
      }
      if (responsibilityScopes.isOwnedElsewhere(agent)) return downstream;
      const authenticatedDirectMessage = latestDirectUserMessage(agent, undefined, { turn });
      const suppliedDirectMessages = Array.isArray(downstream.messages)
        ? downstream.messages.filter((message) => message?.source?.kind === "user")
        : [];
      const previewInput = currentDirectInput(agent, { turn, signal, minimum: "claimed", messages: suppliedDirectMessages });
      if (!previewInput && currentDirectInput(agent, { turn, signal, minimum: "claimed" })?.phase === "claimed") {
        invalidateNativeDirectInput(agent);
        return { ...downstream, kind: "reject", reason: "ODAI_INPUT_CHANGED_BEFORE_ADMISSION" };
      }
      const directMessage = latestDirectUserMessage(agent, suppliedDirectMessages, { turn });
      const namedNotice = recognizeDirectNames(agent, turn, step, directMessage);
      if (namedNotice) downstream = { ...downstream, messages: [...downstream.messages, namedNotice] };
      // A candidate must first pass native admission. The committed user/message
      // observer records it before the model can execute controller tools.
      if (!directMessage && previewInput?.message && !subagentSession && config.routing.mode !== "off") {
        const routes: Partial<Record<Responsibility, ModelRoute>> = {};
        for (const role of CONFIGURABLE_ROLES) { const route = configuredRole(agent, role, turn).route; if (route) routes[role] = route; }
        if (recognizeNamedRequests(extractLatestUserText([previewInput.message]), routes).length) return downstream;
      }
      const responsibilityGap = subagentSession ? undefined : pendingResponsibilityGap(agent, turn, step);
      // Inbox messages are committed after pre-step. Do not dispatch a task-bound
      // proposal while a new or changed human batch still lacks native admission.
      if (responsibilityGap?.taskMessageId && suppliedDirectMessages.length > 0 && !directMessage) return downstream;
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
        const message = previewInput?.message;
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
            if (directMessage && claimSemanticMemoryTurn(agent, turn, step, `capture:${message.id}`)) {
              captured = captureAutomaticMemories({
                storePath: config.memory.storePath, mode: settings.mode, agent, message, turn,
                cwd: agent?.session?.header?.cwd,
              });
            }
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
      if (!responsibilityGap && hasSessionEvent(agent, "odai/named-input-checked", data => data.taskMessageId === (directMessage ?? previewInput?.message)?.id)) return downstream;
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
      const responsibilityTaskFor = (role: string): string => responsibilityGap?.responsibility === role
        ? [
            "# Evidence-grounded responsibility gap",
            JSON.stringify({
              responsibility: responsibilityGap.responsibility,
              gap: responsibilityGap.gap,
              expectedChange: responsibilityGap.expectedChange,
              evidenceRefs: responsibilityGap.evidenceRefs,
              ...(responsibilityGap.userNamed ? { priorHandbacks: evidence.events(agent).filter(event => ["odai/route-result", "odai/research-result"].includes(event.type) && event.data.taskMessageId === responsibilityGap.taskMessageId && event.data.status === "completed" && event.data.routeReceiptStatus === "applied").map(event => ({ responsibility: event.data.role, actualRoute: event.data.actualRoute, output: event.data.outputText })) } : {}),
            }, undefined, 2),
            "",
            DIRECT_USER_TASK_HEADING.trimStart(),
            taskText,
          ].join("\n")
        : taskText;
      const scopePrefixFor = (text: string): { scopePrefixLength?: number } => {
        const index = responsibilityGap ? text.indexOf(DIRECT_USER_TASK_HEADING) : -1;
        return index > 0 ? { scopePrefixLength: index } : {};
      };
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
          ...(responsibilityGap?.userNamed ? { stateDigest: responsibilityGap.stateDigest, taskMessageId: responsibilityGap.taskMessageId } : {}),
          mode: config.routing.mode,
          reasonCode: researchDecision.reasonCode,
          signals: researchDecision.signals,
        });
        if (config.routing.mode === "observe" && !responsibilityGap?.userNamed) {
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
            );
            const subagents = isSubagentsService(ctx.subagents) ? ctx.subagents : undefined;
            const result: Readonly<RoutedRoleOutcome> = subagents || researchRoute.backend === "local-cli"
              ? await runRoutedRole({
             sessionEvidence: { events: evidence.events, append: (owner, type, data) => appendEvent(owner, type, data) },
                  subagents,
                  provider: config.routing.provider,
                  decision: researchDecision,
                  taskText: renderResearchTaskContract(responsibilityTaskFor("researcher")),
                  roleContract: researchContract,
                  roleBundle: researchBundle,
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
              ...(responsibilityGap?.userNamed ? { stateDigest: responsibilityGap.stateDigest, taskMessageId: responsibilityGap.taskMessageId, userNamed: true, outputText: completed ? outputText(result.output) : undefined } : {}),
              status: completed ? "completed" : "fallback",
              stopReason: completed ? result.stopReason : (packetError ? "packet-invalid" : result.stopReason),
              routeSource: researchState.source,
              fallbackUsed: !completed,
              routeReceiptStatus: result.routeReceiptStatus,
              requestedRoute: researchRoute,
              ...(result.routeReceiptError ? { routeReceiptError: result.routeReceiptError } : {}),
              ...(result.actualRoute ? { actualRoute: result.actualRoute } : {}),
              ...(result.boundaryStatus ? { boundaryStatus: result.boundaryStatus, boundaryTools: result.boundaryTools } : {}),
              ...(packet ? { packetDigest: packet.digest, sourceCount: packet.sourceCount } : {}),
              ...(packetError ? { error: packetError } : result.taskError ? { error: result.taskError } : {}),
            });
            if (result.sessionNotice) routedDownstream = { ...routedDownstream, messages: [...routedDownstream.messages, pluginMessage(result.sessionNotice, "responsibility session recovery")] };
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

      if (responsibilityGap?.userNamed && responsibilityGap.responsibility === "researcher" && !sameTurnResearchDecision) {
        appendEvent(agent, "odai/responsibility-gap-consumed", { turn, step, responsibility: "researcher", stateDigest: responsibilityGap.stateDigest, reason: "NAMED_RESEARCH_ATTEMPTED" });
        if (!researchPacketText) routedDownstream = { ...routedDownstream, messages: [...routedDownstream.messages, pluginMessage("用户点名 researcher 未完成：未取得通过核实的研究证据包。最终答复说明实际回执及原因，不重试、不替换模型或修改配置。", "odai named research incomplete")] };
        return routedDownstream;
      }
      let decision = sameTurnResearchDecision ?? decideRoute({
        text: taskText,
        writerConfigured: Boolean(configuredRole(agent, "writer", turn).route),
        creativeConfigured: Boolean(configuredRole(agent, "creative", turn).route),
        creativeText: (extractLatestUserText(downstream.messages) || authenticatedDirectText).slice(0, config.routing.maxInputChars),
        proposal: responsibilityGap,
        interruption: responsibilityContinuation,
      });
      let routeRole = decision.targetRole ?? decision.role;
      const responsibilityTaskText = responsibilityTaskFor(routeRole);
      const roleTaskText = researchPacketText ? `${responsibilityTaskText}\n\n${researchPacketText}` : responsibilityTaskText;
      let roleContext = decision.action === "direct"
        ? undefined
        : buildRoleContextPacket(agent, routeRole, roleTaskText, {
            ...(responsibilityGap?.requirements ? { requirements: responsibilityGap.requirements } : {}),
            ...(responsibilityGap?.taskMessageId ? { taskMessageId: responsibilityGap.taskMessageId } : {}),
            ...scopePrefixFor(roleTaskText),
            evidenceEvents: evidence.events(agent),
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
      // A child needs a frozen packet before dispatch. An in-place check uses
      // its existing context: keeping that proposal pending would restart the
      // same reviewer after handback, even though it already ran.
      const reviewerEvidenceIncomplete = routeRole === "reviewer" && roleContext !== undefined
        && effectiveRoleDispatch("reviewer", configuredRole(agent, "reviewer", turn).dispatch, config.routing.mode) === "child"
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
        if (decision.reasonCode === "HIGH_IMPACT_EVIDENCE_REQUIRED") {
          return { ...routedDownstream, messages: [...routedDownstream.messages, pluginMessage(
            "Odai risk evidence notice: the requested high-impact change relies on an unverified causal claim. Inspect decisive evidence and authorization before acting; use the canonical dao reference when needed. This signal does not select a model, certify an independent gap, or activate a whole-turn tool restriction. Request configured support only for a real capability or independent judgment gap. Keep unresolved dependent actions at their boundary and continue unrelated authorized work. Native execution permissions remain in force.",
            "odai controller retains ownership while verifying high-impact evidence",
          )] };
        }
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
          taskBoundary: roleContext.task,
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
                `An independent reviewer was not started because the bounded packet lacks an authenticated, identifiable review task (${JSON.stringify(localReviewerCoverage)}).`,
                `Evidence diagnostics: ${JSON.stringify(roleContext.diagnostics)}.`,
                responsibilityGap?.responsibility === "reviewer"
                  ? "The recorded reviewer gap remains pending until its task binding is established; do not repeatedly resubmit it unchanged."
                  : "Establish an authenticated user task and a clear delegated review scope before submitting a reviewer gap.",
                "Independent review remains incomplete. Continue authorized work that does not depend on it and repair the task binding from available sources. A controller-local check is not independent acceptance. Missing or failed tests do not prevent a reviewer from investigating them.",
              ].join("\n"),
              "odai reviewer evidence is incomplete; controller continues locally",
            ),
          ],
        };
      }

      if (config.routing.mode === "observe" && !responsibilityGap?.userNamed) {
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
      const leadReview = routeRole === "reviewer" && leadState(evidence.events(agent))?.enabled === true && evidence.events(agent).some(event => event.type === "odai/lead-write" && event.data.taskMessageId === responsibilityGap?.taskMessageId);
      const roleContract = dshRoleContract(routeRole, canonicalRoleContract) + (leadReview ? "\n主导模式验收：回交末尾必须独占一行 VERDICT: pass 或 VERDICT: changes-requested。same-turn 时写在 odai_responsibility_return 的 summary 末尾。" : "");
      let rolePreflightVerified = false;
      if (roleRoute.backend !== "local-cli" && routeRole === "frontend" && decision.action === "upgrade") {
        const health = await probeModelRoute(
          (candidate: ModelRoute, candidateSignal?: AbortSignal) => ctx.llm.resolveCallConfig(candidate, candidateSignal),
          roleRoute,
          signal,
        );
        if (health.status === "rejected") {
          if (responsibilityGap?.userNamed) {
            appendEvent(agent, "odai/route-result", { turn, step, role: routeRole, stateDigest: responsibilityGap.stateDigest, taskMessageId: responsibilityGap.taskMessageId, status: "fallback", stopReason: "route-preflight-failed", error: health.failure.message });
            return { kind: "enter", messages: [...routedDownstream.messages, pluginMessage(`用户点名的 ${routeRole} 未完成：${health.failure.message}。不重试，不替换模型，不修改配置；最终答复必须说明该项未完成及原因。`, "odai named responsibility failed")] };
          }
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
        ...(responsibilityGap?.taskMessageId ? { taskMessageId: responsibilityGap.taskMessageId } : {}),
        ...scopePrefixFor(roleTaskText),
        evidenceEvents: evidence.events(agent),
      });
      const roleDispatch = roleRoute.backend === "local-cli" ? "child" : effectiveRoleDispatch(routeRole, roleState.dispatch, config.routing.mode);
      const inPlaceUpgrade = roleDispatch === "same-turn";
      const contextMode = inPlaceUpgrade ? "same-turn" : "bounded-packet";
      appendEvent(agent, "odai/route-context", {
        turn,
        step,
        role: routeRole,
        mode: contextMode,
        digest: roleContext.digest,
        evidenceDigest: roleContext.evidenceDigest,
        ...(roleContext.reviewEvidenceDigest ? { reviewEvidenceDigest: roleContext.reviewEvidenceDigest } : {}),
        taskBoundary: roleContext.task,
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
                `odai reviewer child was not started because the bounded packet lacks an authenticated, identifiable review task (${JSON.stringify(roleContext.coverage)}).`,
                `Evidence diagnostics: ${JSON.stringify(roleContext.diagnostics)}.`,
                responsibilityGap?.responsibility === "reviewer"
                  ? "The recorded reviewer gap remains pending until its task binding is established; do not repeatedly resubmit it unchanged."
                  : "Establish an authenticated user task and a clear delegated review scope before submitting a reviewer gap.",
                "Independent review remains incomplete. Continue other authorized work that does not depend on it. Do not claim independent acceptance.",
              ].join("\n"),
              "odai reviewer evidence packet is incomplete",
            ),
          ],
        };
      }

      if (inPlaceUpgrade) {
        if (!isInPlaceResponsibility(routeRole)) throw new Error(`unsupported in-place responsibility: ${routeRole}`);
        const responsibilityScope = responsibilityScopes.start(agent, {
          turn,
          startStep: step,
          role: routeRole,
          route: roleRoute,
          source: roleState.source,
          decision,
          routeValidated: rolePreflightVerified,
          ...(responsibilityContinuation ? { resumeOfScopeId: responsibilityContinuation.scopeId } : {}),
        });
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
          ? "This is a same-turn read-only check. It does not establish independent acceptance, regardless of the packet's evidence coverage."
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
                ...(routeRole === "researcher" ? ["", renderResearchTaskContract(roleTaskText)] : []),
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
      const result: Readonly<RoutedRoleOutcome> = subagents || roleRoute.backend === "local-cli"
        ? await runRoutedRole({
             sessionEvidence: { events: evidence.events, append: (owner, type, data) => appendEvent(owner, type, data) },
            subagents,
            provider: config.routing.provider,
            decision: delegationDecision,
            taskText: renderRoleContextPacket(roleContext),
            reviewEvidence: reviewEvidenceSnapshot(roleContext),
            roleContract,
            roleBundle,
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
        ...(responsibilityGap?.userNamed ? { stateDigest: responsibilityGap.stateDigest, taskMessageId: responsibilityGap.taskMessageId, userNamed: true, outputText: result.status === "completed" ? outputText(result.output) : undefined } : {}),
        routeSource: roleState.source,
        fallbackUsed: result.status !== "completed",
        routeReceiptStatus: result.routeReceiptStatus,
        requestedRoute: roleRoute,
        contextDigest: roleContext.digest,
        ...(result.routeReceiptError ? { routeReceiptError: result.routeReceiptError } : {}),
        ...(result.actualRoute ? { actualRoute: result.actualRoute } : {}),
        ...(result.taskError ? { error: result.taskError } : {}),
        ...(result.sessionAction ? { sessionAction: result.sessionAction, routeSessionId: result.routeSessionId, sessionNotice: result.sessionNotice } : {}),
        ...(result.boundaryStatus ? { boundaryStatus: result.boundaryStatus, boundaryTools: result.boundaryTools } : {}),
        ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.cliReportedCostUsd === undefined ? {} : { cliReportedCostUsd: result.cliReportedCostUsd }),
        ...(result.deniedActionsCount === undefined ? {} : { deniedActionsCount: result.deniedActionsCount }),
        ...(result.reasoningEffortVerification ? { reasoningEffortVerification: result.reasoningEffortVerification } : {}),
      });

      if (result.status === "completed") {
        const childText = outputText(result.output);
        const heading = [
          ...(result.sessionNotice ? [result.sessionNotice] : []),
          renderRouteNotice(delegationDecision, config.routing.mode, result.actualRoute, "child"),
          ...(result.reasoningEffortVerification === "verified"
            ? [`Reasoning effort: ${result.actualRoute?.reasoningEffort ?? "unspecified"} (verified from CLI session evidence).`]
            : result.reasoningEffortVerification === "requested-only"
              ? [`Reasoning effort: ${roleRoute.reasoningEffort ?? "unspecified"} (requested only; CLI does not verify actual effort).`] : []),
        ].join("\n");
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

      const failure = [result.sessionNotice, result.error ?? result.stopReason].filter(Boolean).join("; ");
      return {
        kind: "enter",
        messages: [
          ...routedDownstream.messages,
          pluginMessage(
            renderRouteFailureNotice(delegationDecision, failure) + (responsibilityGap?.stateDigest.startsWith("user-named:lead-mode:") ? "\n主导模式该职责未完成：继续授权任务，不重试、不替换模型；最终答复必须说明未完成的步骤及上述原因。" : ""),
            `odai ${routeRole} route unavailable; controller retains ownership`,
          ),
        ],
      };
    };
    ctx.on("agent/pre-step", async (event: AgentRequestEvent, next: () => Promise<StepResult>) => {
      try {
        return await routePreStep(event, next);
      } finally {
        if (!event.signal.aborted) await deps.refreshExecutionSurface(event.agent);
      }
    }, { prepend: true });
  }


}
