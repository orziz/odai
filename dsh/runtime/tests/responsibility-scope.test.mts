import assert from "node:assert/strict";
import test from "node:test";

import {
  claimResponsibilityScope,
  createResponsibilityScope,
  latestDanglingResponsibilityScope,
  latestStoppedResponsibilityScope,
  pendingResponsibilityInterruption,
  pendingResponsibilityScopeRestoration,
  responsibilityScopeOwnsRequest,
  responsibilityScopeStopReason,
} from "../build/responsibility-scope.mjs";
import type { InPlaceResponsibility } from "../build/responsibility-scope.mjs";
import type { RouteDecision } from "../build/router.mjs";
import type { DshEvent } from "../build/runtime-types.mjs";

const decision: Readonly<RouteDecision> = Object.freeze({
  role: "controller",
  mode: "upgrade",
  reasonCode: "TEST_SCOPE",
  reason: "test scope",
  action: "upgrade",
  signals: [],
});
const baseRoute = Object.freeze({ provider: "openai", model: "controller", reasoningEffort: "high", maxTokens: 500 });
const roleRoute = Object.freeze({ provider: "openai", model: "planner", reasoningEffort: "xhigh" });

function pendingScope(role: InPlaceResponsibility = "planner") {
  return createResponsibilityScope({
    turn: 1,
    startStep: 2,
    role,
    route: roleRoute,
    source: "persisted-mapping",
    decision,
  });
}

test("responsibility scope claims one explicit route chain", () => {
  const pending = pendingScope();
  assert.equal(pending.state, "pending");
  assert.equal(pending.continuationPolicy, "read-only-tool-chain");
  assert.equal(responsibilityScopeOwnsRequest(pending, 1, 2), true);
  assert.equal(responsibilityScopeOwnsRequest(pending, 1, 1), false);
  assert.equal(responsibilityScopeOwnsRequest(pending, 2, 2), false);

  const active = claimResponsibilityScope(pending, {
    step: 2,
    baseRoute,
    temporaryRoute: roleRoute,
    routeMode: "same-turn",
  });
  assert.equal(active.state, "active");
  assert.deepEqual(active.baseRoute, baseRoute);
  assert.equal(responsibilityScopeOwnsRequest(active, 1, 3), true);
});

test("all in-place responsibilities share terminal, direct-user, and turn ownership boundaries", () => {
  for (const role of ["planner", "reviewer", "frontend"] as const) {
    const scope = claimResponsibilityScope(pendingScope(role), {
      step: 2,
      baseRoute,
      temporaryRoute: { ...roleRoute, model: role },
      routeMode: "same-turn",
    });
    assert.equal(
      scope.continuationPolicy,
      ["planner", "reviewer"].includes(role) ? "read-only-tool-chain" : "bounded-work-tool-chain",
      role,
    );
    assert.equal(responsibilityScopeStopReason(scope, {
      type: "assistant/message",
      data: { turn: 1, step: 3, message: { content: [{ type: "text", text: "done" }] } },
    }), "terminal-response", role);
    assert.equal(responsibilityScopeStopReason(scope, {
      type: "agent/inbox/spliced",
      data: { inserted: [{ role: "user", source: { kind: "user" }, content: [] }] },
    }), "direct-user-input", role);
    assert.equal(responsibilityScopeStopReason(scope, {
      type: "turn/end",
      data: { turn: 1 },
    }), "turn-ended", role);
  }
});

test("scope continues only for tool chains and stops at ownership boundaries", () => {
  const scope = claimResponsibilityScope(pendingScope("frontend"), {
    step: 2,
    baseRoute,
    temporaryRoute: roleRoute,
    routeMode: "same-turn",
  });
  assert.equal(scope.continuationPolicy, "bounded-work-tool-chain");
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "assistant/message",
    data: { turn: 1, step: 2, message: { content: [{ type: "tool-call", name: "read" }] } },
  }), undefined);
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "assistant/message",
    data: { turn: 1, step: 3, message: { content: [{ type: "text", text: "done" }] } },
  }), "terminal-response");
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "agent/inbox/spliced",
    data: { inserted: [{ role: "user", source: { kind: "user" }, content: [] }] },
  }), "direct-user-input");
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "agent/inbox/spliced",
    data: { inserted: [{ role: "user", source: { kind: "tool" }, content: [] }] },
  }), undefined);
  assert.equal(responsibilityScopeStopReason(scope, {
    type: "turn/end",
    data: { turn: 1 },
  }), "turn-ended");
});

test("durable scope evidence recovers the base route once and never revives a stopped scope", () => {
  const events: DshEvent[] = [
    { type: "odai/responsibility-scope-started", data: { scopeId: "scope-1", role: "reviewer" } },
    {
      type: "odai/responsibility-scope-claimed",
      data: {
        scopeId: "scope-1",
        role: "reviewer",
        baseRoute,
        temporaryRoute: roleRoute,
      },
    },
  ];
  assert.equal(latestDanglingResponsibilityScope(events)?.scopeId, "scope-1");
  events.push({
    type: "odai/responsibility-scope-stopped",
    data: {
      scopeId: "scope-1",
      role: "reviewer",
      baseRoute,
      temporaryRoute: roleRoute,
      reason: "terminal-response",
    },
  });
  assert.equal(latestDanglingResponsibilityScope(events), undefined);
  assert.equal(pendingResponsibilityScopeRestoration(events)?.scopeId, "scope-1");
  events.push({ type: "request/header", data: { header: { config: roleRoute }, reason: "change" } });
  assert.equal(pendingResponsibilityScopeRestoration(events)?.scopeId, "scope-1");
  events.push({
    type: "odai/responsibility-scope-restored",
    data: { scopeId: "another-scope", status: "applied", actualRoute: baseRoute },
  });
  assert.equal(pendingResponsibilityScopeRestoration(events)?.scopeId, "scope-1");
  events.push({
    type: "odai/responsibility-scope-restored",
    data: { scopeId: "scope-1", status: "unverified", stopReason: "no-effective-request" },
  });
  assert.equal(pendingResponsibilityScopeRestoration(events)?.scopeId, "scope-1");
  events.push({
    type: "odai/responsibility-scope-restored",
    data: { scopeId: "scope-1", status: "mismatch", actualRoute: roleRoute },
  });
  assert.equal(pendingResponsibilityScopeRestoration(events)?.scopeId, "scope-1");
  events.push({
    type: "odai/responsibility-scope-restored",
    data: { scopeId: "scope-1", status: "applied", actualRoute: baseRoute },
  });
  assert.equal(pendingResponsibilityScopeRestoration(events), undefined);
});

test("verified output-limit interruptions remain resumable until consumed or cleared", () => {
  const resumed = createResponsibilityScope({
    turn: 3,
    startStep: 1,
    role: "frontend",
    route: roleRoute,
    source: "persisted-mapping",
    decision,
    resumeOfScopeId: "scope-1",
  });
  assert.equal(resumed.resumeOfScopeId, "scope-1");

  const events: DshEvent[] = [
    {
      type: "odai/responsibility-scope-stopped",
      data: { scopeId: "scope-1", turn: 1, role: "frontend", reason: "terminal-response" },
    },
    {
      type: "odai/responsibility-interrupted",
      data: { scopeId: "scope-1", turn: 1, step: 3, responsibility: "frontend", reason: "max-tokens" },
    },
  ];
  assert.equal(latestStoppedResponsibilityScope(events, 1)?.scopeId, "scope-1");
  assert.equal(pendingResponsibilityInterruption(events)?.responsibility, "frontend");

  events.push({
    type: "odai/responsibility-interruption-consumed",
    data: { scopeId: "scope-1", turn: 3, step: 1, responsibility: "frontend" },
  });
  assert.equal(pendingResponsibilityInterruption(events), undefined);

  events.push({
    type: "odai/responsibility-interrupted",
    data: { scopeId: "scope-2", turn: 4, step: 2, responsibility: "planner", reason: "max-tokens" },
  });
  events.push({
    type: "odai/responsibility-interruption-cleared",
    data: { scopeId: "scope-2", turn: 5, step: 1, responsibility: "planner" },
  });
  assert.equal(pendingResponsibilityInterruption(events), undefined);

  const superseded: DshEvent[] = [
    {
      type: "odai/responsibility-interrupted",
      data: { scopeId: "old-scope", turn: 1, step: 1, responsibility: "planner", reason: "max-tokens" },
    },
    {
      type: "odai/responsibility-interrupted",
      data: { scopeId: "new-scope", turn: 2, step: 1, responsibility: "frontend", reason: "max-tokens" },
    },
    {
      type: "odai/responsibility-interruption-consumed",
      data: { scopeId: "new-scope", turn: 3, step: 1, responsibility: "frontend" },
    },
  ];
  assert.equal(pendingResponsibilityInterruption(superseded), undefined);
});
