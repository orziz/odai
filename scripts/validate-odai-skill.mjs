#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, "skills", "odai");
const failures = [];
const warnings = [];

const skillFile = path.join(skillRoot, "SKILL.md");
const skillText = readFileSync(skillFile, "utf8");
const entryTokenEstimate = estimateTokens(skillText);
if (entryTokenEstimate > 3200) {
  failures.push(`SKILL.md: entry token estimate ${entryTokenEstimate} exceeds anti-bloat ceiling 3200`);
} else if (entryTokenEstimate > 2600) {
  warnings.push(`SKILL.md: entry token estimate ${entryTokenEstimate} exceeds review threshold 2600`);
}
const constitutionalCore = [
  "- **道——少干预**：能直达就直达，能少读就少读；未稳时不妄作。",
  "- **儒——正名实**：候选不是授权，实施不是验证，自报不是复验。",
  "- **心——知行合一**：治理点已稳即行，以真实结果反照判断。",
  "- **兵——先知后动**：先看证据、环境与胜点；失败补证、换向或止损。",
  "- **法——守硬门**：定义只在 owner 展开；宿主、权限、工具契约高于本 skill。",
  "",
  "**模型即谋士**：主动端出相邻价值、二阶后果、风险与备路；不越权、不代拍。",
].join("\n");
const generalSection = skillText.match(/^## 总纲\r?\n([\s\S]*?)(?=^## )/m)?.[1] || "";
if (!generalSection.includes(constitutionalCore)) {
  failures.push("SKILL.md: constitutional core changed without updating the explicit ratification gate");
}
const frontmatterMatch = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

if (!frontmatterMatch) {
  failures.push("SKILL.md: missing or invalid YAML frontmatter");
} else {
  const fields = new Map();
  for (const [index, line] of frontmatterMatch[1].split(/\r?\n/).entries()) {
    const match = line.match(/^([a-z0-9-]+):\s*(.*)$/);
    if (!match) {
      failures.push(`SKILL.md frontmatter line ${index + 2}: expected a top-level key/value`);
      continue;
    }
    fields.set(match[1], unquote(match[2].trim()));
  }

  const allowed = new Set(["name", "description"]);
  for (const key of fields.keys()) {
    if (!allowed.has(key)) failures.push(`SKILL.md frontmatter: unexpected key ${key}`);
  }

  const name = fields.get("name") || "";
  const description = fields.get("description") || "";
  if (!/^[a-z0-9-]+$/.test(name)) failures.push(`SKILL.md frontmatter: invalid name ${JSON.stringify(name)}`);
  if (name !== path.basename(skillRoot)) failures.push(`SKILL.md frontmatter: name ${name} does not match folder`);
  if (!description) failures.push("SKILL.md frontmatter: description is required");
  if (description.length > 1024) failures.push(`SKILL.md frontmatter: description is ${description.length} chars`);
  if (/[<>]/.test(description)) failures.push("SKILL.md frontmatter: description contains angle brackets");
}

const openaiFile = path.join(skillRoot, "agents", "openai.yaml");
if (!existsSync(openaiFile)) {
  failures.push("agents/openai.yaml: missing");
} else {
  const openaiText = readFileSync(openaiFile, "utf8");
  requireQuotedField(openaiText, "display_name");
  const shortDescription = requireQuotedField(openaiText, "short_description");
  const defaultPrompt = requireQuotedField(openaiText, "default_prompt");
  if (shortDescription && (shortDescription.length < 25 || shortDescription.length > 64)) {
    failures.push(`agents/openai.yaml: short_description must be 25-64 chars, got ${shortDescription.length}`);
  }
  if (defaultPrompt && !defaultPrompt.includes("$odai")) {
    failures.push("agents/openai.yaml: default_prompt must mention $odai");
  }
}

const files = listFiles(skillRoot);
for (const relativePath of files) {
  if (!relativePath.endsWith(".md")) continue;
  const fullPath = path.join(skillRoot, relativePath);
  const text = readFileSync(fullPath, "utf8");
  for (const match of text.matchAll(/`((?:references|assets)\/[^`\n]+?\.(?:md|mjs|js))`/g)) {
    const target = match[1];
    if (target.includes("...") || target.includes("<")) continue;
    const resolved = path.resolve(skillRoot, target);
    if (!isInside(skillRoot, resolved)) failures.push(`${relativePath}: reference escapes skill root: ${target}`);
    else if (!existsSync(resolved)) failures.push(`${relativePath}: missing reference target: ${target}`);
  }

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.length > 220) warnings.push(`${relativePath}:${index + 1}: long rule line (${line.length} chars)`);
  });
}

const ownerMarkers = [
  { marker: "需求账本", owner: "references/feature-plan/planning-playbook.md" },
  { marker: "对症红信号", owner: "references/modules/implement-code.md" },
  { marker: "执行编排账本", owner: "references/dao/execution-orchestration.md" },
  { marker: "生命周期状态以本节为唯一 owner", owner: "references/dao/verification-contract.md" },
];

const discoverabilityChecks = [
  {
    path: "SKILL.md",
    fragments: [".odai/local.md", "references/dao/local-overlay.md"],
    label: "local overlay detection chain",
  },
  {
    path: "SKILL.md",
    fragments: ["不读被排除模块"],
    label: "excluded adjacent-domain rule",
  },
  {
    path: "references/dao/inquiry-discipline.md",
    fragments: ["references/dao/agent-routing-gate.md"],
    label: "capability escalation chain",
  },
  {
    path: "SKILL.md",
    fragments: ["自造输入", "不宣称修复"],
    label: "cross-layer bug stop trigger",
  },
  {
    path: "references/dao/diagnose-kit.md",
    fragments: ["偶发 / 跨层写入硬门"],
    label: "cross-layer bug write gate",
  },
  {
    path: "references/review-sslb/ui-aesthetic-review.md",
    fragments: ["真实性先手"],
    label: "UI trust-evidence review gate",
  },
  {
    path: "references/modules/implement-code.md",
    fragments: ["完整命中集合", "旁路 / 兼容 / 误改风险", "覆盖回扫与相关测试"],
    label: "broad-scope pre-write triad",
  },
  {
    path: "references/review-sslb/ui-aesthetic-review.md",
    fragments: ["应消失或出现的可见现象", "逐项通过条件"],
    label: "UI unavailable-evidence retest contract",
  },
  {
    path: "SKILL.md",
    fragments: ["验收环境不可用", "必须先读完 `references/dao/verification-contract.md`", "未读不得实施或收口"],
    label: "unavailable-verification load gate",
  },
  {
    path: "references/dao/verification-contract.md",
    fragments: ["复验对象", "动作 / 环境", "可判定通过条件"],
    label: "implemented-unverified closure triad",
  },
];

for (const check of discoverabilityChecks) {
  const text = readFileSync(path.join(skillRoot, check.path), "utf8");
  for (const fragment of check.fragments) {
    if (!text.includes(fragment)) failures.push(`${check.path}: missing ${check.label}: ${fragment}`);
  }
}

for (const { marker, owner } of ownerMarkers) {
  let foundInOwner = false;
  for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(path.join(skillRoot, relativePath), "utf8");
    if (!text.includes(marker)) continue;
    if (relativePath === owner) foundInOwner = true;
    else failures.push(`${relativePath}: rule marker ${marker} belongs only in ${owner}`);
  }
  if (!foundInOwner) failures.push(`${owner}: missing owner marker ${marker}`);
}

for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
  const text = readFileSync(path.join(skillRoot, relativePath), "utf8");
  if (text.includes("需求条目账本")) {
    failures.push(`${relativePath}: deprecated duplicate term 需求条目账本`);
  }
  const readyLineNumbers = text
    .split(/\r?\n/)
    .flatMap((line, index) => line.includes("`ready`") ? [index + 1] : []);
  for (const lineNumber of readyLineNumbers) {
    if (!isAllowedLegacyReady(relativePath, text, lineNumber)) {
      failures.push(`${relativePath}:${lineNumber}: deprecated ambiguous lifecycle state ready`);
    }
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
  console.log(`odai skill is valid (${files.length} files, ${warnings.length} warnings).`);
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
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
    failures.push(`agents/openai.yaml: missing quoted ${key}`);
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

function isAllowedLegacyReady(relativePath, text, lineNumber) {
  const lines = text.split(/\r?\n/);
  if (relativePath === "SKILL.md") {
    const line = lines[lineNumber - 1];
    return line.includes("旧版 `ready`") && line.includes("references/dao/dao-shu-fa-playbook.md");
  }
  if (relativePath !== "references/dao/verification-contract.md") return false;

  const ownerHeading = lines.findIndex((line) => line === "## 承接与旧状态迁移");
  if (ownerHeading < 0 || lineNumber < ownerHeading + 1) return false;
  const nextHeading = lines.findIndex((line, index) => index > ownerHeading && /^#{1,3}\s/.test(line));
  return nextHeading < 0 || lineNumber <= nextHeading;
}
