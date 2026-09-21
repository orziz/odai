#!/usr/bin/env node

// File integrity only; wording, meaning and model quality are not unit tests.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assertRepositoryVersionPolicy } from "./version-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const selected = process.argv[2];
  if (process.argv.length > 3) throw new Error("usage: validate-odai-skill.mjs [skill-directory]");
  if (!selected) assertRepositoryVersionPolicy({ repoRoot });
  const roots = selected ? [path.resolve(selected)] : ["odai", "odai-orchestration", "ribao"].map(name => path.join(repoRoot, "skills", name));
  for (const root of roots) {
    const name = path.basename(root);
    const files = listFiles(root);
    const entry = readFileSync(localTarget(root, "SKILL.md"), "utf8");
    const match = entry.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
    if (!match) throw new Error(`${name}/SKILL.md: missing YAML frontmatter`);
    const metadata = parse(match[1]);
    if (metadata?.name !== name || typeof metadata.description !== "string" || !metadata.description.trim()) throw new Error(`${name}: name and description are required`);
    if (!entry.slice(match[0].length).trim()) throw new Error(`${name}: empty skill body`);
    const ui = parse(readFileSync(localTarget(root, "agents/openai.yaml"), "utf8"));
    for (const field of ["display_name", "short_description", "default_prompt"]) {
      if (typeof ui?.interface?.[field] !== "string" || !ui.interface[field].trim()) throw new Error(`${name}: missing interface.${field}`);
    }
    if (files.includes("manifest.json")) {
      const manifest = JSON.parse(readFileSync(localTarget(root, "manifest.json"), "utf8"));
      if (manifest.name !== name || !Array.isArray(manifest.requiredFiles)) throw new Error(`${name}: invalid manifest`);
      if (JSON.stringify(files.filter(file => file !== "manifest.json").sort()) !== JSON.stringify([...manifest.requiredFiles].sort())) throw new Error(`${name}: requiredFiles must match packaged files`);
      for (const file of manifest.requiredFiles) localTarget(root, file);
    }
    let referenceTokens = 0;
    for (const file of files.filter(file => file.endsWith(".md"))) {
      const text = readFileSync(localTarget(root, file), "utf8");
      if (!text.trim()) throw new Error(`${name}/${file}: empty Markdown resource`);
      for (const match of text.matchAll(/`((?:references|assets|scripts)\/[A-Za-z0-9_./-]+)`/gu)) localTarget(root, match[1]);
      if (file.startsWith("references/")) referenceTokens += estimateTokens(text);
    }
    console.log(`${name}: entry body ~${estimateTokens(entry.slice(match[0].length).trim())} tokens; reference files total ~${referenceTokens} tokens (CJK=1, other UTF-16 units/4; observation only, not per-turn usage).`);
  }
  console.log("Skill files are valid: metadata, declared resources and local references.");
} catch (error) {
  console.error(`Skill structure check failed: ${error.message}`);
  process.exitCode = 1;
}
function localTarget(root, file) {
  const target = path.resolve(root, file);
  const inside = (parent, value) => {
    const relative = path.relative(parent, value);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!inside(root, target) || !inside(realpathSync(root), realpathSync(target))) throw new Error(`Local reference escapes skill root: ${file}`);
  return target;
}
// Same rough estimator as the canary harness; no threshold or release gate.
function estimateTokens(text) {
  const cjk = (text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, target) : [path.relative(root, target).split(path.sep).join("/")];
  });
}
