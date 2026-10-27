import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRouteSession } from "../build/route-session.mjs";
import { createSessionEvidence } from "../build/session-evidence.mjs";
import { applyRoutingConfigAction, readRoutingStore, resolveRoleRoute } from "../build/routing-config.mjs";
import { executeLocalCli, buildLocalCliInvocation } from "../../../skills/odai-orchestration/scripts/local-cli.mjs";

function fakeBackend(cli) {
  const calls = [];
  let active = 0, peak = 0;
  let rejectResume = false;
  const spawnProcess = (_command, args) => {
    calls.push(args); active++; peak = Math.max(peak, active);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      active--;
      const resumed = args.includes(cli === "claude" ? "--resume" : "--conversation");
      if (rejectResume && resumed) { child.stderr.write("session missing"); child.emit("close", 1); return; }
      const resumeFlag = cli === "claude" ? "--resume" : "--conversation";
      const id = resumed ? args[args.indexOf(resumeFlag) + 1] : randomUUID();
      child.stdout.write(cli === "claude"
        ? JSON.stringify({ subtype: "success", result: "full packet accepted", modelUsage: { "test-model": { outputTokens: 1 } } })
        : [{ event: "init", conversation_id: id, init: { model: "test-model" } }, { event: "result", result: { status: "SUCCESS", response: "full packet accepted" } }].map(JSON.stringify).join("\n"));
      child.emit("close", 0);
    });
    return child;
  };
  return { calls, spawnProcess, peak: () => peak, reject: () => { rejectResume = true; } };
}
function agent(id) { return { session: { header: { id }, snapshotEvents: () => [], append() {} } }; }
for (const cli of ["claude", "antigravity"]) {
  test(`${cli} continuation persists by DSH session and route, queues calls, and falls back visibly`, async () => {
    const root = mkdtempSync(join(tmpdir(), "odai-route-session-"));
    try {
      let evidence = createSessionEvidence({ root });
      let parent = agent(randomUUID());
      const backend = fakeBackend(cli);
      const route = { backend: "local-cli", cli, model: "test-model", session: "continue" };
      const call = (owner = parent, mapping = route) => executeRouteSession({ agent: owner, route: mapping, evidence, signal: new AbortController().signal,
        execute: resumeSessionId => executeLocalCli({ route: mapping, prompt: "complete task packet", cwd: process.cwd(), spawnProcess: backend.spawnProcess, resumeSessionId }),
      });
      const [first, second] = await Promise.all([call(), call()]);
      assert.equal(first.sessionAction, "created"); assert.equal(second.sessionAction, "resumed");
      assert.equal(backend.peak(), 1);
      const flag = cli === "claude" ? "--resume" : "--conversation";
      assert.equal(backend.calls[1][backend.calls[1].indexOf(flag) + 1], first.routeSessionId);
      for (const args of backend.calls) {
        assert.ok(args.includes("--model"));
        assert.ok(args.includes(cli === "claude" ? "Read,Glob,Grep" : "plan"));
        assert.ok(!args.includes("--no-session-persistence"));
      }
      if (cli === "claude") assert.equal(backend.calls[0][backend.calls[0].indexOf("--session-id") + 1], first.routeSessionId);
      else assert.ok(!backend.calls[0].includes("--conversation"));
      // Recreate both runtime evidence reader and parent object: durable mapping survives.
      evidence = createSessionEvidence({ root });
      parent = agent(parent.session.header.id);
      const restored = await call();
      assert.equal(restored.sessionAction, "resumed");
      const other = await call(agent(randomUUID()));
      assert.equal(other.sessionAction, "created"); assert.notEqual(other.routeSessionId, first.routeSessionId);
      const changed = await call(parent, { ...route, model: "other-model" });
      assert.equal(changed.sessionAction, "created");
      backend.reject();
      const fallback = await call();
      assert.equal(fallback.status, "completed"); assert.equal(fallback.sessionAction, "resume-failed-created");
      assert.match(fallback.sessionNotice, /续接失败，已新开/);
      assert.notEqual(fallback.routeSessionId, restored.routeSessionId);
      assert.equal(evidence.events(parent).filter(e => e.type === "odai/route-session").length, 5);
      const fresh = await call(parent, { ...route, session: "fresh" });
      assert.equal(fresh.sessionAction, undefined);
      assert.ok(!backend.calls.at(-1).includes(flag));
      if (cli === "claude") assert.ok(backend.calls.at(-1).includes("--no-session-persistence"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test("session configuration validates all backends, round trips and preserves default schema", async () => {
  for (const cli of ["codex", "grok"]) assert.throws(() => resolveRoleRoute({ backend: "local-cli", cli, model: "test", session: "continue" }, "planner"), /暂不支持/);
  assert.throws(() => resolveRoleRoute({ provider: "test", model: "test", session: "continue" }, "planner"), /API.*暂不支持/);
  for (const session of [null, "invalid", true]) assert.throws(() => resolveRoleRoute({ backend: "local-cli", cli: "claude", model: "test", session }, "planner"), /session/);
  const root = mkdtempSync(join(tmpdir(), "odai-session-config-"));
  const path = join(root, "routing.json");
  try {
    await applyRoutingConfigAction(path, { action: "set", responsibility: "planner", backend: "local-cli", cli: "claude", model: "test", session: "continue" });
    assert.equal(readRoutingStore(path).schemaVersion, 5);
    assert.equal(readRoutingStore(path).roles.planner.session, "continue");
    await applyRoutingConfigAction(path, { action: "set", responsibility: "planner", backend: "local-cli", cli: "claude", model: "test" });
    assert.equal(readRoutingStore(path).schemaVersion, 3);
    await applyRoutingConfigAction(path, { action: "remove", responsibility: "planner" });
    assert.equal(readRoutingStore(path).schemaVersion, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.throws(() => buildLocalCliInvocation({ backend: "local-cli", cli: "claude", model: "test", session: "continue" }, {}, { resumeSessionId: "--bad" }), /Invalid resume/);
});

test("aborted queued continuation never starts a backend", async () => {
  const owner = agent(randomUUID()); const events = [];
  const evidence = { events: () => events, append: (_agent, type, data) => events.push({ type, data }) };
  const route = { backend: "local-cli", cli: "claude", model: "test", session: "continue" };
  let unblock; let calls = 0;
  const execute = async () => { calls++; await new Promise(resolve => { unblock = resolve; }); return { status: "completed", sessionId: randomUUID() }; };
  const first = executeRouteSession({ agent: owner, route, evidence, signal: new AbortController().signal, execute });
  await new Promise(resolve => setImmediate(resolve));
  const queued = executeRouteSession({ agent: owner, route, evidence, signal: AbortSignal.abort(), execute });
  const rejected = assert.rejects(queued, /abort/i);
  unblock(); await first; await rejected;
  assert.equal(calls, 1);
});

for (const cli of ["claude", "antigravity"]) test(`${cli} managed roles share opted-in sessions and expose verified receipts`, async () => {
  const { runRoutedRole, latestRouteReceipt } = await import("../build/runtime-support.mjs");
  const root = mkdtempSync(join(tmpdir(), "odai-session-dispatch-"));
  const command = join(root, "fake-cli.mjs");
  const variable = cli === "claude" ? "ODAI_CLAUDE_COMMAND" : "ODAI_AGY_COMMAND";
  const previous = process.env[variable];
  writeFileSync(command, `#!${process.execPath}
const cli = ${JSON.stringify(cli)};
if (cli === "claude") console.log(JSON.stringify({ subtype: "success", result: "handback", modelUsage: { "test-model": { outputTokens: 1 } } }));
else {
 const flag = process.argv.indexOf("--conversation");
 console.log(JSON.stringify({ event: "init", conversation_id: flag >= 0 ? process.argv[flag + 1] : "test-conversation", init: { model: "test-model" } }));
 console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "handback" } }));
}
`);
  chmodSync(command, 0o700); process.env[variable] = command;
  try {
    const owner = agent(randomUUID()); owner.session.header.cwd = root;
    const evidence = createSessionEvidence({ root: join(root, "evidence") });
    const route = { backend: "local-cli", cli, model: "test-model", session: "continue" };
    const call = role => runRoutedRole({ provider: "irrelevant", decision: { role }, taskText: "complete task", roleContract: "read only", agent: owner, signal: new AbortController().signal, roleRoute: route, sessionEvidence: evidence });
    const planned = await call("planner"); const accepted = await call("creative");
    assert.equal(planned.sessionAction, "created"); assert.equal(accepted.sessionAction, "resumed");
    assert.equal(planned.routeSessionId, accepted.routeSessionId);
    assert.equal(accepted.routeReceiptStatus, "applied"); assert.equal(accepted.status, "completed");
    const receipt = latestRouteReceipt([{ type: "odai/route-result", data: { ...accepted, turn: 1, step: 2, role: "creative", routeSource: "persisted-mapping" } }]);
    assert.equal(receipt.sessionAction, "resumed"); assert.equal(receipt.routeSessionId, accepted.routeSessionId);
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
