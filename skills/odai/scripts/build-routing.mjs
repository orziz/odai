#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const manifest = JSON.parse(readFileSync(path.join(skillRoot, "manifest.json"), "utf8"));
if (manifest?.schemaVersion !== 2 || !manifest.roleFiles || !manifest.referenceFiles || !Array.isArray(manifest.requiredFiles)) {
  throw new Error("Odai manifest owner topology is unavailable");
}
const ownerNames = Object.freeze({
  roleFiles: ["controller", "researcher", "planner", "reviewer", "frontend"],
  referenceFiles: ["dao", "planning", "craft", "verification", "support", "leverage", "care", "human-safety"],
});
for (const [group, expectedNames] of Object.entries(ownerNames)) {
  const entries = manifest[group];
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)
    || JSON.stringify(Object.keys(entries).sort()) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(`Invalid manifest owner set: ${group}`);
  }
  const paths = Object.values(entries);
  if (new Set(paths).size !== paths.length) throw new Error(`Duplicate manifest owner path: ${group}`);
}
const ownedPaths = [...Object.values(manifest.roleFiles), ...Object.values(manifest.referenceFiles)];
if (new Set(ownedPaths).size !== ownedPaths.length) throw new Error("Role and reference owners must use distinct paths");

const canonicalRoot = realpathSync(skillRoot);
const requiredFiles = new Set(manifest.requiredFiles);

function ownerFilePath(group, name) {
  const relativeSource = manifest[group]?.[name];
  if (typeof relativeSource !== "string" || relativeSource.trim() === "" || relativeSource.includes("\\")
    || path.isAbsolute(relativeSource) || /^[A-Za-z]:/u.test(relativeSource)
    || relativeSource.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe manifest owner path: ${group}.${name}`);
  }
  if (!requiredFiles.has(relativeSource)) throw new Error(`Manifest owner is undeclared: ${group}.${name}`);
  const source = realpathSync(path.resolve(skillRoot, relativeSource));
  const nested = path.relative(canonicalRoot, source);
  if (nested === "" || nested === ".." || nested.startsWith(`..${path.sep}`) || path.isAbsolute(nested)) {
    throw new Error(`Manifest owner escapes the canonical root: ${group}.${name}`);
  }
  return source;
}
for (const [group, names] of Object.entries(ownerNames)) {
  for (const name of names) ownerFilePath(group, name);
}

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage:
  node skills/odai/scripts/build-routing.mjs --host <codex|claude|copilot> --out <directory> \\
    --controller-model <model> --planner-model <model> --reviewer-model <model> \\
    [--researcher-model <model>] [--frontend-model <model>] [--controller-effort <effort>] \\
    [--researcher-effort <effort>] [--planner-effort <effort>] [--reviewer-effort <effort>] \\
    [--frontend-effort <effort>] [--verifier-command <command>]

生成 odai 的可选宿主 auto 路由适配器。一个持续总控持有实施与最终交付，只在多源证据压缩、独立规划、独立验收或前端专业制作能改变结果时调用相应责任；researcher 与 frontend 映射默认不生成。这里不跨 provider、不增加第二总控或隐藏的每轮前置流程。`);
  process.exit(0);
}

assertKnownArgs();
const host = option("--host");
const out = option("--out");
const models = {
  controller: option("--controller-model"),
  researcher: option("--researcher-model"),
  planner: option("--planner-model"),
  reviewer: option("--reviewer-model"),
  frontend: option("--frontend-model"),
};
const efforts = {
  controller: option("--controller-effort"),
  researcher: option("--researcher-effort"),
  planner: option("--planner-effort"),
  reviewer: option("--reviewer-effort"),
  frontend: option("--frontend-effort"),
};
const verifierCommand = option("--verifier-command") || "node .codex/odai-verify-routing.mjs";
const requiredRoles = ["controller", "planner", "reviewer"];
const roles = Object.freeze([
  ...requiredRoles,
  ...(models.researcher ? ["researcher"] : []),
  ...(models.frontend ? ["frontend"] : []),
]);
const descriptions = {
  controller: "持续持有用户目标、全局状态、修正回路与最终交付。",
  researcher: "只在多源决定证据压缩有实测收益时返回可追溯来源账本。",
  planner: "只在独立判断能改变路线时形成有界的证据化规划。",
  reviewer: "只在独立判断能改变放行结果时依据真实证据验收。",
  frontend: "只在界面设计或前端制作存在专业缺口时形成可验证成品。",
};

if (!new Set(["codex", "claude", "copilot"]).has(host)) throw new Error(`Unsupported routing host: ${host || "(missing)"}`);
if (!out) throw new Error("--out requires a directory");
for (const role of requiredRoles) if (!models[role]) throw new Error(`--${role}-model is required`);
if (efforts.researcher && !models.researcher) throw new Error("--researcher-effort requires --researcher-model");
if (efforts.frontend && !models.frontend) throw new Error("--frontend-effort requires --frontend-model");
if (host === "copilot" && Object.values(efforts).some(Boolean)) {
  throw new Error("Copilot custom-agent profiles do not provide a portable reasoning-effort field");
}

const policy = "conditional";
const target = path.resolve(out, host);
mkdirSync(target, { recursive: true });
if (host === "codex") buildCodex(target);
else if (host === "claude") buildClaude(target);
else buildCopilot(target);

const metadata = {
  id: `odai-routing-${host}`,
  host,
  generatedFrom: "skills/odai/scripts/build-routing.mjs",
  mode: "single-controller-conditional-routing",
  mapping: Object.fromEntries(roles.map((role) => [role, {
    provider: host,
    model: models[role],
    reasoning_effort: efforts[role] || null,
  }])),
  routing_policy: {
    mode: policy,
    controller_identity: "persistent-task-thread",
    controller_owns_final_delivery: true,
    researcher_activation: models.researcher
      ? "only-when-multi-source-decision-evidence-compression-has-measured-net-benefit"
      : "unconfigured",
    planner_activation: "only-when-independent-judgment-can-change-route",
    reviewer_activation: "only-when-independent-judgment-can-change-release",
    frontend_activation: models.frontend
      ? "only-when-interface-design-or-production-needs-specialist-capability"
      : "unconfigured",
    controller_owns_implementation: true,
    sufficient_controller_defaults_to_single_pass: true,
  },
  runtime_verification: host === "codex"
    ? { mode: "post-run-executable", command: verifierCommand }
    : { mode: "host-native-evidence-required", command: null },
  activation: activation(host),
  profiles: roles.map((role) => ({ name: `odai-${role}`, purpose: descriptions[role] })),
};
writeFileSync(path.join(target, "ADAPTER.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(target);

function buildCodex(root) {
  const sourceDir = path.join(skillRoot, "assets", "codex-agents");
  const configRoot = path.join(root, ".codex");
  const agentsRoot = path.join(configRoot, "agents");
  const contractsRoot = path.join(configRoot, "role-contracts");
  mkdirSync(agentsRoot, { recursive: true });
  mkdirSync(contractsRoot, { recursive: true });
  writeRendered(path.join(sourceDir, "config.toml"), path.join(configRoot, "config.toml"), {
    __ODAI_CONTROLLER_MODEL_LINE__: `model = ${JSON.stringify(models.controller)}`,
    __ODAI_CONTROLLER_EFFORT_LINE__: tomlEffortLine(efforts.controller),
    __ODAI_CONTROLLER_BODY__: roleBody("controller", "codex"),
    __ODAI_AGENT_SECTIONS__: codexAgentSections(),
  });
  for (const role of roles.slice(1)) {
    writeRendered(path.join(sourceDir, "role.toml"), path.join(agentsRoot, `odai-${role}.toml`), {
      __ODAI_ROLE_MODEL__: JSON.stringify(models[role]),
      __ODAI_ROLE_EFFORT_LINE__: tomlEffortLine(efforts[role]),
      __ODAI_ROLE_BODY__: roleBody(role, "codex"),
    });
  }
  copyScript("verify-routing.mjs", path.join(configRoot, "odai-verify-routing.mjs"));
  copyScript("run-role.mjs", path.join(configRoot, "odai-run-role.mjs"));
  for (const role of roles) writeFileSync(path.join(contractsRoot, `odai-${role}.md`), roleBody(role, "codex"), "utf8");
}

function buildClaude(root) {
  const source = path.join(skillRoot, "assets", "claude-agents", "agent.md");
  const agentsRoot = path.join(root, ".claude", "agents");
  mkdirSync(agentsRoot, { recursive: true });
  for (const role of roles) {
    writeRendered(source, path.join(agentsRoot, `odai-${role}.md`), {
      __ODAI_ROLE__: role,
      __ODAI_ROLE_DESCRIPTION__: descriptions[role],
      __ODAI_ROLE_MODEL__: models[role],
      __ODAI_ROLE_EFFORT_LINE__: yamlEffortLine(efforts[role]),
      __ODAI_PERMISSION_MODE__: ["researcher", "planner", "reviewer"].includes(role) ? "plan" : "default",
      __ODAI_TOOLS_LINE__: "",
      __ODAI_ROLE_BODY__: roleBody(role, "claude"),
    });
  }
  writeFileSync(path.join(root, ".claude", "settings.patch.json"), `${JSON.stringify({ agent: "odai-controller" }, null, 2)}\n`, "utf8");
}

function buildCopilot(root) {
  const source = path.join(skillRoot, "assets", "copilot-agents", "agent.md");
  const agentsRoot = path.join(root, ".github", "agents");
  mkdirSync(agentsRoot, { recursive: true });
  for (const role of roles) {
    writeRendered(source, path.join(agentsRoot, `odai-${role}.agent.md`), {
      __ODAI_ROLE__: role,
      __ODAI_ROLE_DESCRIPTION__: descriptions[role],
      __ODAI_ROLE_MODEL__: models[role],
      __ODAI_DISABLE_MODEL_INVOCATION__: role === "controller" ? "true" : "false",
      __ODAI_USER_INVOCABLE__: role === "controller" ? "true" : "false",
      __ODAI_TOOLS__: role === "researcher"
        ? '["view", "glob", "grep"]'
        : ["planner", "reviewer"].includes(role) ? '["view", "glob", "grep", "shell"]' : '["*"]',
      __ODAI_ROLE_BODY__: roleBody(role, "copilot"),
    });
  }
  writeFileSync(path.join(root, "LAUNCH.json"), `${JSON.stringify({
    command: ["copilot", `--model=${models.controller}`, "--agent=odai-controller"],
    reason: "Copilot has no portable project setting that makes a custom agent the default main controller.",
    autoModelUnsupported: true,
  }, null, 2)}\n`, "utf8");
}

function roleBody(role, hostName) {
  const source = ownerFilePath("roleFiles", role);
  if (!existsSync(source)) throw new Error(`Missing canonical routing role body: ${source}`);
  const names = hostName === "codex"
    ? { researcher: "odai_researcher", planner: "odai_planner", reviewer: "odai_reviewer", frontend: "odai_frontend" }
    : { researcher: "odai-researcher", planner: "odai-planner", reviewer: "odai-reviewer", frontend: "odai-frontend" };
  const rendered = renderText(readFileSync(source, "utf8"), {
    __ODAI_POLICY__: policy,
    __ODAI_RESEARCHER_ROLE__: models.researcher ? names.researcher : "researcher（当前适配器未配置映射，不能调用）",
    __ODAI_PLANNER_ROLE__: names.planner,
    __ODAI_REVIEWER_ROLE__: names.reviewer,
    __ODAI_FRONTEND_ROLE__: models.frontend ? names.frontend : "frontend（当前适配器未配置映射，不能调用）",
    __ODAI_RUNTIME_VERIFICATION__: hostName === "codex"
      ? "实际路由必须用宿主返回的线程、角色、模型与用量证据核对，不从调用请求推断成功。"
      : "只有宿主原生运行证据能识别实际角色与模型时，路由才算已核实。",
    __ODAI_HOST_NOTE__: hostName === "copilot" ? "Copilot Auto 会覆盖角色模型选择；需要区分角色时不使用 Auto。" : "",
  }, source);
  const craft = role === "frontend"
    ? readFileSync(ownerFilePath("referenceFiles", "craft"), "utf8").trim()
    : "";
  if (hostName !== "codex") {
    return [rendered, ...(craft ? ["## Canonical 制作工艺", craft] : [])].join("\n\n");
  }
  const canonical = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  const responsibility = role === "controller"
    ? "你是唯一总控，持有完整目标、全局状态、修正回路与最终交付。"
    : `你只承担 ${role} 责任，不是第二个总控。`;
  return [
    `以下 canonical odai 是所有责任共享的内核；宿主角色契约只限制本责任，不得另建流程。${responsibility}`,
    canonical,
    ...(craft ? ["## Canonical 制作工艺", craft] : []),
    "## 宿主角色契约",
    rendered,
  ].join("\n\n");
}

function codexAgentSections() {
  return roles.slice(1).flatMap((role) => [
    `[agents.odai_${role}]`,
    `description = ${JSON.stringify(descriptions[role])}`,
    `config_file = ${JSON.stringify(`agents/odai-${role}.toml`)}`,
    "",
  ]).join("\n").trimEnd();
}

function activation(value) {
  if (value === "claude") return { main: "新会话由托管设置选择 odai-controller。", reload: "重启 Claude Code 或重新加载配置。" };
  if (value === "copilot") return {
    main: `使用 copilot --model=${models.controller} --agent=odai-controller 启动。`,
    reload: "安装或更新后重启 Copilot CLI。",
    limitation: "Copilot Auto 会覆盖角色模型选择。",
  };
  return {
    main: "普通会话由托管配置选择单一总控，其余责任按真实缺口调用。",
    reload: "修改后开启新的 Codex 会话。",
  };
}

function copyScript(name, targetFile) {
  const source = path.join(skillRoot, "scripts", name);
  if (!existsSync(source)) throw new Error(`Missing canonical routing script: ${source}`);
  writeFileSync(targetFile, readFileSync(source), "utf8");
}

function assertKnownArgs() {
  const known = new Set([
    "--host", "--out", "--controller-model", "--researcher-model", "--planner-model",
    "--reviewer-model", "--frontend-model", "--controller-effort", "--researcher-effort",
    "--planner-effort", "--reviewer-effort", "--frontend-effort", "--verifier-command",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!known.has(name)) throw new Error(`Unknown option: ${name}`);
    const value = argv[index + 1] || "";
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  }
}

function option(name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  const value = argv[index + 1] || "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function tomlEffortLine(value) { return value ? `model_reasoning_effort = ${JSON.stringify(value)}` : ""; }
function yamlEffortLine(value) { return value ? `effort: ${value}\n` : ""; }
function writeRendered(source, targetFile, replacements) {
  if (!existsSync(source)) throw new Error(`Missing canonical routing source: ${source}`);
  mkdirSync(path.dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, renderText(readFileSync(source, "utf8"), replacements, source), "utf8");
}
function renderText(input, replacements, source = "generated routing text") {
  let text = input;
  for (const [key, value] of Object.entries(replacements)) text = text.replaceAll(key, value);
  const unresolved = text.match(/__ODAI_[A-Z0-9_]+__/g);
  if (unresolved) throw new Error(`Unresolved routing template fields in ${source}: ${[...new Set(unresolved)].join(", ")}`);
  return text;
}
