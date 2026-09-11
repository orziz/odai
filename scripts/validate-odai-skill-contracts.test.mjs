import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const entryPath = "skills/odai/SKILL.md";
const skillText = readFileSync(resolve(repoRoot, entryPath), "utf8");

// Exercise the real validator on disposable sources. A green baseline prevents
// an unrelated fixture/build failure from masquerading as a rejected mutation.
test("canonical validation rejects removal of the core, five judgments, and intent boundaries", async (t) => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-contract-mutations-"));
  try {
    const policy = JSON.parse(readFileSync(resolve(repoRoot, "version-policy.json"), "utf8"));
    const sources = new Set([
      "skills/odai", "skills/ribao", "version-policy.json",
      "scripts/validate-odai-skill.mjs", "scripts/version-policy.mjs",
      "scripts/canary-isolation.mjs", "scripts/odai-canary-harness.mjs",
      "scripts/claude-canary-runner.mjs", "scripts/grok-canary-runner.mjs",
      "scripts/kimi-canary-runner.mjs", "scripts/antigravity-canary-runner.mjs",
      "scripts/openai-compatible-canary-runner.mjs",
      "scripts/codex-canary-judge.mjs", "scripts/grok-canary-judge.mjs",
      "dsh/runtime/build/skill-bundle.mjs", "dsh/runtime/build/runtime-types.mjs",
      ...policy.managedVersions.map(({ path }) => path).filter((path) => !path.startsWith("skills/")),
    ]);
    for (const source of sources) {
      const target = resolve(scratch, source);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(resolve(repoRoot, source), target, { recursive: true });
    }

    function validate(text, relativePath = entryPath) {
      const target = resolve(scratch, relativePath);
      const original = readFileSync(target, "utf8");
      writeFileSync(target, text);
      try {
        const result = spawnSync(process.execPath, [resolve(scratch, "scripts/validate-odai-skill.mjs")], {
          cwd: scratch,
          encoding: "utf8",
          timeout: 15_000,
        });
        assert.ifError(result.error);
        return { status: result.status, output: result.stdout + result.stderr };
      } finally {
        writeFileSync(target, original);
      }
    }

    const baseline = validate(skillText);
    assert.equal(baseline.status, 0, baseline.output);

    async function rejects(name, mutated, diagnostic, relativePath = entryPath) {
      assert.notEqual(mutated, readFileSync(resolve(scratch, relativePath), "utf8"), `${name}: mutation did not change the fixture`);
      await t.test(name, () => {
        const result = validate(mutated, relativePath);
        assert.equal(result.status, 1, `${name}: invalid source was accepted\n${result.output}`);
        assert.match(result.output, diagnostic);
      });
    }

    const core = skillText.match(/^## 精神内核\r?\n([\s\S]*?)(?=^## )/m)?.[1];
    assert.ok(core, "canonical spiritual core is missing");
    const coreLines = core.split(/\r?\n/).filter((line) => line.startsWith("**") || line.startsWith("- "));
    assert.equal(coreLines.length, 6);
    for (const [index, line] of coreLines.entries()) {
      await rejects(`missing spiritual contract ${index + 1}`, skillText.replace(line, ""), /spiritual core missing contract/u);
    }

    const judgments = [...skillText.matchAll(/^- \*\*([事实法成界])\*\*：([^\r\n]*)/gm)];
    assert.deepEqual(judgments.map((match) => match[1]), ["事", "实", "法", "成", "界"]);
    for (const [line, name] of judgments) {
      await rejects(`missing ${name}`, skillText.replace(line, ""), /current judgment/u);
      await rejects(`empty ${name}`, skillText.replace(line, `- **${name}**：`), /current judgment/u);
      await rejects(`duplicate ${name}`, skillText.replace(line, `${line}\n${line}`), /current judgment/u);
      await rejects(`hollow ${name}`, skillText.replace(line, `- **${name}**：按需处理。`), /current judgment/u);
    }
    const withoutDefinitions = judgments.reduce((text, [line]) => text.replace(line, ""), skillText);
    await rejects("names alone do not preserve the five judgments", withoutDefinitions, /current judgment/u);
    await rejects("definitions outside their owner do not satisfy the contract",
      `${withoutDefinitions}\n${judgments.map(([line]) => line).join("\n")}\n`, /current judgment/u);
    await rejects("swapping responsibilities is a regression",
      skillText.replace(judgments[0][0], `- **事**：${judgments[1][2]}`), /current judgment/u);
    await rejects("five judgments must remain non-staged and implicit",
      skillText.replace("五项不是阶段，也不外显。", ""), /current judgment/u);

    const intentBoundaries = [
      "围绕用户要的结果判断，只保留会改变行动的要求、事实、约束和待决项",
      "目标足够清楚且当前动作已获授权就推进",
      "多种实现方式不等于多种用户目标",
      "上下文无法裁决且分歧会改变结果、价值取舍、写入范围或难撤回后果",
      "委托判断不补事实、授权、扩围或外部后果",
      "材料标为未决的取舍，在用户决定或裁决证据出现前不得写成主方案、默认值或验收",
      "给出权衡和建议并保留决定点，不阻断其余交付",
      "实施、提交或发布授权只对已对齐的目标、范围和后果有效，不能替代缺失的用户决定",
      "低成本或可撤回不能替代对齐",
      "探索、决定与实施不自动切换",
      "实施授权看当前请求、上下文和有效授权",
      "用户纠正目标、范围或授权时，只重对齐受影响部分",
      "指出漏做或错报完成时，在有效授权内补做重验",
      "旧任务证据、计划、摘要或模型自报不替代当前验收",
      "验证随影响面扩展：局部只跑命中检查，共享改动覆盖受影响消费者，不跑无关全量",
      "完成只看当前要求、产物和相称验证",
      "已安装技能明确匹配且能改变结果时完整读取",
      "整体整理须在授权范围内覆盖本体与配套",
      "在授权范围内",
      "不以局部修复代替完整交付",
      "须交给用户决定",
      "共同澄清目标、比较可能性和确认理解",
      "不以少提问或多确认为优劣",
      "形成可检验的解释或方案",
      "最能区分它们的证据",
      "保持完整目标与依赖",
      "推翻关键结论的反例",
      "不机械展开多方案或额外分析",
    ];
    for (const [index, boundary] of intentBoundaries.entries()) {
      await rejects(`missing intent boundary ${index + 1}`, skillText.replace(boundary, ""), /SKILL\.md: missing/u);
    }

    const minimalLookupGate = "先查最可能作答的权威来源，不预先捆绑广泛盘点或旁证，答案充分即停";
    await rejects("simple lookup must not pre-batch broad discovery", skillText.replace(minimalLookupGate, ""), /missing adaptive support/u);

    const supportGate = "预期红测和已查明的环境缺失不单独触发支撑升级";
    await rejects("ordinary feedback is not proof of instability", skillText.replace(supportGate, ""), /missing adaptive support/u);

    const leveragePath = "skills/odai/references/leverage.md";
    const leverage = readFileSync(resolve(repoRoot, leveragePath), "utf8");
    const capabilityBoundaries = [
      ["prospective benefit is not a measured saving", "预期不是已证收益"],
      ["same-model independent review is not a model upgrade", "同一模型的独立上下文可以提供独立复核"],
      ["missing usage constrains cost claims", "用量缺失限制成本结论"],
      ["retry requires new evidence", "只有新的可核查修正依据才支持重试"],
      ["installation still requires authorization", "安装或启用须有用户授权"],
      ["one gap must not produce two dispatch paths", "同一缺口只选一条足够的路径"],
      ["adapters supplement rather than duplicate native capabilities", "适配器只补缺失能力、用户映射或可核对的证据"],
      ["uncertainty is not proof of missing capability", "做法尚未想清楚不等于能力不足"],
      ["autonomy does not require repeated failed attempts", "不为证明自主而反复硬试"],
    ];
    for (const [name, boundary] of capabilityBoundaries) {
      await rejects(name, leverage.replace(boundary, ""), /missing external leverage/u, leveragePath);
    }

    for (const [role, boundaries] of [
      ["planner", ["不预做实施", "不是面向用户的最终交付", "用户原文来源", "验收与停止条件"]],
      ["reviewer", ["不调用工具", "完整验收", "通过、失败和仍未判定", "不自行调度"]],
    ]) {
      const rolePath = `skills/odai/assets/routing-roles/${role}.md`;
      const roleText = readFileSync(resolve(repoRoot, rolePath), "utf8");
      for (const boundary of boundaries) {
        await rejects(`${role} retains ${boundary} without a wire-format card`,
          roleText.replace(boundary, ""), /missing routing contract/u, rolePath);
      }
    }

    const restored = validate(skillText);
    assert.equal(restored.status, 0, restored.output);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
