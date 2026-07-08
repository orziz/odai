import { readFile, readdir } from "node:fs/promises";
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
    render: (options) => renderPromptPack({ skillRoot, entryText, ...options }),
  };
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
