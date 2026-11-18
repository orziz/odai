#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const intermediate = resolve(repoRoot, "dsh/client/build/index.mjs");
const target = resolve(repoRoot, "dsh/client/build/client.js");
const marker = "__ODAI_CLIENT_PACKAGE__";
let source = await readFile(intermediate, "utf8");
if (!source.includes(marker)) throw new Error(`compiled DSH client is missing ${marker}`);
if (!source.endsWith("\nexport {};\n")) {
  throw new Error("compiled DSH client has an unexpected module footer");
}
source = source.slice(0, -"export {};\n".length);
await writeFile(target, source, "utf8");
