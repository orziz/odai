#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

process.on("uncaughtException", (error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const supportedRoles = new Set(["controller", "researcher", "planner", "reviewer", "frontend", "creative", "writer"]);

if (args.help) {
  console.log(`Usage:
  node .codex/odai-run-role.mjs --role <controller|researcher|planner|reviewer|frontend|creative|writer> \\
    [--input FILE] [--output FILE] [--evidence FILE] [--cwd PATH] [--manifest FILE] \\
    [--session-key KEY] [--codex-bin FILE] [--sandbox MODE] [--session-id ID] [--closeout-ids A1,A2]

从 odai 托管清单取得角色、模型与推理档，运行一次实际责任并记录可核对证据。
Claude 宿主使用 .claude/odai-run-role.mjs；Codex 宿主支持 claude/antigravity/grok 本机 CLI。
--session-key 为缺少宿主环境变量时显式提供的宿主会话唯一键；
未传 --evidence 时，Codex 本机 CLI 保存到当前项目 .odai/role-evidence/，Claude 保存到执行器同目录 role-evidence/。--timeout 可覆盖本机 CLI 超时（1–7200 整数秒）。
--codex-bin、--sandbox、--session-id、--closeout-ids 仅用于 Codex 宿主。`);
  process.exit(0);
}

if (!supportedRoles.has(args.role)) fail(`不支持的角色：${args.role || "(missing)"}`);
const manifestFile = path.resolve(args.manifest || path.join(scriptDir, "odai-routing.json"));
const manifest = readJson(manifestFile, "路由清单");
if (manifest.id !== "odai-routing-installation" || !["codex", "claude"].includes(manifest.host)) fail("路由清单不是 Codex 或 Claude odai 托管安装");
const mapping = manifest.mapping?.[args.role];
if (manifest.host === "codex" && !mapping?.model) fail(`路由清单缺少 ${args.role} 映射`);


const workdir = path.resolve(args.cwd || process.cwd());
if (manifest.host === "claude" || mapping?.backend === "local-cli") await runLocalRole();
else runCodexRole();

function runCodexRole() {
  if (mapping.session === "continue") fail("Codex 原生角色暂不支持会话续接：证据不足");
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
    const readOnly = ["researcher", "planner", "reviewer", "creative", "writer"].includes(args.role);
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

}

async function runLocalRole() {
  const stateBase = manifest.host === "codex" ? path.join(workdir, ".odai") : scriptDir;
  const evidenceFile = path.resolve(args.evidence || path.join(stateBase, "role-evidence", `${args.role}-${Date.now()}-${randomUUID()}.json`));
  const outputFile = args.output ? path.resolve(args.output) : null;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let result;
  let error;
  let sessionEvidence;
  let unlock;
  try {
    if (args.role === "controller") fail("controller 不支持 local-cli 映射");
    if (mapping?.backend !== "local-cli" || !(manifest.host === "codex" ? ["claude", "antigravity", "grok"] : ["codex", "antigravity", "grok"]).includes(mapping.cli)) {
      fail("Claude 宿主执行器仅接受 codex、antigravity 或 grok 的 local-cli 映射");
    }
    const unsupported = ["--codex-bin", "--sandbox", "--session-id", "--closeout-ids"].filter((option) => args.supplied.has(option));
    if (unsupported.length) fail(`Claude 本机 CLI 分支不支持 Codex 专有选项：${unsupported.join("、")}`);
    const allowedFields = new Set(["backend", "cli", "model", "reasoning_effort", "timeoutSeconds", "session"]);
    for (const key of Object.keys(mapping)) {
      if (!allowedFields.has(key)) fail(`未知本机 CLI 映射字段：${key}`);
    }
    const installedModule = path.join(scriptDir, "odai-local-cli.mjs");
    const moduleFile = existsSync(installedModule) ? installedModule : path.join(scriptDir, "local-cli.mjs");
    const { executeLocalCli, validateLocalCliRoute } = await import(pathToFileURL(moduleFile).href);
    const route = validateLocalCliRoute({
      backend: mapping.backend, cli: mapping.cli, model: mapping.model,
      ...(mapping.reasoning_effort != null ? { reasoningEffort: mapping.reasoning_effort } : {}),
      ...(mapping.session !== undefined ? { session: mapping.session } : {}),
      ...(mapping.timeoutSeconds !== undefined ? { timeoutSeconds: mapping.timeoutSeconds } : {}),
    });
    // Only an explicit flag overrides the shared executor's 1200-second default.
    if (args.supplied.has("--timeout")) route.timeoutSeconds = args.timeout;
    validateLocalCliRoute(route);
    const input = args.input ? readFileSync(path.resolve(args.input), "utf8").trim() : readFileSync(0, "utf8").trim();
    if (!input) fail("角色输入为空");
    const contractFile = path.join(scriptDir, "role-contracts", `odai-${args.role}.md`);
    if (!existsSync(contractFile)) fail(`缺少角色契约：${contractFile}`);
    const contract = readFileSync(contractFile, "utf8");
    const invoke = resumeSessionId => executeLocalCli({ route, prompt: `${contract}\n\n${input}`, cwd: workdir, ...(resumeSessionId ? { resumeSessionId } : {}) });
    let stateFile;
    let previous;
    if (route.session === "continue") {
      const hostSession = (manifest.host === "codex" ? process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID : process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID) || args.sessionKey;
      if (!hostSession) fail("会话续接缺少宿主会话键；请显式传 --session-key");
      const key = createHash("sha256").update(JSON.stringify([manifest.host, hostSession, route.backend, route.cli, route.model])).digest("hex");
      const stateRoot = path.join(stateBase, "role-sessions");
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      stateFile = path.join(stateRoot, `${key}.json`);
      const lock = `${stateFile}.lock`;
      const deadline = Date.now() + args.timeout * 1000;
      while (true) {
        try { mkdirSync(lock, { mode: 0o700 }); break; }
        catch (failure) {
          if (failure.code !== "EEXIST") throw failure;
          if (Date.now() >= deadline) fail(`等待会话锁超时：${lock}；确认没有运行进程后再移除遗留锁`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      unlock = () => rmSync(lock, { recursive: true });
      try {
        if (existsSync(stateFile)) {
          previous = JSON.parse(readFileSync(stateFile, "utf8")).sessionId;
          if (typeof previous !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(previous)) throw new Error("Invalid saved session ID");
        }
      }
      catch { sessionEvidence = { mode: "resume-failed-created", notice: "续接状态损坏，已新开" }; }
    }
    result = await invoke(previous);
    if (previous) {
      sessionEvidence = { mode: "resumed" };
      if (result.status === "error" && !result.boundaryStatus) {
        result = await invoke();
        sessionEvidence = { mode: "resume-failed-created", notice: "续接失败，已新开" };
      }
    }
    if (stateFile && result.status === "completed" && !result.sessionId) { result = { ...result, status: "error", error: "后端未提供可续接会话标识" }; }
    if (stateFile) {
      sessionEvidence ||= { mode: "created" };
      if (sessionEvidence.notice) console.error(sessionEvidence.notice);
      // Clear stale state after failed resume; only verified handbacks become reusable.
      if (result.status === "completed" && result.modelVerified && result.modelVerification === "verified" && result.reasoningEffortVerification !== "mismatch" && result.text?.trim() && result.sessionId) {
        const temporaryState = `${stateFile}.${randomUUID()}.tmp`;
        writeFileSync(temporaryState, JSON.stringify({ sessionId: result.sessionId }), { mode: 0o600 });
        renameSync(temporaryState, stateFile);
      } else if (existsSync(stateFile)) rmSync(stateFile);
    }
    if (result.status !== "completed") fail(result.error || `本机 CLI 未完成：${result.status}`);
    if (result.exitCode !== 0) fail(`本机 CLI 退出状态异常：${result.exitCode ?? "unknown"}`);
    if (typeof result.text !== "string" || !result.text.trim()) fail("角色没有形成输出");
    if (!result.actualModel || !result.modelVerified || result.modelVerification !== "verified") {
      fail(`本机 CLI 模型未核实：${result.modelVerification || "missing"}（请求 ${route.model}，实际 ${result.actualModel || "unknown"}）`);
    }
    // Same gate as DSH: only adapters that can observe effort may fail on it; requested-only is recorded, not blocking.
    if (result.reasoningEffortVerification === "mismatch") {
      fail(`本机 CLI 推理档不一致：请求 ${route.reasoningEffort || "none"}，实际 ${result.actualReasoningEffort || "unknown"}`);
    }
    if (outputFile) {
      if (outputFile === evidenceFile) fail("--output 与 --evidence 不能使用同一路径");
      mkdirSync(path.dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, result.text, "utf8");
    }
  } catch (failure) {
    error = failure instanceof Error ? failure : new Error(String(failure));
  }
  if (unlock) unlock();
  const provider = `local-cli:${mapping?.cli || "unknown"}`;
  const evidence = {
    version: 1,
    role: args.role,
    requested: { provider, model: mapping?.model || null, reasoning_effort: mapping?.reasoning_effort ?? null },
    observed: {
      provider,
      session_id: result?.sessionId || null,
      ...(sessionEvidence ? { session: sessionEvidence } : {}),
      models: result?.actualModel ? [result.actualModel] : [],
      model_verified: result?.modelVerified === true,
      model_verification: result?.modelVerification || "missing",
      reasoning_efforts: result?.actualReasoningEffort ? [result.actualReasoningEffort] : [],
      reasoning_effort_verification: result?.reasoningEffortVerification || "requested-only",
      usage: result?.usage ?? null,
      cli_reported_cost_usd: result?.cliReportedCostUsd ?? null,
      denied_actions_count: result?.deniedActionsCount ?? null,
      duration_ms: result?.durationMs ?? Date.now() - started,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      exit_code: result?.exitCode ?? null,
      status: result?.status || "error",
      error: error?.message || result?.error || null,
    },
    output: error ? null : outputFile,
  };
  mkdirSync(path.dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.error(`odai evidence: ${evidenceFile}`);
  if (error) throw error;
  process.stdout.write(result.text);
  if (!result.text.endsWith("\n")) process.stdout.write("\n");
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
  const result = { role: "", input: "", output: "", evidence: "", cwd: "", manifest: "", codexBin: "", sandbox: "workspace-write", sessionId: "", closeoutIds: "", timeout: 900, help: false, supplied: new Set() };
  const fields = new Map([
    ["--role", "role"], ["--input", "input"], ["--output", "output"], ["--evidence", "evidence"], ["--cwd", "cwd"],
    ["--session-key", "sessionKey"], ["--manifest", "manifest"], ["--codex-bin", "codexBin"], ["--sandbox", "sandbox"], ["--session-id", "sessionId"], ["--closeout-ids", "closeoutIds"], ["--timeout", "timeout"],
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (fields.has(value)) {
      result.supplied.add(value);
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
