import assert from "node:assert/strict";
import test from "node:test";
import { createRepeatedFailureGuard } from "../build/repeated-failure.mjs";
import type { DshAgent, ToolExecution, ToolResult } from "../build/runtime-types.mjs";

function fixture() {
  const agent: DshAgent = { session: { header: { cwd: "/work" }, snapshotEvents: () => [], append() {} } };
  let task = "task-one";
  let seq = 0;
  const guard = createRepeatedFailureGuard({ taskFor: () => task, onDenied() {} });
  const call = (name = "bash", args: object = { command: "npm test" }): ToolExecution => ({ agent, name, arguments: args, callId: String(++seq) });
  const finish = (execution: ToolExecution, value: unknown) => guard.observe(execution, { isError: false, value });
  const fail = () => { const execution = call(); assert.equal(guard.check(execution), undefined); finish(execution, { exitCode: 1 }); };
  const diagnostic = (text: string) => finish(call("read", { file_path: "/work/failure.log" }), { text });
  return { agent, guard, call, finish, fail, diagnostic, newTask() { task = "task-two"; } };
}

test("repeated failures require a new diagnostic or change, without blocking investigation", () => {
  const f = fixture();
  f.diagnostic("first failure log");
  f.fail(); f.fail();
  assert.match(f.guard.check(f.call()) ?? "", /ODAI_REPEATED_FAILURE/u);
  f.diagnostic("first failure log");
  assert.match(f.guard.check(f.call()) ?? "", /ODAI_REPEATED_FAILURE/u);
  assert.equal(f.guard.check(f.call("read", { file_path: "/work/config.json" })), undefined);
  f.diagnostic("different failure log");
  f.fail(); f.fail();
  f.finish(f.call("edit", { file_path: "/work/config.json" }), {});
  assert.equal(f.guard.check(f.call()), undefined);
});

test("new commands, successful verification and new human tasks remain available", () => {
  const f = fixture();
  f.fail();
  const success = f.call();
  f.guard.check(success);
  f.finish(success, { exitCode: 0, stdout: "[exit code: 1]" });
  f.fail();
  assert.equal(f.guard.check(f.call()), undefined);
  f.fail();
  assert.match(f.guard.check(f.call()) ?? "", /ODAI_REPEATED_FAILURE/u);
  assert.equal(f.guard.check(f.call("bash", { command: "npm run targeted-check" })), undefined);
  f.newTask();
  assert.equal(f.guard.check(f.call()), undefined);
});

test("background launches count only their terminal receipts, once per owned job", () => {
  const f = fixture();
  const receipt = (id: string, status: string, detail?: string) => f.finish(f.call("job_output", { job_id: id }), { job: { id, status, detail }, text: "" });
  for (const id of ["job-one", "job-two"]) {
    const start = f.call("bash", { command: "npm test", run_in_background: true, description: id });
    assert.equal(f.guard.check(start), undefined);
    f.finish(start, { kind: "background", jobId: id });
    receipt(id, "running");
    assert.equal(f.guard.check(f.call()), undefined);
    receipt(id, "completed", "exit code: 1");
    receipt(id, "completed", "exit code: 1");
  }
  assert.match(f.guard.check(f.call()) ?? "", /ODAI_REPEATED_FAILURE/u);
  f.newTask();
  receipt("unowned-job", "completed", "exit code: 1");
  f.fail();
  assert.equal(f.guard.check(f.call()), undefined);
});

test("late receipts cannot undo intervening fixes and duplicated runtimes do not double-count", () => {
  const f = fixture();
  const twin = createRepeatedFailureGuard({ taskFor: () => "task-one", onDenied() {} });
  const start = f.call();
  f.guard.check(start); twin.check(start);
  const failure: ToolResult = { isError: false, value: { exitCode: 1 } };
  f.guard.observe(start, failure); twin.observe(start, failure);
  assert.equal(f.guard.check(f.call()), undefined);
  const background = f.call("bash", { command: "npm test", run_in_background: true });
  f.guard.check(background); f.finish(background, { kind: "background", jobId: "old" });
  f.finish(f.call("write"), {});
  f.finish(f.call("job_output"), { job: { id: "old", status: "completed", detail: "exit code: 1" } });
  f.fail();
  assert.equal(f.guard.check(f.call()), undefined);
  const other = fixture();
  assert.equal(other.guard.check(other.call()), undefined);
});
