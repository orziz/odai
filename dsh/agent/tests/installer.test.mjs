import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  inspectAgentInstallation,
  inspectLegacyAgentPreset,
  moveLegacyAgentPreset,
  resolveDshHome,
  supportsDshVersion,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSIONS,
} from "../build/src/installer.mjs";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
function jsonRecord(text) {
  const value = JSON.parse(text);
  if (!isRecord(value)) throw new TypeError("expected a JSON object");
  return value;
}
test("Agent admits newer stable and prerelease hosts without extending a version list", () => {
  assert.equal(SUPPORTED_DSH_RANGE, ">=0.1.7-rc.1");
  assert.deepEqual(SUPPORTED_DSH_VERSIONS, ["0.1.7-rc.1"]);
  for (const admitted of ["0.1.7-rc.1", "0.1.7-rc.2", "0.1.7", "0.1.8-alpha.1", "0.2.0-rc.1", "1.0.0"]) {
    assert.equal(supportsDshVersion(admitted), true, admitted);
  }
  for (const unsupported of ["0.1.5-rc.2", "0.1.7-alpha.2", "", "not-semver"]) {
    assert.equal(supportsDshVersion(unsupported), false, unsupported);
  }
});
test("published bundle declares the odai preset and Control Center through DSH patches", async () => {
  const packageMetadata = jsonRecord(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
  assert.equal(packageMetadata.engines.node, ">=22.15.0");
  assert.equal(packageMetadata.peerDependencies["@deepseek-ai/dsh"], "*");
  assert.equal(packageMetadata.exports["./governance"], "./preset/odai/odai-governance.mjs");
  assert.equal(packageMetadata.exports["./client"], "./client/client.js");
  assert.equal(packageMetadata.exports["./control-center-host"], "./preset/odai/runtime/control-center-host.mjs");
  assert.deepEqual(packageMetadata.dsh.bundle.patch, ["./preset.cordis.patch.yml", "./control-center.cordis.patch.yml"]);
  assert.ok(packageMetadata.files.includes("preset.cordis.patch.yml"));
  assert.equal(packageMetadata.dsh.client.platform, "web");
  const js = { tag: "!!js", resolve: (value) => value };
  const presetPatch = parseYaml(await readFile(resolve(import.meta.dirname, "../preset.cordis.patch.yml"), "utf8"), { customTags: [js] });
  const declaration = presetPatch[0].insert[0];
  assert.equal(declaration.name, "@deepseek-ai/dsh-agent-preset");
  assert.equal(declaration.config.id, "odai", "saved sessions resolve their preset by this id");
  const rows = new Map();
  const collect = (entries) => {
    for (const entry of entries) {
      rows.set(entry.id, entry);
      if (Array.isArray(entry.config)) collect(entry.config);
    }
  };
  collect(declaration.config.plugins);
  assert.equal(rows.get("odai-governance").name, "odai-dsh-agent/governance");
  assert.equal(rows.get("workflow-ptc").name, "@deepseek-ai/dsh-workflow-ptc");
  assert.equal([...rows.values()].some((row) => row.name === "@deepseek-ai/dsh-workflow-worker-thread"), false);
  assert.equal(rows.get("tool-ralph").disabled, true);
  assert.equal(rows.get("tool-plugin-manager").disabled, true);
  const controlCenterPatch = await readFile(resolve(import.meta.dirname, "../control-center.cordis.patch.yml"), "utf8");
  assert.match(controlCenterPatch, /^\s+name: odai-dsh-agent$/mu);
});
test("status reports an absent bundle and no legacy directory in an empty home", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-status-"));
  try {
    const status = await inspectAgentInstallation({ dshHome: resolve(scratch, "home") });
    assert.equal(status.status, "absent");
    assert.equal(status.presetId, "odai");
    assert.equal(status.legacy.status, "absent");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("legacy preset cleanup moves the directory into a backup and touches no user data", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-legacy-"));
  const dshHome = resolve(scratch, "home");
  const legacyRoot = resolve(dshHome, ".agent-presets/odai");
  const memorySentinel = resolve(dshHome, "odai/memory/store.json");
  const sessionPath = resolve(dshHome, "sessions/project/legacy/session.jsonl");
  try {
    await writeLegacyPreset(legacyRoot);
    await mkdir(resolve(memorySentinel, ".."), { recursive: true });
    await writeFile(memorySentinel, "user-owned semantic memory\n", "utf8");
    await mkdir(resolve(sessionPath, ".."), { recursive: true });
    await writeFile(sessionPath, '{"type":"session","version":0}\n', "utf8");
    const inspected = await inspectLegacyAgentPreset({ dshHome });
    assert.equal(inspected.status, "installed");
    assert.equal(inspected.version, "0.2.36");
    assert.equal((await inspectAgentInstallation({ dshHome })).legacy.status, "installed");
    const moved = await moveLegacyAgentPreset({ dshHome });
    assert.equal(moved.operation, "moved");
    assert.equal(moved.previousStatus, "installed");
    await assert.rejects(stat(legacyRoot), /ENOENT/u);
    assert.match(await readFile(resolve(moved.backup, "agent.cordis.yml"), "utf8"), /odai-governance/u);
    assert.equal((await inspectLegacyAgentPreset({ dshHome })).status, "absent");
    assert.equal((await moveLegacyAgentPreset({ dshHome })).operation, "absent");
    assert.equal(await readFile(memorySentinel, "utf8"), "user-owned semantic memory\n");
    assert.equal(await readFile(sessionPath, "utf8"), '{"type":"session","version":0}\n');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("a locally edited legacy preset is reported as drifted and its edits survive in the backup", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-legacy-drift-"));
  const dshHome = resolve(scratch, "home");
  const legacyRoot = resolve(dshHome, ".agent-presets/odai");
  try {
    await writeLegacyPreset(legacyRoot);
    await writeFile(resolve(legacyRoot, "agent.cordis.yml"), "locally edited\n", "utf8");
    const inspected = await inspectLegacyAgentPreset({ dshHome });
    assert.equal(inspected.status, "drifted");
    assert.ok(inspected.issues.includes("modified managed file agent.cordis.yml"));
    const moved = await moveLegacyAgentPreset({ dshHome });
    assert.equal(moved.previousStatus, "drifted");
    assert.equal(await readFile(resolve(moved.backup, "agent.cordis.yml"), "utf8"), "locally edited\n");
    assert.deepEqual((await readdir(resolve(dshHome, "odai/legacy-preset-backups"))).length, 1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("legacy cleanup refuses a linked preset parent", async (context) => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-legacy-link-"));
  const dshHome = resolve(scratch, "home");
  const external = resolve(scratch, "external");
  try {
    await mkdir(dshHome, { recursive: true });
    await writeLegacyPreset(resolve(external, "odai"));
    try {
      await symlink(external, resolve(dshHome, ".agent-presets"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(errorCode(error) ?? "")) {
        context.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(moveLegacyAgentPreset({ dshHome }), /symbolic link is not allowed/u);
    assert.equal((await stat(resolve(external, "odai/agent.cordis.yml"))).isFile(), true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("DSH home resolution honors explicit path before the environment", () => {
  assert.equal(resolveDshHome("./explicit", { DSH_HOME: "./environment" }), resolve("./explicit"));
  assert.equal(resolveDshHome(undefined, { DSH_HOME: "./environment" }), resolve("./environment"));
});
async function writeLegacyPreset(root) {
  const files = {
    "agent.cordis.yml": "- id: odai-governance\n  name: ./odai-governance.mjs\n",
    "preset.yml": "name: odai\n",
    "odai-governance.mjs": 'export * from "./runtime/index.mjs";\n',
    "runtime/index.mjs": "export default 'legacy runtime';\n",
  };
  await mkdir(resolve(root, "runtime"), { recursive: true });
  const hashes = {};
  for (const [path, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    await writeFile(resolve(root, path), content, "utf8");
    hashes[path] = createHash("sha256").update(content).digest("hex");
  }
  const manifest = { schemaVersion: 1, package: "odai-dsh-agent", version: "0.2.36", dshVersion: "0.1.5-rc.2", presetId: "odai", files: hashes };
  await writeFile(resolve(root, ".odai-agent.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
