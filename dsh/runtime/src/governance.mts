import type { DshAgent, DshEvent, ToolExecution, ToolResult } from "./runtime-types.mjs";

export const DEFAULT_CHILD_DENIED_TOOLS = Object.freeze([
  "write",
  "edit",
  "str_replace_editor",
  "bash",
  "pwsh",
  "ask_user_question",
  "subagent",
  "subagent_fork",
  "subagent_codex",
  "subagent_claude_code",
  "send_message",
  "interrupt_agent",
  "list_agents",
  "workflow",
  "ralph",
  "job_output",
  "job_list",
  "job_kill",
] as const);

export const DEFAULT_PROTECTED_CONTROLLER_ALLOWED_TOOLS = Object.freeze([
  "read",
  "read_image",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "ask_user_question",
  "get_goal",
  "list_agents",
  "job_output",
  "job_list",
  "skill",
  "odai_responsibility_return",
] as const);

export interface ToolGuardOptions {
  additionalDeniedTools?: readonly string[];
  onDenied?(execution: ToolExecution, reason: string): void;
}

export interface RouteProtection {
  readonly turn?: number;
  readonly mode?: "read-only";
  readonly scopeId?: string;
  readonly reasonCode?: string;
}

export interface RouteProtectionGuardOptions extends ToolGuardOptions {
  protectionFor?(agent: DshAgent | undefined): RouteProtection | undefined;
}

export interface ToolResultSummary {
  callId: string;
  rootCallId: string;
  tool: string;
  child: boolean;
  isError: boolean;
  errorCode?: string;
}

export function isSubagent(agent: DshAgent | null | undefined): boolean {
  const header = agent?.session?.header;
  return header?.origin === "subagent"
    || (Number.isSafeInteger(header?.delegationDepth) && (header?.delegationDepth ?? 0) > 0);
}

export function createChildToolGuard(options: ToolGuardOptions = {}): (execution: ToolExecution) => string | undefined {
  const denied = new Set<string>([
    ...DEFAULT_CHILD_DENIED_TOOLS,
    ...(Array.isArray(options.additionalDeniedTools) ? options.additionalDeniedTools : []),
  ]);
  const onDenied = typeof options.onDenied === "function" ? options.onDenied : () => {};

  return (execution) => {
    if (!isSubagent(execution?.agent)) return undefined;
    if (!denied.has(execution?.name)) return undefined;

    const reason = `ODAI_SUBAGENT_BOUNDARY: child agents may not execute ${execution.name}; return evidence to the controller instead.`;
    onDenied(execution, reason);
    return reason;
  };
}

function asRouteProtection(event: DshEvent, turn: number): RouteProtection | undefined {
  const { data } = event;
  if (data.turn !== turn || data.mode !== "read-only") return undefined;
  return {
    turn,
    mode: "read-only",
    ...(typeof data.scopeId === "string" ? { scopeId: data.scopeId } : {}),
    ...(typeof data.reasonCode === "string" ? { reasonCode: data.reasonCode } : {}),
  };
}

export function activeRouteProtection(
  agent: DshAgent | null | undefined,
  recordedEvents: readonly DshEvent[] | undefined = agent?.session?.events,
): RouteProtection | undefined {
  if (isSubagent(agent)) return undefined;
  const events = recordedEvents;
  if (!Array.isArray(events)) return undefined;

  let currentTurn: number | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "odai/route-decided") continue;
    if (!Number.isSafeInteger(event.data?.turn)) return undefined;
    currentTurn = event.data.turn;
    break;
  }
  if (currentTurn === undefined) return undefined;

  const releasedScopes = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "odai/route-protection-released" && event.data?.turn === currentTurn) {
      if (typeof event.data?.scopeId === "string") releasedScopes.add(event.data.scopeId);
      continue;
    }
    if (event?.type !== "odai/route-protection") continue;
    const protection = asRouteProtection(event, currentTurn);
    if (!protection) continue;
    if (protection.scopeId && releasedScopes.has(protection.scopeId)) continue;
    return protection;
  }
  return undefined;
}

export function createRouteProtectionGuard(
  options: RouteProtectionGuardOptions = {},
): (execution: ToolExecution) => string | undefined {
  const allowed = new Set<string>(DEFAULT_PROTECTED_CONTROLLER_ALLOWED_TOOLS);
  for (const name of Array.isArray(options.additionalDeniedTools) ? options.additionalDeniedTools : []) {
    allowed.delete(name);
  }
  const onDenied = typeof options.onDenied === "function" ? options.onDenied : () => {};
  const protectionFor = typeof options.protectionFor === "function"
    ? options.protectionFor
    : activeRouteProtection;

  return (execution) => {
    if (isSubagent(execution?.agent)) return undefined;
    if (allowed.has(execution?.name)) return undefined;
    const protection = protectionFor(execution?.agent);
    if (!protection) return undefined;

    const reasonCode = protection.reasonCode ?? "unresolved-high-impact-route";
    const reason = `ODAI_HIGH_IMPACT_ROUTE_BLOCKED: controller may not execute ${execution.name} while ${reasonCode} remains unresolved; use read-only evidence and provide an actionable decision path.`;
    onDenied(execution, reason);
    return reason;
  };
}

export function summarizeToolResult(execution: ToolExecution, result: ToolResult): ToolResultSummary {
  const summary: ToolResultSummary = {
    callId: String(execution.callId),
    rootCallId: String(execution.rootCallId),
    tool: execution.name,
    child: isSubagent(execution.agent),
    isError: result.isError === true,
  };

  if (result.isError === true && result.error?.code) {
    summary.errorCode = String(result.error.code);
  }

  return summary;
}
