#!/usr/bin/env node

import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmdirSync, rmSync, unlinkSync, writeFileSync,
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
const configurableRoles = [...requiredRoles, "researcher", "frontend", "creative", "writer"];
const args = parseArgs(process.argv.slice(2));
const roles = Object.freeze([
  ...requiredRoles,
  ...(args.researcherModel ? ["researcher"] : []),
  ...(args.frontendModel ? ["frontend"] : []),
  ...(args.creativeModel ? ["creative"] : []),
  ...(args.writerModel ? ["writer"] : []),
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
if ((args.namedDispatch || args.leadMode) && !["claude", "codex"].includes(args.host)) fail("--named-dispatch / --lead-mode requires claude or codex");
if (!new Set(["project", "user"]).has(args.scope)) fail(`不支持的 scope：${args.scope}`);
for (const role of configurableRoles) {
  if (!args[`${role}Cli`]) continue;
  if (!["claude", "codex"].includes(args.host)) fail(`--${role}-cli requires claude or codex`);
  if (!(args.host === "codex" ? ["claude", "antigravity", "grok"] : ["codex", "antigravity", "grok"]).includes(args[`${role}Cli`])) fail(`--${role}-cli must be ${args.host === "codex" ? "claude" : "codex"}, antigravity, or grok`);
  if (!args[`${role}Model`]) fail(`--${role}-cli 需要同时提供 --${role}-model`);
}
if (!args.yes) fail("安装、更新或卸载会持久化宿主配置；取得用户授权后传入 --yes");

const targetRoot = resolveTarget(args.host, args.scope, args.target);
const configRoot = resolveConfigRoot(args.host, args.scope, targetRoot);
const layout = hostLayout(args.host, args.scope);
layout.retiredFiles = retiredByHost[args.host];
const manifestPath = path.join(configRoot, manifestName);
const previous = loadManifest(manifestPath);
assertSafeDestination(configRoot, layout, Object.keys(previous?.files || {}));
assertManagedState(configRoot, layout, previous);

returnResult(main());

function main() {
  if (args.uninstall) {
    if (hasMappingArgs(args)) fail("--uninstall 不接受模型、推理档或 policy 参数");
    if (!previous) return { status: "not-installed", host: args.host, scope: args.scope, target: targetRoot, configRoot, requiresNewSession: false };
    const removed = uninstall(configRoot, manifestPath, previous);
    return { status: "uninstalled", host: args.host, scope: args.scope, target: targetRoot, configRoot, removed, requiresNewSession: true };
  }

  for (const role of requiredRoles) if (!args[`${role}Model`]) fail(`缺少 --${role}-model`);
  if (args.researcherEffort && !args.researcherModel) fail("--researcher-effort 需要同时提供 --researcher-model");
  if (args.frontendEffort && !args.frontendModel) fail("--frontend-effort 需要同时提供 --frontend-model");
  if (args.writerEffort && !args.writerModel) fail("--writer-effort 需要同时提供 --writer-model");
  if (args.creativeEffort && !args.creativeModel) fail("--creative-effort 需要同时提供 --creative-model");
  if (!existsSync(builder)) fail(`缺少路由生成器：${builder}`);

  const generatedRoot = mkdtempSync(path.join(tmpdir(), `odai-${args.host}-routing-install-`));
  const snapshots = new Map();
  const newDirectories = [];
  try {
    const generated = buildAdapter(generatedRoot, configRoot);
    const files = collectGeneratedFiles(generatedRoot, layout);
    const originalFiles = prepareOriginalFiles(configRoot, previous, files);
    const settings = planSettings(configRoot, layout, previous);
    for (const relative of directoryAncestors([...files.keys(), manifestName, ...(settings ? [settings.file] : [])])) {
      if (!existsSync(path.join(configRoot, relative))) newDirectories.push(relative);
    }
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
      generatedFrom: "skills/odai-orchestration/scripts/install-routing.mjs",
      governance: generated.governance,
      orchestration: generated.orchestration,
      mapping: generated.mapping,
      routingPolicy: generated.routing_policy,
      activation: generated.activation,
      files: Object.fromEntries([...files].map(([relative, content]) => [relative, sha256(content)])),
      originalFiles,
      createdDirectories: [...new Set([...(previous?.createdDirectories || []), ...newDirectories])],
      settings: settings?.manifest || null,
    };
    atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    assertManagedState(configRoot, layout, manifest);
    return {
      status: previous ? "updated" : "installed", host: args.host, scope: args.scope,
      target: targetRoot, configRoot, mapping: generated.mapping, routingPolicy: generated.routing_policy,
      activation: generated.activation, requiresNewSession: true,
    };
  } catch (error) {
    restore(configRoot, snapshots);
    removeCreatedDirectories(configRoot, newDirectories);
    throw error;
  } finally {
    rmSync(generatedRoot, { recursive: true, force: true });
  }
}

function buildAdapter(outputRoot, root) {
  const command = [builder, "--host", args.host, "--out", outputRoot];
  if (args.namedDispatch) command.push("--named-dispatch");
  if (args.leadMode) command.push("--lead-mode");
  if (args.governanceRoot) command.push("--governance-root", args.governanceRoot);
  for (const role of roles) {
    command.push(`--${role}-model`, args[`${role}Model`]);
    if (args[`${role}Effort`]) command.push(`--${role}-effort`, args[`${role}Effort`]);
    if (args[`${role}Session`]) command.push(`--${role}-session`, args[`${role}Session`]);
    if (args[`${role}Cli`]) command.push(`--${role}-cli`, args[`${role}Cli`]);
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
    let content = readFileSync(source);
    if (args.host === "claude" && args.scope === "user" && targetRelative === "agents/odai-controller.md") {
      content = Buffer.from(content.toString("utf8").replaceAll("node .claude/odai-run-role.mjs", claudeRunnerCommand()));
    }
    if (args.host === "codex" && targetRelative === "named-dispatch-plugin/hooks/hooks.json") {
      const value = JSON.parse(content);
      for (const entries of Object.values(value.hooks)) for (const entry of entries) for (const hook of entry.hooks) hook.command = `node '${path.join(configRoot, "odai-route-hook.mjs").replaceAll("'", "'\\''")}'`;
      content = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    }
    result.set(targetRelative, content);
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
  if (/^\s*\[agents\.odai_(?:researcher|planner|executor|reviewer|frontend|creative|writer)\]\s*$/m.test(original)) {
    fail("既有 Codex 配置已声明 odai 角色但不受当前安装清单管理");
  }
  const generatedFeatures = generated.search(/^\s*\[features\]\s*$/m);
  if (generatedFeatures < 0) fail("生成的 Codex 配置缺少 [features]");
  const generatedAgents = generated.search(/^\s*\[agents\.odai_/m);

  const existingInstructions = topLevelTomlString(original, "developer_instructions");
  const generatedController = generated.slice(0, generatedFeatures).trim();
  const controller = existingInstructions
    ? appendDeveloperInstructions(generatedController, existingInstructions)
    : generatedController;
  const agents = generatedAgents < 0 ? "" : generated.slice(generatedAgents).trim();
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
    const writerFiles = [[".codex/agents/odai-writer.toml", "agents/odai-writer.toml"], [".codex/role-contracts/odai-writer.md", "role-contracts/odai-writer.md"]];
    const writer = roles.includes("writer") ? writerFiles : [];
    const creativeFiles = [
      [".codex/agents/odai-creative.toml", "agents/odai-creative.toml"],
      [".codex/role-contracts/odai-creative.md", "role-contracts/odai-creative.md"],
    ];
    const creative = roles.includes("creative") ? creativeFiles : [];
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
      ...creative,
      ...writer,
    ];
    common.push(...namedFiles(host).map(file => [`.codex/${file}`, file]));
    const generatedFiles = common.filter(([source]) => !roles.some(role => args[`${role}Cli`] && source === `.codex/agents/odai-${role}.toml`));
    if (roles.some(role => args[`${role}Cli`])) generatedFiles.push([".codex/odai-local-cli.mjs", "odai-local-cli.mjs"]);
    return {
      knownFiles: [...namedFiles(host, true), "odai-local-cli.mjs", ...new Set([...common, ...researcherFiles, ...frontendFiles, ...creativeFiles, ...writerFiles].map(([, target]) => target)), "hooks.json", "odai-route-hook.mjs", "odai-run-routing.mjs", "agents/odai-executor.toml", "role-contracts/odai-executor.md"],
      managedFiles: generatedFiles.map(([, target]) => target),
      generatedFiles,
      settings: null,
    };
  }
  if (host === "claude") {
    const executors = ["odai-run-role.mjs", "odai-local-cli.mjs"];
    const local = roles.filter(role => args[`${role}Cli`]);
    const managedFiles = roles.map(role => `${args[`${role}Cli`] ? "role-contracts" : "agents"}/odai-${role}.md`);
    if (local.length) managedFiles.push(...executors);
    managedFiles.push(...namedFiles(host));
    return {
      knownFiles: [...configurableRoles.map(role => `agents/odai-${role}.md`),
        ...configurableRoles.filter(role => role !== "controller").map(role => `role-contracts/odai-${role}.md`), ...executors, ...namedFiles(host, true)],
      managedFiles,
      generatedFiles: managedFiles.map(file => [`.claude/${file}`, file]),
      settings: { file: scope === "project" ? "settings.local.json" : "settings.json", key: "agent", value: "odai-controller",
        permission: local.length ? `Bash(${claudeRunnerCommand()}:*)` : null },
    };
  }
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
  let installed = manifest?.settings;
  if (manifest) {
    if (!installed || installed.file !== spec.file || installed.key !== spec.key || installed.installed !== spec.value) fail("旧路由缺少可恢复的宿主设置记录");
    if (current[spec.key] !== spec.value) fail(`宿主设置 ${spec.key} 已被外部修改`);
    restoreNamedHooks(current, installed.namedHooks);
    restorePermission(current, installed.permission);
  } else {
    const present = Object.hasOwn(current, spec.key);
    if (present && current[spec.key] !== spec.value) fail(`目标已有非 odai 管理的宿主设置 ${spec.key}`);
    installed = { file: spec.file, key: spec.key, installed: spec.value, fileExistedBefore: existsSync(file), previous: { present, value: present ? current[spec.key] : null } };
  }
  const record = { ...installed };
  delete record.namedHooks;
  if (args.namedDispatch || args.leadMode) {
    const command = `node '${path.join(root, "odai-route-hook.mjs").replaceAll("'", "'\\''")}'`;
    const entries = Object.fromEntries(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map(event => [event, { matcher: "*", hooks: [{ type: "command", command, timeout: 10 }] }]));
    record.namedHooks = entries;
    current.hooks ||= {};
    for (const [event, entry] of Object.entries(entries)) current.hooks[event] = [...(current.hooks[event] || []), entry];
  }
  delete record.permission;
  if (spec.permission) {
    const permissionsPresent = Object.hasOwn(current, "permissions");
    if (permissionsPresent && !isObject(current.permissions)) fail("宿主 permissions 必须是对象");
    const permissions = current.permissions || {};
    const allowPresent = Object.hasOwn(permissions, "allow");
    if (allowPresent && (!Array.isArray(permissions.allow) || permissions.allow.some(rule => typeof rule !== "string"))) fail("宿主 permissions.allow 必须是字符串数组");
    const allow = permissions.allow || [];
    record.permission = { rule: spec.permission, added: !allow.includes(spec.permission), permissionsPresent, allowPresent };
    current.permissions = { ...permissions, allow: record.permission.added ? [...allow, spec.permission] : [...allow] };
  }
  current[spec.key] = spec.value;
  return { file: spec.file, value: current, manifest: record };
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function claudeRunnerCommand() {
  return args.scope === "project" ? "node .claude/odai-run-role.mjs"
    : `node '${path.join(configRoot, "odai-run-role.mjs").replaceAll("'", "'\\''")}'`;
}

function assertPermission(current, record) {
  if (!record) return;
  if (record.rule !== `Bash(${claudeRunnerCommand()}:*)` || typeof record.added !== "boolean"
    || typeof record.permissionsPresent !== "boolean" || typeof record.allowPresent !== "boolean") fail("旧路由的权限恢复记录无效");
  if (!isObject(current.permissions) || !Array.isArray(current.permissions.allow)
    || !current.permissions.allow.includes(record.rule)) fail("宿主设置 permissions.allow 已被外部修改");
}

function restorePermission(current, record) {
  if (!record) return;
  assertPermission(current, record);
  if (!record.added) return;
  current.permissions.allow = current.permissions.allow.filter(rule => rule !== record.rule);
  if (!record.allowPresent && current.permissions.allow.length === 0) delete current.permissions.allow;
  if (!record.permissionsPresent && Object.keys(current.permissions).length === 0) delete current.permissions;
}

function assertManagedState(root, layoutValue, manifest) {
  if (args.host === "claude") {
    const localRoles = new Set([
      ...roles.filter(role => args[`${role}Cli`]),
      ...Object.entries(manifest?.mapping || {}).filter(([, route]) => route.backend === "local-cli").map(([role]) => role),
    ]);
    for (const role of configurableRoles.filter(role => localRoles.has(role))) {
      const nativeFile = `agents/odai-${role}.md`;
      if (existsSync(path.join(root, nativeFile)) && !manifest?.files?.[nativeFile]) fail(`本机 CLI 职责存在非 odai 托管的原生代理：${nativeFile}`);
    }
  }
  if (!manifest) {
    const mergeable = args.host === "codex" ? new Set(["config.toml"]) : new Set();
    const conflicts = layoutValue.managedFiles.filter((relative) => !mergeable.has(relative) && existsSync(path.join(root, relative)));
    if (conflicts.length) fail(`目标已有非 odai 管理的配置：${conflicts.join(", ")}`);
    return;
  }
  if (manifest.id !== "odai-routing-installation" || manifest.host !== args.host || manifest.scope !== args.scope) fail("无效的 odai 路由清单");
  if (typeof manifest.target !== "string" || path.resolve(manifest.target) !== targetRoot) fail("旧路由清单的目标与当前配置根不匹配");
  const expectedSetting = layoutValue.settings;
  const installedSetting = manifest.settings;
  if (expectedSetting) {
    if (!installedSetting
      || installedSetting.file !== expectedSetting.file
      || installedSetting.key !== expectedSetting.key
      || installedSetting.installed !== expectedSetting.value) {
      fail("旧路由缺少可恢复的宿主设置记录");
    }
    const currentSettings = readJsonObject(path.join(root, installedSetting.file));
    assertNamedHooks(currentSettings, installedSetting.namedHooks);
    assertPermission(currentSettings, installedSetting.permission);
  } else if (installedSetting) {
    fail("旧路由包含当前宿主不支持的设置记录");
  }
  const accepted = new Set([...(layoutValue.knownFiles || layoutValue.managedFiles), ...layoutValue.retiredFiles]);
  if (manifest.createdDirectories !== undefined) {
    const allowed = directoryAncestors([...accepted, manifestName, ...(expectedSetting ? [expectedSetting.file] : [])]);
    if (!Array.isArray(manifest.createdDirectories)
      || manifest.createdDirectories.some(relative => typeof relative !== "string" || !allowed.has(relative))) {
      fail("旧路由包含无效的托管目录记录");
    }
    assertSafeDestination(root, layoutValue, manifest.createdDirectories);
  }
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
    ...layout.retiredFiles.filter((relative) => manifest.files?.[relative] && !desired.has(relative)),
    ...Object.keys(manifest.files || {}).filter((relative) => !desired.has(relative)),
  ]);
  for (const relative of obsolete) if (existsSync(path.join(root, relative))) unlinkSync(path.join(root, relative));
}

function uninstall(root, manifestPathValue, manifest) {
  const files = Object.keys(manifest.files || {});
  const plannedFiles = new Map();
  for (const relative of files) {
    const original = manifest.originalFiles?.[relative];
    if (!original?.existed) {
      plannedFiles.set(relative, null);
      continue;
    }
    const content = Buffer.from(original.content_base64 || "", "base64");
    if (sha256(content) !== original.sha256) fail(`旧路由的原始文件恢复记录已损坏：${relative}`);
    plannedFiles.set(relative, content);
  }
  const settingPlan = manifest.settings ? planSettingRestore(root, manifest.settings) : null;
  const snapshots = new Map();
  for (const relative of files) snapshot(root, relative, snapshots);
  if (settingPlan) snapshot(root, settingPlan.relative, snapshots);
  snapshot(root, manifestName, snapshots);
  const removedDirectories = [];

  try {
    for (const [relative, content] of plannedFiles) applyFileState(path.join(root, relative), content);
    if (settingPlan) applyFileState(path.join(root, settingPlan.relative), settingPlan.content);
    unlinkSync(manifestPathValue);
    removeCreatedDirectories(root, manifest.createdDirectories || [], removedDirectories);
  } catch (error) {
    try {
      for (const relative of [...removedDirectories].reverse()) mkdirSync(path.join(root, relative), { recursive: true });
      restore(root, snapshots);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "路由卸载失败且无法完整回滚；请检查现有托管清单与文件状态");
    }
    throw error;
  }
  return [...files, ...(manifest.settings ? [`${manifest.settings.file}#${manifest.settings.key}`] : []), manifestName];
}

function planSettingRestore(root, spec) {
  const current = readJsonObject(path.join(root, spec.file));
  if (current[spec.key] !== spec.installed) fail(`宿主设置 ${spec.key} 已被外部修改，拒绝删除`);
  restoreNamedHooks(current, spec.namedHooks);
  restorePermission(current, spec.permission);
  if (spec.previous?.present) current[spec.key] = spec.previous.value; else delete current[spec.key];
  return {
    relative: spec.file,
    content: Object.keys(current).length === 0 && !spec.fileExistedBefore
      ? null
      : Buffer.from(`${JSON.stringify(current, null, 2)}\n`),
  };
}

function directoryAncestors(files) {
  const directories = new Set(["."]);
  for (const relative of files) {
    let directory = path.dirname(relative);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  return directories;
}

function removeCreatedDirectories(root, directories, removed = []) {
  const depth = relative => relative === "." ? 0 : relative.split(/[\\/]/u).length;
  for (const relative of [...new Set(directories)].sort((a, b) => depth(b) - depth(a))) {
    try {
      rmdirSync(path.join(root, relative));
      removed.push(relative);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
    }
  }
}

function applyFileState(file, content) {
  if (content === null) rmSync(file, { force: true });
  else atomicWrite(file, content);
}

function assertSafeDestination(root, layoutValue, previouslyManaged = []) {
  const absoluteRoot = path.resolve(root);
  let current = path.parse(absoluteRoot).root;
  for (const segment of absoluteRoot.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`托管目标或父目录是符号链接：${current}`);
  }
  const relatives = [...layoutValue.managedFiles, ...layoutValue.retiredFiles, ...previouslyManaged, manifestName, ...(layoutValue.settings ? [layoutValue.settings.file] : [])];
  for (const relative of relatives) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some((segment) => segment === "..")) {
      fail(`托管目标超出配置根：${relative}`);
    }
    current = absoluteRoot;
    for (const segment of relative.split(/[\\/]/u).filter(Boolean)) {
      current = path.join(current, segment);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`托管目标或父目录是符号链接：${current}`);
    }
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
  const fields = new Map([["--host", "host"], ["--scope", "scope"], ["--target", "target"], ["--governance-root", "governanceRoot"]]);
  for (const role of configurableRoles) {
    fields.set(`--${role}-model`, `${role}Model`); fields.set(`--${role}-effort`, `${role}Effort`);
    if (role !== "controller") fields.set(`--${role}-session`, `${role}Session`);
    if (role !== "controller") fields.set(`--${role}-cli`, `${role}Cli`);
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--uninstall") result.uninstall = true;
    else if (value === "--lead-mode") result.leadMode = true;
    else if (value === "--named-dispatch") result.namedDispatch = true;
    else if (value === "--yes") result.yes = true;
    else if (fields.has(value)) { const next = values[++index] || ""; if (!next || next.startsWith("--")) fail(`${value} 需要一个值`); result[fields.get(value)] = next; }
    else fail(`未知参数：${value}`);
  }
  return result;
}

function hasMappingArgs(value) { return configurableRoles.some((role) => value[`${role}Model`] || value[`${role}Effort`] || value[`${role}Cli`] || value[`${role}Session`]); }
function printHelp() {
  console.log(`由 odai 在取得用户授权后安装、更新或卸载宿主路由。

Usage:
  node skills/odai-orchestration/scripts/install-routing.mjs --host <codex|claude|copilot> --scope <project|user> [--target <path>] \\
    --controller-model <model> --planner-model <model> --reviewer-model <model> \\
    [--researcher-model <model>] [--frontend-model <model>] [--creative-model <model>] [--writer-model <model>] [--<role>-effort <effort>] [--governance-root <path>] --yes
  Claude: [--<role>-cli <codex|antigravity|grok>]; Codex: [--<role>-cli <claude|antigravity|grok>]\n  [--<role>-session <fresh|continue>] (non-controller roles)\n  [--named-dispatch] [--lead-mode] (Claude / Codex only)

  node skills/odai-orchestration/scripts/install-routing.mjs --host <codex|claude|copilot> --scope <project|user> [--target <path>] --uninstall --yes

安装后用户只需正常使用 odai。总控是唯一持续任务线程并负责实施整合；planner、reviewer 以及可选 researcher、frontend、creative、writer 只在能改变结果时启动。researcher、frontend、creative 与 writer 映射默认不配置。更新会安全移除旧版 advisor、implementer、worker、executor 和 stage runner 托管文件。`);
}

function returnResult(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(message) { throw new Error(message); }

function namedFiles(host, all = false) {
  if (!all && !args.namedDispatch && !args.leadMode) return [];
  return ["odai-route-hook.mjs", "recognize-routing.mjs", "odai-named-dispatch.json", ...(host === "codex" ? [".agents/plugins/marketplace.json", "named-dispatch-plugin/.codex-plugin/plugin.json", "named-dispatch-plugin/hooks/hooks.json"] : [])];
}
function assertNamedHooks(current, entries) {
  for (const [event, entry] of Object.entries(entries || {})) {
    if (!(current.hooks?.[event] || []).some(value => JSON.stringify(value) === JSON.stringify(entry))) fail(`路由 Hook 已漂移：${event}`);
  }
}
function restoreNamedHooks(current, entries) {
  assertNamedHooks(current, entries);
  for (const [event, entry] of Object.entries(entries || {})) {
    current.hooks[event] = current.hooks[event].filter(value => JSON.stringify(value) !== JSON.stringify(entry));
    if (!current.hooks[event].length) delete current.hooks[event];
  }
  if (current.hooks && !Object.keys(current.hooks).length) delete current.hooks;
}
