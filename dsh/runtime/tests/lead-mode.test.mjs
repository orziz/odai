import assert from "node:assert/strict";
import test from "node:test";
import { recognizeLeadSwitch, leadState, leadTaskId, isLeadWriteTool, parseLeadVerdict } from "../build/lead-mode.mjs";
const routes = { planner: { provider: "deepseek", model: "deepseek-v3" }, reviewer: { backend: "local-cli", cli: "claude", model: "opus" } };
for (const text of ["开启主导模式", "这个会话开主导模式", "enable lead mode", "这个会话由 Claude 主导", "这个会话由 DeepSeek 主导", "关闭主导模式", "退出主导模式", "恢复正常模式", "disable lead mode"]) test(`lead switch positive: ${text}`, () => {
  const result = recognizeLeadSwitch(text, routes);
  assert.ok(result);
  assert.equal(result.enabled, !/关闭|退出|恢复|disable/u.test(text));
  if (text.includes("Claude")) assert.deepEqual(result.roles, ["reviewer"]);
  if (text.includes("DeepSeek")) assert.deepEqual(result.roles, ["planner"]);
});
for (const text of ["你来主导", "恢复正常", "服务恢复正常了吗", "开启主导模式吗", "是否开启主导模式", "“开启主导模式”", "`enable lead mode`", "> 开启主导模式", "配置主导模式", "以后默认开启主导模式", "写一下开启主导模式的测试", "给 odai 加一个主导模式开关", "这个会话由 Unknown 主导吗"]) test(`lead switch negative: ${text}`, () => assert.equal(recognizeLeadSwitch(text, routes), undefined));
test("lead mode optional slots, mismatch and evidence rehydration", () => {
  assert.deepEqual(recognizeLeadSwitch("开启主导模式", {}), { enabled: true, roles: ["planner", "reviewer"] });
  assert.deepEqual(recognizeLeadSwitch("开启主导模式", { planner: routes.planner }).roles, ["planner", "reviewer"]);
  assert.equal(recognizeLeadSwitch("这个会话由 Gemini 主导", routes).issue, "mapping-mismatch");
  const both = { planner: routes.reviewer, reviewer: routes.reviewer };
  assert.deepEqual(recognizeLeadSwitch("这个会话由 Claude 主导", both).roles, ["planner", "reviewer"]);
  const events = JSON.parse(JSON.stringify([{ type: "odai/lead-mode", data: { enabled: true, roles: ["planner"] } }, { type: "odai/lead-task", data: { taskMessageId: "task" } }]));
  assert.equal(leadState(events).enabled, true);
  assert.equal(leadTaskId(events, "continue", true), "task");
  assert.equal(leadTaskId(events, "new", false), "new");
  events.push({ type: "odai/lead-mode", data: { enabled: false } });
  assert.equal(leadState(events).enabled, false);
});
for (const verdict of ["pass", "changes-requested"]) {
  for (const line of [`VERDICT: ${verdict}`, `**VERDICT: ${verdict}**`, `\`VERDICT: ${verdict}\``, `VERDICT: ${verdict}.`, `VERDICT： ${verdict}。`, `verdict: ${verdict.toUpperCase()}`, `“VERDICT: ${verdict}”`, `**VERDICT： ${verdict.toUpperCase()}.**`]) {
    test(`lead verdict accepts ${line}`, () => assert.equal(parseLeadVerdict(`notes\n${line}\n\n`), verdict));
  }
  test(`lead verdict accepts repeated ${verdict}`, () => assert.equal(parseLeadVerdict(`VERDICT: ${verdict}\nVERDICT: ${verdict}`), verdict));
}
for (const text of ["", "pass", "VERDICT: pass\nnotes", "VERDICT: pass\nVERDICT: changes-requested", "**verdict： CHANGES-REQUESTED**\n`VERDICT: pass`", "VERDICT: unknown"]) {
  test(`lead verdict invalid: ${text}`, () => assert.equal(parseLeadVerdict(text), "invalid"));
}
test("lead tool boundary treats unknown and shell calls conservatively", () => {
  for (const name of ["read", "glob", "grep", "read_image", "web_search", "web_fetch"]) assert.equal(isLeadWriteTool(name), false);
  for (const name of ["write", "edit", "bash", "unknown"]) assert.equal(isLeadWriteTool(name), true);
});
