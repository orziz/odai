import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";

import type { LegacySessionRepairOptions, LegacySessionRepairResult } from "../../runtime/build/legacy-session-repair.mjs";
import type { DshEvent, DshSessionHeader } from "../../runtime/build/runtime-types.mjs";

interface StoredSession {
  meta: DshSessionHeader;
  events: DshEvent[];
}

interface PersistenceBackend {
  root: string;
  compression: string;
  packChunks: boolean;
  locate(meta: DshSessionHeader): { path: string };
  loadStored(id: string): Promise<StoredSession>;
}

interface PersistenceCoordinatorInstance {
  backend: PersistenceBackend;
  assertEventsSupported(meta: DshSessionHeader, events: readonly DshEvent[]): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sourcePluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(process.env.ODAI_PLUGIN_PACKAGE_ROOT ?? sourcePluginRoot);
const repoRoot = resolve(sourcePluginRoot, "../..");
const dsh = process.env.DSH_BIN ?? "dsh";
const dshRoot = process.env.DSH_PACKAGE_ROOT
  ? resolve(process.env.DSH_PACKAGE_ROOT)
  : findDshPackageRoot(dsh);
const pluginMetadata: unknown = JSON.parse(readFileSync(resolve(pluginRoot, "package.json"), "utf8"));
const dshMetadata: unknown = JSON.parse(readFileSync(resolve(dshRoot, "package.json"), "utf8"));
const expectedDshVersion = isRecord(pluginMetadata) && isRecord(pluginMetadata.peerDependencies)
  ? pluginMetadata.peerDependencies["@deepseek-ai/dsh"]
  : undefined;
const actualDshVersion = isRecord(dshMetadata) ? dshMetadata.version : undefined;
if (typeof expectedDshVersion !== "string" || typeof actualDshVersion !== "string") {
  throw new Error("cannot resolve the Plugin or DSH version contract");
}
if (actualDshVersion !== expectedDshVersion) {
  throw new Error(`Plugin verification expects DSH ${expectedDshVersion}, found ${actualDshVersion}; run the isolated release matrix instead`);
}
const repairPath = [
  resolve(pluginRoot, "runtime/legacy-session-repair.mjs"),
  resolve(pluginRoot, "../runtime/build/legacy-session-repair.mjs"),
].find(existsSync);
if (!repairPath) throw new Error("cannot locate the Odai legacy session repair module");

const repairModule: {
  repairLegacySessionLogs(options?: LegacySessionRepairOptions): LegacySessionRepairResult;
} = await import(pathToFileURL(repairPath).href);
const { repairLegacySessionLogs } = repairModule;
const requireFromDsh = createRequire(resolve(dshRoot, "package.json"));
const jsonlModule: { JsonlSessionPersistence: { prototype: PersistenceBackend } } = await import(
  pathToFileURL(requireFromDsh.resolve("@deepseek-ai/dsh-session-persistence-jsonl")).href
);
const persistenceModule: {
  PersistenceCoordinator: { prototype: PersistenceCoordinatorInstance };
  SessionFormatUnsupportedError: new (...arguments_: unknown[]) => Error;
} = await import(pathToFileURL(requireFromDsh.resolve("@deepseek-ai/dsh-session-persistence")).href);
interface AgentPresetProjectionDefinition {
  init(header: DshSessionHeader): unknown;
  apply(state: unknown, event: DshEvent): unknown;
  wire: { view(state: unknown): unknown };
}
const presetModule: {
  agentPresetProjectionDefinition?: AgentPresetProjectionDefinition;
} = await import(pathToFileURL(requireFromDsh.resolve("@deepseek-ai/dsh-agent-presets")).href);
const { JsonlSessionPersistence } = jsonlModule;
const { PersistenceCoordinator, SessionFormatUnsupportedError } = persistenceModule;

function resolvedSessionPreset(input: { header: DshSessionHeader; events: readonly DshEvent[] }): string {
  const projection = presetModule.agentPresetProjectionDefinition;
  if (!projection || typeof projection.init !== "function" || typeof projection.apply !== "function"
    || typeof projection.wire?.view !== "function") {
    throw new Error("DSH Agent preset projection contract is unavailable");
  }
  let state = projection.init(input.header);
  for (const event of input.events) state = projection.apply(state, event);
  const selected = projection.wire.view(state);
  if (typeof selected !== "string" || selected === "") throw new Error("DSH Agent preset projection did not resolve a preset");
  return selected;
}

const scratch = mkdtempSync(resolve(tmpdir(), "odai-dsh-legacy-repair-"));
const sessionRoot = resolve(scratch, "sessions");
const backend: PersistenceBackend = Object.create(JsonlSessionPersistence.prototype);
backend.root = sessionRoot;
backend.compression = "zstd";
backend.packChunks = true;
const coordinator: PersistenceCoordinatorInstance = Object.create(PersistenceCoordinator.prototype);
coordinator.backend = backend;

const fixtures = [
  {
    id: "legacy-agent-session",
    cwd: resolve(repoRoot, "agent-session-probe"),
    agentPreset: "standard",
    selectedPreset: "odai",
    tornTail: true,
  },
  {
    id: "legacy-plugin-session",
    cwd: resolve(repoRoot, "plugin-session-probe"),
    agentPreset: "standard",
  },
];
const originals = new Map<string, Buffer>();
const noDshProcesses = (): never[] => [];

try {
  const cliPath = resolve(pluginRoot, "build/bin/odai-dsh-plugin.mjs");
  const cliProbe = spawnSync(process.execPath, [cliPath, "legacy-session-repair", "--dsh-home", scratch], { encoding: "utf8" });
  assert.notEqual(cliProbe.status, 0);
  assert.match(cliProbe.stderr, /rerun legacy-session-repair with --yes/u);
  assert.doesNotMatch(cliProbe.stderr, /runtime is unavailable/u);

  for (const fixture of fixtures) {
    const meta = {
      version: 0,
      id: fixture.id,
      createdAt: 1_700_000_000_000,
      cwd: fixture.cwd,
      delegationDepth: 0,
      agentPreset: fixture.agentPreset,
    };
    const path = backend.locate(meta).path;
    const selected = fixture.selectedPreset === undefined ? [] : [{
      type: "agent-preset/selected",
      seq: 1,
      time: 1_700_000_000_002,
      data: { agentPreset: fixture.selectedPreset },
    }];
    let content = encodeLog(meta, [
      {
        type: "request/context",
        seq: 0,
        time: 1_700_000_000_001,
        data: { provider: "probe-provider", model: "probe-model" },
      },
      ...selected,
      {
        type: "odai/route-decided",
        seq: 1 + selected.length,
        time: 1_700_000_000_002 + selected.length,
        data: { turn: 1, step: 1, reasonCode: "DIRECT_DEFAULT_NO_INDEPENDENT_GAP" },
      },
    ]);
    if (fixture.tornTail) {
      content = Buffer.concat([content, encodeLogFrame([{
        type: "request/context",
        seq: 2 + selected.length,
        time: 1_700_000_000_003 + selected.length,
        data: { provider: "unfinished", model: "unfinished" },
      }]).subarray(0, 8)]);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    originals.set(path, content);

    const stored = await backend.loadStored(fixture.id);
    assert.throws(
      () => coordinator.assertEventsSupported(stored.meta, stored.events),
      (error: unknown) => error instanceof SessionFormatUnsupportedError
        && error.message.includes('event type "odai/route-decided"')
        && error.message.includes("not marked ignorable"),
    );
  }

  const repaired = repairLegacySessionLogs({
    dshHome: scratch,
    confirmDshStopped: true,
    processScanner: noDshProcesses,
  });
  assert.equal(repaired.failures.length, 0);
  assert.equal(repaired.repairedArtifacts, 2);
  assert.equal(repaired.repairedEvents, 2);
  assert.equal(repaired.backupPaths.length, 2);
  assert.equal(repaired.tornArtifacts.length, 1);

  for (const fixture of fixtures) {
    const stored = await backend.loadStored(fixture.id);
    coordinator.assertEventsSupported(stored.meta, stored.events);
    const expectedTypes = fixture.selectedPreset === undefined
      ? ["request/context", "odai/route-decided"]
      : ["request/context", "agent-preset/selected", "odai/route-decided"];
    assert.deepEqual(stored.events.map((event) => event.type), expectedTypes);
    assert.equal(stored.events.find((event) => event.type === "request/context")?.ignorable, undefined);
    assert.equal(stored.events.find((event) => event.type === "odai/route-decided")?.ignorable, true);
    assert.equal(
      resolvedSessionPreset({ header: stored.meta, events: stored.events }),
      fixture.selectedPreset ?? fixture.agentPreset,
    );
    const path = backend.locate(stored.meta).path;
    const backupPath = repaired.backupPaths.find((candidate) => candidate.startsWith(path));
    assert.ok(backupPath);
    assert.deepEqual(readFileSync(backupPath), originals.get(path));
  }

  const repeated = repairLegacySessionLogs({
    dshHome: scratch,
    confirmDshStopped: true,
    processScanner: noDshProcesses,
  });
  assert.equal(repeated.repairedEvents, 0);
  process.stdout.write("Odai legacy session repair verified against the current DSH Session contract\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function encodeLog(meta: DshSessionHeader, events: readonly DshEvent[]): Buffer {
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  const header = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "session", ...meta })}\n`), options);
  return Buffer.concat([header, encodeLogFrame(events)]);
}

function encodeLogFrame(events: readonly DshEvent[]): Buffer {
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  return zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`), options);
}

function findDshPackageRoot(command: string): string {
  const locator = process.platform === "win32" ? "where" : "which";
  const located = existsSync(command)
    ? [resolve(command)]
    : execFileSync(locator, [command], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
  const candidates = new Set<string>();
  for (const path of located) {
    const commandDir = dirname(realpathSync(path));
    candidates.add(commandDir);
    candidates.add(resolve(commandDir, "node_modules/@deepseek-ai/dsh"));
    candidates.add(resolve(commandDir, "../@deepseek-ai/dsh"));
  }
  for (const candidate of candidates) {
    let current = candidate;
    for (;;) {
      try {
        const metadata: unknown = JSON.parse(readFileSync(resolve(current, "package.json"), "utf8"));
        if (isRecord(metadata) && metadata.name === "@deepseek-ai/dsh") return current;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`cannot locate the @deepseek-ai/dsh package behind ${command}`);
}
