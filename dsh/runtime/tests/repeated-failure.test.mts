import assert from "node:assert/strict";
import test from "node:test";
import { createRepeatedFailureMonitor } from "../build/repeated-failure.mjs";
import type { DshAgent, ToolExecution, ToolResult } from "../build/runtime-types.mjs";

function fixture() {
  const agent: DshAgent = { session: { header: { cwd: "/work" }, snapshotEvents: () => [], append() {} } };
  let task = "task-one";
  let seq = 0;
  const notices: string[] = [];
  const options = { taskFor: () => task, onRepeated(_execution: ToolExecution, notice: string) { notices.push(notice); } };
  const monitor = createRepeatedFailureMonitor(options);
  const call = (name = "bash", args: object = { command: "npm test" }): ToolExecution => ({ agent, name, arguments: args, callId: String(++seq) });
  const finish = (execution: ToolExecution, value: unknown) => monitor.observe(execution, { isError: false, value });
  const run = (exitCode: number, command = "npm test") => {
    const execution = call("bash", { command });
    assert.equal(monitor.start(execution), undefined);
    finish(execution, { exitCode });
  };
  return { agent, monitor, options, notices, call, finish, run, newTask() { task = "task-two"; } };
}

test("expected red tests and repeated experiments are never blocked and receive one review notice", () => {
  const f = fixture();
  for (let n = 0; n < 10; n++) f.run(1);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /may be expected/u);
  f.run(0); f.run(1); f.run(1);
  assert.equal(f.notices.length, 1);
});

test("unrelated successes, reads and edits cannot clear another command's unsuccessful outcomes", () => {
  const f = fixture();
  f.run(1);
  f.run(0, "echo diagnostic");
  f.finish(f.call("read", { file_path: "/unrelated" }), { text: "new text" });
  f.finish(f.call("edit", { file_path: "/unrelated" }), {});
  f.run(1);
  assert.equal(f.notices.length, 1);
});

test("only corresponding successful results reset a streak, and human tasks isolate notices", () => {
  const f = fixture();
  f.run(1); f.run(0); f.run(1);
  assert.equal(f.notices.length, 0);
  f.run(1);
  assert.equal(f.notices.length, 1);
  f.newTask();
  f.run(1);
  assert.equal(f.notices.length, 1);
  f.run(1);
  assert.equal(f.notices.length, 2);
  const other = fixture();
  other.run(1);
  assert.equal(other.notices.length, 0);
});

test("background receipts are associated and deduplicated; running jobs do not imply failure", () => {
  const f = fixture();
  const receipt = (id: string, status: string, detail?: string) => f.finish(f.call("job_output", { job_id: id }), { job: { id, status, detail }, text: "" });
  receipt("unowned", "completed", "exit code: 1");
  for (const id of ["job-one", "job-two"]) {
    const start = f.call("bash", { command: "npm test", run_in_background: true, description: id });
    f.monitor.start(start); f.finish(start, { kind: "background", jobId: id });
    receipt(id, "running");
    assert.equal(f.notices.length, 0);
    receipt(id, "completed", "exit code: 1");
    receipt(id, "completed", "exit code: 1");
  }
  assert.equal(f.notices.length, 1);
});

test("late receipts cannot supersede newer outcomes or tasks, and runtime copies share deduplication", () => {
  const f = fixture();
  const twin = createRepeatedFailureMonitor(f.options);
  const first = f.call();
  f.monitor.start(first); twin.start(first);
  const failure: ToolResult = { isError: false, value: { exitCode: 1 } };
  f.monitor.observe(first, failure); twin.observe(first, failure);
  assert.equal(f.notices.length, 0);
  const old = f.call("bash", { command: "npm test", run_in_background: true });
  f.monitor.start(old); f.finish(old, { kind: "background", jobId: "old" });
  f.run(0);
  f.finish(f.call("job_output"), { job: { id: "old", status: "completed", detail: "exit code: 1" } });
  f.run(1);
  assert.equal(f.notices.length, 0);
  const earlierTask = f.call("bash", { command: "npm test", run_in_background: true });
  f.monitor.start(earlierTask); f.finish(earlierTask, { kind: "background", jobId: "earlier-task" });
  f.newTask();
  f.finish(f.call("job_output"), { job: { id: "earlier-task", status: "completed", detail: "exit code: 1" } });
  f.run(1);
  assert.equal(f.notices.length, 0);
});
