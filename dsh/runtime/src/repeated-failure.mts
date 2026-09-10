import { createHash } from "node:crypto";
import type { DshAgent, DshSession, ToolExecution, ToolResult } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

type Attempt = { key: string; epoch: number };
interface State {
  session: DshSession;
  task?: string;
  epoch: number;
  failures: Map<string, { code: string; count: number }>;
  calls: Map<string, Attempt>;
  jobs: Map<string, Attempt>;
  observations: Set<string>;
}
const shared = globalThis as typeof globalThis & { __odaiRepeatedFailures?: WeakMap<DshAgent, State> };
const states = shared.__odaiRepeatedFailures ??= new WeakMap<DshAgent, State>();
const commands = new Set(["bash", "pwsh"]);
const diagnostics = new Set(["read", "read_image", "glob", "grep", "web_search", "web_fetch"]);

function digest(value: unknown): string | undefined {
  try { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); } catch { return undefined; }
}
function commandKey(execution: ToolExecution): string | undefined {
  if (!commands.has(execution.name) || !isUnknownRecord(execution.arguments)) return undefined;
  const args = { ...execution.arguments };
  delete args.description;
  delete args.run_in_background;
  args.workdir ??= execution.agent?.session.header.cwd;
  return digest([execution.name, Object.keys(args).sort().map((key) => [key, args[key]])]);
}
function bound<K, V>(map: Map<K, V>): void {
  if (map.size > 128) map.delete(map.keys().next().value!);
}
function advance(state: State): void { state.epoch += 1; state.failures.clear(); }
function record(state: State, attempt: Attempt, code: string): void {
  if (attempt.epoch !== state.epoch) return;
  const prior = state.failures.get(attempt.key);
  state.failures.set(attempt.key, { code, count: prior?.code === code ? prior.count + 1 : 1 });
  bound(state.failures);
}

/** A narrow retry guard, not a judgement of task progress or a token budget. */
export function createRepeatedFailureGuard(options: {
  taskFor(agent: DshAgent): string | undefined;
  onDenied(execution: ToolExecution & { agent: DshAgent }, reason: string): void;
}) {
  function stateFor(agent: DshAgent): State {
    const task = options.taskFor(agent);
    let state = states.get(agent);
    if (!state || state.session !== agent.session) {
      state = { session: agent.session, task, epoch: 0, failures: new Map(), calls: new Map(), jobs: new Map(), observations: new Set() };
      states.set(agent, state);
    } else if (task && task !== state.task) {
      state.task = task;
      advance(state);
      state.observations.clear();
    }
    return state;
  }
  return {
    check(execution: ToolExecution): string | undefined {
      const agent = execution.agent;
      const key = commandKey(execution);
      if (!agent || !key || !execution.callId) return undefined;
      const state = stateFor(agent);
      if ((state.failures.get(key)?.count ?? 0) >= 2) {
        const reason = "ODAI_REPEATED_FAILURE: this command has failed twice with the same failure status since the last new diagnostic result or successful change. Inspect the actual error or fix its prerequisite before retrying; do not disguise the same command to bypass this guard. The task remains unfinished.";
        options.onDenied({ ...execution, agent }, reason);
        return reason;
      }
      state.calls.set(execution.callId, { key, epoch: state.epoch });
      bound(state.calls);
      return undefined;
    },
    observe(execution: ToolExecution, result: ToolResult): void {
      if (!execution.agent) return;
      const state = stateFor(execution.agent);
      const value = isUnknownRecord(result.value) ? result.value : undefined;
      const attempt = execution.callId ? state.calls.get(execution.callId) : undefined;
      if (execution.callId) state.calls.delete(execution.callId);
      if (attempt) {
        if (value?.kind === "background" && typeof value.jobId === "string") {
          state.jobs.set(value.jobId, attempt);
          bound(state.jobs);
        } else if (result.isError === true) {
          record(state, attempt, `error:${result.error?.code ?? "unknown"}`);
        } else if (typeof value?.exitCode === "number" && value.exitCode !== 0) {
          record(state, attempt, `exit:${value.exitCode}`);
        } else if (value?.exitCode === 0 && attempt.epoch === state.epoch) advance(state);
        return;
      }
      if (execution.name === "job_output" && value && isUnknownRecord(value.job)) {
        const job = value.job;
        if (typeof job.id !== "string" || job.status === "running" || job.status === "stopping") return;
        const pending = state.jobs.get(job.id);
        state.jobs.delete(job.id);
        if (!pending) return;
        const exit = typeof job.detail === "string" ? /^exit code: (\d+)$/u.exec(job.detail) : null;
        if (exit && Number(exit[1]) !== 0) record(state, pending, `exit:${Number(exit[1])}`);
        else if (exit && pending.epoch === state.epoch) advance(state);
        return;
      }
      if (result.isError !== false) return;
      if (execution.name === "edit" || execution.name === "write") advance(state);
      else if (diagnostics.has(execution.name)) {
        const observation = digest([execution.name, execution.arguments, result.value ?? result.output]);
        if (!observation || state.observations.has(observation)) return;
        state.observations.add(observation);
        if (state.observations.size > 128) state.observations.delete(state.observations.values().next().value!);
        advance(state);
      }
    },
  };
}
