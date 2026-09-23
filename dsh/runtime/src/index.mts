import {
  applyCompactionStateProtocol,
  applyCompactionTarget,
  effectiveCompactionTarget,
  invalidatePersistedCompactionTarget,
} from "./compaction-config.mjs";
import { installCompactionRuntime } from "./compaction-runtime.mjs";
import { installControlCenterRuntimeWhenAvailable } from "./control-center-runtime.mjs";
import { installLifecycleRuntime } from "./lifecycle-runtime.mjs";
import type { RouteProtection } from "./lifecycle-runtime.mjs";
import { classifyModelRouteFailure, probeModelRoute } from "./model-route.mjs";
import { createPromptRuntime } from "./prompt-runtime.mjs";
import { createResponsibilityScopeOwner } from "./responsibility-scope.mjs";
import { classifyPendingReviewerText, extractLatestUserText, hasExplicitRequestRevision } from "./router.mjs";
import { invalidatePersistedRoleRoute } from "./routing-config.mjs";
import {
  inheritCompactionReasoning,
  resolveConfig,
  resolveSkillPath,
} from "./runtime-config.mjs";
import {
  RUNTIME_NAME,
  loggerFor,
  routedRoleOf,
  responsibilityRoutingAvailable,
  routeFromConfig,
  runRoutedRole,
  sameRequestModelRoute,
} from "./runtime-support.mjs";
import { createSessionEvidence, resolveSessionEvidenceRoot } from "./session-evidence.mjs";
import { currentAgentTurn } from "./skill-selection-state.mjs";
import { hasUncommittedDirectInput, latestDirectUserMessage } from "./semantic-memory.mjs";
import { isBoundRequirementLedger, type ResponsibilityGapProposal } from "./responsibility-gap.mjs";
import { installToolRuntime } from "./tool-runtime.mjs";
import { resolveHumanSafetyContinuityStorePath } from "./human-safety-continuity-store.mjs";
import type {
  DshAgent,
  DshRuntimeContext,
  DshSession,
  ModelRoute,
  RuntimeEventData,
  UnknownRecord,
} from "./runtime-types.mjs";

export const name = RUNTIME_NAME;
export { inheritCompactionReasoning, resolveConfig, resolveSkillPath, runRoutedRole };

export const inject = ["systemPrompt", "tools", "subagents", "sessions", "llm"];

interface RouteFailure {
  kind: string;
  code: string;
  message: string;
}

function isResponsibilityGapProposal(data: RuntimeEventData): data is RuntimeEventData & ResponsibilityGapProposal {
  return typeof data.responsibility === "string"
    && ["researcher", "planner", "reviewer", "frontend", "user"].includes(data.responsibility)
    && typeof data.gap === "string"
    && Array.isArray(data.evidenceRefs)
    && data.evidenceRefs.every((value) => typeof value === "string")
    && typeof data.expectedChange === "string"
    && isBoundRequirementLedger(data.requirements)
    && typeof data.stateDigest === "string";
}

interface RouteInvalidation extends UnknownRecord {
  invalidated: boolean;
  reason?: string;
  backupPath?: string;
  error?: string;
}

export function apply(ctx: DshRuntimeContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig);
  const logger = loggerFor(ctx);
  const disposeControlCenter = installControlCenterRuntimeWhenAvailable(ctx, {
    configPath: config.routing.configPath,
    configuredRoles: config.routing.roles,
    configuredDispatch: config.routing.dispatch,
    logger,
  });
  ctx.effect?.(() => disposeControlCenter, "odai: Control Center RPC");
  const humanSafetyContinuityStorePath = resolveHumanSafetyContinuityStorePath();
  const evidence = createSessionEvidence({
    root: resolveSessionEvidenceRoot(config.routing.configPath),
    logger,
  });
  const childReceiptParents = new WeakMap<DshSession, { parent: DshAgent; parentId: string; turn?: number; step?: number }>();
  ctx.on("agent/created", ({ agent }: { agent: DshAgent }) => {
    const parentId = agent.session.header.parentSession;
    if (typeof parentId !== "string" || !parentId || parentId === agent.session.header.id) return;
    try {
      const parent = ctx.sessions?.get(parentId);
      if (!parent || parent.header.id !== parentId) return;
      const events = parent.snapshotEvents();
      const boundary = events.findLast((event) => event.type === "turn/start" || event.type === "turn/end");
      const turn = boundary?.type === "turn/start" && Number.isSafeInteger(boundary.data.turn) ? Number(boundary.data.turn) : undefined;
      const stepEvent = turn === undefined ? undefined : events.findLast((event) => event.type === "step/start" && event.data.turn === turn);
      const step = Number.isSafeInteger(stepEvent?.data.step) ? Number(stepEvent?.data.step) : undefined;
      childReceiptParents.set(agent.session, { parent: { session: parent }, parentId, turn, step });
    } catch (error) {
      logger.warn(`failed to associate child route evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const appendEvent = (agent: DshAgent, type: string, data: object) => {
    try {
      const receipt = evidence.append(agent, type, data);
      if (!receipt || !["odai/route-applied", "odai/route-fallback"].includes(type)
        || receipt.data.routeMode !== "child" || !routedRoleOf(agent)) return;
      const link = childReceiptParents.get(agent.session);
      const childSessionId = agent.session.header.id;
      if (!link || typeof childSessionId !== "string" || !childSessionId
        || agent.session.header.parentSession !== link.parentId) return;
      const { turn: childTurn, step: childStep, ...details } = receipt.data;
      // Later resident work has no authenticated parent-turn binding.
      const firstNativeTurn = agent.session.snapshotEvents().find((event) => event.type === "turn/start");
      const firstTurn = Number.isSafeInteger(firstNativeTurn?.data.turn) && childTurn === firstNativeTurn?.data.turn;
      evidence.append(link.parent, type, {
        ...details,
        ...(firstTurn && link.turn !== undefined ? { turn: link.turn } : {}),
        ...(firstTurn && link.step !== undefined ? { step: link.step } : {}),
        childSessionId, childReceiptId: receipt.id, childTurn, childStep,
        parentAssociation: firstTurn ? "child-activation" : "parent-session-only",
      });
    } catch (error) {
      logger.warn(`failed to record ${type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const hasSessionEvent = (
    agent: DshAgent,
    type: string,
    predicate: (data: RuntimeEventData) => boolean,
  ): boolean => evidence.has(agent, type, predicate);
  installCompactionRuntime({
    appendEvent,
    applyCompactionStateProtocol,
    applyCompactionTarget,
    classifyModelRouteFailure,
    config,
    ctx,
    effectiveCompactionTarget,
    inheritCompactionReasoning,
    invalidatePersistedCompactionTarget,
    logger,
    probeModelRoute,
    routeFromConfig,
    sameRequestModelRoute,
  });
  const promptRuntime = createPromptRuntime({
    appendEvent,
    config,
    ctx,
    evidence,
    hasSessionEvent,
    humanSafetyContinuityStorePath,
    logger,
  });
  const {
    bundled,
    explicitSkillPath,
    memorySettingsFor,
    routingSnapshotFor,
    selectOutputForAgent,
    skillPath,
  } = promptRuntime;
  const routeProtections = new WeakMap<DshAgent, RouteProtection>();
  const responsibilityScopes = createResponsibilityScopeOwner({
    appendEvent, events: (agent) => evidence.events(agent), routeProtections,
  });
  ctx.effect?.(() => responsibilityScopes.dispose, "odai: responsibility scope owner");
  const configuredRole = (agent: DshAgent, role: string, turn = currentAgentTurn(agent)) => {
    const state = routingSnapshotFor(agent, turn);
    if (state.error || !state.snapshot) return state;
    return {
      route: state.snapshot.roles[role],
      source: state.snapshot.sources[role],
      dispatch: state.snapshot.dispatch[role],
      dispatchSource: state.snapshot.dispatchSources[role],
    };
  };
  const pendingResponsibilityGap = (
    agent: DshAgent,
    turn: number | undefined,
    step: number,
  ): ResponsibilityGapProposal | undefined => {
    if (hasUncommittedDirectInput(agent)) return undefined;
    const events = evidence.events(agent);
    const consumed = new Set(events.flatMap((event) => (
      event.type === "odai/responsibility-gap-consumed" ? [event.data?.stateDigest] : []
    )));
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.data?.turn !== turn
        || event.type !== "odai/responsibility-gap"
        || typeof event.data?.step !== "number"
        || !Number.isSafeInteger(event.data.step)
        || event.data.step >= step
        || consumed.has(event.data.stateDigest)
        || !isResponsibilityGapProposal(event.data)) continue;
      const message = latestDirectUserMessage(agent);
      if (event.data.taskMessageId && !message) return undefined;
      if (message && event.data.taskMessageId && event.data.taskMessageId !== message.id) {
        const text = extractLatestUserText([message]);
        const continuation = event.data.responsibility === "reviewer"
          && Boolean(event.data.taskMessageId)
          && classifyPendingReviewerText(text) === "continue"
          && !(event.data.requirements && hasExplicitRequestRevision(text));
        if (continuation) return event.data;
        appendEvent(agent, "odai/responsibility-gap-consumed", {
          turn,
          step,
          responsibility: event.data.responsibility,
          stateDigest: event.data.stateDigest,
          reason: "SUPERSEDED_BY_DIRECT_USER_TASK",
        });
        return undefined;
      }
      return event.data;
    }
    if (turn === undefined) return undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type !== "odai/responsibility-gap"
        || event.data?.responsibility !== "reviewer"
        || typeof event.data.turn !== "number"
        || event.data.turn >= turn
        || consumed.has(event.data.stateDigest)
        || !isResponsibilityGapProposal(event.data)) continue;
      const deferred = events.slice(index + 1).some((candidate) => (
        candidate.type === "odai/responsibility-gap-deferred"
        && candidate.data?.stateDigest === event.data.stateDigest
      ));
      if (!deferred) continue;
      const message = latestDirectUserMessage(agent);
      if (!message) return undefined;
      const userText = extractLatestUserText([message]);
      const transition = classifyPendingReviewerText(userText);
      if (transition === "continue" && !(event.data.requirements && hasExplicitRequestRevision(userText))) return event.data;
      appendEvent(agent, "odai/responsibility-gap-consumed", {
        turn,
        step,
        responsibility: "reviewer",
        stateDigest: event.data.stateDigest,
        reason: "SUPERSEDED_BY_DIRECT_USER_TASK",
      });
      return undefined;
    }
    return undefined;
  };
  const invalidateFailedRoleRoute = (
    agent: DshAgent,
    role: string,
    route: ModelRoute,
    source: string | undefined,
    failure: RouteFailure,
    position: RuntimeEventData = {},
  ): RouteInvalidation => {
    let invalidation: RouteInvalidation = Object.freeze({ invalidated: false, reason: "not-deterministic-or-not-persisted" });
    if (failure.kind === "deterministic" && source === "persisted-mapping") {
      try {
        invalidation = invalidatePersistedRoleRoute(config.routing.configPath, role, route);
      } catch (error) {
        invalidation = Object.freeze({
          invalidated: false,
          reason: "cleanup-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    appendEvent(agent, "odai/route-health", {
      ...position,
      responsibility: role,
      routeSource: source,
      requestedRoute: route,
      status: failure.kind === "deterministic" ? "invalid" : "unhealthy",
      failureKind: failure.kind,
      errorCode: failure.code,
      error: failure.message,
      invalidated: invalidation.invalidated,
      ...(invalidation.backupPath ? { backupPath: invalidation.backupPath } : {}),
      ...(invalidation.reason ? { cleanupReason: invalidation.reason } : {}),
      ...(invalidation.error ? { cleanupError: invalidation.error } : {}),
    });
    return invalidation;
  };
  installToolRuntime({
    appendEvent, bundled, config, ctx, evidence, explicitSkillPath,
    hasSessionEvent, humanSafetyContinuityStorePath, logger, pendingResponsibilityGap, promptRuntime,
    responsibilityRoutingFor: (agent, turn = currentAgentTurn(agent)) => responsibilityRoutingAvailable(config.routing.mode, routingSnapshotFor(agent, turn)),
    responsibilityScopes, routeProtections, selectOutputForAgent,
  });

  installLifecycleRuntime({
    refreshExecutionSurface: promptRuntime.refreshExecutionSurface,
    appendEvent, bundled, config, configuredRole, ctx, evidence, hasSessionEvent, invalidateFailedRoleRoute,
    logger, memorySettingsFor, pendingResponsibilityGap, responsibilityScopes, routeProtections,
    selectOutputForAgent,
  });

  logger.info(`loaded canonical governance ${bundled.manifest.skillVersion} from ${skillPath}; skillSource=${explicitSkillPath ? "path" : config.governance.skillSource}; routing=${config.routing.mode}`);
}
