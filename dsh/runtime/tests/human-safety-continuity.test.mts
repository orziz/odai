import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createHumanSafetyContinuityTool,
  renderHumanSafetyContinuitySection,
} from "../build/human-safety-continuity.mjs";
import { readHumanSafetyContinuityStore } from "../build/human-safety-continuity-store.mjs";
import type { DshAgent, ToolExecution, UnknownRecord } from "../build/runtime-types.mjs";

interface TestAgent extends DshAgent { currentText: string }

function directUserText(agent: DshAgent): string {
  return "currentText" in agent && typeof agent.currentText === "string" ? agent.currentText : "";
}

function execution(agent: DshAgent): ToolExecution {
  return { name: "odai_human_safety_continuity", agent };
}

function entryId(result: { entry?: { id: string } }): string {
  if (!result.entry) throw new Error("expected a continuity entry");
  return result.entry.id;
}

function harness() {
  const root = mkdtempSync(resolve(tmpdir(), "odai-human-safety-continuity-"));
  const storePath = resolve(root, "continuity.json");
  const changes: UnknownRecord[] = [];
  const tool = createHumanSafetyContinuityTool({
    storePath,
    directUserTextFor: directUserText,
    onChanged(_agent, data) { changes.push(data); },
  });
  const agent: TestAgent = { currentText: "", session: { header: {}, snapshotEvents: () => [], append() {} } };
  return { root, storePath, changes, tool, agent };
}

test("continuity requires explicit current-user persistence and exact user-authored values", async (t) => {
  const state = harness();
  t.after(() => rmSync(state.root, { recursive: true, force: true }));
  state.agent.currentText = "我今天觉得心累。";
  assert.throws(() => state.tool.execute({
    action: "add",
    category: "care-preference",
    value: "我今天觉得心累。",
  }, execution(state.agent)), /explicit request/u);

  const value = "当我说撑不住了时，先问我现在是否安全";
  for (const refusal of [
    `请不要跨会话保存这条照护偏好：${value}。`,
    `“请跨会话保存”只是一个引用示例：${value}。`,
    `“请跨会话保存这条照护偏好：${value}”只是一个引用示例。`,
    `'请跨会话保存'只是一个引用示例：${value}。`,
    `> 请跨会话保存这条照护偏好\n${value}。`,
    `这不是要你跨会话保存，只是在讨论：${value}。`,
    `如果我以后要求你跨会话保存，再保存这条照护偏好：${value}。`,
    `等我明天明确说要跨会话保存时再保存：${value}。`,
    `Once I ask tomorrow, save this care preference: ${value}.`,
    `Only after I ask tomorrow, save this care preference: ${value}.`,
    `Save this care preference only if I ask later: ${value}.`,
    `Please save this care preference upon my future request: ${value}.`,
    `只有等我以后明确要求时，才保存这条照护偏好：${value}。`,
  ]) {
    state.agent.currentText = refusal;
    assert.throws(() => state.tool.execute({
      action: "add",
      category: "care-preference",
      value,
    }, execution(state.agent)), /explicit(?: affirmative)? request/u);
    assert.equal(readHumanSafetyContinuityStore(state.storePath).entries.length, 0);
  }

  state.agent.currentText = "请不要保存";
  assert.throws(() => state.tool.execute({
    action: "add",
    category: "care-preference",
    value: "不要",
  }, execution(state.agent)), /explicit(?: affirmative)? request/u);

  state.agent.currentText = `请跨会话保存这条照护偏好：${value}。`;
  const added = await state.tool.execute({ action: "add", category: "care-preference", value }, execution(state.agent));
  assert.equal(added.status, "added");
  assert.equal(added.record.entries.length, 1);
  assert.equal(state.changes.length, 1);
  assert.deepEqual(state.changes[0], {
    action: "add",
    category: "care-preference",
    entryId: entryId(added),
  });

  const quotedValue = "先确认我想要倾听还是建议";
  state.agent.currentText = `请跨会话保存这条照护偏好：“${quotedValue}”。`;
  const quoted = await state.tool.execute({
    action: "add",
    category: "effective-support",
    value: quotedValue,
  }, execution(state.agent));
  assert.equal(quoted.status, "added");

  state.agent.currentText = "请保存模型自己补写的内容";
  assert.throws(() => state.tool.execute({
    action: "add",
    category: "safety-plan",
    value: "联系一个可信任的人",
  }, execution(state.agent)), /byte-for-byte/u);
});

test("continuity rejects ordinary memory content even when the requested category is safety-scoped", async (t) => {
  const state = harness();
  t.after(() => rmSync(state.root, { recursive: true, force: true }));

  for (const [request, value] of [
    ["帮我记住这个项目要用 pnpm 构建", "这个项目要用 pnpm 构建"],
    ["请跨会话保存：这个项目要用 pnpm 构建", "这个项目要用 pnpm 构建"],
    ["Please save this care preference: This project must use pnpm.", "This project must use pnpm."],
    ["请保存：这个项目的安全构建必须使用 pnpm。", "这个项目的安全构建必须使用 pnpm。"],
    ["Please save: Technical safety checks must run with pnpm.", "Technical safety checks must run with pnpm."],
    ["Please save: Care preference: use pnpm for this project.", "Care preference: use pnpm for this project."],
    ["Please save: I own the project's crisis-recovery deployment and use pnpm.", "I own the project's crisis-recovery deployment and use pnpm."],
    ["Please save: When I am overwhelmed by code reviews, use pnpm for the project.", "When I am overwhelmed by code reviews, use pnpm for the project."],
  ]) {
    state.agent.currentText = request;
    assert.throws(() => state.tool.execute({
      action: "add",
      category: "care-preference",
      value,
    }, execution(state.agent)), /human-safety or care content/u);
  }
  assert.equal(readHumanSafetyContinuityStore(state.storePath).entries.length, 0);

  const careValue = "我压力大的时候希望你少问问题";
  state.agent.currentText = `请记住：${careValue}`;
  const added = await state.tool.execute({
    action: "add",
    category: "care-preference",
    value: careValue,
  }, execution(state.agent));
  assert.equal(added.status, "added");

  for (const value of [
    "项目截止期让我焦虑时，请先听我说",
    "我开始怀疑自己时，希望欧黛先陪我说说，不要马上给方案",
    "我内耗时，希望阿岱帮我把事实和自责分开",
    "我希望默认先用欧黛的陪伴风格，需要行动时再用阿岱支撑",
    "When I am overwhelmed by code reviews, give me space.",
    "When deployment incidents make me anxious, give me space.",
  ]) {
    state.agent.currentText = `请记住这条照护偏好：${value}`;
    const workRelatedCare = await state.tool.execute({
      action: "add",
      category: "care-preference",
      value,
    }, execution(state.agent));
    assert.equal(workRelatedCare.status, "added");
  }

  for (const [request, value] of [
    ["把刚才那条更正为：这个项目改用 npm 构建", "这个项目改用 npm 构建"],
    ["Please replace that safety plan entry with: This project must use npm.", "This project must use npm."],
    ["Please replace that entry with: Care preference: use npm for this project.", "Care preference: use npm for this project."],
    ["Please replace that entry with: I own the project's crisis-recovery deployment and use npm.", "I own the project's crisis-recovery deployment and use npm."],
    ["Please replace that entry with: When I am overwhelmed by code reviews, use npm for the project.", "When I am overwhelmed by code reviews, use npm for the project."],
  ]) {
    state.agent.currentText = request;
    assert.throws(() => state.tool.execute({
      action: "replace",
      entryId: entryId(added),
      category: "care-preference",
      value,
    }, execution(state.agent)), /human-safety or care content/u);
  }
  assert.equal(readHumanSafetyContinuityStore(state.storePath).entries[0].value, careValue);
});

test("continuity is visible, correctable, exportable, and physically clearable across tool instances", async (t) => {
  const state = harness();
  t.after(() => rmSync(state.root, { recursive: true, force: true }));
  const original = "心烦时先听我说，不要说教";
  state.agent.currentText = `以后请记住：${original}。`;
  const added = await state.tool.execute({ action: "add", category: "care-preference", value: original }, execution(state.agent));

  const nextSessionTool = createHumanSafetyContinuityTool({
    storePath: state.storePath,
    directUserTextFor: directUserText,
  });
  state.agent.currentText = "查看我的安全照护档案";
  const shown = await nextSessionTool.execute({ action: "show" }, execution(state.agent));
  assert.equal(shown.record.entries[0].value, original);

  const replacement = "心烦时先听我说，再帮我把事情缩小一步";
  state.agent.currentText = `不要把刚才那条更正为：${replacement}。`;
  assert.throws(() => nextSessionTool.execute({
    action: "replace",
    entryId: entryId(added),
    category: "effective-support",
    value: replacement,
  }, execution(state.agent)), /explicit affirmative request/u);
  assert.equal(readHumanSafetyContinuityStore(state.storePath).entries[0].value, original);

  state.agent.currentText = `Only after I ask tomorrow, replace that entry with: ${replacement}.`;
  assert.throws(() => nextSessionTool.execute({
    action: "replace",
    entryId: entryId(added),
    category: "effective-support",
    value: replacement,
  }, execution(state.agent)), /explicit affirmative request/u);

  state.agent.currentText = `把刚才那条更正为：${replacement}。`;
  const replaced = await nextSessionTool.execute({
    action: "replace",
    entryId: entryId(added),
    category: "effective-support",
    value: replacement,
  }, execution(state.agent));
  assert.equal(replaced.status, "replaced");
  assert.equal(replaced.record.entries[0].category, "effective-support");

  state.agent.currentText = "导出我的安全连续性记录";
  const exported = await nextSessionTool.execute({ action: "export" }, execution(state.agent));
  assert.ok(exported.exportJson);
  assert.match(exported.exportJson, /心烦时先听我说/u);
  const rendered = renderHumanSafetyContinuitySection(exported.record);
  assert.ok(rendered);
  assert.match(rendered, /not evidence of the user's current state/u);
  assert.match(rendered, /effective-support/u);

  state.agent.currentText = "请彻底清空全部安全照护档案";
  const cleared = await nextSessionTool.execute({ action: "clear" }, execution(state.agent));
  assert.equal(cleared.record.entries.length, 0);
  assert.equal(existsSync(state.storePath), false);
  assert.equal(readHumanSafetyContinuityStore(state.storePath).entries.length, 0);
});

test("continuity rejects child access and private contact data", async (t) => {
  const state = harness();
  t.after(() => rmSync(state.root, { recursive: true, force: true }));
  state.agent.currentText = "请跨会话保存：需要时联系 138-1234-5678";
  assert.throws(() => state.tool.execute({
    action: "add",
    category: "safety-plan",
    value: "需要时联系 138-1234-5678",
  }, execution(state.agent)), /contact details/u);

  const child: TestAgent = {
    currentText: "查看我的安全档案",
    session: { header: { origin: "subagent" }, snapshotEvents: () => [], append() {} },
  };
  assert.throws(() => state.tool.execute({ action: "show" }, execution(child)), /child agents/u);
});
