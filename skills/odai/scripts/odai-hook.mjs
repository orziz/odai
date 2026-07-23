#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_TOOLS = new Set([
  "apply_patch",
  "create",
  "edit",
  "editfile",
  "editfiles",
  "multiedit",
  "replace",
  "str_replace_editor",
  "write",
  "write_file",
]);

export function loadPolicy(projectRoot) {
  const policyPath = path.join(projectRoot, ".odai", "hooks.json");
  if (!existsSync(policyPath)) return { policy: null, policyPath };

  let value;
  try {
    value = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`${displayPath(projectRoot, policyPath)} 不是有效 JSON：${error.message}`);
  }

  validatePolicy(value);
  return { policy: value, policyPath };
}

export function evaluatePreTool(payload, policy, projectRoot) {
  if (!policy) return { blocked: false };

  const toolName = String(payload.tool_name ?? payload.toolName ?? "").toLowerCase();
  const toolInput = parseToolInput(payload.tool_input ?? payload.toolInput ?? payload.toolArgs);
  if (!WRITE_TOOLS.has(toolName) && !looksLikePatch(toolInput)) return { blocked: false };

  const cwd = resolveSessionCwd(payload.cwd, projectRoot);
  const candidates = extractPaths(toolInput)
    .map((candidate) => normalizeProjectPath(candidate, cwd, projectRoot))
    .filter(Boolean);

  const protectedPath = candidates.find((candidate) =>
    policy.protectedPaths.some((pattern) => matchGlob(candidate, pattern)),
  );
  if (protectedPath) {
    return {
      blocked: true,
      reason: `odai hook：${protectedPath} 命中项目只读路径；参考或保护对象不得被当前写入修改。`,
    };
  }

  if (policy.blockUnresolvedWrites === true && candidates.length === 0) {
    return {
      blocked: true,
      reason: `odai hook：无法从 ${toolName || "当前写工具"} 解析目标路径；项目启用了 blockUnresolvedWrites，需先明确写入对象。`,
    };
  }

  return { blocked: false };
}

export function evaluateStop(payload, policy, projectRoot) {
  if (!policy || policy.checks.length === 0) return { blocked: false };
  if (payload.stop_hook_active === true || payload.stopHookActive === true) return { blocked: false };

  const changed = collectChangedPaths(projectRoot);
  if (!changed.ok && policy.checks.some((check) => check.always !== true)) {
    return {
      blocked: true,
      reason: `odai hook：无法确定变更范围，不能选择已声明验收：${changed.error}`,
    };
  }

  const selected = policy.checks.filter(
    (check) =>
      check.always === true ||
      changed.paths.some((changedPath) => check.whenChanged.some((pattern) => matchGlob(changedPath, pattern))),
  );

  for (const check of selected) {
    const cwd = path.resolve(projectRoot, check.cwd ?? ".");
    if (!isInside(projectRoot, cwd)) {
      return {
        blocked: true,
        reason: `odai hook：验收 ${check.name} 的 cwd 越出项目根，拒绝执行。`,
      };
    }

    const result = spawnSync(check.run[0], check.run.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: check.timeoutSeconds * 1000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });

    if (result.error) {
      return {
        blocked: true,
        reason: `odai hook：验收 ${check.name} 无法执行：${result.error.message}`,
      };
    }
    if (result.status !== 0) {
      const detail = compactFailure(result.stderr || result.stdout);
      return {
        blocked: true,
        reason: `odai hook：验收 ${check.name} 未通过${detail ? `：${detail}` : `（exit ${String(result.status)}）`}。修复或说明阻断后再收口。`,
      };
    }
  }

  return { blocked: false };
}

export function findProjectRoot(cwd) {
  const candidate = path.resolve(cwd || process.cwd());
  const result = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0 && result.stdout.trim()) return path.resolve(result.stdout.trim());
  return candidate;
}

export function matchGlob(value, pattern) {
  const normalizedValue = normalizeSlashes(value).replace(/^\.\/+/, "");
  const normalizedPattern = normalizeSlashes(pattern).replace(/^\.\/+/, "");
  return globToRegExp(normalizedPattern).test(normalizedValue);
}

async function main() {
  const action = process.argv[2];
  const host = readFlag("--host") || "generic";
  if (!new Set(["pre-tool", "stop"]).has(action)) {
    console.error("Usage: odai-hook.mjs <pre-tool|stop> --host <host>");
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = JSON.parse((await readStdin()).trim() || "{}");
  } catch (error) {
    block(action, host, `odai hook：宿主输入不是有效 JSON：${error.message}`);
    return;
  }

  const projectRoot = findProjectRoot(payload.cwd);
  let policy;
  try {
    ({ policy } = loadPolicy(projectRoot));
  } catch (error) {
    block(action, host, `odai hook：策略无效：${error.message}`);
    return;
  }
  if (!policy) return;

  const result =
    action === "pre-tool"
      ? evaluatePreTool(payload, policy, projectRoot)
      : evaluateStop(payload, policy, projectRoot);
  if (result.blocked) block(action, host, result.reason);
}

function validatePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("根值必须是对象");
  }
  rejectUnknownKeys(value, new Set(["version", "protectedPaths", "blockUnresolvedWrites", "checks"]), "策略");
  if (value.version !== 1) throw new Error("version 必须为 1");

  if (value.protectedPaths === undefined) value.protectedPaths = [];
  if (!Array.isArray(value.protectedPaths) || value.protectedPaths.some((item) => !isNonEmptyString(item))) {
    throw new Error("protectedPaths 必须是非空字符串数组");
  }
  for (const pattern of value.protectedPaths) validatePattern(pattern, "protectedPaths");

  if (value.blockUnresolvedWrites !== undefined && typeof value.blockUnresolvedWrites !== "boolean") {
    throw new Error("blockUnresolvedWrites 必须是布尔值");
  }

  if (value.checks === undefined) value.checks = [];
  if (!Array.isArray(value.checks)) throw new Error("checks 必须是数组");
  for (const [index, check] of value.checks.entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new Error(`checks[${index}] 必须是对象`);
    }
    rejectUnknownKeys(
      check,
      new Set(["name", "whenChanged", "always", "run", "cwd", "timeoutSeconds"]),
      `checks[${index}]`,
    );
    if (!isNonEmptyString(check.name)) throw new Error(`checks[${index}].name 必须是非空字符串`);
    if (!Array.isArray(check.run) || check.run.length === 0 || check.run.some((item) => !isNonEmptyString(item))) {
      throw new Error(`checks[${index}].run 必须是非空字符串数组`);
    }
    if (check.always !== true) {
      if (!Array.isArray(check.whenChanged) || check.whenChanged.length === 0 || check.whenChanged.some((item) => !isNonEmptyString(item))) {
        throw new Error(`checks[${index}].whenChanged 必须是非空字符串数组，或设置 always: true`);
      }
      for (const pattern of check.whenChanged) validatePattern(pattern, `checks[${index}].whenChanged`);
    }
    if (check.cwd !== undefined && !isNonEmptyString(check.cwd)) {
      throw new Error(`checks[${index}].cwd 必须是非空字符串`);
    }
    if (
      check.timeoutSeconds !== undefined &&
      (!Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 600)
    ) {
      throw new Error(`checks[${index}].timeoutSeconds 必须是 1-600 的整数`);
    }
    check.timeoutSeconds ??= 120;
  }
}

function parseToolInput(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractPaths(value) {
  const result = [];
  const pathKeys = new Set([
    "file",
    "file_path",
    "filePath",
    "filename",
    "path",
    "target",
    "target_file",
    "targetPath",
  ]);

  function visit(node, key = "") {
    if (typeof node === "string") {
      if (pathKeys.has(key)) result.push(node);
      if (looksLikePatch(node)) result.push(...extractPatchPaths(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [childKey, child] of Object.entries(node)) visit(child, childKey);
  }

  visit(value);
  return [...new Set(result.map(cleanCandidate).filter(Boolean))];
}

function extractPatchPaths(value) {
  const result = [];
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/) ||
      line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (match) result.push(match[1]);
  }
  return result;
}

function looksLikePatch(value) {
  if (typeof value === "string") return value.includes("*** Begin Patch");
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => typeof item === "string" && item.includes("*** Begin Patch"));
}

function normalizeProjectPath(candidate, cwd, projectRoot) {
  if (!candidate || candidate.includes("\0")) return null;
  const absolute = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
  if (!isInside(projectRoot, absolute)) return null;
  return normalizeSlashes(path.relative(projectRoot, absolute));
}

function resolveSessionCwd(cwd, projectRoot) {
  if (!cwd) return projectRoot;
  const resolved = path.resolve(cwd);
  return isInside(projectRoot, resolved) ? resolved : projectRoot;
}

function collectChangedPaths(projectRoot) {
  const commands = [
    ["diff", "--name-only", "-z", "--diff-filter=ACMRD"],
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRD"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const paths = new Set();
  for (const args of commands) {
    const result = spawnSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) {
      return { ok: false, paths: [], error: compactFailure(result.stderr) || `git ${args[0]} 失败` };
    }
    for (const item of result.stdout.split("\0")) {
      if (item) paths.add(normalizeSlashes(item));
    }
  }
  return { ok: true, paths: [...paths] };
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const followedBySlash = pattern[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function validatePattern(pattern, label) {
  if (path.isAbsolute(pattern) || normalizeSlashes(pattern).split("/").includes("..")) {
    throw new Error(`${label} 只能使用项目内相对 glob：${pattern}`);
  }
  globToRegExp(pattern);
}

function block(action, host, reason) {
  if (action === "pre-tool" || host === "kimi") {
    console.error(reason);
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ decision: "block", reason }));
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function compactFailure(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function cleanCandidate(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function displayPath(root, target) {
  return normalizeSlashes(path.relative(root, target)) || ".";
}

function normalizeSlashes(value) {
  return String(value).split(path.sep).join("/").replaceAll("\\", "/");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} 含未知字段：${unknown.join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
