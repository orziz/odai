import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const sourcePluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(process.env.ODAI_PLUGIN_PACKAGE_ROOT ?? sourcePluginRoot);
const dshRoot = process.env.DSH_PACKAGE_ROOT
  ? resolve(process.env.DSH_PACKAGE_ROOT)
  : findDshPackageRoot(process.env.DSH_BIN ?? "dsh");
const pluginMetadata = JSON.parse(readFileSync(resolve(pluginRoot, "package.json"), "utf8"));
const dshMetadata = JSON.parse(readFileSync(resolve(dshRoot, "package.json"), "utf8"));
const { satisfies } = await import("semver");
assert.ok(satisfies(dshMetadata.version, pluginMetadata.peerDependencies["@deepseek-ai/dsh"], { includePrerelease: true }));
const requireFromDsh = createRequire(resolve(dshRoot, "package.json"));
const loadSdk = (specifier) => import(pathToFileURL(requireFromDsh.resolve(specifier)).href);
const { Context } = await loadSdk("@deepseek-ai/cordis");
const { SessionStore, SessionId, SESSION_FORMAT_VERSION } = await loadSdk("@deepseek-ai/dsh-session");
const { default: JsonlSessionPersistence } = await loadSdk("@deepseek-ai/dsh-session-persistence-jsonl");
const scratch = mkdtempSync(resolve(tmpdir(), "odai-dsh-legacy-boundary-"));
const ctx = new Context();
new SessionStore(ctx);
const backend = new JsonlSessionPersistence(ctx, { root: resolve(scratch, "sessions"), compression: "zstd" });
try {
  for (const ignorable of [false, true]) {
    const id = ignorable ? "legacy-marked" : "legacy-unmarked";
    const path = resolve(scratch, "sessions", "_no-cwd", id, "session.jsonl.zstd");
    const rows = [
      { type: "session", version: 0, id, createdAt: 1_700_000_000_000, delegationDepth: 0, agentPreset: "odai" },
      {
        type: "odai/route-decided",
        seq: 0,
        time: 1_700_000_000_001,
        ...(ignorable ? { ignorable: true } : {}),
        data: { turn: 1, step: 1, reasonCode: "DIRECT_DEFAULT_NO_INDEPENDENT_GAP" },
      },
    ];
    const original = Buffer.concat(
      [rows.slice(0, 1), rows.slice(1)].map((frame) =>
        zstdCompressSync(Buffer.from(frame.map((row) => JSON.stringify(row)).join("\n") + "\n"), {
          params: { [constants.ZSTD_c_checksumFlag]: 1 },
        }),
      ),
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, original);
    await assert.rejects(async () => {
      const handle = await backend.open(SessionId(id), "read");
      try {
        await handle.read();
      } finally {
        await handle.close();
      }
    }, /unknown historical event type "odai\/route-decided"/u);
    assert.deepEqual(readFileSync(path), original, "SDK refusal must preserve the original artifact");
    const cli = spawnSync(
      process.execPath,
      [resolve(pluginRoot, "build/bin/odai-dsh-plugin.mjs"), "legacy-session-repair", "--dsh-home", scratch, "--yes"],
      { encoding: "utf8" },
    );
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /retired for DSH 0\.1\.5-rc\.1/u);
    assert.match(cli.stderr, /No files were modified/u);
    assert.deepEqual(
      readFileSync(path),
      original,
      "retired repair must not rewrite source messages, presets, or Odai events",
    );
  }
  // Odai notices, memory packets and compaction instructions enter the durable
  // log as inbox splices and user messages; the current format must admit them.
  const runtimeModule = (name) => {
    const candidates = [resolve(pluginRoot, "runtime", name), resolve(pluginRoot, "../runtime/build", name)];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error(`cannot locate Odai runtime module ${name}; checked: ${candidates.join(", ")}`);
    return import(pathToFileURL(found).href);
  };
  const [{ pluginMessage }, { memoryPacketMessage }, { applyCompactionStateProtocol }] = await Promise.all(
    ["runtime-support.mjs", "semantic-memory.mjs", "compaction-config.mjs"].map(runtimeModule),
  );
  const compaction = { purpose: "compaction", messages: [] };
  applyCompactionStateProtocol(compaction);
  const odaiMessages = [pluginMessage("Odai notice", "Odai notice"), memoryPacketMessage("Odai memory packet"), ...compaction.messages];
  const currentId = SessionId("odai-message-sources");
  const writer = await backend.create({
    version: SESSION_FORMAT_VERSION,
    id: currentId,
    createdAt: 1_790_000_000_000,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "odai",
  });
  try {
    await writer.append([
      { type: "turn/start", seq: 0, time: 1_790_000_000_001, data: { turn: 1 } },
      { type: "agent/inbox/spliced", seq: 1, time: 1_790_000_000_002, data: { target: "next-turn", start: 0, inserted: odaiMessages } },
      { type: "step/start", seq: 2, time: 1_790_000_000_003, data: { turn: 1, step: 1 } },
      ...odaiMessages.map((message, index) => ({
        type: "user/message",
        seq: 3 + index,
        time: 1_790_000_000_004 + index,
        data: message,
        surfaceOp: "append",
      })),
    ]);
  } finally {
    await writer.close();
  }
  const reader = await backend.open(currentId, "read");
  try {
    const stored = JSON.stringify(await reader.read());
    for (const message of odaiMessages) {
      assert.ok(stored.includes(message.id), `Odai ${message.source?.form} message was not persisted`);
    }
  } finally {
    await reader.close();
  }
  process.stdout.write(
    "Verified SDK legacy refusal and non-mutating retirement; historical v0 Odai logs are not claimed migrated.\n"
      + `Verified Odai notices, memory packets and compaction instructions persist in session format v${SESSION_FORMAT_VERSION}.\n`,
  );
} finally {
  await ctx.fiber.dispose();
  rmSync(scratch, { recursive: true, force: true });
}
function findDshPackageRoot(command) {
  const locator = process.platform === "win32" ? "where" : "which";
  const located = existsSync(command)
    ? [resolve(command)]
    : execFileSync(locator, [command], { encoding: "utf8" }).trim().split(/\r?\n/u).filter(Boolean);
  const candidates = new Set();
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
        const metadata = JSON.parse(readFileSync(resolve(current, "package.json"), "utf8"));
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
