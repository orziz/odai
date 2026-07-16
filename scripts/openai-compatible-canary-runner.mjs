#!/usr/bin/env node
/**
 * Native OpenAI-compatible canary runner with a bounded fixture-only tool loop.
 *
 * The runner intentionally exposes only repository reads/searches, exact text
 * replacement, the fixture's Node tests, and read-only git inspection. It can
 * load credentials from an explicitly supplied settings file without printing
 * them, which is useful for local CC Switch compatibility checks.
 *
 * Usage:
 *   node scripts/openai-compatible-canary-runner.mjs \
 *     --prompt-file <path> --cwd <dir> --last-message <path> \
 *     --model <model> --settings-file <path>
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    promptFile: "",
    cwd: process.cwd(),
    lastMessage: "",
    model: process.env.ODAI_OPENAI_COMPATIBLE_MODEL || "",
    baseUrl: process.env.ODAI_OPENAI_COMPATIBLE_BASE_URL || "",
    settingsFile: "",
    maxTurns: 30,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--prompt-file") args.promptFile = argv[++i];
    else if (arg === "--cwd") args.cwd = argv[++i];
    else if (arg === "--last-message") args.lastMessage = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--settings-file") args.settingsFile = argv[++i];
    else if (arg === "--max-turns") args.maxTurns = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.promptFile || !existsSync(args.promptFile)) throw new Error("--prompt-file is required");
  if (!args.lastMessage) throw new Error("--last-message is required");
  if (!args.model) throw new Error("--model is required");
  if (!Number.isInteger(args.maxTurns) || args.maxTurns < 1 || args.maxTurns > 60) {
    throw new Error("--max-turns must be an integer between 1 and 60");
  }
  return args;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function loadConnection(args) {
  let settingsEnv = {};
  if (args.settingsFile) {
    const settings = JSON.parse(readFileSync(expandHome(args.settingsFile), "utf8"));
    settingsEnv = settings?.env || {};
  }
  const baseUrl = args.baseUrl || settingsEnv.OPENAI_BASE_URL || settingsEnv.ANTHROPIC_BASE_URL || "";
  const apiKey =
    process.env.ODAI_OPENAI_COMPATIBLE_API_KEY ||
    settingsEnv.OPENAI_API_KEY ||
    settingsEnv.ANTHROPIC_AUTH_TOKEN ||
    settingsEnv.ANTHROPIC_API_KEY ||
    "";
  if (!baseUrl) throw new Error("OpenAI-compatible base URL is required");
  if (!apiKey) throw new Error("OpenAI-compatible API key is required");
  return { apiRoot: openAiApiRoot(baseUrl), apiKey };
}

function openAiApiRoot(baseUrl) {
  let value = String(baseUrl).replace(/\/+$/, "").replace(/\/anthropic$/i, "");
  if (!/\/v1$/i.test(value)) value += "/v1";
  return value;
}

function resolveInside(root, input, { mustExist = true } = {}) {
  const candidate = path.resolve(root, String(input || "."));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes the fixture repository");
  }
  if (mustExist && !existsSync(candidate)) throw new Error(`path not found: ${relative || "."}`);
  if (!existsSync(candidate)) return candidate;
  const resolved = realpathSync(candidate);
  const resolvedRelative = path.relative(root, resolved);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    throw new Error("path resolves outside the fixture repository");
  }
  return resolved;
}

function relativeName(root, value) {
  return path.relative(root, value).split(path.sep).join("/") || ".";
}

function listFiles(root, start, recursive) {
  const base = resolveInside(root, start || ".");
  if (!lstatSync(base).isDirectory()) throw new Error("list_directory path must be a directory");
  const output = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      output.push(`${relativeName(root, full)}${entry.isDirectory() ? "/" : ""}`);
      if (recursive && entry.isDirectory() && output.length < 500) visit(full);
      if (output.length >= 500) return;
    }
  };
  visit(base);
  return output.join("\n") || "(empty directory)";
}

function walkFiles(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, output);
    else if (entry.isFile()) output.push(full);
    if (output.length >= 1000) break;
  }
  return output;
}

function searchText(root, query, start) {
  if (!query) throw new Error("search_text query is required");
  const base = resolveInside(root, start || ".");
  const files = lstatSync(base).isDirectory() ? walkFiles(base) : [base];
  const matches = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (line.includes(query)) matches.push(`${relativeName(root, file)}:${index + 1}:${line}`);
      if (matches.length >= 200) return matches.join("\n");
    }
  }
  return matches.join("\n") || "(no matches)";
}

function replaceText(root, filePath, oldText, newText) {
  const file = resolveInside(root, filePath);
  if (!lstatSync(file).isFile()) throw new Error("replace_text path must be a file");
  if (!oldText) throw new Error("replace_text old_text must be non-empty");
  const before = readFileSync(file, "utf8");
  const occurrences = before.split(oldText).length - 1;
  if (occurrences !== 1) throw new Error(`old_text must occur exactly once; found ${occurrences}`);
  writeFileSync(file, before.replace(oldText, String(newText ?? "")), "utf8");
  return `updated ${relativeName(root, file)}`;
}

function writeNewFile(root, filePath, content) {
  const file = resolveInside(root, filePath, { mustExist: false });
  if (existsSync(file)) throw new Error("write_file refuses to overwrite an existing path");
  const parent = path.dirname(file);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
    throw new Error("write_file parent directory must already exist");
  }
  const value = String(content ?? "");
  if (value.length > 300_000) throw new Error("write_file content exceeds 300000 characters");
  writeFileSync(file, value, "utf8");
  return `created ${relativeName(root, file)}`;
}

function runBoundedCommand(root, command) {
  const value = String(command || "").trim();
  let executable;
  let argv;
  if (/^node tests\/[A-Za-z0-9_.-]+\.mjs$/.test(value)) {
    const testPath = value.slice("node ".length);
    executable = process.execPath;
    argv = [resolveInside(root, testPath)];
  } else if (["git status --short", "git status --porcelain"].includes(value)) {
    executable = "git";
    argv = value.endsWith("--short") ? ["status", "--short"] : ["status", "--porcelain"];
  } else if (value === "git diff") {
    executable = "git";
    argv = ["diff"];
  } else {
    const match = value.match(/^git diff -- ([A-Za-z0-9_./-]+)$/);
    if (!match) throw new Error("command is outside the fixture command allowlist");
    resolveInside(root, match[1]);
    executable = "git";
    argv = ["diff", "--", match[1]];
  }
  const result = spawnSync(executable, argv, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return [
    `exit_code=${result.status ?? "null"}`,
    result.stdout || "",
    result.stderr || "",
  ].filter(Boolean).join("\n").slice(0, 200000);
}

const tools = [
  functionTool("read_file", "Read one UTF-8 file inside the fixture repository.", {
    path: { type: "string" },
  }, ["path"]),
  functionTool("list_directory", "List files inside one fixture directory.", {
    path: { type: "string" },
    recursive: { type: "boolean" },
  }, ["path"]),
  functionTool("search_text", "Search for a literal string in fixture files.", {
    query: { type: "string" },
    path: { type: "string" },
  }, ["query", "path"]),
  functionTool("replace_text", "Replace one exact, uniquely occurring string in a fixture file.", {
    path: { type: "string" },
    old_text: { type: "string" },
    new_text: { type: "string" },
  }, ["path", "old_text", "new_text"]),
  functionTool("write_file", "Create one new UTF-8 file inside an existing fixture directory. Existing paths cannot be overwritten.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  functionTool("run_command", "Run an allowlisted fixture test or read-only git command.", {
    command: { type: "string" },
  }, ["command"]),
];

function functionTool(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

function executeTool(root, name, input) {
  if (name === "read_file") {
    const file = resolveInside(root, input.path);
    if (!lstatSync(file).isFile()) throw new Error("read_file path must be a file");
    return readFileSync(file, "utf8").slice(0, 300000);
  }
  if (name === "list_directory") return listFiles(root, input.path, Boolean(input.recursive));
  if (name === "search_text") return searchText(root, input.query, input.path);
  if (name === "replace_text") return replaceText(root, input.path, input.old_text, input.new_text);
  if (name === "write_file") return writeNewFile(root, input.path, input.content ?? input.invokeContent);
  if (name === "run_command") return runBoundedCommand(root, input.command);
  throw new Error(`unknown tool: ${name}`);
}

function assistantText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n");
}

function addUsage(total, usage) {
  total.prompt_tokens += Number(usage?.prompt_tokens || 0);
  total.completion_tokens += Number(usage?.completion_tokens || 0);
  total.total_tokens += Number(usage?.total_tokens || 0);
}

function emitToolUse(call, input) {
  const nameMap = {
    read_file: "Read",
    list_directory: "Glob",
    search_text: "Grep",
    replace_text: "Edit",
    write_file: "Write",
    run_command: "Bash",
  };
  const traceInput = call.function.name === "read_file"
    ? { file_path: input.path }
    : call.function.name === "run_command"
      ? { command: input.command }
      : input;
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: nameMap[call.function.name] || call.function.name, input: traceInput }] },
  })}\n`);
}

const args = parseArgs(process.argv.slice(2));
const root = realpathSync(args.cwd);
const prompt = readFileSync(args.promptFile, "utf8");
const { apiRoot, apiKey } = loadConnection(args);
const messages = [
  {
    role: "system",
    content: "You are a coding agent operating only inside a disposable fixture repository. Follow the user prompt exactly. Use the provided bounded tools for observable reads, edits, tests, and git inspection. Never claim an action without a successful tool result. Finish with a direct user-facing answer.",
  },
  { role: "user", content: prompt },
];
const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
let finalText = "";
let actualModel = "";

for (let turn = 0; turn < args.maxTurns; turn += 1) {
  const response = await fetch(`${apiRoot}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: args.model, messages, tools, tool_choice: "auto" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI-compatible request failed (${response.status}): ${body?.error?.message || body?.message || response.statusText}`);
  addUsage(usage, body.usage);
  actualModel = body.model || actualModel;
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI-compatible response has no assistant message");
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  messages.push(message);
  if (calls.length === 0) {
    finalText = assistantText(message.content).trim();
    break;
  }
  for (const call of calls) {
    let input;
    let result;
    try {
      input = JSON.parse(call.function?.arguments || "{}");
      emitToolUse(call, input);
      result = executeTool(root, call.function?.name, input);
    } catch (error) {
      result = `ERROR: ${error.message}`;
    }
    process.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: call.id, content: result }] } })}\n`);
    messages.push({ role: "tool", tool_call_id: call.id, content: result });
  }
}

if (!finalText) throw new Error(`No final assistant text after ${args.maxTurns} turns`);
writeFileSync(args.lastMessage, finalText.endsWith("\n") ? finalText : `${finalText}\n`, "utf8");
process.stdout.write(`${finalText}\n`);
process.stdout.write(`\n[openai-runner requested_model ${args.model}]\n`);
if (actualModel) process.stdout.write(`[openai-runner actual_model ${actualModel}]\n`);
process.stdout.write(`\ntokens used\n${usage.total_tokens.toLocaleString("en-US")}\n`);
