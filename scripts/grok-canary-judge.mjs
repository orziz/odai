#!/usr/bin/env node
/**
 * Thin adapter: odai canary harness judge -> Grok CLI structured JSON.
 * Reads judge prompt from stdin.
 * Usage:
 *   node scripts/grok-canary-judge.mjs --schema <path> --output <path> [--model grok-4.5]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    schema: "",
    output: "",
    model: process.env.ODAI_GROK_MODEL || "grok-4.5",
    grokBin: process.env.ODAI_GROK_COMMAND || "grok",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--schema") args.schema = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--grok-bin") args.grokBin = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.schema) throw new Error("--schema is required");
  if (!args.output) throw new Error("--output is required");
  if (!existsSync(args.schema)) throw new Error(`schema not found: ${args.schema}`);
  return args;
}

function resolveGrokBin(bin) {
  if (bin !== "grok" && existsSync(bin)) return bin;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidate = path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (existsSync(candidate)) return candidate;
  return bin;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

const args = parseArgs(process.argv.slice(2));
const prompt = await readStdin();
if (!prompt.trim()) {
  console.error("judge prompt on stdin is empty");
  process.exit(2);
}

const tmp = mkdtempSync(path.join(tmpdir(), "odai-grok-judge-"));
const promptFile = path.join(tmp, "judge-prompt.txt");
writeFileSync(promptFile, prompt, "utf8");

const schemaText = readFileSync(args.schema, "utf8").trim();
const grok = resolveGrokBin(args.grokBin);
const cmd = [
  grok,
  "--prompt-file",
  promptFile,
  "--model",
  args.model,
  "--json-schema",
  schemaText,
  "--no-memory",
  "--no-subagents",
  "--disable-web-search",
  "--no-plan",
  "--verbatim",
  "--max-turns",
  "1",
  "--tools",
  "",
];

const result = spawnSync(cmd[0], cmd.slice(1), {
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  maxBuffer: 16 * 1024 * 1024,
});

const stdout = result.stdout || "";
const stderr = result.stderr || "";
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

// Prefer raw stdout JSON; also persist for harness parseJudgeJson(file, fallback).
const text = stdout.trim();
let body = text;
try {
  const parsed = JSON.parse(text);
  // Grok json-schema mode may wrap as { text: "...", ... } or emit bare object.
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.pass === "boolean") {
      body = JSON.stringify(parsed);
    } else if (typeof parsed.text === "string") {
      const inner = parsed.text.trim();
      try {
        const innerParsed = JSON.parse(inner);
        if (innerParsed && typeof innerParsed.pass === "boolean") body = JSON.stringify(innerParsed);
        else body = inner;
      } catch {
        const match = /\{[\s\S]*\}/.exec(inner);
        body = match ? match[0] : inner;
      }
    }
  }
} catch {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match) body = match[0];
}

writeFileSync(args.output, body.endsWith("\n") ? body : `${body}\n`, "utf8");
const exitCode = result.status == null ? 1 : result.status;
rmSync(tmp, { recursive: true, force: true });
process.exit(exitCode);
