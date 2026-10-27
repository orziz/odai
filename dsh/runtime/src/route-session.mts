import type { LocalCliExecutionResult, LocalCliRoute } from "#odai-local-cli";
import type { DshAgent } from "./runtime-types.mjs";
import type { DshEvent } from "./runtime-types.mjs";
export interface RouteSessionEvidence {
  events(agent: DshAgent): readonly DshEvent[];
  append(agent: DshAgent, type: string, data: object): unknown;
}

// Shared by coexisting runtime instances; durable identities live only in session evidence.
const key = Symbol.for("odai.route-session-queues.v1");
const root = globalThis as typeof globalThis & { [key: symbol]: unknown };
const queues = (root[key] ??= new Map<string, Promise<void>>()) as Map<string, Promise<void>>;
export interface RouteSessionReceipt {
  sessionAction?: "created" | "resumed" | "resume-failed-created";
  routeSessionId?: string;
  sessionNotice?: string;
}
export async function executeRouteSession({ agent, route, evidence, signal, execute }: {
  agent: DshAgent; route: LocalCliRoute; evidence?: RouteSessionEvidence; signal: AbortSignal;
  execute(resumeSessionId?: string): Promise<LocalCliExecutionResult>;
}): Promise<LocalCliExecutionResult & RouteSessionReceipt> {
  if (route.session !== "continue") return execute();
  const dshSessionId = agent.session.header.id;
  if (!dshSessionId || !evidence) throw new Error("会话续接需要 DSH 会话标识和证据存储");
  const routeIdentity = JSON.stringify([route.backend, route.cli, route.model]);
  const queueKey = JSON.stringify([dshSessionId, routeIdentity]);
  const previous = queues.get(queueKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(queueKey, current);
  try {
    await previous;
    signal.throwIfAborted();
    const saved = evidence.events(agent).findLast(event => event.type === "odai/route-session" && event.data.routeIdentity === routeIdentity)?.data;
    const resumeId = typeof saved?.routeSessionId === "string" ? saved.routeSessionId : undefined;
    let result = await execute(resumeId);
    let sessionAction: RouteSessionReceipt["sessionAction"] = resumeId ? "resumed" : "created";
    let sessionNotice: string | undefined;
    if (resumeId && result.status === "error" && !result.boundaryStatus && !signal.aborted) {
      sessionAction = "resume-failed-created";
      sessionNotice = `续接失败，已新开（${result.error ?? "后端拒绝"}）`;
      result = await execute();
    }
    const routeSessionId = result.status === "completed" && typeof result.sessionId === "string" && /^[a-zA-Z0-9-]+$/.test(result.sessionId) ? result.sessionId : undefined;
    // Append even on failure to invalidate stale identities. A unique invocation ID
    // keeps multiple calls at the same turn/step independently auditable.
    evidence.append(agent, "odai/route-session", { routeIdentity, routeSessionId, sessionAction, sessionNotice, status: result.status, invocationId: crypto.randomUUID() });
    if (result.status === "completed" && !routeSessionId) return { ...result, status: "error", error: "后端未提供可续接会话标识", sessionAction, sessionNotice };
    return { ...result, sessionAction, routeSessionId, sessionNotice };
  } finally {
    release();
    if (queues.get(queueKey) === current) queues.delete(queueKey);
  }
}
