import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRouteProtection,
  createChildToolGuard,
  createRouteProtectionGuard,
  isSubagent,
  summarizeToolResult,
} from "../build/governance.mjs";
function denial(value) {
  if (value === undefined) throw new Error("expected a governance denial");
  return value;
}
const controller = { session: { header: {}, snapshotEvents: () => [], append() {} } };
const child = {
  session: { header: { origin: "subagent", delegationDepth: 1 }, snapshotEvents: () => [], append() {} },
};
test("subagent detection uses durable lineage", () => {
  assert.equal(isSubagent(controller), false);
  assert.equal(isSubagent(child), true);
});
test("guard denies child writes before dispatch but leaves controller writes alone", () => {
  const denied = [];
  const guard = createChildToolGuard({ onDenied: (execution) => denied.push(execution.name) });
  assert.equal(guard({ agent: controller, name: "write" }), undefined);
  assert.match(denial(guard({ agent: child, name: "write" })), /^ODAI_SUBAGENT_BOUNDARY:/u);
  assert.equal(guard({ agent: child, name: "read" }), undefined);
  assert.match(denial(guard({ agent: child, name: "future_side_effect" })), /^ODAI_SUBAGENT_BOUNDARY:/u);
  assert.deepEqual(denied, ["write", "future_side_effect"]);
});
test("child read-only extensions require an explicit allowlist", () => {
  const defaultGuard = createChildToolGuard();
  assert.match(denial(defaultGuard({ agent: child, name: "custom_repository_reader" })), /^ODAI_SUBAGENT_BOUNDARY:/u);
  const extendedGuard = createChildToolGuard({ additionalAllowedTools: ["custom_repository_reader"] });
  assert.equal(extendedGuard({ agent: child, name: "custom_repository_reader" }), undefined);
});
test("additional denials are monotonic", () => {
  const guard = createChildToolGuard({ additionalDeniedTools: ["web_fetch"] });
  assert.match(denial(guard({ agent: child, name: "web_fetch" })), /^ODAI_SUBAGENT_BOUNDARY:/u);
  assert.match(denial(guard({ agent: child, name: "bash" })), /^ODAI_SUBAGENT_BOUNDARY:/u);
});
test("high-impact route protection denies controller mutations only for the active turn", () => {
  const denied = [];
  const protectedEvents = [
    { type: "odai/route-decided", data: { turn: 1, step: 1 } },
    {
      type: "odai/route-protection",
      data: {
        turn: 1,
        step: 1,
        mode: "read-only",
        reasonCode: "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE",
        source: "responsibility-scope-planner",
        scopeId: "scope-1",
      },
    },
  ];
  const protectedController = { session: { header: {}, snapshotEvents: () => protectedEvents, append() {} } };
  const guard = createRouteProtectionGuard({ onDenied: (execution) => denied.push(execution.name) });
  assert.equal(activeRouteProtection(protectedController)?.turn, 1);
  assert.match(denial(guard({ agent: protectedController, name: "write" })), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(denial(guard({ agent: protectedController, name: "bash" })), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(denial(guard({ agent: protectedController, name: "subagent" })), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(
    denial(guard({ agent: protectedController, name: "future_side_effect" })),
    /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u,
  );
  assert.equal(guard({ agent: protectedController, name: "read" }), undefined);
  assert.equal(guard({ agent: protectedController, name: "ask_user_question" }), undefined);
  assert.equal(guard({ agent: protectedController, name: "web_fetch" }), undefined);
  assert.deepEqual(denied, ["write", "bash", "subagent", "future_side_effect"]);
  const restrictedGuard = createRouteProtectionGuard({ additionalDeniedTools: ["web_fetch"] });
  assert.match(
    denial(restrictedGuard({ agent: protectedController, name: "web_fetch" })),
    /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u,
  );
  protectedEvents.push({
    type: "odai/route-protection-released",
    data: { turn: 1, scopeId: "scope-1", reason: "terminal-response" },
  });
  assert.equal(activeRouteProtection(protectedController), undefined);
  assert.equal(guard({ agent: protectedController, name: "write" }), undefined);
  protectedEvents.push({
    type: "odai/route-decided",
    data: { turn: 2, step: 1, reasonCode: "DIRECT_DEFAULT_NO_INDEPENDENT_GAP" },
  });
  assert.equal(activeRouteProtection(protectedController), undefined);
  assert.equal(guard({ agent: protectedController, name: "write" }), undefined);
});
test("old route failures cannot restore whole-turn write protection", () => {
  for (const source of ["route-failure", "route-config-missing", "route-mismatch", undefined]) {
    const agent = {
      session: {
        header: {},
        snapshotEvents: () => [
          { type: "odai/route-decided", data: { turn: 1, step: 1 } },
          { type: "odai/route-protection", data: { turn: 1, mode: "read-only", source, scopeId: "old-scope" } },
        ],
        append() {},
      },
    };
    assert.equal(activeRouteProtection(agent), undefined, source);
    assert.equal(createRouteProtectionGuard()({ agent, name: "write" }), undefined, source);
  }
});
test("read-only responsibility remains enforced without risk protection", () => {
  let active = true;
  let lookups = 0;
  const guard = createRouteProtectionGuard({
    isReadOnlyResponsibility: (agent) => agent === controller && active,
    protectionFor() {
      lookups += 1;
      return undefined;
    },
    additionalDeniedTools: ["web_fetch"],
  });
  for (const name of ["write", "edit", "bash", "pwsh", "future_side_effect", "web_fetch"]) {
    assert.match(
      denial(guard({ agent: controller, name, arguments: { file_path: "unrelated/notes.md" } })),
      /active read-only responsibility/,
    );
  }
  for (const name of ["read", "glob", "grep", "ask_user_question", "odai_responsibility_return"]) {
    assert.equal(guard({ agent: controller, name }), undefined);
  }
  assert.equal(lookups, 0);
  active = false;
  assert.equal(guard({ agent: controller, name: "write" }), undefined);
  assert.equal(lookups, 1);
});
test("tool summaries retain evidence identity without arguments or output", () => {
  assert.deepEqual(
    summarizeToolResult({ callId: "call-1", rootCallId: "root-1", name: "read", agent: child }, { isError: false }),
    { callId: "call-1", rootCallId: "root-1", tool: "read", child: true, isError: false },
  );
});
