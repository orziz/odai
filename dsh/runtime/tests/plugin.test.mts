import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolve } from "node:path";

import {
  apply,
  inheritCompactionReasoning,
  resolveConfig,
  runRoutedRole,
} from "../build/index.mjs";
import {
  readStoredSessionEvidence,
  resolveSessionEvidenceRoot,
} from "../build/session-evidence.mjs";
import { activeOdaiToolNames, classifyContextActivation, estimateContextTokens, estimateToolSchemaTokens } from "../build/context-activation.mjs";
import { readMemoryStore } from "../build/semantic-memory-store.mjs";
import type { Responsibility } from "../src/responsibility-gap.mjs";
import type {
  DshContentBlock,
  DshEvent,
  DshMessage,
  DshRuntimeContext,
  DshSession,
  ModelRoute,
  PromptSection,
  RuntimeEventData,
  ToolRestriction,
  UnknownRecord,
} from "../src/runtime-types.mjs";
import { isUnknownRecord } from "../src/runtime-types.mjs";

class RequiredMap<TKey, TValue> extends Map<TKey, TValue> {
  override get(key: TKey): TValue {
    const value = super.get(key);
    if (value === undefined) throw new Error(`missing required test fixture key: ${String(key)}`);
    return value;
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("missing required test string");
  return value;
}

function messageText(message: DshMessage | undefined): string {
  return blockText(message?.content?.[0]);
}

function blockText(block: DshContentBlock | undefined): string {
  if (typeof block?.text !== "string") throw new Error("missing required test text block");
  return block.text;
}

function findLastEvent(events: readonly DshEvent[], predicate: (event: DshEvent) => boolean): DshEvent {
  const event = events.findLast(predicate);
  if (event === undefined) throw new Error("missing required final test event");
  return event;
}

function findEvent(events: readonly DshEvent[], predicate: (event: DshEvent) => boolean): DshEvent {
  const event = events.find(predicate);
  if (event === undefined) throw new Error("missing required test event");
  return event;
}

function last<TValue>(values: readonly TValue[]): TValue {
  const value = values.at(-1);
  if (value === undefined) throw new Error("missing required final test fixture item");
  return value;
}

class RequiredArray<TValue> extends Array<TValue> {
  override find<TMatch extends TValue>(predicate: (value: TValue, index: number, obj: TValue[]) => value is TMatch): TMatch;
  override find(predicate: (value: TValue, index: number, obj: TValue[]) => unknown): TValue;
  override find(predicate: (value: TValue, index: number, obj: TValue[]) => unknown): TValue {
    const value = super.find(predicate);
    if (value === undefined) throw new Error("missing required test fixture item");
    return value;
  }
}

interface TestRestriction extends ToolRestriction { readonly deny: readonly string[] }

interface TestMemoryEntry extends UnknownRecord {
  value: string;
  content: string;
  source: { sessionId: string; turn: number };
}
interface TestLatestRoute extends UnknownRecord {
  status: string;
  taskStatus: string;
  error: string;
  taskError: string;
  role: string;
  actualRoute: ModelRoute;
  requestedRoute: ModelRoute;
  mismatchReasons: string[];
}
interface TestToolResult extends UnknownRecord {
  entries: readonly TestMemoryEntry[];
  roles: Readonly<Record<string, unknown>>;
  sources: Readonly<Record<string, unknown>>;
  upstream: { bundleDigest: string; digest: string };
  generation: { generationId: string; activationPhrase: string; authorizationLevel: string };
  active: { generationId: string };
  content: string;
  reasonCode: string;
  error: string;
  taskError: string;
  status: string;
  role: string;
  authorizationPhrase: string;
  proposalPhrase: string;
  sha256: string;
  contract: string;
  digest: string;
  reference: string;
  runtimeContract: number;
  skillVersion: string;
  latestRoute: TestLatestRoute;
  responsibilityBudgets: Readonly<Record<string, number>>;
  signals: string[];
  requestedRoute: ModelRoute;
}
interface TestPromptSection extends PromptSection { readonly text: string }
interface TestToolSchema extends UnknownRecord {
  readonly name: string;
  readonly description: string;
  readonly parameters: UnknownRecord & { readonly properties: UnknownRecord };
}
interface TestTool extends TestToolSchema {
  readonly output: { render(arguments_: UnknownRecord, value: TestToolResult): readonly DshContentBlock[] };
  execute(arguments_: UnknownRecord, execution: UnknownRecord): Promise<TestToolResult>;
}

function isTestTool(value: unknown): value is TestTool {
  return isUnknownRecord(value)
    && typeof value.name === "string"
    && typeof value.execute === "function"
    && isUnknownRecord(value.output)
    && typeof value.output.render === "function";
}

interface TestRequest extends UnknownRecord {
  purpose?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  cacheRetention?: "provider-default" | "short" | "long" | "none";
  maxTokens?: number;
  messages?: DshMessage[];
  signal?: AbortSignal;
}

interface TestRequestWithMessages extends TestRequest { messages: DshMessage[] }

interface TestSubagentRequest extends UnknownRecord {
  maxDepth: number;
  label: string;
  prompt: DshContentBlock[];
  agentOptions: ModelRoute;
}
function asTestSubagentRequest(value: UnknownRecord): TestSubagentRequest {
  if (!Array.isArray(value.prompt) || typeof value.maxDepth !== "number" || typeof value.label !== "string") {
    throw new TypeError("invalid test subagent request");
  }
  return value as TestSubagentRequest;
}

interface TestLlm {
  resolveCallConfig(config: UnknownRecord, signal?: AbortSignal): unknown | Promise<unknown>;
  stream(options: UnknownRecord): AsyncIterable<UnknownRecord>;
}

interface CapturedContext {
  handlers: RequiredMap<string, CallableFunction>;
  handlerOptions: Map<string, unknown>;
  sections: RequiredArray<TestPromptSection>;
  guards: CallableFunction[];
  tools: RequiredArray<TestTool>;
  logs: string[];
}

interface TestSessionLookup {
  get(sessionId: string): DshSession | undefined;
}
interface FakeContextExtra extends UnknownRecord {
  llm?: Partial<TestLlm>;
  sessions?: TestSessionLookup;
  toolSchemas?: (captured: CapturedContext) => TestToolSchema[];
}

type FakeContext = DshRuntimeContext & { readonly captured: CapturedContext };

const skillPath = resolve(import.meta.dirname, "../../../skills/odai/SKILL.md");
const previousDshHome = process.env.DSH_HOME;
const testDshHome = mkdtempSync(resolve(tmpdir(), "odai-runtime-tests-"));
const researchProjectRoot = resolve(testDshHome, "research-project");
mkdirSync(resolve(researchProjectRoot, "config"), { recursive: true });
mkdirSync(resolve(researchProjectRoot, "logs"), { recursive: true });
writeFileSync(resolve(researchProjectRoot, "config/checkout.json"), ["", "", "", "retries=1", ""].join("\n"));
writeFileSync(resolve(researchProjectRoot, "logs/incidents.md"), [
  "", "", "", "", "", "", "", "", "", "", "", "duplicate after timeout", "",
].join("\n"));
process.env.DSH_HOME = testDshHome;
test.after(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(testDshHome, { recursive: true, force: true });
});

function fakeContext(extra: FakeContextExtra = {}): FakeContext {
  const captured: CapturedContext = {
    handlers: new RequiredMap<string, CallableFunction>(),
    handlerOptions: new Map<string, unknown>(),
    sections: new RequiredArray<TestPromptSection>(),
    guards: [],
    tools: new RequiredArray<TestTool>(),
    logs: [],
  };
  const llm: TestLlm = {
    async resolveCallConfig(config: UnknownRecord) { return { config }; },
    async *stream() { throw new Error("unexpected test LLM stream"); },
    ...extra.llm,
  };
  const context = {
    ...extra,
    llm,
    captured,
    systemPrompt: {
      section(value: PromptSection) {
        if (typeof value.text !== "string") throw new TypeError("test prompt section requires text");
        captured.sections.push(value as TestPromptSection);
      },
    },
    tools: {
      register(value: unknown) {
        if (!isTestTool(value)) throw new TypeError("registered test tool is invalid");
        captured.tools.push(value);
      },
      guard(value: CallableFunction) { captured.guards.push(value); },
      schemas() {
        if (typeof extra.toolSchemas === "function") return extra.toolSchemas(captured);
        return captured.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
      },
    },
    on(event: string, handler: CallableFunction, options?: UnknownRecord) {
      captured.handlers.set(event, handler);
      captured.handlerOptions.set(event, options);
    },
    logger() {
      return {
        info(message: string) { captured.logs.push(message); },
        warn(message: string) { captured.logs.push(message); },
      };
    },
  };
  return context;
}

function userMessage(text: string): DshMessage {
  return {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function nativeToolEvents(
  callId: string,
  command: string,
  output: string,
  options: { callSeq?: number; isError?: boolean; name?: string } = {},
): DshEvent[] {
  const callSeq = options.callSeq ?? 100;
  const isError = options.isError === true;
  return [
    {
      type: "tool/call",
      seq: callSeq,
      data: { turn: 1, step: 1, callId, name: options.name ?? "pwsh", arguments: { command } },
    },
    {
      type: "tool/result",
      seq: callSeq + 1,
      sourceEventSeqs: [callSeq],
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          source: { kind: "tool", callId },
          content: [{
            type: "tool-result",
            toolCallId: callId,
            content: [{ type: "text", text: output }],
            isError,
          }],
        },
        ...(isError ? { error: { code: "COMMAND_FAILED" } } : {}),
      },
    },
  ];
}

function responsibilityGapEvent(
  responsibility: Responsibility,
  overrides: Partial<RuntimeEventData> = {},
): DshEvent {
  const markers: Record<Responsibility, string> = { researcher: "a", planner: "b", reviewer: "c", frontend: "d", user: "e" };
  const marker = markers[responsibility];
  return {
    type: "odai/responsibility-gap",
    data: {
      turn: 1,
      step: 0,
      responsibility,
      gap: `${responsibility} can change the current result.`,
      evidenceRefs: ["current-task", "project-evidence"],
      expectedChange: "Resolve the affected decision or artifact.",
      stateDigest: marker.repeat(64),
      ...overrides,
    },
  };
}

function researchPacketText(overrides: UnknownRecord = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    question: "Which facts determine whether client retries are safe?",
    facts: [
      {
        claim: "The client already retries once.",
        excerpt: "retries=1",
        source: { path: "config/checkout.json", line: 4 },
        authority: "runtime configuration",
      },
      {
        claim: "Duplicate charges were observed after timeouts.",
        excerpt: "duplicate after timeout",
        source: { path: "logs/incidents.md", line: 12 },
        authority: "incident record",
      },
    ],
    conflicts: [],
    unknowns: ["Provider idempotency behavior is not documented."],
    stop: "Configured retry and duplicate-charge evidence is established; provider behavior remains unknown.",
    ...overrides,
  });
}

test("config is strict at governance boundaries", () => {
  assert.throws(() => resolveConfig({ routing: { mode: "magic" } }), /must be off, observe, auto, or execute/u);
  assert.throws(() => resolveConfig({ governance: { additionalDeniedTools: [""] } }), /non-empty strings/u);
  assert.throws(() => resolveConfig({ routing: { roles: { planner: { provider: "openai" } } } }), /planner\.model/u);
  assert.throws(() => resolveConfig({ routing: { roles: { critic: {} } } }), /unknown roles: critic/u);
  assert.throws(() => resolveConfig({ routing: { dispatch: { critic: "child" } } }), /dispatch has unknown roles: critic/u);
  assert.throws(() => resolveConfig({ routing: { configPath: "" } }), /configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ governance: { skillSource: "latest" } }), /skillSource must be bundled, auto, or user/u);
  assert.throws(() => resolveConfig({ governance: { skillConfigPath: "" } }), /skillConfigPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ governance: { evolutionRoot: "" } }), /evolutionRoot must be a non-empty string/u);
  assert.equal(
    resolveConfig({ governance: { skillConfigPath: resolve(testDshHome, "another/source.json") } }).governance.evolutionRoot,
    resolve(testDshHome, "odai/skill-evolution"),
  );
  assert.equal(
    resolveConfig({ governance: { evolutionRoot: resolve(testDshHome, "explicit-evolution") } }).governance.evolutionRoot,
    resolve(testDshHome, "explicit-evolution"),
  );
  assert.throws(() => resolveConfig({ output: { configPath: "" } }), /config\.output\.configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ output: { concise: true } }), /config\.output has unknown fields: concise/u);
  assert.throws(() => resolveConfig({ compaction: { configPath: "" } }), /config\.compaction\.configPath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ compaction: { cacheRetention: "forever" } }), /provider-default, short, long, or none/u);
  assert.throws(() => resolveConfig({ compaction: { maxTokens: 500 } }), /config\.compaction has unknown fields: maxTokens/u);
  assert.throws(() => resolveConfig({ memory: { mode: "magic" } }), /config\.memory\.mode must be auto or off/u);
  assert.throws(() => resolveConfig({ memory: { storePath: "" } }), /config\.memory\.storePath must be a non-empty string/u);
  assert.throws(() => resolveConfig({ memory: { maxRetrieved: 0 } }), /integer from 1 to 12/u);
  assert.throws(() => resolveConfig({ memory: { model: "forbidden" } }), /config\.memory has unknown fields: model/u);

  const defaults = resolveConfig();
  assert.equal(defaults.routing.mode, "auto");
  assert.equal(defaults.routing.roles.researcher, undefined);
  assert.equal(defaults.routing.roles.planner, undefined);
  assert.equal(defaults.routing.roles.reviewer, undefined);
  assert.equal(defaults.routing.roles.frontend, undefined);
  assert.equal(defaults.routing.dispatch.researcher, undefined);
  assert.equal(defaults.routing.dispatch.planner, undefined);
  assert.equal(defaults.routing.dispatch.reviewer, undefined);
  assert.equal(defaults.routing.dispatch.frontend, undefined);
  assert.equal(defaults.routing.configPath, resolve(testDshHome, "odai/routing.json"));
  assert.equal(defaults.governance.skillSource, "bundled");
  assert.equal(defaults.governance.skillConfigPath, resolve(testDshHome, "odai/source.json"));
  assert.equal(defaults.governance.evolutionRoot, resolve(testDshHome, "odai/skill-evolution"));
  assert.equal(defaults.output.configPath, resolve(testDshHome, "odai/output.json"));
  assert.equal(defaults.compaction.configPath, resolve(testDshHome, "odai/compaction.json"));
  assert.equal(defaults.compaction.cacheRetention, "provider-default");
  assert.equal(defaults.memory.mode, "auto");
  assert.equal(defaults.memory.storePath, resolve(testDshHome, "odai/memory/store.json"));
  assert.equal(defaults.memory.maxRetrieved, 6);
  assert.equal(resolveConfig({ compaction: { cacheRetention: "provider-default" } }).compaction.cacheRetention, "provider-default");

  const config = resolveConfig({
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
      dispatch: {
        planner: "child",
      },
    },
  });
  assert.deepEqual(config.routing.roles.planner, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  assert.equal(config.routing.dispatch.planner, "child");
});

test("compaction cache retention honors config over the deployment environment", () => {
  const previous = process.env.ODAI_COMPACTION_CACHE_RETENTION;
  try {
    process.env.ODAI_COMPACTION_CACHE_RETENTION = "short";
    assert.equal(resolveConfig().compaction.cacheRetention, "short");
    assert.equal(resolveConfig({ compaction: { cacheRetention: "none" } }).compaction.cacheRetention, "none");
    process.env.ODAI_COMPACTION_CACHE_RETENTION = "provider-default";
    assert.equal(resolveConfig().compaction.cacheRetention, "provider-default");
    process.env.ODAI_COMPACTION_CACHE_RETENTION = "invalid";
    assert.throws(() => resolveConfig(), /provider-default, short, long, or none/u);
  } finally {
    if (previous === undefined) delete process.env.ODAI_COMPACTION_CACHE_RETENTION;
    else process.env.ODAI_COMPACTION_CACHE_RETENTION = previous;
  }
});

test("compaction inherits routed reasoning and applies configured retention for the exact target", async () => {
  const sessions = {
    get(sessionId: string) {
      if (sessionId !== "session-cache") return undefined;
      return {
        header: {},
        events: [],
        append() {},
        requestHeader() {
          return {
            config: {
              provider: "openai",
              model: "user-selected-model",
              reasoningEffort: "xhigh",
            },
          };
        },
      };
    },
  };
  const eligible: TestRequest = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
  };
  assert.equal(inheritCompactionReasoning(eligible, sessions), true);
  assert.equal(eligible.reasoningEffort, "xhigh");
  assert.equal(eligible.cacheRetention, undefined);

  const providerDefault: TestRequest = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
  };
  assert.equal(inheritCompactionReasoning(providerDefault, sessions, "provider-default"), true);
  assert.equal(providerDefault.reasoningEffort, "xhigh");
  assert.equal(providerDefault.cacheRetention, undefined);

  const explicitRetention: TestRequest = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
    cacheRetention: "short",
  };
  assert.equal(inheritCompactionReasoning(explicitRetention, sessions), true);
  assert.equal(explicitRetention.cacheRetention, "short");

  const preselectedReasoning = { ...eligible, reasoningEffort: "medium" };
  assert.equal(inheritCompactionReasoning(preselectedReasoning, sessions, "long"), true);
  assert.equal(preselectedReasoning.reasoningEffort, "medium");
  assert.equal(preselectedReasoning.cacheRetention, "long");

  for (const configuredRetention of ["provider-default", "short", "long", "none"] as const) {
    const preserved = { ...eligible, reasoningEffort: "medium", cacheRetention: "short" };
    assert.equal(inheritCompactionReasoning(preserved, sessions, configuredRetention), false);
    assert.equal(preserved.reasoningEffort, "medium");
    assert.equal(preserved.cacheRetention, "short");
  }

  const explicit = { ...eligible, reasoningEffort: "medium" };
  assert.equal(inheritCompactionReasoning(explicit, sessions), false);
  assert.equal(explicit.reasoningEffort, "medium");
  assert.equal(inheritCompactionReasoning({ ...eligible, model: "different-model", reasoningEffort: undefined }, sessions), false);
  assert.equal(inheritCompactionReasoning({ ...eligible, purpose: undefined, reasoningEffort: undefined }, sessions), false);
  assert.equal(inheritCompactionReasoning(Object.freeze({ ...eligible, reasoningEffort: undefined }), sessions), false);

  const outputConfigPath = resolve(testDshHome, "compaction-output-policy", "output.json");
  mkdirSync(resolve(testDshHome, "compaction-output-policy"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { concise: true, maxTokens: 2_500 },
  })}\n`, "utf8");
  const ctx = fakeContext({ sessions });
  apply(ctx, { skillPath, routing: { mode: "off" }, output: { configPath: outputConfigPath } });
  const streamed: TestRequest = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
  };
  assert.equal(await ctx.captured.handlers.get("llm/stream")(streamed, async () => "next"), "next");
  assert.equal(streamed.reasoningEffort, "xhigh");
  assert.equal(streamed.cacheRetention, undefined);
  assert.equal(streamed.maxTokens, undefined);

  const independentlyBudgetedCompaction = {
    ...streamed,
    reasoningEffort: undefined,
    maxTokens: 8_192,
  };
  assert.equal(
    await ctx.captured.handlers.get("llm/stream")(independentlyBudgetedCompaction, async () => "next"),
    "next",
  );
  assert.equal(independentlyBudgetedCompaction.reasoningEffort, "xhigh");
  assert.equal(independentlyBudgetedCompaction.cacheRetention, undefined);
  assert.equal(independentlyBudgetedCompaction.maxTokens, 8_192);

  const configuredCtx = fakeContext({ sessions });
  apply(configuredCtx, {
    skillPath,
    routing: { mode: "off" },
    compaction: { cacheRetention: "long" },
  });
  const preRouted: TestRequest = {
    purpose: "compaction",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
    reasoningEffort: "medium",
  };
  assert.equal(await configuredCtx.captured.handlers.get("llm/stream")(preRouted, async () => "next"), "next");
  assert.equal(preRouted.reasoningEffort, "medium");
  assert.equal(preRouted.cacheRetention, "long");

  const configuredButIncoming = { ...preRouted, cacheRetention: "short" };
  assert.equal(
    await configuredCtx.captured.handlers.get("llm/stream")(configuredButIncoming, async () => "next"),
    "next",
  );
  assert.equal(configuredButIncoming.cacheRetention, "short");

  const independentlyBudgetedCheckpoint: TestRequest = {
    purpose: "checkpoint",
    sessionId: "session-cache",
    provider: "openai",
    model: "user-selected-model",
    maxTokens: 8_192,
  };
  assert.equal(
    await ctx.captured.handlers.get("llm/stream")(independentlyBudgetedCheckpoint, async () => "next"),
    "next",
  );
  assert.equal(independentlyBudgetedCheckpoint.reasoningEffort, undefined);
  assert.equal(independentlyBudgetedCheckpoint.cacheRetention, undefined);
  assert.equal(independentlyBudgetedCheckpoint.maxTokens, 8_192);
});

test("managed compaction target overrides only summaries and restores inheritance after removal", async () => {
  const configPath = resolve(testDshHome, "managed-compaction-target", "compaction.json");
  mkdirSync(resolve(testDshHome, "managed-compaction-target"), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    target: { provider: "openai", model: "gpt-5.6-luna" },
  })}\n`, "utf8");
  const sessions = {
    get(sessionId: string) {
      if (sessionId !== "managed-compaction") return undefined;
      return {
        header: {},
        events: [],
        append() {},
        requestHeader() {
          return { config: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" } };
        },
      };
    },
  };
  const ctx = fakeContext({ sessions });
  apply(ctx, {
    skillPath,
    routing: { mode: "off" },
    compaction: { configPath },
  });
  const stream = ctx.captured.handlers.get("llm/stream");
  const summary: TestRequestWithMessages = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    maxTokens: 65_536,
    messages: [{ id: "stock", role: "user", content: [{ type: "text", text: "stock compaction instruction" }] }],
  };
  assert.equal(await stream(summary, async () => "next"), "next");
  assert.equal(summary.provider, "openai");
  assert.equal(summary.model, "gpt-5.6-luna");
  assert.equal(summary.reasoningEffort, undefined);
  assert.equal(summary.maxTokens, 65_536);
  assert.equal(summary.cacheRetention, undefined);
  assert.equal(summary.messages.length, 2);
  assert.deepEqual(last(summary.messages).source, {
    kind: "plugin",
    plugin: "odai-dsh-runtime",
    form: "instructions",
  });
  const summaryProtocol = last(summary.messages).content?.[0]?.text;
  assert.ok(summaryProtocol);
  assert.match(summaryProtocol, /SUPERSEDED.*REJECTED/iu);

  const preTargetedSummary: TestRequestWithMessages = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    messages: [{ id: "pre-targeted-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(preTargetedSummary, async () => "next"), "next");
  assert.equal(preTargetedSummary.reasoningEffort, undefined);
  assert.equal(preTargetedSummary.messages.length, 2);
  assert.equal(last(preTargetedSummary.messages).source?.form, "instructions");
  assert.equal(await stream(preTargetedSummary, async () => "next"), "next");
  assert.equal(preTargetedSummary.messages.length, 2);

  const ordinary = { provider: "openai", model: "gpt-5.6-sol" };
  assert.equal(await stream(ordinary, async () => "next"), "next");
  assert.deepEqual(ordinary, { provider: "openai", model: "gpt-5.6-sol" });

  const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_compaction_config");
  const controller = { session: { header: {}, append() {} } };
  assert.deepEqual((await tool.execute({ action: "show" }, { agent: controller })).target, {
    provider: "openai",
    model: "gpt-5.6-luna",
  });
  await tool.execute({
    action: "set",
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  }, { agent: controller });
  const explicitlyReasoned: TestRequestWithMessages = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    messages: [{ id: "explicit-reasoning-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(explicitlyReasoned, async () => "next"), "next");
  assert.equal(explicitlyReasoned.model, "gpt-5.6-luna");
  assert.equal(explicitlyReasoned.reasoningEffort, "high");
  assert.equal(explicitlyReasoned.messages.length, 2);
  assert.deepEqual((await tool.execute({ action: "show" }, { agent: controller })).target, {
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  });
  await tool.execute({ action: "remove" }, { agent: controller });

  const inherited: TestRequestWithMessages = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    messages: [{ id: "inherit-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(inherited, async () => "next"), "next");
  assert.equal(inherited.model, "gpt-5.6-sol");
  assert.equal(inherited.reasoningEffort, "xhigh");
  assert.equal(inherited.messages.length, 1);

  writeFileSync(configPath, "{broken\n", "utf8");
  const fallback: TestRequestWithMessages = {
    purpose: "compaction",
    sessionId: "managed-compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    messages: [{ id: "fallback-stock", role: "user", content: [] }],
  };
  assert.equal(await stream(fallback, async () => "next"), "next");
  assert.equal(fallback.model, "gpt-5.6-sol");
  assert.equal(fallback.reasoningEffort, "xhigh");
  assert.equal(fallback.messages.length, 1);
  assert.equal(ctx.captured.logs.some((message: string) => /compaction model configuration is invalid/iu.test(message)), true);
});

test("configured compaction discards partial failure output and retries once on the inherited route", async () => {
  const configPath = resolve(testDshHome, "compaction-runtime-fallback", "compaction.json");
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    target: { provider: "openai", model: "summary-model", reasoningEffort: "high" },
  })}\n`, "utf8");
  const fallbackCalls: UnknownRecord[] = [];
  const llm: TestLlm = {
    async resolveCallConfig(config: UnknownRecord) { return { config }; },
    stream(options: UnknownRecord) {
      fallbackCalls.push({ ...options });
      return (async function* fallbackStream() {
        yield { type: "text", text: "complete inherited summary" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
  const ctx = fakeContext({ llm });
  apply(ctx, { skillPath, compaction: { configPath } });
  const options: TestRequestWithMessages = {
    purpose: "compaction",
    provider: "openai",
    model: "controller-model",
    reasoningEffort: "max",
    messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
  };
  const configuredSeen: UnknownRecord[] = [];
  const stream = ctx.captured.handlers.get("llm/stream")(options, () => (async function* targetStream() {
    configuredSeen.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort });
    yield { type: "text", text: "partial target output that must be discarded" };
    yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "busy" } } };
  })());
  const chunks: UnknownRecord[] = [];
  for await (const chunk of stream) chunks.push(chunk);

  assert.deepEqual(configuredSeen, [{ provider: "openai", model: "summary-model", reasoningEffort: "high" }]);
  assert.deepEqual(chunks.map((chunk) => chunk.text).filter(Boolean), ["complete inherited summary"]);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].model, "controller-model");
  assert.equal(fallbackCalls[0].reasoningEffort, "max");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).target, {
    provider: "openai",
    model: "summary-model",
    reasoningEffort: "high",
  });
});

test("deterministic compaction route failure backs up and removes only the matching target", async () => {
  const configPath = resolve(testDshHome, "compaction-runtime-invalid", "compaction.json");
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    target: { provider: "openai", model: "removed-summary-model" },
  })}\n`, "utf8");
  const llm: Partial<TestLlm> = {
    async resolveCallConfig(config: UnknownRecord) {
      if (config.model === "removed-summary-model") {
        const error: NodeJS.ErrnoException = new Error("unknown model removed-summary-model");
        error.code = "UNKNOWN_MODEL";
        throw error;
      }
      return { config };
    },
  };
  const ctx = fakeContext({ llm });
  apply(ctx, { skillPath, compaction: { configPath } });
  const options: TestRequestWithMessages = {
    purpose: "compaction",
    provider: "openai",
    model: "controller-model",
    messages: [{ role: "user", content: [{ type: "text", text: "history" }] }],
  };
  const stream = ctx.captured.handlers.get("llm/stream")(options, () => (async function* inheritedStream() {
    yield { type: "text", text: "inherited summary" };
    yield { type: "finish", reason: { kind: "stop" } };
  })());
  const chunks: UnknownRecord[] = [];
  for await (const chunk of stream) chunks.push(chunk);

  assert.deepEqual(chunks.map((chunk) => chunk.text).filter(Boolean), ["inherited summary"]);
  const entries = readdirSync(resolve(configPath, ".."));
  assert.equal(entries.includes("compaction.json"), false);
  assert.equal(entries.some((entry) => entry.startsWith("compaction.json.invalidated-")), true);
});

test("routing off ignores stale protection evidence while memory remains available", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const agent = {
    session: {
      header: {},
      events: [
        { type: "odai/route-decided", data: { turn: 1, step: 1 } },
        { type: "odai/route-protection", data: { turn: 1, step: 1, mode: "read-only" } },
      ],
    },
  };

  assert.equal(ctx.captured.handlers.has("agent/pre-step"), true);
  const result = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("普通请求")] }),
  );
  assert.equal(result.messages.length, 1);
  assert.equal(ctx.captured.guards[0]({ callId: "write-off", agent, name: "write" }), undefined);
});

test("semantic memory captures and retrieves across sessions without hidden model calls", async () => {
  const memoryStorePath = resolve(testDshHome, "memory-integration", "store.json");
  const routingConfigPath = resolve(testDshHome, "memory-integration", "routing.json");
  const projectRoot = resolve(testDshHome, "memory-integration", "project");
  mkdirSync(projectRoot, { recursive: true });
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() {
        starts += 1;
        throw new Error("memory must not start a child");
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: { mode: "off", configPath: routingConfigPath },
    memory: { storePath: memoryStorePath },
  });
  const handler = ctx.captured.handlers.get("agent/pre-step");
  const firstMessage = userMessage("这个项目以后统一使用 pnpm。");
  const firstEvents: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: firstMessage },
  ];
  const firstAgent = {
    session: {
      header: { id: "memory-first", cwd: projectRoot },
      events: firstEvents,
      append(type: string, data: RuntimeEventData) { firstEvents.push({ type, data }); },
    },
  };
  const first = await handler(
    { agent: firstAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [firstMessage] }),
  );
  assert.equal(first.messages.length, 1);
  assert.equal(readMemoryStore(memoryStorePath).entries[0].status, "active");

  const secondMessage = userMessage("请按照 pnpm 约束更新依赖脚本。");
  const secondEvents: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: secondMessage },
  ];
  const secondAgent = {
    session: {
      header: { id: "memory-second", cwd: projectRoot },
      events: secondEvents,
      append(type: string, data: RuntimeEventData) { secondEvents.push({ type, data }); },
    },
  };
  const second = await handler(
    { agent: secondAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [secondMessage] }),
  );
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[1].source.form, "semantic-memory");
  assert.match(second.messages[1].content[0].text, /untrusted historical user context/u);
  assert.equal(starts, 0);
  const memoryTool = ctx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_memory");
  const inspected = await memoryTool.execute({ action: "inspect" }, { agent: secondAgent });
  assert.equal(inspected.entries.length, 1);
  assert.equal(inspected.entries[0].subject, "package-manager");

  const childMessage = userMessage("请按照 pnpm 约束更新依赖脚本。");
  const childAgent = {
    session: {
      header: { id: "memory-child", cwd: projectRoot, origin: "subagent", delegationDepth: 1 },
      events: [{ type: "user/message", seq: 1, data: childMessage }],
    },
  };
  const child = await handler(
    { agent: childAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [childMessage] }),
  );
  assert.equal(child.messages.length, 1);
});

test("invalid semantic memory fails closed without rewriting the store", async () => {
  const root = resolve(testDshHome, "memory-invalid-runtime");
  const memoryStorePath = resolve(root, "memory", "store.json");
  mkdirSync(resolve(memoryStorePath, ".."), { recursive: true });
  writeFileSync(memoryStorePath, "{broken\n", "utf8");
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: { mode: "off", configPath: resolve(root, "routing.json") },
    memory: { storePath: memoryStorePath },
  });
  const message = userMessage("这个项目以后统一使用 pnpm。");
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: message },
  ];
  const agent = {
    session: {
      header: { id: "memory-invalid-runtime", cwd: root },
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [message] }),
  );
  assert.equal(result.messages.length, 1);
  assert.equal(readFileSync(memoryStorePath, "utf8"), "{broken\n");
  assert.equal(ctx.captured.logs.some((line) => /semantic memory is unavailable/u.test(line)), true);
  const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_memory");
  const shown = await tool.execute({ action: "inspect" }, { agent });
  assert.equal(shown.reasonCode, "memory-store-invalid");
});

test("profile and preset runtimes single-flight automatic memory capture", async () => {
  const memoryStorePath = resolve(testDshHome, "memory-dual-runtime", "store.json");
  const routingConfigPath = resolve(testDshHome, "memory-dual-runtime", "routing.json");
  const projectRoot = resolve(testDshHome, "memory-dual-runtime", "project");
  mkdirSync(projectRoot, { recursive: true });
  const globalCtx = fakeContext();
  const presetCtx = fakeContext();
  const config = {
    skillPath,
    routing: { mode: "off", configPath: routingConfigPath },
    memory: { storePath: memoryStorePath },
  };
  apply(globalCtx, config);
  apply(presetCtx, config);
  const message = userMessage("这个项目以后统一使用 pnpm。");
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: message },
  ];
  const agent = {
    session: {
      header: { id: "memory-dual", cwd: projectRoot },
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const input = { agent, turn: 1, step: 1, signal: new AbortController().signal };
  await globalCtx.captured.handlers.get("agent/pre-step")(input, async () => (
    presetCtx.captured.handlers.get("agent/pre-step")(input, async () => ({ kind: "enter", messages: [message] }))
  ));
  const store = readMemoryStore(memoryStorePath);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].occurrences, 1);
});

test("default auto routing keeps ordinary tasks on the current controller", async () => {
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() {
        starts += 1;
        throw new Error("ordinary task must not start a child");
      },
    },
  });
  apply(ctx, { skillPath });

  const events: DshEvent[] = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请把 README 中“请独立规划一下架构选型”这句话改短")],
  }));

  assert.equal(starts, 0);
  assert.equal(result.messages.length, 1);
  assert.equal(events[0].data.role, "controller");
  assert.equal(events[0].data.mode, "auto");
  assert.equal(events[0].data.action, "direct");
});

test("real sessions persist routing evidence outside the DSH event log", async () => {
  const configPath = resolve(testDshHome, "real-session-evidence", "routing.json");
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { configPath } });
  let sessionAppends = 0;
  const agent = {
    session: {
      header: { id: "real-session-evidence" },
      events: [],
      append() { sessionAppends += 1; },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("把普通按钮文案改得更清楚")],
  }));

  assert.equal(sessionAppends, 0);
  const events = readStoredSessionEvidence(resolveSessionEvidenceRoot(configPath), "real-session-evidence");
  assert.deepEqual(events.map((event) => event.type), ["odai/route-decided"]);
});

test("only explicit Odai responsibility labels route manual children", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      mode: "observe",
      configPath: resolve(testDshHome, "manual-child-routing", "routing.json"),
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
    },
  });

  const handler = ctx.captured.handlers.get("agent/request");
  const inherited = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" };
  const controller = { session: { events: [] } };
  assert.deepEqual(await handler({ agent: controller }, async () => inherited), inherited);

  let plannerHeader: { config: UnknownRecord } | undefined;
  const plannerEvents: DshEvent[] = [{ type: "subagent/descriptor", data: { label: "odai-planner architecture check" } }];
  const planner = {
    session: {
      events: plannerEvents,
      requestHeader() { return plannerHeader; },
      append(type: string, data: RuntimeEventData) { this.events.push({ type, data }); },
    },
  };
  const plannerRequest = await handler({ agent: planner, turn: 1, step: 1 }, async () => inherited);
  assert.deepEqual(plannerRequest, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  plannerHeader = { config: plannerRequest };
  ctx.captured.handlers.get("session/event")(planner.session, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1 },
  });
  const childReceipt = findEvent(planner.session.events, (event) => event.type === "odai/route-applied").data;
  assert.equal(childReceipt.status, "applied");
  assert.equal(childReceipt.routeMode, "child");
  assert.equal(childReceipt.routeSource, "deployment-config");
  assert.deepEqual(childReceipt.actualRoute, plannerRequest);
  await ctx.captured.handlers.get("agent/turn-stopping")({ agent: planner, turn: 1 });

  const mismatchedEvents: DshEvent[] = [{ type: "subagent/descriptor", data: { label: "odai-planner second opinion" } }];
  const mismatchedHeader = { config: inherited };
  const mismatchedPlanner = {
    session: {
      events: mismatchedEvents,
      requestHeader() { return mismatchedHeader; },
      append(type: string, data: RuntimeEventData) { mismatchedEvents.push({ type, data }); },
    },
  };
  await handler({ agent: mismatchedPlanner, turn: 1, step: 1 }, async () => inherited);
  ctx.captured.handlers.get("session/event")(mismatchedPlanner.session, {
    type: "request/header",
    data: { turn: 1, step: 1, header: mismatchedHeader },
  });
  assert.throws(
    () => ctx.captured.handlers.get("agent/turn-stopping")({ agent: mismatchedPlanner, turn: 1 }),
    /planner child route was not verified: child model mismatch/u,
  );

  const generic = {
    session: {
      events: [{ type: "subagent/descriptor", data: { label: "审查界面改版代码" } }],
    },
  };
  assert.deepEqual(await handler({ agent: generic }, async () => inherited), inherited);

  const missingReviewer = {
    session: {
      events: [{ type: "subagent/descriptor", data: { label: "odai-reviewer acceptance check" } }],
    },
  };
  await assert.rejects(
    handler({ agent: missingReviewer }, async () => inherited),
    /reviewer child route is not configured/u,
  );
});

test("effective routing mappings are merged, visible after compaction, and stable for one turn", async () => {
  const configPath = resolve(testDshHome, "effective-routing-snapshot", "routing.json");
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      configPath,
      roles: {
        planner: { provider: "deployment", model: "planner-default", reasoningEffort: "high" },
        frontend: { provider: "deployment", model: "frontend-default", reasoningEffort: "max" },
      },
    },
  });
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage("请显示当前所有职责模型映射") },
  ];
  const agent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_routing_config");
  await tool.execute({
    action: "set",
    responsibility: "planner",
    provider: "persisted",
    model: "planner-user",
    reasoningEffort: "xhigh",
  }, { agent });
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const context = { agent, signal: new AbortController().signal };
  const downstream = async () => ({ sections: ctx.captured.sections });
  const first = await assemble({}, context, downstream);
  const firstRouting = first.sections.find((section: TestPromptSection) => section.name === "odai:routing-configuration").text;
  assert.match(firstRouting, /planner=persisted\/planner-user \(reasoningEffort=xhigh\) \[persisted-mapping\]/u);
  assert.match(firstRouting, /frontend=deployment\/frontend-default \(reasoningEffort=max\) \[deployment-config\]/u);

  await tool.execute({
    action: "set",
    responsibility: "frontend",
    provider: "persisted",
    model: "frontend-user",
  }, { agent });
  const sameTurn = await assemble({}, context, downstream);
  assert.match(
    sameTurn.sections.find((section: TestPromptSection) => section.name === "odai:routing-configuration").text,
    /frontend=deployment\/frontend-default/u,
  );

  events.push({
    type: "compaction/summary",
    data: { text: "A stale summary mentions only the planner mapping." },
  });
  agent.phase.turn = 2;
  const afterCompaction = await assemble({}, context, downstream);
  const nextRouting = afterCompaction.sections.find((section: TestPromptSection) => section.name === "odai:routing-configuration").text;
  assert.match(nextRouting, /frontend=persisted\/frontend-user \[persisted-mapping\]/u);
  const shown = await tool.execute({ action: "show" }, { agent });
  assert.deepEqual(shown.sources, { planner: "persisted-mapping", frontend: "persisted-mapping" });
  const removed = await tool.execute({ action: "remove", responsibility: "planner" }, { agent });
  assert.deepEqual(removed.roles.planner, {
    provider: "deployment",
    model: "planner-default",
    reasoningEffort: "high",
  });
  assert.equal(removed.sources.planner, "deployment-config");
});

test("controller output policy is default-concise, turn-stable, request-bounded, and isolated from children", async () => {
  const configPath = resolve(testDshHome, "output-policy", "output.json");
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" }, output: { configPath } });

  const events: DshEvent[] = [];
  const agent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const request = ctx.captured.handlers.get("agent/request");
  const outputTool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_output_config");
  const context = { agent, signal: new AbortController().signal };
  const downstream = async () => ({ sections: ctx.captured.sections });

  const initial = await assemble({}, context, downstream);
  assert.match(
    initial.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text,
    /Keep the final user-facing response concise/u,
  );
  assert.deepEqual((await outputTool.execute({ action: "show" }, { agent })).policy, { concise: true });
  const normal = await outputTool.execute({ action: "set", mode: "normal" }, { agent });
  assert.deepEqual(normal.policy, { concise: false });
  assert.equal(normal.requiresNextTurn, true);
  assert.deepEqual(
    await request({ agent, turn: 1, step: 2 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller" },
  );

  agent.phase.turn = 2;
  const normalSelected = await assemble({}, context, downstream);
  assert.equal(
    normalSelected.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text,
    "",
  );
  const configured = await outputTool.execute({
    action: "set",
    mode: "economy",
    maxTokens: 2_500,
  }, { agent });
  assert.deepEqual(configured.policy, { concise: true, maxTokens: 2_500 });
  assert.equal(configured.requiresNextTurn, true);
  assert.deepEqual(
    await request({ agent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller" },
  );

  agent.phase.turn = 3;
  const selected = await assemble({}, context, downstream);
  const policyText = selected.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text;
  assert.match(policyText, /Keep the final user-facing response concise/u);
  assert.match(policyText, /provider output ceiling request of 2500 tokens/u);
  assert.match(policyText, /never reduces child-agent, compaction, checkpoint/u);
  assert.deepEqual(
    await request({ agent, turn: 3, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 2_500 },
  );
  assert.deepEqual(
    await request({ agent, turn: 3, step: 2 }, async () => ({ provider: "base", model: "controller", maxTokens: 1_000 })),
    { provider: "base", model: "controller", maxTokens: 1_000 },
  );
  assert.deepEqual(findEvent(events, (event) => event.type === "odai/output-budget-applied").data, {
    turn: 3,
    step: 1,
    configuredMaxTokens: 2_500,
    priorMaxTokens: 8_000,
    effectiveMaxTokens: 2_500,
    budgetSource: "controller-policy",
    semantics: "provider-request-ceiling",
  });
  assert.equal(
    findEvent(events, (event) => event.type === "odai/output-budget-applied" && event.data.step === 2).data.budgetSource,
    "preexisting-request-ceiling",
  );

  const child = {
    phase: { turn: 1 },
    session: { header: { origin: "subagent", delegationDepth: 1 }, events: [] },
  };
  const childResult = await request(
    { agent: child, turn: 1, step: 1 },
    async () => ({ provider: "child", model: "worker", maxTokens: 4_000 }),
  );
  assert.deepEqual(childResult, { provider: "child", model: "worker", maxTokens: 4_000 });
  assert.throws(
    () => outputTool.execute({ action: "set", concise: true }, { agent: child }),
    /child agents may not change/u,
  );

  const removed = await outputTool.execute({ action: "remove" }, { agent });
  assert.deepEqual(removed.policy, { concise: true });
  agent.phase.turn = 4;
  const reset = await assemble({}, context, downstream);
  assert.match(
    reset.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text,
    /Keep the final user-facing response concise/u,
  );
  assert.deepEqual(
    await request({ agent, turn: 4, step: 1 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller" },
  );
});

test("session-scoped output ceiling directives apply before generation without changing shared economy", async () => {
  const configPath = resolve(testDshHome, "session-output-ceiling", "output.json");
  mkdirSync(resolve(testDshHome, "session-output-ceiling"), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1, policy: { concise: true, maxTokens: 500 } })}\n`, "utf8");
  const originalStore = readFileSync(configPath, "utf8");
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" }, output: { configPath } });
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const request = ctx.captured.handlers.get("agent/request");
  const events: DshEvent[] = [];
  const restrictions = new RequiredArray<TestRestriction>();
  const agent = {
    phase: { turn: 1 },
    ctx: { tools: { restrict(filter: TestRestriction) { restrictions.push(filter); return () => {}; } } },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const context = { agent, signal: new AbortController().signal };
  const downstream = async () => ({ sections: ctx.captured.sections });
  let hostSeq = 0;
  const addUser = (turn: number, id: string, text: string) => {
    events.push({ type: "turn/start", seq: hostSeq += 1, data: { turn } });
    events.push({
      type: "user/message",
      seq: hostSeq += 1,
      data: { ...userMessage(text), id },
    });
  };

  addUser(1, "uncap-1", "这个会话放开上限");
  const uncapped = await assemble({}, context, downstream);
  const uncappedPrompt = uncapped.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text;
  assert.match(uncappedPrompt, /session-scoped controller output ceiling is disabled/iu);
  assert.doesNotMatch(uncappedPrompt, /ceiling request of 500 tokens/iu);
  assert.ok(last(restrictions).deny.includes("odai_output_config"));
  assert.deepEqual(
    await request({ agent, turn: 1, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 8_000 },
  );
  assert.equal(readFileSync(configPath, "utf8"), originalStore);
  const child = {
    phase: { turn: 1 },
    session: { header: { origin: "subagent", delegationDepth: 1 }, events: [] },
  };
  assert.deepEqual(
    await request({ agent: child, turn: 1, step: 1 }, async () => ({ provider: "child", model: "worker", maxTokens: 4_000 })),
    { provider: "child", model: "worker", maxTokens: 4_000 },
  );
  await assemble({}, context, downstream);
  assert.equal(events.filter((event) => event.type === "odai/output-session-ceiling-configured").length, 1);
  assert.deepEqual(findEvent(events, (event) => event.type === "odai/output-session-ceiling-configured").data, {
    turn: 1,
    step: 1,
    action: "uncap",
    userMessageId: "uncap-1",
    authorizationSource: "authenticated-direct-user-message",
    scope: "session",
  });

  agent.phase.turn = 2;
  addUser(2, "ordinary-2", "现在回答刚才的问题");
  const stillUncapped = await assemble({}, context, downstream);
  assert.match(
    stillUncapped.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text,
    /session-scoped controller output ceiling is disabled/iu,
  );
  assert.deepEqual(
    await request({ agent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller" },
  );

  agent.phase.turn = 3;
  addUser(3, "restore-3", "这个会话恢复输出上限");
  const restored = await assemble({}, context, downstream);
  assert.match(
    restored.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text,
    /ceiling request of 500 tokens/iu,
  );
  assert.ok(last(restrictions).deny.includes("odai_output_config"));
  assert.deepEqual(
    await request({ agent, turn: 3, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 500 },
  );
  assert.equal(readFileSync(configPath, "utf8"), originalStore);

  const questionEvents: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 2,
      data: { ...userMessage("这个会话能不能放开上限？"), id: "question-1" },
    },
  ];
  const questionRestrictions = new RequiredArray<TestRestriction>();
  const questionAgent = {
    phase: { turn: 1 },
    ctx: { tools: { restrict(filter: TestRestriction) { questionRestrictions.push(filter); return () => {}; } } },
    session: {
      header: {},
      events: questionEvents,
      append(type: string, data: RuntimeEventData) { questionEvents.push({ type, data }); },
    },
  };
  await assemble({}, { agent: questionAgent, signal: context.signal }, downstream);
  assert.equal(last(questionRestrictions).deny.includes("odai_output_config"), false);
  assert.equal(questionEvents.some((event) => event.type === "odai/output-session-ceiling-configured"), false);
  assert.deepEqual(
    await request({ agent: questionAgent, turn: 1, step: 1 }, async () => ({ provider: "base", model: "controller" })),
    { provider: "base", model: "controller", maxTokens: 500 },
  );
});

test("a verified controller max-token interruption grants one uncapped pure-continuation recovery turn", async () => {
  const configPath = resolve(testDshHome, "controller-output-recovery", "output.json");
  mkdirSync(resolve(testDshHome, "controller-output-recovery"), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1, policy: { concise: true, maxTokens: 500 } })}\n`, "utf8");
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" }, output: { configPath } });
  const request = ctx.captured.handlers.get("agent/request");
  const observe = ctx.captured.handlers.get("session/event");
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const downstream = async () => ({ sections: ctx.captured.sections });
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { ...userMessage("请给我一个很短的回答"), id: "task-1" } },
  ];
  const agent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  assert.deepEqual(
    await request({ agent, turn: 1, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 500 },
  );
  observe(agent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 1, usage: { outputTokens: 500 } },
  });
  observe(agent.session, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "max-tokens" } },
  });
  assert.deepEqual(findEvent(events, (event) => event.type === "odai/controller-output-interrupted").data, {
    turn: 1,
    step: 1,
    reason: "max-tokens",
    configuredMaxTokens: 500,
    effectiveMaxTokens: 500,
    outputTokens: 500,
    budgetSource: "controller-policy",
    scope: "turn",
  });

  agent.phase.turn = 2;
  events.push({ type: "turn/start", seq: 10, data: { turn: 2 } });
  events.push({ type: "user/message", seq: 11, data: { ...userMessage("继续"), id: "continue-2" } });
  const recoveryPrompt = await assemble({}, { agent, signal: new AbortController().signal }, downstream);
  assert.match(
    recoveryPrompt.sections.find((section: TestPromptSection) => section.name === "odai:controller-output-policy").text,
    /one-turn output recovery is active/iu,
  );
  assert.deepEqual(
    await request({ agent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 8_000 },
  );
  assert.deepEqual(
    await request({ agent, turn: 2, step: 2 }, async () => ({ provider: "base", model: "controller", maxTokens: 300 })),
    { provider: "base", model: "controller", maxTokens: 300 },
  );
  assert.equal(events.filter((event) => event.type === "odai/controller-output-recovery").length, 1);

  agent.phase.turn = 3;
  events.push({ type: "turn/start", seq: 20, data: { turn: 3 } });
  events.push({ type: "user/message", seq: 21, data: { ...userMessage("继续"), id: "continue-3" } });
  assert.deepEqual(
    await request({ agent, turn: 3, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 500 },
  );

  const hostEvents: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { ...userMessage("执行一个受 host 限制的短答"), id: "host-task-1" } },
  ];
  const hostAgent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events: hostEvents,
      append(type: string, data: RuntimeEventData) { hostEvents.push({ type, data }); },
    },
  };
  assert.deepEqual(
    await request({ agent: hostAgent, turn: 1, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 500 },
  );
  assert.deepEqual(
    await request({ agent: hostAgent, turn: 1, step: 2 }, async () => ({ provider: "base", model: "controller", maxTokens: 300 })),
    { provider: "base", model: "controller", maxTokens: 300 },
  );
  observe(hostAgent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 2, usage: { outputTokens: 300 } },
  });
  observe(hostAgent.session, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "max-tokens" } },
  });
  assert.equal(hostEvents.some((event) => event.type === "odai/controller-output-interrupted"), false);
  hostAgent.phase.turn = 2;
  hostEvents.push({ type: "turn/start", seq: 10, data: { turn: 2 } });
  hostEvents.push({ type: "user/message", seq: 11, data: { ...userMessage("继续"), id: "host-continue-2" } });
  assert.deepEqual(
    await request({ agent: hostAgent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 500 },
  );

  const resumedControllerEvents: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { ...userMessage("职责返回后由 Controller 回答"), id: "resumed-task-1" } },
    {
      type: "odai/responsibility-scope-stopped",
      data: { scopeId: "stopped-planner-1", turn: 1, startStep: 1, stopStep: 1, responsibility: "planner", reason: "returned" },
    },
  ];
  const resumedControllerAgent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events: resumedControllerEvents,
      append(type: string, data: RuntimeEventData) { resumedControllerEvents.push({ type, data }); },
    },
  };
  assert.deepEqual(
    await request({ agent: resumedControllerAgent, turn: 1, step: 2 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 500 },
  );
  observe(resumedControllerAgent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 2, usage: { outputTokens: 500 } },
  });
  observe(resumedControllerAgent.session, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "max-tokens" } },
  });
  assert.equal(
    resumedControllerEvents.some((event) => event.type === "odai/controller-output-interrupted" && event.data?.step === 2),
    true,
  );
  resumedControllerAgent.phase.turn = 2;
  resumedControllerEvents.push({ type: "turn/start", seq: 10, data: { turn: 2 } });
  resumedControllerEvents.push({ type: "user/message", seq: 11, data: { ...userMessage("继续"), id: "resumed-continue-2" } });
  assert.deepEqual(
    await request({ agent: resumedControllerAgent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller", maxTokens: 8_000 })),
    { provider: "base", model: "controller", maxTokens: 8_000 },
  );
});

test("host evolution bypass disables selection and mutations", async () => {
  const previous = process.env.ODAI_DISABLE_EVOLUTION;
  process.env.ODAI_DISABLE_EVOLUTION = "1";
  try {
    const ctx = fakeContext();
    apply(ctx, {
      governance: { evolutionRoot: resolve(testDshHome, "disabled-evolution") },
      routing: { mode: "off" },
    });
    const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_skill_evolution");
    const agent = { session: { header: {}, events: [] } };
    assert.equal((await tool.execute({ action: "show" }, { agent })).status, "disabled");
    assert.throws(
      () => tool.execute({ action: "validate", generationId: "0".repeat(64) }, { agent }),
      /disabled by ODAI_DISABLE_EVOLUTION/u,
    );
  } finally {
    if (previous === undefined) delete process.env.ODAI_DISABLE_EVOLUTION;
    else process.env.ODAI_DISABLE_EVOLUTION = previous;
  }
});

test("skill evolution activation preserves the current turn and changes the next prompt snapshot", async () => {
  const root = resolve(testDshHome, "evolution-integration", "skill-evolution");
  const ctx = fakeContext();
  apply(ctx, {
    governance: {
      skillConfigPath: resolve(testDshHome, "evolution-integration", "source.json"),
      evolutionRoot: root,
    },
    routing: { mode: "off", configPath: resolve(testDshHome, "evolution-integration", "routing.json") },
    output: { configPath: resolve(testDshHome, "evolution-integration", "output.json") },
    compaction: { configPath: resolve(testDshHome, "evolution-integration", "compaction.json") },
  });
  const events: DshEvent[] = [];
  const agent = {
    phase: { turn: 1 },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, seq: events.length, time: 1_777_000_000_000 + events.length, data });
      },
    },
  };
  agent.session.append("turn/start", { turn: 1 });
  agent.session.append("user/message", userMessage("Prepare a bounded Odai evolution proposal"));
  const context = { agent, signal: new AbortController().signal };
  const downstream = async () => ({ sections: ctx.captured.sections });
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_skill_evolution");
  const initial = await assemble({}, context, downstream);
  const initialPrompt = initial.sections.find((section: TestPromptSection) => section.name === "odai:canonical-governance").text;
  assert.doesNotMatch(initialPrompt, /EVOLUTION_NEXT_TURN/u);
  const shown = await tool.execute({ action: "show" }, { agent });
  const inspected = await tool.execute({ action: "inspect", path: "SKILL.md" }, { agent });
  const oldString = "`odai` 是面向用户的统一入口和最终交付者，按真实缺口补判断、工艺、验证与外力。";
  const proposalArgs = {
    action: "propose",
    objective: "Prove next-turn evolution selection",
    expectedBundleDigest: shown.upstream.digest,
    changes: [{
      path: "SKILL.md",
      expectedSha256: inspected.sha256,
      replacements: [{ oldString, newString: `${oldString}\n\nEVOLUTION_NEXT_TURN` }],
    }],
  };
  const prepared = await tool.execute(proposalArgs, { agent });
  assert.equal(prepared.status, "authorization-required");
  agent.session.append("turn/end", { turn: 1, reason: "success" });
  agent.phase.turn = 2;
  agent.session.append("turn/start", { turn: 2 });
  agent.session.append("user/message", userMessage(prepared.proposalPhrase));
  const proposed = await tool.execute(proposalArgs, { agent });
  assert.equal(proposed.generation.authorizationLevel, "breaking");
  agent.session.append("turn/end", { turn: 2, reason: "success" });
  agent.phase.turn = 3;
  agent.session.append("turn/start", { turn: 3 });
  agent.session.append("user/message", userMessage(proposed.generation.activationPhrase));
  const activationTurn = await assemble({}, context, downstream);
  assert.doesNotMatch(
    activationTurn.sections.find((section: TestPromptSection) => section.name === "odai:canonical-governance").text,
    /EVOLUTION_NEXT_TURN/u,
  );
  await tool.execute({
    action: "activate",
    generationId: proposed.generation.generationId,
    expectedUpstreamDigest: shown.upstream.digest,
  }, { agent });

  const sameTurn = await assemble({}, context, downstream);
  assert.doesNotMatch(
    sameTurn.sections.find((section: TestPromptSection) => section.name === "odai:canonical-governance").text,
    /EVOLUTION_NEXT_TURN/u,
  );
  agent.session.append("turn/end", { turn: 3, reason: "success" });
  agent.phase.turn = 4;
  agent.session.append("turn/start", { turn: 4 });
  agent.session.append("user/message", userMessage("Continue after the authorized activation"));
  const nextTurn = await assemble({}, context, downstream);
  const evolvedPrompt = nextTurn.sections.find((section: TestPromptSection) => section.name === "odai:canonical-governance").text;
  assert.match(evolvedPrompt, /Canonical source: evolution/u);
  assert.match(evolvedPrompt, /User evolution: generation [a-f0-9]{64}/u);
  assert.match(evolvedPrompt, /rebase required: false/u);
  assert.match(evolvedPrompt, /EVOLUTION_NEXT_TURN/u);
});

test("adaptive tool exposure reconciles prebuilt prompt schemas with the scoped execution registry", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const restrictions = new RequiredArray<TestRestriction>();
  let disposed = 0;
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage("把按钮文案改清楚") },
  ];
  const agent = {
    ctx: {
      tools: {
        restrict(filter: TestRestriction) {
          restrictions.push(filter);
          return () => { disposed += 1; };
        },
      },
    },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const signal = new AbortController().signal;
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  let firstRestrictionAtSnapshot: TestRestriction | undefined;
  await assemble({}, { agent, signal }, async () => {
    firstRestrictionAtSnapshot = last(restrictions);
    return { sections: ctx.captured.sections };
  });
  assert.ok(firstRestrictionAtSnapshot);
  assert.equal(firstRestrictionAtSnapshot, restrictions[0]);
  assert.ok(restrictions[0].deny.includes("odai_human_care"));
  assert.ok(restrictions[0].deny.includes("odai_routing_config"));
  assert.ok(restrictions[0].deny.includes("odai_memory"));
  assert.equal(restrictions[0].deny.includes("odai_responsibility_gap"), false);

  const careMessage = { ...userMessage("你能启动欧黛模式吗？"), id: "user-2" };
  events.push(
    { type: "turn/start", seq: events.length + 1, data: { turn: 2 } },
    { type: "user/message", seq: events.length + 2, data: careMessage },
  );
  let careRestrictionAtSnapshot: TestRestriction | undefined;
  await assemble({}, { agent, signal }, async () => {
    careRestrictionAtSnapshot = last(restrictions);
    return { sections: ctx.captured.sections };
  });
  assert.equal(disposed, 1);
  assert.equal(careRestrictionAtSnapshot, restrictions[1]);
  assert.equal(restrictions[1].deny.includes("odai_human_care"), false);
  assert.ok(restrictions[1].deny.includes("odai_human_safety"));
  const selected = events.filter((event) => event.type === "odai/tool-exposure-selected");
  assert.deepEqual(last(selected).data.activeTools, ["odai_context_capability", "odai_responsibility_gap", "odai_reference", "odai_human_care"]);
});

test("cold first steps expose only executable core tools before gateway activation", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const restrictions = new RequiredArray<TestRestriction>();
  const events: DshEvent[] = [{ type: "turn/start", seq: 1, data: { turn: 1 } }];
  const agent = {
    ctx: { tools: { restrict(filter: TestRestriction) { restrictions.push(filter); return () => {}; } } },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const signal = new AbortController().signal;
  const assemble = ctx.captured.handlers.get("system-prompt/assemble");
  let coldRestrictionAtSnapshot: TestRestriction | undefined;
  const coldAssembly = { sections: ctx.captured.sections, tools: ctx.captured.tools.map(({ name }: { name: string }) => ({ name })) };
  const coldResult = await assemble(coldAssembly, { agent, signal }, async () => {
    coldRestrictionAtSnapshot = last(restrictions);
    return { sections: ctx.captured.sections, tools: ctx.captured.tools.map(({ name }: { name: string }) => ({ name })) };
  });
  assert.ok(coldRestrictionAtSnapshot);
  assert.equal(coldRestrictionAtSnapshot, restrictions[0]);
  assert.ok(coldRestrictionAtSnapshot.deny.includes("odai_human_care"));
  assert.equal(coldRestrictionAtSnapshot.deny.includes("odai_context_capability"), false);
  assert.deepEqual(
    [...coldResult.tools.map((tool: TestToolSchema) => tool.name).filter((name: string) => name.startsWith("odai_")).sort()],
    ["odai_context_capability", "odai_reference", "odai_responsibility_gap"],
  );

  agent.session.append("user/message", userMessage("你能启动欧黛模式吗？"));
  agent.session.append("step/start", { turn: 1, step: 1 });
  const gateway = ctx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_context_capability");
  await gateway.execute({ capability: "human-care" }, { agent });
  let activatedRestrictionAtSnapshot: TestRestriction | undefined;
  const activatedAssembly = { sections: ctx.captured.sections, tools: coldResult.tools.map(({ name }: { name: string }) => ({ name })) };
  const activatedResult = await assemble(activatedAssembly, { agent, signal }, async () => {
    activatedRestrictionAtSnapshot = last(restrictions);
    return activatedAssembly;
  });
  assert.ok(activatedRestrictionAtSnapshot);
  assert.equal(activatedRestrictionAtSnapshot, restrictions[1]);
  assert.equal(activatedRestrictionAtSnapshot.deny.includes("odai_human_care"), false);
  assert.deepEqual(
    [...activatedResult.tools.map((tool: TestToolSchema) => tool.name).filter((name: string) => name.startsWith("odai_")).sort()],
    ["odai_context_capability", "odai_human_care", "odai_reference", "odai_responsibility_gap"],
  );
});

test("every gateway capability is executable when its next-step schema is snapshotted", async () => {
  const cases = [
    ["routing-config", "odai_routing_config"],
    ["human-care", "odai_human_care"],
    ["human-safety", "odai_human_safety"],
    ["skill-source", "odai_skill_source_config"],
    ["skill-evolution", "odai_skill_evolution"],
    ["output-config", "odai_output_config"],
    ["compaction-config", "odai_compaction_config"],
    ["memory", "odai_memory"],
    ["safety-continuity", "odai_human_safety_continuity"],
  ];
  for (const [capability, toolName] of cases) {
    const ctx = fakeContext();
    apply(ctx, { skillPath, routing: { mode: "off" } });
    const restrictions = new RequiredArray<TestRestriction>();
    const events: DshEvent[] = [{ type: "turn/start", seq: 1, data: { turn: 1 } }];
    const agent = {
      ctx: { tools: { restrict(filter: TestRestriction) { restrictions.push(filter); return () => {}; } } },
      session: {
        header: {},
        events,
        append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
      },
    };
    const signal = new AbortController().signal;
    const assemble = ctx.captured.handlers.get("system-prompt/assemble");
    const coldAssembly = { sections: ctx.captured.sections, tools: ctx.captured.tools.map(({ name }: { name: string }) => ({ name })) };
    const coldResult = await assemble(coldAssembly, { agent, signal }, async () => ({
      sections: ctx.captured.sections,
      tools: ctx.captured.tools.map(({ name }: { name: string }) => ({ name })),
    }));
    assert.ok(last(restrictions).deny.includes(toolName), `${toolName} must start hidden`);
    assert.equal(coldResult.tools.some((tool: TestToolSchema) => tool.name === toolName), false, `${toolName} must start outside the schema`);

    agent.session.append("user/message", userMessage("继续"));
    agent.session.append("step/start", { turn: 1, step: 1 });
    const gateway = ctx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_context_capability");
    await gateway.execute({ capability }, { agent });
    let restrictionAtSnapshot: TestRestriction | undefined;
    const activatedAssembly = { sections: ctx.captured.sections, tools: coldResult.tools.map(({ name }: { name: string }) => ({ name })) };
    const activatedResult = await assemble(activatedAssembly, { agent, signal }, async () => {
      restrictionAtSnapshot = last(restrictions);
      return activatedAssembly;
    });
    assert.equal(ctx.captured.tools.some((tool: TestToolSchema) => tool.name === toolName), true, `${toolName} must be registered`);
    assert.equal(activatedResult.tools.some((tool: TestToolSchema) => tool.name === toolName), true, `${toolName} must enter the next schema`);
    assert.ok(restrictionAtSnapshot);
    assert.equal(restrictionAtSnapshot.deny.includes(toolName), false, `${toolName} must be executable at snapshot`);
    assert.equal(restrictionAtSnapshot.deny.includes("odai_context_capability"), false, "gateway must remain executable");
  }
});

test("outer runtime refreshes executable schemas after downstream restriction changes", async () => {
  const visible = new Set(["odai_context_capability", "odai_reference", "odai_responsibility_gap"]);
  const ctx = fakeContext({
    toolSchemas(captured) {
      return captured.tools
        .filter(({ name }) => visible.has(name))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
    },
  });
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
  ];
  const agent = {
    ctx: { tools: { restrict() { return () => {}; } } },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const gateway = ctx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_context_capability");
  await gateway.execute({ capability: "routing-config" }, { agent });
  const assembly = {
    sections: ctx.captured.sections,
    tools: ctx.tools.schemas?.(agent) ?? [],
  };
  const result = await ctx.captured.handlers.get("system-prompt/assemble")(
    assembly,
    { agent, signal: new AbortController().signal },
    async () => {
      visible.add("odai_routing_config");
      return { ...assembly, tools: ctx.tools.schemas?.(agent) ?? [] };
    },
  );
  assert.equal(result.tools.some((tool: TestToolSchema) => tool.name === "odai_routing_config"), true);
});

test("capability gateway recovers a missed expression on the next step", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const restrictions = new RequiredArray<TestRestriction>();
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage("把那个相关设置给我看看") },
    { type: "step/start", seq: 3, data: { turn: 1, step: 1 } },
  ];
  const agent = {
    ctx: { tools: { restrict(filter: TestRestriction) { restrictions.push(filter); return () => {}; } } },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const gateway = ctx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_context_capability");
  await gateway.execute({ capability: "compaction-config" }, { agent });
  const assembled = await ctx.captured.handlers.get("system-prompt/assemble")(
    {},
    { agent, signal: new AbortController().signal },
    async () => ({ sections: ctx.captured.sections }),
  );
  assert.match(
    assembled.sections.find((section: TestPromptSection) => section.name === "odai:compaction-model-configuration").text,
    /compaction model configuration/u,
  );
  assert.equal(last(restrictions).deny.includes("odai_compaction_config"), false);
});

test("implementation turns activate craft within the contextual prompt budget", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const text = "把按钮文案改清楚并运行现有测试";
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage(text) },
  ];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const assembled = await ctx.captured.handlers.get("system-prompt/assemble")(
    {},
    { agent, signal: new AbortController().signal },
    async () => ({ sections: ctx.captured.sections }),
  );
  const section = (name: string) => assembled.sections.find((candidate: TestPromptSection) => candidate.name === name).text;
  assert.match(section("odai:canonical-craft"), /通用制作工艺/u);
  assert.match(section("odai:canonical-craft"), /复用当前项目的实现、依赖和约定/u);
  assert.match(section("odai:canonical-craft"), /只改解决目标所需的最小完整部分/u);
  assert.equal(section("odai:routing-configuration"), "");
  assert.equal(section("odai:human-safety-continuity"), "");
  assert.equal(section("odai:skill-source-configuration"), "");
  assert.equal(section("odai:compaction-model-configuration"), "");
  assert.equal(section("odai:semantic-memory"), "");
  const systemText = assembled.sections.map((candidate: TestPromptSection) => candidate.text).filter(Boolean).join("\n\n");
  const activeNames = new Set<string>(activeOdaiToolNames(classifyContextActivation(text)));
  const activeTools = ctx.captured.tools.filter((tool: TestToolSchema) => activeNames.has(tool.name));
  const systemTokens = estimateContextTokens(systemText) + 4;
  const toolTokens = estimateToolSchemaTokens(activeTools);
  assert.ok(systemTokens <= 1_950, `implementation Odai system budget ${systemTokens} exceeds 1950`);
  assert.ok(toolTokens <= 600, `implementation Odai tool budget ${toolTokens} exceeds 600`);
  assert.ok(systemTokens + toolTokens <= 2_400, `implementation Odai budget ${systemTokens + toolTokens} exceeds 2400`);
  assert.ok(systemTokens + toolTokens < 6_194 * 0.4, "contextual implementation should remove at least 60% of measured Odai overhead");
});

test("read-only requests do not activate the canonical craft reference", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "off" } });
  const text = "只审查现有实现，不要修改文件";
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage(text) },
  ];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const assembled = await ctx.captured.handlers.get("system-prompt/assemble")(
    {},
    { agent, signal: new AbortController().signal },
    async () => ({ sections: ctx.captured.sections }),
  );
  assert.equal(
    assembled.sections.find((section: TestPromptSection) => section.name === "odai:canonical-craft").text,
    "",
  );
  const systemText = assembled.sections.map((section: TestPromptSection) => section.text).filter(Boolean).join("\n\n");
  const activeNames = new Set<string>(activeOdaiToolNames(classifyContextActivation(text)));
  const activeTools = ctx.captured.tools.filter((tool: TestToolSchema) => activeNames.has(tool.name));
  const systemTokens = estimateContextTokens(systemText) + 4;
  const toolTokens = estimateToolSchemaTokens(activeTools);
  assert.ok(systemTokens <= 1_600, `read-only Odai system budget ${systemTokens} exceeds 1600`);
  assert.ok(toolTokens <= 600, `read-only Odai tool budget ${toolTokens} exceeds 600`);
  assert.ok(systemTokens + toolTokens <= 1_900, `read-only Odai budget ${systemTokens + toolTokens} exceeds 1900`);
});

test("plugin registers canonical prompt, monotonic guard, audit observer, and router", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "observe" } });

  assert.equal(ctx.captured.sections.length, 9);
  assert.match(ctx.captured.sections[0].text, /odai canonical governance/u);
  assert.match(ctx.captured.sections[0].text, /already loaded by this runtime; do not call the skill tool/u);
  assert.equal(ctx.captured.sections[1].text, "");
  assert.match(ctx.captured.sections[2].text, /naturally asks to inspect, set, change, or remove/u);
  assert.match(ctx.captured.sections[2].text, /Never infer, recommend as chosen, or silently select/u);
  assert.match(ctx.captured.sections[3].text, /user-controlled human-safety continuity/iu);
  assert.match(ctx.captured.sections[3].text, /Never infer or automatically save a current mood/u);
  assert.match(ctx.captured.sections[4].text, /Users provide goals, constraints, materials, and acceptance/u);
  assert.match(ctx.captured.sections[5].text, /explicitly asks to inspect, set, or reset that source/u);
  assert.equal(ctx.captured.sections[6].text, "");
  assert.match(ctx.captured.sections[7].text, /compaction model configuration/u);
  assert.match(ctx.captured.sections[7].text, /Never infer or silently choose/u);
  assert.match(ctx.captured.sections[7].text, /controller, researcher, planner, reviewer, frontend/u);
  assert.match(ctx.captured.sections[8].text, /long-term semantic memory/u);
  assert.match(ctx.captured.sections[8].text, /no hidden provider, model, embedding, subagent, or compaction call/u);
  const tools = new RequiredMap(ctx.captured.tools.map((tool: TestTool) => [tool.name, tool] as const));
  assert.deepEqual([...tools.keys()], [
    "odai_context_capability",
    "odai_reference",
    "odai_routing_config",
    "odai_human_care",
    "odai_human_safety",
    "odai_responsibility_gap",
    "odai_responsibility_return",
    "odai_skill_source_config",
    "odai_skill_evolution",
    "odai_output_config",
    "odai_compaction_config",
    "odai_memory",
    "odai_human_safety_continuity",
  ]);
  assert.match(tools.get("odai_human_care").description, /non-crisis care/iu);
  assert.match(tools.get("odai_human_safety").description, /Invoke proactively/iu);
  assert.match(tools.get("odai_skill_evolution").description, /current open turn's latest genuine user message/u);
  assert.equal("evidence" in tools.get("odai_skill_evolution").parameters.properties, false);
  assert.equal(ctx.captured.sections.some((section: TestPromptSection) => section.name === "odai:skill-evolution"), false);
  assert.match(tools.get("odai_memory").description, /without requiring the user to say remember/u);
  assert.match(tools.get("odai_human_safety_continuity").description, /independent cross-session human-safety continuity/u);
  assert.ok(ctx.captured.handlers.has("system-prompt/assemble"));
  assert.equal(ctx.captured.guards.length, 1);
  assert.ok(ctx.captured.handlers.has("tools/result"));
  assert.ok(ctx.captured.handlers.has("agent/pre-step"));
  assert.ok(ctx.captured.handlers.has("session/event"));
  assert.ok(ctx.captured.handlers.has("agent/turn-stopping"));

  const events: DshEvent[] = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const planning = await tools.get("odai_reference").execute({ reference: "planning" }, { agent });
  assert.equal(planning.reference, "planning");
  assert.equal(planning.skillVersion, "0.3.7");
  assert.equal(planning.runtimeContract, 6);
  assert.match(planning.digest, /^[a-f0-9]{64}$/u);
  assert.match(planning.contract, /工程实施计划/u);
  const care = await tools.get("odai_human_care").execute({}, { agent });
  assert.match(care.contract, /日常关怀与交互风格/u);
  const safety = await tools.get("odai_human_safety").execute({}, { agent });
  assert.match(safety.contract, /任何可信倾向都不得/u);
  const signal = new AbortController().signal;
  const handler = ctx.captured.handlers.get("agent/pre-step");
  const result = await handler({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.equal(result.kind, "enter");
  assert.equal(result.messages.length, 2);
  assert.match(messageText(result.messages[1]), /role: controller/u);
  assert.match(messageText(result.messages[1]), /target responsibility: planner/u);
  assert.match(messageText(result.messages[1]), /concrete evidence-gathering steps and explicit decision criteria/u);
  assert.match(messageText(result.messages[1]), /do not implement, persist, or publish/u);
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), [
    "odai/route-decided",
    "odai/route-protection",
  ]);
  assert.equal(events[0].data.role, "controller");
  assert.equal(events[0].data.action, "upgrade");
  assert.equal(events[0].data.targetRole, "planner");
  assert.equal(events[0].data.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
  assert.equal(events[1].data.mode, "read-only");
  assert.equal(events[1].data.source, "observe");

  const guard = ctx.captured.guards[0];
  assert.match(guard({ callId: "write-1", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.equal(guard({ callId: "read-1", agent, name: "read" }), undefined);
  assert.equal(last(events).type, "odai/governance-denied");

  await handler({ agent, turn: 2, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("把普通按钮文案改得更清楚")],
  }));
  assert.equal(guard({ callId: "write-2", agent, name: "write" }), undefined);
});

test("explicit safety continuity persists across controller sessions without reaching child prompts", async () => {
  const firstCtx = fakeContext();
  apply(firstCtx, { skillPath });
  const value = "心烦时先听我说，再帮我把事情缩小一步";
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage(`请跨会话保存这条照护偏好：${value}。`) },
  ];
  const firstAgent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, seq: events.length + 1, data }); },
    },
  };
  const firstTool = firstCtx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_human_safety_continuity");
  await firstTool.execute({ action: "add", category: "care-preference", value }, { agent: firstAgent });

  const nextCtx = fakeContext();
  apply(nextCtx, { skillPath });
  const controllerEvents: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage("我今天很焦虑，脑子里一直反复纠结") },
  ];
  const controllerAgent = {
    session: {
      header: {},
      events: controllerEvents,
      append(type: string, data: RuntimeEventData) { controllerEvents.push({ type, seq: controllerEvents.length + 1, data }); },
    },
  };
  const assembled = await nextCtx.captured.handlers.get("system-prompt/assemble")(
    {},
    { agent: controllerAgent, signal: new AbortController().signal },
    async () => ({ sections: nextCtx.captured.sections }),
  );
  const continuity = assembled.sections.find((section: TestPromptSection) => section.name === "odai:human-safety-continuity").text;
  assert.match(continuity, new RegExp(value, "u"));
  assert.match(continuity, /not evidence of the user's current state/u);

  const childAgent = { session: { header: { origin: "subagent", delegationDepth: 1 }, events: [], append() {} } };
  const childAssembled = await nextCtx.captured.handlers.get("system-prompt/assemble")(
    {},
    { agent: childAgent, signal: new AbortController().signal },
    async () => ({ sections: nextCtx.captured.sections }),
  );
  const childContinuity = childAssembled.sections.find((section: TestPromptSection) => section.name === "odai:human-safety-continuity").text;
  assert.doesNotMatch(childContinuity, new RegExp(value, "u"));

  controllerAgent.session.events.push(
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: userMessage("请彻底清空全部安全照护档案") },
  );
  await nextCtx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_human_safety_continuity")
    .execute({ action: "clear" }, { agent: controllerAgent });
});

test("global and preset runtime instances deduplicate durable evidence and routing", async () => {
  const outputConfigPath = resolve(testDshHome, "coexistence-output-policy", "output.json");
  mkdirSync(resolve(testDshHome, "coexistence-output-policy"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { concise: true, maxTokens: 2_500 },
  })}\n`, "utf8");
  const globalCtx = fakeContext();
  const presetCtx = fakeContext();
  const runtimeConfig = {
    skillPath,
    routing: { mode: "observe" },
    output: { configPath: outputConfigPath },
  };
  apply(globalCtx, runtimeConfig);
  apply(presetCtx, runtimeConfig);

  const events: DshEvent[] = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const payload = { agent, turn: 1, step: 1, signal: new AbortController().signal };
  const base = async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  });
  const globalRoute = globalCtx.captured.handlers.get("agent/pre-step");
  const presetRoute = presetCtx.captured.handlers.get("agent/pre-step");
  const result = await globalRoute(payload, () => presetRoute(payload, base));

  assert.equal(events.filter((event) => event.type === "odai/route-decided").length, 1);
  assert.equal(events.filter((event) => event.type === "odai/route-protection").length, 1);
  assert.equal(result.messages.filter((message: DshMessage) => message.source?.plugin === "odai-dsh-runtime").length, 1);
  assert.match(globalCtx.captured.guards[0]({ callId: "global-write", name: "write", agent }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.match(presetCtx.captured.guards[0]({ callId: "preset-write", name: "write", agent }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);

  const execution = {
    callId: "shared-call",
    rootCallId: "shared-call",
    name: "read",
    agent,
  };
  globalCtx.captured.handlers.get("tools/result")(execution, { isError: false });
  presetCtx.captured.handlers.get("tools/result")(execution, { isError: false });
  assert.equal(events.filter((event) => event.type === "odai/tool-observed").length, 1);

  const globalRequest = globalCtx.captured.handlers.get("agent/request");
  const presetRequest = presetCtx.captured.handlers.get("agent/request");
  const capped = await globalRequest(payload, () => presetRequest(payload, async () => ({
    provider: "base",
    model: "controller",
    maxTokens: 8_000,
  })));
  assert.deepEqual(capped, { provider: "base", model: "controller", maxTokens: 2_500 });
  assert.equal(events.filter((event) => event.type === "odai/output-budget-applied").length, 1);
});

test("global and preset execute routing starts exactly one subagent", async () => {
  let starts = 0;
  let disposals = 0;
  const subagents = {
    async start() {
      starts += 1;
      return {
        result: Promise.resolve({
          stopReason: "completed",
          output: [{ type: "text", text: "one routed result" }],
        }),
        async dispose() {
          disposals += 1;
        },
      };
    },
  };
  const globalCtx = fakeContext({ subagents });
  const presetCtx = fakeContext({ subagents });
  const routing = {
    mode: "execute",
    roles: { planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" } },
  };
  apply(globalCtx, { skillPath, routing });
  apply(presetCtx, { skillPath, routing });

  const events: DshEvent[] = [responsibilityGapEvent("planner")];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const payload = { agent, turn: 1, step: 1, signal: new AbortController().signal };
  const base = async () => ({
    kind: "enter",
    messages: [userMessage("请独立规划一下架构选型")],
  });
  const globalRoute = globalCtx.captured.handlers.get("agent/pre-step");
  const presetRoute = presetCtx.captured.handlers.get("agent/pre-step");
  const result = await globalRoute(payload, () => presetRoute(payload, base));

  assert.equal(starts, 1);
  assert.equal(disposals, 1);
  assert.equal(events.filter((event) => event.type === "odai/route-decided").length, 1);
  assert.equal(events.filter((event) => event.type === "odai/route-result").length, 1);
  assert.equal(result.messages.filter((message: DshMessage) => message.source?.plugin === "odai-dsh-runtime").length, 1);
});

test("execute routing disposes a successful provider run", async () => {
  let disposed = false;
  let request: TestSubagentRequest | undefined;
  const result = await runRoutedRole({
    subagents: {
      async start(_provider: string, value: UnknownRecord) {
        request = asTestSubagentRequest(value);
        return {
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "independent evidence" }],
          }),
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "compare options",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(disposed, true);
  assert.ok(request);
  assert.equal(request.maxDepth, 1);
  const delegationPrompt = request.prompt[0]?.text;
  assert.ok(delegationPrompt);
  assert.match(delegationPrompt, /do not edit files/iu);
});

test("default auto reports an unconfigured planner only when the gap is needed", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath });

  const events: DshEvent[] = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const preStep = ctx.captured.handlers.get("agent/pre-step");
  const signal = new AbortController().signal;
  const result = await preStep({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.deepEqual(events.map((event) => event.type), [
    "odai/route-decided",
    "odai/route-config-missing",
    "odai/route-protection",
  ]);
  assert.equal(events[1].data.role, "planner");
  assert.equal(events[1].data.status, "unconfigured");
  assert.equal(events[2].data.source, "route-config-missing");
  assert.match(messageText(result.messages[1]), /required responsibility: planner/u);
  assert.match(messageText(result.messages[1]), /natural language/u);
  assert.match(messageText(result.messages[1]), /odai_routing_config/u);
  assert.doesNotMatch(messageText(result.messages[1]), /requested controller route|routing:\n/u);

  const inherited = { provider: "openai", model: "current-controller", reasoningEffort: "high" };
  assert.deepEqual(
    await ctx.captured.handlers.get("agent/request")({ agent, turn: 1 }, async () => inherited),
    inherited,
  );
  assert.match(ctx.captured.guards[0]({ callId: "missing-planner-write", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
});

test("an invalid user routing store keeps governance loaded and repairs through the tool", async () => {
  const configPath = resolve(testDshHome, "invalid-config", "routing.json");
  mkdirSync(resolve(testDshHome, "invalid-config"), { recursive: true });
  writeFileSync(configPath, "{not-json\n", "utf8");

  const ctx = fakeContext();
  assert.doesNotThrow(() => apply(ctx, { skillPath, routing: { configPath } }));
  assert.equal(ctx.captured.guards.length, 1);
  assert.ok(ctx.captured.tools.some((tool: TestToolSchema) => tool.name === "odai_routing_config"));

  const events: DshEvent[] = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  const missing = findEvent(events, (event) => event.type === "odai/route-config-missing");
  const protection = findEvent(events, (event) => event.type === "odai/route-protection");
  assert.equal(missing.data.status, "invalid");
  assert.ok(typeof missing.data.error === "string");
  assert.match(missing.data.error, /cannot read odai routing config/u);
  assert.equal(protection.data.source, "route-config-invalid");
  assert.match(messageText(result.messages[1]), /saved configuration is invalid/u);
  assert.match(messageText(result.messages[1]), /repair and persist/u);
  assert.match(ctx.captured.guards[0]({ callId: "invalid-config-write", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);

  const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_routing_config");
  const repaired = await tool.execute({
    action: "set",
    responsibility: "planner",
    provider: "provider-a",
    model: "model-plan",
  }, { agent: { session: { header: {}, append() {} } } });
  assert.equal(repaired.recoveredInvalidStore, true);
  assert.deepEqual(repaired.roles.planner, { provider: "provider-a", model: "model-plan" });
  assert.equal(readdirSync(resolve(testDshHome, "invalid-config")).some(
    (entry) => entry.startsWith("routing.json.invalid-"),
  ), true);
  assert.deepEqual((await tool.execute({ action: "show" }, { agent: { session: { header: {} } } })).roles.planner, {
    provider: "provider-a",
    model: "model-plan",
  });

  writeFileSync(`${configPath}.lock`, `${process.pid}:live-owner\n`, "utf8");
  utimesSync(`${configPath}.lock`, new Date(0), new Date(0));
  await assert.rejects(tool.execute({
    action: "set",
    responsibility: "reviewer",
    provider: "provider-b",
    model: "model-review",
  }, { agent: { session: { header: {} } } }), /being updated; retry/u);
  rmSync(`${configPath}.lock`, { force: true });
});

test("execute mode loads without subagents and reports an unconfigured reviewer on demand", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { mode: "execute" } });
  const events: DshEvent[] = [responsibilityGapEvent("reviewer")];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请独立审查这个架构方案")],
  }));

  assert.deepEqual(events.map((event) => event.type), [
    "odai/responsibility-gap",
    "odai/route-decided",
    "odai/responsibility-gap-consumed",
    "odai/route-config-missing",
  ]);
  assert.equal(events[3].data.role, "reviewer");
  assert.equal(events.some((event) => event.type === "odai/route-protection"), false);
  assert.match(messageText(result.messages[1]), /required responsibility: reviewer/u);
});

test("configured auto mode upgrades the current controller turn without a child", async () => {
  const outputConfigPath = resolve(testDshHome, "planner-output-override", "output.json");
  mkdirSync(resolve(outputConfigPath, ".."), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({ schemaVersion: 1, policy: { concise: true, maxTokens: 500 } })}\n`, "utf8");
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    output: { configPath: outputConfigPath },
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          maxTokens: 2_048,
        },
      },
    },
  });

  const events: DshEvent[] = [];
  let actualHeader: UnknownRecord | undefined;
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const preStep = ctx.captured.handlers.get("agent/pre-step");
  const request = ctx.captured.handlers.get("agent/request");
  assert.deepEqual(ctx.captured.handlerOptions.get("agent/request"), { prepend: true });
  const signal = new AbortController().signal;
  const result = await preStep({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.match(messageText(result.messages[1]), /action: upgrade/u);
  assert.match(messageText(result.messages[1]), /no child was started/u);
  assert.match(messageText(result.messages[1]), /requested controller route: openai\/gpt-5\.6-sol \(reasoning: high, maxTokens: 2048\)/u);
  assert.deepEqual(events.map((event) => event.type), [
    "odai/route-decided",
    "odai/route-context",
    "odai/responsibility-scope-started",
    "odai/route-protection",
    "odai/route-upgrade",
  ]);
  assert.equal(events[0].data.role, "controller");
  assert.equal(events[0].data.action, "upgrade");
  assert.equal(events[0].data.targetRole, "planner");
  assert.equal(events[1].data.mode, "same-turn");
  assert.match(requiredString(events[1].data.digest), /^[a-f0-9]{64}$/u);
  assert.equal(events[2].data.role, "planner");
  assert.equal(events[2].data.continuationPolicy, "read-only-tool-chain");
  assert.equal(events[3].data.source, "responsibility-scope-planner");
  assert.equal(events[3].data.scopeId, events[2].data.scopeId);
  assert.equal(events[4].data.status, "requested");
  assert.equal(events[4].data.responsibilityScopeId, events[2].data.scopeId);
  assert.deepEqual(events[4].data.requestedRoute, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });

  const inherited = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max", maxTokens: 500 };
  const plannerRequest = await request({ agent, turn: 1, step: 1 }, async () => inherited);
  assert.deepEqual(plannerRequest, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });
  actualHeader = { config: plannerRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1 },
  });
  const plannerReceipt = findEvent(events, (event) => event.type === "odai/route-applied").data;
  assert.equal(plannerReceipt.status, "applied");
  assert.equal(plannerReceipt.responsibility, "planner");
  assert.deepEqual(plannerReceipt.actualRoute, plannerRequest);
  assert.ok(plannerReceipt.requestedRoute);
  assert.equal(plannerReceipt.requestedRoute.maxTokens, 2_048);
  assert.deepEqual(findEvent(events, (event) => event.type === "odai/output-budget-overridden").data, {
    turn: 1,
    step: 1,
    responsibility: "planner",
    responsibilityMaxTokens: 2_048,
    configuredControllerMaxTokens: 500,
    effectiveMaxTokens: 2_048,
    budgetSource: "responsibility-override",
    semantics: "explicit-responsibility-override",
  });

  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { content: [{ type: "tool-call", id: "read-1", name: "read", arguments: "{}" }] } },
  });
  const plannerToolContinuation = await request({ agent, turn: 1, step: 2 }, async () => inherited);
  assert.deepEqual(plannerToolContinuation, {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });
  actualHeader = { config: plannerToolContinuation };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { turn: 1, step: 2, header: actualHeader },
  });
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 2, message: { content: [{ type: "text", text: "mode: direct" }] } },
  });
  assert.equal(findLastEvent(events, (event) => event.type === "odai/responsibility-scope-stopped").data.reason, "terminal-response");
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "max-tokens" } },
  });
  assert.equal(events.some((event) => event.type === "odai/responsibility-interrupted"), false);
  assert.deepEqual(await request({ agent, turn: 1, step: 3 }, async () => inherited), inherited);

  await preStep({ agent, turn: 2, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("把普通按钮文案改得更清楚")],
  }));
  assert.deepEqual(await request({ agent, turn: 2, step: 1 }, async () => inherited), inherited);

  await preStep({ agent, turn: 3, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));
  const queuedScopeRequest = await request({ agent, turn: 3, step: 1 }, async () => inherited);
  actualHeader = { config: queuedScopeRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { turn: 3, step: 1, header: actualHeader },
  });
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/message",
    data: { turn: 3, step: 1, message: { content: [{ type: "tool-call", id: "read-2", name: "read", arguments: "{}" }] } },
  });
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "agent/inbox/spliced",
    data: { target: "next-step", start: 0, inserted: [userMessage("先暂停这个，回答我刚发的新问题")] },
  });
  assert.equal(findLastEvent(events, (event) => event.type === "odai/responsibility-scope-stopped").data.reason, "direct-user-input");
  assert.deepEqual(await request({ agent, turn: 3, step: 2 }, async () => inherited), inherited);
});

test("auto mode honors explicit child dispatch for planner and frontend", async () => {
  const cases = [
    {
      role: "planner" as const,
      route: { provider: "openai", model: "planner-child", reasoningEffort: "high" },
      message: "checkout 老超时，把客户端超时和重试一起改掉。",
      events: [responsibilityGapEvent("planner")],
    },
    {
      role: "frontend" as const,
      route: { provider: "kimi-coding", model: "frontend-child", reasoningEffort: "max" },
      message: "重新设计并实现完整的运营后台导航、表格、筛选、加载和错误状态。",
      events: [responsibilityGapEvent("frontend")],
    },
  ];

  for (const fixture of cases) {
    let starts = 0;
    const ctx = fakeContext({
      subagents: {
        async start(_provider: string, options: UnknownRecord) {
          starts += 1;
          assert.equal(options.label, `odai-${fixture.role}`);
          return {
            localAgent: {
              session: {
                events: [{ type: "request/header", data: { header: { config: fixture.route } } }],
              },
            },
            result: Promise.resolve({
              stopReason: "completed",
              output: [{ type: "text", text: `${fixture.role} bounded result` }],
            }),
            async dispose() {},
          };
        },
      },
    });
    apply(ctx, {
      skillPath,
      routing: {
        roles: { [fixture.role]: fixture.route },
        dispatch: { [fixture.role]: "child" },
      },
    });
    const events: DshEvent[] = [...fixture.events];
    const agent = {
      session: {
        header: {},
        events,
        append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
      },
    };
    const result = await ctx.captured.handlers.get("agent/pre-step")(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [userMessage(fixture.message)] }),
    );
    assert.equal(starts, 1, fixture.role);
    assert.equal(events.some((event) => event.type === "odai/responsibility-scope-started"), false, fixture.role);
    assert.match(messageText(result.messages.at(-1)), new RegExp(`${fixture.role} bounded result`, "u"));
    const routed = findLastEvent(events, (event) => event.type === "odai/route-result");
    assert.equal(routed.data.role, fixture.role);
    assert.equal(routed.data.status, "completed");
  }
});

test("researcher same-turn dispatch returns its read-only packet to the controller", async () => {
  const researcherRoute = { provider: "openai", model: "researcher-inline" };
  const controllerRoute = { provider: "openai", model: "controller" };
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      roles: { researcher: researcherRoute },
      dispatch: { researcher: "same-turn" },
    },
  });
  const events: DshEvent[] = [responsibilityGapEvent("researcher")];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("核实当前实现依据再继续")] }),
  );
  const researcherRequest = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => controllerRoute,
  );
  assert.deepEqual(researcherRequest, researcherRoute);
  const returnTool = ctx.captured.tools.find((tool: TestTool) => tool.name === "odai_responsibility_return");
  const returned = await returnTool.execute({
    target: "controller",
    summary: "Verified bounded evidence packet",
    evidenceRefs: ["src/router.mts:1"],
  }, { agent });
  assert.equal(returned.responsibility, "researcher");
  assert.equal(returned.target, "controller");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 2 },
    async () => researcherRequest,
  ), controllerRoute);
});

test("reviewer same-turn findings return to the controller for continued processing", async () => {
  const reviewerRoute = { provider: "openai", model: "reviewer-inline" };
  const controllerRoute = { provider: "openai", model: "controller" };
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      roles: { reviewer: reviewerRoute },
      dispatch: { reviewer: "same-turn" },
    },
  });
  const events: DshEvent[] = [responsibilityGapEvent("reviewer")];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请审查当前实现并把 finding 交回总控继续处理")] }),
  );
  const reviewerRequest = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => controllerRoute,
  );
  assert.deepEqual(reviewerRequest, reviewerRoute);
  const returnTool = ctx.captured.tools.find((tool: TestTool) => tool.name === "odai_responsibility_return");
  const returned = await returnTool.execute({
    target: "controller",
    summary: "Finding: preserve the controller-owned write boundary.",
    evidenceRefs: ["dsh/runtime/src/governance.mts"],
  }, { agent });
  assert.equal(returned.responsibility, "reviewer");
  assert.equal(returned.target, "controller");
  assert.equal(findLastEvent(events, (event) => event.type === "odai/responsibility-returned").data.target, "controller");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 2 },
    async () => reviewerRequest,
  ), controllerRoute);
});

test("planner handback restores the original controller route", async () => {
  const plannerRoute = { provider: "openai", model: "planner-inline", reasoningEffort: "high" };
  const controllerRoute = { provider: "openai", model: "controller", reasoningEffort: "max" };
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: { roles: { planner: plannerRoute }, dispatch: { planner: "same-turn" } },
  });
  const original = userMessage("请修复并验证当前路由问题");
  const events: DshEvent[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: original },
    { type: "step/start", seq: 3, data: { turn: 1, step: 1 } },
    { ...responsibilityGapEvent("planner"), seq: 4 },
  ];
  let actualHeader: UnknownRecord | undefined;
  const agent = {
    phase: { turn: 1, step: 1 },
    session: {
      header: {}, events,
      requestHeader() { return actualHeader; },
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [original] }),
  );
  const plannerRequest = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1, signal },
    async () => controllerRoute,
  );
  assert.deepEqual(plannerRequest, plannerRoute);
  actualHeader = { config: plannerRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header", data: { turn: 1, step: 1, header: actualHeader },
  });

  const returnTool = ctx.captured.tools.find((tool: TestTool) => tool.name === "odai_responsibility_return");
  const returned = await returnTool.execute({
    target: "controller",
    summary: "The bounded plan is ready for controller implementation.",
    evidenceRefs: ["planner-readonly-evidence"],
  }, { agent });
  assert.equal(returned.target, "controller");
  assert.equal(findLastEvent(events, (event) => event.type === "odai/responsibility-returned").data.target, "controller");

  agent.phase.step = 2;
  const restored = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 2, signal },
    async () => plannerRequest,
  );
  assert.deepEqual(restored, controllerRoute);
  actualHeader = { config: restored };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header", data: { turn: 1, step: 2, header: actualHeader },
  });
  const restoration = findLastEvent(events, (event) => event.type === "odai/responsibility-scope-restored");
  assert.equal(restoration.data.status, "applied");
  assert.deepEqual(restoration.data.actualRoute, controllerRoute);
});

test("same-turn read-only terminal output is recovered to the controller when handback is missing", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      roles: { reviewer: { provider: "openai", model: "reviewer-inline" } },
      dispatch: { reviewer: "same-turn" },
    },
  });
  const events: DshEvent[] = [responsibilityGapEvent("reviewer")];
  const injected: DshMessage[] = [];
  const agent = {
    inject(message: DshMessage) { injected.push(message); },
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请审查当前实现")] }),
  );
  const inherited = { provider: "openai", model: "controller" };
  const reviewerRequest = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => inherited,
  );
  assert.equal(reviewerRequest.model, "reviewer-inline");
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "looks good" }] } },
  });
  assert.equal(injected.length, 1);
  assert.match(messageText(injected[0]), /unverified read-only draft/u);
  assert.equal(findLastEvent(events, (event) => event.type === "odai/responsibility-return-missing").data.status, "recovery-injected");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 2 },
    async () => reviewerRequest,
  ), inherited);
});

test("resume restores every in-place responsibility's base route without reviving ownership", async () => {
  const base = { provider: "openai", model: "controller", reasoningEffort: "high", maxTokens: 500 };
  const signal = new AbortController().signal;
  for (const role of ["planner", "reviewer", "frontend"]) {
    const ctx = fakeContext();
    apply(ctx, { skillPath });
    const temporary = { provider: "openai", model: role, reasoningEffort: "xhigh", maxTokens: 500 };
    const scopeId = `scope-resume-${role}`;
    const events: DshEvent[] = [
      {
        type: "odai/responsibility-scope-started",
        data: {
          scopeId,
          turn: 1,
          startStep: 2,
          role,
          requestedRoute: temporary,
          continuationPolicy: ["planner", "reviewer"].includes(role) ? "read-only-tool-chain" : "bounded-work-tool-chain",
        },
      },
      {
        type: "odai/responsibility-scope-claimed",
        data: {
          scopeId,
          turn: 1,
          startStep: 2,
          role,
          requestedRoute: temporary,
          baseRoute: base,
          temporaryRoute: temporary,
          routeMode: "same-turn",
        },
      },
    ];
    const agent = {
      session: {
        header: {},
        events,
        append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
      },
    };
    await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 2, step: 1, signal }, async () => ({
      kind: "enter",
      messages: [userMessage("告诉我当前状态")],
    }));
    assert.equal(
      findLastEvent(events, (event) => event.type === "odai/responsibility-scope-stopped").data.reason,
      "runtime-resume",
      role,
    );
    assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
      { agent, turn: 2, step: 1, signal },
      async () => temporary,
    ), base, role);
    ctx.captured.handlers.get("session/event")(agent.session, {
      type: "request/header",
      data: { turn: 2, step: 1, header: { config: base } },
    });
    const restoration = findLastEvent(events, (event) => event.type === "odai/responsibility-scope-restored").data;
    assert.equal(restoration.status, "applied", role);
    assert.deepEqual(restoration.actualRoute, base, role);
    assert.equal(events.some((event) => event.type === "odai/route-applied"), false, role);
  }
});

test("a positionless late header cannot erase durable base-route restoration", async () => {
  const ctx = fakeContext();
  apply(ctx, { skillPath });
  const base = { provider: "openai", model: "controller", reasoningEffort: "high", maxTokens: 500 };
  const temporary = { provider: "openai", model: "planner", reasoningEffort: "xhigh", maxTokens: 2_048 };
  const events: DshEvent[] = [
    {
      type: "odai/responsibility-scope-stopped",
      data: {
        scopeId: "scope-late-header",
        turn: 1,
        startStep: 1,
        stopStep: 1,
        role: "planner",
        requestedRoute: temporary,
        baseRoute: base,
        temporaryRoute: temporary,
        reason: "terminal-response",
      },
    },
    { type: "request/header", data: { header: { config: temporary }, reason: "change" } },
  ];
  let actualHeader = { config: temporary };
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 2, step: 1, signal },
    async () => ({ kind: "enter", messages: [userMessage("告诉我当前状态")] }),
  );
  const restoredRequest = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 2, step: 1, signal },
    async () => temporary,
  );
  assert.deepEqual(restoredRequest, base);
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 2, step: 1, chunk: { type: "block-start" } },
  });
  const mismatch = findEvent(events, (event) => event.type === "odai/responsibility-scope-restored").data;
  assert.equal(mismatch.scopeId, "scope-late-header");
  assert.equal(mismatch.status, "mismatch");
  assert.match(ctx.captured.guards[0]({ callId: "write-1", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);

  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 3, step: 1, signal },
    async () => ({ kind: "enter", messages: [userMessage("继续报告当前状态")] }),
  );
  const retriedRequest = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 3, step: 1, signal },
    async () => temporary,
  );
  assert.deepEqual(retriedRequest, base);
  actualHeader = { config: retriedRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 3, step: 1, chunk: { type: "block-start" } },
  });
  const restored = findLastEvent(events, (event) => event.type === "odai/responsibility-scope-restored").data;
  assert.equal(restored.scopeId, "scope-late-header");
  assert.equal(restored.status, "applied");
  assert.deepEqual(restored.actualRoute, base);
});

test("a planner mapping identical to the controller stays inline without a duplicate model call", async () => {
  let routeResolutions = 0;
  const ctx = fakeContext({
    llm: {
      async resolveCallConfig(config: UnknownRecord) {
        routeResolutions += 1;
        return { config };
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: { roles: { planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" } } },
  });
  const events: DshEvent[] = [];
  let actualHeader: UnknownRecord | undefined;
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));
  const controller = { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" };
  const request = await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1, signal },
    async () => controller,
  );
  assert.deepEqual(request, controller);
  assert.equal(routeResolutions, 1);
  actualHeader = { config: request };
  ctx.captured.handlers.get("session/event")(agent.session, { type: "request/header", data: { turn: 1, step: 1, header: actualHeader } });
  const receipt = findEvent(events, (event) => event.type === "odai/route-applied").data;
  assert.equal(receipt.routeMode, "inline");
  assert.equal(receipt.status, "applied");
});

test("same-turn deterministic route validation removes the exact persisted mapping and restores the controller", async () => {
  const configPath = resolve(testDshHome, "runtime-route-invalid", "routing.json");
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    roles: { planner: { provider: "openai", model: "removed-planner" } },
  })}\n`, "utf8");
  const llm = {
    async resolveCallConfig(config: UnknownRecord) {
      if (config.model === "removed-planner") {
        const error: NodeJS.ErrnoException = new Error("unknown model removed-planner");
        error.code = "UNKNOWN_MODEL";
        throw error;
      }
      return { config };
    },
  };
  const ctx = fakeContext({ llm });
  apply(ctx, { skillPath, routing: { configPath } });
  const events: DshEvent[] = [responsibilityGapEvent("planner")];
  const agent = { session: { header: {}, events, append(type: string, data: RuntimeEventData) { events.push({ type, data }); } } };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("比较当前兼容路线后完成修复")],
  }));
  const base = { provider: "openai", model: "controller-model", reasoningEffort: "high" };
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1, signal },
    async () => base,
  ), base);
  assert.equal(findEvent(events, (event) => event.type === "odai/route-health").data.status, "invalid");
  assert.equal(findEvent(events, (event) => event.type === "odai/route-fallback").data.fallbackUsed, true);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).roles.planner, undefined);
  assert.equal(readdirSync(resolve(configPath, "..")).some((entry) => entry.startsWith("routing.json.invalidated-")), true);
});

test("transient same-turn route validation falls back without deleting the persisted mapping", async () => {
  const configPath = resolve(testDshHome, "runtime-route-transient", "routing.json");
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  const target = { provider: "openai", model: "busy-planner" };
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1, roles: { planner: target } })}\n`, "utf8");
  const llm = {
    async resolveCallConfig(config: UnknownRecord) {
      if (config.model === "busy-planner") {
        const error: NodeJS.ErrnoException = new Error("quota exhausted for this request");
        error.code = "QUOTA_EXCEEDED";
        throw error;
      }
      return { config };
    },
  };
  const ctx = fakeContext({ llm });
  apply(ctx, { skillPath, routing: { configPath } });
  const events: DshEvent[] = [responsibilityGapEvent("planner")];
  const agent = { session: { header: {}, events, append(type: string, data: RuntimeEventData) { events.push({ type, data }); } } };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("比较当前兼容路线后完成修复")],
  }));
  const base = { provider: "openai", model: "controller-model" };
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1, signal },
    async () => base,
  ), base);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).roles.planner, target);
  assert.equal(readdirSync(resolve(configPath, "..")).some((entry) => entry.startsWith("routing.json.invalidated-")), false);
  assert.equal(findEvent(events, (event) => event.type === "odai/route-health").data.status, "unhealthy");
});

test("a provider failure after route preflight retries the original controller once and preserves recoverable config", async () => {
  const configPath = resolve(testDshHome, "runtime-route-provider-failure", "routing.json");
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  const target = { provider: "openai", model: "planner-model" };
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1, roles: { planner: target } })}\n`, "utf8");
  const ctx = fakeContext();
  apply(ctx, { skillPath, routing: { configPath } });
  const events: DshEvent[] = [responsibilityGapEvent("planner")];
  const agent = { session: { header: {}, events, append(type: string, data: RuntimeEventData) { events.push({ type, data }); } } };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("比较当前兼容路线后完成修复")],
  }));
  const base = { provider: "base", model: "controller-model" };
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1, signal },
    async () => base,
  ), target);
  assert.deepEqual(await ctx.captured.handlers.get("agent/request-error")({
    agent,
    turn: 1,
    step: 1,
    provider: "openai",
    failure: { code: "RATE_LIMIT", message: "busy" },
    signal,
  }, async () => ({ kind: "failed" })), { kind: "retry" });
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1, signal },
    async () => base,
  ), base);
  ctx.captured.handlers.get("session/event")(agent.session, { type: "request/header", data: { header: { config: base } } });
  assert.equal(findLastEvent(events, (event) => event.type === "odai/responsibility-scope-stopped").data.reason, "route-request-failed");
  assert.equal(events.filter((event) => event.type === "odai/route-applied").length, 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).roles.planner, target);
  assert.equal(events.filter((event) => event.type === "odai/route-fallback").length, 1);
});

test("reviewer starts a child only from a complete hash-addressed evidence packet", async () => {
  let starts = 0;
  let startRequest: TestSubagentRequest | undefined;
  const ctx = fakeContext({
    subagents: {
      async start(_provider: string, request: UnknownRecord) {
        starts += 1;
        startRequest = asTestSubagentRequest(request);
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "independent review result" }] }),
          async dispose() {},
        };
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: { roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
  });
  const events: DshEvent[] = [
    responsibilityGapEvent("reviewer", {
      gap: "Review planner acceptance A1 and A2 against the final patch.",
      expectedChange: "Accept A1 and A2 or return precise blocking findings.",
    }),
    { type: "user/message", data: userMessage("实现请求：保持默认行为并修复路由。") },
    {
      type: "odai/responsibility-returned",
      data: {
        returned: true,
        scopeId: "planner-scope-1",
        responsibility: "planner",
        target: "controller",
        summary: "Planner acceptance A1: reuse the canonical owner; A2: preserve the bounded source format.",
        evidenceRefs: ["canonical-owner", "final-diff"],
      },
    },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过；A2：只修改目标模块。" }] } },
    ...nativeToolEvents("diff-1", "git diff -- dsh/runtime/src/router.mts", "diff --git a/router.mjs b/router.mjs\n+bounded change", { callSeq: 101 }),
    ...nativeToolEvents("test-1", "node --test dsh/runtime/tests/router.test.mts", "tests 14 pass 14 fail 0 exit code: 0", { callSeq: 111 }),
  ];
  const agent = { session: { header: {}, events, append(type: string, data: RuntimeEventData) { events.push({ type, data }); } } };
  const result = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(starts, 1);
  assert.ok(startRequest);
  assert.match(blockText(startRequest.prompt[0]), /Odai bounded role context packet/u);
  assert.match(blockText(startRequest.prompt[0]), /Review planner acceptance A1 and A2 against the final patch/u);
  assert.match(blockText(startRequest.prompt[0]), /Planner acceptance A1: reuse the canonical owner/u);
  assert.match(blockText(startRequest.prompt[0]), /kinds: planner-handback, planning/u);
  assert.match(blockText(startRequest.prompt[0]), /kinds: tool, diff/u);
  assert.match(blockText(startRequest.prompt[0]), /kinds: tool, test/u);
  const contextEvent = findEvent(events, (event) => event.type === "odai/route-context");
  assert.equal(contextEvent.data.mode, "bounded-packet");
  assert.equal(contextEvent.data.acceptanceCount, 1);
  assert.equal(contextEvent.data.diffCount, 1);
  assert.equal(contextEvent.data.testCount, 1);
  assert.match(messageText(result.messages[1]), new RegExp(`sha256:${contextEvent.data.digest}`, "u"));
  const routeResult = findEvent(events, (event) => event.type === "odai/route-result").data;
  assert.equal(routeResult.routeSource, "deployment-config");
  assert.equal(routeResult.fallbackUsed, false);
  assert.equal(routeResult.routeReceiptStatus, "applied");
  assert.deepEqual(routeResult.requestedRoute, {
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
  });
  assert.deepEqual(routeResult.actualRoute, routeResult.requestedRoute);
  const shownRoute = await ctx.captured.tools
    .find((tool: TestToolSchema) => tool.name === "odai_routing_config")
    .execute({ action: "show" }, { agent });
  assert.equal(shownRoute.latestRoute.status, "applied");
  assert.equal(shownRoute.latestRoute.taskStatus, "completed");
  assert.equal(shownRoute.latestRoute.taskStopReason, "completed");
  assert.equal(shownRoute.latestRoute.routeMode, "child");

  const mismatchCtx = fakeContext({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "wrong-reviewer", reasoningEffort: "max" } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "untrusted review" }] }),
          async dispose() { throw new Error("reviewer cleanup failed"); },
        };
      },
    },
  });
  apply(mismatchCtx, {
    skillPath,
    routing: {
      configPath: resolve(testDshHome, "reviewer-route-mismatch", "routing.json"),
      roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } },
    },
  });
  const mismatchEvents = [
    responsibilityGapEvent("reviewer"),
    { type: "user/message", data: userMessage("实现请求：保持默认行为并修复路由。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过；A2：只修改目标模块。" }] } },
    ...nativeToolEvents("diff-mismatch", "git diff -- dsh/runtime/src/router.mts", "diff --git a/router.mjs b/router.mjs\n+bounded change", { callSeq: 121 }),
    ...nativeToolEvents("test-mismatch", "node --test dsh/runtime/tests/router.test.mts", "tests 14 pass 14 fail 0 exit code: 0", { callSeq: 131 }),
  ];
  const mismatchAgent = {
    session: {
      header: {},
      events: mismatchEvents,
      append(type: string, data: RuntimeEventData) { mismatchEvents.push({ type, data }); },
    },
  };
  await mismatchCtx.captured.handlers.get("agent/pre-step")(
    { agent: mismatchAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  const mismatchShowTool = mismatchCtx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_routing_config");
  const mismatchShown = await mismatchShowTool.execute({ action: "show" }, { agent: mismatchAgent });
  assert.equal(mismatchShown.latestRoute.status, "mismatch");
  assert.equal(mismatchShown.latestRoute.taskStatus, "fallback");
  assert.match(mismatchShown.latestRoute.error, /child model mismatch/u);
  assert.match(mismatchShown.latestRoute.taskError, /provider cleanup failed: reviewer cleanup failed/u);
  assert.doesNotMatch(mismatchShown.latestRoute.taskError, /child model mismatch/u);
  const mismatchRendered = blockText(mismatchShowTool.output.render({}, mismatchShown)[0]);
  assert.match(mismatchRendered, /routeError=child model mismatch/u);
  assert.match(mismatchRendered, /taskError=provider cleanup failed: reviewer cleanup failed/u);

  let fallbackResolutions = 0;
  let fallbackStarts = 0;
  const fallbackCtx = fakeContext({
    llm: {
      async resolveCallConfig(config: UnknownRecord) {
        fallbackResolutions += 1;
        return { config };
      },
    },
    subagents: {
      async start() {
        fallbackStarts += 1;
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "reviewed after evidence refresh" }] }),
          async dispose() {},
        };
      },
    },
  });
  apply(fallbackCtx, {
    skillPath,
    routing: { roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
  });
  const fallbackEvents: DshEvent[] = [
    { type: "user/message", data: userMessage("实现请求：保持默认行为并修复路由。") },
    responsibilityGapEvent("reviewer"),
  ];
  const fallbackAgent = {
    session: {
      header: {},
      events: fallbackEvents,
      append(type: string, data: RuntimeEventData) { fallbackEvents.push({ type, data }); },
    },
  };
  const fallback = await fallbackCtx.captured.handlers.get("agent/pre-step")(
    { agent: fallbackAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(fallbackResolutions, 0);
  assert.match(messageText(fallback.messages[1]), /Remain on the current controller route/u);
  assert.match(messageText(fallback.messages[1]), /only to gather or fix that evidence/u);
  assert.match(messageText(fallback.messages[1]), /not independent acceptance/u);
  assert.equal(fallbackEvents.some((event) => event.type === "odai/route-upgrade"), false);
  assert.equal(fallbackEvents.some((event) => event.type === "odai/route-protection"), false);
  assert.equal(fallbackEvents.some((event) => event.type === "odai/route-applied"), false);
  const fallbackDecision = findEvent(fallbackEvents, (event) => event.type === "odai/route-decided").data;
  assert.equal(fallbackDecision.action, "direct");
  assert.equal(fallbackDecision.targetRole, "reviewer");
  assert.ok((fallbackDecision.signals ?? []).includes("controller-local-review"));
  const fallbackResult = findEvent(fallbackEvents, (event) => event.type === "odai/route-result").data;
  assert.equal(fallbackResult.stopReason, "evidence-packet-missing");
  assert.equal(fallbackResult.independent, false);
  assert.equal(fallbackEvents.some((event) => event.type === "odai/responsibility-gap-consumed"), false);
  const deferredGap = findEvent(fallbackEvents, (event) => event.type === "odai/responsibility-gap-deferred").data;
  assert.equal(deferredGap.responsibility, "reviewer");
  assert.match(String(deferredGap.evidenceDigest), /^[a-f0-9]{64}$/u);
  assert.match(messageText(fallback.messages[1]), /remains pending/u);
  assert.match(messageText(fallback.messages[1]), /Evidence diagnostics/u);
  const repeatedFallback = await fallbackCtx.captured.handlers.get("agent/pre-step")(
    { agent: fallbackAgent, turn: 1, step: 2, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(repeatedFallback.messages.length, 1);
  assert.equal(fallbackStarts, 0);
  assert.equal(fallbackEvents.filter((event) => event.type === "odai/responsibility-gap-deferred").length, 1);
  fallbackEvents.push(
    { type: "turn/start", seq: 300, data: { turn: 2 } },
    { type: "user/message", seq: 301, data: userMessage("继续") },
  );
  const carriedFallback = await fallbackCtx.captured.handlers.get("agent/pre-step")(
    { agent: fallbackAgent, turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("继续")] }),
  );
  assert.equal(carriedFallback.messages.length, 1);
  assert.equal(fallbackStarts, 0);
  assert.equal(fallbackEvents.filter((event) => event.type === "odai/responsibility-gap-deferred").length, 1);
  fallbackEvents.push(
    { type: "turn/start", seq: 310, data: { turn: 3 } },
    { type: "user/message", seq: 311, data: userMessage("继续；A1 还必须覆盖回滚") },
  );
  const clarifiedFallback = await fallbackCtx.captured.handlers.get("agent/pre-step")(
    { agent: fallbackAgent, turn: 3, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("继续；A1 还必须覆盖回滚")] }),
  );
  assert.equal(clarifiedFallback.messages.length, 1);
  assert.equal(fallbackStarts, 0);
  assert.equal(fallbackEvents.filter((event) => event.type === "odai/responsibility-gap-deferred").length, 1);
  fallbackEvents.push(
    ...nativeToolEvents("diff-after-deferral", "git diff -- dsh/runtime/src/router.mts", "diff --git a/router.mjs b/router.mjs\n+bounded change", { callSeq: 201 }),
    ...nativeToolEvents("test-after-deferral", "node --test dsh/runtime/tests/router.test.mts", "tests 14 pass 14 fail 0 exit code: 0", { callSeq: 211 }),
  );
  await fallbackCtx.captured.handlers.get("agent/pre-step")(
    { agent: fallbackAgent, turn: 3, step: 2, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("继续；A1 还必须覆盖回滚")] }),
  );
  assert.equal(fallbackStarts, 1);
  assert.equal(fallbackEvents.some((event) => event.type === "odai/responsibility-gap-consumed"), true);
  const reviewerRequest = await fallbackCtx.captured.handlers.get("agent/request")(
    { agent: fallbackAgent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller", reasoningEffort: "high" }),
  );
  assert.deepEqual(reviewerRequest, { provider: "base", model: "controller", reasoningEffort: "high" });

  let executeStarts = 0;
  const executeCtx = fakeContext({
    subagents: {
      async start() {
        executeStarts += 1;
        throw new Error("execute reviewer must not start without a complete packet");
      },
    },
  });
  apply(executeCtx, {
    skillPath,
    routing: {
      mode: "execute",
      roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } },
    },
  });
  const executeEvents: DshEvent[] = [responsibilityGapEvent("reviewer")];
  const executeAgent = {
    session: {
      header: {},
      events: executeEvents,
      append(type: string, data: RuntimeEventData) { executeEvents.push({ type, data }); },
    },
  };
  const executeFallback = await executeCtx.captured.handlers.get("agent/pre-step")(
    { agent: executeAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(executeStarts, 0);
  assert.match(executeFallback.messages[1].content[0].text, /bounded packet is incomplete/u);
  assert.match(executeFallback.messages[1].content[0].text, /remains pending/u);
  assert.equal(findEvent(executeEvents, (event) => event.type === "odai/route-result").data.stopReason, "evidence-packet-missing");
  assert.equal(executeEvents.some((event) => event.type === "odai/responsibility-gap-consumed"), false);
  assert.equal(executeEvents.some((event) => event.type === "odai/responsibility-gap-deferred"), true);
  executeEvents.push(
    { type: "turn/start", seq: 320, data: { turn: 2 } },
    { type: "user/message", seq: 321, data: userMessage("现在几点？") },
  );
  await executeCtx.captured.handlers.get("agent/pre-step")(
    { agent: executeAgent, turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("现在几点？")] }),
  );
  assert.equal(executeEvents.some((event) => (
    event.type === "odai/responsibility-gap-consumed"
    && event.data?.reason === "SUPERSEDED_BY_DIRECT_USER_TASK"
  )), true);
  assert.equal(executeStarts, 0);
  executeEvents.push(
    { type: "turn/start", seq: 330, data: { turn: 3 } },
    { type: "user/message", seq: 331, data: userMessage("改做一个无关的新任务") },
  );
  await executeCtx.captured.handlers.get("agent/pre-step")(
    { agent: executeAgent, turn: 3, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("改做一个无关的新任务")] }),
  );
  const supersededGap = findEvent(executeEvents, (event) => (
    event.type === "odai/responsibility-gap-consumed" && event.data?.reason === "SUPERSEDED_BY_DIRECT_USER_TASK"
  ));
  assert.equal(supersededGap.data.responsibility, "reviewer");
  assert.equal(executeStarts, 0);

  let failedStarts = 0;
  const failedCtx = fakeContext({ subagents: { async start() { failedStarts += 1; throw new Error("failed tests must block reviewer children"); } } });
  apply(failedCtx, {
    skillPath,
    routing: { roles: { reviewer: { provider: "openai", model: "gpt-5.6-terra", reasoningEffort: "max" } } },
  });
  const failedEvents: DshEvent[] = [
    responsibilityGapEvent("reviewer"),
    { type: "user/message", data: userMessage("实现请求：保持默认行为并修复路由。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过。" }] } },
    ...nativeToolEvents("diff-2", "git diff -- dsh/runtime/src/router.mts", "diff --git a/router.mjs b/router.mjs\n+bounded change", { callSeq: 141 }),
    ...nativeToolEvents("test-2", "node --test dsh/runtime/tests/router.test.mts", "tests 14 pass 13 fail 1 exit code: 1", { callSeq: 151, isError: true }),
  ];
  const failedAgent = { session: { header: {}, events: failedEvents, append(type: string, data: RuntimeEventData) { failedEvents.push({ type, data }); } } };
  await failedCtx.captured.handlers.get("agent/pre-step")(
    { agent: failedAgent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );
  assert.equal(failedStarts, 0);
  const failedContext = findEvent(failedEvents, (event) => event.type === "odai/route-context").data;
  assert.equal(failedContext.sufficient, false);
  assert.equal(failedContext.mode, "controller-local");
  assert.equal(failedEvents.some((event) => event.type === "odai/route-upgrade"), false);
  assert.equal(findEvent(failedEvents, (event) => event.type === "odai/route-result").data.independent, false);
});

test("reviewer child accepts a current read-only check without relabeling it as a test", async () => {
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() {
        starts += 1;
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "reviewer-model" } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "reviewed" }] }),
          async dispose() {},
        };
      },
    },
  });
  apply(ctx, { skillPath, routing: { roles: { reviewer: { provider: "openai", model: "reviewer-model" } } } });
  const events: DshEvent[] = [
    responsibilityGapEvent("reviewer"),
    { type: "user/message", data: userMessage("保持原格式和修改范围，修复路由证据识别。") },
    ...nativeToolEvents("check-route-diff", "git diff -- dsh/runtime/src/routing-context.mts", "diff --git a/routing-context.mts b/routing-context.mts\n+bounded change", { callSeq: 181 }),
    ...nativeToolEvents("check-route-eslint", "pnpm exec eslint dsh/runtime/src/routing-context.mts", "", { callSeq: 191 }),
  ];
  const agent = { session: { header: {}, events, append(type: string, data: RuntimeEventData) { events.push({ type, data }); } } };
  await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [userMessage("请独立审查这次实现")] }),
  );

  assert.equal(starts, 1);
  const context = findEvent(events, (event) => event.type === "odai/route-context").data;
  assert.equal(context.testCount, 0);
  assert.equal(context.checkCount, 1);
  assert.equal(context.sufficient, true);
});

test("an unavailable frontend mapping falls back locally with an explicit non-receipt notice", async () => {
  const configPath = resolve(testDshHome, "frontend-local-fallback", "routing.json");
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    roles: { frontend: { provider: "frontend-provider", model: "removed-frontend" } },
  })}\n`, "utf8");
  let resolutions = 0;
  const ctx = fakeContext({
    llm: {
      async resolveCallConfig(config: UnknownRecord) {
        resolutions += 1;
        if (config.model === "removed-frontend") {
          const error: NodeJS.ErrnoException = new Error("unknown model removed-frontend");
          error.code = "UNKNOWN_MODEL";
          throw error;
        }
        return { config };
      },
    },
  });
  apply(ctx, { skillPath, routing: { configPath } });
  const events: DshEvent[] = [];
  const agent = { session: { header: {}, events, append(type: string, data: RuntimeEventData) { events.push({ type, data }); } } };
  const signal = new AbortController().signal;
  const result = await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("整体改版这个运维仪表盘，覆盖移动端、多状态和 Playwright 浏览器验收。")],
  }));
  assert.equal(resolutions, 1);
  assert.match(messageText(result.messages[1]), /Continue locally as the current controller/u);
  assert.match(messageText(result.messages[1]), /Do not claim the configured frontend responsibility ran/u);
  assert.match(messageText(result.messages[1]), /Canonical craft reference/u);
  assert.equal(events.some((event) => event.type === "odai/route-upgrade"), false);
  assert.equal(findEvent(events, (event) => event.type === "odai/route-result").data.status, "fallback");
  const base = { provider: "base", model: "controller" };
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1, signal },
    async () => base,
  ), base);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).roles.frontend, undefined);
});

test("frontend incident upgrades in place, verifies its actual route, and overrides the global ceiling", async () => {
  const outputConfigPath = resolve(testDshHome, "frontend-output-policy", "output.json");
  const routingConfigPath = resolve(testDshHome, "frontend-output-policy", "routing.json");
  mkdirSync(resolve(testDshHome, "frontend-output-policy"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { concise: true, maxTokens: 500 },
  })}\n`, "utf8");
  let starts = 0;
  const ctx = fakeContext({
    subagents: {
      async start() { starts += 1; throw new Error("frontend must remain in the controller turn"); },
    },
  });
  apply(ctx, {
    skillPath,
    output: { configPath: outputConfigPath },
    routing: {
      configPath: routingConfigPath,
      roles: {
        frontend: {
          provider: "provider-frontend",
          model: "model-frontend",
          reasoningEffort: "max",
          maxTokens: 4_096,
        },
      },
    },
  });
  const events: DshEvent[] = [];
  let actualHeader: UnknownRecord | undefined;
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  const assembled = await ctx.captured.handlers.get("system-prompt/assemble")(
    {},
    { agent, signal },
    async () => ({ sections: ctx.captured.sections }),
  );
  const routingSection = assembled.sections.find((section: TestPromptSection) => section.name === "odai:routing-configuration").text;
  assert.equal(routingSection, "");
  const routed = await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("评估一下这个：把小松同学登录页面、登录后的首页以及个人空间截图发上去，帮我们优化界面介绍，看怎么让大家一眼就能明白小松同学是做什么的。")],
  }));
  assert.equal(starts, 0);
  assert.match(routed.messages[1].content[0].text, /target responsibility: frontend/u);
  assert.match(routed.messages[1].content[0].text, /Canonical craft reference/u);
  assert.match(routed.messages[1].content[0].text, /not an independent child/u);

  const request = ctx.captured.handlers.get("agent/request");
  const effectiveRequest = await request({ agent, turn: 1, step: 1 }, async () => ({
    provider: "base",
    model: "controller",
    reasoningEffort: "high",
    maxTokens: 8_000,
  }));
  assert.deepEqual(effectiveRequest, {
    provider: "provider-frontend",
    model: "model-frontend",
    reasoningEffort: "max",
    maxTokens: 4_096,
  });
  actualHeader = { config: effectiveRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "turn/end",
    data: { turn: 0, reason: { kind: "completed" } },
  });
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { header: actualHeader },
  });
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 0, step: 99, chunk: { type: "block-start" } },
  });
  assert.equal(events.some((event) => event.type === "odai/route-applied"), false);
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "block-start" } },
  });
  const startedScope = findEvent(events, (event) => event.type === "odai/responsibility-scope-started").data;
  const applied = findEvent(events, (event) => event.type === "odai/route-applied");
  assert.deepEqual(applied.data, {
    turn: 1,
    step: 1,
    responsibility: "frontend",
    responsibilityScopeId: startedScope.scopeId,
    status: "applied",
    routeMode: "same-turn",
    routeSource: "deployment-config",
    fallbackUsed: false,
    requestedRoute: {
      provider: "provider-frontend",
      model: "model-frontend",
      reasoningEffort: "max",
      maxTokens: 4_096,
    },
    actualRoute: effectiveRequest,
  });
  const routingTool = ctx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_routing_config");
  const shown = await routingTool.execute({ action: "show" }, { agent });
  assert.deepEqual(shown.latestRoute, applied.data);
  assert.deepEqual(shown.responsibilityBudgets.frontend, { source: "responsibility-override", maxTokens: 4_096 });
  const renderedRoute = blockText(routingTool.output.render({}, shown)[0]);
  assert.match(renderedRoute, /In-place responsibility ceilings: frontend=maxTokens=4096 \[responsibility-override\]/u);
  assert.match(renderedRoute, /actual=provider-frontend\/model-frontend \(reasoningEffort=max, maxTokens=4096\)/u);
  const outputTool = ctx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_output_config");
  const shownOutput = await outputTool.execute({ action: "show" }, { agent });
  assert.deepEqual(shownOutput.responsibilityBudgets.frontend, { source: "responsibility-override", maxTokens: 4_096 });
  const override = findEvent(events, (event) => event.type === "odai/output-budget-overridden");
  assert.deepEqual(override.data, {
    turn: 1,
    step: 1,
    responsibility: "frontend",
    responsibilityMaxTokens: 4_096,
    configuredControllerMaxTokens: 500,
    effectiveMaxTokens: 4_096,
    budgetSource: "responsibility-override",
    semantics: "explicit-responsibility-override",
  });

  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 1_000, outputTokens: 4_096 } } },
  });
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1_000, outputTokens: 4_096 },
      message: { content: [{ type: "text", text: "truncated frontend result" }] },
    },
  });
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "max-tokens" } },
  });
  const interruption = findEvent(events, (event) => event.type === "odai/responsibility-interrupted").data;
  assert.equal(interruption.scopeId, startedScope.scopeId);
  assert.equal(interruption.responsibility, "frontend");
  assert.equal(interruption.reason, "max-tokens");
  assert.equal(interruption.effectiveMaxTokens, 4_096);
  assert.equal(interruption.outputTokens, 4_096);

  const diagnosticMessage = { ...userMessage("又被截断，到底是什么问题？"), id: "user-diagnostic" };
  events.push(
    { type: "turn/start", seq: 100, data: { turn: 2 } },
    { type: "user/message", seq: 101, data: diagnosticMessage },
  );
  const diagnosed = await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 2, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [diagnosticMessage],
  }));
  assert.match(diagnosed.messages[1].content[0].text, /Odai verified output-limit interruption/u);
  assert.match(diagnosed.messages[1].content[0].text, /responsibility: frontend/u);
  assert.match(diagnosed.messages[1].content[0].text, /effective maxTokens: 4096/u);
  assert.match(diagnosed.messages[1].content[0].text, /observed outputTokens: 4096/u);
  assert.equal(findLastEvent(events, (event) => event.type === "odai/route-decided").data.action, "direct");
  assert.equal(events.some((event) => event.type === "odai/responsibility-interruption-cleared"), false);
  assert.equal(events.some((event) => event.type === "odai/responsibility-interruption-consumed"), false);
  assert.equal(findEvent(events, (event) => event.type === "odai/responsibility-interruption-preserved").data.scopeId, startedScope.scopeId);
  assert.deepEqual(await request({ agent, turn: 2, step: 1 }, async () => ({ provider: "base", model: "controller" })), {
    provider: "base",
    model: "controller",
    maxTokens: 500,
  });

  const continuationMessage = { ...userMessage("继续"), id: "user-continuation" };
  events.push(
    { type: "turn/start", seq: 200, data: { turn: 3 } },
    { type: "user/message", seq: 201, data: continuationMessage },
  );
  const resumed = await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 3, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [continuationMessage],
  }));
  const resumedDecision = findLastEvent(events, (event) => event.type === "odai/route-decided").data;
  assert.equal(resumedDecision.reasonCode, "RESPONSIBILITY_OUTPUT_LIMIT_CONTINUATION");
  assert.equal(resumedDecision.targetRole, "frontend");
  assert.equal(findEvent(events, (event) => event.type === "odai/responsibility-interruption-resume-requested").data.scopeId, startedScope.scopeId);
  assert.match(resumed.messages[1].content[0].text, /RESPONSIBILITY_OUTPUT_LIMIT_CONTINUATION/u);
  const resumedScope = findLastEvent(events, (event) => event.type === "odai/responsibility-scope-started").data;
  assert.equal(resumedScope.role, "frontend");
  assert.equal(resumedScope.resumeOfScopeId, startedScope.scopeId);
  const resumedRequest = await request({ agent, turn: 3, step: 1 }, async () => ({ provider: "base", model: "controller" }));
  assert.deepEqual(resumedRequest, effectiveRequest);
  actualHeader = { config: resumedRequest };
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { turn: 3, step: 1, header: actualHeader },
  });
  const consumed = findEvent(events, (event) => event.type === "odai/responsibility-interruption-consumed").data;
  assert.equal(consumed.scopeId, startedScope.scopeId);
  assert.equal(consumed.resumedScopeId, resumedScope.scopeId);
  assert.equal(findLastEvent(events, (event) => event.type === "odai/route-applied").data.responsibilityScopeId, resumedScope.scopeId);
});

test("a new authenticated task clears preserved interruption even when a plugin notice follows it", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: { roles: { frontend: { provider: "provider-frontend", model: "model-frontend", maxTokens: 4_096 } } },
  });
  const newTask = { ...userMessage("告诉我现在几点"), id: "new-task" };
  const events: DshEvent[] = [
    {
      type: "odai/responsibility-interrupted",
      data: {
        scopeId: "scope-old-frontend",
        turn: 1,
        step: 1,
        responsibility: "frontend",
        reason: "max-tokens",
        requestedRoute: { provider: "provider-frontend", model: "model-frontend", maxTokens: 4_096 },
        effectiveRoute: { provider: "provider-frontend", model: "model-frontend", maxTokens: 4_096 },
        effectiveMaxTokens: 4_096,
        outputTokens: 4_096,
      },
    },
    { type: "turn/start", seq: 10, data: { turn: 2 } },
    { type: "user/message", seq: 11, data: newTask },
  ];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const pluginNotice = {
    id: "other-plugin-notice",
    role: "user",
    content: [{ type: "text", text: "继续" }],
    source: { kind: "plugin", plugin: "other-plugin" },
  };
  const signal = new AbortController().signal;
  const direct = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 2, step: 1, signal },
    async () => ({ kind: "enter", messages: [newTask, pluginNotice] }),
  );
  assert.equal(direct.messages.length, 2);
  assert.equal(findEvent(events, (event) => event.type === "odai/responsibility-interruption-cleared").data.scopeId, "scope-old-frontend");
  assert.equal(events.some((event) => event.type === "odai/responsibility-interruption-resume-requested"), false);

  const continuation = { ...userMessage("继续"), id: "later-continuation" };
  events.push(
    { type: "turn/start", seq: 12, data: { turn: 3 } },
    { type: "user/message", seq: 13, data: continuation },
  );
  const later = await ctx.captured.handlers.get("agent/pre-step")(
    { agent, turn: 3, step: 1, signal },
    async () => ({ kind: "enter", messages: [continuation] }),
  );
  assert.equal(later.messages.length, 1);
  assert.equal(events.some((event) => event.type === "odai/responsibility-scope-started"), false);
  assert.equal(events.some((event) => event.type === "odai/responsibility-interruption-resume-requested"), false);
});

test("same-turn route mismatch emits an actual receipt and fails closed before tools", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      configPath: resolve(testDshHome, "frontend-route-mismatch", "routing.json"),
      roles: {
        frontend: { provider: "provider-frontend", model: "model-frontend", reasoningEffort: "max" },
      },
    },
  });
  const events: DshEvent[] = [];
  const actualHeader = { config: { provider: "base", model: "controller", reasoningEffort: "high" } };
  const agent = {
    session: {
      header: {},
      events,
      requestHeader() { return actualHeader; },
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("重新设计登录页和首页的信息架构与响应式交互。")],
  }));
  await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller", reasoningEffort: "high" }),
  );
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "request/header",
    data: { header: actualHeader },
  });
  assert.equal(events.some((event) => event.type === "odai/route-applied"), false);
  ctx.captured.handlers.get("session/event")(agent.session, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "block-start" } },
  });

  const receipt = findEvent(events, (event) => event.type === "odai/route-applied").data;
  assert.equal(receipt.status, "mismatch");
  assert.equal(receipt.fallbackUsed, true);
  assert.deepEqual(receipt.actualRoute, actualHeader.config);
  assert.match(requiredString(receipt.error), /same-turn provider mismatch/u);
  assert.match(
    ctx.captured.guards[0]({ callId: "mismatched-route-write", agent, name: "write" }),
    /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u,
  );
  const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_routing_config");
  const shown = await tool.execute({ action: "show" }, { agent });
  assert.equal(shown.latestRoute.status, "mismatch");
  assert.equal(shown.latestRoute.fallbackUsed, true);

  const unverifiedEvents: DshEvent[] = [];
  const unverifiedAgent = {
    session: {
      header: {},
      events: unverifiedEvents,
      append(type: string, data: RuntimeEventData) { unverifiedEvents.push({ type, data }); },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")({ agent: unverifiedAgent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage("重新设计登录页和首页的信息架构与响应式交互。")],
  }));
  await ctx.captured.handlers.get("agent/request")(
    { agent: unverifiedAgent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller" }),
  );
  ctx.captured.handlers.get("session/event")(unverifiedAgent.session, { type: "turn/end", data: { turn: 1 } });
  const unverified = findEvent(unverifiedEvents, (event) => event.type === "odai/route-applied").data;
  assert.equal(unverified.status, "unverified");
  assert.equal(unverified.stopReason, "no-effective-request");
  assert.equal(unverified.actualRoute, undefined);
});

test("frontend missing mapping falls through and an omitted role budget keeps the global ceiling", async () => {
  const outputConfigPath = resolve(testDshHome, "frontend-fallback-output", "output.json");
  const routingConfigPath = resolve(testDshHome, "frontend-fallback-output", "routing.json");
  mkdirSync(resolve(testDshHome, "frontend-fallback-output"), { recursive: true });
  writeFileSync(outputConfigPath, `${JSON.stringify({ schemaVersion: 1, policy: { concise: true, maxTokens: 500 } })}\n`, "utf8");
  const task = userMessage("整体改版这个运维仪表盘，覆盖移动端和交互状态，并用 Playwright 做浏览器验收。");
  const signal = new AbortController().signal;

  const missingCtx = fakeContext();
  apply(missingCtx, { skillPath, output: { configPath: outputConfigPath } });
  const missingEvents: DshEvent[] = [];
  const missingAgent = { session: { header: {}, events: missingEvents, append(type: string, data: RuntimeEventData) { missingEvents.push({ type, data }); } } };
  const missing = await missingCtx.captured.handlers.get("agent/pre-step")(
    { agent: missingAgent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [task] }),
  );
  assert.equal(missing.messages.length, 1);
  assert.equal(findEvent(missingEvents, (event) => event.type === "odai/route-config-missing").data.role, "frontend");

  const boundedCtx = fakeContext();
  apply(boundedCtx, {
    skillPath,
    output: { configPath: outputConfigPath },
    routing: {
      configPath: routingConfigPath,
      roles: {
        planner: { provider: "provider-planner", model: "model-planner", reasoningEffort: "high" },
        frontend: { provider: "provider-frontend", model: "model-frontend", reasoningEffort: "max" },
      },
    },
  });
  const boundedEvents: DshEvent[] = [];
  const boundedAgent = { session: { header: {}, events: boundedEvents, append(type: string, data: RuntimeEventData) { boundedEvents.push({ type, data }); } } };
  await boundedCtx.captured.handlers.get("agent/pre-step")(
    { agent: boundedAgent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [task] }),
  );
  assert.deepEqual(await boundedCtx.captured.handlers.get("agent/request")(
    { agent: boundedAgent, turn: 1, step: 1 },
    async () => ({ provider: "base", model: "controller", maxTokens: 8_000 }),
  ), {
    provider: "provider-frontend",
    model: "model-frontend",
    reasoningEffort: "max",
    maxTokens: 500,
  });
  assert.equal(boundedEvents.some((event) => event.type === "odai/output-budget-overridden"), false);
  assert.deepEqual(findEvent(boundedEvents, (event) => event.type === "odai/output-budget-applied").data, {
    turn: 1,
    step: 1,
    responsibility: "frontend",
    configuredMaxTokens: 500,
    priorMaxTokens: 8_000,
    effectiveMaxTokens: 500,
    budgetSource: "controller-policy",
    semantics: "provider-request-ceiling",
  });
  const routingTool = boundedCtx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_routing_config");
  const shownRouting = await routingTool.execute({ action: "show" }, { agent: boundedAgent });
  const inheritedBudget = {
    source: "controller-policy",
    maxTokens: 500,
    warning: "responsibility-inherits-controller-ceiling",
  };
  assert.deepEqual(shownRouting.responsibilityBudgets, {
    planner: inheritedBudget,
    frontend: inheritedBudget,
  });
  const renderedRouting = blockText(routingTool.output.render({}, shownRouting)[0]);
  assert.match(renderedRouting, /Warning: planner has no explicit maxTokens and inherits the controller ceiling/u);
  assert.match(renderedRouting, /Warning: frontend has no explicit maxTokens and inherits the controller ceiling/u);
  const configuredRouting = await routingTool.execute({
    action: "set",
    responsibility: "frontend",
    provider: "provider-frontend",
    model: "model-frontend",
    reasoningEffort: "max",
  }, { agent: boundedAgent, signal });
  assert.equal(configuredRouting.requiresNextTurn, true);
  assert.deepEqual(configuredRouting.responsibilityBudgets.frontend, shownRouting.responsibilityBudgets.frontend);
  const outputTool = boundedCtx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_output_config");
  const shownOutput = await outputTool.execute({ action: "show" }, { agent: boundedAgent });
  assert.deepEqual(shownOutput.responsibilityBudgets, shownRouting.responsibilityBudgets);
  assert.match(
    blockText(outputTool.output.render({}, shownOutput)[0]),
    /Warning: frontend has no explicit maxTokens and inherits the controller ceiling/u,
  );
  const configuredOutput = await outputTool.execute({
    action: "set",
    mode: "economy",
    maxTokens: 500,
  }, { agent: boundedAgent });
  assert.deepEqual(configuredOutput.responsibilityBudgets, shownRouting.responsibilityBudgets);
});

test("auto mode upgrades an implicit continuation of earlier high-impact context", async () => {
  const ctx = fakeContext();
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          maxTokens: 2_048,
        },
      },
    },
  });

  const highImpact = userMessage("线上退款偶尔重复入账，我看就是确认超时太短。把确认超时改成 30 秒、最多重试 3 次。");
  const continuation = userMessage("继续深入判断刚才这个迁移是否可以安全发布");
  const events: DshEvent[] = [
    { type: "user/message", data: highImpact },
    { type: "user/message", data: userMessage("用一句话重述刚才的结论") },
    { type: "user/message", data: continuation },
  ];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 3,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [continuation],
  }));

  const routeEvents = events.filter((event) => event.type.startsWith("odai/route-"));
  assert.equal(routeEvents[0].type, "odai/route-decided");
  assert.equal(routeEvents[0].data.action, "upgrade");
  assert.equal(routeEvents[0].data.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
  assert.equal(routeEvents[1].type, "odai/route-context");
  assert.equal(routeEvents[2].type, "odai/route-protection");
  assert.equal(routeEvents[3].type, "odai/route-upgrade");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 3, step: 1 },
    async () => ({ provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" }),
  ), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });
});

test("configured auto mode keeps an evidence-grounded planner gap in the current turn", async () => {
  let starts = 0;
  let startRequest: TestSubagentRequest | undefined;
  const ctx = fakeContext({
    subagents: {
      async start(_provider: string, request: UnknownRecord) {
        starts += 1;
        startRequest = asTestSubagentRequest(request);
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: {
                  header: {
                    config: {
                      provider: "openai",
                      model: "gpt-5.6-sol",
                      reasoningEffort: "high",
                    },
                  },
                },
              }],
            },
          },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "independent decision" }],
          }),
          async dispose() {},
        };
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        planner: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          maxTokens: 2_048,
        },
      },
    },
  });

  const events: DshEvent[] = [responsibilityGapEvent("planner")];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请独立规划一下架构选型")],
  }));

  assert.equal(starts, 0);
  assert.equal(startRequest, undefined);
  assert.match(messageText(result.messages[1]), /runtime: auto/u);
  assert.match(messageText(result.messages[1]), /no child was started/u);
  assert.match(messageText(result.messages[1]), /planner responsibility contract/u);
  assert.deepEqual(events.map((event) => event.type), [
    "odai/responsibility-gap",
    "odai/route-decided",
    "odai/responsibility-gap-consumed",
    "odai/route-context",
    "odai/responsibility-scope-started",
    "odai/route-protection",
    "odai/route-upgrade",
  ]);
  assert.equal(events[1].data.action, "upgrade");
  assert.equal(events[6].data.status, "requested");
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => ({ provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max" }),
  ), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });
});

test("configured researcher compresses evidence before planner without replacing the decision route", async () => {
  const starts: TestSubagentRequest[] = [];
  const subagents = {
    async start(_provider: string, request: UnknownRecord) {
      starts.push(asTestSubagentRequest(request));
      return {
        localAgent: {
          session: {
            events: [{
              type: "request/header",
              data: { header: { config: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 } } },
            }],
          },
        },
        result: Promise.resolve({
          stopReason: "completed",
          output: [{ type: "text", text: researchPacketText() }],
        }),
        async dispose() {},
      };
    },
  };
  const ctx = fakeContext({ subagents });
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        researcher: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 },
        planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", maxTokens: 2_048 },
      },
    },
  });
  const events: DshEvent[] = [responsibilityGapEvent("researcher")];
  const agent = {
    session: {
      header: { cwd: researchProjectRoot },
      events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
    },
  };
  const signal = new AbortController().signal;
  const requestText = "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。";
  const result = await ctx.captured.handlers.get("agent/pre-step")({ agent, turn: 1, step: 1, signal }, async () => ({
    kind: "enter",
    messages: [userMessage(requestText)],
  }));

  assert.equal(starts.length, 1);
  assert.equal(starts[0].label, "odai-researcher");
  assert.deepEqual(starts[0].agentOptions, { provider: "openai", model: "gpt-5.6-luna", maxTokens: 500 });
  assert.match(blockText(starts[0].prompt[0]), /no fields beyond this exact shape/u);
  assert.match(blockText(starts[0].prompt[0]), /"claim":"\.\.\.","excerpt":"exact complete cited line"/u);
  assert.match(blockText(starts[0].prompt[0]), /Allowed source scope: the current project root only/u);
  assert.match(blockText(starts[0].prompt[0]), /excerpt must exactly equal the complete cited source line/u);
  assert.equal(result.messages.length, 3);
  assert.match(messageText(result.messages[1]), /Odai bounded researcher evidence packet/u);
  assert.match(messageText(result.messages[1]), /config\/checkout\.json/u);
  assert.match(result.messages[2].content[0].text, /planner responsibility contract/u);
  const researchResult = findEvent(events, (event) => event.type === "odai/research-result");
  assert.equal(researchResult.data.status, "completed");
  assert.equal(researchResult.data.sourceCount, 2);
  assert.equal(researchResult.data.routeSource, "deployment-config");
  assert.equal(researchResult.data.fallbackUsed, false);
  assert.equal(researchResult.data.routeReceiptStatus, "applied");
  assert.deepEqual(researchResult.data.actualRoute, researchResult.data.requestedRoute);
  assert.match(requiredString(researchResult.data.packetDigest), /^[a-f0-9]{64}$/u);
  assert.deepEqual(events.filter((event) => event.type === "odai/route-decided").map((event) => event.data.targetRole), ["planner"]);
  assert.deepEqual(await ctx.captured.handlers.get("agent/request")(
    { agent, turn: 1, step: 1 },
    async () => ({ provider: "openai", model: "controller", reasoningEffort: "max", maxTokens: 8_000 }),
  ), {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxTokens: 2_048,
  });

  const mismatchCtx = fakeContext({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "wrong-researcher", reasoningEffort: "xhigh", maxTokens: 500 } } },
              }],
            },
          },
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: researchPacketText() }] }),
          async dispose() { throw new Error("researcher cleanup failed"); },
        };
      },
    },
  });
  apply(mismatchCtx, {
    skillPath,
    routing: {
      configPath: resolve(testDshHome, "researcher-route-mismatch", "routing.json"),
      roles: {
        researcher: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 },
        planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
    },
  });
  const mismatchEvents = [responsibilityGapEvent("researcher")];
  const mismatchAgent = {
    session: {
      header: { cwd: researchProjectRoot },
      events: mismatchEvents,
      append(type: string, data: RuntimeEventData) { mismatchEvents.push({ type, data }); },
    },
  };
  await mismatchCtx.captured.handlers.get("agent/pre-step")(
    { agent: mismatchAgent, turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [userMessage(requestText)] }),
  );
  const mismatchShowTool = mismatchCtx.captured.tools.find((tool: TestToolSchema) => tool.name === "odai_routing_config");
  const mismatchShown = await mismatchShowTool.execute({ action: "show" }, { agent: mismatchAgent });
  assert.equal(mismatchShown.latestRoute.status, "mismatch");
  assert.equal(mismatchShown.latestRoute.taskStatus, "fallback");
  assert.match(mismatchShown.latestRoute.error, /child model mismatch/u);
  assert.match(mismatchShown.latestRoute.taskError, /provider cleanup failed: researcher cleanup failed/u);
  assert.doesNotMatch(mismatchShown.latestRoute.taskError, /child model mismatch/u);
  const mismatchRendered = blockText(mismatchShowTool.output.render({}, mismatchShown)[0]);
  assert.match(mismatchRendered, /routeError=child model mismatch/u);
  assert.match(mismatchRendered, /taskError=provider cleanup failed: researcher cleanup failed/u);

  const missingPlannerCtx = fakeContext({ subagents });
  apply(missingPlannerCtx, {
    skillPath,
    routing: {
      roles: {
        researcher: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "xhigh", maxTokens: 500 },
      },
    },
  });
  const missingEvents = [responsibilityGapEvent("researcher")];
  const missingAgent = {
    session: {
      header: { cwd: researchProjectRoot },
      events: missingEvents,
      append(type: string, data: RuntimeEventData) { missingEvents.push({ type, data }); },
    },
  };
  const missingResult = await missingPlannerCtx.captured.handlers.get("agent/pre-step")({
    agent: missingAgent,
    turn: 1,
    step: 1,
    signal,
  }, async () => ({ kind: "enter", messages: [userMessage(requestText)] }));
  assert.equal(starts.length, 2);
  assert.equal(missingResult.messages.length, 3);
  assert.match(missingResult.messages[2].content[0].text, /required responsibility: planner/u);
  assert.equal(findEvent(missingEvents, (event) => event.type === "odai/route-config-missing" && event.data.role === "planner").data.status, "unconfigured");
  assert.match(missingPlannerCtx.captured.guards[0]({ callId: "write", agent: missingAgent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
});

test("invalid researcher output is discarded before the planner sees it", async () => {
  const ctx = fakeContext({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: { header: { config: { provider: "openai", model: "researcher-model" } } },
              }],
            },
          },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: researchPacketText({ facts: [
              {
                claim: "The client already retries once.",
                excerpt: "retries=1",
                source: { path: "config/checkout.json", line: 4 },
                authority: "runtime configuration",
              },
              {
                claim: "A missing source proves the provider is unsafe.",
                excerpt: "fabricated",
                source: { path: "logs/missing.md", line: 1 },
                authority: "fabricated record",
              },
            ] }) }],
          }),
          async dispose() {},
        };
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      roles: {
        researcher: { provider: "openai", model: "researcher-model" },
        planner: { provider: "openai", model: "planner-model" },
      },
    },
  });
  const events: DshEvent[] = [responsibilityGapEvent("researcher")];
  const agent = { session: { header: { cwd: researchProjectRoot }, events, append(type: string, data: RuntimeEventData) { events.push({ type, data }); } } };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));
  assert.equal(result.messages.length, 2);
  assert.doesNotMatch(messageText(result.messages[1]), /bounded researcher evidence packet/u);
  const researchResult = findEvent(events, (event) => event.type === "odai/research-result");
  assert.equal(researchResult.data.status, "fallback");
  assert.equal(researchResult.data.routeReceiptStatus, "applied");
  assert.equal(researchResult.data.stopReason, "packet-invalid");
  assert.match(requiredString(researchResult.data.error), /source\.path does not exist/u);
});

test("high-impact execute routing fails closed when the planner is unavailable", async () => {
  const ctx = fakeContext({
    subagents: {
      async start() {
        throw new Error("provider unavailable");
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      mode: "execute",
      provider: "spawn",
      roles: { planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" } },
    },
  });

  const events: DshEvent[] = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const handler = ctx.captured.handlers.get("agent/pre-step");
  const result = await handler({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));

  assert.deepEqual(events.slice(0, 4).map((event) => event.type), [
    "odai/route-decided",
    "odai/route-context",
    "odai/route-result",
    "odai/route-protection",
  ]);
  assert.equal(events[1].data.mode, "bounded-packet");
  assert.equal(events[2].data.status, "fallback");
  assert.equal(events[3].data.source, "route-failure");
  assert.equal(events[3].data.failure, "provider unavailable");
  assert.match(messageText(result.messages[1]), /High-impact fail-closed protection is active/u);
  assert.doesNotMatch(messageText(result.messages[1]), /continue directly/u);

  const guard = ctx.captured.guards[0];
  assert.match(guard({ callId: "write-failed-route", agent, name: "write" }), /^ODAI_HIGH_IMPACT_ROUTE_BLOCKED:/u);
  assert.equal(guard({ callId: "read-failed-route", agent, name: "read" }), undefined);
});

test("ordinary state-backed planner route failure still permits controller fallback", async () => {
  const ctx = fakeContext({
    subagents: {
      async start() {
        throw new Error("provider unavailable");
      },
    },
  });
  apply(ctx, {
    skillPath,
    routing: {
      mode: "execute",
      provider: "spawn",
      roles: { planner: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "high" } },
    },
  });

  const events: DshEvent[] = [responsibilityGapEvent("planner")];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const result = await ctx.captured.handlers.get("agent/pre-step")({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("请独立规划一下架构选型")],
  }));

  assert.equal(events.some((event) => event.type === "odai/route-protection"), false);
  assert.match(messageText(result.messages[1]), /continue directly as controller/u);
  assert.equal(ctx.captured.guards[0]({ callId: "write-normal-fallback", agent, name: "write" }), undefined);
});

test("execute routing rejects a completed child without textual evidence", async () => {
  let disposed = false;
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          result: Promise.resolve({ stopReason: "completed", output: [] }),
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "plan",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(disposed, true);
  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(result.stopReason, "route-empty-output");
  assert.equal(result.error, "child completed without textual evidence");
  assert.equal(result.taskError, "child completed without textual evidence");
  assert.deepEqual(result.output, []);
});

test("execute routing discards output when the actual child model mismatches", async () => {
  let disposed = false;
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          localAgent: {
            session: {
              events: [{
                type: "request/header",
                data: {
                  header: {
                    config: {
                      provider: "openai",
                      model: "gpt-5.6-luna",
                      reasoningEffort: "max",
                    },
                  },
                },
              }],
            },
          },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "untrusted route output" }],
          }),
          async dispose() {
            disposed = true;
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "compare options",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
    roleRoute: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
  });

  assert.equal(disposed, true);
  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "mismatch");
  assert.match(requiredString(result.routeReceiptError), /child model mismatch/u);
  assert.equal(result.stopReason, "route-unverified");
  assert.match(requiredString(result.error), /child model mismatch/u);
  assert.deepEqual(result.output, []);
});

test("execute routing marks a missing child request header unverified", async () => {
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          localAgent: { session: { events: [] } },
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "unverified child output" }],
          }),
          async dispose() {},
        };
      },
    },
    provider: "spawn",
    decision: { role: "reviewer" },
    taskText: "review",
    roleContract: "Canonical reviewer contract.",
    agent: {},
    signal: new AbortController().signal,
    roleRoute: { provider: "openai", model: "reviewer-model" },
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.match(requiredString(result.routeReceiptError), /request\/header did not expose/u);
  assert.equal(result.stopReason, "route-unverified");
  assert.match(requiredString(result.error), /request\/header did not expose/u);
  assert.deepEqual(result.output, []);
});

test("execute routing falls back without claiming evidence on provider failure", async () => {
  const result = await runRoutedRole({
    subagents: {
      async start() {
        throw new Error("provider unavailable");
      },
    },
    provider: "spawn",
    decision: { role: "reviewer" },
    taskText: "review",
    roleContract: "Canonical reviewer contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(result.stopReason, "infrastructure-error");
  assert.equal(result.error, "provider unavailable");
  assert.equal(result.taskError, "provider unavailable");
});

test("execute routing treats provider cleanup failure as untrusted evidence", async () => {
  const result = await runRoutedRole({
    subagents: {
      async start() {
        return {
          result: Promise.resolve({
            stopReason: "completed",
            output: [{ type: "text", text: "must not be trusted" }],
          }),
          async dispose() {
            throw new Error("cleanup timed out");
          },
        };
      },
    },
    provider: "spawn",
    decision: { role: "planner" },
    taskText: "compare options",
    roleContract: "Canonical planner contract.",
    agent: {},
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.routeReceiptStatus, "unverified");
  assert.equal(result.stopReason, "infrastructure-error");
  assert.match(requiredString(result.error), /provider cleanup failed: cleanup timed out/u);
  assert.equal(result.taskError, "provider cleanup failed: cleanup timed out");
  assert.deepEqual(result.output, []);
});

test("the model can persist every user-specified responsibility mapping", async () => {
  const configPath = resolve(testDshHome, "natural-config", "routing.json");
  const ctx = fakeContext();
  const secondRuntimeCtx = fakeContext();
  apply(ctx, { skillPath, routing: { configPath } });
  apply(secondRuntimeCtx, { skillPath, routing: { configPath } });
  const tool = ctx.captured.tools.find((candidate: TestTool) => candidate.name === "odai_routing_config");
  assert.ok(tool);
  assert.match(tool.description, /Never choose a provider, model, reasoning effort, token limit, or price on the user's behalf/u);

  const events: DshEvent[] = [];
  const agent = {
    session: {
      header: {},
      events,
      append(type: string, data: RuntimeEventData) {
        events.push({ type, data });
      },
    },
  };
  const execution = { agent };
  const mappings = {
    researcher: { provider: "provider-r", model: "model-research", reasoningEffort: "low", maxTokens: 512 },
    planner: { provider: "provider-a", model: "model-plan", reasoningEffort: "high", maxTokens: 2_048 },
    reviewer: { provider: "provider-c", model: "model-review", reasoningEffort: "max" },
    frontend: { provider: "provider-frontend", model: "model-frontend", reasoningEffort: "max", maxTokens: 4_096 },
  };
  for (const [responsibility, route] of Object.entries(mappings)) {
    const configured = await tool.execute({ action: "set", responsibility, ...route }, execution);
    assert.deepEqual(configured.roles[responsibility], route);
    assert.equal(configured.requiresNextTurn, true);
  }

  const shown = await tool.execute({ action: "show" }, execution);
  assert.deepEqual(shown.roles, mappings);
  assert.deepEqual(shown.responsibilityBudgets, {
    planner: { source: "responsibility-override", maxTokens: 2_048 },
    frontend: { source: "responsibility-override", maxTokens: 4_096 },
  });
  assert.equal(shown.requiresNextTurn, false);
  const rendered = blockText(tool.output.render({}, shown)[0]);
  assert.match(rendered, /researcher: provider-r\/model-research \(reasoningEffort=low, maxTokens=512\)/u);
  assert.match(rendered, /planner: provider-a\/model-plan \(reasoningEffort=high, maxTokens=2048\)/u);
  assert.match(rendered, /frontend: provider-frontend\/model-frontend \(reasoningEffort=max, maxTokens=4096\)/u);
  assert.match(rendered, /Researcher routing is task-gated but not price-aware[^\n]*does not guarantee lower cost/u);
  assert.equal(events.filter((event) => event.type === "odai/routing-configured").length, 4);

  const preStep = secondRuntimeCtx.captured.handlers.get("agent/pre-step");
  await preStep({
    agent,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [userMessage("checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。")],
  }));
  const inherited = { provider: "base", model: "controller", reasoningEffort: "max" };
  assert.deepEqual(
    await secondRuntimeCtx.captured.handlers.get("agent/request")({ agent, turn: 1, step: 1 }, async () => inherited),
    { provider: "provider-a", model: "model-plan", reasoningEffort: "high", maxTokens: 2_048 },
  );

  const dispatch = {
    researcher: "same-turn",
    planner: "child",
    reviewer: "same-turn",
    frontend: "child",
  } as const;
  for (const [responsibility, mode] of Object.entries(dispatch)) {
    const configured = await tool.execute({ action: "set-dispatch", responsibility, dispatch: mode }, execution);
    assert.ok(isUnknownRecord(configured.dispatch));
    assert.equal(configured.dispatch[responsibility], mode);
  }
  const shownDispatch = await tool.execute({ action: "show" }, execution);
  assert.deepEqual(shownDispatch.dispatch, dispatch);
  assert.deepEqual(shownDispatch.dispatchSources, Object.fromEntries(
    Object.keys(dispatch).map((responsibility) => [responsibility, "persisted-config"]),
  ));
  assert.match(blockText(tool.output.render({}, shownDispatch)[0]), /planner: child \[persisted-config\]/u);

  const removed = await tool.execute({ action: "remove", responsibility: "reviewer" }, execution);
  assert.equal(removed.roles.reviewer, undefined);
  assert.ok(isUnknownRecord(removed.dispatch));
  assert.equal(removed.dispatch.reviewer, "same-turn");
  const resetDispatch = await tool.execute({ action: "reset-dispatch", responsibility: "reviewer" }, execution);
  assert.ok(isUnknownRecord(resetDispatch.dispatch));
  assert.equal(resetDispatch.dispatch.reviewer, undefined);
  assert.throws(
    () => tool.execute({
      action: "set",
      responsibility: "planner",
      provider: "provider-a",
      model: "model-plan",
    }, { agent: { session: { header: { origin: "subagent", delegationDepth: 1 } } } }),
    /child agents may not change/u,
  );
});
