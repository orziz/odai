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
  "references/dao/composition.md",
  "references/dao/continuity.md",
  "references/dao/coordination.md",
  "references/dao/verification.md",
  "references/capabilities/design-spec.md",
  "references/capabilities/diagnose.md",
  "references/capabilities/feature-plan.md",
  "references/capabilities/implement-code.md",
  "references/capabilities/review-sslb.md",
  "references/recipes/project-guide.md",
  "references/recipes/ribao.md",
  "references/domains/ui-design.md",
  "references/domains/interactive-systems.md",
  "references/techniques/consensus.md",
  "references/techniques/audit-loop.md",
  "references/techniques/review-full.md",
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
];
for (const relativePath of files) {
  if (retiredPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
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
      "在任何项目检索、工具调用或写入前",
      "所求（唯一可观察结果）",
      "没有“仍缺”就不得继续调用工具",
      "`更完整 / 也许还有 / 安心` 不算缺口",
      "先冻结本轮白名单",
      "证据纠偏优先于直达白名单",
      "**只答不写**",
      "最多一次定位加一次源读取",
      "定位与源读取有先后依赖",
      "每轮只发一个命令",
      "不授权执行该命令或验证答案",
      "答案出现立即收口",
      "**明确局部修改**",
      "其授权以该根因为前提",
      "祈使、紧急语气和精确数值",
      "该手段退出白名单",
      "共享抽象、公共契约或全局语义",
      "不把上层共用改动作为附赠修复",
      "方向、幅度和保护链均成立的证据",
      "不证明保护已端到端生效",
      "拒绝原数值不等于获准采用另一个数值",
      "本轮该参数不写",
      "耦合参数任一缺证，整组不写",
      "保护证据只用三态",
      "verified_end_to_end",
      "不得用“基本保护”模糊降级",
      "不能用泛化目标澄清替代",
      "环境 / 流量边界、单一变量、观察窗口",
      "恢复原值的回退",
      "不串读第二份",
      "建议必须明示“待确认”",
      "进入增强档",
      "`.odai/local.md`",
      "从任务对象自动二选一，只读一份",
      "交付对象同时含 UI 与客户端不构成并读理由",
    ],
  },
  {
    path: "SKILL.md",
    label: "minimal hard boundaries",
    fragments: ["不改写用户已确认", "逐项保留", "难回退动作", "不运行无关测试", "验证覆盖什么就只声明什么", "不能只反对"],
  },
  {
    path: "references/dao/authority.md",
    label: "adaptive authority",
    fragments: ["可自行查证的先查证", "可逆设计探索可以先做", "不自动禁止可逆探索"],
  },
  {
    path: "references/dao/verification.md",
    label: "risk-proportional verification",
    fragments: ["最接近真实使用场景", "implemented_unverified", "不要默认重新实施"],
  },
  {
    path: "references/dao/continuity.md",
    label: "long-task continuity",
    fragments: ["短任务不创建状态文件", "assets/task-state.md", "assets/task-ledger.md", "第二套真相"],
  },
  {
    path: "references/dao/coordination.md",
    label: "truthful agent coordination",
    fragments: [
      "优先主流程直办",
      "不要虚构模型",
      "主流程能够复核",
      "读前门：写入 agent 首次写入前完整读取两者",
      "Review agent 始终 `READ_ONLY`",
      "主流程逐项复验后才关闭",
      "references/techniques/consensus.md",
    ],
  },
  {
    path: "references/dao/composition.md",
    label: "host skill composition",
    fragments: [
      "宿主已提供",
      "文档、表格、演示、PDF",
      "高信号规则",
      "不让用户选择",
      "不扫描 home",
      "## 演进闭环",
      "不自动改 skill",
      "用户明确采纳",
      "提升进 canonical source",
    ],
  },
  {
    path: "references/capabilities/feature-plan.md",
    label: "automatic interactive-system planning",
    fragments: ["references/domains/interactive-systems.md", "不把推荐默认值写成用户决定", "不要为完整而串读"],
  },
  {
    path: "references/capabilities/design-spec.md",
    label: "automatic design domains",
    fragments: [
      "references/domains/ui-design.md",
      "references/domains/interactive-systems.md",
      "不让用户选择领域包",
      "交付前过来源门",
      "开头一条总免责声明不能替代逐项标注",
      "同仓库、同领域或关键词相似不够",
    ],
  },
  {
    path: "references/capabilities/diagnose.md",
    label: "evidence-led diagnosis",
    fragments: ["与症状有直接关系", "相邻函数异常", "局部、可逆", "换正交证据路径", "证据相反或副作用未知时不改"],
  },
  {
    path: "references/capabilities/implement-code.md",
    label: "method-light implementation",
    fragments: ["不强制 TDD、SDD 或 BDD", "不事后包装成 TDD", "准确局部修改"],
  },
  {
    path: "references/domains/interactive-systems.md",
    label: "input completion gate",
    fragments: [
      "交付前逐项核对当前输入方式",
      "触屏交付必须显式包含两块",
      "**触控契约**",
      "**误触复验**",
      "拇指 / 手掌遮挡安全区、触控热区与按钮间距",
      "按下、滑出、抬起、取消 / 中断",
      "真实握持压力态覆盖相邻按钮、滑动经过、多指并发和边缘触控",
      "每项必须覆盖或说明不适用",
    ],
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
    "**道可道，非常道。术无定数，法无定法。**",
    "术法可变，事实、用户决定与底线不可曲",
    "**谋定而后动**",
    "**模型即谋士，攻防兼备**",
    "**看得清、拿得稳、打得准、落得实、守得住、走得远**",
    "**道儒心兵法，五家合一；大道至简**",
    "少干预、正名实、知行相照、审势制胜、守住底线",
    "不作分工、路由或模块",
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
