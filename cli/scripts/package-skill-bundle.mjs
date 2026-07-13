#!/usr/bin/env node

import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(cliRoot, "..");
const sourceRoot = path.join(repoRoot, "skills", "odai");
const targetRoot = path.join(cliRoot, "skills", "odai");
const command = process.argv[2];

if (command === "prepare") {
  await assertCanonicalSkill();
  await rm(path.join(cliRoot, "skills"), { recursive: true, force: true });
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await cp(sourceRoot, targetRoot, { recursive: true });
  console.log("prepared temporary bundled skill from skills/odai");
} else if (command === "clean") {
  await rm(path.join(cliRoot, "skills"), { recursive: true, force: true });
  console.log("cleaned temporary bundled skill");
} else {
  throw new Error("Usage: package-skill-bundle.mjs <prepare|clean>");
}

async function assertCanonicalSkill() {
  const entry = await readFile(path.join(sourceRoot, "SKILL.md"), "utf8").catch(() => "");
  if (!entry.includes("name: odai")) {
    throw new Error(`Expected canonical odai skill at ${sourceRoot}`);
  }
}
