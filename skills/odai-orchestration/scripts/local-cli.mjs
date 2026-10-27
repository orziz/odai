import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
const ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const ROUTE_FIELDS = new Set(["backend", "cli", "model", "reasoningEffort", "timeoutSeconds", "session"]);
const DEFAULT_TIMEOUT_SECONDS = 1200;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_BYTES = 8192;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateLocalCliRoute(value) {
  if (!isRecord(value)) throw new TypeError("local-cli route must be an object");
  if (value.backend !== "local-cli") throw new TypeError('backend must be "local-cli"');
  if (Object.hasOwn(value, "provider") || Object.hasOwn(value, "maxTokens")) {
    throw new TypeError("local-cli routes must not contain provider or maxTokens");
  }
  if (value.cli === "gemini") throw new TypeError("local-cli gemini: 本版本尚未支持 Gemini CLI，可改用 antigravity");
  if (!Object.hasOwn(ADAPTERS, value.cli)) throw new TypeError("local-cli cli must be claude, codex, antigravity, or grok");
  for (const key of Object.keys(value)) {
    if (!ROUTE_FIELDS.has(key)) throw new TypeError(`Unknown local-cli route field: ${key}`);
  }
  if (typeof value.model !== "string" || !value.model || /^-|[\s\p{Cc}\p{Cf}]/u.test(value.model)) {
    throw new TypeError("local-cli model must be non-empty, must not start with -, or contain whitespace or control characters");
  }
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== "string" || /[^a-z]/.test(value.reasoningEffort) || !ADAPTERS[value.cli].effort.test(value.reasoningEffort))) {
    throw new TypeError(`Invalid ${value.cli} reasoningEffort`);
  }
  if (value.session !== undefined && !["fresh", "continue"].includes(value.session)) throw new TypeError("session must be fresh or continue");
  if (value.session === "continue" && !ADAPTERS[value.cli].continuation) throw new TypeError(`${value.cli} 暂不支持会话续接`);
  const timeoutSeconds = value.timeoutSeconds;
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 7200)) {
    throw new TypeError("local-cli timeoutSeconds must be an integer from 1 to 7200");
  }
  return {
    backend: "local-cli", cli: value.cli, model: value.model,
    ...(value.session !== undefined ? { session: value.session } : {}),
    ...(value.reasoningEffort !== undefined ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
  };
}

export const AGY_READ_ONLY_TOOLS = Object.freeze(["read_file", "search_web", "ask_question", "manage_task", "view_file", "grep_search", "list_dir", "find_by_name"]);
const AGY_READ_BOUNDARY = "\n\n只用只读工具读取任务包中已给出路径的文件（例如 read_file，旧版本叫 view_file）。不要列目录、搜索文件、执行命令、写入或编辑文件；这些动作会被拒绝，并使本次调用作废。需要但未给出的文件，请在回交中列明所需文件，不要自行尝试。";
const effortArgs = (route) => route.reasoningEffort ? ["--effort", route.reasoningEffort] : [];
const ADAPTERS = Object.freeze({
  claude: {
    continuation: true,
    effort: /^(low|medium|high|xhigh|max)$/,
    command: "claude", override: "ODAI_CLAUDE_COMMAND", input: "stdin",
    args: (route, { sessionId, resumeSessionId }) => ["-p", "--output-format", "json", "--model", route.model, ...effortArgs(route),
      "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", ...(route.session === "continue"
        ? [resumeSessionId ? "--resume" : "--session-id", resumeSessionId || sessionId]
        : ["--no-session-persistence"])],
    parse: (stdout, route) => parseClaudeResult(stdout, route.model),
  },
  codex: {
    continuation: false,
    effort: /^[a-z]+$/,
    command: "codex", override: "ODAI_CODEX_COMMAND", input: "stdin",
    args: (route, { cwd }) => ["exec", "--json", "--model", route.model,
      ...(route.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(route.reasoningEffort)}`] : []),
      "-c", "features.multi_agent=false", "--sandbox", "read-only", "--skip-git-repo-check", "-C", cwd, "-"],
    parse: parseCodexResult,
  },
  antigravity: {
    continuation: true,
    effort: /^(low|medium|high)$/,
    command: "agy", override: "ODAI_AGY_COMMAND", input: "argv",
    args: (route, { prompt, resumeSessionId }) => {
      if (typeof prompt !== "string") throw new TypeError("antigravity requires a prompt");
      const input = prompt + AGY_READ_BOUNDARY;
      if (Buffer.byteLength(input, "utf8") > 256 * 1024) throw new TypeError("antigravity prompt exceeds 256 KiB (including read-only instructions)");
      return [...(resumeSessionId ? ["--conversation", resumeSessionId] : []), "-p", input, "--output-format", "stream-json", "--mode", "plan", "--disable-slash-commands", "--model", route.model,
        ...effortArgs(route), "--print-timeout", `${route.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}s`];
    },
    parse: parseAntigravityResult,
  },
  grok: {
    continuation: false,
    effort: /^(none|minimal|low|medium|high|xhigh|max)$/,
    command: "grok", override: "ODAI_GROK_COMMAND", input: "file",
    args: (route, { cwd, promptFile }) => {
      if (typeof promptFile !== "string" || !promptFile) throw new TypeError("grok requires a private prompt file");
      return ["--prompt-file", promptFile, "--output-format", "json", "-m", route.model, ...effortArgs(route),
        "--tools", "read_file,grep,list_dir", "--disallowed-tools", "Agent", "--sandbox", "read-only",
        "--permission-mode", "dontAsk", "--no-memory", "--cwd", cwd];
    },
    parse: parseGrokResult,
  },
});

export function buildLocalCliInvocation(route, env = process.env, context = {}) {
  const normalized = validateLocalCliRoute(route);
  if (["codex", "grok"].includes(normalized.cli) && (typeof context.cwd !== "string" || !context.cwd)) {
    throw new TypeError(`${normalized.cli} requires cwd`);
  }
  const adapter = ADAPTERS[normalized.cli];
  if (context.resumeSessionId !== undefined && (normalized.session !== "continue" || typeof context.resumeSessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(context.resumeSessionId))) throw new TypeError("Invalid resume session ID");
  if (normalized.cli === "claude" && normalized.session === "continue" && !context.resumeSessionId && !context.sessionId) throw new TypeError("Claude continuation requires a new session ID");
  return { command: env[adapter.override] || adapter.command, args: adapter.args(normalized, context) };
}

function emptyResult(status, error) {
  return {
    status, text: "", modelVerified: false, modelVerification: "missing",
    reasoningEffortVerification: "requested-only", ...(error ? { error } : {}),
  };
}

function tail(value, length = 2000) {
  return String(value).trim().slice(-length);
}

function parseClaudeResult(stdout, requestedModel) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return emptyResult("error", `Claude returned invalid JSON${tail(stdout) ? `: ${tail(stdout)}` : ""}`);
  }
  if (!isRecord(payload)) return emptyResult("error", "Claude returned an invalid result object");
  const result = {
    ...emptyResult("completed"),
    text: typeof payload.result === "string" ? payload.result : "",
    ...(isRecord(payload.usage) ? { usage: payload.usage } : {}),
    ...(typeof payload.total_cost_usd === "number" && Number.isFinite(payload.total_cost_usd) && payload.total_cost_usd >= 0
      ? { cliReportedCostUsd: payload.total_cost_usd } : {}),
  };
  // Only modelUsage is model evidence; neither prose nor top-level model claims qualify.
  const models = isRecord(payload.modelUsage)
    ? Object.entries(payload.modelUsage).filter(([model, usage]) => model.trim() && isRecord(usage))
    : [];
  const outputTokens = (usage) => typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)
    && usage.outputTokens >= 0 ? usage.outputTokens : 0;
  const requested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const matches = ([model, usage]) => {
    const canonical = typeof usage.canonicalModel === "string" ? usage.canonicalModel : "";
    return requested.length > 0 && (ALIASES.has(requested)
      ? model.includes(requested) || canonical.includes(requested)
      : model === requested || canonical === requested || model.startsWith(`${requested}-`));
  };
  // Claude Code records its own helper calls (e.g. a short haiku request) in modelUsage too, and on
  // short answers they can out-produce the routed model. The requested model having run verifies the
  // route; only when it is absent is the busiest entry reported as the mismatching actual model.
  const matched = models.find(matches);
  const busiest = [...models].sort((a, b) => outputTokens(b[1]) - outputTokens(a[1]))[0];
  if (matched || busiest) {
    result.actualModel = (matched ?? busiest)[0];
    result.modelVerified = Boolean(matched);
    result.modelVerification = matched ? "verified" : "mismatch";
  }
  if (payload.is_error || payload.subtype !== "success") {
    result.status = "error";
    const details = typeof payload.error === "string" ? payload.error
      : Array.isArray(payload.errors) ? payload.errors.filter((item) => typeof item === "string").join("; ") : result.text;
    result.error = `Claude result ${typeof payload.subtype === "string" ? payload.subtype : "missing success subtype"}${details ? `: ${tail(details)}` : ""}`;
  }
  return result;
}

function jsonLines(stdout) {
  return stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const value = JSON.parse(line);
    if (!isRecord(value)) throw new TypeError("Invalid JSONL event");
    return value;
  });
}

function exactModel(result, actual, requested) {
  if (typeof actual !== "string" || !actual || /^-|[\s\p{Cc}\p{Cf}]/u.test(actual)) return;
  result.actualModel = actual;
  result.modelVerified = actual === requested;
  result.modelVerification = result.modelVerified ? "verified" : "mismatch";
}

function readEvidence(file) {
  // Session files are untrusted input too; never load an unbounded transcript.
  if (statSync(file).size > MAX_OUTPUT_BYTES) throw new Error("CLI evidence exceeds output limit");
  return readFileSync(file, "utf8");
}

function codexContext(threadId, cwd, env) {
  if (typeof threadId !== "string" || !/^[a-zA-Z0-9-]+$/.test(threadId)) return;
  const root = join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "sessions");
  const pending = [root];
  const matches = [];
  while (pending.length) {
    for (const entry of readdirSync(pending.pop(), { withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(full);
      // Locate by thread ID in the filename, never scan unrelated transcript bodies.
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) matches.push(full);
    }
  }
  // Ambiguous evidence must not depend on directory iteration order.
  if (matches.length !== 1) return;
  const events = jsonLines(readEvidence(matches[0]));
  const session = events.find((event) => event.type === "session_meta")?.payload;
  if (session?.id !== threadId || typeof session.cwd !== "string" || realpathSync(session.cwd) !== realpathSync(cwd)) return;
  return events.findLast((event) => event.type === "turn_context")?.payload;
}

function parseCodexResult(stdout, route, { cwd, env }) {
  const events = jsonLines(stdout);
  const lastMessage = events.findLast((event) => event.type === "item.completed" && event.item?.type === "agent_message");
  const result = { ...emptyResult("completed"), text: typeof lastMessage?.item?.text === "string" ? lastMessage.item.text : "" };
  const usage = events.findLast((event) => event.type === "turn.completed")?.usage;
  if (isRecord(usage)) result.usage = usage;
  const failure = events.findLast((event) => event.type === "turn.failed" || event.type === "error");
  if (failure) return { ...result, status: "error", error: `Codex failed: ${tail(failure.error?.message || failure.message || "unknown error")}` };
  if (route.reasoningEffort) result.reasoningEffortVerification = "mismatch";
  try {
    const context = codexContext(events.find((event) => event.type === "thread.started")?.thread_id, cwd, env);
    exactModel(result, context?.model, route.model);
    if (typeof context?.effort === "string" && /^[a-z]+$/.test(context.effort)) {
      result.actualReasoningEffort = context.effort;
      result.reasoningEffortVerification = !route.reasoningEffort || route.reasoningEffort === context.effort ? "verified" : "mismatch";
    }
  } catch { /* Missing, malformed or unreadable session evidence stays unverified. */ }
  return result;
}

function parseAntigravityResult(stdout, route) {
  const events = jsonLines(stdout);
  const violations = [...new Set(events.filter(event => event.event === "step_update" && event.step_update?.step_type === "tool" && event.step_update?.state === "DONE" && !AGY_READ_ONLY_TOOLS.includes(event.step_update.tool_name)).map(event => String(event.step_update.tool_name ?? "<missing>")))];
  if (violations.length) return { ...emptyResult("error", `boundary-violation: ${violations.join(", ")}；agy 的权限设置允许了写类工具，请检查 agy 设置里的 permissions.allow。执行后检查不能撤销已发生的动作。`), boundaryStatus: "boundary-violation", boundaryTools: violations };
  const init = events.find((event) => event.event === "init");
  const payload = events.findLast((event) => event.event === "result")?.result;
  if (!isRecord(payload)) return emptyResult("error", "Antigravity returned no result event");
  const result = { ...emptyResult("completed"), text: typeof payload.response === "string" ? payload.response : "" };
  exactModel(result, init?.init?.model, route.model);
  if (typeof init?.conversation_id === "string") result.sessionId = init.conversation_id;
  if (isRecord(payload.usage)) result.usage = payload.usage;
  if (Array.isArray(payload.denied_actions)) result.deniedActionsCount = payload.denied_actions.length;
  else if (Number.isSafeInteger(payload.denied_actions) && payload.denied_actions >= 0) result.deniedActionsCount = payload.denied_actions;
  if (payload.status !== "SUCCESS") {
    result.status = "error";
    result.error = `Antigravity result ${payload.status || "missing status"}: ${tail(payload.error || result.text)}`;
  }
  return result;
}

function grokTokenCount(usage) {
  if (!isRecord(usage)) return 0;
  const count = (...fields) => fields.map((field) => usage[field])
    .find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return count("total_tokens", "totalTokens") ?? (
    (count("input_tokens", "inputTokens") ?? 0)
    + (count("output_tokens", "outputTokens") ?? 0)
    + (count("cache_read_input_tokens", "cacheReadInputTokens") ?? 0)
    + (count("cache_creation_input_tokens", "cacheCreationInputTokens") ?? 0)
    + (count("reasoning_tokens", "reasoningTokens") ?? 0)
  );
}

function parseGrokResult(stdout, route, { cwd, env }) {
  const payload = JSON.parse(stdout);
  if (!isRecord(payload)) return emptyResult("error", "Grok returned an invalid result object");
  const result = { ...emptyResult("completed"), text: typeof payload.text === "string" ? payload.text : "" };
  if (payload.stopReason !== "EndTurn") return { ...result, status: "error", error: `Grok stopReason: ${tail(payload.stopReason || "missing")}` };
  // Do not allow a CLI-supplied session ID to escape the sessions directory.
  const safeSessionId = typeof payload.sessionId === "string" && /^[a-zA-Z0-9_-]+$/.test(payload.sessionId);
  if (safeSessionId) result.sessionId = payload.sessionId;
  // Canary output supplies modelUsage even though the CLI README omits it.
  // Never replace conflicting or malformed modelUsage evidence with a summary.
  if (payload.modelUsage != null) {
    if (!isRecord(payload.modelUsage)) return result;
    const models = Object.entries(payload.modelUsage);
    if (models.length) {
      // Grok helper models (web search, session summary) can also appear; as with Claude, the requested
      // model having run verifies the route, otherwise the busiest entry is the mismatching actual model.
      const matched = models.find(([model]) => model === route.model);
      const busiest = [...models].sort((a, b) => grokTokenCount(b[1]) - grokTokenCount(a[1]))[0];
      exactModel(result, (matched ?? busiest)[0], route.model);
      return result;
    }
  }
  if (!safeSessionId) return result;
  try {
    const summary = JSON.parse(readEvidence(join(env.HOME || homedir(), ".grok", "sessions", encodeURIComponent(resolve(cwd)), payload.sessionId, "summary.json")));
    if (isRecord(summary)) exactModel(result, summary.model ?? summary.modelId ?? summary.model_id, route.model);
  } catch { /* Official documentation only: unknown evidence formats fail closed. */ }
  return result;
}

/** The string overload preserves the original Claude parser API. */
export function parseLocalCliResult(stdout, requestedRoute, context = {}) {
  const route = typeof requestedRoute === "string" ? { backend: "local-cli", cli: "claude", model: requestedRoute } : validateLocalCliRoute(requestedRoute);
  try {
    return ADAPTERS[route.cli].parse(stdout, route, { ...context, env: context.env ?? process.env });
  } catch (error) {
    return emptyResult("error", `${route.cli} returned invalid output: ${tail(error?.message || error)}`);
  }
}

/** Executes only the target CLI. Host routing and fallback policy belong to callers. */
export async function executeLocalCli({
  route, prompt, cwd, signal, resumeSessionId, env = process.env, spawnProcess = spawn, killProcess,
  killGraceMs = 1000, maxOutputBytes = MAX_OUTPUT_BYTES,
}) {
  const normalized = validateLocalCliRoute(route);
  const sessionId = normalized.session === "continue" && normalized.cli === "claude" ? resumeSessionId || randomUUID() : undefined;
  if (typeof prompt !== "string") throw new TypeError("local-cli prompt must be a string");
  if (typeof cwd !== "string" || !cwd) throw new TypeError("local-cli cwd must be a non-empty string");
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw new TypeError("killGraceMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError("maxOutputBytes must be a positive safe integer");
  if (killProcess !== undefined && typeof killProcess !== "function") throw new TypeError("killProcess must be a function");
  // An injected fake spawn must never cause OS signals to be sent to an invented PID.
  // Inject killProcess as well to exercise process-group behavior with a fake executor.
  const processGroup = process.platform !== "win32" && (spawnProcess === spawn || killProcess !== undefined);
  const signalProcess = killProcess ?? process.kill;
  const started = Date.now();
  let exitCode = null;
  const timedResult = (result) => ({ ...result, exitCode, durationMs: Date.now() - started });
  if (signal?.aborted) return timedResult(emptyResult("cancelled", "Local CLI execution cancelled"));
  const adapter = ADAPTERS[normalized.cli];
  const timeoutSeconds = normalized.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  let temporary;
  try {
    let promptFile;
    if (adapter.input === "file") {
      temporary = mkdtempSync(join(tmpdir(), "odai-local-cli-"));
      chmodSync(temporary, 0o700);
      promptFile = join(temporary, "prompt.txt");
      writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    const invocation = buildLocalCliInvocation(normalized, env, { prompt, cwd, promptFile, sessionId, resumeSessionId });
    return await new Promise((resolve) => {
      let child;
      let settled = false;
      let stopResult;
      let timeout;
      let killTimer;
      let closed = false;
      let groupKillSent = false;
      let stdoutBytes = 0;
      const stdout = [];
      let stderr = Buffer.alloc(0);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        resolve(timedResult(result));
      };
      const kill = (terminationSignal) => {
        try {
          if (processGroup && child.pid) signalProcess(-child.pid, terminationSignal);
          else child.kill(terminationSignal);
        } catch (error) {
          // An exited leader can still have living descendants in its process group.
          if (error?.code !== "ESRCH" && stopResult) stopResult.error += `; ${error?.message || String(error)}`;
        }
      };
      const stop = (status, message) => {
        if (settled || stopResult) return;
        stopResult = emptyResult(status, message);
        kill("SIGTERM");
        if (!settled) killTimer = setTimeout(() => {
          kill("SIGKILL");
          groupKillSent = true;
          if (closed) finish(stopResult);
        }, killGraceMs);
      };
      const onAbort = () => stop("cancelled", "Local CLI execution cancelled");
      try {
        child = spawnProcess(invocation.command, invocation.args, {
          cwd, env, shell: false, windowsHide: true, detached: processGroup, stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        finish(emptyResult("error", `Could not start ${normalized.cli}: ${error?.message || String(error)}`));
        return;
      }
      child.on("error", (error) => {
        if (!child.pid) finish(stopResult || emptyResult("error", `Could not start ${normalized.cli}: ${error.message}`));
        else stop("error", `${normalized.cli} process error: ${error.message}`);
      });
      child.stdout.on("data", (chunk) => {
        if (settled || stopResult) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > maxOutputBytes) {
          stdout.length = 0;
          stop("error", `${normalized.cli} stdout exceeded the ${maxOutputBytes} byte output limit`);
        } else stdout.push(bytes);
      });
      child.stderr.on("data", (chunk) => {
        if (settled || stopResult) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderr = Buffer.concat([stderr, bytes.subarray(-STDERR_BYTES)]).subarray(-STDERR_BYTES);
      });
      for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
        stream.on("error", (error) => stop("error", `${normalized.cli} ${name} error: ${error.message}`));
      }
      child.on("close", (code, terminationSignal) => {
        exitCode = Number.isInteger(code) ? code : null;
        closed = true;
        if (stopResult) {
          // Do not clear the escalation timer merely because the group leader closed
          // its pipes: descendants may still be running with independent stdio.
          if (!processGroup || groupKillSent) finish(stopResult);
          return;
        }
        if (code !== 0) {
          const details = tail(stderr.toString("utf8")) || tail(Buffer.concat(stdout).toString("utf8"));
          finish(emptyResult("error", `${normalized.cli} exited ${terminationSignal ? `with signal ${terminationSignal}` : `with code ${code}`}${details ? `: ${details}` : ""}`));
          return;
        }
        finish({ ...parseLocalCliResult(Buffer.concat(stdout).toString("utf8"), normalized, { cwd, env }), ...(sessionId ? { sessionId } : {}) });
      });
      child.stdin.on("error", (error) => {
        // Early CLI failure often closes stdin first; close still supplies its stderr and exit code.
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") stop("error", `${normalized.cli} stdin error: ${error.message}`);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => stop("timeout", `Local CLI execution timed out after ${timeoutSeconds} seconds`), timeoutSeconds * 1000);
      if (signal?.aborted) { onAbort(); return; }
      try { child.stdin.end(adapter.input === "stdin" ? prompt : undefined, "utf8"); } catch (error) {
        stop("error", `Could not send ${normalized.cli} input: ${error?.message || String(error)}`);
      }
    });
  } catch (error) {
    return timedResult(emptyResult("error", `${normalized.cli} execution failed: ${tail(error?.message || error)}`));
  } finally {
    // Exact private mkdtemp root owned by this invocation; never a caller-supplied path.
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
