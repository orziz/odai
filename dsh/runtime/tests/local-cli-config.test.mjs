import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  applyRoutingConfigAction,
  createRoutingConfigTool,
  effectiveRoutingSnapshot,
  readRoutingStore,
  resolveRoleRoute,
} from "../build/routing-config.mjs";
import { describeModelRoute, probeModelRoute, sameModelRoute } from "../build/model-route.mjs";
import { resolveConfig } from "../build/runtime-config.mjs";
import { resolveInPlaceResponsibilityOutputBudgets } from "../build/output-config.mjs";

const local = { backend: "local-cli", cli: "claude", model: "opus", reasoningEffort: "high" };
const api = { provider: "openai", model: "controller", reasoningEffort: "xhigh", maxTokens: 2048 };

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), "odai-local-cli-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return resolve(root, "routing.json");
}

function store(path, roles, dispatch = {}, schemaVersion = 3) {
  writeFileSync(path, JSON.stringify({ schemaVersion, roles, ...(schemaVersion === 1 ? {} : { dispatch }) }));
}

test("local CLI routes validate supported responsibilities, options, and evidence boundaries", () => {
  for (const role of ["researcher", "planner", "reviewer", "frontend", "creative"]) {
    assert.deepEqual(resolveRoleRoute(local, role), local);
    assert.deepEqual(resolveRoleRoute({ ...local, model: "sonnet", timeoutSeconds: 7200 }, role), {
      ...local, model: "sonnet", timeoutSeconds: 7200,
    });
    assert.throws(() => resolveRoleRoute({ ...local, model: " sonnet " }, role), /model/);
  }
  for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(resolveRoleRoute({ ...local, reasoningEffort }, "planner").reasoningEffort, reasoningEffort);
  }
  const invalid = [
    [{ backend: "local-cli", model: "opus" }, /cli/],
    [{ backend: "local-cli", cli: "claude" }, /model/],
    [{ ...local, model: " " }, /model/],
    [{ ...local, provider: "openai" }, /provider/],
    [{ ...local, provider: undefined }, /provider/],
    [{ ...local, maxTokens: 100 }, /maxTokens/],
    [{ ...local, maxTokens: undefined }, /maxTokens/],
    [{ ...local, cli: "gemini" }, /antigravity/],
    [{ ...local, model: "-model" }, /model/],
    [{ ...local, model: "two models" }, /model/],
    [{ ...local, model: "model\u0000" }, /model/],
    [{ ...local, cli: "codex", reasoningEffort: "HIGH" }, /reasoningEffort/],
    [{ ...local, cli: "antigravity", reasoningEffort: "max" }, /reasoningEffort/],
    [{ ...local, cli: "grok", reasoningEffort: "custom" }, /reasoningEffort/],
    [{ ...local, cli: "other" }, /cli/],
    [{ ...local, reasoningEffort: "minimal" }, /reasoningEffort/],
    [{ ...local, timeoutSeconds: 0 }, /timeoutSeconds/],
    [{ ...local, timeoutSeconds: -1 }, /timeoutSeconds/],
    [{ ...local, timeoutSeconds: 7201 }, /timeoutSeconds/],
    [{ ...local, timeoutSeconds: 1.5 }, /timeoutSeconds/],
    [{ ...local, timeoutSeconds: "1200" }, /timeoutSeconds/],
    [{ ...local, extra: true }, /field/i],
  ];
  for (const [route, error] of invalid) assert.throws(() => resolveRoleRoute(route, "planner"), error);
  assert.deepEqual(resolveRoleRoute({ ...api, reasoningEffort: "custom-provider-effort" }, "researcher"), {
    ...api, reasoningEffort: "custom-provider-effort",
  });
  assert.throws(() => resolveRoleRoute({ ...api, cli: "claude" }, "planner"), /unknown fields/);
  assert.throws(() => resolveRoleRoute({ ...api, backend: "api" }, "planner"), /unknown fields/);
});

test("all four CLI routes persist user options and render their adapter identity", async (t) => {
  const path = fixture(t);
  const tool = createRoutingConfigTool(path);
  for (const [cli, model, reasoningEffort] of [
    ["claude", "opus", "max"], ["codex", "gpt-6.1-sol", "minimal"],
    ["antigravity", "gemini-3.8-flash-high", "high"], ["grok", "grok-code", "none"],
  ]) {
    const route = { backend: "local-cli", cli, model, reasoningEffort };
    for (const role of ["researcher", "planner", "reviewer", "frontend", "creative"]) assert.deepEqual(resolveRoleRoute(route, role), route);
    const result = await applyRoutingConfigAction(path, { action: "set", responsibility: "frontend", ...route });
    assert.deepEqual(result.roles.frontend, route);
    assert.deepEqual(readRoutingStore(path).roles.frontend, route);
    assert.ok(tool.output.render({}, result)[0].text.includes(`local-cli:${cli}/${model} (reasoning: ${reasoningEffort})`));
    assert.ok(tool.parameters.properties.cli.enum.includes(cli));
    assert.ok(tool.output.schema.properties.roles.properties.frontend.oneOf[1].properties.cli.enum.includes(cli));
  }
  const explicit = await applyRoutingConfigAction(path, { action: "set", responsibility: "frontend", ...local, timeoutSeconds: 1200 });
  assert.equal(explicit.roles.frontend.timeoutSeconds, 1200);
});

test("show distinguishes verified and mismatched reasoning evidence and denied actions", async (t) => {
  const path = fixture(t);
  const route = { backend: "local-cli", cli: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" };
  for (const verification of ["verified", "mismatch"]) {
    const latestRoute = {
      turn: 1, step: 1, responsibility: "planner", status: verification === "verified" ? "applied" : "mismatch",
      routeMode: "child", routeSource: "persisted-mapping", fallbackUsed: verification === "mismatch",
      requestedRoute: route, actualRoute: verification === "verified" ? route : { backend: route.backend, cli: route.cli, model: route.model },
      reasoningEffortVerification: verification, deniedActionsCount: 0,
    };
    const result = await applyRoutingConfigAction(path, { action: "show" }, { latestRoute });
    const text = createRoutingConfigTool(path).output.render({}, result)[0].text;
    assert.ok(text.includes(`reasoningEffortVerification=${verification}`));
    assert.match(text, /deniedActionsCount=0/);
    assert.doesNotMatch(text, /requested only/);
  }
});

test("set requires explicit local CLI and model, skips API resolution, and persists v3 only while needed", async (t) => {
  const path = fixture(t);
  let resolverCalls = 0;
  const events = [];
  const options = {
    resolveCallConfig: async (route) => { resolverCalls += 1; return { config: route }; },
    onConfigured: (event) => events.push(event),
  };
  for (const route of [
    { backend: "local-cli", model: "opus" },
    { backend: "local-cli", cli: "claude" },
    { ...local, provider: undefined },
    { ...local, maxTokens: undefined },
  ]) {
    await assert.rejects(applyRoutingConfigAction(path, { action: "set", responsibility: "planner", ...route }, options));
    assert.equal(existsSync(path), false);
  }
  await applyRoutingConfigAction(path, { action: "set", responsibility: "reviewer", ...api }, options);
  assert.equal(resolverCalls, 1);
  assert.equal(readRoutingStore(path).schemaVersion, 2);
  const result = await applyRoutingConfigAction(path, { action: "set", responsibility: "planner", ...local }, options);
  assert.equal(resolverCalls, 1);
  assert.equal(events.at(-1).validationStatus, undefined);
  assert.deepEqual(result.roles.planner, local);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, "utf8")).roles.planner, "timeoutSeconds"), false);
  assert.equal(result.dispatch.planner, undefined);
  assert.equal(readRoutingStore(path).schemaVersion, 3);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, 3);
  await applyRoutingConfigAction(path, { action: "remove", responsibility: "planner" }, options);
  assert.equal(readRoutingStore(path).schemaVersion, 2);
  assert.deepEqual(readRoutingStore(path).roles, { reviewer: api });
});

test("routing stores read schemas 1, 2, 3 and reject stored or deployment local same-turn", (t) => {
  const path = fixture(t);
  for (const schemaVersion of [1, 2, 3]) {
    store(path, { planner: api }, {}, schemaVersion);
    assert.deepEqual(readRoutingStore(path), { schemaVersion, roles: { planner: api }, dispatch: {} });
  }
  store(path, { frontend: local }, { frontend: "same-turn" });
  assert.throws(() => readRoutingStore(path), /local-cli.*child.*same-turn/);
  assert.throws(() => resolveConfig({ routing: { roles: { planner: local }, dispatch: { planner: "same-turn" } } }), /local-cli.*child.*same-turn/);
  const configured = resolveConfig({ routing: { roles: { planner: local } } });
  assert.equal(configured.routing.roles.planner.backend, "local-cli");
  assert.equal(configured.routing.dispatch.planner, undefined);
});

test("effective snapshots reject local same-turn across persisted and deployment sources", (t) => {
  const path = fixture(t);
  store(path, { planner: local });
  assert.throws(() => effectiveRoutingSnapshot(path, {}, { planner: "same-turn" }), /local-cli.*same-turn/);
  store(path, {}, { planner: "same-turn" }, 2);
  assert.throws(() => effectiveRoutingSnapshot(path, { planner: local }), /local-cli.*same-turn/);
  store(path, { planner: local }, { planner: "child" });
  const snapshot = effectiveRoutingSnapshot(path, {}, { planner: "same-turn" });
  assert.equal(snapshot.dispatch.planner, "child");
  assert.equal(snapshot.dispatchSources.planner, "persisted-config");
});

test("set and dispatch changes reject effective same-turn conflicts before writing", async (t) => {
  const path = fixture(t);
  store(path, {}, { planner: "same-turn" }, 2);
  let before = readFileSync(path, "utf8");
  await assert.rejects(applyRoutingConfigAction(path, { action: "set", responsibility: "planner", ...local }), /local-cli.*same-turn/);
  assert.equal(readFileSync(path, "utf8"), before);
  store(path, { planner: local });
  before = readFileSync(path, "utf8");
  await assert.rejects(applyRoutingConfigAction(path, { action: "set-dispatch", responsibility: "planner", dispatch: "same-turn" }), /local-cli.*same-turn/);
  assert.equal(readFileSync(path, "utf8"), before);
  await applyRoutingConfigAction(path, { action: "set-dispatch", responsibility: "planner", dispatch: "child" });
  before = readFileSync(path, "utf8");
  await assert.rejects(applyRoutingConfigAction(path, { action: "reset-dispatch", responsibility: "planner" }, {
    configuredDispatch: { planner: "same-turn" },
  }), /local-cli.*same-turn/);
  assert.equal(readFileSync(path, "utf8"), before);
  store(path, { planner: api }, { planner: "same-turn" }, 2);
  before = readFileSync(path, "utf8");
  await assert.rejects(applyRoutingConfigAction(path, { action: "remove", responsibility: "planner" }, {
    configuredRoles: { planner: local },
  }), /local-cli.*same-turn/);
  assert.equal(readFileSync(path, "utf8"), before);
  store(path, {}, {}, 2);
  await assert.rejects(applyRoutingConfigAction(path, { action: "set", responsibility: "planner", ...local }, {
    configuredDispatch: { planner: "same-turn" },
  }), /local-cli.*same-turn/);
  await assert.rejects(applyRoutingConfigAction(path, { action: "set-dispatch", responsibility: "planner", dispatch: "same-turn" }, {
    configuredRoles: { planner: local },
  }), /local-cli.*same-turn/);
});

test("show describes both route kinds and labels local effort as requested only", async (t) => {
  const path = fixture(t);
  store(path, { planner: api, frontend: local });
  const latestRoute = {
    turn: 1, step: 1, responsibility: "frontend", status: "applied", routeMode: "child",
    routeSource: "persisted-mapping", fallbackUsed: false, requestedRoute: local,
    actualRoute: { backend: "local-cli", cli: "claude", model: "claude-opus-example" },
    reasoningEffortVerification: "requested-only",
  };
  const result = await applyRoutingConfigAction(path, { action: "show" }, { latestRoute });
  const tool = createRoutingConfigTool(path);
  const text = tool.output.render({}, result)[0].text;
  assert.match(text, /planner: openai\/controller \(reasoningEffort=xhigh, maxTokens=2048\)/);
  assert.match(text, /frontend: local-cli:claude\/opus \(reasoning: high\)/);
  assert.match(text, /actual=local-cli:claude\/claude-opus-example/);
  assert.match(text, /reasoningEffort=high \(requested only; not verified by the local CLI\)/);
  assert.equal(describeModelRoute(api), "openai/controller (reasoningEffort=xhigh, maxTokens=2048)");
  assert.equal(describeModelRoute({ provider: "openai", model: "plain" }), "openai/plain");
  assert.equal(describeModelRoute({ provider: "openai", model: "plain" }, { showUnspecifiedReasoning: true }), "openai/plain (reasoningEffort=unspecified)");
  assert.deepEqual(resolveInPlaceResponsibilityOutputBudgets({ concise: true, maxTokens: 500 }, { frontend: local }), undefined);
  assert.deepEqual(resolveInPlaceResponsibilityOutputBudgets({ concise: true, maxTokens: 500 }, { planner: api, frontend: local }), {
    planner: { source: "responsibility-override", maxTokens: 2048 },
  });
});

test("creative mappings persist API and local CLI options without an implicit dispatch or in-place budget", async (t) => {
  const path = fixture(t);
  const tool = createRoutingConfigTool(path);
  assert.ok(tool.parameters.properties.responsibility.enum.includes("creative"));
  assert.ok(tool.output.schema.properties.roles.properties.creative);
  for (const route of [api, local]) {
    const configured = resolveConfig({ routing: { roles: { creative: route } } });
    assert.deepEqual(configured.routing.roles.creative, route);
    assert.equal(configured.routing.dispatch.creative, undefined);
    const result = await applyRoutingConfigAction(path, { action: "set", responsibility: "creative", ...route });
    assert.deepEqual(result.roles.creative, route);
    assert.equal(result.dispatch.creative, undefined);
    assert.deepEqual(readRoutingStore(path).roles.creative, route);
    assert.equal(readRoutingStore(path).schemaVersion, route.backend === "local-cli" ? 3 : 2);
    assert.deepEqual(resolveInPlaceResponsibilityOutputBudgets({ concise: true, maxTokens: 500 }, { creative: route }), undefined);
    await applyRoutingConfigAction(path, { action: "set-dispatch", responsibility: "creative", dispatch: "child" });
    assert.equal(readRoutingStore(path).dispatch.creative, "child");
    await applyRoutingConfigAction(path, { action: "reset-dispatch", responsibility: "creative" });
    assert.equal(readRoutingStore(path).dispatch.creative, undefined);
  }
  await applyRoutingConfigAction(path, { action: "remove", responsibility: "creative" });
  assert.deepEqual(readRoutingStore(path).roles, {});
  assert.equal(readRoutingStore(path).schemaVersion, 2);
});

test("creative rejects same-turn for API, local CLI, and dispatch-only configuration without writing", async (t) => {
  const path = fixture(t);
  const error = /creative.*child.*same-turn/;
  for (const route of [api, local, undefined]) {
    const roles = route ? { creative: route } : {};
    store(path, roles, {}, route?.backend === "local-cli" ? 3 : 2);
    const before = readFileSync(path, "utf8");
    await assert.rejects(applyRoutingConfigAction(path, { action: "set-dispatch", responsibility: "creative", dispatch: "same-turn" }), error);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.throws(() => resolveConfig({ routing: { roles, dispatch: { creative: "same-turn" } } }), error);
    assert.throws(() => effectiveRoutingSnapshot(path, {}, { creative: "same-turn" }), error);
    await assert.rejects(applyRoutingConfigAction(path, { action: "set", responsibility: "creative", ...(route ?? api) }, {
      configuredDispatch: { creative: "same-turn" },
    }), error);
    assert.equal(readFileSync(path, "utf8"), before);
    store(path, roles, { creative: "same-turn" });
    assert.throws(() => readRoutingStore(path), error);
  }
});

test("local route probes do not call the API resolver and equality includes backend and timeout", async () => {
  let calls = 0;
  assert.deepEqual(await probeModelRoute(() => { calls += 1; throw new Error("API resolver must not run"); }, local), { status: "unavailable" });
  assert.equal(calls, 0);
  assert.equal(sameModelRoute(local, { ...local }), true);
  assert.equal(sameModelRoute(local, { ...local, timeoutSeconds: 100 }), false);
  assert.equal(sameModelRoute(local, { ...local, reasoningEffort: "max" }), false);
  assert.equal(sameModelRoute(local, { provider: "claude", model: "opus", reasoningEffort: "high" }), false);
  assert.equal(sameModelRoute(api, { ...api }), true);
  assert.equal(sameModelRoute(api, { ...api, maxTokens: 500 }), false);
});

test("writer mappings persist API and local CLI options without an implicit dispatch or in-place budget", async (t) => {
  const path = fixture(t);
  const tool = createRoutingConfigTool(path);
  assert.ok(tool.parameters.properties.responsibility.enum.includes("writer"));
  assert.ok(tool.output.schema.properties.roles.properties.writer);
  for (const route of [api, local]) {
    const configured = resolveConfig({ routing: { roles: { writer: route } } });
    assert.deepEqual(configured.routing.roles.writer, route);
    assert.equal(configured.routing.dispatch.writer, undefined);
    const result = await applyRoutingConfigAction(path, { action: "set", responsibility: "writer", ...route });
    assert.deepEqual(result.roles.writer, route);
    assert.equal(result.dispatch.writer, undefined);
    assert.deepEqual(readRoutingStore(path).roles.writer, route);
    assert.equal(readRoutingStore(path).schemaVersion, route.backend === "local-cli" ? 3 : 2);
    assert.deepEqual(resolveInPlaceResponsibilityOutputBudgets({ concise: true, maxTokens: 500 }, { writer: route }), undefined);
    await applyRoutingConfigAction(path, { action: "set-dispatch", responsibility: "writer", dispatch: "child" });
    assert.equal(readRoutingStore(path).dispatch.writer, "child");
    await applyRoutingConfigAction(path, { action: "reset-dispatch", responsibility: "writer" });
    assert.equal(readRoutingStore(path).dispatch.writer, undefined);
  }
  await applyRoutingConfigAction(path, { action: "remove", responsibility: "writer" });
  assert.deepEqual(readRoutingStore(path).roles, {});
  assert.equal(readRoutingStore(path).schemaVersion, 2);
});

test("writer rejects same-turn for API, local CLI, and dispatch-only configuration without writing", async (t) => {
  const path = fixture(t);
  const error = /writer.*child.*same-turn/;
  for (const route of [api, local, undefined]) {
    const roles = route ? { writer: route } : {};
    store(path, roles, {}, route?.backend === "local-cli" ? 3 : 2);
    const before = readFileSync(path, "utf8");
    await assert.rejects(applyRoutingConfigAction(path, { action: "set-dispatch", responsibility: "writer", dispatch: "same-turn" }), error);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.throws(() => resolveConfig({ routing: { roles, dispatch: { writer: "same-turn" } } }), error);
    assert.throws(() => effectiveRoutingSnapshot(path, {}, { writer: "same-turn" }), error);
    await assert.rejects(applyRoutingConfigAction(path, { action: "set", responsibility: "writer", ...(route ?? api) }, {
      configuredDispatch: { writer: "same-turn" },
    }), error);
    assert.equal(readFileSync(path, "utf8"), before);
    store(path, roles, { writer: "same-turn" });
    assert.throws(() => readRoutingStore(path), error);
  }
});
