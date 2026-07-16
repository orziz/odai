#!/usr/bin/env node
/**
 * Thin adapter: odai canary harness -> Grok CLI headless runner.
 * Usage:
 *   node scripts/grok-canary-runner.mjs --prompt-file <path> --cwd <dir> --last-message <path> [--model grok-4.5]
 *
 * Emits a Codex-compatible "tokens used" footer when Grok JSON usage is available,
 * so odai-canary-harness can sum runner_cli_reported_tokens.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    promptFile: "",
    cwd: process.cwd(),
    lastMessage: "",
    model: process.env.ODAI_GROK_MODEL || "grok-4.5",
    maxTurns: process.env.ODAI_GROK_MAX_TURNS || "80",
    grokBin: process.env.ODAI_GROK_COMMAND || "grok",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--prompt-file") args.promptFile = argv[++i];
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--last-message") args.lastMessage = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--max-turns") args.maxTurns = argv[++i];
    else if (a === "--grok-bin") args.grokBin = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.promptFile) throw new Error("--prompt-file is required");
  if (!args.lastMessage) throw new Error("--last-message is required");
  if (!existsSync(args.promptFile)) throw new Error(`prompt file not found: ${args.promptFile}`);
  return args;
}

function resolveGrokBin(bin) {
  if (bin !== "grok" && existsSync(bin)) return bin;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidate = path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (existsSync(candidate)) return candidate;
  return bin;
}

function extractFromJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { body: "", totalTokens: null, raw: text };
  try {
    const parsed = JSON.parse(text);
    const body =
      typeof parsed.text === "string"
        ? parsed.text
        : typeof parsed.response === "string"
          ? parsed.response
          : text;
    const usage = parsed.usage || parsed.modelUsage || null;
    let totalTokens = null;
    if (usage && typeof usage === "object") {
      if (Number.isFinite(usage.total_tokens)) totalTokens = usage.total_tokens;
      else if (Number.isFinite(usage.totalTokens)) totalTokens = usage.totalTokens;
      else {
        const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
        const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
        const cacheRead = Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0) || 0;
        const cacheCreate = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0) || 0;
        const reasoning = Number(usage.reasoning_tokens ?? usage.reasoningTokens ?? 0) || 0;
        const sum = input + output + cacheRead + cacheCreate + reasoning;
        if (sum > 0) totalTokens = sum;
      }
    }
    // modelUsage may be { "grok-4.5": { total_tokens: N } }
    if (totalTokens == null && parsed.modelUsage && typeof parsed.modelUsage === "object") {
      let sum = 0;
      for (const value of Object.values(parsed.modelUsage)) {
        if (value && typeof value === "object") {
          const t = Number(value.total_tokens ?? value.totalTokens ?? 0);
          if (Number.isFinite(t)) sum += t;
        }
      }
      if (sum > 0) totalTokens = sum;
    }
    return { body, totalTokens, raw: text, parsed };
  } catch {
    return { body: text, totalTokens: null, raw: text };
  }
}

function extractLastAssistantFromExport(value) {
  const messages = [];
  let role = "";
  let lines = [];
  const flush = () => {
    if (role === "Assistant") {
      const message = lines.join("\n").trim();
      if (message) messages.push(message);
    }
    lines = [];
  };
  for (const line of String(value || "").split(/\r?\n/)) {
    const heading = /^## (User|Assistant|Tools)\s*$/.exec(line);
    if (heading) {
      flush();
      role = heading[1];
    } else {
      lines.push(line);
    }
  }
  flush();
  return messages.at(-1) || "";
}

const args = parseArgs(process.argv.slice(2));
const grok = resolveGrokBin(args.grokBin);
const versionResult = spawnSync(grok, ["--version"], {
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
  grok,
  "--prompt-file",
  args.promptFile,
  "--cwd",
  args.cwd,
  "--model",
  args.model,
  "--output-format",
  "json",
  "--always-approve",
  "--permission-mode",
  "bypassPermissions",
  "--no-memory",
  "--no-subagents",
  "--disable-web-search",
  "--no-plan",
  "--verbatim",
  "--max-turns",
  String(args.maxTurns),
];

const result = spawnSync(cmd[0], cmd.slice(1), {
  cwd: args.cwd,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});

const stdout = result.stdout || "";
const stderr = result.stderr || "";
const toolOutputFailed = /tool_error:\s*tool_output_error|error_kind[^\n]*tool_output_error/i.test(stderr);
const extracted = extractFromJson(stdout);
const body = extracted.body || "";
let finalBody = body;
const actualModel = extracted.parsed?.modelUsage && typeof extracted.parsed.modelUsage === "object"
  ? Object.keys(extracted.parsed.modelUsage)[0] || ""
  : "";
const sessionId = typeof extracted.parsed?.sessionId === "string"
  ? extracted.parsed.sessionId
  : "";

// Grok's aggregate JSON contains the final text and usage, but not the tool
// calls/results needed by the neutral judge. Export the saved session after the
// run so runner.log preserves the observable action trail. Fall back to the
// final body when an older CLI or an interrupted session cannot be exported.
let transcript = body;
if (result.status === 0 && sessionId) {
  const exportResult = spawnSync(grok, ["export", sessionId], {
    cwd: args.cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (exportResult.status === 0 && String(exportResult.stdout || "").trim()) {
    transcript = String(exportResult.stdout).trimEnd();
    finalBody = extractLastAssistantFromExport(transcript) || finalBody;
  } else {
    const exportError = `${exportResult.stderr || ""}`.trim();
    process.stderr.write(
      `\n[grok-runner warning: session export failed${exportError ? `: ${exportError}` : ""}]\n`,
    );
  }
}

if (result.status === 0 && !finalBody) {
  process.stderr.write("\n[grok-runner error: no final assistant text]\n");
  process.exit(1);
}

// Full exported session for transcripts; last_message remains final assistant text.
if (transcript) process.stdout.write(transcript.endsWith("\n") ? transcript : `${transcript}\n`);
process.stdout.write(`\n[grok-runner requested_model ${args.model}]\n`);
if (actualModel) process.stdout.write(`[grok-runner actual_model ${actualModel}]\n`);
if (cliVersion) process.stdout.write(`[grok-runner cli_version ${cliVersion}]\n`);
// Codex-compatible footer for harness token aggregation.
if (Number.isFinite(extracted.totalTokens) && extracted.totalTokens >= 0) {
  const formatted = Math.trunc(extracted.totalTokens).toLocaleString("en-US");
  process.stdout.write(`\ntokens used\n${formatted}\n`);
}
if (stderr) process.stderr.write(stderr);
if (result.status === 0 && toolOutputFailed) {
  process.stderr.write("\n[grok-runner warning: Grok reported tool_output_error but returned a final assistant message]\n");
}

writeFileSync(args.lastMessage, finalBody.trimEnd() + (finalBody.endsWith("\n") ? "" : "\n"), "utf8");

// Keep raw JSON for offline audit.
try {
  writeFileSync(path.join(path.dirname(args.lastMessage), "grok-runner.json"), extracted.raw || stdout || "", "utf8");
} catch {
  // best-effort
}

process.exit(result.status == null ? 1 : result.status);
