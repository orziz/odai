#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const cliRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(cliRoot, "..");
const sourceRoot = path.join(repoRoot, "skills", "odai");
const targetRoot = path.join(cliRoot, "skills", "odai");
const checkOnly = process.argv.includes("--check");

await assertSkillRoot(sourceRoot);
assertInside(repoRoot, sourceRoot, "source skill root");
assertInside(cliRoot, targetRoot, "target skill root");

const sourceFiles = await listFiles(sourceRoot);

if (checkOnly) {
  const targetFiles = await listFiles(targetRoot).catch(() => []);
  const mismatches = await compareFileTrees({ sourceFiles, targetFiles });
  if (mismatches.length > 0) {
    throw new Error(`cli skill snapshot is stale:\n${mismatches.map((item) => `- ${item}`).join("\n")}`);
  }
  console.log(`cli skill snapshot is current (${sourceFiles.length} files).`);
} else {
  await rm(targetRoot, { recursive: true, force: true });
  for (const relativePath of sourceFiles) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    assertInside(sourceRoot, sourcePath, "source file");
    assertInside(targetRoot, targetPath, "target file");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath));
  }
  console.log(`synced skills/odai to cli/skills/odai (${sourceFiles.length} files).`);
}

async function assertSkillRoot(root) {
  const entry = await readFile(path.join(root, "SKILL.md"), "utf8").catch(() => undefined);
  if (!entry?.includes("name: odai")) {
    throw new Error(`Expected odai skill at ${root}`);
  }
}

async function listFiles(root) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, fullPath).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  return files.sort();
}

async function compareFileTrees({ sourceFiles, targetFiles }) {
  const mismatches = [];
  const sourceSet = new Set(sourceFiles);
  const targetSet = new Set(targetFiles);
  for (const file of sourceFiles) {
    if (!targetSet.has(file)) {
      mismatches.push(`missing ${file}`);
      continue;
    }
    const sourceHash = await hashFile(path.join(sourceRoot, file));
    const targetHash = await hashFile(path.join(targetRoot, file));
    if (sourceHash !== targetHash) {
      mismatches.push(`changed ${file}`);
    }
  }
  for (const file of targetFiles) {
    if (!sourceSet.has(file)) {
      mismatches.push(`extra ${file}`);
    }
  }
  return mismatches;
}

async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label} escapes expected directory: ${child}`);
}
