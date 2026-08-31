import { randomUUID } from "node:crypto";

import { renderDelegationPrompt } from "./router.mjs";
import type { RouteDecision } from "./router.mjs";
import type { SkillBundle } from "./skill-bundle.mjs";
import type { ResponsibilityInterruption } from "./responsibility-scope.mjs";
import { CONFIGURABLE_ROLES } from "./routing-config.mjs";
import { ODAI_CONTEXTUAL_TOOL_NAMES, ODAI_CORE_TOOL_NAMES } from "./context-activation.mjs";
import { ROUTED_ROLES } from "./runtime-config.mjs";
import type {
  DshAgent,
  DshContentBlock,
  DshEvent,
  DshMessage,
  ModelRoute,
  ResponsibilityDispatch,
  PromptAssembly,
  RuntimeLogger,
  ToolSchema,
  UnknownRecord,
} from "./runtime-types.mjs";

interface RoutedRunResult {
  stopReason: string;
  output?: readonly DshContentBlock[];
}

interface RequestRouteAgent {
  session?: { events?: readonly DshEvent[] };
}

interface RoutedRun {
  result: Promise<RoutedRunResult>;
  localAgent?: RequestRouteAgent;
  dispose(): Promise<void>;
}

export interface SubagentsService {
  start(provider: string, options: UnknownRecord): Promise<RoutedRun>;
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
}

export interface SkillSelection {
  mode: string;
  status: string;
  reasonCode: string;
  detail?: string;
  bundle: SkillBundle;
  rejections: readonly { source: string; reasonCode: string }[];
  evolution?: {
    status?: string;
    generationId?: string;
    baseDigest?: string;
    upstreamDigest?: string;
    rebaseRequired?: boolean;
  };
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
      kind: "plugin",
      plugin: RUNTIME_NAME,
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
    ...(route ? [`effective route: ${route.provider}/${route.model}`] : []),
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
    "Decision-blocking factual question: Determine whether the user's causal claim is supported and which existing repository facts govern the safety of the requested high-impact change.",
    "Allowed source scope: the current project root only. Use repository-relative paths and read-only source tools; do not inspect parent, sibling, user, or unrelated directories.",
    "Authority and freshness: label each current-checkout source by its actual role (for example runtime configuration, implementation, test, incident record, or documentation). Do not invent an authority hierarchy; report unresolved conflicts and missing freshness evidence as unknowns.",
    "Stop condition: return the smallest packet with 2-6 source-backed facts from at least two files, or stop with the missing evidence boundary. Do not select a route or continue after additional reading cannot change this factual question.",
    "For every fact, excerpt must exactly equal the complete cited source line after trimming leading and trailing whitespace.",
    "",
    "Original user request:",
    taskText,
  ].join("\n");
}

export function roleAgentOptions(roleRoute?: ModelRoute): UnknownRecord | undefined {
  if (!roleRoute) return undefined;
  return {
    provider: roleRoute.provider,
    model: roleRoute.model,
    ...(roleRoute.maxTokens === undefined ? {} : { maxTokens: roleRoute.maxTokens }),
  };
}

export function sameRequestModelRoute(left?: Partial<ModelRoute>, right?: Partial<ModelRoute>): boolean {
  return Boolean(left && right
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort);
}

export function currentAgentStep(agent: DshAgent): number | undefined {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
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
  const events = localAgent?.session?.events;
  if (!Array.isArray(events)) return undefined;
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

export async function runRoutedRole({
  subagents,
  provider,
  decision,
  taskText,
  roleContract,
  agent,
  signal,
  roleRoute,
}: {
  subagents: SubagentsService;
  provider: string;
  decision: Pick<RouteDecision, "role">;
  taskText: string;
  roleContract: string;
  agent: unknown;
  signal: AbortSignal;
  roleRoute?: ModelRoute;
}): Promise<Readonly<RoutedRoleOutcome>> {
  let run: RoutedRun | undefined;
  let outcome: Readonly<RoutedRoleOutcome>;
  try {
    run = await subagents.start(provider, {
      label: `odai-${decision.role}`,
      prompt: [{ type: "text", text: renderDelegationPrompt(decision, taskText, roleContract) }],
      parent: agent,
      signal,
      maxDepth: 1,
      ...(roleRoute ? { agentOptions: roleAgentOptions(roleRoute) } : {}),
    });
    const result = await run.result;
    const actualRoute = latestRequestRoute(run.localAgent);
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
      await run.dispose();
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

  return outcome;
}

export function canonicalPrompt(selection: SkillSelection): string {
  const { bundle } = selection;
  const fallback = selection.status === "fallback"
    ? `Selection fallback: ${selection.reasonCode}${selection.detail ? ` (${selection.detail})` : ""}.`
    : undefined;
  const evolution = selection.evolution?.status === "active"
    ? `User evolution: generation ${selection.evolution.generationId}; base digest ${selection.evolution.baseDigest}; current upstream digest ${selection.evolution.upstreamDigest}; rebase required: ${String(selection.evolution.rebaseRequired)}.`
    : undefined;
  return [
    "## odai canonical governance",
    `Canonical source: ${bundle.source} (${bundle.provider})`,
    `Canonical skill: ${bundle.manifest.skillVersion}; runtime contract: ${bundle.manifest.runtimeContract}; digest: ${bundle.digest}.`,
    ...(evolution ? [evolution] : []),
    ...(fallback ? [fallback] : []),
    "Apply this governance to every request. Keep the controller as the final delivery owner; use another role only for a real independent gap with observable net benefit.",
    "Odai governance is already loaded by this runtime; do not call the skill tool or read SKILL.md to load odai again.",
    "",
    bundle.skillText,
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
    const options = [
      ...(route.reasoningEffort ? [`reasoningEffort=${route.reasoningEffort}`] : []),
      ...(route.maxTokens ? [`maxTokens=${route.maxTokens}`] : []),
    ];
    return [`${role}=${route.provider}/${route.model}${options.length > 0 ? ` (${options.join(", ")})` : ""} [${snapshot.sources[role]}]`];
  });
  const dispatch = CONFIGURABLE_ROLES.flatMap((role) => (
    snapshot.dispatch[role]
      ? [`${role}=${snapshot.dispatch[role]} [${snapshot.dispatchSources[role]}]`]
      : []
  ));
  return [
    `Current effective responsibility mappings (runtime-owned; supersedes conversation summaries): ${mappings.join("; ") || "none"}.`,
    `Current explicit dispatch overrides: ${dispatch.join("; ") || "none; legacy defaults apply"}.`,
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
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "subagent/descriptor") continue;
    const label = event.data?.label;
    if (typeof label !== "string") return undefined;
    const match = /^odai-(researcher|planner|reviewer|frontend)(?:$|[\s:])/u.exec(label.trim());
    return match && (ROUTED_ROLES as readonly string[]).includes(match[1]) ? match[1] : undefined;
  }
  return undefined;
}

const ODAI_ADAPTIVE_TOOL_NAMES = new Set<string>([...ODAI_CONTEXTUAL_TOOL_NAMES, ...ODAI_CORE_TOOL_NAMES]);

export function reconcileAdaptiveToolSchemas(
  assembly: PromptAssembly,
  activeNames: readonly string[],
  executableSchemas: readonly ToolSchema[] = [],
): PromptAssembly {
  if (!assembly || !Array.isArray(assembly.tools)) return assembly;
  const active = new Set(activeNames);
  const executableByName = new Map(
    (Array.isArray(executableSchemas) ? executableSchemas : [])
      .filter((tool) => active.has(tool?.name))
      .map((tool) => [tool.name, tool]),
  );
  const tools = assembly.tools.filter((tool) => !ODAI_ADAPTIVE_TOOL_NAMES.has(tool?.name)
    || (active.has(tool.name) && executableByName.has(tool.name)));
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
  return tools.length === assembly.tools.length && missing.length === 0 ? assembly : { ...assembly, tools };
}
