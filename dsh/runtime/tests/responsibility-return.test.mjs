import assert from "node:assert/strict";
import test from "node:test";
import { createResponsibilityReturnTool } from "../build/responsibility-return.mjs";
import { createResponsibilityScope } from "../build/responsibility-scope.mjs";
function agent() {
  return { session: { header: {}, snapshotEvents: () => [], append() {} } };
}
function execution(owner) {
  return { name: "odai_responsibility_return", agent: owner };
}
function scope(role) {
  return createResponsibilityScope({
    turn: 1,
    startStep: 1,
    role,
    route: { provider: "openai", model: `${role}-model` },
  });
}
test("same-turn read-only responsibilities return through a validated mechanical handback", async () => {
  const owner = agent();
  let active = scope("planner");
  let returned;
  const tool = createResponsibilityReturnTool({
    activeScopeFor: () => active,
    onReturned(_agent, result) {
      returned = result;
      active = undefined;
    },
  });
  const result = await tool.execute(
    { target: "controller", summary: "The bounded plan is complete.", evidenceRefs: ["src/router.mts:1"] },
    execution(owner),
  );
  assert.equal(result.returned, true);
  assert.equal(result.responsibility, "planner");
  assert.equal(result.target, "controller");
  assert.equal(returned?.scopeId, result.scopeId);
  assert.throws(
    () => tool.execute({ target: "controller", summary: "again", evidenceRefs: ["x"] }, execution(owner)),
    /requires an active same-turn read-only/u,
  );
});
test("responsibility handback accepts only the preserved controller target", () => {
  const owner = agent();
  const tool = createResponsibilityReturnTool({ activeScopeFor: () => scope("planner"), onReturned() {} });
  assert.throws(
    () => tool.execute({ target: "executor", summary: "ready", evidenceRefs: ["plan"] }, execution(owner)),
    /target must be controller/u,
  );
});
