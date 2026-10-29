import { effectiveSessionRoute } from "./session-controls.mjs";
import { executeRouteSession } from "./route-session.mjs";
import type { RouteSessionEvidence } from "./route-session.mjs";
import { renderLocalCliReviewEvidence } from "./review-evidence.mjs";
import { randomUUID } from "node:crypto";
import { executeLocalCli } from "#odai-local-cli";
import type { LocalCliRoute } from "#odai-local-cli";
import { describeModelRoute } from "./model-route.mjs";

import { renderDelegationPrompt } from "./router.mjs";
import type { RouteDecision } from "./router.mjs";
import type { SkillBundle } from "./skill-bundle.mjs";
import type { ResponsibilityInterruption } from "./responsibility-scope.mjs";
import { CONFIGURABLE_ROLES } from "./routing-config.mjs";
import { ODAI_CONTEXTUAL_TOOL_NAMES, ODAI_CORE_TOOL_NAMES } from "./context-activation.mjs";
import { ROUTED_ROLES } from "./runtime-config.mjs";
import type {
  DshAgent,
  DshSession,
  DshContentBlock,
  DshEvent,
  DshMessage,
  ModelRoute,
  ResponsibilityDispatch,
  PromptAssembly,
  RuntimeLogger,
  ToolSchema,
  ToolRestriction,
  UnknownRecord,
} from "./runtime-types.mjs";
import { ODAI_MESSAGE_SOURCE_KIND, sessionEvents } from "./runtime-types.mjs";

interface RoutedRunResult {
  stopReason: string;
  output?: readonly DshContentBlock[];
}

interface RequestRouteAgent {
  session?: {
    snapshotEvents?(): readonly DshEvent[];
  };
}

interface RoutedRun {
  childId?: string;
  result: Promise<RoutedRunResult>;
  localAgent?: RequestRouteAgent;
  dispose(): Promise<void>;
}

export interface SubagentsService {
  startActivation?(spec: UnknownRecord): Promise<RoutedRun>;
  start?(provider: string, options: UnknownRecord): Promise<RoutedRun>;
}

export interface RoutedRoleOutcome extends UnknownRecord {
  status: "completed" | "fallback";
  stopReason: string;
  output: readonly DshContentBlock[];
  routeReceiptStatus?: "applied" | "mismatch" | "unverified";
  routeReceiptError?: string;
  actualRoute?: ModelRoute;
  error?: string;
  taskError?: string;
  durationMs?: number;
  usage?: Readonly<Record<string, unknown>>;
  cliReportedCostUsd?: number;
  reasoningEffortVerification?: "verified" | "mismatch" | "requested-only";
  deniedActionsCount?: number;
  sessionAction?: "created" | "resumed" | "resume-failed-created";
  routeSessionId?: string;
  sessionNotice?: string;
}

export interface SkillSelection {
  mode: string;
  status: string;
  reasonCode: string;
  detail?: string;
  bundle: SkillBundle;
  rejections: readonly { source: string; reasonCode: string }[];
}

// A proposal can only route when some responsibility has a mapping. An invalid store
// stays visible so its existing fail-closed notice still reaches the controller.
export function responsibilityRoutingAvailable(mode: string, state: RoutingSnapshotState): boolean {
  if (mode === "off") return false;
  if (state.error || !state.snapshot) return true;
  return Object.values(state.snapshot.roles).some((route) => route !== undefined);
}

export interface RoutingSnapshotState {
  error?: string;
  detail?: string;
  snapshot?: {
    roles: Readonly<Record<string, ModelRoute | undefined>>;
    sources: Readonly<Record<string, string>>;
    dispatch: Readonly<Record<string, ResponsibilityDispatch | undefined>>;
    dispatchSources: Readonly<Record<string, string>>;
  };
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const RUNTIME_NAME = "odai-dsh-runtime";

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function pluginMessage(
  text: string,
  summary: string,
  extraBlocks: readonly DshContentBlock[] = [],
): Readonly<DshMessage> {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }, ...extraBlocks],
    source: {
      kind: ODAI_MESSAGE_SOURCE_KIND,
      form: "notice",
      summary: summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`,
    },
  });
}

export function renderOutputLimitInterruptionNotice(interruption: ResponsibilityInterruption): string {
  const route = interruption.effectiveRoute ?? interruption.requestedRoute;
  return [
    "Odai verified output-limit interruption",
    `responsibility: ${interruption.responsibility}`,
    `interrupted scope: ${interruption.scopeId}`,
    `provider finish reason: ${interruption.reason}`,
    ...(route ? [`effective route: ${describeModelRoute(route, { style: "identity" })}`] : []),
    ...(interruption.effectiveMaxTokens === undefined ? [] : [`effective maxTokens: ${interruption.effectiveMaxTokens}`]),
    ...(interruption.outputTokens === undefined ? [] : [`observed outputTokens: ${interruption.outputTokens}`]),
    "This proves the responsibility output was interrupted, not that its task completed. Explain the verified cause without guessing. Resume only after an explicit user continuation.",
  ].join("\n");
}

export function loggerFor(ctx: { logger?: (name: string) => RuntimeLogger }): RuntimeLogger {
  if (typeof ctx.logger !== "function") return { info() {}, warn() {} };
  return ctx.logger(RUNTIME_NAME);
}

export function outputText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block): block is DshContentBlock => isUnknownRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

export function renderResearchTaskContract(taskText: string): string {
  return [
    "Factual question: Resolve the assigned responsibility gap using the expected change, evidence references, and original user task below. Treat evidence references as leads to verify. If no gap is supplied, use the factual question in the user task; if it is unclear, return the missing evidence boundary.",
    "Allowed source scope: the current project root only. Use repository-relative paths and read-only source tools; do not inspect parent, sibling, user, or unrelated directories.",
    "Authority and freshness: label each current-checkout source by its actual role (for example runtime configuration, implementation, test, incident record, or documentation). Do not invent an authority hierarchy; report unresolved conflicts and missing freshness evidence as unknowns.",
    "Stop condition: return the smallest sufficient source-backed packet, or stop with the missing evidence boundary. One fact or one source file is allowed; do not pad the packet or add sources to meet a quota. Do not select a route or continue after additional reading cannot change this factual question.",
    "For every fact, excerpt must exactly equal the complete cited source line after trimming leading and trailing whitespace.",
    "",
    "Assigned research task:",
    taskText,
  ].join("\n");
}

export function roleAgentOptions(roleRoute?: ModelRoute): UnknownRecord | undefined {
  if (!roleRoute) return undefined;
  if (roleRoute.backend === "local-cli") throw new Error("local-cli requires odai_responsibility_gap; native DSH children cannot execute this route");
  return {
    provider: roleRoute.provider,
    model: roleRoute.model,
    ...(roleRoute.maxTokens === undefined ? {} : { maxTokens: roleRoute.maxTokens }),
  };
}

export function sameRequestModelRoute(left?: Partial<ModelRoute>, right?: Partial<ModelRoute>): boolean {
  return Boolean(left && right
    && left.backend === right.backend
    && left.cli === right.cli
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort);
}

export function currentAgentStep(agent: DshAgent): number | undefined {
  const events = sessionEvents(agent?.session);
  if (events.length === 0) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "step/start" && Number.isSafeInteger(events[index].data?.step)) return events[index].data.step;
  }
  return undefined;
}

export function routeFromConfig(config: unknown): ModelRoute | undefined {
  if (!isUnknownRecord(config) || typeof config.provider !== "string" || typeof config.model !== "string") return undefined;
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    ...(typeof config.reasoningEffort === "string" ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(typeof config.maxTokens === "number" ? { maxTokens: config.maxTokens } : {}),
  });
}

export function latestRequestRoute(localAgent: RequestRouteAgent | undefined): ModelRoute | undefined {
  const events = sessionEvents(localAgent?.session);
  if (events.length === 0) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "request/header") continue;
    const header = isUnknownRecord(event.data.header) ? event.data.header : undefined;
    return routeFromConfig(header?.config);
  }
  return undefined;
}

export function routeMismatchFor(expected: ModelRoute | undefined, actual: ModelRoute | undefined, subject: string): string | undefined {
  if (!expected) return undefined;
  if (!actual) return `${subject} request/header did not expose an actual model route`;
  for (const field of ["provider", "model", "reasoningEffort", "maxTokens"]) {
    if (expected[field] !== undefined && expected[field] !== actual[field]) {
      return `${subject} ${field} mismatch: expected ${expected[field]}, got ${actual[field] ?? "<absent>"}`;
    }
  }
  return undefined;
}

export function routeMismatch(expected?: ModelRoute, actual?: ModelRoute): string | undefined {
  return routeMismatchFor(expected, actual, "child");
}

interface ManagedChildBinding { parentSessionId: string; role: string; route?: ModelRoute; childSession?: DshSession; bundle?: SkillBundle; reviewReader?: import("./review-evidence.mjs").ReviewEvidenceReader }
export function managedRoleRoute(agent: DshAgent, role: string): ModelRoute | undefined {
  if (!isManagedRoleChild(agent) || routedRoleOf(agent) !== role) return undefined;
  const descriptor = sessionEvents(agent.session).findLast(event => event.type === "subagent/descriptor");
  return typeof descriptor?.data.label === "string" ? managedChildLabels.get(descriptor.data.label)?.route : undefined;
}
export function managedRoleBundle(agent: DshAgent): SkillBundle | undefined {
  if (!isManagedRoleChild(agent)) return undefined;
  const descriptor = sessionEvents(agent.session).findLast(event => event.type === "subagent/descriptor");
  return typeof descriptor?.data.label === "string" ? managedChildLabels.get(descriptor.data.label)?.bundle : undefined;
}
export function managedReviewEvidenceReader(agent: DshAgent): import("./review-evidence.mjs").ReviewEvidenceReader | undefined {
  if (!isManagedRoleChild(agent) || routedRoleOf(agent) !== "reviewer") return undefined;
  const descriptor = sessionEvents(agent.session).findLast(event => event.type === "subagent/descriptor");
  return typeof descriptor?.data.label === "string" ? managedChildLabels.get(descriptor.data.label)?.reviewReader : undefined;
}
const managedChildState = globalThis as typeof globalThis & { __odaiManagedChildBindings?: Map<string, ManagedChildBinding> };
const managedChildLabels = managedChildState.__odaiManagedChildBindings ??= new Map<string, ManagedChildBinding>();
export function isManagedRoleChild(agent: DshAgent): boolean {
  const descriptor = sessionEvents(agent.session).findLast((event) => event.type === "subagent/descriptor");
  const binding = typeof descriptor?.data.label === "string" ? managedChildLabels.get(descriptor.data.label) : undefined;
  if (!binding || !isSubagentSession(agent) || !agent.session.header.id
    || agent.session.header.parentSession !== binding.parentSessionId || routedRoleOf(agent) !== binding.role
    || (binding.childSession && binding.childSession !== agent.session)) return false;
  binding.childSession ??= agent.session;
  return true;
}

export async function runRoutedRole({
  subagents,
  provider,
  decision,
  taskText,
  roleContract,
  agent,
  signal,
  roleRoute,
  roleBundle,
  reviewEvidence,
  sessionEvidence,
}: {
  sessionEvidence?: RouteSessionEvidence;
  subagents?: SubagentsService;
  provider: string;
  decision: Pick<RouteDecision, "role">;
  taskText: string;
  roleContract: string;
  agent: unknown;
  signal: AbortSignal;
  roleRoute?: ModelRoute;
  roleBundle?: SkillBundle;
  reviewEvidence?: import("./review-evidence.mjs").ReviewEvidenceSnapshot;
}): Promise<Readonly<RoutedRoleOutcome>> {
  if (roleRoute?.backend === "local-cli") {
    return runLocalCliRole({ decision, taskText, roleContract, roleBundle, agent, signal, roleRoute, reviewEvidence, sessionEvidence });
  }
  let run: RoutedRun | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= Promise.resolve().then(() => run?.dispose());
  let rejectCancellation: ((reason: Error) => void) | undefined;
  const abort = () => {
    void dispose().catch(() => {});
    rejectCancellation?.(new Error("Responsibility cancelled"));
  };
  let outcome: Readonly<RoutedRoleOutcome>;
  const label = `odai-${decision.role}: managed-${randomUUID()}`;
  const parentSessionId = isUnknownRecord(agent) && isUnknownRecord(agent.session) && isUnknownRecord(agent.session.header)
    ? agent.session.header.id : undefined;
  if (typeof parentSessionId === "string" && parentSessionId) managedChildLabels.set(label, {
    parentSessionId, role: decision.role, route: roleRoute, ...(roleBundle ? { bundle: roleBundle } : {}),
    ...(decision.role === "reviewer" && reviewEvidence ? { reviewReader: reviewEvidence.createReader() } : {}),
  });
  try {
  try {
    signal.throwIfAborted();
    if (!subagents) throw new Error("dsh subagents service unavailable");
    const request = {
      prompt: [{ type: "text", text: renderDelegationPrompt(decision, taskText,
        roleBundle ? `${roleBundle.coreContract}\n\n${roleContract}` : roleContract) }],
      parent: agent,
      maxDepth: 1,
      ...(roleRoute ? { agentOptions: roleAgentOptions(roleRoute) } : {}),
    };
    run = subagents.startActivation
      ? await subagents.startActivation({ provider, label, request, signal, delivery: "caller" })
      : await subagents.start!(provider, { ...request, label, signal });
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const result = await Promise.race([run.result, cancelled]);
    const childSession = managedChildLabels.get(label)?.childSession;
    const actualRoute = subagents.startActivation
      ? latestRequestRoute(childSession?.header.id === run.childId ? { session: childSession } : undefined)
      : latestRequestRoute(run.localAgent);
    const mismatch = routeMismatch(roleRoute, actualRoute);
    const routeReceiptStatus = !actualRoute ? "unverified" : mismatch ? "mismatch" : "applied";
    const routeEvidence = Object.freeze({
      routeReceiptStatus,
      ...(mismatch ? { routeReceiptError: mismatch } : {}),
      ...(actualRoute ? { actualRoute } : {}),
    });
    if (result.stopReason !== "completed") {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: result.stopReason,
        output: result.output ?? [],
        ...routeEvidence,
      });
    } else if (mismatch) {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: "route-unverified",
        output: [],
        error: mismatch,
        ...routeEvidence,
      });
    } else if (!outputText(result.output)) {
      outcome = Object.freeze({
        status: "fallback",
        stopReason: "route-empty-output",
        output: [],
        error: "child completed without textual evidence",
        taskError: "child completed without textual evidence",
        ...routeEvidence,
      });
    } else {
      outcome = Object.freeze({
        status: "completed",
        stopReason: result.stopReason,
        output: result.output ?? [],
        ...routeEvidence,
      });
    }
  } catch (error) {
    const taskError = error instanceof Error ? error.message : String(error);
    outcome = Object.freeze({
      status: "fallback",
      stopReason: "infrastructure-error",
      output: [],
      routeReceiptStatus: "unverified",
      error: taskError,
      taskError,
    });
  }

  if (run) {
    try {
      await dispose();
    } catch (error) {
      const disposeError = error instanceof Error ? error.message : String(error);
      const cleanupTaskError = outcome?.taskError
        ? `${outcome.taskError}; provider cleanup failed: ${disposeError}`
        : `provider cleanup failed: ${disposeError}`;
      return Object.freeze({
        status: "fallback",
        stopReason: "infrastructure-error",
        output: [],
        routeReceiptStatus: outcome?.routeReceiptStatus ?? "unverified",
        ...(outcome?.routeReceiptError ? { routeReceiptError: outcome.routeReceiptError } : {}),
        ...(outcome?.actualRoute ? { actualRoute: outcome.actualRoute } : {}),
        error: outcome?.error
          ? `${outcome.error}; provider cleanup failed: ${disposeError}`
          : cleanupTaskError,
        taskError: cleanupTaskError,
      });
    }
  }

  if (signal.aborted) {
    return Object.freeze({
      ...outcome,
      status: "fallback",
      stopReason: "cancelled",
      output: [],
      error: "Responsibility cancelled; late output was not accepted.",
    });
  }
  return outcome;
  } finally {
    signal.removeEventListener("abort", abort);
    managedChildLabels.delete(label);
  }
}

async function runLocalCliRole({ decision, taskText, roleContract, roleBundle, agent, signal, roleRoute, reviewEvidence, sessionEvidence }: {
  decision: Pick<RouteDecision, "role">;
  taskText: string;
  roleContract: string;
  roleBundle?: SkillBundle;
  agent: unknown;
  signal: AbortSignal;
  roleRoute: LocalCliRoute;
  sessionEvidence?: RouteSessionEvidence;
  reviewEvidence?: import("./review-evidence.mjs").ReviewEvidenceSnapshot;
}): Promise<Readonly<RoutedRoleOutcome>> {
  try {
    signal.throwIfAborted();
    if (!["researcher", "planner", "reviewer", "frontend", "creative", "writer"].includes(decision.role)) throw new Error("unsupported local-cli responsibility");
    if (decision.role === "reviewer" && !reviewEvidence) throw new Error("local-cli reviewer requires a task-bound captured evidence snapshot");
    const capturedEvidence = decision.role === "reviewer" && reviewEvidence ? renderLocalCliReviewEvidence(reviewEvidence) : "";
    const cwd = isUnknownRecord(agent) && isUnknownRecord(agent.session) && isUnknownRecord(agent.session.header)
      ? agent.session.header.cwd : undefined;
    if (typeof cwd !== "string" || !cwd.trim()) throw new Error("local-cli requires the session working directory");
    const readBoundary = {
      claude: "Read files using Read, Glob, and Grep; shell commands are unavailable.",
      codex: "Read files using read-only commands within the read-only sandbox. Child agents are disabled.",
      antigravity: "Use read-only tools to read only files whose paths are supplied in the task packet. Do not list directories, search for files, execute commands, write or edit files: denied actions invalidate this call. Report any missing files needed in the handback without attempting to find them. In agy 1.4.7 plan mode is ineffective with slash expansion disabled; request-review permissions and post-execution checks enforce this boundary.",
      grok: "Read files using read_file, grep, and list_dir within the read-only sandbox. Shell commands and Agent delegation are unavailable.",
    }[roleRoute.cli];
    const prompt = [
      renderDelegationPrompt(decision, taskText, roleBundle ? `${roleBundle.coreContract}\n\n${roleContract}` : roleContract),
      capturedEvidence,
      decision.role === "researcher" ? "Return only the required research packet JSON. Repository quotations are checked against source paths and lines before acceptance." : "",
      `Local CLI execution boundary: read-only. ${readBoundary} There are no DSH tools. Return plain text to the controller. For production work, return an unapplied patch; do not modify files.`,
    ].join("\n\n");
    const effectiveRoute = effectiveSessionRoute(roleRoute, agent as DshAgent, sessionEvidence);
    const result = await executeRouteSession({ agent: agent as DshAgent, route: effectiveRoute, evidence: sessionEvidence, signal,
      execute: resumeSessionId => executeLocalCli({ route: effectiveRoute, prompt, cwd, signal, resumeSessionId }),
    });
    const metadata = {
      ...(result.sessionAction ? { sessionAction: result.sessionAction, routeSessionId: result.routeSessionId, sessionNotice: result.sessionNotice } : {}),
      ...(result.boundaryStatus ? { boundaryStatus: result.boundaryStatus, boundaryTools: result.boundaryTools } : {}),
      durationMs: result.durationMs,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.cliReportedCostUsd === undefined ? {} : { cliReportedCostUsd: result.cliReportedCostUsd }),
      reasoningEffortVerification: result.reasoningEffortVerification,
      ...(result.deniedActionsCount === undefined ? {} : { deniedActionsCount: result.deniedActionsCount }),
    };
    if (signal.aborted || result.status === "cancelled") return Object.freeze({
      ...metadata, status: "fallback", stopReason: "cancelled", output: [], routeReceiptStatus: "unverified",
      error: "Responsibility cancelled; late output was not accepted.",
    });
    if (result.status !== "completed") return Object.freeze({
      ...metadata, status: "fallback", stopReason: result.status === "timeout" ? "timeout" : "infrastructure-error",
      output: [], routeReceiptStatus: "unverified", error: result.error, taskError: result.error,
    });
    const actualRoute: ModelRoute | undefined = result.actualModel
      ? {
          backend: "local-cli", cli: roleRoute.cli, model: result.actualModel,
          ...(result.reasoningEffortVerification === "verified" && result.actualReasoningEffort !== undefined
            ? { reasoningEffort: result.actualReasoningEffort } : {}),
        } : undefined;
    const effortMismatch = result.reasoningEffortVerification === "mismatch";
    const routeEvidence = {
      ...metadata, ...(actualRoute ? { actualRoute } : {}),
      routeReceiptStatus: effortMismatch || result.modelVerification === "mismatch"
        ? "mismatch" as const : result.modelVerified ? "applied" as const : "unverified" as const,
    };
    if (effortMismatch) {
      const error = result.error ?? `local CLI reasoning effort mismatch: requested ${roleRoute.reasoningEffort}, got ${result.actualReasoningEffort ?? "unknown"}`;
      return Object.freeze({ ...routeEvidence, status: "fallback", stopReason: "route-unverified", output: [], error, routeReceiptError: error });
    }
    if (!result.text.trim()) return Object.freeze({
      ...routeEvidence, status: "fallback", stopReason: "route-empty-output", output: [],
      error: "local CLI completed without textual evidence", taskError: "local CLI completed without textual evidence",
    });
    if (!result.modelVerified) {
      const error = result.error ?? (result.modelVerification === "mismatch"
        ? `local CLI model mismatch: requested ${roleRoute.model}, got ${result.actualModel}`
        : "local CLI did not expose actual model evidence");
      return Object.freeze({ ...routeEvidence, status: "fallback", stopReason: "route-unverified", output: [], error, routeReceiptError: error });
    }
    return Object.freeze({ ...routeEvidence, status: "completed", stopReason: "completed", output: [{ type: "text", text: result.text }] });
  } catch (error) {
    const taskError = error instanceof Error ? error.message : String(error);
    return Object.freeze({ status: "fallback", stopReason: signal.aborted ? "cancelled" : "infrastructure-error", output: [], routeReceiptStatus: "unverified", error: taskError, taskError });
  }
}

export function canonicalPrompt(selection: SkillSelection, child = false, coreInDelegation = false): string {
  const { bundle } = selection;
  const fallback = selection.status === "fallback"
    ? `Selection fallback: ${selection.reasonCode}${selection.detail ? ` (${selection.detail})` : ""}.`
    : undefined;
  return [
    "## odai canonical governance",
    `Canonical source: ${bundle.source} (${bundle.provider})`,
    `Canonical skill: ${bundle.manifest.skillVersion}; runtime contract: ${bundle.manifest.runtimeContract}; governance digest: ${bundle.governance.digest}.`,
    `Bundled orchestration: ${bundle.orchestration.manifest.version}; orchestration digest: ${bundle.orchestration.digest}; composition digest: ${bundle.digest}.`,
    ...(fallback ? [fallback] : []),
    child
      ? "Governance is loaded from the authenticated task snapshot. Act within the supplied delegation scope and host permissions."
      : "Canonical governance is already loaded; do not call the skill tool or read SKILL.md to load it again. Orchestration, when enabled, is provided separately.",
    "",
    coreInDelegation ? "The same-snapshot core is included once in the authenticated parent's responsibility contract below." : child ? bundle.coreContract : bundle.skillBody,
  ].join("\n");
}

export function renderEffectiveRoutingContext(snapshotState: RoutingSnapshotState): string {
  if (snapshotState.error || !snapshotState.snapshot) {
    return [
      "Current effective responsibility mappings: unavailable because the saved routing configuration is invalid.",
      `Configuration error: ${snapshotState.detail}`,
      "Use odai_routing_config only when the user asks to inspect or repair it; do not infer any route.",
    ].join("\n");
  }
  const snapshot = snapshotState.snapshot;
  const mappings = CONFIGURABLE_ROLES.flatMap((role) => {
    const route = snapshot.roles[role];
    if (!route) return [];
    return [`${role}=${describeModelRoute(route)} [${snapshot.sources[role]}]`];
  });
  const dispatch = CONFIGURABLE_ROLES.flatMap((role) => (
    snapshot.dispatch[role]
      ? [`${role}=${snapshot.dispatch[role]} [${snapshot.dispatchSources[role]}]`]
      : []
  ));
  return [
    `Current effective responsibility mappings (runtime-owned; supersedes conversation summaries): ${mappings.join("; ") || "none"}.`,
    `Current explicit dispatch overrides: ${dispatch.join("; ") || "none; legacy defaults apply"}.`,
    ...(Object.values(snapshot.roles).some(route => route?.backend === "local-cli")
      ? ["Local-cli mappings always use child dispatch, including when no explicit override exists; native labels and same-turn upgrades cannot execute them."] : []),
    "These are route targets and dispatch preferences, not evidence that a responsibility ran. Only an actual route receipt proves use; a generic subagent does not.",
  ].join("\n");
}

export function latestRouteReceipt(events: readonly DshEvent[]): Readonly<UnknownRecord> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event?.data;
    if (!data?.routeSource || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) continue;
    if (event.type === "odai/route-fallback") {
      return Object.freeze({
        turn: data.turn,
        step: data.step,
        responsibility: data.responsibility,
        ...(data.responsibilityScopeId ? { responsibilityScopeId: data.responsibilityScopeId } : {}),
        status: "fallback",
        taskStatus: "fallback",
        routeMode: data.routeMode,
        routeSource: data.routeSource,
        fallbackUsed: true,
        requestedRoute: data.requestedRoute,
        ...(data.fallbackRoute ? { actualRoute: data.fallbackRoute } : {}),
        ...(data.error ? { error: data.error } : {}),
      });
    }
    if (event.type === "odai/route-applied") {
      return Object.freeze({
        turn: data.turn,
        step: data.step,
        responsibility: data.responsibility,
        ...(data.responsibilityScopeId ? { responsibilityScopeId: data.responsibilityScopeId } : {}),
        status: data.status,
        routeMode: data.routeMode,
        routeSource: data.routeSource,
        fallbackUsed: data.fallbackUsed,
        requestedRoute: data.requestedRoute,
        ...(data.sessionAction ? { sessionAction: data.sessionAction, routeSessionId: data.routeSessionId, sessionNotice: data.sessionNotice } : {}),
        ...(data.reasoningEffortVerification ? { reasoningEffortVerification: data.reasoningEffortVerification } : {}),
        ...(typeof data.deniedActionsCount === "number" ? { deniedActionsCount: data.deniedActionsCount } : {}),
        ...(data.actualRoute ? { actualRoute: data.actualRoute } : {}),
        ...(data.stopReason ? { stopReason: data.stopReason } : {}),
        ...(data.error ? { error: data.error } : {}),
      });
    }
    if (["odai/route-result", "odai/research-result"].includes(event.type)) {
      const routeReceiptStatus = data.routeReceiptStatus ?? "unverified";
      return Object.freeze({
        turn: data.turn,
        step: data.step,
        responsibility: data.role,
        status: routeReceiptStatus,
        taskStatus: data.status,
        routeMode: "child",
        routeSource: data.routeSource,
        fallbackUsed: routeReceiptStatus !== "applied",
        requestedRoute: data.requestedRoute,
        ...(data.sessionAction ? { sessionAction: data.sessionAction, routeSessionId: data.routeSessionId, sessionNotice: data.sessionNotice } : {}),
        ...(data.reasoningEffortVerification ? { reasoningEffortVerification: data.reasoningEffortVerification } : {}),
        ...(typeof data.deniedActionsCount === "number" ? { deniedActionsCount: data.deniedActionsCount } : {}),
        ...(data.actualRoute ? { actualRoute: data.actualRoute } : {}),
        ...(data.routeReceiptError ? { error: data.routeReceiptError } : {}),
        ...(data.stopReason ? { taskStopReason: data.stopReason } : {}),
        ...(data.error ? { taskError: data.error } : {}),
      });
    }
  }
  return undefined;
}

export function isSubagentSession(agent: DshAgent): boolean {
  const header = agent.session?.header;
  return header?.origin === "subagent"
    || (Number.isSafeInteger(header?.delegationDepth) && (header.delegationDepth ?? 0) > 0);
}

export function routedRoleOf(agent: DshAgent): string | undefined {
  const events = sessionEvents(agent?.session);
  if (events.length === 0) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "subagent/descriptor") continue;
    const label = event.data?.label;
    if (typeof label !== "string") return undefined;
    const match = /^odai-(researcher|planner|reviewer|frontend|creative|writer)(?:$|[\s:])/u.exec(label.trim());
    return match && (ROUTED_ROLES as readonly string[]).includes(match[1]) ? match[1] : undefined;
  }
  return undefined;
}

const ODAI_ADAPTIVE_TOOL_NAMES = new Set<string>([...ODAI_CONTEXTUAL_TOOL_NAMES, ...ODAI_CORE_TOOL_NAMES]);

// Native rc.1 tool instructions have stable section owners. Restrict only those
// owners; never search arbitrary host or workspace prose for words to delete.
const DSH_TOOL_SECTIONS = new Map<string, readonly string[]>([
  ...["bash", "pwsh", "read", "write", "edit", "glob", "grep", "web_search", "web_fetch", "workflow", "ralph", "subagent", "subagent_fork"]
    .map((name): [string, readonly string[]] => [`tool:${name}`, [name]]),
  ["tool:goal", ["create_goal", "get_goal", "update_goal"]],
  ["tool:jobs", ["job_output", "job_list", "job_kill"]],
]);

export function reconcileAdaptiveToolSchemas(
  assembly: PromptAssembly,
  activeNames: readonly string[],
  executableSchemas: readonly ToolSchema[] = [],
  restriction: ToolRestriction = {},
): PromptAssembly {
  if (!assembly || !Array.isArray(assembly.tools)) return assembly;
  const allowed = restriction.allow ? new Set(restriction.allow) : undefined;
  const denied = new Set(restriction.deny ?? []);
  const permitted = (name: string): boolean => (!allowed || allowed.has(name)) && !denied.has(name);
  const active = new Set(activeNames);
  const executableByName = new Map(
    (Array.isArray(executableSchemas) ? executableSchemas : [])
      .filter((tool) => active.has(tool?.name) && permitted(tool.name))
      .map((tool) => [tool.name, tool]),
  );
  const tools = assembly.tools.filter((tool) => permitted(tool.name) && (
    !ODAI_ADAPTIVE_TOOL_NAMES.has(tool?.name)
    || (active.has(tool.name) && executableByName.has(tool.name))
  ));
  const present = new Set(tools.map((tool) => tool?.name));
  const missing = activeNames
    .filter((name) => !present.has(name) && executableByName.has(name))
    .map((name) => executableByName.get(name));
  if (missing.length > 0) {
    const lastAdaptiveIndex = tools.reduce(
      (last, tool, index) => ODAI_ADAPTIVE_TOOL_NAMES.has(tool?.name) ? index : last,
      -1,
    );
    tools.splice(lastAdaptiveIndex < 0 ? tools.length : lastAdaptiveIndex + 1, 0, ...missing);
  }
  let sectionsChanged = false;
  const sections = (Array.isArray(assembly.sections) ? assembly.sections : []).map((section) => {
    if (section.text && DSH_TOOL_SECTIONS.get(section.name)?.some((name) => !permitted(name))) {
      sectionsChanged = true;
      return { ...section, text: "" };
    }
    return section;
  });
  return tools.length === assembly.tools.length && missing.length === 0 && !sectionsChanged
    ? assembly : { ...assembly, tools, ...(sectionsChanged ? { sections } : {}) };
}
