import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  inspectAgentInstallation,
  installAgentPreset,
  renderAgentCompositionForDsh,
  resolveDshHome,
  supportsDshVersion,
  SUPPORTED_DSH_RANGE,
  SUPPORTED_DSH_VERSIONS,
  uninstallAgentPreset,
} from "../src/installer.mjs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new TypeError("expected a JSON object");
  return value;
}

test("Agent composition follows the exact rc.1 support contract", async () => {
  assert.equal(SUPPORTED_DSH_RANGE, "0.1.2-rc.1");
  assert.deepEqual(SUPPORTED_DSH_VERSIONS, ["0.1.2-rc.1"]);
  assert.equal(supportsDshVersion("0.1.2-rc.1"), true);
  for (const unsupported of ["0.1.1-rc.2", "0.1.2-alpha.5", "0.1.2-rc.2", "0.1.2", "0.1.3-alpha.1", "0.1.3"]) {
    assert.equal(supportsDshVersion(unsupported), false, unsupported);
  }

  const source = await readFile(resolve(import.meta.dirname, "../preset/odai/agent.cordis.yml"), "utf8");
  const normalizedSource = source.replace(/\r\n/gu, "\n");
  assert.equal(renderAgentCompositionForDsh(source, "0.1.2-rc.1"), normalizedSource);
  assert.throws(() => renderAgentCompositionForDsh(source, "0.1.1-rc.2"), /unsupported DSH version/u);
  assert.throws(() => renderAgentCompositionForDsh(source, "0.1.3-alpha.1"), /unsupported DSH version/u);
});

test("managed preset rejects removed DSH releases before writing", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-unsupported-version-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  try {
    await writeFixture(sourceRoot, "runtime");
    for (const dshVersion of ["0.1.1-rc.2", "0.1.2-alpha.5", "0.1.2", "0.1.3-alpha.1"]) {
      await assert.rejects(
        installAgentPreset({ dshHome, sourceRoot, dshVersion }),
        /unsupported DSH version/u,
      );
    }
    await assert.rejects(stat(resolve(dshHome, ".agent-presets/odai")), /ENOENT/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("managed preset installs, updates, reports status, and uninstalls", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-installer-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  const evolutionSentinel = resolve(dshHome, "odai/skill-evolution/user-generation.sentinel");
  const memorySentinel = resolve(dshHome, "odai/memory/store.json");
  try {
    await writeFixture(sourceRoot, "first runtime");
    await mkdir(resolve(evolutionSentinel, ".."), { recursive: true });
    await writeFile(evolutionSentinel, "user-owned evolution\n", "utf8");
    await mkdir(resolve(memorySentinel, ".."), { recursive: true });
    await writeFile(memorySentinel, "user-owned semantic memory\n", "utf8");
    const installed = await installAgentPreset({ dshHome, sourceRoot });
    assert.equal(installed.operation, "installed");
    assert.ok(SUPPORTED_DSH_VERSIONS.includes(installed.dshVersion));
    assert.equal((await inspectAgentInstallation({ dshHome })).dshVersion, installed.dshVersion);
    assert.equal(installed.trust, "user");
    assert.match(installed.security, /same privileges as shell access/u);
    assert.equal((await inspectAgentInstallation({ dshHome })).status, "installed");
    const firstCompositionSize = Buffer.byteLength(await readFile(resolve(installed.target, "agent.cordis.yml")));
    if (process.platform !== "win32") {
      assert.equal((await stat(installed.target)).mode & 0o777, 0o700);
      assert.equal((await stat(resolve(installed.target, "runtime/index.mjs"))).mode & 0o777, 0o600);
      assert.equal((await stat(resolve(installed.target, ".odai-agent.json"))).mode & 0o777, 0o600);
    }

    await writeFile(resolve(sourceRoot, "runtime/index.mjs"), "export default 'second runtime';\n", "utf8");
    const updated = await installAgentPreset({ dshHome, sourceRoot });
    assert.equal(updated.operation, "updated");
    assert.match(await readFile(resolve(updated.target, "runtime/index.mjs"), "utf8"), /second runtime/u);
    const secondCompositionSize = Buffer.byteLength(await readFile(resolve(updated.target, "agent.cordis.yml")));
    assert.notEqual(secondCompositionSize, firstCompositionSize);
    assert.equal(await readFile(memorySentinel, "utf8"), "user-owned semantic memory\n");

    const refreshed = await installAgentPreset({ dshHome, sourceRoot });
    const thirdCompositionSize = Buffer.byteLength(await readFile(resolve(refreshed.target, "agent.cordis.yml")));
    assert.notEqual(thirdCompositionSize, secondCompositionSize);

    const removed = await uninstallAgentPreset({ dshHome });
    assert.equal(removed.operation, "uninstalled");
    assert.equal((await inspectAgentInstallation({ dshHome })).status, "absent");
    assert.equal(await readFile(evolutionSentinel, "utf8"), "user-owned evolution\n");
    assert.equal(await readFile(memorySentinel, "utf8"), "user-owned semantic memory\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("normal lifecycle never inspects or rewrites historical session logs", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-session-boundary-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  const sessionPath = resolve(dshHome, "sessions/project/legacy/session.jsonl");
  const session = [
    JSON.stringify({ type: "session", version: 0, id: "legacy", createdAt: 1_700_000_000_000, delegationDepth: 0 }),
    JSON.stringify({ type: "odai/unknown-historical-event", seq: 0, time: 1_700_000_000_001, data: { retained: true } }),
    "",
  ].join("\n");
  try {
    await writeFixture(sourceRoot, "first runtime");
    await mkdir(resolve(sessionPath, ".."), { recursive: true });
    await writeFile(sessionPath, session, "utf8");

    assert.equal((await installAgentPreset({ dshHome, sourceRoot })).operation, "installed");
    assert.equal(await readFile(sessionPath, "utf8"), session);

    await writeFile(resolve(sourceRoot, "runtime/index.mjs"), "export default \"updated runtime\";\n", "utf8");
    assert.equal((await installAgentPreset({ dshHome, sourceRoot })).operation, "updated");
    assert.equal(await readFile(sessionPath, "utf8"), session);

    assert.equal((await uninstallAgentPreset({ dshHome })).operation, "uninstalled");
    assert.equal(await readFile(sessionPath, "utf8"), session);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("managed preset refuses updates and removal after local drift", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-drift-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  try {
    await writeFixture(sourceRoot, "runtime");
    const installed = await installAgentPreset({ dshHome, sourceRoot });
    await writeFile(resolve(installed.target, "agent.cordis.yml"), "locally edited\n", "utf8");

    const status = await inspectAgentInstallation({ dshHome });
    assert.equal(status.status, "drifted");
    assert.ok(status.issues.includes("modified managed file agent.cordis.yml"));
    await assert.rejects(
      installAgentPreset({ dshHome, sourceRoot }),
      /refusing to replace modified preset/u,
    );
    await assert.rejects(
      uninstallAgentPreset({ dshHome }),
      /refusing to remove modified preset/u,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("uninstall refuses to leave an invalid default preset", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-default-"));
  const sourceRoot = resolve(scratch, "source");
  const dshHome = resolve(scratch, "home");
  try {
    await writeFixture(sourceRoot, "runtime");
    await installAgentPreset({ dshHome, sourceRoot });
    await writeFile(resolve(dshHome, "settings.yaml"), "agent-presets:\n  default: odai\n", "utf8");
    await assert.rejects(
      uninstallAgentPreset({ dshHome }),
      /select another agent-presets\.default first/u,
    );
    await writeFile(resolve(dshHome, "settings.yaml"), "agent-presets:\n  default: standard\n", "utf8");
    assert.equal((await uninstallAgentPreset({ dshHome })).operation, "uninstalled");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("published metadata describes complete DSH capabilities in Chinese", async () => {
  const packageMetadata = jsonRecord(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
  const presetMetadata = await readFile(resolve(import.meta.dirname, "../preset/odai/preset.yml"), "utf8");
  const controlCenterPatch = await readFile(resolve(import.meta.dirname, "../control-center.cordis.patch.yml"), "utf8");

  assert.ok(typeof packageMetadata.description === "string");
  assert.ok(isRecord(packageMetadata.engines));
  assert.match(packageMetadata.description, /完整继承 DSH 标准模式 全部能力/u);
  assert.equal(packageMetadata.engines.node, ">=22.15.0");
  assert.ok(isRecord(packageMetadata.exports));
  assert.equal(packageMetadata.exports["./client"], "./client/client.js");
  assert.equal(packageMetadata.exports["./control-center-host"], "./preset/odai/runtime/control-center-host.mjs");
  assert.ok(isRecord(packageMetadata.dsh) && isRecord(packageMetadata.dsh.client));
  assert.equal(packageMetadata.dsh.client.platform, "web");
  assert.match(controlCenterPatch, /^\s+name: odai-dsh-agent$/mu);
  assert.doesNotMatch(controlCenterPatch, /control-center-host/u);
  assert.match(presetMetadata, /^name: odai 治理模式$/mu);
  assert.match(presetMetadata, /^description: 完整继承 DSH 标准模式 全部能力，并叠加 odai 治理、证据与自动路由，以 odai 为总控。$/mu);
});

test("DSH home resolution honors explicit path before the environment", () => {
  assert.equal(resolveDshHome("./explicit", { DSH_HOME: "./environment" }), resolve("./explicit"));
  assert.equal(resolveDshHome(undefined, { DSH_HOME: "./environment" }), resolve("./environment"));
});

test("installer writes through DSH_HOME when no explicit home is provided", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-env-home-"));
  const sourceRoot = resolve(scratch, "source");
  const previous = process.env.DSH_HOME;
  try {
    await writeFixture(sourceRoot, "runtime");
    process.env.DSH_HOME = resolve(scratch, "environment-home");
    const installed = await installAgentPreset({ sourceRoot });
    assert.equal(installed.target, resolve(process.env.DSH_HOME, ".agent-presets/odai"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(scratch, { recursive: true, force: true });
  }
});

async function writeFixture(root: string, runtimeText: string): Promise<void> {
  await Promise.all([
    mkdir(resolve(root, "runtime"), { recursive: true }),
    mkdir(resolve(root, "skills/odai"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, "agent.cordis.yml"), "- id: odai\n  name: ./runtime/index.mjs\n", "utf8"),
    writeFile(resolve(root, "preset.yml"), "name: Odai\n", "utf8"),
    writeFile(resolve(root, "runtime/index.mjs"), `export default ${JSON.stringify(runtimeText)};\n`, "utf8"),
    writeFile(resolve(root, "runtime/session-evidence.mjs"), "export const fixture = true;\n", "utf8"),
    writeFile(resolve(root, "runtime/skill-bundle.mjs"), "export const fixture = true;\n", "utf8"),
    writeFile(resolve(root, "runtime/skill-evolution.mjs"), "export const fixture = true;\n", "utf8"),
    writeFile(resolve(root, "runtime/skill-selection-state.mjs"), "export const fixture = true;\n", "utf8"),
    writeFile(resolve(root, "runtime/skill-selector.mjs"), "export const fixture = true;\n", "utf8"),
    writeFile(resolve(root, "runtime/skill-source-config.mjs"), "export const fixture = true;\n", "utf8"),
    writeFile(resolve(root, "skills/odai/SKILL.md"), "---\nname: odai\n---\n", "utf8"),
    writeFile(resolve(root, "skills/odai/manifest.json"), "{\"schemaVersion\":1}\n", "utf8"),
  ]);
}
