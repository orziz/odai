#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills", "odai");
const failures = [];
const warnings = [];

const skillFile = path.join(skillRoot, "SKILL.md");
if (!existsSync(skillFile)) fail("SKILL.md: missing");
const skillText = readFileSync(skillFile, "utf8");
const entryTokenEstimate = estimateTokens(skillText);
if (entryTokenEstimate > 2600) fail(`SKILL.md: entry token estimate ${entryTokenEstimate} exceeds anti-bloat ceiling 2600`);
else if (entryTokenEstimate > 2200) warn(`SKILL.md: entry token estimate ${entryTokenEstimate} exceeds review threshold 2200`);

validateFrontmatter(skillText);
validateConstitution(skillText);
validateOpenaiMetadata();

const files = listFiles(skillRoot);
const markdownTokenEstimate = files
  .filter((file) => file.endsWith(".md"))
  .reduce((total, file) => total + estimateTokens(readFileSync(path.join(skillRoot, file), "utf8")), 0);
if (markdownTokenEstimate > 15000) fail(`skill markdown estimate ${markdownTokenEstimate} exceeds total anti-bloat ceiling 15000`);
else if (markdownTokenEstimate > 12000) warn(`skill markdown estimate ${markdownTokenEstimate} exceeds total review threshold 12000`);
const requiredFiles = [
  "assets/task-ledger.md",
  "assets/task-state.md",
  "references/dao/authority.md",
  "references/dao/continuity.md",
  "references/dao/leverage.md",
  "references/dao/verification.md",
  "references/capabilities/design.md",
  "references/capabilities/delivery.md",
  "references/capabilities/planning.md",
  "references/capabilities/review.md",
  "references/domains/ui-design.md",
  "references/domains/interactive-systems.md",
  "references/techniques/consensus.md",
  "references/techniques/review-modes.md",
];
for (const relativePath of requiredFiles) {
  if (!files.includes(relativePath)) fail(`${relativePath}: required vNext resource is missing`);
}

const retiredPrefixes = [
  "assets/dao/",
  "references/modules/",
  "references/feature-plan/",
  "references/design-spec/",
  "references/implement-code/",
  "references/review-sslb/",
  "references/game-plan/",
  "references/game-design/",
  "references/recipes/",
];
const retiredFiles = new Set([
  "references/dao/composition.md",
  "references/dao/coordination.md",
  "references/capabilities/diagnose.md",
  "references/capabilities/design-spec.md",
  "references/capabilities/feature-plan.md",
  "references/capabilities/implement-code.md",
  "references/capabilities/review-sslb.md",
  "references/techniques/audit-loop.md",
  "references/techniques/review-full.md",
]);
for (const relativePath of files) {
  if (retiredFiles.has(relativePath) || retiredPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
    fail(`${relativePath}: retired architecture path must not return`);
  }
  if (/references\/techniques\/(?:sdd|tdd|bdd)(?:-|\.)/.test(relativePath)) {
    fail(`${relativePath}: SDD/TDD/BDD must remain optional methods, not first-class technique files`);
  }
}

for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
  const text = readFileSync(path.join(skillRoot, relativePath), "utf8");
  for (const match of text.matchAll(/\b((?:references|assets)\/[A-Za-z0-9_./-]+\.(?:md|mjs|js))\b/g)) {
    const target = match[1];
    const resolved = path.resolve(skillRoot, target);
    if (!isInside(skillRoot, resolved)) fail(`${relativePath}: reference escapes skill root: ${target}`);
    else if (!existsSync(resolved)) fail(`${relativePath}: missing reference target: ${target}`);
  }

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.length > 240) warn(`${relativePath}:${index + 1}: long rule line (${line.length} chars)`);
  });
}

const discoverabilityChecks = [
  {
    path: "SKILL.md",
    label: "adaptive task kernel",
    fragments: [
      "行动开始或判断改变时",
      "事（用户要什么结果）",
      "实（依据与缺口）",
      "法（当前最轻充分路径）",
      "成（验成证据）",
      "界（授权、风险与止点）",
      "五项是随时重判的问题，不是阶段或输出模板",
      "**事**",
      "**实**",
      "**法**",
      "**成**",
      "**界**",
      "是否推进“事”或消除真实缺口",
      "是否有足够事实、授权与必要性",
      "没有真实缺口就不继续检索",
      "## 按势换挡",
      "**直达**",
      "**纠偏**",
      "先把它当假设",
      "只实施能单独闭合原症状的最窄因果切点",
      "替代手段与相邻发现冻结为保持项",
      "相邻异常、自造输入和新增测试只可探索",
      "补丁两者皆有就先删替代项再验证",
      "不以健壮性或“保险起见”为由并做",
      "**展开**",
      "**守险**",
      "交付具体缺口、取证点与通过 / 停止条件",
      "不是固定流程",
      "用户要落地且条件已足够时继续交付",
      "增强不自动扩大范围",
      "默认 Y 是“事”，X 是待证根因",
      "X 即使属实也不自动成为独立目标",
      "只有手段对“事”确有因果必要性时，才随根因获得授权",
      "祈使、紧急语气和精确数值不把它升级成无条件目标",
      "**高影响参数停止门**",
      "准备写入超时、重试、并发、资源、权限或外部副作用参数时，先读 `references/dao/authority.md` 与 `references/dao/verification.md`",
      "方向、幅度与保护链证据须同时成立",
      "未读、任一缺失或证据反对点名值",
      "任一缺失或证据反对点名值，整组本轮不写",
      "精确命令不覆盖此门",
      "拒绝原值不等于获准另拍数值",
      "明确标为“待验证的实验候选”且不实施",
      "待验证的实验候选",
      "声明、局部观测与端到端验证不得互相冒充",
      "停在可逆边界交还裁决",
      "每次只读最可能改变当前决定的最少资料",
      "references/capabilities/planning.md",
      "references/capabilities/design.md",
      "references/capabilities/delivery.md",
      "references/capabilities/review.md",
      "references/dao/continuity.md",
      "references/dao/leverage.md",
      "references/techniques/consensus.md",
      "references/techniques/review-modes.md",
      "`.odai/local.md`",
    ],
  },
  {
    path: "SKILL.md",
    label: "minimal hard boundaries",
    fragments: [
      "**只答不写**",
      "最多一次定位加一次源读取",
      "未见结果不得同批预排候选源、仓库枚举或后续检查",
      "答案出现立即收口",
      "不授权执行所问命令、读取旁路实现或验证答案",
      "**明确局部修改**",
      "冻结用户点名的结果、对象、字段和验收",
      "只读直接实现与现成验证缝，只改冻结行为",
      "相邻错误与重构先作发现",
      "测试只覆盖冻结行为与真实回归风险并沿用项目方式",
      "确认一下",
      "不自动要求新增长期测试",
      "无来源事实、硬指标或范围不得补造",
      "发现不等于获准实施",
      "验证覆盖什么就只声明什么",
      "未读、未做、未跑、未验、未调用都直说",
      "最小安全下一步",
    ],
  },
  {
    path: "references/dao/authority.md",
    label: "adaptive authority",
    fragments: [
      "## 事的所有权",
      "事由用户定义",
      "发现或提案不等于新增目标或实施授权",
      "可自行查证的先查证",
      "可逆设计探索可以先做",
      "不自动禁止可逆探索",
    ],
  },
  {
    path: "references/dao/verification.md",
    label: "risk-proportional verification",
    fragments: [
      "## 何谓成事",
      "用户定义的可观察结果",
      "验证求最小充分证据",
      "最接近真实使用场景",
      "## 高影响参数",
      "只有真实调用链达到 `verified_end_to_end`",
      "才能称已有保护、已幂等或可安全重试",
      "三者不得互相冒充",
      "候选不冒充生产决定",
      "待证明的不变量",
      "跨层关联字段或标识",
      "不要只说“验证幂等、重试或安全”",
      "implemented_unverified",
      "不要默认重新实施",
    ],
  },
  {
    path: "references/dao/continuity.md",
    label: "long-task continuity",
    fragments: ["状态文件是恢复手段，不是交付本身", "短任务不创建状态文件", "assets/task-state.md", "assets/task-ledger.md", "第二套真相"],
  },
  {
    path: "references/dao/leverage.md",
    label: "truthful leverage and coordination",
    fragments: [
      "借力是成事手段，不是进度证据",
      "先服从宿主、项目规则与用户指定资源",
      "不让用户选择内部包",
      "不扫描 home",
      "优先主流程直办",
      "不要虚构模型",
      "主流程能够复核",
      "最小 brief 只含当前所需的事",
      "写入下放前",
      "已获得同版",
      "未携带则在首次写入前读取可访问源",
      "无法访问或确认同版时降为只读回交",
      "审查 agent 始终只读",
      "主流程逐项复验后才关闭",
      "references/techniques/consensus.md",
      "## 演进而不自改",
      "不自动改 skill",
      "提升进 canonical source",
      "候选数量由真实缺口决定",
    ],
  },
  {
    path: "references/capabilities/planning.md",
    label: "decision-oriented planning",
    fragments: ["足以行动的决定", "不制造多方案", "决定已足以行动时停止规划", "不以规格文档存在冒充成事", "不把推荐默认值写成用户决定", "references/domains/interactive-systems.md", "references/capabilities/design.md"],
  },
  {
    path: "references/capabilities/design.md",
    label: "automatic design domains",
    fragments: [
      "references/domains/ui-design.md",
      "references/domains/interactive-systems.md",
      "设计是成事手段",
      "不得放进实现契约",
      "同仓库、同领域或关键词相似不够",
    ],
  },
  {
    path: "references/capabilities/review.md",
    label: "findings-first review",
    fragments: ["findings first", "证据不足不判缺陷", "最小修复方向", "不把清单变成仪式", "references/techniques/review-modes.md", "references/capabilities/design.md", "建议数量不替代风险判断"],
  },
  {
    path: "references/capabilities/delivery.md",
    label: "evidence-led delivery",
    fragments: [
      "用户定义的可交付结果",
      "用户给出的根因与修法是重要假设",
      "定位不是终点",
      "继续最窄完整改动",
      "换正交证据",
      "做最小而完整的改动",
      "不强制 TDD、SDD 或 BDD",
      "不事后包装成 TDD",
      "证据相反或副作用未知时不改",
      "## 命中边界",
    ],
  },
  {
    path: "references/techniques/review-modes.md",
    label: "heavy review modes",
    fragments: ["普通单轮审查不读", "clean 计数归零", "references/dao/leverage.md", "references/capabilities/delivery.md", "正式准入输出", "过程完整性", "不按建议数量机械计数"],
  },
  {
    path: "references/techniques/consensus.md",
    label: "minimum sufficient consensus",
    fragments: ["最少席位", "没有独立增量就不增加席位", "不按多数票", "不伪装"],
  },
  {
    path: "references/domains/ui-design.md",
    label: "context-derived visual language",
    fragments: ["从品牌、内容、场景、平台和既有系统选择视觉语言", "每个显著视觉手段都应服务层级、识别或反馈", "不因流行样式自动加入或禁止"],
  },
  {
    path: "references/domains/interactive-systems.md",
    label: "modality-adaptive input completion",
    fragments: [
      "按实际输入方式补齐会改变结果的契约与压力态",
      "不为每种设备套固定清单",
      "可命中区域、遮挡、手势冲突",
      "按下、移动、滑出、抬起、取消 / 中断",
      "相邻目标、滑动经过、多指或边缘触控中真正相关的压力态",
      "只覆盖当前系统真实支持的输入",
      "弱网、低端机、高同屏或中断恢复会影响判定时",
    ],
  },
  {
    path: "assets/task-state.md",
    label: "dao-aligned task state",
    fragments: ["## 事与界", "用户定义的结果", "授权 / 风险 / 止点", "## 实与成", "验成证据", "## 法", "下一项最轻充分动作"],
  },
];
for (const check of discoverabilityChecks) {
  const fullPath = path.join(skillRoot, check.path);
  if (!existsSync(fullPath)) continue;
  const text = readFileSync(fullPath, "utf8");
  for (const fragment of check.fragments) {
    if (!text.includes(fragment)) fail(`${check.path}: missing ${check.label}: ${fragment}`);
  }
}

if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (failures.length > 0) {
  console.error("Validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`odai skill is valid (${files.length} files, ${warnings.length} warnings, entry estimate ${entryTokenEstimate} tokens, total markdown estimate ${markdownTokenEstimate} tokens).`);
}

function validateFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return fail("SKILL.md: missing or invalid YAML frontmatter");

  const fields = new Map();
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    const field = line.match(/^([a-z0-9-]+):\s*(.*)$/);
    if (!field) {
      fail(`SKILL.md frontmatter line ${index + 2}: expected a top-level key/value`);
      continue;
    }
    fields.set(field[1], unquote(field[2].trim()));
  }

  for (const key of fields.keys()) {
    if (!new Set(["name", "description"]).has(key)) fail(`SKILL.md frontmatter: unexpected key ${key}`);
  }
  const name = fields.get("name") || "";
  const description = fields.get("description") || "";
  if (!/^[a-z0-9-]+$/.test(name)) fail(`SKILL.md frontmatter: invalid name ${JSON.stringify(name)}`);
  if (name !== path.basename(skillRoot)) fail(`SKILL.md frontmatter: name ${name} does not match folder`);
  if (!description) fail("SKILL.md frontmatter: description is required");
  if (description.length > 1024) fail(`SKILL.md frontmatter: description is ${description.length} chars`);
  if (/[<>]/.test(description)) fail("SKILL.md frontmatter: description contains angle brackets");
}

function validateConstitution(text) {
  const section = (text.match(/^## 总纲\r?\n([\s\S]*?)(?=^## )/m)?.[1] || "").replaceAll("\r\n", "\n");
  const fragments = [
    "**事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。**",
    "推进用户定义的事",
    "经验证的可交付结果",
    "主动端出会改变结果的反例",
    "事实、用户决定与底线不可曲",
    "无据不断",
    "无权不越",
    "无必要不造工作",
    "发现不等于获准实施",
  ];
  for (const fragment of fragments) {
    if (!section.includes(fragment)) fail(`SKILL.md: constitutional core missing: ${fragment}`);
  }
}

function validateOpenaiMetadata() {
  const openaiFile = path.join(skillRoot, "agents", "openai.yaml");
  if (!existsSync(openaiFile)) return fail("agents/openai.yaml: missing");
  const text = readFileSync(openaiFile, "utf8");
  requireQuotedField(text, "display_name");
  const shortDescription = requireQuotedField(text, "short_description");
  const defaultPrompt = requireQuotedField(text, "default_prompt");
  if (shortDescription && (shortDescription.length < 25 || shortDescription.length > 64)) {
    fail(`agents/openai.yaml: short_description must be 25-64 chars, got ${shortDescription.length}`);
  }
  if (defaultPrompt && !defaultPrompt.includes("$odai")) fail("agents/openai.yaml: default_prompt must mention $odai");
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

function estimateTokens(value) {
  const text = String(value || "");
  const cjkChars = (text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g) || []).length;
  return Math.ceil(cjkChars + (text.length - cjkChars) / 4);
}

function requireQuotedField(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"));
  if (!match) {
    fail(`agents/openai.yaml: missing quoted ${key}`);
    return "";
  }
  return JSON.parse(match[1]);
}

function listFiles(root) {
  const result = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) result.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }
  walk(root);
  return result.sort();
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}
