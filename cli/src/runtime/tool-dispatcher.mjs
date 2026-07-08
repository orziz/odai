import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { authorizationGate } from "./gates/authorization.mjs";
import { evidenceGate } from "./gates/evidence.mjs";
import { perceptionGate } from "./gates/perception.mjs";
import { policyGate } from "./gates/policy.mjs";
import { isProtectedModelPath } from "./path-classifier.mjs";
import { publicIntent, redactCommand, redactString, redactUrl } from "./redaction.mjs";
import { planShellCommand } from "./sandbox-adapter.mjs";
import { stopGate } from "./gates/stop.mjs";
import { subagentBoundaryGate } from "./gates/subagent-boundary.mjs";

export class ToolDispatcher {
  constructor({
    workspaceRoot,
    sessionTmp,
    evidence,
    session,
    allowShellExecution = false,
    allowedShellCommands = [],
    shellTimeoutMs = 30000,
    maxOutputChars = 20000,
    checkpointDir,
    shellSandbox = { mode: "none" },
    shellSandboxPlatform,
    shellSandboxCommandExists,
    shellSandboxProbe,
    runShellCommand = defaultRunShellCommand,
    allowNetworkRequests = false,
    networkPolicy = { allowRequests: false, allowedHosts: [], timeoutMs: 10000 },
    fetchImpl = globalThis.fetch,
  }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.sessionTmp = path.resolve(sessionTmp);
    this.evidence = evidence;
    this.session = session;
    this.allowShellExecution = allowShellExecution;
    this.allowedShellCommands = allowedShellCommands.map(String);
    this.shellTimeoutMs = shellTimeoutMs;
    this.maxOutputChars = maxOutputChars;
    this.checkpointDir = checkpointDir ? path.resolve(checkpointDir) : undefined;
    this.shellSandbox = shellSandbox;
    this.shellSandboxPlatform = shellSandboxPlatform;
    this.shellSandboxCommandExists = shellSandboxCommandExists;
    this.shellSandboxProbe = shellSandboxProbe;
    this.runShellCommand = runShellCommand;
    this.allowNetworkRequests = allowNetworkRequests;
    this.networkPolicy = networkPolicy;
    this.fetchImpl = fetchImpl;
  }

  async dispatch(intent) {
    const context = {
      workspaceRoot: this.workspaceRoot,
      sessionTmp: this.sessionTmp,
      evidence: this.evidence,
      session: this.session,
      allowShellExecution: this.allowShellExecution,
      allowedShellCommands: this.allowedShellCommands,
      shellTimeoutMs: this.shellTimeoutMs,
      maxOutputChars: this.maxOutputChars,
      checkpointDir: this.checkpointDir,
      shellSandbox: this.shellSandbox,
      shellSandboxPlatform: this.shellSandboxPlatform,
      shellSandboxCommandExists: this.shellSandboxCommandExists,
      shellSandboxProbe: this.shellSandboxProbe,
      runShellCommand: this.runShellCommand,
      allowNetworkRequests: this.allowNetworkRequests,
      networkPolicy: this.networkPolicy,
      fetchImpl: this.fetchImpl,
    };
    const normalized = normalizeIntent(intent, context);

    for (const gate of [
      subagentBoundaryGate,
      policyGate,
      stopGate,
      authorizationGate,
      perceptionGate,
      evidenceGate,
    ]) {
      const decision = gate(normalized, context);
      if (!decision.allow) {
        const denial = {
          ok: false,
          gate: decision.gate,
          reason: redactString(decision.reason),
          intent: publicIntent(normalized),
        };
        this.evidence.recordDenial(denial);
        this.session.recordFailure(failureKey(normalized));
        return denial;
      }
    }

    return execute(normalized, context);
  }
}

async function execute(intent, context) {
  if (intent.type === "list") {
    assertAllowedPath(intent.path, context);
    const maxEntries = intent.maxEntries || 200;
    const discoveredEntries = await listPath(intent.path, context, maxEntries + 1);
    const truncated = discoveredEntries.length > maxEntries;
    const entries = truncated ? discoveredEntries.slice(0, maxEntries) : discoveredEntries;
    context.evidence.recordLocation(intent.path, "listed");
    return {
      ok: true,
      type: "list",
      path: intent.path,
      entries,
      truncated,
    };
  }

  if (intent.type === "read") {
    assertAllowedPath(intent.path, context);
    try {
      const content = await readFile(intent.path, "utf8");
      context.evidence.recordRead(intent.path);
      context.session.resetWriteFailuresForPath(intent.path);
      return {
        ok: true,
        type: "read",
        path: intent.path,
        content,
        privateContent: isProtectedModelPath(intent.path, context) || undefined,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      context.evidence.recordLocation(intent.path, "read_not_found");
      return {
        ok: false,
        type: "read",
        path: intent.path,
        error: "file_not_found",
      };
    }
  }

  if (intent.type === "search") {
    assertAllowedPath(intent.path, context);
    const maxResults = intent.maxResults || 50;
    const discoveredMatches = await searchPath({
      rootPath: intent.path,
      pattern: intent.pattern,
      maxResults: maxResults + 1,
      context,
    });
    const truncated = discoveredMatches.length > maxResults;
    const matches = truncated ? discoveredMatches.slice(0, maxResults) : discoveredMatches;
    for (const match of matches) {
      context.evidence.recordLocation(path.resolve(context.workspaceRoot, match.path), "search_match");
    }
    return {
      ok: true,
      type: "search",
      path: intent.path,
      pattern: redactString(intent.pattern || ""),
      matches,
      truncated,
    };
  }

  if (intent.type === "write") {
    assertAllowedPath(intent.path, context);
    const checkpoint = await createWriteCheckpoint(intent, context);
    await mkdir(path.dirname(intent.path), { recursive: true });
    await writeFile(intent.path, intent.content || "", "utf8");
    if (checkpoint) {
      context.evidence.recordCheckpoint(checkpoint);
    }
    context.evidence.recordWrite(intent.path, intent.actor, checkpoint ? checkpoint.id : undefined);
    return { ok: true, type: "write", path: intent.path, checkpoint: checkpoint?.id };
  }

  if (intent.type === "shell") {
    if (!context.allowShellExecution) {
      context.evidence.recordCommand(intent.command, intent.actor);
      return {
        ok: true,
        type: "shell",
        command: redactCommand(intent.command),
        skipped: true,
        reason: "Shell execution is disabled; intent was recorded only.",
      };
    }

    if (!Array.isArray(intent.command) || intent.command.length === 0) {
      return {
        ok: false,
        gate: "policy",
        reason: "Executable shell intents must use an argv array.",
      };
    }

    const shellPlan = planShellCommand({
      command: intent.command,
      workspaceRoot: context.workspaceRoot,
      sessionTmp: context.sessionTmp,
      sandbox: context.shellSandbox,
      platform: context.shellSandboxPlatform,
      commandExists: context.shellSandboxCommandExists,
      sandboxProbe: context.shellSandboxProbe,
    });
    if (!shellPlan.ok) {
      return {
        ok: false,
        gate: shellPlan.gate || "policy",
        reason: shellPlan.reason,
        type: "shell",
        command: redactCommand(intent.command),
      };
    }

    const result = context.runShellCommand(shellPlan.command[0], shellPlan.command.slice(1), {
      cwd: context.workspaceRoot,
      env: scrubEnv(process.env),
      encoding: "utf8",
      timeout: context.shellTimeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    context.evidence.recordCommand(intent.command, intent.actor);
    return {
      ok: result.status === 0,
      type: "shell",
      command: redactCommand(intent.command),
      sandbox: shellPlan.sandbox,
      status: result.status,
      stdout: truncate(redactString(result.stdout || ""), context.maxOutputChars),
      stderr: truncate(redactString(result.stderr || ""), context.maxOutputChars),
      timedOut: result.error?.code === "ETIMEDOUT",
    };
  }

  if (intent.type === "network") {
    if (!context.fetchImpl) {
      return {
        ok: false,
        gate: "policy",
        reason: "fetch is not available in this Node runtime.",
        type: "network",
        url: redactUrl(intent.url),
        method: intent.method,
      };
    }

    const timeoutMs = context.networkPolicy?.timeoutMs || 10000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await context.fetchImpl(intent.url, {
        method: intent.method || "GET",
        headers: {
          accept: "text/plain, application/json;q=0.9, */*;q=0.1",
        },
        signal: controller.signal,
      });
      const text = truncate(await response.text(), context.maxOutputChars);
      const result = {
        ok: response.ok,
        type: "network",
        url: redactUrl(intent.url),
        method: intent.method || "GET",
        status: response.status,
        headers: publicHeaders(response.headers),
        body: text,
        bytes: text.length,
      };
      context.evidence.recordNetwork(result, intent.actor);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        type: "network",
        url: redactUrl(intent.url),
        method: intent.method || "GET",
        error: error?.name === "AbortError" ? "network_timeout" : redactString(error?.message || String(error)),
      };
      context.evidence.recordNetwork(result, intent.actor);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Unsupported intent type: ${intent.type}`);
}

function defaultRunShellCommand(command, args, options) {
  return spawnSync(command, args, options);
}

async function createWriteCheckpoint(intent, context) {
  if (!context.checkpointDir) return undefined;

  const previous = await readExistingContent(intent.path);
  const checkpoint = {
    id: randomUUID(),
    path: intent.path,
    actor: intent.actor,
    existed: previous.existed,
    checkpointPath: "",
  };
  checkpoint.checkpointPath = path.join(context.checkpointDir, `${checkpoint.id}.json`);
  await mkdir(context.checkpointDir, { recursive: true });
  await writeFile(
    checkpoint.checkpointPath,
    `${JSON.stringify(
      {
        id: checkpoint.id,
        path: checkpoint.path,
        actor: checkpoint.actor,
        existed: checkpoint.existed,
        content: previous.content,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return checkpoint;
}

async function readExistingContent(filePath) {
  try {
    return {
      existed: true,
      content: await readFile(filePath, "utf8"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        existed: false,
        content: "",
      };
    }
    throw error;
  }
}

function normalizeIntent(intent, context = {}) {
  const resolvedPath = intent.path ? resolveIntentPath(intent.path, context) : undefined;
  const pathRisk = ["list", "read", "search", "write"].includes(intent.type) && isProtectedModelPath(resolvedPath, context)
    ? "credential"
    : undefined;
  return {
    ...intent,
    actor: intent.actor || { kind: "main", id: "main" },
    path: resolvedPath,
    risk: pathRisk || intent.risk || (intent.type === "network" ? "external" : "normal"),
    perception: Boolean(intent.perception),
    acceptanceEvidence: intent.acceptanceEvidence,
    acceptanceCriteria: intent.acceptanceCriteria,
  };
}

async function listPath(filePath, context, maxEntries = 200) {
  const stats = await stat(filePath);
  if (!stats.isDirectory()) {
    return [listEntry(filePath, stats, context)];
  }
  const entries = [];
  const dirents = await readdir(filePath, { withFileTypes: true });
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entries.length >= maxEntries) break;
    const entryPath = path.join(filePath, dirent.name);
    if (shouldHideDiscoveryPath(entryPath, context)) continue;
    entries.push({
      name: dirent.name,
      path: publicWorkspacePath(entryPath, context),
      type: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other",
    });
  }
  return entries;
}

function listEntry(filePath, stats, context) {
  return {
    name: path.basename(filePath),
    path: publicWorkspacePath(filePath, context),
    type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
  };
}

async function searchPath({ rootPath, pattern, maxResults, context }) {
  const matches = [];
  const needle = String(pattern || "");
  if (!needle) return matches;
  const rootStats = await stat(rootPath);
  const files = rootStats.isDirectory()
    ? await collectSearchFiles(rootPath, context, maxResults * 20)
    : [rootPath];
  for (const filePath of files) {
    if (matches.length >= maxResults) break;
    if (shouldHideDiscoveryPath(filePath, context)) continue;
    await searchFile({ filePath, needle, matches, maxResults, context });
  }
  return matches;
}

async function collectSearchFiles(rootPath, context, maxFiles) {
  const files = [];
  async function visit(current) {
    if (files.length >= maxFiles || shouldHideDiscoveryPath(current, context)) return;
    const dirents = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (files.length >= maxFiles) break;
      const entryPath = path.join(current, dirent.name);
      if (shouldHideDiscoveryPath(entryPath, context)) continue;
      if (dirent.isDirectory()) {
        await visit(entryPath);
      } else if (dirent.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await visit(rootPath);
  return files;
}

async function searchFile({ filePath, needle, matches, maxResults, context }) {
  const content = await readFile(filePath, "utf8").catch(() => "");
  if (!content) return;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
    if (!lines[index].includes(needle)) continue;
    matches.push({
      path: publicWorkspacePath(filePath, context),
      line: index + 1,
      text: truncate(redactString(lines[index].trim()), 300),
    });
  }
}

function shouldHideDiscoveryPath(filePath, context) {
  if (!isPathAllowed(filePath, context)) return true;
  if (isProtectedModelPath(filePath, context)) return true;
  const relative = publicWorkspacePath(filePath, context);
  return relative === ".git"
    || relative.startsWith(".git/")
    || relative === "node_modules"
    || relative.startsWith("node_modules/")
    || relative === ".odai/runs"
    || relative.startsWith(".odai/runs/")
    || relative === ".odai/sessions"
    || relative.startsWith(".odai/sessions/");
}

function publicWorkspacePath(filePath, context = {}) {
  const relative = path.relative(path.resolve(context.workspaceRoot || process.cwd()), path.resolve(filePath));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.resolve(filePath);
}

function resolveIntentPath(filePath, context = {}) {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  return path.resolve(context.workspaceRoot || process.cwd(), filePath);
}

function assertAllowedPath(filePath, context) {
  if (!filePath) return;
  if (!isPathAllowed(filePath, context)) {
    throw new Error(`Path is outside allowed roots: ${filePath}`);
  }
}

export function isPathAllowed(filePath, context) {
  const resolvedPath = path.resolve(filePath);
  const roots = [context.workspaceRoot, context.sessionTmp].filter(Boolean).map((root) => path.resolve(root));
  if (!roots.some((root) => isInside(resolvedPath, root))) {
    return false;
  }

  const realRoots = roots.map(realpathOrResolved);
  const realTarget = realpathForExistingTargetOrParent(resolvedPath);
  if (!realTarget) {
    return false;
  }
  return realRoots.some((root) => isInside(realTarget, root));
}

function isInside(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrResolved(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function realpathForExistingTargetOrParent(filePath) {
  let current = path.resolve(filePath);
  for (;;) {
    if (existsSync(current)) {
      try {
        return realpathSync(current);
      } catch {
        return undefined;
      }
    }
    const next = path.dirname(current);
    if (next === current) return undefined;
    current = next;
  }
}

function failureKey(intent) {
  return [intent.actor.kind, intent.type, intent.path || intent.url || intent.command || "unknown"].join(":");
}

function scrubEnv(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key)) {
      delete next[key];
    }
  }
  return next;
}

function truncate(value = "", limit = 20000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function publicHeaders(headers) {
  if (!headers || typeof headers.forEach !== "function") return {};
  const result = {};
  headers.forEach((value, key) => {
    if (/authorization|cookie|set-cookie|token|secret/i.test(key)) return;
    result[key] = value;
  });
  return result;
}
