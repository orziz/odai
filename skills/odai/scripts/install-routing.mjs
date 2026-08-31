#!/usr/bin/env node

import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const builder = path.join(scriptDir, "build-routing.mjs");
const manifestName = "odai-routing.json";
const requiredRoles = ["controller", "planner", "reviewer"];
const configurableRoles = [...requiredRoles, "researcher", "frontend"];
const args = parseArgs(process.argv.slice(2));
const roles = Object.freeze([
  ...requiredRoles,
  ...(args.researcherModel ? ["researcher"] : []),
  ...(args.frontendModel ? ["frontend"] : []),
]);
const retiredByHost = {
  codex: [
    "hooks.json", "odai-route-hook.mjs", "odai-run-routing.mjs",
    "odai-run-provider-role.mjs", "agents/odai-advisor.toml", "agents/odai-implementer.toml", "agents/odai-worker.toml", "agents/odai-executor.toml", "role-contracts/odai-executor.md",
    "provider-roles/odai-controller.md", "provider-roles/odai-planner.md", "provider-roles/odai-executor.md",
    "provider-roles/odai-advisor.md", "provider-roles/odai-implementer.md", "provider-roles/odai-worker.md", "provider-roles/odai-reviewer.md",
  ],
  claude: ["agents/odai-advisor.md", "agents/odai-implementer.md", "agents/odai-worker.md", "agents/odai-executor.md"],
  copilot: ["agents/odai-advisor.agent.md", "agents/odai-implementer.agent.md", "agents/odai-worker.agent.md", "agents/odai-executor.agent.md"],
};

if (args.help) { printHelp(); process.exit(0); }
if (!new Set(["codex", "claude", "copilot"]).has(args.host)) fail(`不支持的 host：${args.host || "(missing)"}`);
if (!new Set(["project", "user"]).has(args.scope)) fail(`不支持的 scope：${args.scope}`);
if (!args.yes) fail("安装、更新或卸载会持久化宿主配置；取得用户授权后传入 --yes");

const targetRoot = resolveTarget(args.host, args.scope, args.target);
const configRoot = resolveConfigRoot(args.host, args.scope, targetRoot);
const layout = hostLayout(args.host, args.scope);
layout.retiredFiles = retiredByHost[args.host];
const manifestPath = path.join(configRoot, manifestName);
const previous = loadManifest(manifestPath);
assertSafeDestination(configRoot, layout, Object.keys(previous?.files || {}));
assertManagedState(configRoot, layout, previous);

if (args.uninstall) {
  if (hasMappingArgs(args)) fail("--uninstall 不接受模型、推理档或 policy 参数");
  if (!previous) returnResult({ status: "not-installed", host: args.host, scope: args.scope, target: targetRoot, configRoot, requiresNewSession: false });
  const removed = uninstall(configRoot, manifestPath, previous);
  returnResult({ status: "uninstalled", host: args.host, scope: args.scope, target: targetRoot, configRoot, removed, requiresNewSession: true });
}

for (const role of requiredRoles) if (!args[`${role}Model`]) fail(`缺少 --${role}-model`);
if (args.researcherEffort && !args.researcherModel) fail("--researcher-effort 需要同时提供 --researcher-model");
if (args.frontendEffort && !args.frontendModel) fail("--frontend-effort 需要同时提供 --frontend-model");
if (!existsSync(builder)) fail(`缺少路由生成器：${builder}`);

const generatedRoot = mkdtempSync(path.join(tmpdir(), `odai-${args.host}-routing-install-`));
const snapshots = new Map();
try {
  const generated = buildAdapter(generatedRoot, configRoot);
  const files = collectGeneratedFiles(generatedRoot, layout);
  const originalFiles = prepareOriginalFiles(configRoot, previous, files);
  const settings = planSettings(configRoot, layout, previous);
  const candidates = new Set([...layout.managedFiles, ...layout.retiredFiles, ...Object.keys(previous?.files || {}), manifestName]);
  for (const relative of candidates) snapshot(configRoot, relative, snapshots);
  if (settings) snapshot(configRoot, settings.file, snapshots);
  for (const [relative, content] of files) atomicWrite(path.join(configRoot, relative), content);
  if (settings) atomicWrite(path.join(configRoot, settings.file), Buffer.from(`${JSON.stringify(settings.value, null, 2)}\n`));
  removeObsolete(configRoot, previous, files);
  const manifest = {
    version: 13,
    id: "odai-routing-installation",
    host: args.host,
    scope: args.scope,
    target: targetRoot,
    installedAt: new Date().toISOString(),
    generatedFrom: "skills/odai/scripts/install-routing.mjs",
    mapping: generated.mapping,
    routingPolicy: generated.routing_policy,
    activation: generated.activation,
    files: Object.fromEntries([...files].map(([relative, content]) => [relative, sha256(content)])),
    originalFiles,
    settings: settings?.manifest || null,
  };
  atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  assertManagedState(configRoot, layout, manifest);
  returnResult({
    status: previous ? "updated" : "installed", host: args.host, scope: args.scope,
    target: targetRoot, configRoot, mapping: generated.mapping, routingPolicy: generated.routing_policy,
    activation: generated.activation, requiresNewSession: true,
  });
} catch (error) {
  restore(configRoot, snapshots);
  throw error;
} finally {
  rmSync(generatedRoot, { recursive: true, force: true });
}

function buildAdapter(outputRoot, root) {
  const command = [builder, "--host", args.host, "--out", outputRoot];
  for (const role of roles) {
    command.push(`--${role}-model`, args[`${role}Model`]);
    if (args[`${role}Effort`]) command.push(`--${role}-effort`, args[`${role}Effort`]);
  }
  if (args.host === "codex") command.push("--verifier-command", `node ${JSON.stringify(path.join(root, "odai-verify-routing.mjs"))}`);
  const result = spawnSync(process.execPath, command, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail(result.stderr.trim() || "路由生成失败");
  const adapter = path.join(outputRoot, args.host, "ADAPTER.json");
  if (!existsSync(adapter)) fail("路由生成结果缺少 ADAPTER.json");
  return JSON.parse(readFileSync(adapter, "utf8"));
}

function collectGeneratedFiles(root, layoutValue) {
  const result = new Map();
  for (const [sourceRelative, targetRelative] of layoutValue.generatedFiles) {
    const source = path.join(root, args.host, sourceRelative);
    if (!existsSync(source)) fail(`生成结果缺少文件：${sourceRelative}`);
    result.set(targetRelative, readFileSync(source));
  }
  return result;
}

function prepareOriginalFiles(root, manifest, files) {
  if (args.host !== "codex" || !files.has("config.toml")) return manifest?.originalFiles || {};
  const previousOriginal = manifest?.originalFiles?.["config.toml"] || (manifest
    ? { existed: false, sha256: null, content_base64: null }
    : originalFileRecord(path.join(root, "config.toml")));
  const original = previousOriginal.existed
    ? Buffer.from(previousOriginal.content_base64 || "", "base64")
    : Buffer.alloc(0);
  if (previousOriginal.existed && sha256(original) !== previousOriginal.sha256) fail("旧路由的原始 Codex 配置恢复记录已损坏");
  files.set("config.toml", Buffer.from(mergeCodexConfig(original.toString("utf8"), files.get("config.toml").toString("utf8"))));
  return { ...(manifest?.originalFiles || {}), "config.toml": previousOriginal };
}

function originalFileRecord(file) {
  if (!existsSync(file)) return { existed: false, sha256: null, content_base64: null };
  const content = readFileSync(file);
  return { existed: true, sha256: sha256(content), content_base64: content.toString("base64") };
}

function mergeCodexConfig(original, generated) {
  if (/^\s*\[agents\.odai_(?:researcher|planner|executor|reviewer|frontend)\]\s*$/m.test(original)) {
    fail("既有 Codex 配置已声明 odai 角色但不受当前安装清单管理");
  }
  const generatedFeatures = generated.search(/^\s*\[features\]\s*$/m);
  if (generatedFeatures < 0) fail("生成的 Codex 配置缺少 [features]");
  const generatedAgents = generated.search(/^\s*\[agents\.odai_/m);
  if (generatedAgents < 0) fail("生成的 Codex 配置缺少 odai 角色注册");
  const existingInstructions = topLevelTomlString(original, "developer_instructions");
  const generatedController = generated.slice(0, generatedFeatures).trim();
  const controller = existingInstructions
    ? appendDeveloperInstructions(generatedController, existingInstructions)
    : generatedController;
  const agents = generated.slice(generatedAgents).trim();
  let preserved = removeTopLevelCodexKeys(original, new Set(["model", "model_reasoning_effort", "developer_instructions"]));
  preserved = setFeatureFlag(preserved, "multi_agent", "true");
  return [controller, preserved.trim(), agents].filter(Boolean).join("\n\n") + "\n";
}

function topLevelTomlString(source, name) {
  const firstTable = String(source || "").search(/^\s*\[/m);
  const top = firstTable < 0 ? String(source || "") : String(source || "").slice(0, firstTable);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const multiline = new RegExp(`^\\s*${escaped}\\s*=\\s*(\"\"\"|''')([\\s\\S]*?)\\1\\s*$`, "m").exec(top);
  if (multiline) return multiline[2].replace(/^\r?\n|\r?\n$/g, "");
  const line = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "m").exec(top);
  if (!line) return "";
  const raw = line[1].trim();
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { fail(`无法安全解析既有 Codex ${name}`); }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  fail(`无法安全解析既有 Codex ${name}`);
}

function appendDeveloperInstructions(controller, existing) {
  const match = /developer_instructions\s*=\s*\"\"\"\n?([\s\S]*?)\n?\"\"\"/.exec(controller);
  if (!match) fail("生成的 Codex controller 缺少 developer_instructions");
  const combined = `${match[1].trim()}\n\n## 既有宿主指令\n\n${existing.trim()}`;
  return controller.replace(match[0], `developer_instructions = ${JSON.stringify(combined)}`);
}

function removeTopLevelCodexKeys(source, names) {
  const lines = String(source || "").split(/\r?\n/);
  const kept = [];
  let tableSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) tableSeen = true;
    const match = !tableSeen && /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match || !names.has(match[1])) { kept.push(line); continue; }
    const delimiter = match[2].includes('"""') ? '"""' : match[2].includes("'''") ? "'''" : "";
    if (!delimiter || match[2].split(delimiter).length >= 3) continue;
    while (++index < lines.length && !lines[index].includes(delimiter)) { /* remove multiline value */ }
  }
  return kept.join("\n");
}

function setFeatureFlag(source, name, value) {
  const lines = String(source || "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (start < 0) return `${source.trim()}${source.trim() ? "\n\n" : ""}[features]\n${name} = ${value}\n`;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  const filtered = lines.slice(start + 1, end).filter((line) => !new RegExp(`^\\s*${name}\\s*=`).test(line));
  lines.splice(start + 1, end - start - 1, ...filtered, `${name} = ${value}`);
  return lines.join("\n");
}

function hostLayout(host, scope) {
  if (host === "codex") {
    const researcherFiles = [
      [".codex/agents/odai-researcher.toml", "agents/odai-researcher.toml"],
      [".codex/role-contracts/odai-researcher.md", "role-contracts/odai-researcher.md"],
    ];
    const researcher = roles.includes("researcher") ? researcherFiles : [];
    const frontendFiles = [
      [".codex/agents/odai-frontend.toml", "agents/odai-frontend.toml"],
      [".codex/role-contracts/odai-frontend.md", "role-contracts/odai-frontend.md"],
    ];
    const frontend = roles.includes("frontend") ? frontendFiles : [];
    const common = [
      [".codex/config.toml", "config.toml"],
      [".codex/odai-run-role.mjs", "odai-run-role.mjs"], [".codex/odai-verify-routing.mjs", "odai-verify-routing.mjs"],
      [".codex/agents/odai-planner.toml", "agents/odai-planner.toml"],
      [".codex/agents/odai-reviewer.toml", "agents/odai-reviewer.toml"],
      [".codex/role-contracts/odai-controller.md", "role-contracts/odai-controller.md"],
      [".codex/role-contracts/odai-planner.md", "role-contracts/odai-planner.md"],
      [".codex/role-contracts/odai-reviewer.md", "role-contracts/odai-reviewer.md"],
      ...researcher,
      ...frontend,
    ];
    const generatedFiles = common;
    return {
      knownFiles: [...new Set([...common, ...researcherFiles, ...frontendFiles].map(([, target]) => target)), "hooks.json", "odai-route-hook.mjs", "odai-run-routing.mjs", "agents/odai-executor.toml", "role-contracts/odai-executor.md"],
      managedFiles: generatedFiles.map(([, target]) => target),
      generatedFiles,
      settings: null,
    };
  }
  if (host === "claude") return {
    knownFiles: configurableRoles.map((role) => `agents/odai-${role}.md`),
    managedFiles: roles.map((role) => `agents/odai-${role}.md`),
    generatedFiles: roles.map((role) => [`.claude/agents/odai-${role}.md`, `agents/odai-${role}.md`]),
    settings: { file: scope === "project" ? "settings.local.json" : "settings.json", key: "agent", value: "odai-controller" },
  };
  return {
    knownFiles: configurableRoles.map((role) => `agents/odai-${role}.agent.md`),
    managedFiles: roles.map((role) => `agents/odai-${role}.agent.md`),
    generatedFiles: roles.map((role) => [`.github/agents/odai-${role}.agent.md`, `agents/odai-${role}.agent.md`]),
    settings: null,
  };
}

function planSettings(root, layoutValue, manifest) {
  if (!layoutValue.settings) return null;
  const spec = layoutValue.settings;
  const file = path.join(root, spec.file);
  const current = readJsonObject(file);
  if (manifest) {
    const installed = manifest.settings;
    if (!installed || installed.file !== spec.file || installed.key !== spec.key || installed.installed !== spec.value) fail("旧路由缺少可恢复的宿主设置记录");
    if (current[spec.key] !== spec.value) fail(`宿主设置 ${spec.key} 已被外部修改`);
    return { file: spec.file, value: current, manifest: installed };
  }
  const present = Object.hasOwn(current, spec.key);
  if (present && current[spec.key] !== spec.value) fail(`目标已有非 odai 管理的宿主设置 ${spec.key}`);
  return {
    file: spec.file,
    value: { ...current, [spec.key]: spec.value },
    manifest: { file: spec.file, key: spec.key, installed: spec.value, fileExistedBefore: existsSync(file), previous: { present, value: present ? current[spec.key] : null } },
  };
}

function assertManagedState(root, layoutValue, manifest) {
  if (!manifest) {
    const mergeable = args.host === "codex" ? new Set(["config.toml"]) : new Set();
    const conflicts = layoutValue.managedFiles.filter((relative) => !mergeable.has(relative) && existsSync(path.join(root, relative)));
    if (conflicts.length) fail(`目标已有非 odai 管理的配置：${conflicts.join(", ")}`);
    return;
  }
  if (manifest.id !== "odai-routing-installation" || manifest.host !== args.host) fail("无效的 odai 路由清单");
  const accepted = new Set([...(layoutValue.knownFiles || layoutValue.managedFiles), ...layoutValue.retiredFiles]);
  for (const [relative, expected] of Object.entries(manifest.files || {})) {
    if (!accepted.has(relative)) fail(`旧路由包含未知文件：${relative}`);
    const file = path.join(root, relative);
    if (!existsSync(file) || sha256(readFileSync(file)) !== expected) fail(`旧路由文件缺失或已漂移：${relative}`);
  }
  for (const relative of layoutValue.managedFiles) {
    if (!manifest.files?.[relative] && existsSync(path.join(root, relative))) fail(`新托管位置已有非 odai 文件：${relative}`);
  }
}

function removeObsolete(root, manifest, desiredFiles) {
  if (!manifest) return;
  const desired = new Set(desiredFiles.keys());
  const obsolete = new Set([
    ...layout.retiredFiles.filter((relative) => manifest.files?.[relative]),
    ...Object.keys(manifest.files || {}).filter((relative) => !desired.has(relative)),
  ]);
  for (const relative of obsolete) if (existsSync(path.join(root, relative))) unlinkSync(path.join(root, relative));
}

function uninstall(root, manifestPathValue, manifest) {
  const files = Object.keys(manifest.files || {});
  for (const relative of files) {
    const file = path.join(root, relative);
    const original = manifest.originalFiles?.[relative];
    if (original?.existed) atomicWrite(file, Buffer.from(original.content_base64 || "", "base64"));
    else if (existsSync(file)) unlinkSync(file);
  }
  if (manifest.settings) restoreSetting(root, manifest.settings);
  unlinkSync(manifestPathValue);
  return [...files, ...(manifest.settings ? [`${manifest.settings.file}#${manifest.settings.key}`] : []), manifestName];
}

function restoreSetting(root, spec) {
  const file = path.join(root, spec.file);
  const current = readJsonObject(file);
  if (current[spec.key] !== spec.installed) fail(`宿主设置 ${spec.key} 已被外部修改，拒绝删除`);
  if (spec.previous?.present) current[spec.key] = spec.previous.value; else delete current[spec.key];
  if (Object.keys(current).length === 0 && !spec.fileExistedBefore) unlinkSync(file);
  else atomicWrite(file, Buffer.from(`${JSON.stringify(current, null, 2)}\n`));
}

function assertSafeDestination(root, layoutValue, previouslyManaged = []) {
  for (const relative of [...layoutValue.managedFiles, ...layoutValue.retiredFiles, ...previouslyManaged, manifestName, ...(layoutValue.settings ? [layoutValue.settings.file] : [])]) {
    const target = path.join(root, relative);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) fail(`托管目标是符号链接：${target}`);
  }
}

function loadManifest(file) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; }
function readJsonObject(file) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; }
function snapshot(root, relative, map) { const file = path.join(root, relative); map.set(relative, existsSync(file) ? readFileSync(file) : null); }
function restore(root, map) { for (const [relative, content] of map) { const file = path.join(root, relative); if (content === null) rmSync(file, { force: true }); else atomicWrite(file, content); } }
function atomicWrite(target, content) { mkdirSync(path.dirname(target), { recursive: true }); const temp = `${target}.odai-${process.pid}-${randomUUID()}.tmp`; writeFileSync(temp, content); renameSync(temp, target); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function resolveTarget(host, scope, supplied) {
  if (supplied) return path.resolve(supplied);
  if (scope === "project") return process.cwd();
  if (host === "codex") return path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  if (host === "claude") return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"));
  return path.resolve(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"));
}
function resolveConfigRoot(host, scope, target) { if (scope === "user") return target; if (host === "codex") return path.join(target, ".codex"); if (host === "claude") return path.join(target, ".claude"); return path.join(target, ".github"); }

function parseArgs(values) {
  const result = { host: "", scope: "project", target: "", uninstall: false, yes: false, help: false };
  for (const role of configurableRoles) { result[`${role}Model`] = ""; result[`${role}Effort`] = ""; }
  const fields = new Map([["--host", "host"], ["--scope", "scope"], ["--target", "target"]]);
  for (const role of configurableRoles) { fields.set(`--${role}-model`, `${role}Model`); fields.set(`--${role}-effort`, `${role}Effort`); }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--uninstall") result.uninstall = true;
    else if (value === "--yes") result.yes = true;
    else if (fields.has(value)) { const next = values[++index] || ""; if (!next || next.startsWith("--")) fail(`${value} 需要一个值`); result[fields.get(value)] = next; }
    else fail(`未知参数：${value}`);
  }
  return result;
}

function hasMappingArgs(value) { return configurableRoles.some((role) => value[`${role}Model`] || value[`${role}Effort`]); }
function printHelp() {
  console.log(`由 odai 在取得用户授权后安装、更新或卸载宿主路由。

Usage:
  node skills/odai/scripts/install-routing.mjs --host <codex|claude|copilot> --scope <project|user> [--target <path>] \\
    --controller-model <model> --planner-model <model> --reviewer-model <model> \\
    [--researcher-model <model>] [--frontend-model <model>] [--<role>-effort <effort>] --yes

  node skills/odai/scripts/install-routing.mjs --host <codex|claude|copilot> --scope <project|user> [--target <path>] --uninstall --yes

安装后用户只需正常使用 odai。总控是唯一持续任务线程并持有实施；planner、reviewer 以及可选 researcher、frontend 只在能改变结果时启动。researcher 与 frontend 映射默认不配置。更新会安全移除旧版 advisor、implementer、worker、executor 和 stage runner 托管文件。`);
}

function returnResult(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }
function fail(message) { throw new Error(message); }
