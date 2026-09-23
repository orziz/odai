import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONTROL_CENTER_CHANNEL,
  CONTROL_CENTER_ENDPOINT,
  CONTROL_CENTER_EVIDENCE_ENDPOINT,
  installControlCenterRuntime,
  installControlCenterRuntimeWhenAvailable,
} from "../build/control-center-runtime.mjs";
import { createSessionEvidence } from "../build/session-evidence.mjs";
test("Control Center registers exact authenticated transport routes and validates RPC envelopes", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-control-center-fetch-"));
  const routes = new Map();
  const connection = {
    rpc: {
      handle() {
        throw new Error("custom RPC carrier must not be used");
      },
    },
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => {
          routes.delete(route.path);
        };
      },
    },
  };
  const ctx = {
    get() {
      return connection;
    },
    llm: {
      resolveCallConfig(route) {
        return { config: route };
      },
    },
  };
  const dispose = installControlCenterRuntime(ctx, { configPath: resolve(scratch, "routing.json") });
  try {
    const path = "/api/odai-control-center/routing";
    const route = routes.get(path);
    assert.ok(route);
    assert.equal(routes.size, 2);
    const call = (body) =>
      route.fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    assert.equal((await call({ type: "client-request", rpcId: "probe", method: "wrong" })).status, 400);
    const response = await call({
      type: "client-request",
      rpcId: "probe",
      method: "odai-control-center/routing",
      payload: { action: "show" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rpcId, "probe");
    assert.equal(body.result.value.ok, true);
    assert.ok(body.result.value.config);
  } finally {
    await dispose?.();
    await rm(scratch, { recursive: true, force: true });
  }
  assert.equal(routes.size, 0);
});
test("Control Center uses one process-wide loopback RPC registration across Cordis scopes", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-control-center-runtime-"));
  const configPath = resolve(scratch, "routing.json");
  const evidenceRoot = resolve(scratch, "evidence");
  const evidenceStore = createSessionEvidence({ root: evidenceRoot });
  evidenceStore.append({ session: { header: { id: "session-one" } } }, "odai/responsibility-gap", {
    turn: 1,
    step: 2,
    responsibility: "planner",
    gap: "a concrete planning gap",
  });
  let handler;
  let registrations = 0;
  let shadowRegistrations = 0;
  let disposals = 0;
  const probes = [];
  const connection = {
    rpc: {
      handle(channel, callback, options) {
        registrations += 1;
        assert.equal(channel, CONTROL_CENTER_CHANNEL);
        assert.equal(options.authority, "loopback");
        handler = callback;
        return async () => {
          disposals += 1;
        };
      },
    },
  };
  const llm = {
    resolveCallConfig(route) {
      probes.push(route);
      return { config: route };
    },
  };
  const ctx = {
    get(name) {
      return name === "connection" ? connection : undefined;
    },
    llm,
  };
  const shadowConnection = {
    rpc: {
      handle() {
        shadowRegistrations += 1;
        return async () => {};
      },
    },
  };
  const shadowCtx = {
    get(name) {
      return name === "connection" ? shadowConnection : undefined;
    },
    llm,
  };
  const disposeFirst = installControlCenterRuntime(ctx, { configPath, evidenceRoot });
  const disposeSecond = installControlCenterRuntime(shadowCtx, {
    configPath,
    evidenceRoot,
    configuredRoles: { planner: { provider: "deployment", model: "planner-model" } },
  });
  assert.equal(registrations, 1);
  assert.equal(shadowRegistrations, 0);
  assert.ok(handler);
  assert.ok(disposeFirst);
  assert.ok(disposeSecond);
  try {
    const shown = await handler(CONTROL_CENTER_ENDPOINT, { action: "show" }, new AbortController().signal);
    assert.equal(shown.value.ok, true);
    assert.equal("configPath" in (shown.value.config ?? {}), false);
    assert.equal(shown.value.config?.roles.planner?.provider, "deployment");
    const evidence = await handler(
      CONTROL_CENTER_EVIDENCE_ENDPOINT,
      { sessionId: "session-one" },
      new AbortController().signal,
    );
    assert.equal(evidence.value.ok, true);
    assert.equal(evidence.value.events?.length, 1);
    assert.equal(evidence.value.events?.[0]?.type, "odai/responsibility-gap");
    assert.equal(evidence.value.unchanged, false);
    assert.equal(typeof evidence.value.revision, "string");
    const unchangedEvidence = await handler(
      CONTROL_CENTER_EVIDENCE_ENDPOINT,
      { sessionId: "session-one", revision: evidence.value.revision },
      new AbortController().signal,
    );
    assert.equal(unchangedEvidence.value.ok, true);
    assert.equal(unchangedEvidence.value.unchanged, true);
    assert.equal(unchangedEvidence.value.events, undefined);
    evidenceStore.append({ session: { header: { id: "session-one" } } }, "odai/route-result", {
      turn: 1,
      step: 3,
      responsibility: "planner",
      status: "completed",
    });
    const changedEvidence = await handler(
      CONTROL_CENTER_EVIDENCE_ENDPOINT,
      { sessionId: "session-one", revision: evidence.value.revision },
      new AbortController().signal,
    );
    assert.equal(changedEvidence.value.unchanged, false);
    assert.equal(changedEvidence.value.events?.length, 2);
    assert.notEqual(changedEvidence.value.revision, evidence.value.revision);
    const invalidEvidence = await handler(
      CONTROL_CENTER_EVIDENCE_ENDPOINT,
      { sessionId: "session-one", root: "/tmp" },
      new AbortController().signal,
    );
    assert.equal(invalidEvidence.value.error?.code, "bad-request");
    const set = await handler(
      CONTROL_CENTER_ENDPOINT,
      { action: "set", responsibility: "planner", provider: "openai", model: "gpt-test", reasoningEffort: "high" },
      new AbortController().signal,
    );
    assert.equal(set.value.ok, true);
    assert.equal(set.value.config?.roles.planner?.model, "gpt-test");
    assert.equal(set.value.config?.requiresNextTurn, true);
    assert.deepEqual(probes, [{ provider: "openai", model: "gpt-test", reasoningEffort: "high" }]);
    assert.match(await readFile(configPath, "utf8"), /"planner"/u);
    const invalid = await handler(
      CONTROL_CENTER_ENDPOINT,
      { action: "set-dispatch", responsibility: "controller", dispatch: "child" },
      new AbortController().signal,
    );
    assert.equal(invalid.value.ok, false);
    assert.equal(invalid.value.error?.code, "bad-request");
    await disposeFirst();
    assert.equal(disposals, 0);
    const afterFirstDisposal = await handler(CONTROL_CENTER_ENDPOINT, { action: "show" }, new AbortController().signal);
    assert.equal(afterFirstDisposal.value.ok, true);
    assert.equal(afterFirstDisposal.value.config?.roles.planner?.provider, "openai");
    await disposeSecond();
    assert.equal(disposals, 1);
  } finally {
    await disposeFirst?.();
    await disposeSecond?.();
    await rm(scratch, { recursive: true, force: true });
  }
});
test("Control Center waits for a late Web connection service", async () => {
  let connection;
  let serviceHandler;
  let registrations = 0;
  let disposals = 0;
  const ctx = {
    get(name) {
      return name === "connection" ? connection : undefined;
    },
    on(event, handler) {
      if (event === "internal/service") serviceHandler = handler;
    },
    llm: {
      resolveCallConfig(route) {
        return { config: route };
      },
    },
  };
  const dispose = installControlCenterRuntimeWhenAvailable(ctx, {
    configPath: resolve(tmpdir(), "odai-control-center-late-routing.json"),
  });
  assert.equal(registrations, 0);
  assert.ok(serviceHandler);
  connection = {
    rpc: {
      handle() {
        registrations += 1;
        return async () => {
          disposals += 1;
        };
      },
    },
  };
  serviceHandler("connection");
  serviceHandler("connection");
  assert.equal(registrations, 1);
  await dispose();
  assert.equal(disposals, 1);
  serviceHandler("connection");
  assert.equal(registrations, 1);
});
test("Control Center rejects an unavailable route without overwriting configuration", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-control-center-reject-"));
  const configPath = resolve(scratch, "routing.json");
  let handler;
  const connection = {
    rpc: {
      handle(_channel, callback) {
        handler = callback;
        return async () => {};
      },
    },
  };
  const ctx = {
    get() {
      return connection;
    },
    llm: {
      resolveCallConfig() {
        throw Object.assign(new Error("unknown model"), { code: "UNKNOWN_MODEL" });
      },
    },
  };
  const dispose = installControlCenterRuntime(ctx, { configPath });
  try {
    assert.ok(handler);
    const result = await handler(
      CONTROL_CENTER_ENDPOINT,
      { action: "set", responsibility: "reviewer", provider: "missing", model: "none" },
      new AbortController().signal,
    );
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error?.code, "route-rejected");
    await assert.rejects(readFile(configPath, "utf8"), /ENOENT/u);
  } finally {
    await dispose?.();
    await rm(scratch, { recursive: true, force: true });
  }
});
