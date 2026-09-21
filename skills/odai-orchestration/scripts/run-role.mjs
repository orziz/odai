#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const supportedRoles = new Set(["controller", "researcher", "planner", "reviewer", "frontend"]);

if (args.help) {
  console.log(`Usage:
  node .codex/odai-run-role.mjs --role <controller|researcher|planner|reviewer|frontend> \\
    [--input FILE] [--output FILE] [--evidence FILE] [--cwd PATH] [--manifest FILE] \\
    [--codex-bin FILE] [--sandbox MODE] [--session-id ID] [--closeout-ids A1,A2]

从 odai 托管清单取得当前 Codex 宿主的角色、模型与推理档，运行一次实际责任并记录可核对证据。`);
  process.exit(0);
}

if (!supportedRoles.has(args.role)) fail(`不支持的角色：${args.role || "(missing)"}`);
const manifestFile = path.resolve(args.manifest || path.join(scriptDir, "odai-routing.json"));
const manifest = readJson(manifestFile, "路由清单");
if (manifest.id !== "odai-routing-installation" || manifest.host !== "codex") fail("路由清单不是 Codex odai 托管安装");
const mapping = manifest.mapping?.[args.role];
if (!mapping?.model) fail(`路由清单缺少 ${args.role} 映射`);

const workdir = path.resolve(args.cwd || process.cwd());
const input = args.input ? readFileSync(path.resolve(args.input), "utf8").trim() : readFileSync(0, "utf8").trim();
if (!input) fail("角色输入为空");
const contractFile = path.join(scriptDir, "role-contracts", `odai-${args.role}.md`);
if (!existsSync(contractFile)) fail(`缺少角色契约：${contractFile}`);
const contract = readFileSync(contractFile, "utf8");
const temporary = mkdtempSync(path.join(tmpdir(), "odai-role-"));
const outputFile = path.resolve(args.output || path.join(temporary, "result.txt"));
const evidenceFile = args.evidence ? path.resolve(args.evidence) : "";
const startedAt = new Date().toISOString();
const started = Date.now();
mkdirSync(path.dirname(outputFile), { recursive: true });

try {
  const readOnly = args.role === "researcher" || args.role === "planner" || args.role === "reviewer";
  const closeoutIds = parseCloseoutIds(args.closeoutIds);
  const schemaFile = closeoutIds.length > 0 ? writeCloseoutSchema(temporary, closeoutIds) : "";
  const hostOwnsRouting = process.env.ODAI_ROUTING_ACTIVE === "1";
  const shared = [
    "--json", "--model", mapping.model,
    ...effortArgs(mapping.reasoning_effort),
    ...(hostOwnsRouting ? ["-c", "features.multi_agent=false"] : []),
    ...(args.sessionId ? ["-c", `sandbox_mode=${JSON.stringify(readOnly ? "read-only" : args.sandbox)}`] : []),
    "-c", `developer_instructions=${JSON.stringify(contract)}`,
    ...(schemaFile ? ["--output-schema", schemaFile] : []),
    "-o", outputFile,
  ];
  const command = args.sessionId
    ? ["exec", "resume", ...shared, args.sessionId, "-"]
    : ["exec", ...shared, "--sandbox", readOnly ? "read-only" : args.sandbox, "-C", workdir, "-"];
  const child = spawnSync(args.codexBin || process.env.ODAI_CODEX_COMMAND || "codex", command, {
    cwd: workdir,
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: args.timeout * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) fail(child.error.message);
  const raw = `${child.stdout || ""}${child.stderr || ""}`;
  if (child.status !== 0) fail(`Codex ${args.role} 调用失败：${tail(raw)}`);
  if (!existsSync(outputFile) || !readFileSync(outputFile, "utf8").trim()) fail("角色没有形成输出");
  if (closeoutIds.length > 0) writeFileSync(outputFile, renderCloseout(readFileSync(outputFile, "utf8"), closeoutIds), "utf8");
  const events = parseJsonLines(raw);
  const threadId = String(events.find((event) => event.type === "thread.started")?.thread_id || args.sessionId || "");
  if (args.sessionId && threadId !== args.sessionId) fail(`Codex 恢复了错误线程：期望 ${args.sessionId}，实际 ${threadId || "unknown"}`);
  const eventModels = collectStrings(events, "model");
  const runtime = eventModels.length > 0 ? null : queryRuntime(threadId, Date.parse(startedAt));
  const models = runtime?.model ? [runtime.model] : eventModels;
  const evidence = {
    version: 1,
    role: args.role,
    requested: { provider: "codex", model: mapping.model, reasoning_effort: mapping.reasoning_effort || null },
    observed: {
      provider: "codex",
      thread_id: threadId || null,
      models,
      model_verified: models.length > 0,
      reasoning_efforts: runtime?.reasoning_effort ? [runtime.reasoning_effort] : [],
      tool_use_detected: containsToolUse(events),
      tool_evidence: collectToolEvidence(events),
      usage: lastDefined(events.map((event) => event.usage || event.payload?.usage)) || null,
      cost_usd: null,
      duration_ms: Date.now() - started,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      exit_code: child.status,
    },
    output: outputFile,
  };
  writeEvidence(evidence);
  const response = readFileSync(outputFile, "utf8");
  process.stdout.write(response);
  if (!response.endsWith("\n")) process.stdout.write("\n");
} catch (error) {
  writeEvidence({
    version: 1,
    role: args.role,
    requested: { provider: "codex", model: mapping.model, reasoning_effort: mapping.reasoning_effort || null },
    observed: {
      provider: "codex", thread_id: null, models: [], model_verified: false,
      usage: null, cost_usd: null, duration_ms: Date.now() - started,
      started_at: startedAt, completed_at: new Date().toISOString(), exit_code: null,
      error: error?.message || String(error),
    },
    output: null,
  });
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function writeEvidence(value) {
  if (!evidenceFile) return;
  mkdirSync(path.dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function queryRuntime(threadId, startedAt) {
  if (!threadId) return null;
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
  if (!existsSync(root)) return null;
  const threshold = Number.isFinite(startedAt) ? startedAt - 15000 : Date.now() - 60000;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || statSync(full).mtimeMs < threshold) continue;
      const events = parseJsonLines(readFileSync(full, "utf8"));
      const session = events.find((event) => event.type === "session_meta")?.payload;
      if (session?.id !== threadId || path.resolve(session.cwd || "") !== workdir) continue;
      const context = [...events].reverse().find((event) => event.type === "turn_context")?.payload || {};
      return { model: String(context.model || ""), reasoning_effort: String(context.effort || context.collaboration_mode?.settings?.reasoning_effort || "") };
    }
  }
  return null;
}

function parseJsonLines(value) {
  const result = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { result.push(JSON.parse(line)); } catch { /* warnings are not evidence */ }
  }
  return result;
}

function collectStrings(value, key) {
  const found = new Set();
  const walk = (item) => {
    if (!item || typeof item !== "object") return;
    if (typeof item[key] === "string" && item[key]) found.add(item[key]);
    for (const child of Object.values(item)) {
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === "object") walk(child);
    }
  };
  value.forEach(walk);
  return [...found];
}

function containsToolUse(events) {
  const types = new Set(["command_execution", "collab_tool_call", "mcp_tool_call", "file_change", "web_search"]);
  return events.some((event) => (event.type === "item.started" || event.type === "item.completed") && types.has(event.item?.type));
}

function collectToolEvidence(events) {
  const supported = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);
  const result = [];
  let chars = 0;
  for (const event of events) {
    if (event.type !== "item.completed" || !supported.has(event.item?.type)) continue;
    const item = event.item;
    const evidence = {
      type: item.type,
      command: clip(item.command || item.name || "", 4000),
      status: item.status || "",
      exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
      output: clip(item.aggregated_output || item.output || item.text || "", 16000),
    };
    chars += JSON.stringify(evidence).length;
    if (chars > 80000) break;
    result.push(evidence);
  }
  return result;
}

function effortArgs(value) { return value ? ["-c", `model_reasoning_effort=${JSON.stringify(value)}`] : []; }
function clip(value, limit) { const text = String(value || ""); return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`; }
function lastDefined(values) { return [...values].reverse().find((value) => value != null); }
function readJson(file, label) { if (!existsSync(file)) fail(`缺少${label}：${file}`); return JSON.parse(readFileSync(file, "utf8")); }

function parseArgs(values) {
  const result = { role: "", input: "", output: "", evidence: "", cwd: "", manifest: "", codexBin: "", sandbox: "workspace-write", sessionId: "", closeoutIds: "", timeout: 900, help: false };
  const fields = new Map([
    ["--role", "role"], ["--input", "input"], ["--output", "output"], ["--evidence", "evidence"], ["--cwd", "cwd"],
    ["--manifest", "manifest"], ["--codex-bin", "codexBin"], ["--sandbox", "sandbox"], ["--session-id", "sessionId"], ["--closeout-ids", "closeoutIds"], ["--timeout", "timeout"],
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (fields.has(value)) {
      const next = values[++index] || "";
      if (!next || next.startsWith("--")) fail(`${value} 需要一个值`);
      result[fields.get(value)] = fields.get(value) === "timeout" ? Number(next) : next;
    } else fail(`未知参数：${value}`);
  }
  if (!Number.isFinite(result.timeout) || result.timeout <= 0) fail("--timeout 必须是正数秒数");
  return result;
}

function writeCloseoutSchema(directory, ids) {
  const file = path.join(directory, "closeout.schema.json");
  const report = {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["verified", "unresolved", "failed"] },
      evidence: { type: "string" },
      next: { type: "string" },
    },
    required: ["status", "evidence", "next"],
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      delivery: { type: "string" },
      acceptance: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(ids.map((id) => [id, report])),
        required: ids,
      },
    },
    required: ["delivery", "acceptance"],
  };
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  return file;
}

function parseCloseoutIds(value) {
  if (!String(value || "").trim()) return [];
  const ids = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !/^A[1-9][0-9]{0,2}$/.test(id))) {
    fail("--closeout-ids 必须是互不重复的 A1,A2 形式");
  }
  return ids;
}

function renderCloseout(source, ids) {
  let value;
  try { value = JSON.parse(String(source || "").trim()); }
  catch { fail("结构化执行回交不是有效 JSON"); }
  const delivery = String(value?.delivery || "").trim();
  if (!delivery) fail("结构化执行回交缺少面向用户的 delivery");
  for (const id of ids) {
    const report = value?.acceptance?.[id];
    if (!report || !String(report.evidence || "").trim()) fail(`结构化执行回交缺少 ${id} 的实际证据`);
    const next = String(report.next || "").trim();
    if (report.status === "verified" && next) fail(`结构化执行回交中 ${id} 已 verified 却仍有继续条件`);
    if (report.status !== "verified" && !next) fail(`结构化执行回交中 ${id} 未闭合却缺少继续条件`);
  }
  return `${delivery}\n\n<odai_closeout>${JSON.stringify(value.acceptance)}</odai_closeout>\n`;
}

function tail(value) { return String(value || "").trim().slice(-2000); }
function fail(message) { throw new Error(message); }
