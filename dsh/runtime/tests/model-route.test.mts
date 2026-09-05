import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyModelRouteFailure,
  probeModelRoute,
  requireModelRoute,
  sameModelRoute,
} from "../build/model-route.mjs";

test("model route failures distinguish invalid routes from environment and transient failures", () => {
  assert.equal(classifyModelRouteFailure({ code: "NO_ADAPTER", message: "missing" }).kind, "deterministic");
  assert.equal(classifyModelRouteFailure({ code: "UNKNOWN_MODEL", message: "missing" }).kind, "deterministic");
  assert.equal(classifyModelRouteFailure({ code: "PI_AI_ERROR", message: "404: model gpt-x does not exist" }).kind, "deterministic");
  assert.equal(classifyModelRouteFailure({ code: "AUTH", message: "401" }).kind, "environment");
  assert.equal(classifyModelRouteFailure({ code: "AUTH", message: "401: requested model does not exist for this account" }).kind, "environment");
  assert.equal(classifyModelRouteFailure({ code: "PERMISSION", message: "model not found in permitted catalog" }).kind, "environment");
  assert.equal(classifyModelRouteFailure({ code: "MISSING_CREDENTIAL", message: "missing key" }).kind, "environment");
  assert.deepEqual(
    classifyModelRouteFailure({ code: "PI_AI_ERROR", message: "request failed", failure: { code: "MODEL_NOT_FOUND", message: "nested missing model" } }),
    { kind: "deterministic", code: "MODEL_NOT_FOUND", message: "nested missing model" },
  );
  assert.deepEqual(
    classifyModelRouteFailure({ code: "PI_AI_ERROR", message: "request failed", failure: { code: "AUTH", message: "nested credentials failed" } }),
    { kind: "environment", code: "AUTH", message: "nested credentials failed" },
  );
  for (const code of ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]) {
    assert.equal(classifyModelRouteFailure({ code, message: code }).kind, "transient");
  }
  assert.equal(classifyModelRouteFailure({ code: "ABORTED", message: "cancelled" }).kind, "cancelled");
  assert.equal(classifyModelRouteFailure(new Error("unclassified")).kind, "unknown");
});

test("model route probe uses non-generating call resolution and preserves exact route fields", async () => {
  const route = { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh", maxTokens: 2_048 };
  let observed;
  const verified = await probeModelRoute(async (config) => {
    observed = config;
    return { config: { ...config, maxTokens: 1_024 } };
  }, route);
  assert.deepEqual(observed, route);
  assert.equal(verified.status, "verified");
  assert.equal(verified.config.maxTokens, 1_024);
  assert.equal((await probeModelRoute(undefined, route)).status, "unavailable");

  await assert.rejects(
    requireModelRoute(async () => {
      const error: NodeJS.ErrnoException = new Error("provider has no configured model");
      error.code = "UNKNOWN_MODEL";
      throw error;
    }, route, undefined, "planner route"),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "UNKNOWN_MODEL"
      && "routeFailureKind" in error
      && error.routeFailureKind === "deterministic",
  );
});

test("same model route compares every user-owned route option", () => {
  const route = { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" };
  assert.equal(sameModelRoute(route, { ...route }), true);
  assert.equal(sameModelRoute(route, { ...route, reasoningEffort: "high" }), false);
  assert.equal(sameModelRoute(route, { ...route, maxTokens: 500 }), false);
});
