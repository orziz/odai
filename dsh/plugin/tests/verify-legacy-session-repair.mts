import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sourcePluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(process.env.ODAI_PLUGIN_PACKAGE_ROOT ?? sourcePluginRoot);
const dshRoot = process.env.DSH_PACKAGE_ROOT
  ? resolve(process.env.DSH_PACKAGE_ROOT)
  : findDshPackageRoot(process.env.DSH_BIN ?? "dsh");
const pluginMetadata = JSON.parse(readFileSync(resolve(pluginRoot, "package.json"), "utf8"));
const dshMetadata = JSON.parse(readFileSync(resolve(dshRoot, "package.json"), "utf8"));
assert.equal(dshMetadata.version, pluginMetadata.peerDependencies["@deepseek-ai/dsh"]);
const requireFromDsh = createRequire(resolve(dshRoot, "package.json"));
const loadSdk = (specifier: string) => import(pathToFileURL(requireFromDsh.resolve(specifier)).href);
const { Context } = await loadSdk("@deepseek-ai/cordis");
const { SessionStore, SessionId } = await loadSdk("@deepseek-ai/dsh-session");
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
      // Minimal refusal counterexample, not a claimed migratable conversation.
      { type: "odai/route-decided", seq: 0, time: 1_700_000_000_001, ...(ignorable ? { ignorable: true } : {}), data: {
        turn: 1, step: 1, reasonCode: "DIRECT_DEFAULT_NO_INDEPENDENT_GAP",
      } },
    ];
    const original = Buffer.concat([rows.slice(0, 1), rows.slice(1)].map((frame) =>
      zstdCompressSync(Buffer.from(frame.map((row) => JSON.stringify(row)).join("\n") + "\n"), {
        params: { [constants.ZSTD_c_checksumFlag]: 1 },
      })));

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, original);
    await assert.rejects(async () => {
      const handle = await backend.open(SessionId(id), "read");
      try { await handle.read(); } finally { await handle.close(); }
    }, /unknown historical event type "odai\/route-decided"/u);
    assert.deepEqual(readFileSync(path), original, "SDK refusal must preserve the original artifact");

    const cli = spawnSync(process.execPath, [resolve(pluginRoot, "build/bin/odai-dsh-plugin.mjs"),
      "legacy-session-repair", "--dsh-home", scratch, "--yes"], { encoding: "utf8" });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /retired for DSH 0\.1\.5-rc\.1/u);
    assert.match(cli.stderr, /No files were modified/u);
    assert.deepEqual(readFileSync(path), original, "retired repair must not rewrite source messages, presets, or Odai events");
  }
  process.stdout.write("Verified SDK legacy refusal and non-mutating retirement; historical v0 Odai logs are not claimed migrated.\n");
} finally {
  await ctx.fiber.dispose();
  rmSync(scratch, { recursive: true, force: true });
}

function findDshPackageRoot(command: string): string {
  const locator = process.platform === "win32" ? "where" : "which";
  const located = existsSync(command) ? [resolve(command)]
    : execFileSync(locator, [command], { encoding: "utf8" }).trim().split(/\r?\n/u).filter(Boolean);
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
