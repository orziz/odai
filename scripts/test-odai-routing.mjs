#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(repo, "skills", "odai-orchestration");
const builder = path.join(skill, "scripts", "build-routing.mjs");
const installer = path.join(skill, "scripts", "install-routing.mjs");
const roles = ["controller", "planner", "reviewer"];

try {
  testBuilds();
  testInstallLifecycle();
  testDirectoryOwnership();
  testUninstallSettingsDriftIsAtomic();
  testManifestPathEscapeIsRejected();
  testParentSymlinkIsRejected();
  testTargetSymlinkIsRejected();
  testUnmanagedResearcherConflict();
  testRetiredArguments();
  console.log("odai routing keeps one controller, controller-owned implementation, and only configured researcher, planner, reviewer, or frontend responsibilities.");
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}

function testBuilds() {
  const root = temp("odai-routing-build-");
  try {
    for (const host of ["codex", "claude", "copilot"]) {
      const result = runNode(builder, [...buildArgs(host, path.join(root, host)), "--governance-root", path.join(repo, "skills/odai")]);
      assert.equal(result.status, 0, result.stderr);
      const generated = path.join(root, host, host);
      const adapter = json(path.join(generated, "ADAPTER.json"));
      assert.equal(adapter.routing_policy.mode, "conditional");
      assert.equal(adapter.routing_policy.controller_identity, "persistent-task-thread");
      assert.equal(adapter.routing_policy.controller_owns_implementation, true);
      assert.deepEqual(Object.keys(adapter.mapping), roles);
      assert.equal(adapter.mapping.executor, undefined);
      assert.equal(adapter.routing_policy.executor_activation, undefined);

      if (host === "codex") {
        assert.ok(!existsSync(path.join(generated, ".codex", "odai-run-routing.mjs")));
        assert.ok(!existsSync(path.join(generated, ".codex", "agents", "odai-executor.toml")));
        assert.ok(!existsSync(path.join(generated, ".codex", "role-contracts", "odai-executor.md")));
        assert.ok(existsSync(path.join(generated, ".codex", "odai-run-role.mjs")));
      } else if (host === "claude") {
        assert.ok(!existsSync(path.join(generated, ".claude", "agents", "odai-executor.md")));
      } else {
        assert.ok(!existsSync(path.join(generated, ".github", "agents", "odai-executor.agent.md")));
      }
    }

    const optional = runNode(builder, [
      ...buildArgs("codex", path.join(root, "optional")),
      "--researcher-model", "researcher-model", "--researcher-effort", "low",
      "--frontend-model", "frontend-model", "--frontend-effort", "high",
    ]);
    assert.equal(optional.status, 0, optional.stderr);
    const generated = path.join(root, "optional", "codex");
    const adapter = json(path.join(generated, "ADAPTER.json"));
    assert.deepEqual(Object.keys(adapter.mapping), ["controller", "planner", "reviewer", "researcher", "frontend"]);
    assert.ok(existsSync(path.join(generated, ".codex", "agents", "odai-researcher.toml")));
    assert.ok(existsSync(path.join(generated, ".codex", "agents", "odai-frontend.toml")));
    const isolated = path.join(root, "independent/odai-orchestration");
    cpSync(skill, isolated, { recursive: true });
    const help = runNode(path.join(isolated, "scripts/build-routing.mjs"), ["--help"]);
    assert.equal(help.status, 0, help.stderr);
    const project = path.join(root, "independent-project");
    mkdirSync(project);
    const installed = runNode(path.join(isolated, "scripts/install-routing.mjs"), [
      "--host", "codex", "--scope", "project", "--target", project,
      "--governance-root", path.join(repo, "skills/odai"),
      "--controller-model", "test-controller", "--planner-model", "test-planner", "--reviewer-model", "test-reviewer", "--yes",
    ]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(JSON.parse(installed.stdout).status, "installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testInstallLifecycle() {
  const project = temp("odai-routing-install-");
  try {
    const installed = runNode(installer, installArgs(project));
    assert.equal(installed.status, 0, installed.stderr);
    const config = path.join(project, ".codex");
    const manifestFile = path.join(config, "odai-routing.json");
    let manifest = json(manifestFile);
    assert.equal(manifest.version, 13);
    assert.deepEqual(Object.keys(manifest.mapping), roles);
    assert.equal(manifest.mapping.executor, undefined);
    assert.ok(!existsSync(path.join(config, "agents", "odai-executor.toml")));
    assert.ok(!existsSync(path.join(config, "odai-run-routing.mjs")));

    // Simulate a prior managed installation so the update path proves exact cleanup.
    const retired = {
      "agents/odai-executor.toml": "legacy executor\n",
      "role-contracts/odai-executor.md": "legacy executor contract\n",
      "odai-run-routing.mjs": "legacy stage runner\n",
    };
    for (const [relative, content] of Object.entries(retired)) {
      const file = path.join(config, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      manifest.files[relative] = sha256(Buffer.from(content));
    }
    manifest.mapping.executor = { provider: "codex", model: "legacy-executor", reasoning_effort: null };
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const updated = runNode(installer, installArgs(project));
    assert.equal(updated.status, 0, updated.stderr);
    manifest = json(manifestFile);
    assert.equal(manifest.mapping.executor, undefined);
    for (const relative of Object.keys(retired)) assert.ok(!existsSync(path.join(config, relative)), relative);

    const uninstall = runNode(installer, ["--host", "codex", "--scope", "project", "--target", project, "--uninstall", "--yes"]);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.ok(!existsSync(manifestFile));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function testDirectoryOwnership() {
  for (const host of ["codex", "claude", "copilot"]) {
    for (const preexisting of [[], ["."], [".", "agents"], [".", "role-contracts"], [".", "agents", "role-contracts"]]) {
      const project = temp("odai-routing-directories-");
      const config = path.join(project, { codex: ".codex", claude: ".claude", copilot: ".github" }[host]);
      try {
        for (const dir of preexisting) mkdirSync(path.join(config, dir), { recursive: true });
        const installed = runNode(installer, installArgs(project, host));
        assert.equal(installed.status, 0, installed.stderr);
        const created = json(path.join(config, "odai-routing.json")).createdDirectories;
        for (const dir of preexisting) assert.equal(created.includes(dir), false);
        const updated = runNode(installer, installArgs(project, host));
        assert.equal(updated.status, 0, updated.stderr);
        assert.deepEqual(json(path.join(config, "odai-routing.json")).createdDirectories, created);
        const uninstallArgs = ["--host", host, "--scope", "project", "--target", project, "--uninstall", "--yes"];
        assert.equal(runNode(installer, uninstallArgs).status, 0);
        for (const dir of preexisting) assert.ok(existsSync(path.join(config, dir)), `preserve ${dir}`);
        for (const dir of created) assert.equal(existsSync(path.join(config, dir)), false, `remove ${dir}`);
        assert.equal(JSON.parse(runNode(installer, uninstallArgs).stdout).status, "not-installed");
        assert.ok(existsSync(project));
      } finally { rmSync(project, { recursive: true, force: true }); }
    }
  }
  for (const legacy of [false, true]) {
    const project = temp("odai-routing-preserve-");
    const config = path.join(project, ".codex");
    try {
      mkdirSync(config);
      const original = Buffer.from('# keep CRLF\r\nmodel = "original"\r\n[features]\r\nmulti_agent = false\r\n');
      writeFileSync(path.join(config, "config.toml"), original);
      const result = runNode(installer, installArgs(project));
      assert.equal(result.status, 0, result.stderr);
      if (legacy) {
        const manifestPath = path.join(config, "odai-routing.json");
        const manifest = json(manifestPath);
        delete manifest.createdDirectories;
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      for (const dir of [".", "agents", "role-contracts"]) writeFileSync(path.join(config, dir, "unmanaged.txt"), `keep ${dir}`);
      assert.equal(runNode(installer, installArgs(project)).status, 0);
      assert.equal(runNode(installer, ["--host", "codex", "--target", project, "--uninstall", "--yes"]).status, 0);
      assert.deepEqual(readFileSync(path.join(config, "config.toml")), original);
      for (const dir of [".", "agents", "role-contracts"]) assert.equal(readFileSync(path.join(config, dir, "unmanaged.txt"), "utf8"), `keep ${dir}`);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
  const userRoot = temp("odai-routing-user-root-");
  try {
    const args = installArgs(userRoot);
    args[args.indexOf("--scope") + 1] = "user";
    assert.equal(runNode(installer, args).status, 0);
    const manifestPath = path.join(userRoot, "odai-routing.json");
    const manifest = json(manifestPath);
    for (const invalid of [["../outside"], [path.resolve(userRoot, "outside")], ["unknown"], "."]) {
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, createdDirectories: invalid }));
      const rejected = runNode(installer, ["--host", "codex", "--scope", "user", "--target", userRoot, "--uninstall", "--yes"]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /无效的托管目录记录/u);
      for (const file of Object.keys(manifest.files)) assert.ok(existsSync(path.join(userRoot, file)));
    }
    delete manifest.createdDirectories;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal(runNode(installer, ["--host", "codex", "--scope", "user", "--target", userRoot, "--uninstall", "--yes"]).status, 0);
    assert.ok(existsSync(path.join(userRoot, "agents")), "legacy ownership is unknown and must remain untouched");
    assert.ok(existsSync(userRoot));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
}

function testUninstallSettingsDriftIsAtomic() {
  const project = temp("odai-routing-uninstall-atomic-");
  try {
    const installed = runNode(installer, installArgs(project, "claude"));
    assert.equal(installed.status, 0, installed.stderr);
    const config = path.join(project, ".claude");
    const manifestFile = path.join(config, "odai-routing.json");
    const managedFile = path.join(config, "agents", "odai-controller.md");
    writeFileSync(path.join(config, "settings.local.json"), `${JSON.stringify({ agent: "external" }, null, 2)}\n`);

    const removed = runNode(installer, ["--host", "claude", "--scope", "project", "--target", project, "--uninstall", "--yes"]);
    assert.notEqual(removed.status, 0);
    assert.match(removed.stderr, /已被外部修改/u);
    assert.ok(existsSync(manifestFile), "failed uninstall must preserve its manifest");
    assert.ok(existsSync(managedFile), "failed uninstall must preserve managed files");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function testManifestPathEscapeIsRejected() {
  const root = temp("odai-routing-manifest-escape-");
  const project = path.join(root, "project");
  const victim = path.join(root, "victim.json");
  try {
    mkdirSync(project);
    writeFileSync(victim, '{"preserved":true}\n', "utf8");
    const installed = runNode(installer, installArgs(project));
    assert.equal(installed.status, 0, installed.stderr);
    const manifestFile = path.join(project, ".codex", "odai-routing.json");
    const manifest = json(manifestFile);
    manifest.settings = {
      file: "../../victim.json",
      key: "agent",
      installed: "odai-controller",
      fileExistedBefore: true,
      previous: { present: false, value: null },
    };
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const removed = runNode(installer, [...installArgs(project), "--uninstall"]);
    assert.notEqual(removed.status, 0);
    assert.match(removed.stderr, /不支持的设置记录/u);
    assert.equal(readFileSync(victim, "utf8"), '{"preserved":true}\n');
    for (const relative of Object.keys(manifest.files)) {
      assert.equal(existsSync(path.join(project, ".codex", relative)), true, relative);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testParentSymlinkIsRejected() {
  const project = temp("odai-routing-parent-link-");
  const outside = temp("odai-routing-parent-link-outside-");
  try {
    const config = path.join(project, ".codex");
    mkdirSync(config, { recursive: true });
    try {
      symlinkSync(outside, path.join(config, "agents"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
      throw error;
    }
    const installed = runNode(installer, installArgs(project));
    assert.notEqual(installed.status, 0);
    assert.match(installed.stderr, /符号链接/u);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

function testTargetSymlinkIsRejected() {
  const actual = temp("odai-routing-target-symlink-actual-");
  const parent = temp("odai-routing-target-symlink-parent-");
  const linked = path.join(parent, "linked-project");
  try {
    try {
      symlinkSync(actual, linked, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
      throw error;
    }
    const installed = runNode(installer, installArgs(linked));
    assert.notEqual(installed.status, 0);
    assert.match(installed.stderr, /符号链接/u);
    assert.equal(existsSync(path.join(actual, ".codex")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(actual, { recursive: true, force: true });
  }
}

function testUnmanagedResearcherConflict() {
  const project = temp("odai-routing-unmanaged-researcher-");
  try {
    const config = path.join(project, ".codex", "config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, "[agents.odai_researcher]\nconfig_file = \"external-researcher.toml\"\n", "utf8");
    const result = runNode(installer, [
      ...installArgs(project),
      "--researcher-model", "researcher-model",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /既有 Codex 配置已声明 odai 角色/u);
    assert.equal(readFileSync(config, "utf8"), "[agents.odai_researcher]\nconfig_file = \"external-researcher.toml\"\n");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function testRetiredArguments() {
  const root = temp("odai-routing-retired-args-");
  try {
    const executor = runNode(builder, [...buildArgs("codex", root), "--executor-model", "retired"]);
    assert.notEqual(executor.status, 0);
    assert.match(executor.stderr, /Unknown option: --executor-model/u);
    const stage = runNode(builder, [...buildArgs("codex", root), "--planning-policy", "stage"]);
    assert.notEqual(stage.status, 0);
    assert.match(stage.stderr, /Unknown option: --planning-policy/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function buildArgs(host, out) {
  return [
    "--host", host, "--out", out,
    "--controller-model", "controller-model",
    "--planner-model", "planner-model",
    "--reviewer-model", "reviewer-model",
  ];
}

function installArgs(project, host = "codex") {
  return [
    "--host", host, "--scope", "project", "--target", project,
    "--controller-model", "controller-model",
    "--planner-model", "planner-model",
    "--reviewer-model", "reviewer-model",
    "--yes",
  ];
}

function runNode(file, args) {
  const scratch = temp("odai-routing-child-temp-");
  try {
    const result = spawnSync(process.execPath, [file, ...args], {
      cwd: repo, encoding: "utf8", env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    });
    assert.deepEqual(readdirSync(scratch), [], `temporary routing generation must be cleaned after ${path.basename(file)}: ${result.stderr}`);
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
function json(file) { return JSON.parse(readFileSync(file, "utf8")); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
// Ordinary fixtures need physical paths; link rejection cases create their own links.
function temp(prefix) { return realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); }
