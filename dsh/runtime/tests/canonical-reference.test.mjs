import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createCanonicalReferenceTool } from "../build/canonical-reference.mjs";
import { loadSkillBundle } from "../build/skill-bundle.mjs";
import { dshRoleContract } from "../build/role-overlays.mjs";
import { composeRoleContract } from "#odai-contracts";
const bundle = loadSkillBundle(resolve(import.meta.dirname, "../../../skills/odai/SKILL.md"));
const agent = { session: { header: {}, snapshotEvents: () => [], append() {} } };
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
  const contents = Object.fromEntries(
    Object.entries(bundle.orchestration.fileContents).map(([file, bytes]) => [
      file,
      Buffer.from(bytes, "base64").toString("utf8"),
    ]),
  );
  const references = { planning: "PLANNING_OWNER", verification: "VERIFICATION_OWNER", craft: "CRAFT_OWNER" };
  const governance = {
    runtimeContract: bundle.manifest.runtimeContract,
    skillBody: "GOVERNANCE",
    referenceContracts: references,
  };
  for (const [role, owner] of [
    ["planner", "planning"],
    ["reviewer", "verification"],
    ["frontend", "craft"],
  ]) {
    const contract = dshRoleContract(
      role,
      composeRoleContract(role, governance, bundle.orchestration.manifest, contents, { embedded: true }),
    );
    for (const [name, text] of Object.entries(references)) assert.equal(contract.includes(text), name === owner);
    for (const invalid of [undefined, "", 42]) {
      assert.throws(
        () =>
          Reflect.apply(composeRoleContract, undefined, [
            role,
            { ...governance, referenceContracts: { ...references, [owner]: invalid } },
            bundle.orchestration.manifest,
            contents,
          ]),
        /reference .* unavailable/u,
      );
    }
  }
});
