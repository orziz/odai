import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  inspectAgentControlCenter,
  installAgentControlCenter,
  uninstallAgentControlCenter,
} from "../build/src/control-center-installer.mjs";
import { MINIMUM_DSH_VERSION } from "../build/src/installer.mjs";
const packageMetadata = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
const targetVersion = packageMetadata.version;
const previousVersion = targetVersion.replace(/\.\d+$/u, (value) => `.${Number(value.slice(1)) - 1}`);
const newerVersion = targetVersion.replace(/\.\d+$/u, (value) => `.${Number(value.slice(1)) + 1}`);
async function writeResolvedPackage(profileRoot, version, complete = true) {
  const root = resolve(profileRoot, "node_modules/odai-dsh-agent");
  await mkdir(resolve(root, "build/src"), { recursive: true });
  await mkdir(resolve(root, "preset/odai/runtime"), { recursive: true });
  await mkdir(resolve(root, "client"), { recursive: true });
  await writeFile(resolve(root, "package.json"), `${JSON.stringify({ name: "odai-dsh-agent", version })}\n`);
  await writeFile(resolve(root, "build/src/installer.mjs"), "export function apply() {}\n");
  if (complete) {
    await mkdir(resolve(root, "preset/odai/skills/odai"), { recursive: true });
    await writeFile(resolve(root, "preset.cordis.patch.yml"), "- insert: []\n");
    await writeFile(resolve(root, "preset/odai/odai-governance.mjs"), "export * from \"./runtime/index.mjs\";\n");
    await writeFile(resolve(root, "preset/odai/runtime/bootstrap.mjs"), "export function apply() {}\n");
    await writeFile(resolve(root, "preset/odai/runtime/compaction-engine.mjs"), "export function apply() {}\n");
    await writeFile(resolve(root, "preset/odai/runtime/index.mjs"), "export function apply() {}\n");
    await writeFile(resolve(root, "preset/odai/skills/odai/SKILL.md"), "---\nname: odai\n---\n");
    await writeFile(resolve(root, "preset/odai/package.json"), JSON.stringify({
      type: "module",
      imports: {
        "#odai-contracts": "./skills/odai-orchestration/scripts/compose-contracts.mjs",
        "#odai-local-cli": "./skills/odai-orchestration/scripts/local-cli.mjs",
        "#odai-recognize-routing": "./skills/odai-orchestration/scripts/recognize-routing.mjs",
      },
    }));
    await writeFile(resolve(root, "preset/odai/skills/odai/manifest.json"), "{}\n");
    await mkdir(resolve(root, "preset/odai/skills/odai-orchestration/scripts"), { recursive: true });
    await writeFile(resolve(root, "preset/odai/skills/odai-orchestration/manifest.json"), "{}\n");
    await writeFile(resolve(root, "preset/odai/skills/odai-orchestration/scripts/compose-contracts.mjs"), "export {};\n");
    await writeFile(resolve(root, "preset/odai/skills/odai-orchestration/scripts/local-cli.mjs"), "export {};\n");
    await writeFile(resolve(root, "preset/odai/skills/odai-orchestration/scripts/recognize-routing.mjs"), "export {};\n");
    await writeFile(resolve(root, "control-center.cordis.patch.yml"), "plugins:\n  - name: odai-dsh-agent\n");
    await writeFile(resolve(root, "preset/odai/runtime/control-center-host.mjs"), "export function apply() {}\n");
    await writeFile(resolve(root, "preset/odai/runtime/control-center-runtime.mjs"), "export const ok = true;\n");
    await writeFile(resolve(root, "client/client.js"), "export {};\n");
  }
}
async function writeProfile(dshHome, fixture) {
  const profileRoot = resolve(dshHome, "profiles/web");
  await rm(profileRoot, { recursive: true, force: true });
  await mkdir(profileRoot, { recursive: true });
  await writeFile(
    resolve(profileRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-profile-web",
        private: true,
        ...(fixture.dependency
          ? { dependencies: { "odai-dsh-plugin": targetVersion, "odai-dsh-agent": fixture.dependency } }
          : { dependencies: { "odai-dsh-plugin": targetVersion } }),
        dsh: { profile: { bundles: fixture.bundles ?? ["@deepseek-ai/dsh-base", "odai-dsh-plugin"] } },
        unrelated: { preserved: true },
      },
      null,
      2,
    )}\n`,
  );
  const lockDependency = fixture.lockDependency === undefined ? fixture.dependency : fixture.lockDependency;
  await writeFile(
    resolve(profileRoot, "pnpm-lock.yaml"),
    `${JSON.stringify(
      {
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: {
              "odai-dsh-plugin": { specifier: targetVersion, version: targetVersion },
              ...(lockDependency
                ? {
                    "odai-dsh-agent": {
                      specifier: lockDependency,
                      version: fixture.lockResolvedVersion ?? lockDependency,
                    },
                  }
                : {}),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  if (fixture.resolvedVersion)
    await writeResolvedPackage(profileRoot, fixture.resolvedVersion, fixture.complete ?? true);
  return profileRoot;
}
function registryExecutor(profileRoot, calls) {
  return (command, args, options) => {
    if (args[0] === "-V") return MINIMUM_DSH_VERSION;
    if (args.includes("--dump-config")) {
      let config = { default: "standard" };
      for (const path of [resolve(profileRoot, "cordis.patch.yml"), resolve(options.env.DSH_HOME, "cordis.patch.yml")]) {
        try {
          const rows = parseYaml(readFileSync(path, "utf8"));
          for (const row of rows ?? []) if (row.id === "agent-preset-registry") config = { ...config, ...row.config };
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return JSON.stringify([{ name: "@deepseek-ai/dsh-agent-preset-registry", config }]);
    }
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
      writeFileSync(
        resolve(packageRoot, "package.json"),
        `${JSON.stringify({ name: "odai-dsh-agent", version: targetVersion })}\n`,
        "utf8",
      );
    } else {
      delete metadata.dependencies["odai-dsh-agent"];
      metadata.dsh.profile.bundles = metadata.dsh.profile.bundles.filter((entry) => entry !== "odai-dsh-agent");
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
  const calls = [];
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
    assert.deepEqual(calls[0]?.args, [
      "plugin",
      "--profile",
      "web",
      "add",
      `odai-dsh-agent@${targetVersion}`,
      "--save-exact",
    ]);
    assert.equal(calls[0]?.options.env?.DSH_HOME, await realpath(dshHome));
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
  const cases = [
    ["absent", {}, "absent"],
    ["current", { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion }, "current"],
    [
      "old registry",
      { dependency: previousVersion, bundles: ["odai-dsh-agent"], resolvedVersion: previousVersion },
      "registry-upgrade",
    ],
    [
      "newer registry",
      { dependency: newerVersion, bundles: ["odai-dsh-agent"], resolvedVersion: newerVersion },
      "newer",
    ],
    [
      "file source",
      {
        dependency: "file:/repo/dsh/agent",
        bundles: ["odai-dsh-agent"],
        resolvedVersion: targetVersion,
        complete: false,
      },
      "local-link",
    ],
    [
      "link source",
      { dependency: "link:/repo/dsh/agent", bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion },
      "local-link",
    ],
    ["dependency only", { dependency: targetVersion, bundles: [], resolvedVersion: targetVersion }, "partial-drift"],
    ["bundle only", { bundles: ["odai-dsh-agent"] }, "partial-drift"],
    [
      "resolved mismatch",
      { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: previousVersion },
      "partial-drift",
    ],
    [
      "lock mismatch",
      {
        dependency: targetVersion,
        bundles: ["odai-dsh-agent"],
        resolvedVersion: targetVersion,
        lockDependency: previousVersion,
      },
      "partial-drift",
    ],
    [
      "lock prefix collision",
      {
        dependency: targetVersion,
        bundles: ["odai-dsh-agent"],
        resolvedVersion: targetVersion,
        lockResolvedVersion: `${targetVersion}0`,
      },
      "partial-drift",
    ],
    [
      "range source",
      { dependency: `^${targetVersion}`, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion },
      "unknown-source",
    ],
    [
      "prerelease",
      { dependency: `${targetVersion}-rc.10`, bundles: ["odai-dsh-agent"], resolvedVersion: `${targetVersion}-rc.10` },
      "registry-upgrade",
    ],
    [
      "different build",
      {
        dependency: `${targetVersion}+build.1`,
        bundles: ["odai-dsh-agent"],
        resolvedVersion: `${targetVersion}+build.1`,
      },
      "partial-drift",
    ],
    [
      "version prefix",
      { dependency: `v${targetVersion}`, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion },
      "unknown-source",
    ],
    [
      "invalid prerelease",
      { dependency: `${targetVersion}-rc.01`, bundles: ["odai-dsh-agent"], resolvedVersion: `${targetVersion}-rc.01` },
      "unknown-source",
    ],
    [
      "missing runtime",
      { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion, complete: false },
      "partial-drift",
    ],
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
test("missing import map or orchestration entry triggers repair instead of unchanged", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-import-repair-"));
  const dshHome = resolve(scratch, "home");
  try {
    const { rmSync } = await import("node:fs");
    for (const [path, damage] of [
      ["preset/odai/package.json", "missing"],
      ["preset/odai/skills/odai-orchestration/scripts/compose-contracts.mjs", "missing"],
      ["preset/odai/package.json", "invalid-map"],
      ["preset/odai/package.json", "directory"],
      ["preset/odai/skills/odai-orchestration/scripts/compose-contracts.mjs", "directory"],
      ["preset/odai/skills/odai-orchestration/scripts/local-cli.mjs", "missing"],
      ["preset/odai/skills/odai-orchestration/scripts/local-cli.mjs", "directory"],
      ["preset/odai/package.json", "invalid-local-cli-map"],
    ]) {
      const profileRoot = await writeProfile(dshHome, { dependency: targetVersion, bundles: ["odai-dsh-agent"], resolvedVersion: targetVersion });
      const file = resolve(profileRoot, "node_modules/odai-dsh-agent", path);
      const original = await readFile(file);
      await rm(file);
      if (damage === "invalid-map") await writeFile(file, '{}');
      if (damage === "invalid-local-cli-map") {
        const metadata = JSON.parse(original.toString());
        delete metadata.imports["#odai-local-cli"];
        await writeFile(file, JSON.stringify(metadata));
      }
      if (damage === "directory") await mkdir(file);
      assert.equal((await inspectAgentControlCenter({ dshHome })).status, "partial-drift", `${path}: ${damage}`);
      const calls = [];
      const registry = registryExecutor(profileRoot, calls);
      const repaired = await installAgentControlCenter({ dshHome, execute(command, args, options) {
        const output = registry(command, args, options);
        if (args.includes("add")) {
          rmSync(file, { recursive: true, force: true });
          writeFileSync(file, original);
        }
        return output;
      } });
      assert.equal(repaired.operation, "repaired");
      assert.equal(calls.filter((call) => call.args.includes("add")).length, 1);
      assert.equal((await inspectAgentControlCenter({ dshHome })).status, "current");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
test("missing Control Center bundle patch is drift and explicit install repairs it", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-patch-"));
  const dshHome = resolve(scratch, "home");
  try {
    const profileRoot = await writeProfile(dshHome, {
      dependency: targetVersion,
      bundles: ["odai-dsh-agent"],
      resolvedVersion: targetVersion,
    });
    const patch = resolve(profileRoot, "node_modules/odai-dsh-agent/control-center.cordis.patch.yml");
    await rm(patch);
    const inspection = await inspectAgentControlCenter({ dshHome });
    assert.equal(inspection.status, "partial-drift");
    assert.ok(inspection.issues.some((issue) => issue.includes("control-center.cordis.patch.yml")));
    const calls = [];
    const registry = registryExecutor(profileRoot, calls);
    const result = await installAgentControlCenter({
      dshHome,
      execute(command, args, options) {
        const output = registry(command, args, options);
        if (args.includes("add")) writeFileSync(patch, "plugins:\n  - name: odai-dsh-agent\n");
        return output;
      },
    });
    assert.equal(result.operation, "repaired");
    assert.equal(calls.length, 1);
    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "current");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("Control Center rejects unsupported hosts before calling the package manager", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-version-"));
  const dshHome = resolve(scratch, "home");
  try {
    const profileRoot = await writeProfile(dshHome, {});
    const before = await readFile(resolve(profileRoot, "package.json"));
    const calls = [];
    await assert.rejects(
      installAgentControlCenter({
        dshHome,
        execute(_command, args) {
          calls.push(args);
          return "0.1.2-rc.1\n";
        },
      }),
      /unsupported DSH version/u,
    );
    assert.deepEqual(calls, [["-V"]]);
    assert.deepEqual(await readFile(resolve(profileRoot, "package.json")), before);
    assert.deepEqual(await readdir(resolve(dshHome, "odai/locks")), []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("explicit repair replaces a broken local source and preserves Plugin coexistence", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-local-repair-"));
  const dshHome = resolve(scratch, "home");
  const calls = [];
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
    assert.equal(profile.dsh.profile.bundles.filter((entry) => entry === "odai-dsh-agent").length, 1);
    assert.equal(profile.dsh.profile.bundles.filter((entry) => entry === "odai-dsh-plugin").length, 1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("failed local-source repair preserves changed profile state and captures recovery evidence", async () => {
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
    let attempts = 0;
    const execute = (_command, args) => {
      if (args[0] === "-V") return MINIMUM_DSH_VERSION;
      attempts += 1;
      const packagePath = resolve(profileRoot, "package.json");
      const profile = JSON.parse(readFileSync(packagePath, "utf8"));
      profile.dependencies["odai-dsh-agent"] = targetVersion;
      writeFileSync(packagePath, `${JSON.stringify(profile, null, 2)}\n`);
      throw new Error("injected install failure");
    };
    await assert.rejects(
      installAgentControlCenter({ dshHome, execute }),
      /automatic rollback was not attempted[\s\S]*current profile state was preserved/u,
    );
    assert.equal(attempts, 1);
    const after = await readFile(resolve(profileRoot, "package.json"), "utf8");
    assert.notEqual(after, before);
    assert.equal(JSON.parse(after).dependencies["odai-dsh-agent"], targetVersion);
    assert.equal(await readFile(presetSentinel, "utf8"), "preset remains\n");
    const backups = await readdir(resolve(dshHome, "odai/control-center-backups"));
    assert.equal(backups.length, 1);
    const evidenceRoot = resolve(dshHome, "odai/control-center-backups", backups[0]);
    assert.equal(await readFile(resolve(evidenceRoot, "before/package.json"), "utf8"), before);
    assert.equal(await readFile(resolve(evidenceRoot, "after/package.json"), "utf8"), after);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("failed Control Center command with unchanged profile performs no inverse command", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-unchanged-failure-"));
  const dshHome = resolve(scratch, "home");
  try {
    const profileRoot = await writeProfile(dshHome, {
      dependency: "link:/repo/dsh/agent",
      bundles: ["odai-dsh-agent"],
      resolvedVersion: targetVersion,
    });
    const before = await readFile(resolve(profileRoot, "package.json"), "utf8");
    let attempts = 0;
    await assert.rejects(
      installAgentControlCenter({
        dshHome,
        execute: (_command, args) => {
          if (args[0] === "-V") return MINIMUM_DSH_VERSION;
          attempts += 1;
          throw new Error("no mutation");
        },
      }),
      /profile state remained unchanged/u,
    );
    assert.equal(attempts, 1);
    assert.equal(await readFile(resolve(profileRoot, "package.json"), "utf8"), before);
    await assert.rejects(readdir(resolve(dshHome, "odai/control-center-backups")), /ENOENT/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test("Control Center operation lock blocks concurrent commands", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-lock-"));
  const dshHome = resolve(scratch, "home");
  try {
    await writeProfile(dshHome, {
      dependency: targetVersion,
      bundles: ["odai-dsh-agent"],
      resolvedVersion: targetVersion,
    });
    const lockRoot = resolve(dshHome, "odai/locks");
    await mkdir(lockRoot, { recursive: true });
    await writeFile(resolve(lockRoot, "control-center-web.lock"), `${process.pid}:held-by-test\n`, "utf8");
    let attempts = 0;
    const execute = () => {
      attempts += 1;
      return "";
    };
    await assert.rejects(
      installAgentControlCenter({ dshHome, packageSpec: "different", execute }),
      /already in progress/u,
    );
    await assert.rejects(uninstallAgentControlCenter({ dshHome, execute }), /already in progress/u);
    assert.equal(attempts, 0);
    await writeFile(resolve(lockRoot, "control-center-web.lock"), "99999999:dead-owner\n", "utf8");
    await writeFile(resolve(lockRoot, "control-center-web.lock.claim"), "99999999:dead-claim\n", "utf8");
    const recovered = await installAgentControlCenter({ dshHome, execute });
    assert.equal(recovered.operation, "unchanged");
    await writeFile(resolve(lockRoot, "control-center-web.lock.claim"), `${process.pid}:live-claim\n`, "utf8");
    await assert.rejects(
      installAgentControlCenter({ dshHome, execute }),
      /already in progress/u,
    );
    assert.equal(await readFile(resolve(lockRoot, "control-center-web.lock.claim"), "utf8"), `${process.pid}:live-claim\n`);
    await rm(resolve(lockRoot, "control-center-web.lock.claim"), { force: true });
    const raceLockPath = resolve(lockRoot, "control-center-web.lock");
    const tracePath = resolve(scratch, "lock-trace.log");
    await mkdir(`${raceLockPath}.claims`, { recursive: true });
    await writeFile(raceLockPath, "99999999:dead-owner\n", "utf8");
    await writeFile(`${raceLockPath}.claim`, "99999999:dead-claim\n", "utf8");
    await writeFile(`${raceLockPath}.claims/99999999.dead-ticket`, "99999999:dead-ticket\n", "utf8");
    const moduleUrl = new URL("../build/src/operation-lock.mjs", import.meta.url).href;
    const workerScript = `
      import { appendFileSync } from "node:fs";
      import { acquireAgentOperationLock } from ${JSON.stringify(moduleUrl)};
      const [lockPath, tracePath] = process.argv.slice(1);
      try {
        const release = acquireAgentOperationLock(lockPath, "Agent Control Center web operation");
        appendFileSync(tracePath, \`enter:\${process.pid}\\n\`, "utf8");
        await new Promise((r) => setTimeout(r, 35));
        appendFileSync(tracePath, \`exit:\${process.pid}\\n\`, "utf8");
        release();
        process.exit(0);
      } catch (error) {
        if (/already in progress/u.test(String(error?.message ?? error))) {
          process.exit(2);
        }
        console.error(error);
        process.exit(1);
      }
    `;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise((resolveChild, rejectChild) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", workerScript, raceLockPath, tracePath], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (chunk) => { stderr += String(chunk); });
          child.on("error", rejectChild);
          child.on("close", (code) => resolveChild({ code, stderr }));
        }),
      ),
    );
    for (const result of results) {
      assert.ok(result.code === 0 || result.code === 2, `unexpected worker failure: ${result.code} ${result.stderr}`);
    }
    const winners = results.filter((result) => result.code === 0).length;
    if (winners === 0) {
      const { acquireAgentOperationLock } = await import("../build/src/operation-lock.mjs");
      const releaseFollowUp = acquireAgentOperationLock(raceLockPath, "Agent Control Center web operation");
      releaseFollowUp();
    }
    const trace = (await readFile(tracePath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    let active = 0;
    for (const line of trace) {
      active += line.startsWith("enter:") ? 1 : -1;
      assert.ok(active >= 0 && active <= 1, `overlapping lock holders detected in trace: ${trace.join(",")}`);
    }
    assert.equal(active, 0);
    assert.deepEqual(await readdir(lockRoot), []);
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
    await writeProfile(dshHome, {
      dependency: newerVersion,
      bundles: ["odai-dsh-agent"],
      resolvedVersion: newerVersion,
    });
    await assert.rejects(installAgentControlCenter({ dshHome, execute: () => "" }), /refusing to downgrade/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("uninstall refuses while the profile chooses odai as the default preset", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-default-guard-"));
  const dshHome = resolve(scratch, "home");
  const calls = [];
  try {
    const profileRoot = await writeProfile(dshHome, {});
    await writeResolvedPackage(profileRoot, targetVersion);
    const execute = registryExecutor(profileRoot, calls);
    await installAgentControlCenter({ dshHome, execute });
    const patchPath = resolve(profileRoot, "cordis.patch.yml");
    for (const config of [
      { default: "standard", selectedDefault: "odai" },
      { default: "odai" },
      { default: "odai", selectedDefault: "standard", modeSelectionEnabled: false },
    ]) {
      await writeFile(patchPath, JSON.stringify([{ id: "agent-preset-registry", config }]));
      await assert.rejects(uninstallAgentControlCenter({ dshHome, execute }), /refusing to remove the default agent preset odai/u);
    }
    await writeFile(patchPath, JSON.stringify([{ id: "agent-preset-registry", config: { default: "standard", selectedDefault: "standard" } }]));
    await writeFile(resolve(dshHome, "cordis.patch.yml"), JSON.stringify([{ id: "agent-preset-registry", config: { selectedDefault: "odai" } }]));
    await assert.rejects(uninstallAgentControlCenter({ dshHome, execute }), /refusing to remove the default agent preset odai/u);
    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "current");
    assert.equal(calls.filter((call) => call.args.includes("remove")).length, 0);
    await rm(resolve(dshHome, "cordis.patch.yml"));
    for (const output of ["[]", "invalid: shape", "- name: '@deepseek-ai/dsh-agent-preset-registry'\n  config:\n    default: !!js process.env.DEFAULT_AGENT\n"]) {
      await assert.rejects(uninstallAgentControlCenter({ dshHome, execute(command, args, options) {
        return args.includes("--dump-config") ? output : execute(command, args, options);
      } }), /cannot determine the effective default/);
    }
    assert.equal(calls.filter((call) => call.args.includes("remove")).length, 0);
    await writeFile(patchPath, JSON.stringify([{ id: "agent-preset-registry", config: { default: "standard", selectedDefault: "odai", modeSelectionEnabled: false } }]));
    assert.equal((await uninstallAgentControlCenter({ dshHome, execute })).operation, "uninstalled");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
