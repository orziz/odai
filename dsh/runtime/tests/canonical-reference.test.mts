import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { createCanonicalReferenceTool } from "../build/canonical-reference.mjs";
import { loadSkillBundle } from "../build/skill-bundle.mjs";
import type { DshAgent } from "../src/runtime-types.mjs";

const bundle = loadSkillBundle(resolve(import.meta.dirname, "../../../skills/odai/SKILL.md"));
const agent: DshAgent = { session: { header: {}, snapshotEvents: () => [], append() {} } };

test("canonical references use one selected snapshot and fail closed outside the controller", async () => {
  const tool = createCanonicalReferenceTool({ bundleFor: () => bundle });
  const planning = await tool.execute({ reference: "planning" }, { name: tool.name, agent });
  assert.equal(planning.skillVersion, bundle.manifest.skillVersion);
  assert.equal(planning.runtimeContract, bundle.manifest.runtimeContract);
  assert.equal(planning.digest, bundle.digest);
  assert.equal(planning.contract, bundle.referenceContracts.planning);
  assert.throws(() => tool.execute({ reference: "unknown" }, { name: tool.name, agent }), /reference must be/u);

  const denied = createCanonicalReferenceTool({ bundleFor: () => bundle, isUnavailable: () => true });
  assert.throws(
    () => denied.execute({ reference: "planning" }, { name: tool.name, agent }),
    /only to the controller outside a responsibility scope/u,
  );
});
