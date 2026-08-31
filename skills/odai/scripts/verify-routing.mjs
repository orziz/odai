#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const mappings = new Map([["odai_researcher", "researcher"], ["odai_planner", "planner"], ["odai_reviewer", "reviewer"], ["odai_frontend", "frontend"]]);

if (args.help) {
  console.log(`Usage:
  node odai-verify-routing.mjs --host codex --project <directory> \\
    --role <odai_researcher|odai_planner|odai_reviewer|odai_frontend> --after <ISO timestamp> \\
    [--agent-path </root/task>] [--sessions <directory>]

只读取近期 Codex rollout metadata，把实际角色、模型与推理档和 odai 托管清单对账。`);
  process.exit(0);
}
if (args.host !== "codex") fail(`不支持的 host：${args.host || "(missing)"}`);
if (!mappings.has(args.role)) fail("--role 必须是 odai_researcher、odai_planner、odai_reviewer 或 odai_frontend");
if (!args.project || !args.after) fail("缺少 --project 或 --after");
const after = Date.parse(args.after);
if (!Number.isFinite(after)) fail(`无效的 --after：${args.after}`);

const project = path.resolve(args.project);
const manifestFile = path.join(scriptDir, "odai-routing.json");
if (!existsSync(manifestFile)) fail(`缺少路由清单：${manifestFile}`);
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
if (manifest.id !== "odai-routing-installation" || manifest.host !== "codex") fail("路由清单无效");
for (const [relative, expected] of Object.entries(manifest.files || {})) {
  const target = path.join(scriptDir, relative);
  if (!existsSync(target) || sha256(readFileSync(target)) !== expected) fail(`路由托管文件缺失或已变化：${relative}`);
}
const expected = manifest.mapping?.[mappings.get(args.role)];
if (!expected?.model) fail("路由清单缺少角色模型映射");

const sessions = path.resolve(args.sessions || path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions"));
if (!existsSync(sessions)) fail(`Codex sessions 不存在：${sessions}`);
const candidates = [];
for (const file of recentJsonl(sessions, after - 5000)) {
  const metadata = readMetadata(file);
  const session = metadata.session;
  const source = session?.source?.subagent?.thread_spawn;
  if (!source || session.agent_role !== args.role || path.resolve(session.cwd || "") !== project) continue;
  const started = Date.parse(session.timestamp || "");
  if (!Number.isFinite(started) || started < after) continue;
  if (args.agentPath && source.agent_path !== args.agentPath) continue;
  if (metadata.context) candidates.push({ session, context: metadata.context, source });
}
if (candidates.length !== 1) fail(candidates.length ? `找到 ${candidates.length} 个候选子会话；请用 --agent-path 消除歧义` : "未找到满足边界的子会话运行时记录");
const match = candidates[0];
const actualModel = match.context.model;
const actualEffort = match.context.effort || match.context.collaboration_mode?.settings?.reasoning_effort || null;
if (actualModel !== expected.model) fail(`模型不匹配：期望 ${expected.model}，实际 ${actualModel || "(missing)"}`);
if (expected.reasoning_effort && actualEffort !== expected.reasoning_effort) fail(`推理档不匹配：期望 ${expected.reasoning_effort}，实际 ${actualEffort || "(missing)"}`);

process.stdout.write(`${JSON.stringify({
  verified: true, role: match.session.agent_role, model: actualModel, reasoning_effort: actualEffort,
  agent_path: match.source.agent_path || null, child_thread_id: match.session.id,
  parent_thread_id: match.session.parent_thread_id || null, project,
}, null, 2)}\n`);

function recentJsonl(root, threshold) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && statSync(full).mtimeMs >= threshold) files.push(full);
    }
  }
  return files;
}
function readMetadata(file) {
  let session = null; let context = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "session_meta") session = event.payload;
    if (event.type === "turn_context") context = event.payload;
    if (session && context) break;
  }
  return { session, context };
}
function parseArgs(values) {
  const result = { host: "", project: "", role: "", after: "", agentPath: "", sessions: "", help: false };
  const fields = new Map([["--host", "host"], ["--project", "project"], ["--role", "role"], ["--after", "after"], ["--agent-path", "agentPath"], ["--sessions", "sessions"]]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (fields.has(value)) { const next = values[++index] || ""; if (!next || next.startsWith("--")) fail(`${value} 需要一个值`); result[fields.get(value)] = next; }
    else fail(`未知参数：${value}`);
  }
  return result;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function fail(message) { console.error(message); process.exit(1); }
