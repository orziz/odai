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
  type ControlCenterResponse,
} from "../build/control-center-runtime.mjs";
import { createSessionEvidence } from "../build/session-evidence.mjs";
import type { DshAgent, DshRuntimeContext, UnknownRecord } from "../build/runtime-types.mjs";

interface OuterResult {
  ok: true;
  value: ControlCenterResponse;
}

test("Control Center uses one process-wide loopback RPC registration across Cordis scopes", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-control-center-runtime-"));
  const configPath = resolve(scratch, "routing.json");
  const evidenceRoot = resolve(scratch, "evidence");
  const evidenceStore = createSessionEvidence({ root: evidenceRoot });
  evidenceStore.append({
    session: { header: { id: "session-one" } },
  } as unknown as DshAgent, "odai/responsibility-gap", {
    turn: 1,
    step: 2,
    responsibility: "planner",
    gap: "a concrete planning gap",
  });
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<OuterResult>) | undefined;
  let registrations = 0;
  let shadowRegistrations = 0;
  let disposals = 0;
  const probes: UnknownRecord[] = [];
  const connection = {
    rpc: {
      handle(channel: string, callback: typeof handler, options: { authority: string }) {
        registrations += 1;
        assert.equal(channel, CONTROL_CENTER_CHANNEL);
        assert.equal(options.authority, "loopback");
        handler = callback;
        return async () => { disposals += 1; };
      },
    },
  };
  const llm = {
    resolveCallConfig(route: UnknownRecord) {
      probes.push(route);
      return { config: route };
    },
  };
  const ctx = {
    get(name: string) { return name === "connection" ? connection : undefined; },
    llm,
  } as unknown as DshRuntimeContext;
  const shadowConnection = {
    rpc: {
      handle() {
        shadowRegistrations += 1;
        return async () => {};
      },
    },
  };
  const shadowCtx = {
    get(name: string) { return name === "connection" ? shadowConnection : undefined; },
    llm,
  } as unknown as DshRuntimeContext;

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

    const evidence = await handler(CONTROL_CENTER_EVIDENCE_ENDPOINT, { sessionId: "session-one" }, new AbortController().signal);
    assert.equal(evidence.value.ok, true);
    assert.equal(evidence.value.events?.length, 1);
    assert.equal(evidence.value.events?.[0]?.type, "odai/responsibility-gap");
    assert.equal(evidence.value.unchanged, false);
    assert.equal(typeof evidence.value.revision, "string");
    const unchangedEvidence = await handler(CONTROL_CENTER_EVIDENCE_ENDPOINT, {
      sessionId: "session-one",
      revision: evidence.value.revision,
    }, new AbortController().signal);
    assert.equal(unchangedEvidence.value.ok, true);
    assert.equal(unchangedEvidence.value.unchanged, true);
    assert.equal(unchangedEvidence.value.events, undefined);
    evidenceStore.append({ session: { header: { id: "session-one" } } } as unknown as DshAgent, "odai/route-result", {
      turn: 1,
      step: 3,
      responsibility: "planner",
      status: "completed",
    });
    const changedEvidence = await handler(CONTROL_CENTER_EVIDENCE_ENDPOINT, {
      sessionId: "session-one",
      revision: evidence.value.revision,
    }, new AbortController().signal);
    assert.equal(changedEvidence.value.unchanged, false);
    assert.equal(changedEvidence.value.events?.length, 2);
    assert.notEqual(changedEvidence.value.revision, evidence.value.revision);
    const invalidEvidence = await handler(CONTROL_CENTER_EVIDENCE_ENDPOINT, { sessionId: "session-one", root: "/tmp" }, new AbortController().signal);
    assert.equal(invalidEvidence.value.error?.code, "bad-request");

    const set = await handler(CONTROL_CENTER_ENDPOINT, {
      action: "set",
      responsibility: "planner",
      provider: "openai",
      model: "gpt-test",
      reasoningEffort: "high",
    }, new AbortController().signal);
    assert.equal(set.value.ok, true);
    assert.equal(set.value.config?.roles.planner?.model, "gpt-test");
    assert.equal(set.value.config?.requiresNextTurn, true);
    assert.deepEqual(probes, [{ provider: "openai", model: "gpt-test", reasoningEffort: "high" }]);
    assert.match(await readFile(configPath, "utf8"), /"planner"/u);

    const invalid = await handler(CONTROL_CENTER_ENDPOINT, {
      action: "set-dispatch",
      responsibility: "controller",
      dispatch: "child",
    }, new AbortController().signal);
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

test("Control Center rejects an unavailable route without overwriting configuration", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-control-center-reject-"));
  const configPath = resolve(scratch, "routing.json");
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<OuterResult>) | undefined;
  const connection = { rpc: { handle(_channel: string, callback: typeof handler) { handler = callback; return async () => {}; } } };
  const ctx = {
    get() { return connection; },
    llm: {
      resolveCallConfig() {
        throw Object.assign(new Error("unknown model"), { code: "UNKNOWN_MODEL" });
      },
    },
  } as unknown as DshRuntimeContext;
  const dispose = installControlCenterRuntime(ctx, { configPath });
  try {
    assert.ok(handler);
    const result = await handler(CONTROL_CENTER_ENDPOINT, {
      action: "set",
      responsibility: "reviewer",
      provider: "missing",
      model: "none",
    }, new AbortController().signal);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error?.code, "route-rejected");
    await assert.rejects(readFile(configPath, "utf8"), /ENOENT/u);
  } finally {
    await dispose?.();
    await rm(scratch, { recursive: true, force: true });
  }
});
