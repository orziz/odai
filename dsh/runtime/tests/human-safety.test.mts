import assert from "node:assert/strict";
import test from "node:test";

import { createHumanCareTool } from "../build/human-care.mjs";
import { createHumanSafetyTool } from "../build/human-safety.mjs";
import type { DshAgent, ToolExecution } from "../build/runtime-types.mjs";

function agentWithChild(child = false): DshAgent & { child: boolean } {
  return { child, session: { header: {}, snapshotEvents: () => [], append() {} } };
}

function isChild(agent: DshAgent): boolean {
  return "child" in agent && agent.child === true;
}

function execution(name: string, child = false): ToolExecution {
  return { name, agent: agentWithChild(child) };
}

test("non-crisis care is separate, argument-free, and never changes routing or persistence", async () => {
  const contract = "先承接感受，再提供一个可选的小步骤。";
  const tool = createHumanCareTool({
    contractFor() { return contract; },
    isChild,
  });
  assert.ok(tool.description);
  assert.ok(tool.parameters);
  assert.match(tool.description, /fatigue, anxiety, self-doubt, rumination, shame, fear of mistakes/iu);
  assert.match(tool.description, /does not diagnose, score, persist state, or change model routing/iu);
  assert.deepEqual(tool.parameters.required, undefined);

  const controller = await tool.execute({}, execution("odai_human_care"));
  assert.equal(controller.scope, "non-crisis-care");
  assert.equal(controller.userChannelOwner, "current-controller");
  assert.equal(controller.contract, contract);
  const child = await tool.execute({}, execution("odai_human_care", true));
  assert.equal(child.userChannelOwner, "controller");
  assert.throws(() => tool.execute({ mood: "anxious" }, execution("odai_human_care")), /accepts no arguments/u);
});

test("human-safety guidance is crisis-specific, proactive, and keeps the controller on the user channel", async () => {
  const contract = "及时干预、主动引导；不得造成二次伤害。";
  const tool = createHumanSafetyTool({
    contractFor() { return contract; },
    isChild,
  });
  assert.ok(tool.description);
  assert.ok(tool.parameters);
  assert.ok(tool.output);
  assert.match(tool.description, /sustained or worsening low mood, hopelessness, burden, self-harm, suicide/iu);
  assert.match(tool.description, /Invoke proactively/iu);
  assert.match(tool.description, /do not diagnose, score, persist state, or change model routing/iu);
  assert.deepEqual(tool.parameters.required, undefined);
  assert.deepEqual(tool.output.schema.required, ["priority", "principles", "userChannelOwner", "contract"]);

  const controller = await tool.execute({}, execution("odai_human_safety"));
  assert.equal(controller.priority, "highest");
  assert.equal(controller.userChannelOwner, "current-controller");
  assert.equal(controller.contract, contract);
  assert.deepEqual(controller.principles, ["timely-intervention", "active-guidance", "no-secondary-harm"]);
  const rendered = tool.output.render({}, controller)[0]?.text;
  assert.ok(rendered);
  assert.match(rendered, /及时干预、主动引导/u);

  const child = await tool.execute({}, execution("odai_human_safety", true));
  assert.equal(child.userChannelOwner, "controller");
  assert.throws(() => tool.execute({ severity: "high" }, execution("odai_human_safety")), /accepts no arguments/u);
});
