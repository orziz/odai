#!/usr/bin/env node
/**
 * Thin adapter: odai canary harness -> Kimi Code CLI headless runner.
 *
 * Kimi Code's stream-json output does not currently expose usage. After the
 * run finishes, this adapter reads the matching local session wire and emits
 * the same `tokens used` footer understood by the canary harness. The total is
 * inputOther + inputCacheRead + inputCacheCreation + output across every LLM
 * step in the turn, matching the existing runner cost-comparison convention.
 *
 * Usage:
 *   node scripts/kimi-canary-runner.mjs --prompt-file <path> --cwd <dir>
 *     --last-message <path> [--model kimi-code/k3]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    promptFile: "",
    cwd: process.cwd(),
    lastMessage: "",
    model: process.env.ODAI_KIMI_MODEL || "kimi-code/k3",
    kimiBin: process.env.ODAI_KIMI_COMMAND || "kimi",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prompt-file") args.promptFile = argv[++i];
    else if (arg === "--cwd") args.cwd = argv[++i];
    else if (arg === "--last-message") args.lastMessage = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--kimi-bin") args.kimiBin = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.promptFile) throw new Error("--prompt-file is required");
  if (!args.lastMessage) throw new Error("--last-message is required");
  if (!existsSync(args.promptFile)) throw new Error(`prompt file not found: ${args.promptFile}`);
  return args;
}
function assistantText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function findSessionDir(sessionId) {
  if (!sessionId) return "";
  const sessionsRoot = path.join(os.homedir(), ".kimi-code", "sessions");
  if (!existsSync(sessionsRoot)) return "";
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, entry.name, sessionId);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function readSessionUsage(sessionId) {
  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) return null;
  const wireFile = path.join(sessionDir, "agents", "main", "wire.jsonl");
  if (!existsSync(wireFile)) return null;

  const total = {
    inputOther: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    output: 0,
    steps: 0,
    actualModel: "",
    thinkingEffort: "",
  };
  for (const line of readFileSync(wireFile, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "llm.request") {
      if (!total.actualModel) total.actualModel = event.modelAlias || event.model || "";
      if (!total.thinkingEffort) total.thinkingEffort = event.thinkingEffort || "";
    }
    if (event.type !== "usage.record" || event.usageScope !== "turn" || !event.usage) continue;
    total.actualModel = event.model || total.actualModel;
    total.inputOther += Number(event.usage.inputOther || 0);
    total.inputCacheRead += Number(event.usage.inputCacheRead || 0);
    total.inputCacheCreation += Number(event.usage.inputCacheCreation || 0);
    total.output += Number(event.usage.output || 0);
    total.steps += 1;
  }
  if (total.steps === 0) return null;
  return {
    ...total,
    tokens: total.inputOther + total.inputCacheRead + total.inputCacheCreation + total.output,
  };
}

const args = parseArgs(process.argv.slice(2));
const prompt = readFileSync(args.promptFile, "utf8");
const skillsDir = path.join(args.cwd, "skills");
mkdirSync(skillsDir, { recursive: true });

const versionResult = spawnSync(args.kimiBin, ["--version"], {
  cwd: args.cwd,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  timeout: 30_000,
});
const cliVersion = `${versionResult.stdout || ""}${versionResult.stderr || ""}`.replace(/\s+/g, " ").trim();

const result = spawnSync(
  args.kimiBin,
  [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "-m",
    args.model,
    "--skills-dir",
    skillsDir,
  ],
  {
    cwd: args.cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  },
);

const stdout = result.stdout || "";
const stderr = result.stderr || "";
process.stdout.write(stdout);
process.stderr.write(stderr);

let finalText = "";
let sessionId = "";
for (const line of stdout.split(/\r?\n/)) {
  if (!line.trim().startsWith("{")) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.role === "assistant") {
    const text = assistantText(event.content);
    if (text) finalText = text;
  }
  if (event.role === "meta" && event.type === "session.resume_hint" && typeof event.session_id === "string") {
    sessionId = event.session_id;
  }
}

const usage = readSessionUsage(sessionId);
if (result.status === 0 && !finalText) {
  process.stderr.write("\n[kimi-runner error: no final assistant text]\n");
  process.exitCode = 1;
} else {
  writeFileSync(args.lastMessage, finalText.endsWith("\n") ? finalText : `${finalText}\n`, "utf8");
  process.stdout.write(`\n[kimi-runner requested_model ${args.model}]\n`);
  if (usage?.actualModel) process.stdout.write(`[kimi-runner actual_model ${usage.actualModel}]\n`);
  if (usage?.thinkingEffort) process.stdout.write(`[kimi-runner thinking_effort ${usage.thinkingEffort}]\n`);
  if (cliVersion) process.stdout.write(`[kimi-runner cli_version ${cliVersion}]\n`);
  if (sessionId) process.stdout.write(`[kimi-runner session ${sessionId}]\n`);
  if (usage) {
    process.stdout.write(
      `[kimi-runner usage input_other=${usage.inputOther} cache_read=${usage.inputCacheRead} ` +
        `cache_creation=${usage.inputCacheCreation} output=${usage.output} steps=${usage.steps}]\n`,
    );
    process.stdout.write(`\ntokens used\n${usage.tokens.toLocaleString("en-US")}\n`);
  } else {
    process.stdout.write("[kimi-runner usage unavailable]\n");
  }
  process.exitCode = result.status == null ? 1 : result.status;
}
