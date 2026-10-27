import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  validateLocalCliRoute, buildLocalCliInvocation, parseLocalCliResult, executeLocalCli,
} from "../../../skills/odai-orchestration/scripts/local-cli.mjs";

const route = { backend: "local-cli", cli: "claude", model: "haiku" };
const model = "claude-haiku-4-5-20251001";
function payload(overrides = {}) {
  return JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "Review complete",
    modelUsage: { [model]: { outputTokens: 52, canonicalModel: "claude-haiku-4-5" } },
    usage: { input_tokens: 531, output_tokens: 52 }, total_cost_usd: 0.016755,
    ...overrides,
  });
}

function fakeProcess(run, { ignoreTerm = false } = {}) {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  const input = [];
  child.stdin.on("data", (chunk) => input.push(chunk));
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL" || !ignoreTerm) queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  let invocation;
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    queueMicrotask(() => run?.(child));
    return child;
  };
  return { child, signals, spawnProcess, input: () => Buffer.concat(input).toString(), invocation: () => invocation };
}
function execute(fake, options = {}) {
  return executeLocalCli({ route, prompt: "Read files and return advice", cwd: process.cwd(), spawnProcess: fake.spawnProcess, ...options });
}

test("local CLI route validation preserves omitted timeout and supports Claude efforts", () => {
  assert.deepEqual(validateLocalCliRoute(route), route);
  for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(validateLocalCliRoute({ ...route, reasoningEffort, timeoutSeconds: 7200 }).reasoningEffort, reasoningEffort);
  }
  for (const invalid of [
    null, [], {}, { ...route, backend: "api" }, { ...route, cli: undefined },
    { ...route, model: undefined }, { ...route, model: " " }, { ...route, model: "bad\0model" },
    { ...route, provider: "anthropic" }, { ...route, provider: undefined }, { ...route, maxTokens: 10 },
    { ...route, reasoningEffort: "minimal" }, { ...route, reasoningEffort: null }, { ...route, extra: true },
    ...[0, -1, 1.5, 7201, Infinity, NaN, "1200", null].map((timeoutSeconds) => ({ ...route, timeoutSeconds })),
  ]) assert.throws(() => validateLocalCliRoute(invalid), TypeError);
  assert.throws(() => validateLocalCliRoute({ ...route, cli: "gemini" }), /本版本尚未支持.*antigravity/);
  for (const cli of ["claude", "codex", "antigravity", "grok"]) {
    for (const model of ["-model", "--help", " haiku", "haiku ", "a b", "a\tb", "a\nb", "a\u007fb", "a\u0085b", "a\u200bb"]) {
      assert.throws(() => validateLocalCliRoute({ ...route, cli, model }), /model/);
    }
  }
});

test("invocation fixes read-only flags and treats executable and model as single arguments", () => {
  const configured = { ...route, model: "model;echo-secret", reasoningEffort: "high" };
  assert.deepEqual(buildLocalCliInvocation(configured, { ODAI_CLAUDE_COMMAND: "/path with spaces/claude" }), {
    command: "/path with spaces/claude",
    args: ["-p", "--output-format", "json", "--model", configured.model, "--effort", "high", "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--no-session-persistence"],
  });
  assert.equal(buildLocalCliInvocation(route, {}).command, "claude");
  assert.equal(buildLocalCliInvocation(route, {}).args.includes("--effort"), false);
  assert.equal(buildLocalCliInvocation(route, {}).args.includes("--bare"), false);
});

test("parser preserves text, usage, cost and verified model evidence", () => {
  const result = parseLocalCliResult(payload(), "haiku");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Review complete");
  assert.equal(result.actualModel, model);
  assert.equal(result.modelVerified, true);
  assert.equal(result.modelVerification, "verified");
  assert.equal(result.reasoningEffortVerification, "requested-only");
  assert.deepEqual(result.usage, { input_tokens: 531, output_tokens: 52 });
  assert.equal(result.cliReportedCostUsd, 0.016755);
});

test("model evidence verifies the requested model among helper usage and applies alias and full-ID rules", () => {
  const stdout = payload({ modelUsage: {
    "claude-sonnet-4-6": { outputTokens: 10 },
    [model]: { outputTokens: 80, canonicalModel: "claude-haiku-4-5" },
  } });
  for (const requested of ["haiku", model, "claude-haiku-4-5"]) {
    assert.equal(parseLocalCliResult(stdout, requested).modelVerified, true);
  }
  // The requested model ran even though another entry produced more output.
  const sonnet = parseLocalCliResult(stdout, "sonnet");
  assert.equal(sonnet.modelVerified, true);
  assert.equal(sonnet.actualModel, "claude-sonnet-4-6");
  // Absent: the busiest entry is reported as the mismatching actual model.
  const opus = parseLocalCliResult(stdout, "opus");
  assert.equal(opus.modelVerification, "mismatch");
  assert.equal(opus.actualModel, model);
  assert.equal(parseLocalCliResult(stdout, "claude-haiku-4").modelVerified, true);
  assert.equal(parseLocalCliResult(stdout, "claude-hai").modelVerified, false);
  const canonicalAlias = payload({ modelUsage: { opaque: { outputTokens: 2, canonicalModel: "claude-haiku-4-5" } } });
  assert.equal(parseLocalCliResult(canonicalAlias, "haiku").modelVerified, true);
  assert.equal(parseLocalCliResult(canonicalAlias, "claude-haiku-4-5").modelVerified, true);
});

test("a Claude Code helper call outproducing a short routed answer is not a mismatch", () => {
  // Observed 2026-10-15 with `--model opus` and the reply "OK".
  const stdout = payload({ result: "OK", modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 521, outputTokens: 13, canonicalModel: "claude-haiku-4-5" },
    "claude-opus-5": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 2800, cacheCreationInputTokens: 3406, canonicalModel: "claude-opus-5" },
  } });
  const result = parseLocalCliResult(stdout, "opus");
  assert.equal(result.modelVerified, true);
  assert.equal(result.actualModel, "claude-opus-5");
  assert.equal(parseLocalCliResult(stdout, "claude-opus-5").modelVerified, true);
  assert.equal(parseLocalCliResult(stdout, "claude-opus-5-5").modelVerification, "mismatch");
});

test("missing and mismatched evidence stay distinguishable from process failure", () => {
  const mismatch = parseLocalCliResult(payload(), "opus");
  assert.equal(mismatch.status, "completed");
  assert.equal(mismatch.modelVerified, false);
  assert.equal(mismatch.modelVerification, "mismatch");
  assert.equal(mismatch.actualModel, model);
  for (const modelUsage of [undefined, {}, [], null, { model: null }]) {
    const result = parseLocalCliResult(payload({ modelUsage, model: "haiku", result: "I am haiku" }), "haiku");
    assert.equal(result.status, "completed");
    assert.equal(result.modelVerified, false);
    assert.equal(result.modelVerification, "missing");
    assert.equal(result.actualModel, undefined);
  }
});

test("parser reports CLI and JSON errors but leaves empty text to the host", () => {
  for (const stdout of ["not JSON", "[]", "null", payload({ is_error: true }), payload({ subtype: "error_max_turns" }), payload({ subtype: undefined })]) {
    const result = parseLocalCliResult(stdout, "haiku");
    assert.equal(result.status, "error");
    assert.ok(result.error);
  }
  const failure = parseLocalCliResult(payload({ is_error: true, errors: ["not logged in"] }), "haiku");
  assert.match(failure.error, /not logged in/);
  assert.equal(parseLocalCliResult(payload({ result: "" }), "haiku").status, "completed");
  assert.equal(parseLocalCliResult(payload({ result: "" }), "haiku").text, "");
});

test("execution sends prompt only over stdin, passes cwd/env and parses completed output", async () => {
  const fake = fakeProcess((child) => { child.stdout.write(payload()); child.emit("close", 0, null); });
  const prompt = "private prompt $(touch should-not-run)";
  const env = { ODAI_CLAUDE_COMMAND: "/fake/claude", PATH: "/fake/bin" };
  const result = await execute(fake, { prompt, env });
  assert.equal(result.status, "completed");
  assert.equal(result.actualModel, model);
  assert.ok(result.durationMs >= 0);
  assert.equal(fake.input(), prompt);
  assert.equal(fake.invocation().args.includes(prompt), false);
  assert.equal(fake.invocation().command, "/fake/claude");
  assert.equal(fake.invocation().options.cwd, process.cwd());
  assert.equal(fake.invocation().options.env, env);
  assert.equal(fake.invocation().options.shell, false);
  assert.deepEqual(fake.invocation().options.stdio, ["pipe", "pipe", "pipe"]);
});

test("execution handles launch errors, process failures and bounded stderr", async () => {
  const failedSpawn = fakeProcess((child) => { child.pid = undefined; child.emit("error", new Error("ENOENT")); });
  assert.match((await execute(failedSpawn)).error, /ENOENT/);
  const throws = await executeLocalCli({ route, prompt: "test", cwd: process.cwd(), spawnProcess() { throw new Error("spawn failed"); } });
  assert.equal(throws.status, "error");
  assert.match(throws.error, /spawn failed/);
  const fake = fakeProcess((child) => {
    child.stderr.write(`${"x".repeat(20_000)} useful failure tail`);
    child.stdout.write(payload());
    child.emit("close", 2, null);
  });
  const result = await execute(fake);
  assert.equal(result.status, "error");
  assert.match(result.error, /code 2/);
  assert.match(result.error, /useful failure tail$/);
  assert.ok(result.error.length < 2100);
  assert.equal(result.text, "");
});

test("execution retains actual exit codes independently of output verification and cancellation", async () => {
  for (const [code, stdout, status] of [[0, payload(), "completed"], [0, "invalid JSON", "error"], [7, payload(), "error"], [null, "", "error"]]) {
    const fake = fakeProcess((child) => { child.stdout.write(stdout); child.emit("close", code, code === null ? "SIGTERM" : null); });
    const result = await execute(fake);
    assert.equal(result.exitCode, code);
    assert.equal(result.status, status);
  }
  const failedSpawn = fakeProcess((child) => { child.pid = undefined; child.emit("error", new Error("ENOENT")); });
  assert.equal((await execute(failedSpawn)).exitCode, null);
  const controller = new AbortController();
  const fake = fakeProcess((child) => { controller.abort(); child.emit("close", 23, null); }, { ignoreTerm: true });
  const cancelled = await execute(fake, { signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.exitCode, 23);
  assert.equal((await execute(fakeProcess(), { signal: controller.signal })).exitCode, null);
});

test("stdout is capped in bytes and an overproducing process is terminated", async () => {
  const fake = fakeProcess((child) => child.stdout.write("界".repeat(20)), { ignoreTerm: true });
  const result = await execute(fake, { maxOutputBytes: 50, killGraceMs: 5 });
  assert.equal(result.status, "error");
  assert.match(result.error, /output limit/);
  assert.equal(result.text, "");
  assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
});

test("pre-cancelled execution never starts a process", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await executeLocalCli({ route, prompt: "x", cwd: process.cwd(), signal: controller.signal, spawnProcess() { calls += 1; throw new Error("must not start"); } });
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 0);
});

test("cancellation escalates SIGTERM to SIGKILL and discards late success", async () => {
  const controller = new AbortController();
  const fake = fakeProcess((child) => {
    controller.abort();
    child.stdout.write(payload());
  }, { ignoreTerm: true });
  const result = await execute(fake, { signal: controller.signal, killGraceMs: 5 });
  assert.equal(result.status, "cancelled");
  assert.equal(result.text, "");
  assert.equal(result.modelVerified, false);
  assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
});

test("graceful cancellation stops after SIGTERM", async () => {
  const controller = new AbortController();
  const fake = fakeProcess(() => controller.abort());
  const result = await execute(fake, { signal: controller.signal, killGraceMs: 5 });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(fake.signals, ["SIGTERM"]);
});

test("timeout kills an actual fake child that ignores SIGTERM before resolving", { skip: process.platform === "win32" }, async () => {
  let child;
  let ready = false;
  const signals = [];
  const result = await executeLocalCli({
    route: { ...route, timeoutSeconds: 1 }, prompt: "test", cwd: process.cwd(), killGraceMs: 20,
    spawnProcess(_command, _args, options) {
      child = spawn(process.execPath, ["--input-type=module", "-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], options);
      child.stdout.once("data", () => { ready = true; });
      const kill = child.kill.bind(child);
      child.kill = (signal) => { signals.push(signal); return kill(signal); };
      return child;
    },
  });
  assert.equal(ready, true);
  assert.equal(result.status, "timeout");
  assert.equal(result.text, "");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("group escalation survives a leader closing its pipes before the grace period", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  const fake = fakeProcess(() => controller.abort());
  const signals = [];
  let closed = false;
  let closedBeforeKill = false;
  fake.child.on("close", () => { closed = true; });
  const result = await execute(fake, {
    signal: controller.signal, killGraceMs: 5,
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGTERM") queueMicrotask(() => fake.child.emit("close", 0, null));
      else closedBeforeKill = closed;
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(fake.invocation().options.detached, true);
  assert.equal(closedBeforeKill, true, "SIGKILL must still be sent after close");
  assert.deepEqual(signals, [[-fake.child.pid, "SIGTERM"], [-fake.child.pid, "SIGKILL"]]);
  assert.deepEqual(fake.signals, [], "the OS signal seam must own fake group termination");
});

async function assertProcessStopped(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, "the grandchild must have started");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        // A killed orphan can remain a zombie until the container's init reaps it.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return;
      }
    } catch (error) {
      if (error.code === "ESRCH" || error.code === "ENOENT") return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`grandchild ${pid} remained alive after group termination`);
}

for (const inheritPipes of [true, false]) {
  for (const stopReason of ["timeout", "cancelled"]) {
    test(`${stopReason} terminates wrapper descendants with ${inheritPipes ? "inherited" : "independent"} pipes`, {
      skip: process.platform === "win32", timeout: 5000,
    }, async (t) => {
      const controller = new AbortController();
      const signals = [];
      let child;
      let grandchildPid;
      let leaderClosed = false;
      let closedBeforeKill = false;
      // The wrapper exits on SIGTERM; its descendant ignores it and outlives it.
      const descendantSource = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send({ pid: process.pid });';
      const wrapperSource = `
        import { spawn } from "node:child_process";
        process.on("SIGTERM", () => process.exit(0));
        const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], {
          stdio: ["ignore", ${JSON.stringify(inheritPipes ? "inherit" : "ignore")}, ${JSON.stringify(inheritPipes ? "inherit" : "ignore")}, "ipc"],
        });
        child.on("message", message => process.stdout.write(JSON.stringify(message) + "\\n"));
      `;
      t.after(() => {
        controller.abort();
        if (child?.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          child.kill("SIGKILL");
        }
        if (grandchildPid) {
          try { process.kill(grandchildPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      });
      const result = await executeLocalCli({
        route: { ...route, timeoutSeconds: 1 }, prompt: "test", cwd: process.cwd(),
        signal: controller.signal, killGraceMs: 100,
        spawnProcess(_command, _args, options) {
          assert.equal(options.detached, true);
          child = spawn(process.execPath, ["--input-type=module", "-e", wrapperSource], options);
          child.on("close", () => { leaderClosed = true; });
          let ready = "";
          child.stdout.on("data", (chunk) => {
            ready += chunk;
            if (!grandchildPid && ready.includes("\n")) {
              grandchildPid = JSON.parse(ready.trim()).pid;
              if (stopReason === "cancelled") controller.abort();
            }
          });
          return child;
        },
        killProcess(pid, signal) {
          signals.push([pid, signal]);
          if (signal === "SIGKILL") closedBeforeKill = leaderClosed;
          return process.kill(pid, signal);
        },
      });
      assert.equal(result.status, stopReason);
      assert.equal(result.text, "");
      assert.equal(result.modelVerified, false);
      assert.deepEqual(signals, [[-child.pid, "SIGTERM"], [-child.pid, "SIGKILL"]]);
      if (!inheritPipes) assert.equal(closedBeforeKill, true, "leader close must not cancel group escalation");
      await assertProcessStopped(grandchildPid);
    });
  }
}


const codexRoute = { backend: "local-cli", cli: "codex", model: "gpt-6.1-sol", reasoningEffort: "low" };
const agyRoute = { backend: "local-cli", cli: "antigravity", model: "gemini-3.8-flash-medium" };
const grokRoute = { backend: "local-cli", cli: "grok", model: "grok-code", reasoningEffort: "none" };
const threadId = "01a13d65-468d-7e71-a6f4-5ae3f0d6b2d9";
const ndjson = (...events) => events.map((event) => JSON.stringify(event)).join("\n");
const codexOutput = ndjson(
  { type: "thread.started", thread_id: threadId },
  { type: "item.completed", item: { type: "agent_message", text: "Earlier message" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "marker-7781" } },
  { type: "turn.completed", usage: { input_tokens: 33621, cached_input_tokens: 26368, output_tokens: 84, reasoning_output_tokens: 24 } },
);
const agyOutput = (result = {}, init = { model: agyRoute.model }) => ndjson(
  { event: "init", conversation_id: "b8ec26a5-test", init },
  { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n" } },
  { event: "result", result: { conversation_id: "b8ec26a5-test", status: "SUCCESS", response: "OK\n", duration_seconds: 4.81, num_turns: 1, usage: { input_tokens: 13175, output_tokens: 90, thinking_tokens: 89 }, ...result } },
);
const grokOutput = (overrides = {}) => JSON.stringify({ text: "OK", stopReason: "EndTurn", sessionId: "grok-session", requestId: "request-1", ...overrides });

function evidenceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "odai-local-evidence-"));
  // Only remove the exact mkdtemp fixture owned by this test.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const env = { HOME: root, CODEX_HOME: join(root, "codex"), HTTPS_PROXY: "http://127.0.0.1:7890" };
  const sessions = join(env.CODEX_HOME, "sessions", "2026", "10", "15");
  mkdirSync(sessions, { recursive: true });
  const codexFile = join(sessions, `rollout-2026-10-15-${threadId}.jsonl`);
  const session = (meta = {}, context = {}) => writeFileSync(codexFile, ndjson(
    { type: "session_meta", payload: { id: threadId, cwd, ...meta } },
    { type: "turn_context", payload: { model: "old-model", effort: "high" } },
    { type: "turn_context", payload: { cwd, model: codexRoute.model, effort: "low", ...context } },
  ));
  const grokDir = join(root, ".grok", "sessions", encodeURIComponent(cwd), "grok-session");
  mkdirSync(grokDir, { recursive: true });
  const summaryFile = join(grokDir, "summary.json");
  const summary = (value = { model: grokRoute.model }) => writeFileSync(summaryFile, JSON.stringify(value));
  return { root, cwd, env, sessions, codexFile, session, summary, summaryFile };
}

test("adapter effort validation follows each CLI contract", () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "future"]) {
    assert.equal(validateLocalCliRoute({ ...codexRoute, reasoningEffort: effort }).reasoningEffort, effort);
  }
  for (const [configured, efforts] of [[agyRoute, ["low", "medium", "high"]], [grokRoute, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]]]) {
    for (const reasoningEffort of efforts) assert.equal(validateLocalCliRoute({ ...configured, reasoningEffort }).reasoningEffort, reasoningEffort);
    assert.throws(() => validateLocalCliRoute({ ...configured, reasoningEffort: "future" }), /reasoningEffort/);
  }
  for (const reasoningEffort of ["HIGH", "low high", "", "low\n", 1]) assert.throws(() => validateLocalCliRoute({ ...codexRoute, reasoningEffort }), /reasoningEffort/);
});

test("Codex invocation matches measured stdin, effort and sandbox arguments", async () => {
  assert.deepEqual(buildLocalCliInvocation(codexRoute, { ODAI_CODEX_COMMAND: "/fake/codex" }, { cwd: "/work" }), {
    command: "/fake/codex", args: ["exec", "--json", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="low"', "-c", "features.multi_agent=false", "--sandbox", "read-only", "--skip-git-repo-check", "-C", "/work", "-"],
  });
  assert.equal(buildLocalCliInvocation({ ...codexRoute, reasoningEffort: undefined }, {}, { cwd: "/work" }).args.some((arg) => arg.startsWith("model_reasoning_effort")), false);
  const fake = fakeProcess((child) => { child.stdout.write(codexOutput); child.emit("close", 0); });
  await execute(fake, { route: codexRoute, prompt: "stdin-only", env: { CODEX_HOME: "/missing-fixture" } });
  assert.equal(fake.input(), "stdin-only");
  assert.equal(fake.invocation().args.includes("stdin-only"), false);
});

test("Codex verifies last context from filename-matched session and real cwd", async (t) => {
  const fixture = evidenceFixture(t);
  const link = join(fixture.root, "work-link");
  symlinkSync(fixture.cwd, link, "dir");
  fixture.session({ cwd: link });
  // Unrelated invalid transcripts must never be parsed.
  writeFileSync(join(fixture.sessions, "rollout-unrelated.jsonl"), "invalid transcript");
  const parsed = parseLocalCliResult(codexOutput, codexRoute, fixture);
  assert.equal(parsed.text, "marker-7781");
  assert.equal(parsed.modelVerified, true);
  assert.equal(parsed.reasoningEffortVerification, "verified");
  assert.equal(parsed.actualReasoningEffort, "low");
  assert.equal(parsed.usage.output_tokens, 84);
  const fake = fakeProcess((child) => { child.stdout.write(codexOutput); child.emit("close", 0); });
  const result = await execute(fake, { route: codexRoute, cwd: fixture.cwd, env: fixture.env });
  assert.equal(result.modelVerified, true);
  assert.equal(fake.invocation().options.env.HTTPS_PROXY, fixture.env.HTTPS_PROXY);
});

test("Codex rejects missing, mismatched, malformed and ambiguous evidence", (t) => {
  const fixture = evidenceFixture(t);
  const parse = () => parseLocalCliResult(codexOutput, codexRoute, fixture);
  assert.equal(parse().modelVerification, "missing");
  fixture.session({ id: "wrong" });
  assert.equal(parse().modelVerification, "missing");
  fixture.session({ cwd: fixture.root });
  assert.equal(parse().modelVerification, "missing");
  fixture.session({}, { model: "other" });
  assert.equal(parse().modelVerification, "mismatch");
  fixture.session({}, { effort: "high" });
  assert.equal(parse().reasoningEffortVerification, "mismatch");
  fixture.session({}, { effort: undefined });
  assert.equal(parse().reasoningEffortVerification, "mismatch");
  fixture.session({}, { model: undefined });
  assert.equal(parse().modelVerification, "missing");
  writeFileSync(fixture.codexFile, "malformed");
  assert.equal(parse().modelVerification, "missing");
  fixture.session();
  writeFileSync(join(fixture.sessions, `rollout-duplicate-${threadId}.jsonl`), readFileSync(fixture.codexFile));
  assert.equal(parse().modelVerification, "missing");
  assert.equal(parseLocalCliResult("invalid", codexRoute, fixture).status, "error");
  assert.equal(parseLocalCliResult(ndjson({ type: "thread.started", thread_id: threadId }), codexRoute, fixture).text, "");
  assert.equal(parseLocalCliResult(codexOutput + '\n{"type":"turn.failed","error":{"message":"failed"}}', codexRoute, fixture).status, "error");
});

test("Antigravity uses bounded argv prompt, measured plan flags and no stdin", async () => {
  const configured = { ...agyRoute, reasoningEffort: "high", timeoutSeconds: 30 };
  const invocation = buildLocalCliInvocation(configured, { ODAI_AGY_COMMAND: "/fake/agy" }, { prompt: "Read" });
  assert.equal(invocation.command, "/fake/agy");
  assert.match(invocation.args[1], /^Read\n\n只用只读工具.*任务包.*read_file.*view_file.*不要列目录、搜索文件、执行命令、写入或编辑文件.*本次调用作废.*回交/);
  assert.deepEqual(invocation.args, ["-p", invocation.args[1], "--output-format", "stream-json", "--mode", "plan", "--disable-slash-commands", "--model", agyRoute.model, "--effort", "high", "--print-timeout", "30s"]);
  const defaultArgs = buildLocalCliInvocation(agyRoute, {}, { prompt: "Read" }).args;
  assert.equal(defaultArgs.includes("--effort"), false);
  assert.equal(defaultArgs.at(-1), "1200s");
  const fake = fakeProcess((child) => { child.stdout.write(agyOutput()); child.emit("close", 0); });
  const result = await execute(fake, { route: agyRoute });
  assert.equal(fake.input(), "");
  assert.equal(result.text, "OK\n");
  assert.equal(result.modelVerified, true);
  assert.equal(result.sessionId, "b8ec26a5-test");
  assert.equal(result.usage.thinking_tokens, 89);
  assert.equal(result.reasoningEffortVerification, "requested-only");
  const large = fakeProcess();
  const failure = await execute(large, { route: agyRoute, prompt: "界".repeat(90_000) });
  assert.equal(failure.status, "error");
  assert.match(failure.error, /256 KiB/);
  assert.equal(large.invocation(), undefined);
});

test("Antigravity handles ERROR, empty responses, absent and mismatched init models", () => {
  assert.equal(parseLocalCliResult(agyOutput({ status: "ERROR", response: "", error: 'invalid model selection (--model "bogus-model-xyz")' }), agyRoute).status, "error");
  assert.equal(parseLocalCliResult(agyOutput({ response: "" }), agyRoute).text, "");
  assert.equal(parseLocalCliResult(agyOutput({}, { model: "other" }), agyRoute).modelVerification, "mismatch");
  assert.equal(parseLocalCliResult(agyOutput({}, {}), agyRoute).modelVerification, "missing");
  assert.equal(parseLocalCliResult(agyOutput({ denied_actions: [{ tool: "run_command" }] }), agyRoute).deniedActionsCount, 1);
  assert.equal(parseLocalCliResult(agyOutput({ denied_actions: 2 }), agyRoute).deniedActionsCount, 2);
  assert.equal(parseLocalCliResult(agyOutput() + '\n{"event":"result","result":{"status":"SUCCESS","response":"last"}}', agyRoute).text, "last");
  for (const output of ["not JSON", "{}", "[]"]) assert.equal(parseLocalCliResult(output, agyRoute).status, "error");
});

test("Grok uses private file prompt, exact documented flags and summary evidence", async (t) => {
  const fixture = evidenceFixture(t);
  fixture.summary();
  let promptFile;
  const fake = fakeProcess((child) => { child.stdout.write(grokOutput()); child.emit("close", 0); });
  const spawnProcess = (command, args, options) => {
    promptFile = args[1];
    assert.equal(readFileSync(promptFile, "utf8"), "private prompt");
    assert.equal(statSync(promptFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(promptFile, "..")).mode & 0o777, 0o700);
    assert.equal(command, "/fake/grok");
    assert.deepEqual(args, ["--prompt-file", promptFile, "--output-format", "json", "-m", grokRoute.model, "--effort", "none", "--tools", "read_file,grep,list_dir", "--disallowed-tools", "Agent", "--sandbox", "read-only", "--permission-mode", "dontAsk", "--no-memory", "--cwd", fixture.cwd]);
    return fake.spawnProcess(command, args, options);
  };
  const result = await executeLocalCli({ route: grokRoute, prompt: "private prompt", cwd: fixture.cwd, env: { ...fixture.env, ODAI_GROK_COMMAND: "/fake/grok" }, spawnProcess });
  assert.equal(result.modelVerified, true);
  assert.equal(result.reasoningEffortVerification, "requested-only");
  assert.equal(fake.input(), "");
  assert.equal(existsSync(promptFile), false);
  assert.equal(existsSync(join(promptFile, "..")), false);
});

test("Grok prioritizes modelUsage keys over summary evidence and does not require a session", (t) => {
  const fixture = evidenceFixture(t);
  fixture.summary({ model: "summary-model" });
  for (const usage of [{}, { total_tokens: 12 }, null]) {
    const result = parseLocalCliResult(grokOutput({ modelUsage: { [grokRoute.model]: usage } }), grokRoute, fixture);
    assert.equal(result.actualModel, grokRoute.model);
    assert.equal(result.modelVerified, true);
  }
  assert.equal(parseLocalCliResult(grokOutput({ sessionId: undefined, modelUsage: { [grokRoute.model]: {} } }), grokRoute).modelVerified, true);
  fixture.summary();
  const mismatch = parseLocalCliResult(grokOutput({ modelUsage: { other: {} } }), grokRoute, fixture);
  assert.equal(mismatch.actualModel, "other");
  assert.equal(mismatch.modelVerification, "mismatch");
  for (const modelUsage of [[], "invalid", { "invalid model": {} }]) {
    assert.equal(parseLocalCliResult(grokOutput({ modelUsage }), grokRoute, fixture).modelVerification, "missing");
  }
});

test("Grok selects the model with most tokens across total and component field formats", () => {
  for (const [other, selected] of [
    [{ total_tokens: 20 }, { total_tokens: 30 }],
    [{ totalTokens: 20 }, { totalTokens: 30 }],
    [{ outputTokens: 20 }, { inputTokens: 30, outputTokens: 1 }],
    [{ total_tokens: 20 }, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, reasoning_tokens: 1 }],
    [{ totalTokens: 20 }, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, reasoningTokens: 1 }],
    [{ total_tokens: 1, input_tokens: 100 }, { total_tokens: 2 }],
  ]) {
    for (const entries of [ [["other", other], [grokRoute.model, selected]], [[grokRoute.model, selected], ["other", other]] ]) {
      const result = parseLocalCliResult(grokOutput({ modelUsage: Object.fromEntries(entries) }), grokRoute);
      assert.equal(result.actualModel, grokRoute.model);
      assert.equal(result.modelVerified, true);
    }
  }
});

test("Grok summary schema alternatives verify and missing evidence fails closed", (t) => {
  const fixture = evidenceFixture(t);
  const parse = (output = grokOutput()) => parseLocalCliResult(output, grokRoute, fixture);
  assert.equal(parse().modelVerification, "missing");
  for (const field of ["model", "modelId", "model_id"]) {
    fixture.summary({ [field]: grokRoute.model });
    assert.equal(parse().modelVerified, true);
  }
  fixture.summary({ model: "other" });
  assert.equal(parse().modelVerification, "mismatch");
  for (const value of [{}, [], null, { model: 3 }, { model: "" }]) {
    fixture.summary(value);
    assert.equal(parse().modelVerification, "missing");
  }
  writeFileSync(fixture.summaryFile, "invalid JSON");
  assert.equal(parse().modelVerification, "missing");
  fixture.summary();
  for (const modelUsage of [undefined, null, {}]) assert.equal(parse(grokOutput({ modelUsage })).modelVerified, true);
  for (const sessionId of [undefined, "../grok-session", "", "/absolute"]) assert.equal(parse(grokOutput({ sessionId })).modelVerification, "missing");
  assert.equal(parse(grokOutput({ stopReason: "MaxTokens" })).status, "error");
  assert.equal(parse(grokOutput({ text: "" })).text, "");
  for (const output of ["invalid", "[]", "null"]) assert.equal(parse(output).status, "error");
});

for (const failure of ["spawn", "exit", "cancelled", "timeout", "overflow"]) {
  test(`Grok cleans private input after ${failure}`, async (t) => {
    const fixture = evidenceFixture(t);
    const controller = new AbortController();
    let promptFile;
    const fake = fakeProcess((child) => {
      if (failure === "exit") child.emit("close", 1);
      if (failure === "cancelled") controller.abort();
      if (failure === "overflow") child.stdout.write("x".repeat(100));
    });
    const result = await executeLocalCli({
      route: { ...grokRoute, timeoutSeconds: 1 }, prompt: "secret", cwd: fixture.cwd, env: fixture.env,
      signal: controller.signal, killGraceMs: 1, maxOutputBytes: 50,
      spawnProcess(command, args, options) {
        promptFile = args[1];
        if (failure === "spawn") throw new Error("spawn failure");
        return fake.spawnProcess(command, args, options);
      },
    });
    assert.equal(result.status, ["cancelled", "timeout"].includes(failure) ? failure : "error");
    assert.equal(existsSync(promptFile), false);
    assert.equal(existsSync(join(promptFile, "..")), false);
  });
}

test("Grok verifies the requested model when a helper model used more tokens", () => {
  const result = parseLocalCliResult(grokOutput({ modelUsage: {
    "grok-helper": { total_tokens: 5000 },
    [grokRoute.model]: { total_tokens: 12 },
  } }), grokRoute);
  assert.equal(result.modelVerified, true);
  assert.equal(result.actualModel, grokRoute.model);
});

test("agy actual denied write fixture is distinct from DONE boundary violations", () => {
  const init = { event: "init", init: { model: agyRoute.model, tools: ["view_file", "list_dir", "grep_search", "find_by_name", "write_to_file"] } };
  const step = { step_type: "tool", tool_name: "write_file", state: "ERROR", tool_info: { name: "write_file", parameters: { Path: "…/probe.txt" }, error: { type: "TOOL_ERROR", message: "permission check failed …" } } };
  const denied = { event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "write_file", display_name: "WriteFile" }] } };
  const readSteps = [
    { event: "step_update", step_update: { step_type: "tool", tool_name: "read_file", state: "DONE" } },
    { event: "step_update", step_update: { step_type: "tool", tool_name: "read_file", state: "ERROR" } },
    { event: "step_update", step_update: { step_type: "tool", tool_name: "run_command", state: "ERROR" } },
  ];
  const read = parseLocalCliResult(ndjson(init, ...readSteps, { event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "command" }] } }), agyRoute);
  assert.equal(read.boundaryStatus, undefined);
  assert.equal(read.text, "");
  assert.equal(read.deniedActionsCount, 1);
  const parsed = parseLocalCliResult(ndjson(init, { event: "step_update", step_update: step }, denied), agyRoute);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.deniedActionsCount, 1);
  for (const tool of ["write_file", "edit_file", "run_command", "unknown_tool"]) {
    const result = parseLocalCliResult(ndjson(init, { event: "step_update", step_update: { ...step, tool_name: tool, state: "DONE" } }, { event: "result", result: { status: "SUCCESS", response: "DO NOT LEAK" } }), agyRoute);
    assert.equal(result.status, "error"); assert.equal(result.text, "");
    assert.equal(result.boundaryStatus, "boundary-violation"); assert.deepEqual(result.boundaryTools, [tool]);
    assert.match(result.error, /permissions.allow/);
  }
  for (const tool of ["read_file", "search_web", "ask_question", "manage_task", "view_file", "grep_search", "list_dir", "find_by_name"]) assert.equal(parseLocalCliResult(ndjson(init, { event: "step_update", step_update: { ...step, tool_name: tool, state: "DONE" } }, denied), agyRoute).status, "completed");
});
