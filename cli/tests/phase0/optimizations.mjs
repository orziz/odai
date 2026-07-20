import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentLoop } from "../../src/runtime/agent-loop.mjs";
import {
  partitionModelIntents,
  resolveAgentLoopMaxTurns,
  summarizeControlIntents,
} from "../../src/runtime/agent-control.mjs";
import { parseToolIntentEnvelope } from "../../src/runtime/tool-intent-codec.mjs";
import { selectSkillReferences } from "../../src/core/skill-pack.mjs";
import { compressConversationContext, runMockTask } from "../../src/core/run-task.mjs";
import { buildTranscriptCompactContext } from "../../src/core/transcript-store.mjs";
import { validateProvider, assertProvider } from "../../src/orchestrator/provider-contract.mjs";
import { createMockProvider } from "../../src/providers/mock-provider.mjs";
import { runCommandAsync } from "../../src/providers/subprocess-runner.mjs";
import { EvidenceLedger } from "../../src/runtime/evidence-ledger.mjs";
import { ToolDispatcher } from "../../src/runtime/tool-dispatcher.mjs";
import { SessionState } from "../../src/core/session-state.mjs";
import { prepareProviderInput } from "../../src/runtime/provider-session.mjs";
import { buildNextTaskContext } from "../../src/core/interactive/session-task.mjs";
import { describeRuntimeGovernance } from "../../src/core/governance-registry.mjs";
import { prepareModelIntents, DEFAULT_MAX_MODEL_TOOL_INTENTS } from "../../src/runtime/model-tool-intents.mjs";
import { parseResumeArgs } from "../../src/core/continue-run.mjs";
import {
  discoverSkillsSync,
  findSkillByName,
  matchSkillsInTask,
  normalizeSkillName,
  RESERVED_SLASH_COMMANDS,
} from "../../src/core/skill-discovery.mjs";
import { composeTaskPromptPack, loadSkillPack } from "../../src/core/skill-pack.mjs";
import { access, mkdir, writeFile } from "node:fs/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.ODAI_LANG = "en";

// Node 20 can emit EPIPE when a short-lived child exits before stdin is flushed.
const shortLivedCommand = await runCommandAsync(process.execPath, ["--version"], {
  input: "x".repeat(1024 * 1024),
});
assert.equal(shortLivedCommand.status, 0);
assert.match(shortLivedCommand.stdout, /^v\d+/);

// --- agent-control helpers ---
assert.deepEqual(
  partitionModelIntents([
    { type: "read", path: "a" },
    { type: "complete", summary: "done" },
    { type: "ask-user", question: "ok?" },
    { type: "spawn-subagent", profile: "reviewer" },
  ]),
  {
    toolIntents: [{ type: "read", path: "a" }],
    controlIntents: [
      { type: "complete", summary: "done" },
      { type: "ask-user", question: "ok?" },
      { type: "spawn-subagent", profile: "reviewer" },
    ],
  },
);

assert.equal(resolveAgentLoopMaxTurns({ reasoning: "high" }), 16);
assert.equal(resolveAgentLoopMaxTurns({ reasoning: "medium" }), 10);
assert.equal(resolveAgentLoopMaxTurns({ reasoning: "low" }), 6);
assert.equal(resolveAgentLoopMaxTurns({ maxTurns: 3, maxTurnsExplicit: true }), 3);
assert.equal(resolveAgentLoopMaxTurns({}), 4);

const envelope = parseToolIntentEnvelope(
  JSON.stringify({
    text: "spawn",
    toolIntents: [{ type: "spawn-subagent", profile: "challenger", provider: "auto", reason: "check" }],
  }),
);
assert.equal(envelope.toolIntents?.[0]?.type, "spawn-subagent");
assert.equal(envelope.toolIntents?.[0]?.profile, "challenger");

// --- skill references on demand (tight signals only) ---
const baseline = selectSkillReferences({ task: "ping" });
assert.deepEqual(baseline, []);
assert.equal(baseline.includes("references/capabilities/delivery.md"), false);

const governanceBaseline = selectSkillReferences({ task: "ping", includeGovernance: true });
assert.ok(governanceBaseline.includes("references/dao/authority.md"));
assert.ok(governanceBaseline.includes("references/dao/verification.md"));

// broad nouns alone must NOT bloat skill pack
assert.equal(selectSkillReferences({ task: "看看代码和测试" }).includes("references/capabilities/delivery.md"), false);
assert.equal(selectSkillReferences({ task: "plan next steps" }).includes("references/capabilities/planning.md"), false);

const implementRefs = selectSkillReferences({ task: "按 implement-code 落地实现这个修复" });
assert.ok(implementRefs.includes("references/capabilities/delivery.md"));

const diagnoseRefs = selectSkillReferences({ task: "排查这个性能回归并定位原因" });
assert.ok(diagnoseRefs.includes("references/capabilities/delivery.md"));

assert.ok(selectSkillReferences({ task: "部署到生产前确认授权和回退" }).includes("references/dao/authority.md"));
assert.ok(selectSkillReferences({ task: "验收这个旧任务是否已经完成" }).includes("references/dao/verification.md"));
assert.ok(selectSkillReferences({ task: "恢复这个跨会话长期任务" }).includes("references/dao/continuity.md"));

const readmeRefs = selectSkillReferences({ task: "整理 README 和 commit message" });
assert.deepEqual(readmeRefs, baseline);

const reviewRefs = selectSkillReferences({ task: "请 code review 这个 diff" });
assert.ok(reviewRefs.includes("references/capabilities/review.md"));

const routingPack = await loadSkillPack({ repoRoot });
const referenceRouteCases = [
  ["写 feature-plan 规格规划", "agent_loop", "references/capabilities/planning.md"],
  ["整理 design-spec 设计说明", "agent_loop", "references/capabilities/design.md"],
  ["设计一个后台工作台页面", "agent_loop", "references/domains/ui-design.md"],
  ["做游戏策划和关卡设计", "agent_loop", "references/domains/interactive-systems.md"],
  ["诊断报错后落地修复", "agent_loop", "references/capabilities/delivery.md"],
  ["下放 agent 做独立挑战", "agent_loop", "references/dao/leverage.md"],
  ["启动多模型合议模式", "agent_loop", "references/techniques/consensus.md"],
  ["完整三省六部全仓审查", "agent_loop", "references/techniques/review-modes.md"],
  ["处理冻结范围", "subagent", "references/dao/leverage.md"],
];
for (const [task, mode, expectedReference] of referenceRouteCases) {
  const references = selectSkillReferences({ task, mode });
  assert.ok(references.includes(expectedReference), `${task} should select ${expectedReference}`);
  assert.ok(routingPack.supportFiles.includes(expectedReference), `${expectedReference} must exist in canonical skill`);
  await routingPack.render({ references });
}

const governanceSourceRoot = path.resolve(routingPack.root, "..", "..");
for (const entry of describeRuntimeGovernance().entries) {
  for (const sourceRef of entry.sourceRefs) {
    const [sourcePath] = sourceRef.split(":");
    await access(path.join(governanceSourceRoot, sourcePath));
  }
}

// --- provider contract ---
const mock = createMockProvider("mock-main", ["reasoning", "code"]);
assert.equal(validateProvider(mock).ok, true);
assert.equal(assertProvider(mock).name, "mock-main");
assert.equal(validateProvider({ name: "x" }).ok, false);

// --- agent loop control semantics ---
const sessionTmp = await mkdtemp(path.join(tmpdir(), "odai-opt-"));
const evidence = new EvidenceLedger();
const session = new SessionState({ id: "opt-session" });
const dispatcher = new ToolDispatcher({
  workspaceRoot: repoRoot,
  sessionTmp,
  evidence,
  session,
});

// resume argv parser remains importable after continue-run extraction
const resumeArgs = parseResumeArgs(["--tail", "0"]);
assert.equal(resumeArgs.tail, 0);
assert.equal(resumeArgs.initialTaskArgv, undefined);

// raw intent batch limit covers control intents (spawn flood)
const spawnFlood = prepareModelIntents({
  intents: Array.from({ length: 25 }, () => ({ type: "spawn-subagent", profile: "reviewer" })),
  actor: { kind: "main", id: "main" },
});
assert.ok(spawnFlood.overflow);
assert.equal(spawnFlood.overflow.count, 25);
assert.equal(spawnFlood.overflow.limit, DEFAULT_MAX_MODEL_TOOL_INTENTS);
assert.equal(spawnFlood.controlIntents.length, 0);
assert.equal(spawnFlood.toolIntents.length, 0);

const completeLoop = await runAgentLoop({
  provider: createMockProvider("mock-main", ["reasoning", "code"]),
  task: "complete control path",
  dispatcher,
  evidence,
  maxTurns: 4,
});
assert.equal(completeLoop.completed, true);
assert.equal(completeLoop.stopReason, "provider_complete");
assert.equal(completeLoop.completionSummary, "Mock completion without more tools.");

const askLoop = await runAgentLoop({
  provider: createMockProvider("mock-main", ["reasoning", "code"]),
  task: "ask user control path",
  dispatcher,
  evidence,
  maxTurns: 4,
});
assert.equal(askLoop.completed, false);
assert.equal(askLoop.stopReason, "needs_user");
assert.match(askLoop.userPrompt || "", /continue/i);

const spawnLoop = await runAgentLoop({
  provider: createMockProvider("mock-main", ["reasoning", "code"]),
  task: "spawn subagent control path",
  dispatcher,
  evidence,
  maxTurns: 4,
});
assert.equal(spawnLoop.completed, true);
assert.equal(spawnLoop.stopReason, "provider_complete");
assert.equal(spawnLoop.spawnRequests?.length, 1);
assert.equal(spawnLoop.spawnRequests[0].profile, "reviewer");

// 25 control-only spawns must fail closed with no spawnRequests fan-out
const floodProvider = {
  name: "flood-main",
  kind: "mock",
  auth: "none",
  capabilities: ["reasoning", "code"],
  available: true,
  async run() {
    return {
      provider: "flood-main",
      text: "spawn flood",
      toolIntents: Array.from({ length: 25 }, () => ({
        type: "spawn-subagent",
        profile: "reviewer",
        provider: "auto",
      })),
    };
  },
};
const floodEvidence = new EvidenceLedger();
const floodLoop = await runAgentLoop({
  provider: floodProvider,
  task: "spawn flood",
  dispatcher: new ToolDispatcher({
    workspaceRoot: repoRoot,
    sessionTmp,
    evidence: floodEvidence,
    session: new SessionState({ id: "flood-session" }),
  }),
  evidence: floodEvidence,
  maxTurns: 1,
});
assert.equal(floodLoop.completed, false);
assert.equal(floodLoop.stopReason, "tool_intent_limit_exceeded");
assert.equal(floodLoop.spawnRequests, undefined);
assert.equal(floodLoop.turns[0].toolIntentOverflow.count, 25);
assert.ok(floodEvidence.denials.some((denial) => denial.intent?.type === "tool-intent-batch"));

// Prior-turn spawn must not survive a later raw overflow (no spawn fan-out on failed loop)
let mixedSpawnTurn = 0;
const mixedSpawnProvider = {
  name: "mixed-spawn-overflow",
  kind: "mock",
  auth: "none",
  capabilities: ["reasoning", "code"],
  available: true,
  async run() {
    mixedSpawnTurn += 1;
    if (mixedSpawnTurn === 1) {
      return {
        provider: "mixed-spawn-overflow",
        text: "first turn spawn",
        toolIntents: [
          {
            type: "spawn-subagent",
            profile: "reviewer",
            provider: "auto",
          },
          {
            type: "read",
            path: "README.md",
          },
        ],
      };
    }
    return {
      provider: "mixed-spawn-overflow",
      text: "second turn flood",
      toolIntents: Array.from({ length: 25 }, () => ({
        type: "spawn-subagent",
        profile: "reviewer",
        provider: "auto",
      })),
    };
  },
};
const mixedEvidence = new EvidenceLedger();
const mixedLoop = await runAgentLoop({
  provider: mixedSpawnProvider,
  task: "spawn then overflow",
  dispatcher: new ToolDispatcher({
    workspaceRoot: repoRoot,
    sessionTmp,
    evidence: mixedEvidence,
    session: new SessionState({ id: "mixed-spawn-session" }),
  }),
  evidence: mixedEvidence,
  maxTurns: 4,
});
assert.equal(mixedLoop.completed, false);
assert.equal(mixedLoop.stopReason, "tool_intent_limit_exceeded");
assert.equal(mixedLoop.spawnRequests, undefined);
assert.ok(mixedLoop.turns.length >= 2);
assert.ok(mixedLoop.turns.some((turn) => turn.toolIntentOverflow?.count === 25));

// --- runTask integration: skill refs + max turns + spawn ---
const completeTask = await runMockTask({
  repoRoot,
  argv: ["complete control path", "--agent-loop", "--provider", "mock-main"],
});
assert.equal(completeTask.status, "ready");
assert.equal(completeTask.agentLoop?.stopReason, "provider_complete");
assert.ok(Array.isArray(completeTask.skill?.references));
assert.deepEqual(completeTask.skill.references, []);

const highReasoning = await runMockTask({
  repoRoot,
  argv: ["complete control path", "--agent-loop", "--provider", "mock-main", "--reasoning", "high"],
});
assert.equal(highReasoning.maxTurns, 16);

const explicitTurns = await runMockTask({
  repoRoot,
  argv: ["complete control path", "--agent-loop", "--provider", "mock-main", "--max-turns", "2"],
});
assert.equal(explicitTurns.maxTurns, 2);

// Default: spawn requests are recorded, not auto-executed
const spawnTask = await runMockTask({
  repoRoot,
  argv: [
    "spawn subagent control path",
    "--agent-loop",
    "--provider",
    "mock-main",
  ],
});
assert.equal(spawnTask.status, "ready");
assert.equal(spawnTask.spawnAutoExecuted, false);
assert.equal(spawnTask.spawnRequests?.length, 1);
assert.equal(spawnTask.subagentReviews.length, 0);
assert.match(spawnTask.note || "", /--auto-spawn/);

// Opt-in auto-spawn schedules subagents
const spawnTaskAuto = await runMockTask({
  repoRoot,
  argv: [
    "spawn subagent control path",
    "--agent-loop",
    "--provider",
    "mock-main",
    "--auto-spawn",
    "--exclude-provider",
    "codex-cli",
    "--exclude-provider",
    "grok-cli",
    "--exclude-provider",
    "claude-cli",
    "--exclude-provider",
    "claude-agent-sdk",
  ],
});
assert.equal(spawnTaskAuto.status, "ready");
assert.equal(spawnTaskAuto.spawnAutoExecuted, true);
assert.ok(spawnTaskAuto.subagentReviews.length >= 1);

// --- context compression ---
const fatContext = {
  status: "ready",
  lastTaskArgv: ["task-a"],
  lastResult: { status: "ready", task: "task-a" },
  recent: Array.from({ length: 30 }, (_, i) => ({
    type: "task-pair",
    argv: [`task-${i}`],
    blob: "x".repeat(500),
  })),
};
const compressed = compressConversationContext(fatContext, { contextWindowTokens: 20000, maxRecent: 8 });
assert.ok(compressed.compressed);
assert.ok(compressed.recent.length <= 8);
assert.ok(compressed.compressed.recentDropped >= 0);

// Small context must pass through prepareProviderInput without forced reshape
const smallPrepared = prepareProviderInput({
  input: {
    task: "tiny",
    conversationContext: {
      status: "ready",
      lastTaskArgv: ["a"],
      lastResult: { status: "ready", task: "a" },
      recent: [{ type: "task-pair", argv: ["a"] }],
    },
  },
  provider: { name: "mock-main", kind: "mock" },
  workspaceRoot: repoRoot,
});
assert.equal(smallPrepared.conversationContext?.compressed, undefined);

// Oversized context compresses at prepareProviderInput
const prepared = prepareProviderInput({
  input: {
    task: "auto compress",
    conversationContext: fatContext,
    modelOptions: { contextWindowTokens: 20000 },
    previousToolResults: Array.from({ length: 30 }, (_, i) => ({
      turn: i,
      intent: { type: "read", path: `f${i}.txt` },
      result: { ok: true, type: "read", path: `f${i}.txt`, content: "x".repeat(8000) },
    })),
  },
  provider: { name: "mock-main", kind: "mock" },
  workspaceRoot: repoRoot,
});
assert.ok(prepared.conversationContext?.compressed);
assert.ok(prepared.conversationContext.recent.length <= 8);
assert.ok(prepared.previousToolResults.length <= 12);
assert.ok(prepared.previousToolResults.every((entry) => !entry.result?.content || entry.result.content.length <= 4100));

// Interactive multi-turn context force-compresses session memory
const nextContext = buildNextTaskContext({
  previousContext: fatContext,
  argv: ["next", "--save", "--agent-loop", "--provider", "auto"],
  result: {
    status: "ready",
    task: "next",
    providerSessions: [{ provider: "mock-main", sessionId: "s1" }],
    agentLoop: {
      turns: [{ toolResults: [{ type: "read", path: "mock.txt", ok: true }] }],
    },
  },
  workspaceRoot: repoRoot,
  contextWindowTokens: 20000,
});
assert.ok(nextContext.compressed);
assert.ok(nextContext.recent.length <= 10);
assert.ok(Array.isArray(nextContext.lastResult.toolActions));

const compact = buildTranscriptCompactContext({
  sessionId: "s1",
  transcriptPath: "/tmp/x.jsonl",
  entries: [
    { type: "session-start" },
    { type: "task-submit", argv: ["hello", "--provider", "mock-main"] },
    {
      type: "task-result",
      result: {
        status: "ready",
        task: "hello",
        agentLoop: { stopReason: "provider_complete" },
      },
    },
  ],
  budgetTokens: 1000,
});
assert.equal(compact.kind, "session-compact-context");
assert.ok(Array.isArray(compact.stopReasons));
assert.equal(compact.stopReasons[0]?.stopReason, "provider_complete");
assert.ok(compact.compressed);

// --- skill discovery (.agents + skills) and /skill-name model ---
const skillDiscoveryRoot = await mkdtemp(path.join(tmpdir(), "odai-skill-disc-"));
await mkdir(path.join(skillDiscoveryRoot, ".agents", "skills", "demo-craft"), { recursive: true });
await writeFile(
  path.join(skillDiscoveryRoot, ".agents", "skills", "demo-craft", "SKILL.md"),
  "---\nname: demo-craft\ndescription: Demo craft skill\n---\n\nUse demo craft.\n",
  "utf8",
);
await mkdir(path.join(skillDiscoveryRoot, "skills", "workspace-craft"), { recursive: true });
await writeFile(
  path.join(skillDiscoveryRoot, "skills", "workspace-craft", "SKILL.md"),
  "---\nname: workspace-craft\ndescription: Workspace craft\n---\n\nWorkspace craft body.\n",
  "utf8",
);
const discovered = discoverSkillsSync({
  workspaceRoot: skillDiscoveryRoot,
  env: { ...process.env, HOME: path.join(skillDiscoveryRoot, "no-home") },
  includeUserAgents: false,
});
assert.ok(discovered.some((skill) => skill.name === "demo-craft" && skill.sourceKind === "agents"));
assert.ok(discovered.some((skill) => skill.name === "workspace-craft" && skill.sourceKind === "skills"));

// /skills full inventory lists every install (uniqueByName: false)
const { listAllSkills, formatSkillsReport, skillDiscoveryRoots } = await import("../../src/core/skill-discovery.mjs");
const allListed = listAllSkills({
  workspaceRoot: skillDiscoveryRoot,
  env: { ...process.env, HOME: path.join(skillDiscoveryRoot, "no-home") },
  includeUserAgents: false,
});
assert.ok(allListed.length >= 2);
assert.ok(allListed.some((skill) => skill.name === "demo-craft"));
assert.ok(allListed.some((skill) => skill.name === "workspace-craft"));
// uniqueByName resolve path is smaller or equal; list path is the full inventory surface for /skills
const primaryOnly = discoverSkillsSync({
  workspaceRoot: skillDiscoveryRoot,
  env: { ...process.env, HOME: path.join(skillDiscoveryRoot, "no-home") },
  includeUserAgents: false,
  uniqueByName: true,
});
assert.ok(allListed.length >= primaryOnly.length);
const report = formatSkillsReport({
  skills: allListed,
  active: ["demo-craft"],
  workspaceRoot: skillDiscoveryRoot,
});
assert.match(report, /skills discovered: \d+ install/);
assert.match(report, /unique name/);
assert.match(report, /full inventory/);
assert.match(report, /\/demo-craft/);
assert.match(report, /\/workspace-craft/);
// ~/.agents/skills stays user-scoped even when walk would otherwise hit home
const fakeHome = path.join(skillDiscoveryRoot, "home-user");
const userAgentsRoot = path.join(fakeHome, ".agents", "skills");
await mkdir(path.join(userAgentsRoot, "user-craft"), { recursive: true });
await writeFile(
  path.join(userAgentsRoot, "user-craft", "SKILL.md"),
  "---\nname: user-craft\ndescription: user scoped craft\n---\n# user-craft\n",
  "utf8",
);
const roots = skillDiscoveryRoots({
  workspaceRoot: path.join(fakeHome, "project", "nested"),
  env: { HOME: fakeHome },
  includeUserAgents: true,
  includePackagedOdai: false,
  maxParentDepth: 8,
});
const userRoot = roots.find((item) => item.root === path.resolve(userAgentsRoot));
assert.ok(userRoot, "user agents root should be discovered");
assert.equal(userRoot.scope, "user");
assert.ok(!roots.some((item) => item.scope !== "user" && item.root === path.resolve(userAgentsRoot)));
const withUser = listAllSkills({
  workspaceRoot: path.join(fakeHome, "project", "nested"),
  env: { HOME: fakeHome },
  includeUserAgents: true,
  includePackagedOdai: false,
});
assert.ok(withUser.some((skill) => skill.name === "user-craft" && skill.scope === "user"));
assert.equal(normalizeSkillName("/Demo-Craft"), "demo-craft");
assert.ok(RESERVED_SLASH_COMMANDS.has("model"));
assert.ok(RESERVED_SLASH_COMMANDS.has("skills"), "/skills remains a reserved list command");
assert.equal(findSkillByName("demo-craft", { workspaceRoot: skillDiscoveryRoot, includeUserAgents: false })?.name, "demo-craft");
assert.deepEqual(
  matchSkillsInTask("please use demo-craft for this", discovered),
  ["demo-craft"],
);

const odaiPack = await loadSkillPack({ repoRoot });
const external = await (await import("../../src/core/skill-discovery.mjs")).loadExternalSkillPack("demo-craft", {
  workspaceRoot: skillDiscoveryRoot,
  env: { HOME: path.join(skillDiscoveryRoot, "no-home") },
});
const composed = await composeTaskPromptPack({
  odaiPack,
  odaiReferences: ["references/dao/authority.md"],
  externalSkills: [external],
});
assert.ok(composed.promptPack.includes("odai skill entry"));
assert.ok(composed.promptPack.includes("external skill: demo-craft"));
assert.ok(composed.promptPack.includes("do not override odai governance"));
assert.deepEqual(composed.externalSkillNames, ["demo-craft"]);

const skillRun = await runMockTask({
  repoRoot: skillDiscoveryRoot,
  argv: ["use demo craft", "--agent-loop", "--provider", "mock-main", "--skill", "demo-craft"],
});
assert.equal(skillRun.status, "ready");
assert.ok(skillRun.skill.external.includes("demo-craft"));
assert.ok(skillRun.skill.references.includes("references/dao/leverage.md"));
assert.ok(skillRun.skill.promptPackBytes > 0);

console.log("optimizations: ok");
