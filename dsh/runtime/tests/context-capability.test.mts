import assert from "node:assert/strict";
import test from "node:test";

import {
  activateRequestedCapabilities,
  createContextCapabilityTool,
  requestedContextCapabilities,
} from "../build/context-capability.mjs";
import type { ContextCapability } from "../build/context-capability.mjs";
import type { DshAgent, DshEvent } from "../build/runtime-types.mjs";
import { classifyContextActivation } from "../build/context-activation.mjs";

function agentWithChild(child = false): DshAgent & { child: boolean } {
  return { child, session: { header: {}, snapshotEvents: () => [], append() {} } };
}

function isChild(agent: DshAgent): boolean {
  return "child" in agent && agent.child === true;
}

test("capability gateway enables an otherwise missed intent for the current turn", async () => {
  const requests: ContextCapability[] = [];
  const tool = createContextCapabilityTool({
    isChild,
    onRequested(_agent, capability) { requests.push(capability); },
  });
  const result = await tool.execute({ capability: "compaction-config" }, { name: "odai_context_capability", agent: agentWithChild(false) });
  assert.deepEqual(result, { capability: "compaction-config", status: "available-next-step" });
  assert.deepEqual(requests, ["compaction-config"]);

  const events: DshEvent[] = [
    { type: "odai/context-capability-requested", data: { turn: 3, step: 1, capability: "compaction-config" } },
    { type: "odai/context-capability-requested", data: { turn: 2, step: 4, capability: "memory" } },
  ];
  const capabilities = requestedContextCapabilities(events, 3);
  assert.deepEqual(capabilities, ["compaction-config"]);
  const activation = activateRequestedCapabilities(classifyContextActivation("这个设置换一下"), capabilities);
  assert.equal(activation.compactionConfig, true);
  assert.equal(activation.memory, false);
});

test("capability gateway performs no child or unknown capability action", async () => {
  const tool = createContextCapabilityTool({ isChild });
  assert.throws(
    () => tool.execute({ capability: "routing-config" }, { name: "odai_context_capability", agent: agentWithChild(true) }),
    /child agents/u,
  );
  assert.throws(
    () => tool.execute({ capability: "unknown" }, { name: "odai_context_capability", agent: agentWithChild(false) }),
    /capability must be/u,
  );
});
