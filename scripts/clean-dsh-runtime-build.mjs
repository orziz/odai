#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await Promise.all([
  "dsh/build",
  "dsh/runtime/build",
  "dsh/client/build",
  "dsh/plugin/build",
  "dsh/agent/build",
].map((path) => rm(resolve(repoRoot, path), { recursive: true, force: true })));
