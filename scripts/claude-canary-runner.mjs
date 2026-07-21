#!/usr/bin/env node
/**
 * Thin adapter: odai canary harness -> Claude Code CLI headless runner.
 * Drives claude.exe in `-p` (print) headless mode, streams the full stream-json
 * transcript to stdout, and writes the final assistant text to --last-message.
 * Claude runs with permission prompts bypassed; invoke this adapter only inside
 * the canary harness's disposable fixture repositories.
 * Usage:
 *   node scripts/claude-canary-runner.mjs --prompt-file <path> --cwd <dir> --last-message <path> [--model opus]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    promptFile: "",
    cwd: process.cwd(),
    lastMessage: "",
    model: process.env.ODAI_CLAUDE_MODEL || "sonnet",
    claudeBin: process.env.ODAI_CLAUDE_COMMAND || "claude",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--prompt-file") args.promptFile = argv[++i];
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--last-message") args.lastMessage = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--claude-bin") args.claudeBin = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.promptFile) throw new Error("--prompt-file is required");
  if (!args.lastMessage) throw new Error("--last-message is required");
  if (!existsSync(args.promptFile)) throw new Error(`prompt file not found: ${args.promptFile}`);
  return args;
}

function resolveClaudeBin(bin) {
  if (bin !== "claude" && existsSync(bin)) return bin;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];
  for (const extRoot of candidates) {
    if (!existsSync(extRoot)) continue;
    const entries = readdirSync(extRoot)
      .filter((entry) => /anthropic\.claude-code/.test(entry))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const entry of entries) {
      const candidate = path.join(extRoot, entry, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
      if (existsSync(candidate)) return candidate;
    }
  }
  return bin;
}

const args = parseArgs(process.argv.slice(2));
const claude = resolveClaudeBin(args.claudeBin);
const prompt = readFileSync(args.promptFile, "utf8");

const versionResult = spawnSync(claude, ["--version"], {
  cwd: args.cwd,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  timeout: 30_000,
});
const cliVersion = `${versionResult.stdout || ""}${versionResult.stderr || ""}`
  .replace(/\s+/g, " ")
  .trim();

const cmd = [
  claude,
  "-p",
  "--model", args.model,
  "--output-format", "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
  "--add-dir", args.cwd,
];

const result = spawnSync(cmd[0], cmd.slice(1), {
  cwd: args.cwd,
  input: prompt,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
  // Parent harness enforces its own timeout; do not cap here.
  maxBuffer: 64 * 1024 * 1024,
});

const raw = `${result.stdout || ""}${result.stderr || ""}`;
process.stdout.write(raw);

let finalText = "";
const usage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
};
let usageResultEvents = 0;
let costUsd = null;
let actualModel = "";
let streamCliVersion = "";
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) continue;
  let evt;
  try { evt = JSON.parse(trimmed); } catch { continue; }
  if (!actualModel && typeof evt.model === "string") actualModel = evt.model;
  if (!streamCliVersion && typeof evt.claude_code_version === "string") {
    streamCliVersion = evt.claude_code_version;
  }
  if (evt.type === "result" && typeof evt.result === "string") {
    finalText = evt.result;
    if (evt.usage && typeof evt.usage === "object") {
      usageResultEvents += 1;
      for (const field of Object.keys(usage)) {
        usage[field] += Number(evt.usage[field] || 0);
      }
    }
    costUsd = typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : null;
  }
}

if (result.status === 0 && !finalText) {
  process.stderr.write("\n[claude-runner error: no result event with final assistant text]\n");
  process.exitCode = 1;
} else {
  writeFileSync(args.lastMessage, finalText.endsWith("\n") ? finalText : `${finalText}\n`, "utf8");

  process.stdout.write(`\n[claude-runner requested_model ${args.model}]\n`);
  if (actualModel) process.stdout.write(`[claude-runner actual_model ${actualModel}]\n`);
  if (streamCliVersion || cliVersion) {
    process.stdout.write(`[claude-runner cli_version ${streamCliVersion || cliVersion}]\n`);
  }

  // Emit a `tokens used` footer that the harness parseCliReportedTokens() recognizes:
  // total context tokens processed (input + cache + output) as a session-total figure.
  if (usageResultEvents > 0) {
    const total =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.output_tokens || 0);
    process.stdout.write(`[claude-runner usage_result_events ${usageResultEvents}]\n`);
    process.stdout.write(`\ntokens used\n${total.toLocaleString("en-US")}\n`);
  }
  if (costUsd != null) process.stdout.write(`\n[claude-runner cost_usd ${costUsd.toFixed(6)}]\n`);

  // process.exit() truncates pending stdout pipe writes once raw exceeds the OS
  // pipe buffer (~64KB); set exitCode and let the event loop drain instead.
  process.exitCode = result.status == null ? 1 : result.status;
}
