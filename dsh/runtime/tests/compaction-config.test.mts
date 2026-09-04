import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  COMPACTION_CONFIG_PROMPT,
  COMPACTION_STATE_PROTOCOL,
  applyCompactionStateProtocol,
  applyCompactionTarget,
  createCompactionConfigTool,
  effectiveCompactionTarget,
  readCompactionModelStore,
  resolveCompactionConfigPath,
  resolveCompactionTarget,
} from "../build/compaction-config.mjs";
import type { CompactionConfiguredEvent } from "../build/compaction-config.mjs";
import { acquireOwnedStoreLock } from "../build/store-lock.mjs";
import { isUnknownRecord } from "../build/runtime-types.mjs";
import type { DshMessage, DshSessionsService, ToolExecution } from "../build/runtime-types.mjs";

function testExecution(): ToolExecution {
  return { name: "odai_compaction_config", agent: { session: { header: {}, snapshotEvents: () => [], append() {} } } };
}

function last<T>(values: readonly T[]): T {
  const value = values.at(-1);
  if (value === undefined) throw new Error("expected a final test value");
  return value;
}

test("compaction target validates explicit model options and applies only to compaction", () => {
  assert.deepEqual(resolveCompactionTarget({
    provider: " openai ",
    model: " gpt-5.6-luna ",
    reasoningEffort: " high ",
  }), {
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  });
  assert.throws(() => resolveCompactionTarget({ provider: "openai" }), /\.model must be a non-empty string/u);
  assert.throws(() => resolveCompactionTarget({ provider: "", model: "luna" }), /\.provider must be a non-empty string/u);
  assert.throws(() => resolveCompactionTarget({ provider: "openai", model: "luna", reasoningEffort: " " }), /\.reasoningEffort must be a non-empty string/u);
  assert.throws(() => resolveCompactionTarget({ provider: "openai", model: "luna", effort: "max" }), /unknown fields: effort/u);
  assert.match(COMPACTION_CONFIG_PROMPT, /Never infer or silently choose/iu);
  assert.match(COMPACTION_CONFIG_PROMPT, /reasoning effort/iu);
  assert.match(COMPACTION_CONFIG_PROMPT, /checkpoint integrity protocol/iu);
  assert.match(COMPACTION_CONFIG_PROMPT, /original history/iu);

  const ordinary = { provider: "openai", model: "gpt-5.6-sol" };
  assert.equal(applyCompactionTarget(ordinary, { provider: "openai", model: "gpt-5.6-luna" }), false);
  assert.deepEqual(ordinary, { provider: "openai", model: "gpt-5.6-sol" });

  const compaction = {
    purpose: "compaction",
    provider: "openai",
    model: "gpt-5.6-sol",
    maxTokens: 8_192,
    cacheRetention: "short",
  };
  assert.equal(applyCompactionTarget(compaction, { provider: "openai", model: "gpt-5.6-luna" }), true);
  assert.deepEqual(compaction, {
    purpose: "compaction",
    provider: "openai",
    model: "gpt-5.6-luna",
    maxTokens: 8_192,
    cacheRetention: "short",
  });
  assert.equal(applyCompactionTarget(compaction, { provider: "openai", model: "gpt-5.6-luna" }), false);

  const configuredReasoning = { ...compaction, reasoningEffort: "medium" };
  const configuredTarget = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "high" };
  assert.equal(applyCompactionTarget(configuredReasoning, configuredTarget), true);
  assert.equal(configuredReasoning.reasoningEffort, "high");
  assert.equal(applyCompactionTarget(configuredReasoning, configuredTarget), false);

  const sessions: DshSessionsService = {
    get(sessionId: string) {
      if (sessionId !== "session-route") return undefined;
      return {
        header: {},
        snapshotEvents: () => [],
        append() {},
        requestHeader: () => ({ config: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" } }),
      };
    },
  };
  const upstreamInherited = {
    purpose: "compaction",
    sessionId: "session-route",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  };
  assert.equal(applyCompactionTarget(upstreamInherited, { provider: "openai", model: "gpt-5.6-luna" }, sessions), true);
  assert.equal(upstreamInherited.reasoningEffort, undefined);

  const alreadyTargeted = {
    purpose: "compaction",
    sessionId: "session-route",
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
  };
  assert.equal(applyCompactionTarget(alreadyTargeted, { provider: "openai", model: "gpt-5.6-luna" }, sessions), true);
  assert.equal(alreadyTargeted.reasoningEffort, undefined);
  assert.equal(applyCompactionTarget(alreadyTargeted, { provider: "openai", model: "gpt-5.6-luna" }, sessions), false);

  const sameDurableRoute = {
    purpose: "compaction",
    sessionId: "session-route",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  };
  assert.equal(applyCompactionTarget(sameDurableRoute, { provider: "openai", model: "gpt-5.6-sol" }, sessions), false);
  assert.equal(sameDurableRoute.reasoningEffort, "xhigh");

  const explicitReasoning = { ...upstreamInherited, model: "gpt-5.6-sol", reasoningEffort: "medium" };
  assert.equal(applyCompactionTarget(explicitReasoning, { provider: "openai", model: "gpt-5.6-luna" }, sessions), true);
  assert.equal(explicitReasoning.reasoningEffort, "medium");
  assert.throws(
    () => applyCompactionTarget(Object.freeze({ ...compaction, model: "gpt-5.6-sol" }), { provider: "openai", model: "gpt-5.6-luna" }),
    /immutable request/u,
  );
});

test("configured compaction targets append one strict state protocol without touching inherited or ordinary calls", () => {
  const target = { provider: "openai", model: "gpt-5.6-luna" };
  const originalMessages: DshMessage[] = [{ id: "stock", role: "user", content: [{ type: "text", text: "Stock compaction instruction" }] }];
  const configured = { purpose: "compaction", messages: originalMessages };

  assert.equal(applyCompactionStateProtocol(configured, target), true);
  assert.notEqual(configured.messages, originalMessages);
  assert.equal(configured.messages.length, 2);
  assert.equal(configured.messages[0], originalMessages[0]);
  assert.deepEqual(configured.messages[1].content, [{ type: "text", text: COMPACTION_STATE_PROTOCOL }]);
  assert.deepEqual(configured.messages[1].source, {
    kind: "plugin",
    plugin: "odai-dsh-runtime",
    form: "instructions",
  });
  assert.match(COMPACTION_STATE_PROTOCOL, /SUPERSEDED.*REJECTED/iu);
  assert.match(COMPACTION_STATE_PROTOCOL, /byte-for-byte/iu);
  assert.match(COMPACTION_STATE_PROTOCOL, /self-check/iu);
  assert.equal(applyCompactionStateProtocol(configured, target), false);
  assert.equal(configured.messages.length, 2);

  const inherited = { purpose: "compaction", messages: originalMessages };
  assert.equal(applyCompactionStateProtocol(inherited, undefined), false);
  assert.equal(inherited.messages, originalMessages);
  const ordinary = { purpose: "ordinary", messages: originalMessages };
  assert.equal(applyCompactionStateProtocol(ordinary, target), false);
  assert.equal(ordinary.messages, originalMessages);
  assert.throws(
    () => applyCompactionStateProtocol(Object.freeze({ purpose: "compaction", messages: originalMessages }), target),
    /mutable message envelope/u,
  );
  assert.throws(
    () => applyCompactionStateProtocol({ purpose: "compaction" }, target),
    /mutable message envelope/u,
  );
});

test("compaction model store is atomic, repairable, locked, resettable, and child-protected", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-compaction-config-"));
  try {
    const configPath = resolve(root, "odai", "compaction.json");
    assert.equal(resolveCompactionConfigPath(undefined, { DSH_HOME: root }), configPath);
    assert.throws(() => resolveCompactionConfigPath(""), /non-empty string/u);
    assert.deepEqual(readCompactionModelStore(configPath), { schemaVersion: 1 });
    assert.deepEqual(effectiveCompactionTarget(configPath), { source: "inherit" });

    const events: CompactionConfiguredEvent[] = [];
    const tool = createCompactionConfigTool(configPath, {
      onConfigured(_agent, data) { events.push(data); },
    });
    const execution = testExecution();
    assert.ok(tool.parameters);
    assert.ok(isUnknownRecord(tool.parameters.properties));
    assert.deepEqual(tool.parameters.properties.reasoningEffort, {
      type: "string",
      description: "Optional compaction reasoning effort explicitly supplied by the user.",
    });
    assert.ok(tool.output);
    const outputProperties = tool.output.schema.properties;
    assert.ok(isUnknownRecord(outputProperties));
    const targetSchema = outputProperties.target;
    assert.ok(isUnknownRecord(targetSchema) && isUnknownRecord(targetSchema.properties));
    assert.deepEqual(targetSchema.properties.reasoningEffort, { type: "string" });
    const childTool = createCompactionConfigTool(configPath, { isChild: () => true });
    assert.throws(
      () => childTool.execute({ action: "set", provider: "openai", model: "gpt-5.6-luna" }, execution),
      /child agents may not change/u,
    );

    const initial = await tool.execute({ action: "show" }, execution);
    assert.deepEqual(initial, {
      action: "show",
      configPath,
      source: "inherit",
      requiresNextCompaction: false,
    });
    assert.throws(() => tool.execute({ action: "show", provider: "openai" }, execution), /must be omitted for show/u);
    assert.throws(() => tool.execute({ action: "show", reasoningEffort: "high" }, execution), /must be omitted for show/u);
    assert.throws(() => tool.execute({ action: "set", provider: "openai" }, execution), /\.model must be a non-empty string/u);
    assert.throws(
      () => tool.execute({ action: "set", provider: "openai", model: "luna", reasoningEffort: "" }, execution),
      /\.reasoningEffort must be a non-empty string/u,
    );
    assert.throws(() => tool.execute({ action: "remove", model: "luna" }, execution), /must be omitted for remove/u);

    const configured = await tool.execute({ action: "set", provider: " openai ", model: " gpt-5.6-luna " }, execution);
    assert.deepEqual(configured.target, { provider: "openai", model: "gpt-5.6-luna" });
    assert.equal(configured.source, "persisted");
    assert.equal(configured.requiresNextCompaction, true);
    assert.deepEqual(readCompactionModelStore(configPath), {
      schemaVersion: 1,
      target: { provider: "openai", model: "gpt-5.6-luna" },
    });
    assert.deepEqual(effectiveCompactionTarget(configPath), {
      target: { provider: "openai", model: "gpt-5.6-luna" },
      source: "persisted",
    });
    assert.deepEqual(last(events), {
      action: "set",
      target: { provider: "openai", model: "gpt-5.6-luna" },
    });

    const configuredWithReasoning = await tool.execute({
      action: "set",
      provider: "openai",
      model: "gpt-5.6-luna",
      reasoningEffort: " high ",
    }, execution);
    assert.deepEqual(configuredWithReasoning.target, {
      provider: "openai",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    });
    assert.deepEqual(readCompactionModelStore(configPath).target, configuredWithReasoning.target);
    assert.deepEqual(last(events).target, configuredWithReasoning.target);

    const clearedReasoning = await tool.execute({
      action: "set",
      provider: "openai",
      model: "gpt-5.6-luna",
    }, execution);
    assert.deepEqual(clearedReasoning.target, { provider: "openai", model: "gpt-5.6-luna" });
    assert.deepEqual(readCompactionModelStore(configPath).target, clearedReasoning.target);

    const release = acquireOwnedStoreLock(configPath, "Odai compaction model configuration");
    await assert.rejects(
      async () => tool.execute({ action: "set", provider: "openai", model: "other" }, execution),
      /is being updated/u,
    );
    release();

    writeFileSync(configPath, "{broken\n", "utf8");
    assert.deepEqual(await tool.execute({ action: "show" }, execution), {
      action: "show",
      configPath,
      source: "inherit",
      requiresNextCompaction: false,
      invalidStore: true,
    });
    const repaired = await tool.execute({ action: "set", provider: "openai", model: "gpt-5.6-luna" }, execution);
    assert.equal(repaired.recoveredInvalidStore, true);
    assert.equal(readdirSync(resolve(root, "odai")).some((name) => name.startsWith("compaction.json.invalid-")), true);

    const removed = await tool.execute({ action: "remove" }, execution);
    assert.deepEqual(removed, {
      action: "remove",
      configPath,
      source: "inherit",
      requiresNextCompaction: true,
    });
    assert.equal(existsSync(configPath), false);
    assert.deepEqual(effectiveCompactionTarget(configPath), { source: "inherit" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
