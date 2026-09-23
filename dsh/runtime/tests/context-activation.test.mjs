import assert from "node:assert/strict";
import test from "node:test";
import {
  ODAI_CONTEXTUAL_TOOL_NAMES,
  activeOdaiToolNames,
  classifyContextActivation,
  inactiveOdaiToolNames,
} from "../build/context-activation.mjs";
import { responsibilityRoutingAvailable } from "../build/runtime-support.mjs";
test("ordinary work exposes only the compact core tools", () => {
  const activation = classifyContextActivation("把按钮文案改清楚并运行现有测试");
  assert.deepEqual(activation, {
    care: false,
    safety: false,
    routingConfig: false,
    skillSource: false,
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
  assert.deepEqual(activeOdaiToolNames(care), [
    "odai_context_capability",
    "odai_responsibility_gap",
    "odai_reference",
    "odai_human_care",
  ]);
  const crisis = classifyContextActivation("我越来越绝望，觉得活不下去了");
  assert.equal(crisis.care, false);
  assert.equal(crisis.safety, true);
  assert.deepEqual(activeOdaiToolNames(crisis), [
    "odai_context_capability",
    "odai_responsibility_gap",
    "odai_reference",
    "odai_human_safety",
  ]);
  assert.equal(crisis.routingConfig, false);
  assert.equal(crisis.memory, false);
  const style = classifyContextActivation("这次请用欧黛的方式，先听我说");
  assert.equal(style.care, true);
  assert.equal(style.safety, false);
  assert.equal(style.routingConfig, false);
  assert.equal(style.memory, false);
});
test("low-frequency control tools appear only for matching direct intent", () => {
  const cases = [
    ["请显示当前所有职责模型映射", "odai_routing_config"],
    ["规划职责改成 child", "odai_routing_config"],
    ["验收改成同轮调度", "odai_routing_config"],
    ["把 Odai skill 来源设置成 bundled", "odai_skill_source_config"],
    ["把输出模式改成 economy", "odai_output_config"],
    ["这个会话放开上限", "odai_output_config"],
    ["这个会话能不能放开上限？", "odai_output_config"],
    ["Can I remove the output cap for this session?", "odai_output_config"],
    ["查看 compaction model 配置", "odai_compaction_config"],
    ["以后默认使用 npm，请记住", "odai_memory"],
    ["导出我的跨会话安全照护档案", "odai_human_safety_continuity"],
  ];
  for (const [text, expected] of cases) {
    assert.ok(
      activeOdaiToolNames(classifyContextActivation(text)).includes(expected),
      `${expected} should activate for ${text}`,
    );
  }
});
test("responsibility proposals are exposed only when some responsibility can route", () => {
  const activation = classifyContextActivation("把按钮文案改清楚");
  const planner = { provider: "openai", model: "planner" };
  const snapshot = (roles) => ({ snapshot: { roles, sources: {}, dispatch: {} } });
  assert.equal(responsibilityRoutingAvailable("off", snapshot({ planner })), false);
  assert.equal(responsibilityRoutingAvailable("auto", snapshot({ planner: undefined, reviewer: undefined })), false);
  assert.equal(responsibilityRoutingAvailable("auto", snapshot({ planner })), true);
  // An invalid store keeps the proposal path so its fail-closed notice still reaches the controller.
  assert.equal(responsibilityRoutingAvailable("auto", { error: "invalid", detail: "bad json" }), true);
  assert.equal(activeOdaiToolNames(activation, { responsibilityRouting: false }).includes("odai_responsibility_gap"), false);
  assert.equal(activeOdaiToolNames(activation, { responsibilityRouting: true }).includes("odai_responsibility_gap"), true);
});
