import assert from "node:assert/strict";
import test from "node:test";

import {
  ODAI_CONTEXTUAL_TOOL_NAMES,
  activeOdaiToolNames,
  classifyContextActivation,
  estimateContextTokens,
  estimateToolSchemaTokens,
  inactiveOdaiToolNames,
} from "../build/context-activation.mjs";

test("ordinary work exposes only the compact core tools", () => {
  const activation = classifyContextActivation("把按钮文案改清楚并运行现有测试");
  assert.deepEqual(activation, {
    care: false,
    safety: false,
    routingConfig: false,
    skillSource: false,
    skillEvolution: false,
    outputConfig: false,
    compactionConfig: false,
    memory: false,
    continuity: false,
  });
  const active = activeOdaiToolNames(activation);
  assert.deepEqual(active, ["odai_context_capability", "odai_responsibility_gap", "odai_reference"]);
  assert.deepEqual(inactiveOdaiToolNames(active), ODAI_CONTEXTUAL_TOOL_NAMES);
  assert.deepEqual(activeOdaiToolNames(activation, { responsibilityReturn: true }), [
    "odai_context_capability",
    "odai_responsibility_gap",
    "odai_responsibility_return",
  ]);
  assert.deepEqual(activeOdaiToolNames(activation, { child: true }), []);
});

test("care and crisis signals activate separate contracts without model configuration", () => {
  const care = classifyContextActivation("我最近很焦虑，总怀疑自己会犯错，脑子反复纠结");
  assert.equal(care.care, true);
  assert.equal(care.safety, false);
  assert.deepEqual(activeOdaiToolNames(care), ["odai_context_capability", "odai_responsibility_gap", "odai_reference", "odai_human_care"]);

  const crisis = classifyContextActivation("我越来越绝望，觉得活不下去了");
  assert.equal(crisis.care, false);
  assert.equal(crisis.safety, true);
  assert.deepEqual(activeOdaiToolNames(crisis), ["odai_context_capability", "odai_responsibility_gap", "odai_reference", "odai_human_safety"]);
  assert.equal(crisis.routingConfig, false);
  assert.equal(crisis.memory, false);

  const style = classifyContextActivation("这次请用欧黛的方式，先听我说");
  assert.equal(style.care, true);
  assert.equal(style.safety, false);
  assert.equal(style.routingConfig, false);
  assert.equal(style.memory, false);
});

test("low-frequency control tools appear only for matching direct intent", () => {
  const cases: Array<readonly [string, ReturnType<typeof activeOdaiToolNames>[number]]> = [
    ["请显示当前所有职责模型映射", "odai_routing_config"],
    ["规划职责改成 child", "odai_routing_config"],
    ["验收改成同轮调度", "odai_routing_config"],
    ["把 Odai skill 来源设置成 bundled", "odai_skill_source_config"],
    ["查看 Odai 治理演化 generation", "odai_skill_evolution"],
    ["把输出模式改成 economy", "odai_output_config"],
    ["这个会话放开上限", "odai_output_config"],
    ["这个会话能不能放开上限？", "odai_output_config"],
    ["Can I remove the output cap for this session?", "odai_output_config"],
    ["查看 compaction model 配置", "odai_compaction_config"],
    ["以后默认使用 npm，请记住", "odai_memory"],
    ["导出我的跨会话安全照护档案", "odai_human_safety_continuity"],
  ];
  for (const [text, expected] of cases) {
    assert.ok(activeOdaiToolNames(classifyContextActivation(text)).includes(expected), `${expected} should activate for ${text}`);
  }
});

test("context budget estimator matches DSH fixed-density pricing", () => {
  assert.equal(estimateContextTokens("12345"), 2);
  assert.equal(estimateToolSchemaTokens([]), 0);
  const tools = [{ name: "x", description: "y", parameters: { type: "object" } }];
  const wire = JSON.stringify(tools);
  assert.equal(estimateToolSchemaTokens(tools), Math.ceil(wire.length / 4) + 4);
});
