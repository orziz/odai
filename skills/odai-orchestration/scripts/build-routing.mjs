#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { composeRoleContract, validateCompositionManifest, stripEntryMetadata } from "./compose-contracts.mjs";
import { createHash } from "node:crypto";
import { validateLocalCliRoute } from "./local-cli.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) printHelp();
const manifest = validateCompositionManifest(JSON.parse(readFileSync(path.join(skillRoot, "manifest.json"), "utf8")));
const governanceRoot = path.resolve(option("--governance-root") || path.join(skillRoot, "../odai"));
const governanceManifest = JSON.parse(readFileSync(path.join(governanceRoot, "manifest.json"), "utf8"));
if (governanceManifest.name !== "odai" || governanceManifest.runtimeContract !== manifest.governanceContract) throw new Error("Incompatible governance skill; supply --governance-root <odai-directory>");
function capture(root, declared) {
  if (!Array.isArray(declared.requiredFiles) || new Set(declared.requiredFiles).size !== declared.requiredFiles.length) throw new Error("Invalid requiredFiles");
  const contents = {};
  const digest = createHash("sha256").update(JSON.stringify(declared));
  for (const file of [...declared.requiredFiles].sort()) {
    if (typeof file !== "string" || file.includes("\\") || path.isAbsolute(file) || /^[A-Za-z]:/u.test(file)
      || file.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe bundle path: ${file}`);
    const source = realpathSync(path.resolve(root, file));
    const nested = path.relative(realpathSync(root), source);
    if (!nested || nested === ".." || nested.startsWith(`..${path.sep}`) || path.isAbsolute(nested)) throw new Error(`Bundle file escapes root: ${file}`);
    const bytes = readFileSync(source);
    contents[file] = bytes.toString("utf8");
    digest.update("\0").update(file).update("\0").update(bytes);
  }
  return { contents, digest: digest.digest("hex") };
}
const extension = capture(skillRoot, manifest);
const core = capture(governanceRoot, governanceManifest);
const contractContents = extension.contents;
const governance = { runtimeContract: governanceManifest.runtimeContract,
  skillBody: stripEntryMetadata(core.contents["SKILL.md"] || ""),
  referenceContracts: Object.fromEntries(Object.entries(governanceManifest.referenceFiles).map(([name, file]) => [name, core.contents[file]])) };

function printHelp() {
  console.log(`Usage:
  node skills/odai-orchestration/scripts/build-routing.mjs --host <codex|claude|copilot> --out <directory> [--governance-root <path>] \\
    --controller-model <model> --planner-model <model> --reviewer-model <model> \\
    [--researcher-model <model>] [--frontend-model <model>] [--creative-model <model>] [--writer-model <model>] [--controller-effort <effort>] \\
    [--researcher-effort <effort>] [--planner-effort <effort>] [--reviewer-effort <effort>] \\
    [--frontend-effort <effort>] [--creative-effort <effort>] [--writer-effort <effort>] [--verifier-command <command>]
  Claude: [--<role>-cli <codex|antigravity|grok>]; Codex: [--<role>-cli <claude|antigravity|grok>]\n  [--<role>-session <fresh|continue>] (non-controller roles)\n  [--named-dispatch] [--lead-mode] (Claude / Codex only)

生成 odai 的可选宿主 auto 路由适配器。一个持续总控负责实施整合与最终交付，只在证据压缩、独立规划、独立验收、前端专业制作或创意专业判断能改变结果时调用相应责任；researcher、frontend、creative 与 writer 映射默认不生成。Claude Code 可把非 controller 职责显式映射到只读本机 CLI；不增加第二总控或隐藏的每轮前置流程。`);
  process.exit(0);
}

assertKnownArgs();
const host = option("--host");
const leadMode = argv.includes("--lead-mode");
if (leadMode && !["claude", "codex"].includes(host)) throw new Error("--lead-mode requires claude or codex");
const namedDispatch = argv.includes("--named-dispatch");
if (namedDispatch && !["claude", "codex"].includes(host)) throw new Error("--named-dispatch requires claude or codex");
const out = option("--out");
const models = {
  controller: option("--controller-model"),
  researcher: option("--researcher-model"),
  planner: option("--planner-model"),
  reviewer: option("--reviewer-model"),
  frontend: option("--frontend-model"),
  creative: option("--creative-model"),
  writer: option("--writer-model"),
};
const efforts = {
  controller: option("--controller-effort"),
  researcher: option("--researcher-effort"),
  planner: option("--planner-effort"),
  reviewer: option("--reviewer-effort"),
  frontend: option("--frontend-effort"),
  creative: option("--creative-effort"),
  writer: option("--writer-effort"),
};
const localRoutes = {};
for (const role of ["researcher", "planner", "reviewer", "frontend", "creative", "writer"]) {
  const cli = option(`--${role}-cli`);
  if (!cli) continue;
  if (!["claude", "codex"].includes(host)) throw new Error(`--${role}-cli requires claude or codex`);
  if (!(host === "codex" ? ["claude", "antigravity", "grok"] : ["codex", "antigravity", "grok"]).includes(cli)) throw new Error(`--${role}-cli must be ${host === "codex" ? "claude" : "codex"}, antigravity, or grok`);
  localRoutes[role] = validateLocalCliRoute({ backend: "local-cli", cli, model: models[role],
    ...(efforts[role] ? { reasoningEffort: efforts[role] } : {}) });
}
const sessions = {};
for (const role of Object.keys(models)) {
  const session = option(`--${role}-session`);
  if (!session) continue;
  if (role === "controller" || host === "copilot" || !models[role] || !["fresh", "continue"].includes(session)) throw new Error("Invalid role session mapping");
  if (session === "continue" && localRoutes[role]) validateLocalCliRoute({ ...localRoutes[role], session });
  if (session === "continue" && host === "codex" && !localRoutes[role]) throw new Error("Codex 原生角色暂不支持会话续接：证据不足");
  sessions[role] = session;
}
const hasLocalRoutes = Object.keys(localRoutes).length > 0;
const roleMapping = (role) => ({
  ...(localRoutes[role] ? { backend: "local-cli", cli: localRoutes[role].cli } : { provider: host }),
  model: models[role], reasoning_effort: efforts[role] || null,
  ...(sessions[role] ? { session: sessions[role] } : {}),
});
const verifierCommand = option("--verifier-command") || "node .codex/odai-verify-routing.mjs";
const requiredRoles = ["controller", "planner", "reviewer"];
const roles = Object.freeze([
  ...requiredRoles,
  ...(models.researcher ? ["researcher"] : []),
  ...(models.frontend ? ["frontend"] : []),
  ...(models.creative ? ["creative"] : []),
  ...(models.writer ? ["writer"] : []),
]);
const descriptions = {
  writer: "只在方向已定、需要起草、改写或翻译面向用户或读者的文字时提供成稿或候选。",
  controller: "持续持有用户目标、全局状态、修正回路与最终交付。",
  researcher: "只为会改变决定的事实缺口返回有界来源账本，调用前有收益依据，回交后验贡献。",
  planner: "只在独立判断能改变路线时形成有界的证据化规划。",
  reviewer: "只在独立判断能改变放行结果时依据真实证据验收。",
  frontend: "只在界面设计或前端制作存在专业缺口时形成可验证成品。",
  creative: "只在发散构思、面向用户的写作与表达或品味把关存在专业缺口时提供构思、候选、取舍或把关意见。",
};

if (!new Set(["codex", "claude", "copilot"]).has(host)) throw new Error(`Unsupported routing host: ${host || "(missing)"}`);
if (!out) throw new Error("--out requires a directory");
for (const role of requiredRoles) if (!models[role]) throw new Error(`--${role}-model is required`);
if (efforts.researcher && !models.researcher) throw new Error("--researcher-effort requires --researcher-model");
if (efforts.frontend && !models.frontend) throw new Error("--frontend-effort requires --frontend-model");
if (efforts.writer && !models.writer) throw new Error("--writer-effort requires --writer-model");
if (efforts.creative && !models.creative) throw new Error("--creative-effort requires --creative-model");
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
  generatedFrom: "skills/odai-orchestration/scripts/build-routing.mjs",
  governance: { version: governanceManifest.skillVersion, digest: core.digest },
  orchestration: { version: manifest.version, digest: extension.digest },
  mode: "single-controller-conditional-routing",
  mapping: Object.fromEntries(roles.map((role) => [role, roleMapping(role)])),
  routing_policy: {
    mode: policy,
    controller_identity: "persistent-task-thread",
    controller_owns_final_delivery: true,
    researcher_activation: models.researcher
      ? "only-for-a-decision-blocking-multi-source-gap-with-justified-expected-benefit"
      : "unconfigured",
    planner_activation: "only-when-independent-judgment-can-change-route",
    reviewer_activation: "only-when-independent-judgment-can-change-release",
    frontend_activation: models.frontend
      ? "only-when-interface-design-or-production-needs-specialist-capability"
      : "unconfigured",
    creative_activation: models.creative
      ? "only-when-player-or-user-facing-content-needs-specialist-creative-judgment"
      : "unconfigured",
    writer_activation: models.writer ? "only-when-reader-facing-writing-needs-specialist-production" : "unconfigured",
    controller_owns_implementation: true,
    sufficient_controller_defaults_to_single_pass: true,
  },
  runtime_verification: host === "codex" && !hasLocalRoutes
    ? { mode: "post-run-executable", command: verifierCommand }
    : hasLocalRoutes ? {
      mode: "per-role-evidence-required",
      roles: Object.fromEntries(roles.map(role => [role, localRoutes[role]
        ? { mode: "role-executor-evidence", command: `node .${host}/odai-run-role.mjs --role ${role} --input <file>` }
        : { mode: "host-native-evidence-required", command: null }])),
    } : { mode: "host-native-evidence-required", command: null },
  activation: activation(host),
  profiles: roles.map((role) => ({ name: `odai-${role}`, purpose: descriptions[role] })),
};
writeFileSync(path.join(target, "ADAPTER.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
if (namedDispatch || leadMode) buildNamedDispatch();
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
  for (const role of roles.slice(1).filter(role => !localRoutes[role])) {
    writeRendered(path.join(sourceDir, "role.toml"), path.join(agentsRoot, `odai-${role}.toml`), {
      __ODAI_ROLE_MODEL__: JSON.stringify(models[role]),
      __ODAI_ROLE_EFFORT_LINE__: tomlEffortLine(efforts[role]),
      __ODAI_ROLE_SANDBOX_LINE__: ["creative", "writer"].includes(role) ? 'sandbox_mode = "read-only"' : "",
      __ODAI_ROLE_BODY__: roleBody(role, "codex"),
    });
  }
  if (hasLocalRoutes) {
    copyScript("local-cli.mjs", path.join(configRoot, "odai-local-cli.mjs"));
    writeFileSync(path.join(configRoot, "odai-routing.json"), `${JSON.stringify({ id: "odai-routing-installation", host: "codex", mapping: Object.fromEntries(roles.map(role => [role, roleMapping(role)])) }, null, 2)}\n`);
  }
  copyScript("verify-routing.mjs", path.join(configRoot, "odai-verify-routing.mjs"));
  copyScript("run-role.mjs", path.join(configRoot, "odai-run-role.mjs"));
  for (const role of roles) writeFileSync(path.join(contractsRoot, `odai-${role}.md`), roleBody(role, "codex"), "utf8");
}

function buildClaude(root) {
  const source = path.join(skillRoot, "assets", "claude-agents", "agent.md");
  const agentsRoot = path.join(root, ".claude", "agents");
  // Never leave a native proxy beside a local route, or reuse a stale local manifest.
  // Build output has no installation ownership record: reject instead of deleting files.
  for (const role of ["researcher", "planner", "reviewer", "frontend", "creative", "writer"]) {
    const opposite = localRoutes[role] ? `agents/odai-${role}.md` : `role-contracts/odai-${role}.md`;
    if (existsSync(path.join(root, ".claude", opposite))) throw new Error(`Conflicting previous routing output: ${opposite}; use a fresh --out directory`);
  }
  if (!hasLocalRoutes && ["odai-run-role.mjs", "odai-local-cli.mjs", "odai-routing.json"].some(file => existsSync(path.join(root, ".claude", file)))) {
    throw new Error("Conflicting previous local CLI output; use a fresh --out directory");
  }
  mkdirSync(agentsRoot, { recursive: true });
  for (const role of roles) {
    if (localRoutes[role]) {
      const contractsRoot = path.join(root, ".claude", "role-contracts");
      mkdirSync(contractsRoot, { recursive: true });
      writeFileSync(path.join(contractsRoot, `odai-${role}.md`), roleBody(role, "claude"), "utf8");
      continue;
    }
    writeRendered(source, path.join(agentsRoot, `odai-${role}.md`), {
      __ODAI_ROLE__: role,
      __ODAI_ROLE_DESCRIPTION__: descriptions[role],
      __ODAI_ROLE_MODEL__: models[role],
      __ODAI_ROLE_EFFORT_LINE__: yamlEffortLine(efforts[role]),
      __ODAI_PERMISSION_MODE__: ["researcher", "planner", "reviewer", "creative", "writer"].includes(role) ? "plan" : "default",
      __ODAI_TOOLS_LINE__: "",
      __ODAI_ROLE_BODY__: roleBody(role, "claude"),
    });
  }
  if (hasLocalRoutes) {
    copyScript("run-role.mjs", path.join(root, ".claude", "odai-run-role.mjs"));
    copyScript("local-cli.mjs", path.join(root, ".claude", "odai-local-cli.mjs"));
    writeFileSync(path.join(root, ".claude", "odai-routing.json"), `${JSON.stringify({
      id: "odai-routing-installation", host: "claude",
      mapping: Object.fromEntries(Object.keys(localRoutes).map(role => [role, roleMapping(role)])),
    }, null, 2)}\n`, "utf8");
  }
  writeFileSync(path.join(root, ".claude", "settings.patch.json"), `${JSON.stringify({
    agent: "odai-controller",
    ...(hasLocalRoutes ? { permissions: { allow: ["Bash(node .claude/odai-run-role.mjs:*)"] } } : {}),
  }, null, 2)}\n`, "utf8");
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
      __ODAI_TOOLS__: ["researcher", "creative", "writer"].includes(role)
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
  const source = path.join(skillRoot, manifest.roleFiles[role]);
  if (!existsSync(source)) throw new Error(`Missing canonical routing role body: ${source}`);
  const names = hostName === "codex"
    ? { researcher: "odai_researcher", planner: "odai_planner", reviewer: "odai_reviewer", frontend: "odai_frontend", creative: "odai_creative", writer: "odai_writer" }
    : { researcher: "odai-researcher", planner: "odai-planner", reviewer: "odai-reviewer", frontend: "odai-frontend", creative: "odai-creative", writer: "odai-writer" };
  if (["claude", "codex"].includes(hostName)) {
    for (const [localRole, route] of Object.entries(localRoutes)) {
      names[localRole] += `（本机 ${route.cli}，只读；把有界任务包写入文件后运行 node .${hostName}/odai-run-role.mjs --role ${localRole} --input <文件>）`;
    }
  }
  const rendered = renderText(composeRoleContract(role, governance, manifest, contractContents), {
    __ODAI_POLICY__: policy,
    __ODAI_RESEARCHER_ROLE__: models.researcher ? names.researcher : "researcher（当前适配器未配置映射，不能调用）",
    __ODAI_PLANNER_ROLE__: names.planner,
    __ODAI_REVIEWER_ROLE__: names.reviewer,
    __ODAI_FRONTEND_ROLE__: models.frontend ? names.frontend : "frontend（当前适配器未配置映射，不能调用）",
    __ODAI_WRITER_ROLE__: models.writer ? names.writer : "writer（当前适配器未配置映射，不能调用）",
    __ODAI_CREATIVE_ROLE__: models.creative ? names.creative : "creative（当前适配器未配置映射，不能调用）",
    __ODAI_RUNTIME_VERIFICATION__: hostName === "codex"
      ? (hasLocalRoutes ? "原生角色用宿主运行证据核对；本机 CLI 只接受执行器退出 0 且模型已核实的 version 1 证据，证据路径见 stderr；非 0 退出时不能接收正文为成功。" : "实际路由必须用宿主返回的线程、角色、模型与用量证据核对，不从调用请求推断成功。")
      : hasLocalRoutes
        ? "原生子代理用宿主运行证据核实角色与模型；本机 CLI 用角色执行器的 version 1 证据核实，证据路径见 stderr。执行器非 0 退出时不能接收正文为成功；显式请求的推理档也必须核实。"
        : "只有宿主原生运行证据能识别实际角色与模型时，路由才算已核实。",
    __ODAI_HOST_NOTE__: hostName === "copilot" ? "Copilot Auto 会覆盖角色模型选择；需要区分角色时不使用 Auto。" : "",
  }, source);
  return rendered + (role === "controller" ? [
    ...(hostName === "codex" && hasLocalRoutes ? ["\n\n默认 workspace-write 沙箱中，本机 CLI 职责实测因无法联网而失败（claude 零 token、退出码 1）。运行上述具体执行器命令时，需要申请越出沙箱，理由是需要联网，并写入本机 CLI 自己的目录；由用户按自己的审批策略批准该命令。用户拒绝或当前审批策略不允许时，如实报告该职责不可用，不改用别的模型。安装器不修改沙箱或联网设置。越出后 CLI 可联网并写用户目录；撤回时拒绝后续批准，恢复用户自行修改的配置。"] : []),
    ...Object.keys(sessions).filter(r => sessions[r] === "continue" && !localRoutes[r] && hostName === "claude").map(r => `\n\n${r} 开启会话续接时，用 SendMessage 继续上次派出的同一个 odai-${r} 子代理（可按名字或 agentId 续发，已完成的子代理也可以续发），不新派。`),
    ...(Object.values(sessions).includes("continue") && hasLocalRoutes ? ["\n\n本机 CLI 续接键按清单宿主优先取对应环境变量（Claude: CLAUDE_CODE_SESSION_ID；Codex: CODEX_THREAD_ID），另一变量作为后备；缺失时调用执行器须传 --session-key <宿主会话唯一键>。"] : []),
  ].join("") : "");
}

function codexAgentSections() {
  return roles.slice(1).filter(role => !localRoutes[role]).flatMap((role) => [
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
    ...["researcher", "planner", "reviewer", "frontend", "creative", "writer"].map(role => `--${role}-session`),
    "--host", "--out", "--governance-root", "--controller-model", "--researcher-model", "--planner-model",
    "--reviewer-model", "--frontend-model", "--creative-model", "--writer-model", "--controller-effort", "--researcher-effort",
    "--planner-effort", "--reviewer-effort", "--frontend-effort", "--creative-effort", "--writer-effort", "--verifier-command",
    "--researcher-cli", "--planner-cli", "--reviewer-cli", "--frontend-cli", "--creative-cli", "--writer-cli",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (["--named-dispatch", "--lead-mode"].includes(name)) { index -= 1; continue; }
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

function buildNamedDispatch() {
  const config = path.join(target, `.${host}`);
  const hooks = Object.fromEntries(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map(event => [event, [{ matcher: "*", hooks: [{ type: "command", command: `node "${host === "codex" ? "${PLUGIN_ROOT}/../.." : ".claude"}/odai-route-hook.mjs"`, timeout: 10 }] }]]));
  copyScript("route-hook.mjs", path.join(config, "odai-route-hook.mjs"));
  copyScript("recognize-routing.mjs", path.join(config, "recognize-routing.mjs"));
  writeFileSync(path.join(config, "odai-named-dispatch.json"), JSON.stringify({ id: "odai-named-dispatch", host, ...(leadMode ? { leadMode: true, namedDispatch } : {}), mapping: metadata.mapping }, null, 2) + "\n");
  if (host === "claude") {
    const file = path.join(config, "settings.patch.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), hooks }, null, 2) + "\n");
  } else {
    const plugin = path.join(config, "named-dispatch-plugin");
    mkdirSync(path.join(plugin, ".codex-plugin"), { recursive: true });
    mkdirSync(path.join(plugin, "hooks"), { recursive: true });
    mkdirSync(path.join(config, ".agents/plugins"), { recursive: true });
    writeFileSync(path.join(config, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "odai-local-routing", plugins: [{ name: "odai-named-dispatch", source: "./named-dispatch-plugin" }] }, null, 2) + "\n");
    // PLUGIN_ROOT is the plugin directory, whose parent contains the executor.
    for (const groups of Object.values(hooks)) groups[0].hooks[0].command = 'node "${PLUGIN_ROOT}/../odai-route-hook.mjs"';
    writeFileSync(path.join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ id: "odai-named-dispatch", name: "odai-named-dispatch", version: "0.2.3", description: "Optional named responsibility routing" }));
    writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks }, null, 2));
  }
}
