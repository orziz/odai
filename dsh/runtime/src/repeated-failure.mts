import { createHash } from "node:crypto";
import type { DshAgent, DshSession, ToolExecution, ToolResult } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

type Attempt = { key: string; epoch: number; sequence: number };
type Outcomes = { sequence: number; code?: string; count: number; notified: boolean };
interface State {
  session: DshSession;
  task?: string;
  epoch: number;
  sequence: number;
  outcomes: Map<string, Outcomes>;
  calls: Map<string, Attempt>;
  jobs: Map<string, Attempt>;
}
const shared = globalThis as typeof globalThis & { __odaiRepeatedFailureMonitors?: WeakMap<DshAgent, State> };
const states = shared.__odaiRepeatedFailureMonitors ??= new WeakMap<DshAgent, State>();
const commands = new Set(["bash", "pwsh"]);

function commandKey(execution: ToolExecution): string | undefined {
  if (!commands.has(execution.name) || !isUnknownRecord(execution.arguments)) return undefined;
  const args = { ...execution.arguments };
  delete args.description;
  delete args.run_in_background;
  args.workdir ??= execution.agent?.session.header.cwd;
  try {
    return createHash("sha256").update(JSON.stringify([execution.name,
      Object.keys(args).sort().map((key) => [key, args[key]])])).digest("hex");
  } catch { return undefined; }
}
function bound<K, V>(map: Map<K, V>): void {
  if (map.size > 128) map.delete(map.keys().next().value!);
}

/** Repeated unsuccessful outcomes are a review signal, not proof that a retry is wrong. */
export function createRepeatedFailureMonitor(options: {
  taskFor(agent: DshAgent): string | undefined;
  onRepeated(execution: ToolExecution & { agent: DshAgent }, notice: string): void;
}) {
  function stateFor(agent: DshAgent): State {
    const task = options.taskFor(agent);
    let state = states.get(agent);
    if (!state || state.session !== agent.session) {
      state = { session: agent.session, task, epoch: 0, sequence: 0, outcomes: new Map(), calls: new Map(), jobs: new Map() };
      states.set(agent, state);
    } else if (task && task !== state.task) {
      state.task = task;
      state.epoch += 1;
      state.outcomes.clear();
    }
    return state;
  }
  function record(state: State, attempt: Attempt, code: string | undefined,
    execution: ToolExecution & { agent: DshAgent }): void {
    if (attempt.epoch !== state.epoch) return;
    const prior = state.outcomes.get(attempt.key);
    if (prior && attempt.sequence < prior.sequence) return;
    const outcome: Outcomes = {
      sequence: attempt.sequence, code,
      count: code === undefined ? 0 : prior?.code === code ? prior.count + 1 : 1,
      notified: prior?.notified ?? false,
    };
    state.outcomes.set(attempt.key, outcome);
    bound(state.outcomes);
    if (outcome.count < 2 || outcome.notified) return;
    outcome.notified = true;
    options.onRepeated(execution, "ODAI_RETRY_REVIEW: repeated unsuccessful outcomes were observed for this command. Nonzero exits may be expected in tests or experiments. Check whether another retry serves the task; continue when justified. This notice does not block execution or require user approval.");
  }
  return {
    start(execution: ToolExecution): undefined {
      const key = commandKey(execution);
      if (!execution.agent || !key || !execution.callId) return undefined;
      const state = stateFor(execution.agent);
      if (!state.calls.has(execution.callId)) {
        state.calls.set(execution.callId, { key, epoch: state.epoch, sequence: ++state.sequence });
        bound(state.calls);
      }
      return undefined;
    },
    observe(execution: ToolExecution, result: ToolResult): void {
      const agent = execution.agent;
      if (!agent) return;
      const state = stateFor(agent);
      const value = isUnknownRecord(result.value) ? result.value : undefined;
      const attempt = execution.callId ? state.calls.get(execution.callId) : undefined;
      if (execution.callId) state.calls.delete(execution.callId);
      if (attempt) {
        if (value?.kind === "background" && typeof value.jobId === "string") {
          state.jobs.set(value.jobId, attempt);
          bound(state.jobs);
        } else if (result.isError === true) record(state, attempt, `error:${result.error?.code ?? "unknown"}`, { ...execution, agent });
        else if (typeof value?.exitCode === "number") record(state, attempt,
          value.exitCode === 0 ? undefined : `exit:${value.exitCode}`, { ...execution, agent });
        return;
      }
      if (execution.name !== "job_output" || !value || !isUnknownRecord(value.job)) return;
      const job = value.job;
      if (typeof job.id !== "string" || job.status === "running" || job.status === "stopping") return;
      const pending = state.jobs.get(job.id);
      state.jobs.delete(job.id);
      if (!pending) return;
      const exit = typeof job.detail === "string" ? /^exit code: (\d+)$/u.exec(job.detail) : null;
      if (exit) record(state, pending, Number(exit[1]) === 0 ? undefined : `exit:${Number(exit[1])}`, { ...execution, agent });
    },
  };
}
