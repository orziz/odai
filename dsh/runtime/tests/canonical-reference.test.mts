import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { createCanonicalReferenceTool } from "../build/canonical-reference.mjs";
import { loadSkillBundle } from "../build/skill-bundle.mjs";
import { dshRoleContract } from "../build/role-overlays.mjs";
import { composeRoleContract } from "#odai-contracts";
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

test("responsibilities receive their owner through the shared compiler and reject invalid content", () => {
  const contents = Object.fromEntries(Object.entries(bundle.fileContents).map(([file, bytes]) => [file, Buffer.from(bytes, "base64").toString("utf8")]));
  const references = { planning: "PLANNING_OWNER", verification: "VERIFICATION_OWNER", craft: "CRAFT_OWNER" };
  for (const [name, text] of Object.entries(references)) contents[bundle.manifest.referenceFiles[name as keyof typeof references]] = text;
  for (const [role, owner] of [["planner", "planning"], ["reviewer", "verification"], ["frontend", "craft"]] as const) {
    const contract = dshRoleContract(role, composeRoleContract(role, bundle.manifest, contents, { embedded: true }));
    for (const [name, text] of Object.entries(references)) {
      assert.equal(contract.includes(text), name === owner, "each responsibility receives only its direct owner");
    }
    for (const invalid of [undefined, "", 42]) {
      assert.throws(() => Reflect.apply(composeRoleContract, undefined, [role, bundle.manifest,
        { ...contents, [bundle.manifest.referenceFiles[owner]]: invalid }]), /contract body is unavailable/u);
    }
  }
});
