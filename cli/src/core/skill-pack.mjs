import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function loadSkillPack({ repoRoot = process.cwd() } = {}) {
  const skillRoot = await resolveSkillRoot({ repoRoot });
  const entry = path.join(skillRoot, "SKILL.md");
  const entryText = await readFile(entry, "utf8");
  const supportFiles = await listMarkdown(skillRoot);
  const entrySha256 = sha256(entryText);
  return {
    name: "odai",
    root: skillRoot,
    entry,
    entryText,
    entrySha256,
    supportFiles,
    selectReferences: (options) => selectSkillReferences(options),
    render: (options) => renderPromptPack({ skillRoot, entryText, ...options }),
  };
}

/**
 * Choose skill reference files by task text. Always includes dao governance
 * baseline; domain modules are attached only on clear module signals so
 * everyday tasks do not bloat the prompt.
 */
export function selectSkillReferences({ task = "", mode = "agent_loop", includeGovernance = true } = {}) {
  const refs = new Set();
  if (includeGovernance) {
    refs.add("references/modules/dao.md");
    refs.add("references/dao/interaction-contract.md");
  }
  const text = String(task || "");
  if (!text.trim()) {
    return [...refs];
  }

  // Prefer explicit module ids / clear task verbs over broad nouns like "代码" or "plan".
  if (/\breview-sslb\b|三省六部|code\s*review|代码审查|审这个\s*diff|review\s+(this\s+)?diff/i.test(text)) {
    refs.add("references/modules/review-sslb.md");
  }
  if (
    /\bimplement-code\b|实现代码|落地实现|修复这个\s*bug|fix\s+this\s+bug|refactor\s+this|按\s*tdd|补测试并实现/i.test(text)
  ) {
    refs.add("references/modules/implement-code.md");
  }
  if (/\bfeature-plan\b|规格规划|需求规格|方案取舍|写规格|需求条目/i.test(text)) {
    refs.add("references/modules/feature-plan.md");
  }
  if (/\bdesign-spec\b|设计说明|交互设计|页面状态矩阵|ui\s*spec/i.test(text)) {
    refs.add("references/modules/design-spec.md");
  }
  if (/\bgame-plan\b|\bgame-design\b|游戏策划|游戏视觉|数值策划|关卡设计/i.test(text)) {
    refs.add("references/modules/game-plan.md");
  }
  if (/\bproject-guide\b|项目说明|接手基线|整理\s*readme|write\s+(the\s+)?readme/i.test(text)) {
    refs.add("references/modules/project-guide.md");
  }
  if (/\bribao\b|写日报|commit\s*message|pr\s*message|整理\s*pr/i.test(text)) {
    refs.add("references/modules/ribao.md");
  }
  if (
    /\bagent-governance\b|合议模式|多模型合议|独立挑战|spawn\s*subagent|下放\s*agent|consensus\s*mode/i.test(text)
  ) {
    refs.add("references/dao/agent-governance.md");
  }
  if (mode === "subagent" && !refs.has("references/dao/agent-governance.md")) {
    refs.add("references/dao/agent-governance.md");
  }
  return [...refs];
}

async function resolveSkillRoot({ repoRoot = process.cwd() } = {}) {
  const workspaceRoot = path.join(repoRoot, "skills", "odai");
  if (await hasSkillEntry(workspaceRoot)) {
    return workspaceRoot;
  }
  const packagedRoot = path.join(packageRoot(), "skills", "odai");
  if (await hasSkillEntry(packagedRoot)) {
    return packagedRoot;
  }
  const developmentRoot = path.join(packageRoot(), "..", "skills", "odai");
  if (await isRepositoryCheckout() && await hasSkillEntry(developmentRoot)) {
    return developmentRoot;
  }
  throw new Error(`odai skill pack not found. Expected ${workspaceRoot} or bundled package skills/odai.`);
}

async function hasSkillEntry(skillRoot) {
  try {
    await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function isRepositoryCheckout() {
  try {
    await stat(path.join(packageRoot(), "..", ".git"));
    return path.basename(packageRoot()) === "cli";
  } catch {
    return false;
  }
}

export async function renderPromptPack({ skillRoot, entryText, references = [] }) {
  const chunks = ["# odai skill entry", entryText.trimEnd()];

  for (const relativePath of references) {
    if (!relativePath.endsWith(".md")) {
      throw new Error(`Only markdown skill references can be rendered: ${relativePath}`);
    }
    const fullPath = path.join(skillRoot, relativePath);
    const text = await readFile(fullPath, "utf8");
    chunks.push(`# odai reference: ${relativePath}`, text.trimEnd());
  }

  return `${chunks.join("\n\n")}\n`;
}

/**
 * Compose odai (system governance) + optional external craft skills.
 * External skills never replace odai; they append as secondary craft layers.
 */
export async function composeTaskPromptPack({
  odaiPack,
  odaiReferences = [],
  externalSkills = [],
} = {}) {
  const base = await odaiPack.render({ references: odaiReferences });
  if (!Array.isArray(externalSkills) || externalSkills.length === 0) {
    return {
      promptPack: base,
      externalSkillNames: [],
      bytes: base.length,
    };
  }

  const chunks = [
    base.trimEnd(),
    "",
    "# external craft skills (secondary)",
    "The following skills provide domain craft only. They do not override odai governance,",
    "confirmation, authorization, evidence standards, or completion rights.",
    "",
  ];
  const names = [];
  for (const skill of externalSkills) {
    if (!skill?.name || skill.name === "odai") continue;
    const text = typeof skill.entryText === "string"
      ? skill.entryText
      : skill.entry
        ? await readFile(skill.entry, "utf8")
        : "";
    if (!text.trim()) continue;
    names.push(skill.name);
    chunks.push(
      `# external skill: ${skill.name} (${skill.scope || "unknown"}:${skill.sourceKind || "skills"})`,
      text.trimEnd(),
      "",
    );
  }
  const promptPack = `${chunks.join("\n").trimEnd()}\n`;
  return {
    promptPack,
    externalSkillNames: names,
    bytes: promptPack.length,
  };
}

async function listMarkdown(root) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.relative(root, fullPath).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  return files.sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
