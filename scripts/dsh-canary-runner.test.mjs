import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { observeProviderOutputCeiling } from "./dsh-output-budget-observation.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(repoRoot, "scripts/dsh-canary-runner.mjs");
const fakeDshWebFixture = resolve(repoRoot, "scripts/fixtures/fake-dsh-web-rc1.mjs");

const routingBlock = [
  "    routing:",
  "      mode: auto",
  "      provider: spawn",
].join("\n");

test("provider output ceiling observation distinguishes request evidence from compliance", () => {
  assert.deepEqual(observeProviderOutputCeiling([], undefined), {
    status: "not-requested",
    observedRequests: 0,
    overruns: [],
  });
  assert.deepEqual(observeProviderOutputCeiling([
    { turn: 1, step: 1, usage: { outputTokens: 430 } },
    { turn: 1, step: 2, usage: { output_tokens: 689 } },
  ], 500), {
    status: "provider-exceeded-requested-ceiling",
    requestedMaxTokens: 500,
    observedRequests: 2,
    maxObservedOutputTokens: 689,
    overruns: [{ turn: 1, step: 2, outputTokens: 689 }],
  });
  assert.deepEqual(observeProviderOutputCeiling([
    { turn: 1, step: 1, usage: { outputTokens: 500 } },
  ], 500), {
    status: "within-requested-ceiling",
    requestedMaxTokens: 500,
    observedRequests: 1,
    maxObservedOutputTokens: 500,
    overruns: [],
  });
  assert.throws(() => observeProviderOutputCeiling([], 0), /positive integer/u);
});

test("strict canary fails closed when observed provider output exceeds the request ceiling", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odai-dsh-ceiling-test-"));
  try {
    const sourceHome = resolve(root, "source-home");
    const isolationHome = resolve(root, "isolation-home");
    const workdir = resolve(root, "work");
    const promptFile = resolve(root, "prompt.md");
    const lastMessage = resolve(root, "last-message.txt");
    const fakeDsh = resolve(root, "fake-dsh.mjs");
    await Promise.all([
      mkdir(sourceHome, { recursive: true }),
      mkdir(isolationHome, { recursive: true }),
      mkdir(workdir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(sourceHome, "settings.yaml"), "agent-default-model:\n  provider: openai\n  model: test-model\n  reasoningEffort: xhigh\n", "utf8"),
      writeFile(resolve(sourceHome, ".credentials.yaml"), "{}\n", "utf8"),
      writeFile(promptFile, "test task\n", "utf8"),
      writeFile(fakeDsh, `#!/usr/bin/env node\nimport { mkdir, readFile, writeFile } from "node:fs/promises";\nimport { resolve } from "node:path";\nconst patchPath = process.argv[process.argv.indexOf("--patch") + 1];\nconst patch = await readFile(patchPath, "utf8");\nconst root = JSON.parse(/^    root: (.+)$/mu.exec(patch)[1]);\nconst session = resolve(root, "strict-ceiling", "session.jsonl");\nawait mkdir(resolve(root, "strict-ceiling"), { recursive: true });\nconst records = [\n  { id: "strict-ceiling", origin: "controller" },\n  { type: "request/header", data: { header: { config: { provider: "openai", model: "test-model", reasoningEffort: "xhigh", maxTokens: 500 }, system: "## Odai controller output policy" } } },\n  { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 689 } } } },\n  { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "done" }] } } },\n];\nawait writeFile(session, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n", "utf8");\n`, "utf8"),
    ]);
    await chmod(fakeDsh, 0o700);

    await assert.rejects(
      () => execFileAsync(process.execPath, [
        runner,
        "--prompt-file", promptFile,
        "--cwd", workdir,
        "--last-message", lastMessage,
        "--source-home", sourceHome,
        "--dsh-bin", fakeDsh,
        "--provider", "openai",
        "--model", "test-model",
        "--reasoning-effort", "xhigh",
        "--surface", "plain",
        "--routing-mode", "off",
        "--output-concise",
        "--controller-max-tokens", "500",
        "--require-output-ceiling-compliance",
        "--timeout", "10",
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: isolationHome,
          ODAI_CANARY_HOME: isolationHome,
          ODAI_CANARY_ISOLATION: "odai-canary-isolation/v1",
          ODAI_CANARY_SKILL_MODE: "on",
        },
      }),
      (error) => {
        assert.match(`${error.message}\n${error.stderr ?? ""}`, /provider output ceiling compliance failed/u);
        assert.match(`${error.message}\n${error.stderr ?? ""}`, /"outputTokens":689/u);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-plugin frontend canary merges durable route evidence and verifies the explicit budget", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odai-dsh-frontend-canary-test-"));
  try {
    const sourceHome = resolve(root, "source-home");
    const isolationHome = resolve(root, "isolation-home");
    const workdir = resolve(root, "work");
    const promptFile = resolve(root, "prompt.md");
    const lastMessage = resolve(root, "last-message.txt");
    const runtimePlugin = resolve(root, "runtime/index.mjs");
    const runtimeSkill = resolve(root, "skill/SKILL.md");
    const fakeDsh = resolve(root, "fake-dsh.mjs");
    await Promise.all([
      mkdir(sourceHome, { recursive: true }),
      mkdir(isolationHome, { recursive: true }),
      mkdir(workdir, { recursive: true }),
      mkdir(dirname(runtimePlugin), { recursive: true }),
      mkdir(dirname(runtimeSkill), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(sourceHome, "settings.yaml"), "agent-default-model:\n  provider: openai\n  model: controller\n  reasoningEffort: high\n", "utf8"),
      writeFile(resolve(sourceHome, ".credentials.yaml"), "{}\n", "utf8"),
      writeFile(promptFile, "整体改版这个前端界面。\n", "utf8"),
      writeFile(runtimePlugin, "export default {};\n", "utf8"),
      writeFile(runtimeSkill, "# skill\n", "utf8"),
      writeFile(fakeDsh, `#!/usr/bin/env node\nimport { mkdir, readFile, writeFile } from "node:fs/promises";\nimport { resolve } from "node:path";\nconst patchPath = process.argv[process.argv.indexOf("--patch") + 1];\nconst patch = await readFile(patchPath, "utf8");\nconst root = JSON.parse(/^    root: (.+)$/mu.exec(patch)[1]);\nconst id = "frontend-canary";\nconst sessionDir = resolve(root, id);\nawait mkdir(sessionDir, { recursive: true });\nconst records = [\n  { id, origin: "controller" },\n  { type: "request/header", data: { header: { config: { provider: "kimi-coding", model: "k3", reasoningEffort: "max", maxTokens: 4096 }, system: "## Odai controller output policy" } } },\n  { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 3000 } } } },\n  { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "done" }] } } },\n];\nawait writeFile(resolve(sessionDir, "session.jsonl"), records.map((record) => JSON.stringify(record)).join("\\n") + "\\n", "utf8");\nconst evidenceDir = resolve(process.env.DSH_HOME, "odai/session-evidence");\nawait mkdir(evidenceDir, { recursive: true });\nconst events = [\n  { schemaVersion: 1, sessionId: id, type: "odai/route-decided", data: { role: "controller", action: "upgrade", targetRole: "frontend" } },\n  { schemaVersion: 1, sessionId: id, type: "odai/route-upgrade", data: { requestedRoute: { provider: "kimi-coding", model: "k3", reasoningEffort: "max", maxTokens: 4096 } } },\n  { schemaVersion: 1, sessionId: id, type: "odai/output-budget-overridden", data: { configuredControllerMaxTokens: 500, effectiveMaxTokens: 4096 } },\n];\nawait writeFile(resolve(evidenceDir, id + ".jsonl"), events.map((event) => JSON.stringify(event)).join("\\n") + "\\n", "utf8");\n`, "utf8"),
    ]);
    await chmod(fakeDsh, 0o700);

    const { stdout } = await execFileAsync(process.execPath, [
      runner,
      "--prompt-file", promptFile,
      "--cwd", workdir,
      "--last-message", lastMessage,
      "--source-home", sourceHome,
      "--dsh-bin", fakeDsh,
      "--provider", "kimi-coding",
      "--model", "k3",
      "--reasoning-effort", "max",
      "--surface", "source-plugin",
      "--runtime-plugin-path", runtimePlugin,
      "--runtime-skill-path", runtimeSkill,
      "--routing-mode", "auto",
      "--frontend-provider", "kimi-coding",
      "--frontend-model", "k3",
      "--frontend-reasoning-effort", "max",
      "--frontend-max-tokens", "4096",
      "--controller-max-tokens", "500",
      "--output-concise",
      "--require-output-ceiling-compliance",
      "--timeout", "10",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: isolationHome,
        ODAI_CANARY_HOME: isolationHome,
        ODAI_CANARY_ISOLATION: "odai-canary-isolation/v1",
        ODAI_CANARY_SKILL_MODE: "on",
      },
    });
    assert.match(stdout, /\[dsh-runner surface source-plugin\]/u);
    assert.match(stdout, /\[dsh-runner actual_controller_max_tokens 4096\]/u);
    assert.equal((await readFile(lastMessage, "utf8")).trim(), "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH canary runner isolates Plugin and Agent routing surfaces", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odai-dsh-runner-test-"));
  try {
    const sourceHome = resolve(root, "source-home");
    const isolationHome = resolve(root, "isolation-home");
    const workdir = resolve(root, "work");
    const pluginHome = resolve(root, "plugin-home");
    const agentHome = resolve(root, "agent-home");
    const sourcePlugin = resolve(root, "source-runtime/index.mjs");
    const sourceSkill = resolve(root, "source-skill/SKILL.md");
    const promptFile = resolve(root, "prompt.md");
    await Promise.all([
      mkdir(sourceHome, { recursive: true }),
      mkdir(isolationHome, { recursive: true }),
      mkdir(workdir, { recursive: true }),
      mkdir(resolve(pluginHome, "profiles/headless/node_modules/odai-dsh-plugin/runtime"), { recursive: true }),
      mkdir(resolve(agentHome, ".agent-presets/odai"), { recursive: true }),
      mkdir(dirname(sourcePlugin), { recursive: true }),
      mkdir(dirname(sourceSkill), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(sourceHome, "settings.yaml"), [
        "agent-default-model:",
        "  provider: placeholder",
        "  model: placeholder",
        "  reasoningEffort: low",
        "",
      ].join("\n"), "utf8"),
      writeFile(resolve(sourceHome, ".credentials.yaml"), "{}\n", "utf8"),
      writeFile(resolve(pluginHome, "profiles/headless/node_modules/odai-dsh-plugin/runtime/index.mjs"), "export default {};\n", "utf8"),
      writeFile(resolve(agentHome, ".agent-presets/odai/agent.cordis.yml"), `- id: odai-governance\n  name: ./runtime/index.mjs\n  config:\n${routingBlock}\n`.replaceAll("\n", "\r\n"), "utf8"),
      writeFile(sourcePlugin, "export default {};\n", "utf8"),
      writeFile(sourceSkill, "# source skill\n", "utf8"),
      writeFile(promptFile, [
        "Use the odai skill at `/tmp/frozen/skills/odai/SKILL.md` to handle the user request below. Read that SKILL.md completely before taking task actions.",
        "",
        "test task",
        "",
      ].join("\n"), "utf8"),
    ]);

    const plugin = await runSurface({
      root,
      sourceHome,
      isolationHome,
      workdir,
      promptFile,
      profileHome: pluginHome,
      surface: "plugin",
      routingMode: "observe",
    });
    assert.equal(plugin.hasGlobalPlugin, true);
    assert.equal(plugin.hasAgent, false);
    assert.match(plugin.patch, /mode: observe/u);
    assert.doesNotMatch(plugin.settings, /agent-presets:/u);
    assert.deepEqual(plugin.outputPolicy, {
      schemaVersion: 1,
      policy: { concise: false },
    });

    const agent = await runSurface({
      root,
      sourceHome,
      isolationHome,
      workdir,
      promptFile,
      profileHome: agentHome,
      surface: "agent",
      routingMode: "execute",
      outputConcise: true,
      controllerMaxTokens: 2_500,
    });
    assert.equal(agent.hasGlobalPlugin, false);
    assert.equal(agent.hasAgent, true);
    assert.doesNotMatch(agent.patch, /odai-governance/u);
    assert.match(agent.settings, /agent-presets:\n  default: odai/u);
    assert.match(agent.agentComposition, /mode: execute/u);
    assert.match(agent.agentComposition, /model: "gpt-5\.6-sol"/u);
    assert.deepEqual(agent.outputPolicy, {
      schemaVersion: 1,
      policy: { concise: true, maxTokens: 2_500 },
    });

    const source = await runSurface({
      root,
      sourceHome,
      isolationHome,
      workdir,
      promptFile,
      profileHome: "",
      surface: "source-plugin",
      routingMode: "auto",
      runtimePluginPath: sourcePlugin,
      runtimeSkillPath: sourceSkill,
      researcherProvider: "openai",
      researcherModel: "gpt-5.6-luna",
      researcherReasoningEffort: "xhigh",
      researcherMaxTokens: 500,
      expectResearcher: "skipped",
      frontendProvider: "kimi-coding",
      frontendModel: "k3",
      frontendReasoningEffort: "max",
      frontendMaxTokens: 4_096,
      controllerMaxTokens: 500,
      controllerEmbedsSkill: false,
    });
    assert.equal(source.hasGlobalPlugin, false);
    assert.equal(source.hasAgent, false);
    assert.match(source.patch, /odai-governance-canary-source/u);
    assert.equal(source.patch.includes(`name: ${JSON.stringify(sourcePlugin)}`), true);
    assert.match(source.patch, /researcher:[\s\S]*provider: "openai"[\s\S]*model: "gpt-5\.6-luna"[\s\S]*reasoningEffort: "xhigh"[\s\S]*maxTokens: 500/u);
    assert.match(source.patch, /frontend:[\s\S]*provider: "kimi-coding"[\s\S]*model: "k3"[\s\S]*maxTokens: 4096/u);
    assert.deepEqual(source.outputPolicy, {
      schemaVersion: 1,
      policy: { concise: false, maxTokens: 500 },
    });

    const fakeDsh = resolve(root, "fake-dsh-web.mjs");
    await copyFile(fakeDshWebFixture, fakeDsh);
    await chmod(fakeDsh, 0o700);
    let dshCommand = fakeDsh;
    if (process.platform === "win32") {
      const shimRoot = resolve(root, "fake dsh shim");
      const packageRoot = resolve(shimRoot, "custom modules/@deepseek-ai/dsh");
      const shimEntry = resolve(packageRoot, "lib/bin.js");
      await mkdir(resolve(packageRoot, "lib"), { recursive: true });
      await Promise.all([
        copyFile(fakeDsh, shimEntry),
        writeFile(resolve(packageRoot, "package.json"), "{\"type\":\"module\"}\n", "utf8"),
        writeFile(resolve(shimRoot, "dsh.cmd"), "@ECHO off\r\nnode \"%dp0%\\custom modules\\@deepseek-ai\\dsh\\lib\\bin.js\" %*\r\n", "utf8"),
      ]);
      dshCommand = resolve(shimRoot, "dsh.cmd");
    }
    const webAgent = await runSurface({
      root,
      sourceHome,
      isolationHome,
      workdir,
      promptFile,
      profileHome: agentHome,
      surface: "agent",
      routingMode: "execute",
      dshBin: dshCommand,
      preflight: false,
    });
    assert.deepEqual(webAgent, {
      preset: "odai",
      model: "gpt-5.6-luna",
      permissionMode: "danger-full-access",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runSurface(options) {
  const lastMessage = resolve(options.root, `${options.surface}-${options.preflight === false ? "web" : "preflight"}.json`);
  const commandArgs = [
    runner,
    "--prompt-file", options.promptFile,
    "--cwd", options.workdir,
    "--last-message", lastMessage,
    "--source-home", options.sourceHome,
    "--provider", "openai",
    "--model", "gpt-5.6-luna",
    "--reasoning-effort", "max",
    "--surface", options.surface,
    "--routing-mode", options.routingMode,
    "--planner-provider", "openai",
    "--planner-model", "gpt-5.6-sol",
    "--planner-reasoning-effort", "high",
    "--timeout", "30",
  ];
  if (options.profileHome) commandArgs.push("--profile-home", options.profileHome);
  if (options.controllerEmbedsSkill !== false) commandArgs.push("--controller-embeds-skill");
  if (options.runtimePluginPath) commandArgs.push("--runtime-plugin-path", options.runtimePluginPath);
  if (options.runtimeSkillPath) commandArgs.push("--runtime-skill-path", options.runtimeSkillPath);
  if (options.researcherProvider) commandArgs.push(
    "--researcher-provider", options.researcherProvider,
    "--researcher-model", options.researcherModel,
    "--researcher-reasoning-effort", options.researcherReasoningEffort,
    "--researcher-max-tokens", String(options.researcherMaxTokens),
    "--expect-researcher", options.expectResearcher,
  );
  if (options.frontendProvider) commandArgs.push(
    "--frontend-provider", options.frontendProvider,
    "--frontend-model", options.frontendModel,
    "--frontend-reasoning-effort", options.frontendReasoningEffort,
    "--frontend-max-tokens", String(options.frontendMaxTokens),
  );
  if (options.outputConcise) commandArgs.push("--output-concise");
  if (options.controllerMaxTokens !== undefined) {
    commandArgs.push("--controller-max-tokens", String(options.controllerMaxTokens));
  }
  if (options.dshBin) commandArgs.push("--dsh-bin", options.dshBin);
  if (options.preflight !== false) commandArgs.push("--preflight");
  await execFileAsync(process.execPath, commandArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: options.isolationHome,
      ODAI_CANARY_HOME: options.isolationHome,
      ODAI_CANARY_ISOLATION: "odai-canary-isolation/v1",
      ODAI_CANARY_SKILL_MODE: "on",
    },
  });
  return JSON.parse(await readFile(lastMessage, "utf8"));
}
