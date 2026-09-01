import assert from "node:assert/strict";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  inspectAgentControlCenter,
  installAgentControlCenter,
  uninstallAgentControlCenter,
} from "../src/control-center-installer.mjs";

interface Invocation {
  command: string;
  args: string[];
  options: ExecFileSyncOptionsWithStringEncoding;
}

interface ProfileFixture {
  dependency?: string;
  bundles?: string[];
  resolvedVersion?: string;
  complete?: boolean;
  lockDependency?: string | null;
}

const packageMetadata = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
const targetVersion = packageMetadata.version as string;
const previousVersion = targetVersion.replace(/\.\d+$/u, (value) => `.${Number(value.slice(1)) - 1}`);
const newerVersion = targetVersion.replace(/\.\d+$/u, (value) => `.${Number(value.slice(1)) + 1}`);

async function writeResolvedPackage(profileRoot: string, version: string, complete = true): Promise<void> {
  const root = resolve(profileRoot, "node_modules/odai-dsh-agent");
  await mkdir(resolve(root, "build/src"), { recursive: true });
  await mkdir(resolve(root, "preset/odai/runtime"), { recursive: true });
  await mkdir(resolve(root, "client"), { recursive: true });
  await writeFile(resolve(root, "package.json"), `${JSON.stringify({ name: "odai-dsh-agent", version })}\n`);
  await writeFile(resolve(root, "build/src/installer.mjs"), "export function apply() {}\n");
  if (complete) {
    await writeFile(resolve(root, "preset/odai/runtime/control-center-host.mjs"), "export function apply() {}\n");
    await writeFile(resolve(root, "preset/odai/runtime/control-center-runtime.mjs"), "export const ok = true;\n");
    await writeFile(resolve(root, "client/client.js"), "export {};\n");
  }
}

async function writeProfile(dshHome: string, fixture: ProfileFixture): Promise<string> {
  const profileRoot = resolve(dshHome, "profiles/web");
  await rm(profileRoot, { recursive: true, force: true });
  await mkdir(profileRoot, { recursive: true });
  await writeFile(resolve(profileRoot, "package.json"), `${JSON.stringify({
    name: "dsh-profile-web",
    private: true,
    ...(fixture.dependency ? { dependencies: {
      "odai-dsh-plugin": targetVersion,
      "odai-dsh-agent": fixture.dependency,
    } } : { dependencies: { "odai-dsh-plugin": targetVersion } }),
    dsh: { profile: { bundles: fixture.bundles ?? ["@deepseek-ai/dsh-base", "odai-dsh-plugin"] } },
    unrelated: { preserved: true },
  }, null, 2)}\n`);
  const lockDependency = fixture.lockDependency === undefined ? fixture.dependency : fixture.lockDependency;
  await writeFile(resolve(profileRoot, "pnpm-lock.yaml"), `${JSON.stringify({
    lockfileVersion: "9.0",
    importers: {
      ".": {
        dependencies: {
          "odai-dsh-plugin": { specifier: targetVersion, version: targetVersion },
          ...(lockDependency ? { "odai-dsh-agent": { specifier: lockDependency, version: lockDependency } } : {}),
        },
      },
    },
  }, null, 2)}\n`);
  if (fixture.resolvedVersion) await writeResolvedPackage(profileRoot, fixture.resolvedVersion, fixture.complete ?? true);
  return profileRoot;
}

function registryExecutor(profileRoot: string, calls: Invocation[]) {
  return (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string => {
    calls.push({ command, args, options });
    const packagePath = resolve(profileRoot, "package.json");
    const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
    if (args.includes("add")) {
      metadata.dependencies = { ...(metadata.dependencies ?? {}), "odai-dsh-agent": targetVersion };
      metadata.dsh.profile.bundles = [...new Set([...(metadata.dsh.profile.bundles ?? []), "odai-dsh-agent"])];
      writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      const lockPath = resolve(profileRoot, "pnpm-lock.yaml");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.importers["."].dependencies["odai-dsh-agent"] = { specifier: targetVersion, version: targetVersion };
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      const packageRoot = resolve(profileRoot, "node_modules/odai-dsh-agent");
      writeFileSync(resolve(packageRoot, "package.json"), `${JSON.stringify({ name: "odai-dsh-agent", version: targetVersion })}\n`, "utf8");
    } else {
      delete metadata.dependencies["odai-dsh-agent"];
      metadata.dsh.profile.bundles = metadata.dsh.profile.bundles.filter((entry: string) => entry !== "odai-dsh-agent");
      writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      const lockPath = resolve(profileRoot, "pnpm-lock.yaml");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      delete lock.importers["."].dependencies["odai-dsh-agent"];
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      rm(resolve(profileRoot, "node_modules/odai-dsh-agent"), { recursive: true, force: true }).catch(() => {});
    }
    return "";
  };
}

test("Agent Control Center registry install is explicit, exact, idempotent, and removable", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-center-"));
  const dshHome = resolve(scratch, "home");
  const calls: Invocation[] = [];
  try {
    const profileRoot = await writeProfile(dshHome, {});
    await writeResolvedPackage(profileRoot, targetVersion);
    await rm(resolve(profileRoot, "node_modules/odai-dsh-agent/package.json"), { force: true });
    const execute = registryExecutor(profileRoot, calls);

    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "absent");
    const installed = await installAgentControlCenter({ dshHome, execute });
    assert.equal(installed.operation, "installed");
    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "current");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ["plugin", "--profile", "web", "add", `odai-dsh-agent@${targetVersion}`, "--save-exact"]);
    assert.equal(calls[0]?.options.env?.DSH_HOME, dshHome);

    assert.equal((await installAgentControlCenter({ dshHome, execute })).operation, "unchanged");
    assert.equal(calls.length, 1);

    assert.equal((await uninstallAgentControlCenter({ dshHome, execute })).operation, "uninstalled");
    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "absent");
    const afterRemoval = JSON.parse(readFileSync(resolve(profileRoot, "package.json"), "utf8"));
    assert.equal(afterRemoval.dependencies["odai-dsh-plugin"], targetVersion);
    assert.equal(afterRemoval.dsh.profile.bundles.includes("odai-dsh-plugin"), true);
    assert.equal(calls.length, 2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Control Center inspection distinguishes provenance, versions, and partial ownership", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-states-"));
  const dshHome = resolve(scratch, "home");
  const cases: Array<[string, ProfileFixture, string]> = [
    ["absent", {}, "absent"],
    ["current", { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion }, "current"],
    ["old registry", { dependency: previousVersion, bundles: ["odai-dsh-agent"], resolvedVersion: previousVersion }, "registry-upgrade"],
    ["newer registry", { dependency: newerVersion, bundles: ["odai-dsh-agent"], resolvedVersion: newerVersion }, "newer"],
    ["file source", { dependency: "file:/repo/dsh/agent", bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion, complete: false }, "local-link"],
    ["link source", { dependency: "link:/repo/dsh/agent", bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion }, "local-link"],
    ["dependency only", { dependency: targetVersion, bundles: [], resolvedVersion: targetVersion }, "partial-drift"],
    ["bundle only", { bundles: ["odai-dsh-agent"] }, "partial-drift"],
    ["resolved mismatch", { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: previousVersion }, "partial-drift"],
    ["lock mismatch", { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion, lockDependency: previousVersion }, "partial-drift"],
    ["range source", { dependency: `^${targetVersion}`, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion }, "unknown-source"],
    ["missing runtime", { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion, complete: false }, "partial-drift"],
  ];
  try {
    for (const [label, fixture, expected] of cases) {
      await writeProfile(dshHome, fixture);
      assert.equal((await inspectAgentControlCenter({ dshHome })).status, expected, label);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("explicit repair replaces a broken local source and preserves Plugin coexistence", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-local-repair-"));
  const dshHome = resolve(scratch, "home");
  const calls: Invocation[] = [];
  try {
    const profileRoot = await writeProfile(dshHome, {
      dependency: "link:/repo/dsh/agent",
      bundles: ["odai-dsh-plugin", "odai-dsh-agent"],
      resolvedVersion: targetVersion,
      complete: false,
    });
    await writeResolvedPackage(profileRoot, targetVersion);
    const repaired = await installAgentControlCenter({ dshHome, execute: registryExecutor(profileRoot, calls) });
    assert.equal(repaired.operation, "repaired");
    assert.equal(repaired.previousStatus, "local-link");
    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "current");
    const profile = JSON.parse(await readFile(resolve(profileRoot, "package.json"), "utf8"));
    assert.equal(profile.dependencies["odai-dsh-agent"], targetVersion);
    assert.equal(profile.dependencies["odai-dsh-plugin"], targetVersion);
    assert.equal(profile.dsh.profile.bundles.filter((entry: string) => entry === "odai-dsh-agent").length, 1);
    assert.equal(profile.dsh.profile.bundles.filter((entry: string) => entry === "odai-dsh-plugin").length, 1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("failed local-source repair rolls back profile metadata without touching the preset or Plugin", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-rollback-"));
  const dshHome = resolve(scratch, "home");
  const presetSentinel = resolve(dshHome, ".agent-presets/odai/preset.yml");
  try {
    const profileRoot = await writeProfile(dshHome, {
      dependency: "link:/repo/dsh/agent",
      bundles: ["odai-dsh-plugin", "odai-dsh-agent"],
      resolvedVersion: targetVersion,
    });
    await mkdir(resolve(presetSentinel, ".."), { recursive: true });
    await writeFile(presetSentinel, "preset remains\n");
    const before = await readFile(resolve(profileRoot, "package.json"), "utf8");
    let attempt = 0;
    const execute = (_command: string, args: string[]): string => {
      attempt += 1;
      const packagePath = resolve(profileRoot, "package.json");
      const profile = JSON.parse(readFileSync(packagePath, "utf8"));
      if (attempt === 1) {
        profile.dependencies["odai-dsh-agent"] = targetVersion;
        writeFileSync(packagePath, `${JSON.stringify(profile, null, 2)}\n`);
        throw new Error("injected install failure");
      }
      assert.match(args.join(" "), /add link:\/repo\/dsh\/agent/u);
      return "";
    };
    await assert.rejects(
      installAgentControlCenter({ dshHome, execute }),
      /previous Control Center profile state was restored/u,
    );
    assert.equal(await readFile(resolve(profileRoot, "package.json"), "utf8"), before);
    assert.equal(await readFile(presetSentinel, "utf8"), "preset remains\n");
    const profile = JSON.parse(before);
    assert.equal(profile.dependencies["odai-dsh-plugin"], targetVersion);
    assert.equal(profile.dsh.profile.bundles.includes("odai-dsh-plugin"), true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Control Center refuses partial removal and silent downgrade", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-refuse-"));
  const dshHome = resolve(scratch, "home");
  try {
    await writeProfile(dshHome, { dependency: targetVersion, bundles: [], resolvedVersion: targetVersion });
    await assert.rejects(uninstallAgentControlCenter({ dshHome, execute: () => "" }), /partially owned/u);
    await writeProfile(dshHome, { dependency: newerVersion, bundles: ["odai-dsh-agent"], resolvedVersion: newerVersion });
    await assert.rejects(installAgentControlCenter({ dshHome, execute: () => "" }), /refusing to downgrade/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
