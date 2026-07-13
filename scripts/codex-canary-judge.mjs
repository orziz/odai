#!/usr/bin/env node
/**
 * Thin adapter: odai canary harness judge -> Codex CLI structured JSON.
 * Neutral third-party judge (GPT-5.6 Sol / high by default) used across the odai
 * A/B history, independent of the runner model family. Reads the judge prompt from
 * stdin; Codex writes the schema-constrained JSON to --output.
 * Usage:
 *   node scripts/codex-canary-judge.mjs --cwd <dir> --schema <path> --output <path> [--model gpt-5.6-sol]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    schema: "",
    output: "",
    model: process.env.ODAI_CODEX_JUDGE_MODEL || "gpt-5.6-sol",
    reasoningEffort: process.env.ODAI_CODEX_JUDGE_EFFORT || "high",
    codexBin: process.env.ODAI_CODEX_COMMAND || "codex",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--schema") args.schema = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--reasoning-effort") args.reasoningEffort = argv[++i];
    else if (a === "--codex-bin") args.codexBin = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.schema) throw new Error("--schema is required");
  if (!args.output) throw new Error("--output is required");
  if (!existsSync(args.schema)) throw new Error(`schema not found: ${args.schema}`);
  return args;
}

function resolveCodexBin(bin) {
  if (bin !== "codex" && existsSync(bin)) return bin;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const desktopBinRoot = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
  const candidates = [
    path.join(home, ".codex", ".sandbox-bin", process.platform === "win32" ? "codex.exe" : "codex"),
    path.join(desktopBinRoot, process.platform === "win32" ? "codex.exe" : "codex"),
  ];
  if (existsSync(desktopBinRoot)) {
    for (const entry of readdirSync(desktopBinRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      candidates.push(path.join(desktopBinRoot, entry, process.platform === "win32" ? "codex.exe" : "codex"));
    }
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
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

const codex = resolveCodexBin(args.codexBin);
const cmd = [
  codex,
  "exec",
  "--ephemeral",
  "--sandbox", "read-only",
  "--model", args.model,
  "-c", `model_reasoning_effort=${JSON.stringify(args.reasoningEffort)}`,
  "-C", args.cwd,
  "--output-schema", args.schema,
  "-o", args.output,
  "-",
];

const result = spawnSync(cmd[0], cmd.slice(1), {
  cwd: args.cwd,
  input: prompt,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
  maxBuffer: 32 * 1024 * 1024,
});

process.stdout.write(`${result.stdout || ""}${result.stderr || ""}`);
process.exit(result.status == null ? 1 : result.status);
