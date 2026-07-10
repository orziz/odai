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
const frontmatterMatch = skillText.match(/^---\n([\s\S]*?)\n---/);

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
];

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
