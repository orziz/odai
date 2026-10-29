#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = path.join(repo, "skills", "odai-orchestration");
const builder = path.join(skill, "scripts", "build-routing.mjs");
const installer = path.join(skill, "scripts", "install-routing.mjs");
const roles = ["controller", "planner", "reviewer"];

const tests = [testHostSessions, testBuilds, testCreativeRouting, testWriterRouting, testInstallLifecycle, testDirectoryOwnership,
  testUninstallSettingsDriftIsAtomic, testManifestPathEscapeIsRejected, testParentSymlinkIsRejected,
  testTargetSymlinkIsRejected, testUnmanagedResearcherConflict, testRetiredArguments,
  testClaudeLocalBuild, testClaudeLocalLifecycle, testClaudeLocalRuntime, testClaudeLocalUserScope];
let passed = 0;
try {
  for (const test of tests) { test(); passed += 1; }
  console.log(`odai routing: ${passed} suites passed, 0 failed (native and local CLI routing, evidence, installation and recovery).`);
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
      assert.deepEqual(Object.keys(adapter.mapping).sort(), [...roles].sort());
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
    assert.deepEqual(Object.keys(adapter.mapping).sort(), ["controller", "planner", "reviewer", "researcher", "frontend"].sort());
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

function testCreativeRouting() {
  for (const host of ["codex", "claude", "copilot"]) {
    const project = temp("odai-routing-creative-");
    const config = path.join(project, { codex: ".codex", claude: ".claude", copilot: ".github" }[host]);
    const roleFile = path.join("agents", `odai-creative${{ codex: ".toml", claude: ".md", copilot: ".agent.md" }[host]}`);
    const configured = [...installArgs(project, host), "--creative-model", "creative-model",
      ...(host === "copilot" ? [] : ["--creative-effort", "high"])];
    try {
      const initial = runNode(installer, installArgs(project, host));
      assert.equal(initial.status, 0, initial.stderr);
      assert.equal(existsSync(path.join(config, roleFile)), false);
      const absent = json(path.join(config, "odai-routing.json"));
      assert.equal(absent.mapping.creative, undefined);
      assert.equal(absent.routingPolicy.creative_activation, "unconfigured");

      const enabled = runNode(installer, configured);
      assert.equal(enabled.status, 0, enabled.stderr);
      const manifest = json(path.join(config, "odai-routing.json"));
      assert.deepEqual(manifest.mapping.creative, { provider: host, model: "creative-model", reasoning_effort: host === "copilot" ? null : "high" });
      assert.ok(manifest.files[roleFile]);
      const profile = readFileSync(path.join(config, roleFile), "utf8");
      assert.ok(profile.includes(readFileSync(path.join(skill, "assets/routing-roles/creative.md"), "utf8").trim()));
      assert.ok(profile.includes(readFileSync(path.join(repo, "skills/odai/references/craft.md"), "utf8").trim()));
      assert.doesNotMatch(profile, /__ODAI_[A-Z0-9_]+__/u);
      if (host === "codex") {
        assert.match(profile, /^sandbox_mode = "read-only"$/mu);
        assert.match(readFileSync(path.join(config, "config.toml"), "utf8"), /^\[agents\.odai_creative\]$/mu);
        testCreativeCodexRuntime(project, config);
      } else if (host === "claude") {
        assert.match(profile, /^permissionMode: plan$/mu);
      } else {
        assert.match(profile, /^tools: \["view", "glob", "grep"\]$/mu);
      }

      const disabled = runNode(installer, installArgs(project, host));
      assert.equal(disabled.status, 0, disabled.stderr);
      assert.equal(existsSync(path.join(config, roleFile)), false);
      assert.equal(json(path.join(config, "odai-routing.json")).mapping.creative, undefined);
      if (host === "codex") assert.equal(existsSync(path.join(config, "role-contracts/odai-creative.md")), false);
      const reenabled = runNode(installer, configured);
      assert.equal(reenabled.status, 0, reenabled.stderr);
      const removed = runNode(installer, ["--host", host, "--target", project, "--uninstall", "--yes"]);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(existsSync(path.join(config, roleFile)), false);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }

  const root = temp("odai-routing-creative-invalid-");
  try {
    const effortOnly = runNode(builder, [...buildArgs("codex", root), "--creative-effort", "high"]);
    assert.notEqual(effortOnly.status, 0);
    assert.match(effortOnly.stderr, /--creative-effort requires --creative-model/u);
    const installEffortOnly = runNode(installer, [...installArgs(root), "--creative-effort", "high"]);
    assert.notEqual(installEffortOnly.status, 0);
    assert.match(installEffortOnly.stderr, /--creative-effort 需要同时提供 --creative-model/u);
    const config = path.join(root, ".codex/config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    const original = '[agents.odai_creative]\nconfig_file = "external-creative.toml"\n';
    writeFileSync(config, original);
    const conflict = runNode(installer, [...installArgs(root), "--creative-model", "creative-model"]);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /既有 Codex 配置已声明 odai 角色/u);
    assert.equal(readFileSync(config, "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function testCreativeCodexRuntime(project, config) {
  const fakeCodex = path.join(project, "fake-codex.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(args));
console.log(JSON.stringify({ type: "thread.started", thread_id: "creative-thread", model: "creative-model" }));
`);
  chmodSync(fakeCodex, 0o700);
  const input = path.join(project, "input.md");
  const evidence = path.join(project, "evidence.json");
  writeFileSync(input, "给已定稿的商店页提供两个有明确取舍的标题候选。\n");
  for (const resume of [false, true]) {
    const result = runNode(path.join(config, "odai-run-role.mjs"), [
      "--role", "creative", "--cwd", project, "--input", input,
      "--codex-bin", fakeCodex, "--sandbox", "danger-full-access", "--evidence", evidence,
      ...(resume ? ["--session-id", "creative-thread"] : []),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(result.stdout);
    if (resume) assert.ok(args.includes('sandbox_mode="read-only"'));
    else assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(args[args.indexOf("--model") + 1], "creative-model");
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.equal(json(evidence).role, "creative");
    assert.equal(json(evidence).observed.model_verified, true);
  }

  const sessions = path.join(project, "sessions");
  mkdirSync(sessions);
  const timestamp = new Date().toISOString();
  const sessionFile = path.join(sessions, "creative.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "creative-thread", agent_role: "odai_creative", cwd: project, timestamp,
      source: { subagent: { thread_spawn: { agent_path: "/root/creative" } } } } },
    { type: "turn_context", payload: { model: "creative-model", effort: "high" } },
  ];
  writeFileSync(sessionFile, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const verifyArgs = ["--host", "codex", "--project", project, "--role", "odai_creative", "--after", timestamp,
    "--agent-path", "/root/creative", "--sessions", sessions];
  const verified = runNode(path.join(config, "odai-verify-routing.mjs"), verifyArgs);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).role, "odai_creative");
  records[1].payload.model = "wrong-model";
  writeFileSync(sessionFile, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const mismatch = runNode(path.join(config, "odai-verify-routing.mjs"), verifyArgs);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /模型不匹配/u);
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
    assert.deepEqual(Object.keys(manifest.mapping).sort(), [...roles].sort());
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

function testClaudeLocalBuild() {
  const root = temp("odai-routing-claude-local-build-");
  try {
    const extra = ["--reviewer-cli", "codex", "--reviewer-effort", "high",
      "--planner-cli", "grok", "--researcher-model", "research-model", "--researcher-cli", "codex",
      "--frontend-model", "front-model", "--frontend-cli", "antigravity",
      "--creative-model", "creative-model", "--creative-cli", "grok",
      "--writer-model", "writer-model", "--writer-cli", "antigravity"];
    const result = runNode(builder, [...buildArgs("claude", root), ...extra]);
    assert.equal(result.status, 0, result.stderr);
    const config = path.join(root, "claude/.claude");
    const adapter = json(path.join(root, "claude/ADAPTER.json"));
    const manifest = json(path.join(config, "odai-routing.json"));
    assert.equal(manifest.id, "odai-routing-installation");
    assert.equal(manifest.host, "claude");
    assert.deepEqual(manifest.mapping.reviewer, { backend: "local-cli", cli: "codex", model: "reviewer-model", reasoning_effort: "high" });
    assert.deepEqual(adapter.mapping.reviewer, manifest.mapping.reviewer);
    assert.equal(adapter.runtime_verification.roles.reviewer.mode, "role-executor-evidence");
    assert.equal(adapter.runtime_verification.roles.controller.mode, "host-native-evidence-required");
    for (const role of ["planner", "reviewer", "researcher", "frontend", "creative", "writer"]) {
      assert.equal(existsSync(path.join(config, `agents/odai-${role}.md`)), false);
      assert.ok(existsSync(path.join(config, `role-contracts/odai-${role}.md`)));
    }
    for (const [source, target] of [["run-role.mjs", "odai-run-role.mjs"], ["local-cli.mjs", "odai-local-cli.mjs"]]) {
      assert.deepEqual(readFileSync(path.join(config, target)), readFileSync(path.join(skill, "scripts", source)));
    }
    const controller = readFileSync(path.join(config, "agents/odai-controller.md"), "utf8");
    assert.match(controller, /node \.claude\/odai-run-role\.mjs --role reviewer --input <文件>/u);
    assert.deepEqual(json(path.join(config, "settings.patch.json")), { agent: "odai-controller", permissions: { allow: ["Bash(node .claude/odai-run-role.mjs:*)"] } });

    for (const host of ["codex", "copilot"]) {
      for (const [entry, args] of [[builder, buildArgs(host, root)], [installer, installArgs(root, host)]]) {
        const invalid = runNode(entry, [...args, "--reviewer-cli", "codex"]);
        assert.notEqual(invalid.status, 0);
        assert.match(invalid.stderr, /requires claude or codex|must be/u);
      }
    }
    for (const invalid of [["--reviewer-cli", "claude"], ["--reviewer-cli", "gemini"],
      ["--controller-cli", "codex"], ["--creative-cli", "grok"],
      ["--reviewer-cli", "antigravity", "--reviewer-effort", "max"]]) {
      for (const [entry, args] of [[builder, buildArgs("claude", root)], [installer, installArgs(root, "claude")]]) {
        assert.notEqual(runNode(entry, [...args, ...invalid]).status, 0, invalid.join(" "));
      }
    }
    assert.equal(existsSync(path.join(root, ".claude")), false, "invalid installation must not write files");
    const nativeOverLocal = runNode(builder, buildArgs("claude", root));
    assert.notEqual(nativeOverLocal.status, 0);
    assert.match(nativeOverLocal.stderr, /fresh --out directory/u);
    const nativeRoot = path.join(root, "native");
    assert.equal(runNode(builder, buildArgs("claude", nativeRoot)).status, 0);
    const localOverNative = runNode(builder, [...buildArgs("claude", nativeRoot), "--reviewer-cli", "codex"]);
    assert.notEqual(localOverNative.status, 0);
    assert.match(localOverNative.stderr, /fresh --out directory/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function testClaudeLocalLifecycle() {
  const rule = "Bash(node .claude/odai-run-role.mjs:*)";
  for (const original of [null, {}, { permissions: {} }, { permissions: { allow: [] } },
    { env: { KEEP: "yes" }, permissions: { allow: ["Read", "Read"], deny: ["Write"] } },
    { permissions: { allow: [rule, "Read"], deny: ["Write"] } }]) {
    const project = temp("odai-routing-claude-local-install-");
    const config = path.join(project, ".claude");
    const settingsFile = path.join(config, "settings.local.json");
    const base = installArgs(project, "claude");
    const local = [...base, "--reviewer-cli", "codex", "--reviewer-effort", "high"];
    const remove = ["--host", "claude", "--target", project, "--uninstall", "--yes"];
    try {
      if (original !== null) { mkdirSync(config); writeFileSync(settingsFile, JSON.stringify(original)); }
      assert.equal(runNode(installer, base).status, 0);
      let result = runNode(installer, local);
      assert.equal(result.status, 0, result.stderr);
      const manifestFile = path.join(config, "odai-routing.json");
      const manifest = json(manifestFile);
      const localFiles = ["odai-run-role.mjs", "odai-local-cli.mjs", "role-contracts/odai-reviewer.md"];
      for (const file of localFiles) assert.ok(manifest.files[file], file);
      assert.equal(existsSync(path.join(config, "agents/odai-reviewer.md")), false);
      assert.ok(existsSync(path.join(config, "agents/odai-planner.md")));
      assert.ok(json(settingsFile).permissions.allow.includes(rule));
      assert.equal(runNode(installer, local).status, 0);
      assert.deepEqual(json(manifestFile).settings, manifest.settings, "updating preserves ownership");
      // Permissions and every new file participate in drift checks before any mutation.
      const settingsBytes = readFileSync(settingsFile);
      const drifted = json(settingsFile);
      drifted.permissions.allow = drifted.permissions.allow.filter(value => value !== rule);
      writeFileSync(settingsFile, JSON.stringify(drifted));
      for (const command of [local, remove]) {
        result = runNode(installer, command);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /permissions.allow 已被外部修改/u);
        for (const file of localFiles) assert.ok(existsSync(path.join(config, file)));
      }
      writeFileSync(settingsFile, settingsBytes);
      for (const file of localFiles) {
        const target = path.join(config, file);
        const bytes = readFileSync(target);
        writeFileSync(target, "external modification");
        for (const command of [local, remove]) {
          result = runNode(installer, command);
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /漂移/u);
        }
        assert.equal(readFileSync(target, "utf8"), "external modification");
        writeFileSync(target, bytes);
      }
      assert.equal(runNode(installer, base).status, 0);
      for (const file of localFiles) assert.equal(existsSync(path.join(config, file)), false);
      assert.ok(existsSync(path.join(config, "agents/odai-reviewer.md")));
      assert.deepEqual(json(settingsFile), { ...(original || {}), agent: "odai-controller" });
      assert.equal(runNode(installer, local).status, 0);
      // A user permission added later must survive uninstall.
      const settings = json(settingsFile);
      settings.permissions.allow.push("Grep");
      writeFileSync(settingsFile, JSON.stringify(settings));
      assert.equal(runNode(installer, remove).status, 0);
      const expected = structuredClone(original || {});
      expected.permissions ||= {};
      expected.permissions.allow = [...(expected.permissions.allow || []), "Grep"];
      assert.deepEqual(json(settingsFile), expected);
      for (const file of [...localFiles, "odai-routing.json"]) assert.equal(existsSync(path.join(config, file)), false);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
  // New unmanaged runner paths must never be overwritten.
  const project = temp("odai-routing-claude-local-conflict-");
  try {
    const file = path.join(project, ".claude/odai-local-cli.mjs");
    mkdirSync(path.dirname(file));
    writeFileSync(file, "user module");
    const result = runNode(installer, [...installArgs(project, "claude"), "--reviewer-cli", "codex"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /非 odai/u);
    assert.equal(readFileSync(file, "utf8"), "user module");
    // Exact fixture file created above; remove it to test the opposite native path.
    rmSync(file);
    const native = path.join(project, ".claude/agents/odai-reviewer.md");
    mkdirSync(path.dirname(native));
    writeFileSync(native, "user native agent");
    const localArgs = [...installArgs(project, "claude"), "--reviewer-cli", "codex"];
    for (const afterInstall of [false, true]) {
      if (afterInstall) {
        rmSync(native);
        assert.equal(runNode(installer, localArgs).status, 0);
        writeFileSync(native, "user native agent");
      }
      const conflict = runNode(installer, localArgs);
      assert.notEqual(conflict.status, 0);
      assert.match(conflict.stderr, /原生代理/u);
      assert.equal(readFileSync(native, "utf8"), "user native agent");
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
}

function testClaudeLocalRuntime() {
  const project = temp("odai-routing-claude-local-runtime-");
  try {
    const built = runNode(builder, [...buildArgs("claude", project), "--reviewer-cli", "codex", "--reviewer-effort", "high"]);
    assert.equal(built.status, 0, built.stderr);
    const config = path.join(project, "claude/.claude");
    const runner = path.join(config, "odai-run-role.mjs");
    const manifestFile = path.join(config, "odai-routing.json");
    const manifest = json(manifestFile);
    const input = path.join(project, "task.md");
    const evidence = path.join(project, "evidence.json");
    const output = path.join(project, "output.txt");
    const capture = path.join(project, "capture.json");
    const codexHome = path.join(project, "codex-home");
    const fake = path.join(project, "fake-cli.mjs");
    writeFileSync(input, "Review this bounded task, return the finding.");
    writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const mode = process.env.TEST_MODE;
const prompt = args[0] === "-p" ? args[1] : readFileSync(0, "utf8");
writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({args, prompt, proxy: process.env.HTTPS_PROXY}));
if (mode === "exit") process.exit(7);
if (mode === "timeout") { setInterval(() => {}, 1000); }
else if (args[0] === "-p") {
  console.log(JSON.stringify({ event: "init", init: { model: "reviewer-model" } }));
  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "verified body", usage: {output_tokens: 8} } }));
} else {
  const id = "thread-" + mode;
  if (mode !== "missing") {
    mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), {recursive: true});
    const events = [{type: "session_meta", payload: {id, cwd: process.cwd()}},
      {type: "turn_context", payload: {model: mode === "model" ? "wrong-model" : "reviewer-model", effort: mode === "effort" ? "low" : "high"}}];
    writeFileSync(path.join(process.env.CODEX_HOME, "sessions", "rollout-" + id + ".jsonl"), events.map(x => JSON.stringify(x)).join("\\n"));
  }
  console.log(JSON.stringify({type: "thread.started", thread_id: id}));
  console.log(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: mode === "empty" ? "" : "verified body"}}));
  console.log(JSON.stringify({type: "turn.completed", usage: {output_tokens: 8}}));
}
`);
    chmodSync(fake, 0o700);
    const env = { ODAI_CODEX_COMMAND: fake, ODAI_AGY_COMMAND: fake, CODEX_HOME: codexHome, TEST_CAPTURE: capture, HTTPS_PROXY: "http://fixture.invalid" };
    const command = ["--role", "reviewer", "--cwd", project, "--input", input, "--evidence", evidence, "--output", output];
    let result = runNode(runner, command, { ...env, TEST_MODE: "success" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "verified body\n");
    const proof = json(evidence);
    assert.equal(proof.version, 1);
    assert.deepEqual(proof.requested, { provider: "local-cli:codex", model: "reviewer-model", reasoning_effort: "high" });
    assert.equal(proof.observed.model_verified, true);
    assert.deepEqual(proof.observed.models, ["reviewer-model"]);
    assert.equal(proof.observed.reasoning_effort_verification, "verified");
    assert.equal(proof.observed.exit_code, 0);
    assert.deepEqual(proof.observed.usage, { output_tokens: 8 });
    assert.ok(proof.observed.duration_ms >= 0);
    const called = json(capture);
    assert.equal(called.args[called.args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(called.args.includes("features.multi_agent=false"));
    assert.ok(called.prompt.includes(readFileSync(path.join(config, "role-contracts/odai-reviewer.md"), "utf8")));
    assert.ok(called.prompt.includes(readFileSync(input, "utf8")));
    assert.equal(called.proxy, env.HTTPS_PROXY);
    for (const mode of ["model", "missing", "effort", "empty", "exit", "timeout"]) {
      writeFileSync(output, "previous output");
      result = runNode(runner, [...command, ...(mode === "timeout" ? ["--timeout", "1"] : [])], { ...env, TEST_MODE: mode });
      assert.notEqual(result.status, 0, mode);
      assert.equal(result.stdout, "", mode);
      assert.equal(readFileSync(output, "utf8"), "previous output");
      const failure = json(evidence);
      assert.ok(failure.observed.error, mode);
      assert.equal(failure.output, null);
      assert.equal(failure.observed.exit_code, mode === "exit" ? 7 : mode === "timeout" ? null : 0);
      if (["missing", "model"].includes(mode)) assert.equal(failure.observed.model_verified, false);
    }
    const defaultEvidence = runNode(runner, ["--role", "reviewer", "--cwd", project, "--input", input], { ...env, TEST_MODE: "success" });
    assert.equal(defaultEvidence.status, 0, defaultEvidence.stderr);
    const saved = defaultEvidence.stderr.match(/odai evidence: (.+)/u)?.[1];
    assert.ok(saved && existsSync(saved));
    assert.equal(json(saved).observed.model_verified, true);
    // Source-layout fallback must work without an installed-name module.
    cpSync(path.join(skill, "scripts/local-cli.mjs"), path.join(config, "local-cli.mjs"));
    rmSync(path.join(config, "odai-local-cli.mjs"));
    result = runNode(runner, command, { ...env, TEST_MODE: "success" });
    assert.equal(result.status, 0, result.stderr);
    for (const [option, value] of [["--sandbox", "read-only"], ["--codex-bin", fake], ["--session-id", "thread-success"], ["--closeout-ids", "A1"]]) {
      result = runNode(runner, [...command, option, value], env);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Codex 专有选项/u);
    }
    for (const effort of [null, "high"]) {
      manifest.mapping.reviewer = { backend: "local-cli", cli: "antigravity", model: "reviewer-model", reasoning_effort: effort };
      writeFileSync(manifestFile, JSON.stringify(manifest));
      result = runNode(runner, command, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "verified body\n");
      assert.equal(json(evidence).observed.reasoning_effort_verification, "requested-only");
      assert.ok(json(capture).args.includes("--disable-slash-commands"));
    }
    for (const mapping of [{ provider: "claude", model: "reviewer-model" }, { backend: "local-cli", cli: "claude", model: "opus" }]) {
      manifest.mapping.reviewer = mapping;
      writeFileSync(manifestFile, JSON.stringify(manifest));
      result = runNode(runner, command, env);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
}

function testClaudeLocalUserScope() {
  const root = temp("odai-routing-claude-local-user-");
  try {
    const args = [...installArgs(root, "claude"), "--reviewer-cli", "codex"];
    args[args.indexOf("--scope") + 1] = "user";
    const result = runNode(installer, args);
    assert.equal(result.status, 0, result.stderr);
    const command = `node '${path.join(root, "odai-run-role.mjs")}'`;
    assert.ok(readFileSync(path.join(root, "agents/odai-controller.md"), "utf8").includes(`${command} --role reviewer`));
    assert.deepEqual(json(path.join(root, "settings.json")).permissions.allow, [`Bash(${command}:*)`]);
    assert.equal(runNode(installer, args).status, 0);
    assert.equal(runNode(installer, ["--host", "claude", "--scope", "user", "--target", root, "--uninstall", "--yes"]).status, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

function runNode(file, args, env = {}) {
  const scratch = temp("odai-routing-child-temp-");
  try {
    const result = spawnSync(process.execPath, [file, ...args], {
      cwd: repo, encoding: "utf8", env: { ...process.env, ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
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

function testWriterRouting() {
  for (const host of ["codex", "claude", "copilot"]) {
    const project = temp("odai-routing-writer-");
    const config = path.join(project, { codex: ".codex", claude: ".claude", copilot: ".github" }[host]);
    const roleFile = path.join("agents", `odai-writer${{ codex: ".toml", claude: ".md", copilot: ".agent.md" }[host]}`);
    const configured = [...installArgs(project, host), "--writer-model", "writer-model",
      ...(host === "copilot" ? [] : ["--writer-effort", "high"])];
    try {
      const initial = runNode(installer, installArgs(project, host));
      assert.equal(initial.status, 0, initial.stderr);
      assert.equal(existsSync(path.join(config, roleFile)), false);
      const absent = json(path.join(config, "odai-routing.json"));
      assert.equal(absent.mapping.writer, undefined);
      assert.equal(absent.routingPolicy.writer_activation, "unconfigured");

      const enabled = runNode(installer, configured);
      assert.equal(enabled.status, 0, enabled.stderr);
      const manifest = json(path.join(config, "odai-routing.json"));
      assert.deepEqual(manifest.mapping.writer, { provider: host, model: "writer-model", reasoning_effort: host === "copilot" ? null : "high" });
      assert.ok(manifest.files[roleFile]);
      const profile = readFileSync(path.join(config, roleFile), "utf8");
      assert.ok(profile.includes(readFileSync(path.join(skill, "assets/routing-roles/writer.md"), "utf8").trim()));
      assert.ok(profile.includes(readFileSync(path.join(repo, "skills/odai/references/craft.md"), "utf8").trim()));
      assert.doesNotMatch(profile, /__ODAI_[A-Z0-9_]+__/u);
      if (host === "codex") {
        assert.match(profile, /^sandbox_mode = "read-only"$/mu);
        assert.match(readFileSync(path.join(config, "config.toml"), "utf8"), /^\[agents\.odai_writer\]$/mu);
        testWriterCodexRuntime(project, config);
      } else if (host === "claude") {
        assert.match(profile, /^permissionMode: plan$/mu);
      } else {
        assert.match(profile, /^tools: \["view", "glob", "grep"\]$/mu);
      }

      const disabled = runNode(installer, installArgs(project, host));
      assert.equal(disabled.status, 0, disabled.stderr);
      assert.equal(existsSync(path.join(config, roleFile)), false);
      assert.equal(json(path.join(config, "odai-routing.json")).mapping.writer, undefined);
      if (host === "codex") assert.equal(existsSync(path.join(config, "role-contracts/odai-writer.md")), false);
      const reenabled = runNode(installer, configured);
      assert.equal(reenabled.status, 0, reenabled.stderr);
      const removed = runNode(installer, ["--host", host, "--target", project, "--uninstall", "--yes"]);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(existsSync(path.join(config, roleFile)), false);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }

  const root = temp("odai-routing-writer-invalid-");
  try {
    const effortOnly = runNode(builder, [...buildArgs("codex", root), "--writer-effort", "high"]);
    assert.notEqual(effortOnly.status, 0);
    assert.match(effortOnly.stderr, /--writer-effort requires --writer-model/u);
    const installEffortOnly = runNode(installer, [...installArgs(root), "--writer-effort", "high"]);
    assert.notEqual(installEffortOnly.status, 0);
    assert.match(installEffortOnly.stderr, /--writer-effort 需要同时提供 --writer-model/u);
    const config = path.join(root, ".codex/config.toml");
    mkdirSync(path.dirname(config), { recursive: true });
    const original = '[agents.odai_writer]\nconfig_file = "external-writer.toml"\n';
    writeFileSync(config, original);
    const conflict = runNode(installer, [...installArgs(root), "--writer-model", "writer-model"]);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /既有 Codex 配置已声明 odai 角色/u);
    assert.equal(readFileSync(config, "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function testWriterCodexRuntime(project, config) {
  const fakeCodex = path.join(project, "fake-codex.mjs");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(args));
console.log(JSON.stringify({ type: "thread.started", thread_id: "writer-thread", model: "writer-model" }));
`);
  chmodSync(fakeCodex, 0o700);
  const input = path.join(project, "input.md");
  const evidence = path.join(project, "evidence.json");
  writeFileSync(input, "给已定稿的商店页提供两个有明确取舍的标题候选。\n");
  for (const resume of [false, true]) {
    const result = runNode(path.join(config, "odai-run-role.mjs"), [
      "--role", "writer", "--cwd", project, "--input", input,
      "--codex-bin", fakeCodex, "--sandbox", "danger-full-access", "--evidence", evidence,
      ...(resume ? ["--session-id", "writer-thread"] : []),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(result.stdout);
    if (resume) assert.ok(args.includes('sandbox_mode="read-only"'));
    else assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(args[args.indexOf("--model") + 1], "writer-model");
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.equal(json(evidence).role, "writer");
    assert.equal(json(evidence).observed.model_verified, true);
  }

  const sessions = path.join(project, "sessions");
  mkdirSync(sessions);
  const timestamp = new Date().toISOString();
  const sessionFile = path.join(sessions, "writer.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "writer-thread", agent_role: "odai_writer", cwd: project, timestamp,
      source: { subagent: { thread_spawn: { agent_path: "/root/writer" } } } } },
    { type: "turn_context", payload: { model: "writer-model", effort: "high" } },
  ];
  writeFileSync(sessionFile, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const verifyArgs = ["--host", "codex", "--project", project, "--role", "odai_writer", "--after", timestamp,
    "--agent-path", "/root/writer", "--sessions", sessions];
  const verified = runNode(path.join(config, "odai-verify-routing.mjs"), verifyArgs);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).role, "odai_writer");
  records[1].payload.model = "wrong-model";
  writeFileSync(sessionFile, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const mismatch = runNode(path.join(config, "odai-verify-routing.mjs"), verifyArgs);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /模型不匹配/u);
}

function testHostSessions() {
  const result = spawnSync(process.execPath, ["--test", path.join(repo, "scripts/host-routing-session.test.mjs"), path.join(repo, "scripts/named-dispatch.test.mjs"), path.join(repo, "scripts/lead-dispatch.test.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
