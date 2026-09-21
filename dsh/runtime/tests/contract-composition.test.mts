import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { composeRoleContract } from "#odai-contracts";
import { loadSkillBundle } from "../build/skill-bundle.mjs";
import { resolveSkillSelection } from "../build/skill-selector.mjs";
import { isUnknownRecord } from "../build/runtime-types.mjs";
const repo = resolve(import.meta.dirname, "../../..");
const canonical = resolve(repo, "skills/odai");
const extension = resolve(repo, "skills/odai-orchestration");
const bundled = loadSkillBundle(resolve(canonical, "SKILL.md"));
function record(value: unknown): Record<string, unknown> { assert.ok(isUnknownRecord(value)); return value; }
async function fixture(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(resolve(tmpdir(), "odai-composition-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("governance loads without orchestration files or a compiler dependency", () => fixture(async root => {
  cpSync(canonical, resolve(root, "odai"), { recursive: true });
  for (const file of ["governance-bundle.mjs", "runtime-types.mjs"]) cpSync(resolve(repo, "dsh/runtime/build", file), resolve(root, file));
  writeFileSync(resolve(root, "odai/SKILL.md"), "---\nname: odai\ndescription: fixture\n---\nGOVERNANCE_PAYLOAD\n");
  const loader = await import(pathToFileURL(resolve(root, "governance-bundle.mjs")).href);
  const loaded = record(loader.loadGovernanceBundle(resolve(root, "odai/SKILL.md")));
  assert.equal(loaded.skillBody, "GOVERNANCE_PAYLOAD");
  assert.equal("roleFiles" in record(loaded.manifest), false);
  assert.equal("orchestration" in loaded, false);
}));
test("composition passes captured payloads once and embeds only declared reference dependencies", () => {
  const manifest = bundled.orchestration.manifest;
  const contents = Object.fromEntries(Object.entries(bundled.orchestration.fileContents).map(([file, bytes]) => [file, Buffer.from(bytes, "base64").toString("utf8")]));
  contents[manifest.delegationFile] = "DELEGATION_PAYLOAD";
  const input = { runtimeContract: bundled.manifest.runtimeContract, skillBody: "GOVERNANCE_PAYLOAD", referenceContracts: bundled.governance.referenceContracts };
  for (const role of Object.keys(manifest.roleFiles)) {
    const text = composeRoleContract(role, input, manifest, contents);
    assert.equal(text.split(input.skillBody).length - 1, 1);
    assert.equal(text.split("DELEGATION_PAYLOAD").length - 1, role === "controller" ? 0 : 1);
    assert.equal(composeRoleContract(role, input, manifest, contents, { embedded: true }).includes(input.skillBody), false);
  }
});
test("invalid orchestration dependencies and empty resources fail without changing governance", () => fixture(root => {
  cpSync(extension, root, { recursive: true });
  const file = resolve(root, "manifest.json"), original = readFileSync(file, "utf8");
  for (const mutate of [
    (value: Record<string, unknown>) => { record(record(value.rolePresets).planner).references = []; },
    (value: Record<string, unknown>) => { record(record(value.rolePresets).frontend).references = ["unknown"]; },
    (value: Record<string, unknown>) => { value.delegationFile = "../outside.md"; },
    (value: Record<string, unknown>) => { value.governanceContract = 99; },
  ]) {
    const value = record(JSON.parse(original)); mutate(value); writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadSkillBundle(resolve(canonical, "SKILL.md"), { orchestrationRoot: root }));
  }
  writeFileSync(file, original);
  writeFileSync(resolve(root, bundled.orchestration.manifest.delegationFile), "\n");
  assert.throws(() => loadSkillBundle(resolve(canonical, "SKILL.md"), { orchestrationRoot: root }), /unavailable|empty/u);
}));
test("governance and orchestration identities change independently and snapshots remain immutable", () => fixture(root => {
  const core = resolve(root, "odai"), orchestration = resolve(root, "orchestration");
  cpSync(canonical, core, { recursive: true }); cpSync(extension, orchestration, { recursive: true });
  const load = () => loadSkillBundle(resolve(core, "SKILL.md"), { orchestrationRoot: orchestration });
  const first = load();
  writeFileSync(resolve(core, "SKILL.md"), `${first.skillText}\nCORE_REVISION\n`);
  const second = load();
  assert.notEqual(first.governance.digest, second.governance.digest);
  assert.equal(first.orchestration.digest, second.orchestration.digest);
  assert.notEqual(first.digest, second.digest);
  assert.equal(first.skillBody.includes("CORE_REVISION"), false);
  const role = resolve(orchestration, second.orchestration.manifest.roleFiles.planner);
  writeFileSync(role, `${readFileSync(role, "utf8")}\nROLE_REVISION\n`);
  const third = load();
  assert.equal(second.governance.digest, third.governance.digest);
  assert.notEqual(second.orchestration.digest, third.orchestration.digest);
  assert.notEqual(second.digest, third.digest);
  assert.equal(second.roleContracts.planner!.includes("ROLE_REVISION"), false);
  assert.equal(third.roleContracts.planner!.includes("ROLE_REVISION"), true);
}));
test("external scripts and neighboring orchestration are ignored; incompatible governance falls back without rewriting", () => fixture(async root => {
  const project = resolve(root, "project"), external = resolve(project, ".dsh/skills/odai");
  mkdirSync(resolve(project, ".git"), { recursive: true }); cpSync(canonical, external, { recursive: true });
  mkdirSync(resolve(external, "scripts"));
  writeFileSync(resolve(external, "scripts/compose-contracts.mjs"), 'throw new Error("EXTERNAL_CODE_EXECUTED");\n');
  const file = resolve(external, "manifest.json"), manifest = record(JSON.parse(readFileSync(file, "utf8")));
  manifest.skillVersion = "9.0.0";
  (manifest.requiredFiles as string[]).push("scripts/compose-contracts.mjs");
  writeFileSync(file, JSON.stringify(manifest));
  const neighbor = resolve(external, "../odai-orchestration"); mkdirSync(neighbor);
  writeFileSync(resolve(neighbor, "manifest.json"), "invalid");
  const env = { DSH_HOME: resolve(root, "home"), DSH_AGENTS_HOME: resolve(root, "agents") };
  const selected = await resolveSkillSelection({ mode: "auto", bundled, cwd: project, env });
  assert.equal(selected.bundle.source, "project-dsh");
  assert.equal(selected.bundle.orchestration.digest, bundled.orchestration.digest);
  manifest.schemaVersion = 3; manifest.runtimeContract = 7; writeFileSync(file, JSON.stringify(manifest));
  const before = readFileSync(file, "utf8");
  const fallback = await resolveSkillSelection({ mode: "auto", bundled, cwd: project, env });
  assert.equal(fallback.bundle, bundled);
  assert.ok(fallback.rejections.some(rejection => rejection.reasonCode === "external-invalid"));
  assert.equal(readFileSync(file, "utf8"), before);
}));
test("copied agent preset and plugin resolve both bundles outside the repository", () => fixture(async root => {
  for (const [name, packageSource] of [["agent", "dsh/agent/preset/odai/package.json"], ["plugin", "dsh/plugin/package.json"]]) {
    const installed = resolve(root, name!); mkdirSync(installed, { recursive: true });
    cpSync(resolve(repo, packageSource!), resolve(installed, "package.json"));
    cpSync(resolve(repo, "dsh/runtime/build"), resolve(installed, "runtime"), { recursive: true });
    cpSync(canonical, resolve(installed, "skills/odai"), { recursive: true });
    cpSync(extension, resolve(installed, "skills/odai-orchestration"), { recursive: true });
    const loader = await import(pathToFileURL(resolve(installed, "runtime/skill-bundle.mjs")).href);
    assert.equal(record(loader.loadSkillBundle(resolve(installed, "skills/odai/SKILL.md"))).digest, bundled.digest);
  }
}));
