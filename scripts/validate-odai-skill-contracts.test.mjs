import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillText = readFileSync(fileURLToPath(new URL("../skills/odai/SKILL.md", import.meta.url)), "utf8");
const validatorText = readFileSync(fileURLToPath(new URL("./validate-odai-skill.mjs", import.meta.url)), "utf8");

const intentContracts = [
  {
    skill: "行动前须有充分且唯一的意图证据",
    validator: "行动前须有充分且唯一的意图证据",
  },
  {
    skill: "方向性改进有多个合理交付物时",
    validator: "/方向性改进有多个合理交付物",
  },
  {
    skill: "实施、提交或发布授权只作用于已对齐的目标、范围与后果，不能让目标变唯一",
    validator: "不能让目标变唯一",
  },
  {
    skill: "低成本或可撤回不能替代对齐",
    validator: "/低成本或可撤回不能替代对齐/",
  },
  {
    skill: "探索、决定与实施不自动切换",
    validator: "探索、决定与实施不自动切换",
  },
  {
    skill: "用户纠正使目标、范围或授权变化时",
    validator: "/用户纠正使目标、范围或授权变化时",
  },
  {
    skill: "只指出遗漏、未执行或错误完成声明时",
    validator: "/只指出遗漏、未执行或错误完成声明时",
  },
];

test("intent-alignment entry contracts are registered in the canonical validator", () => {
  for (const contract of intentContracts) {
    assert.ok(skillText.includes(contract.skill), `SKILL.md lost intent contract: ${contract.skill}`);
    assert.ok(validatorText.includes(contract.validator), `validator lost intent anchor: ${contract.validator}`);
  }
});
