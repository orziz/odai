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

    const routingConfigFile = resolve(root, "routing snapshot.json");
    const parserReceipt = resolve(root, "runtime-parser-receipt.txt");
    await writeFile(resolve(dirname(sourcePlugin), "routing-config.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
export function readRoutingStore(path) {
  writeFileSync(${JSON.stringify(parserReceipt)}, path, "utf8");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed.rejectByRuntime) throw new Error("runtime parser rejected snapshot");
  return { roles: parsed.roles, dispatch: parsed.dispatch ?? {} };
}
`, "utf8");
    const snapshotOptions = { root, sourceHome, isolationHome, workdir, promptFile,
      surface: "source-plugin", routingMode: "auto", runtimePluginPath: sourcePlugin,
      runtimeSkillPath: sourceSkill, routingConfigFile, dshBin: resolve(root, "must-not-run") };
    const snapshot = { schemaVersion: 2, roles: {
      researcher: { provider: "research-provider", model: "research-model" },
      planner: { provider: "plan-provider", model: "plan-model" },
      reviewer: { provider: "review-provider", model: "review-model", reasoningEffort: "high" },
      frontend: { provider: "front-provider", model: "front-model", maxTokens: 8192 },
    }, dispatch: { researcher: "same-turn", planner: "child", reviewer: "child", frontend: "same-turn" } };
    await writeFile(resolve(sourceHome, "settings.yaml"), "agent-default-model:\n  provider: old\n  model: old\nagent-presets:\n  default: personal\nagent-memory:\n  text: private-behavior\nllm-pi-ai:\n  fixtureSecret: never-print-this\n", "utf8");
    const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile(routingConfigFile, snapshotText, "utf8");
    await mkdir(resolve(sourceHome, "odai"), { recursive: true });
    const sourceRouting = '{"schemaVersion":2,"roles":{"planner":{"provider":"unrelated","model":"private"}}}\n';
    await writeFile(resolve(sourceHome, "odai/routing.json"), sourceRouting, "utf8");
    const configured = await runSurface(snapshotOptions);
    assert.equal(await readFile(parserReceipt, "utf8"), routingConfigFile);
    assert.deepEqual(configured.routingConfig, snapshot);
    assert.equal(configured.settingsPolicy, "connection-only");
    assert.deepEqual(configured.settingsKeys.sort(), ["agent-default-model", "agent-presets", "llm-pi-ai"]);
    assert.match(configured.settings, /default: standard/u);
    assert.doesNotMatch(JSON.stringify(configured), /private-behavior|never-print-this/u);
    assert.doesNotMatch(configured.patch, /gpt-5\.6-sol|reasoningEffort:|maxTokens:|roles:/u);
    const isolatedConfigPath = JSON.parse(/^\s+configPath: (.+)$/mu.exec(configured.patch)[1]);
    const isolatedSessionRoot = JSON.parse(/^    root: (.+)$/mu.exec(configured.patch)[1]);
    assert.equal(isolatedConfigPath, resolve(dirname(isolatedSessionRoot), "home/odai/routing.json"));
    assert.equal(await readFile(routingConfigFile, "utf8"), snapshotText);
    assert.equal(await readFile(resolve(sourceHome, "odai/routing.json"), "utf8"), sourceRouting);
    assert.deepEqual(configured.outputPolicy, { schemaVersion: 1, policy: { concise: false } });
    for (const flag of ["--planner-model", "--researcher-max-tokens", "--frontend-provider", "--expect-researcher"]) {
      await assert.rejects(() => runSurface({ ...snapshotOptions, extraArgs: [flag, "1"] }), /cannot be mixed with legacy routing flags/u);
    }
    await assert.rejects(() => runSurface({ ...snapshotOptions, surface: "plain", runtimePluginPath: "", runtimeSkillPath: "", controllerEmbedsSkill: false }), /requires --surface source-plugin/u);
    await assert.rejects(() => runSurface({ ...snapshotOptions, extraArgs: ["--routing-config-file", routingConfigFile] }), /may only be supplied once/u);
    await assert.rejects(() => runSurface({ ...snapshotOptions, routingConfigFile: resolve(root, "missing.json") }), /routing config file not found/u);
    await writeFile(routingConfigFile, '{"rejectByRuntime":true}', "utf8");
    await assert.rejects(() => runSurface(snapshotOptions), /runtime parser rejected snapshot/u);
    for (const valid of [{ schemaVersion: 1, roles: { planner: { provider: "p", model: "m" } } }, { schemaVersion: 2, roles: {}, dispatch: { reviewer: "same-turn" } }]) {
      await writeFile(routingConfigFile, JSON.stringify(valid), "utf8");
      const result = await runSurface(snapshotOptions);
      assert.deepEqual(result.routingConfig, { schemaVersion: 2, roles: valid.roles, dispatch: valid.dispatch ?? {} });
      assert.doesNotMatch(result.patch, /gpt-5\.6-sol|reasoningEffort:|maxTokens:|roles:/u);
    }

    const fakeDsh = resolve(root, "fake-dsh-web.mjs");
    await copyFile(fakeDshWebFixture, fakeDsh);
    await copyFile(resolve(repoRoot, "scripts/fixtures/fake-dsh-follow.mjs"), resolve(root, "fake-dsh-follow.mjs"));
    await chmod(fakeDsh, 0o700);
    let dshCommand = fakeDsh;
    if (process.platform === "win32") {
      const shimRoot = resolve(root, "fake dsh shim");
      const packageRoot = resolve(shimRoot, "custom modules/@deepseek-ai/dsh");
      const shimEntry = resolve(packageRoot, "lib/bin.js");
      await mkdir(resolve(packageRoot, "lib"), { recursive: true });
      await Promise.all([
        copyFile(fakeDsh, shimEntry),
        copyFile(resolve(root, "fake-dsh-follow.mjs"), resolve(packageRoot, "lib/fake-dsh-follow.mjs")),
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
      outputConcise: true,
      expectedPolicyObservation: "1/1",
    });
    assert.deepEqual(webAgent, {
      preset: "odai",
      model: "gpt-5.6-luna",
      permissionMode: "danger-full-access",
    });
    const turnsFile = resolve(root, "conversation.json");
    await writeFile(turnsFile, JSON.stringify({ schemaVersion: 1, name: "test-continuation", caseId: 5,
      acceptance: ["Retain real messages and state across restart"],
      turns: [{ useCasePrompt: true }, { prompt: "revise the decision" }, { prompt: "continue after restart", restartBefore: true }] }));
    const continued = await runSurface({ root, sourceHome, isolationHome, workdir, promptFile,
      surface: "plain", routingMode: "off", dshBin: dshCommand, preflight: false,
      transport: "web", turnsFile, controllerEmbedsSkill: false, expectedPolicyObservation: "0/3" });
    assert.equal(continued.preset, "standard");
    const report = JSON.parse(await readFile(resolve(root, "plain-web.json.turns.json"), "utf8"));
    assert.equal(report.completed, true);
    assert.equal(report.turns.length, 3);
    assert.equal(new Set(report.turns.map(turn => turn.requestId)).size, 3);
    assert.equal(new Set(report.turns.map(turn => turn.sessionId)).size, 1);
    assert.deepEqual(report.turns.map(turn => turn.turn), [1, 3, 5]);
    assert.deepEqual(report.turns.map(turn => turn.restarted), [false, false, true]);
    for (const [index, turn] of report.turns.entries()) {
      assert.ok(turn.endSeq > turn.messageSeq);
      if (index) assert.ok(turn.messageSeq > report.turns[index - 1].endSeq);
      assert.equal(await readFile(resolve(turn.workspaceSnapshot, "turn-state.txt"), "utf8"), turn.prompt);
      const events = (await readFile(turn.eventsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.at(-1).seq, turn.endSeq);
      assert.ok(events.some(event => event.type === "user/message" && event.data.source.rpcId === turn.requestId));
      if (index) assert.ok(events.every(event => event.seq > report.turns[index - 1].endSeq));
    }
    assert.match(report.protocol.sha256, /^[a-f0-9]{64}$/u);
    await rm(resolve(root, "plain-web.json.events.jsonl"));
    await assert.rejects(() => runSurface({ root, sourceHome, isolationHome, workdir, promptFile,
      surface: "plain", routingMode: "off", dshBin: dshCommand, preflight: false,
      transport: "web", controllerEmbedsSkill: false, unclaimedMessage: true }), /outside an open native claimed step/u);
    const failedEvents = (await readFile(resolve(root, "plain-web.json.events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(failedEvents.some(event => event.type === "user/message" && event.data.source.rpcId));
    assert.equal(JSON.parse(await readFile(resolve(root, "plain-web.json.turns.json"), "utf8")).completed, false);
    await assert.rejects(() => runSurface({ root, sourceHome, isolationHome, workdir, promptFile,
      surface: "plain", routingMode: "off", dshBin: dshCommand, preflight: false,
      transport: "web", controllerEmbedsSkill: false, historyStall: true }), /history pagination made no progress/u);
    const schemaFile = resolve(root, "judge-schema.json");
    await writeFile(schemaFile, '{"type":"object"}', "utf8");
    const judgeOptions = { root, sourceHome, isolationHome, workdir, promptFile, surface: "plain", routingMode: "off",
      dshBin: dshCommand, preflight: false, controllerEmbedsSkill: false, skillMode: "off",
      promptFile: "-", input: "Judge this isolated task result.", expectedRole: "judge",
      extraArgs: ["--role", "judge", "--schema-file", schemaFile] };
    const judged = await runSurface(judgeOptions);
    assert.equal(judged.permissionMode, "read-only");
    const judgePreflight = await runSurface({ ...judgeOptions, preflight: true });
    assert.match(judgePreflight.patch, /- id: approval\n  config:\n    policy: never/u);
    assert.match(judgePreflight.patch, /defaultPreset: read-only\n    presets:\n      read-only:\n        sandbox: read-only\n        approval: never/u);
    assert.match(judgePreflight.patch, /- id: session-title-llm\n  disabled: true/u);
    await assert.rejects(() => runSurface({ ...judgeOptions, skillMode: "on" }), /judge requires isolated skill-off/u);
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
    "--timeout", "30",
  ];
  if (options.routingConfigFile) commandArgs.push("--routing-config-file", options.routingConfigFile);
  else commandArgs.push("--planner-provider", "openai", "--planner-model", "gpt-5.6-sol", "--planner-reasoning-effort", "high");
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
  if (options.transport) commandArgs.push("--transport", options.transport);
  if (options.turnsFile) commandArgs.push("--turns-file", options.turnsFile);
  if (options.preflight !== false) commandArgs.push("--preflight");
  commandArgs.push(...(options.extraArgs ?? []));
  const execution = execFileAsync(process.execPath, commandArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: options.isolationHome,
      ODAI_CANARY_HOME: options.isolationHome,
      ODAI_CANARY_ISOLATION: "odai-canary-isolation/v1",
      ODAI_CANARY_SKILL_MODE: options.skillMode ?? "on",
      ODAI_TEST_UNCLAIMED_MESSAGE: options.unclaimedMessage ? "1" : "",
      ODAI_TEST_HISTORY_STALL: options.historyStall ? "1" : "",
    },
  });
  if (options.input !== undefined) execution.child.stdin.end(options.input);
  const { stdout } = await execution;
  if (options.expectedRole) assert.ok(stdout.includes(`adapter=dsh role=${options.expectedRole} skill_mode=${options.skillMode} home=isolated`));
  if (options.expectedPolicyObservation) assert.ok(stdout.includes(`[dsh-runner output_policy_prompt_observed ${options.expectedPolicyObservation}]`), stdout);
  return JSON.parse(await readFile(lastMessage, "utf8"));
}
