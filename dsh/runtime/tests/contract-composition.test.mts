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
const bundled = loadSkillBundle(resolve(canonical, "SKILL.md"));
const contents = Object.fromEntries(Object.entries(bundled.fileContents).map(([file, bytes]) => [file, Buffer.from(bytes, "base64").toString("utf8")]));
function record(value: unknown): Record<string, unknown> { assert.ok(isUnknownRecord(value)); return value; }
async function fixture(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(resolve(tmpdir(), "odai-composition-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("presets share one core, delegate only specialists, and retain owner-specific permissions", () => {
  for (const role of Object.keys(bundled.manifest.rolePresets)) {
    const text = composeRoleContract(role, bundled.manifest, contents);
    assert.equal(text.split("## 精神内核").length - 1, 1);
    assert.equal(text.split("## 受托边界").length - 1, role === "controller" ? 0 : 1);
    assert.equal(text.includes("## 按表现分配支撑"), role === "controller");
    assert.equal(text.includes("## 完成\n"), role === "controller");
    if (role === "controller") assert.ok(text.startsWith(`${bundled.skillBody}\n\n`), "standalone controllers retain the complete entry in source order");
  }
  const frontend = composeRoleContract("frontend", bundled.manifest, contents);
  assert.match(frontend, /已授权且确有写入权限时才实施/u);
  assert.match(frontend, /只读环境返回设计或待应用补丁/u);
  assert.match(composeRoleContract("reviewer", bundled.manifest, contents), /不扫描工作目录/u);
  assert.match(composeRoleContract("planner", bundled.manifest, contents), /plan-only、未决取舍和外部动作边界不因计划通过而消失/u);
});

test("missing dependencies, duplicated modules, unknown owners, and blank modules fail closed", () => fixture(root => {
  cpSync(canonical, root, { recursive: true });
  const manifestFile = resolve(root, "manifest.json");
  const original = readFileSync(manifestFile, "utf8");
  const mutations: Array<(manifest: Record<string, unknown>) => void> = [
    manifest => { record(record(manifest.rolePresets).planner).modules = ["core"]; },
    manifest => { record(record(manifest.rolePresets).planner).references = []; },
    manifest => { record(record(manifest.rolePresets).reviewer).modules = ["core", "delegation", "delegation"]; },
    manifest => { record(record(manifest.rolePresets).frontend).references = ["unknown"]; },
    manifest => { record(manifest.moduleFiles).core = "../outside.md"; },
    manifest => { delete record(manifest.moduleFiles).delegation; },
    manifest => { record(record(manifest.rolePresets).controller).modules = ["core", "delegation"]; },
  ];
  for (const mutate of mutations) {
    const manifest = record(JSON.parse(original));
    mutate(manifest);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => loadSkillBundle(resolve(root, "SKILL.md")), /must include|missing a required|unique known|invalid owners|unsafe or undeclared/u);
  }
  writeFileSync(manifestFile, original);
  for (const file of Object.values(bundled.manifest.moduleFiles)) {
    const path = resolve(root, file);
    const body = readFileSync(path, "utf8");
    writeFileSync(path, " \n");
    assert.throws(() => loadSkillBundle(resolve(root, "SKILL.md")), /empty|unavailable/u);
    writeFileSync(path, body);
  }
  const entry = resolve(root, "SKILL.md");
  const source = readFileSync(entry, "utf8");
  for (const heading of ["精神内核", "当前判断", "共同行动边界"]) {
    const empty = source.replace(new RegExp(`(^## ${heading}\\r?\\n)[\\s\\S]*?(?=^## )`, "mu"), "$1\n");
    assert.notEqual(empty, source);
    writeFileSync(entry, empty);
    assert.throws(() => loadSkillBundle(entry), /core section is empty/u);
    writeFileSync(entry, `${source}\n## ${heading}\nDuplicate\n`);
    assert.throws(() => loadSkillBundle(entry), /core section must appear exactly once/u);
  }
}));

test("module and preset changes affect the digest and captured contracts remain immutable", () => fixture(root => {
  cpSync(canonical, root, { recursive: true });
  const path = resolve(root, "SKILL.md");
  const first = loadSkillBundle(path);
  const corePath = resolve(root, first.manifest.moduleFiles.entry);
  writeFileSync(corePath, readFileSync(corePath, "utf8").replace("## 精神内核\n", "## 精神内核\n\nCORE_REVISION\n"));
  const second = loadSkillBundle(path);
  assert.notEqual(first.digest, second.digest);
  assert.doesNotMatch(first.coreContract, /CORE_REVISION/u);
  assert.match(second.coreContract, /CORE_REVISION/u);
  const manifestFile = resolve(root, "manifest.json");
  const manifest = record(JSON.parse(readFileSync(manifestFile, "utf8")));
  record(record(manifest.rolePresets).researcher).references = ["dao"];
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const third = loadSkillBundle(path);
  assert.notEqual(second.digest, third.digest);
  assert.match(third.roleContracts.researcher!, /Canonical dao reference/u);
  assert.doesNotMatch(second.roleContracts.researcher!, /Canonical dao reference/u);
}));

test("external composition scripts are data and old schema candidates fall back without rewriting", () => fixture(async root => {
  const project = resolve(root, "project");
  const external = resolve(project, ".dsh/skills/odai");
  mkdirSync(resolve(project, ".git"), { recursive: true });
  cpSync(canonical, external, { recursive: true });
  writeFileSync(resolve(external, "scripts/compose-contracts.mjs"), 'throw new Error("EXTERNAL_CODE_EXECUTED");\n');
  const manifestFile = resolve(external, "manifest.json");
  const manifest = record(JSON.parse(readFileSync(manifestFile, "utf8")));
  manifest.skillVersion = "9.0.0";
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const env = { DSH_HOME: resolve(root, "home"), DSH_AGENTS_HOME: resolve(root, "agents") };
  const selected = await resolveSkillSelection({ mode: "auto", bundled, cwd: project, env });
  assert.equal(selected.bundle.source, "project-dsh");
  assert.match(selected.bundle.coreContract, /事由人定/u);
  manifest.schemaVersion = 2; manifest.runtimeContract = 6;
  delete manifest.moduleFiles; delete manifest.rolePresets;
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const before = readFileSync(manifestFile, "utf8");
  const fallback = await resolveSkillSelection({ mode: "auto", bundled, cwd: project, env });
  assert.equal(fallback.bundle, bundled);
  assert.ok(fallback.rejections.some(rejection => rejection.reasonCode === "external-invalid"));
  assert.equal(readFileSync(manifestFile, "utf8"), before);
}));

test("copied agent preset and plugin resolve their own trusted compiler outside the repository", () => fixture(async root => {
  for (const [name, packageSource] of [["agent", "dsh/agent/preset/odai/package.json"], ["plugin", "dsh/plugin/package.json"]]) {
    const installed = resolve(root, name!);
    mkdirSync(installed, { recursive: true });
    cpSync(resolve(repo, packageSource!), resolve(installed, "package.json"));
    cpSync(resolve(repo, "dsh/runtime/build"), resolve(installed, "runtime"), { recursive: true });
    cpSync(canonical, resolve(installed, "skills/odai"), { recursive: true });
    const loader = await import(pathToFileURL(resolve(installed, "runtime/skill-bundle.mjs")).href);
    const loaded: unknown = loader.loadSkillBundle(resolve(installed, "skills/odai/SKILL.md"));
    assert.equal(record(loaded).digest, bundled.digest);
    assert.equal(record(loaded).coreContract, bundled.coreContract);
  }
}));
