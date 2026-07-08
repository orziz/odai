const SUPPORTED_LANGUAGE_SET = new Set(["en", "zh"]);

const TRANSLATIONS = {
  en: {
    "language.name": "English",
    "interactive.sessionTitle": "odai interactive session",
    "interactive.typeTask":
      "Type a task, /providers, /models, /models select, /provider <name|auto>, /model <model|provider:model|auto|select>, /reasoning <auto|none|minimal|low|medium|high>, /context <auto|200k|1m>, /settings, /language <zh|en>, /auth, /agents, /init, /doctor, /setup, /status, /audit, /evidence, /policy, /sessions, /continue, /rollback, /authorize <scope>, /retry, /help, or /exit. Press Tab for completions.",
    "interactive.help":
      "Commands: /providers, /models [select|--json|--provider <name>], /provider <name|auto>, /model <model|provider:model|auto|select>, /reasoning <auto|none|minimal|low|medium|high>, /context <auto|200k|1m>, /settings, /language <zh|en>, /auth [api-key|claude-cli|provider-command|all|clear], /agents [--use-api-key] [--use-provider-command] [--main-provider <name>|--exclude-provider <name>], /init [--force], /doctor [--provider <name>|--all|--model <model>|--governance|--setup|--status|--audit|--evidence|--acceptance|--milestones|--sandbox [--smoke --allow-shell]|--e2e], /setup [--use-api-key] [--use-provider-command] [--model <model>], /status [--use-api-key] [--use-provider-command] [--model <model>], /audit [--use-api-key] [--use-provider-command] [--model <model>], /evidence, /policy, /sessions [--tail n] [--context|--compact], /continue [--run] [--use-api-key] [--use-provider-command] [--allow-shell] [--allow-network], /rollback [latest|record.json] [--path <file>] [--checkpoint <id>] [--confirm] [--delete-new-files], /authorize <scope>, /retry, /run <task> [--model <model> --reasoning <depth> --context <tokens> --subagent reviewer:auto[:model] --subagent challenger:<provider>[:model] --exclude-provider <name>], /exit. Tab completes commands, providers, model labels, and setting values.",
    "interactive.unknownCommand": "Unknown command. Use /help, or press Tab to complete commands.",
    "interactive.bye": "bye",
    "language.current": "Current CLI language: {language}. Use /language zh or /language en.",
    "language.updated": "Session CLI language updated.",
    "language.blocked": "Usage: /language <zh|en>",
    "prompt.footer": "Enter:send | Tab:complete | Up/Down:select | Ctrl+C:exit",
    "slash.model": "Switch the active model",
    "slash.models": "List or select discovered models",
    "slash.provider": "Switch the active provider",
    "slash.reasoning": "Set reasoning depth",
    "slash.context": "Set context window budget",
    "slash.settings": "Show current session settings",
    "slash.language": "Switch CLI language",
    "slash.auth": "Confirm provider auth for this session",
    "slash.agents": "Inspect subagent profiles and routing",
    "slash.doctor": "Probe provider/runtime readiness",
    "slash.setup": "Show setup and evidence checklist",
    "slash.status": "Show odai readiness status",
    "slash.audit": "Audit completion evidence",
    "slash.evidence": "Audit saved external evidence",
    "slash.sessions": "Inspect session transcripts",
    "slash.continue": "Continue from saved run/session context",
    "slash.rollback": "Rollback from saved checkpoints",
    "slash.authorize": "Authorize a gated risk scope",
    "slash.run": "Run a one-shot task from the REPL",
    "slash.init": "Scaffold .odai config files",
    "slash.policy": "Show current policy config",
    "slash.help": "Show command help",
    "slash.retry": "Retry the previous task",
    "slash.exit": "Exit odai",
    "completion.provider": "Provider",
    "completion.configuredModel": "Configured model hint",
    "completion.autoDefault": "Use provider/model default",
    "completion.reasoning.none": "Request no extra reasoning",
    "completion.reasoning.minimal": "Minimal reasoning effort",
    "completion.reasoning.low": "Low reasoning effort",
    "completion.reasoning.medium": "Medium reasoning effort",
    "completion.reasoning.high": "High reasoning effort",
    "completion.context.128k": "128k token budget",
    "completion.context.200k": "200k token budget",
    "completion.context.1m": "1m token budget",
    "completion.auth.apiKey": "Allow API-key providers for this session",
    "completion.auth.claudeCli": "Allow only the local Claude CLI provider",
    "completion.auth.providerCommand": "Allow subscription CLI providers for this session",
    "completion.auth.all": "Allow API-key and provider-command use",
    "completion.auth.clear": "Clear session auth confirmations",
    "completion.provider.auto": "Let odai route provider",
    "completion.model.auto": "Clear session model override",
    "completion.model.select": "Pick from discovered models",
    "completion.models.select": "Open model picker",
    "completion.models.json": "Show discovery diagnostics",
    "completion.models.provider": "Filter by provider",
    "completion.models.model": "Use model override",
    "completion.models.useApiKey": "Permit API-key probing",
    "completion.models.useProviderCommand": "Permit provider CLI probing",
    "completion.providers.useApiKey": "Show API-key provider readiness",
    "completion.providers.useProviderCommand": "Show subscription CLI readiness",
    "completion.agents.useApiKey": "Permit API-key provider routing preview",
    "completion.agents.useProviderCommand": "Permit CLI provider routing preview",
    "completion.agents.mainProvider": "Exclude current main provider from subagents",
    "completion.agents.excludeProvider": "Exclude provider from auto routing",
    "completion.doctor.all": "Probe all eligible providers",
    "completion.doctor.provider": "Choose provider",
    "completion.doctor.model": "Use model override",
    "completion.doctor.useApiKey": "Permit API-key provider calls",
    "completion.doctor.useProviderCommand": "Permit provider CLI calls",
    "completion.doctor.save": "Save run evidence",
    "completion.doctor.stream": "Stream provider output and meter",
    "completion.continue.run": "Rerun resumable command",
    "completion.continue.useApiKey": "Reconfirm API-key providers",
    "completion.continue.useProviderCommand": "Reconfirm provider CLI",
    "completion.continue.allowShell": "Permit shell tool gate",
    "completion.continue.allowNetwork": "Permit network tool gate",
    "completion.run.provider": "Choose provider",
    "completion.run.model": "Use model override",
    "completion.run.reasoning": "Set reasoning depth",
    "completion.run.context": "Set context budget",
    "completion.run.subagent": "Add subagent review/challenge",
    "completion.run.excludeProvider": "Exclude provider from auto routing",
    "completion.run.useApiKey": "Permit API-key providers",
    "completion.run.useProviderCommand": "Permit provider CLIs",
    "completion.run.allowShell": "Permit shell tool gate",
    "completion.run.allowNetwork": "Permit network tool gate",
    "completion.sessions.tail": "Show recent transcript events",
    "completion.sessions.context": "Read compact resume context",
    "completion.sessions.compact": "Write sanitized context snapshot",
    "completion.language.zh": "Use Chinese CLI text",
    "completion.language.en": "Use English CLI text",
    "setup.cliSetup.note":
      "Use ./cli/bin/odai.mjs from this repository until the package bin is linked or installed as odai; setup does not modify PATH.",
    "setup.note":
      "Setup is a read-only guide. It does not call real providers, execute subscription CLIs, or run sandbox smoke commands.",
    "update.notice":
      "Update available: {packageName} {currentVersion} -> {latestVersion}. Run: {installCommand}",
  },
  zh: {
    "language.name": "中文",
    "interactive.sessionTitle": "odai 交互会话",
    "interactive.typeTask":
      "输入任务，或使用 /providers、/models、/models select、/provider <name|auto>、/model <model|provider:model|auto|select>、/reasoning <auto|none|minimal|low|medium|high>、/context <auto|200k|1m>、/settings、/language <zh|en>、/auth、/agents、/init、/doctor、/setup、/status、/audit、/evidence、/policy、/sessions、/continue、/rollback、/authorize <scope>、/retry、/help、/exit。按 Tab 补全。",
    "interactive.help":
      "命令: /providers、/models [select|--json|--provider <name>]、/provider <name|auto>、/model <model|provider:model|auto|select>、/reasoning <auto|none|minimal|low|medium|high>、/context <auto|200k|1m>、/settings、/language <zh|en>、/auth [api-key|claude-cli|provider-command|all|clear]、/agents [--use-api-key] [--use-provider-command] [--main-provider <name>|--exclude-provider <name>]、/init [--force]、/doctor [--provider <name>|--all|--model <model>|--governance|--setup|--status|--audit|--evidence|--acceptance|--milestones|--sandbox [--smoke --allow-shell]|--e2e]、/setup [--use-api-key] [--use-provider-command] [--model <model>]、/status [--use-api-key] [--use-provider-command] [--model <model>]、/audit [--use-api-key] [--use-provider-command] [--model <model>]、/evidence、/policy、/sessions [--tail n] [--context|--compact]、/continue [--run] [--use-api-key] [--use-provider-command] [--allow-shell] [--allow-network]、/rollback [latest|record.json] [--path <file>] [--checkpoint <id>] [--confirm] [--delete-new-files]、/authorize <scope>、/retry、/run <task> [--model <model> --reasoning <depth> --context <tokens> --subagent reviewer:auto[:model] --subagent challenger:<provider>[:model] --exclude-provider <name>]、/exit。Tab 会补全命令、provider、模型标签和设置值。",
    "interactive.unknownCommand": "未知命令。使用 /help，或按 Tab 补全命令。",
    "interactive.bye": "再见",
    "language.current": "当前 CLI 语言: {language}。使用 /language zh 或 /language en 切换。",
    "language.updated": "当前会话的 CLI 语言已更新。",
    "language.blocked": "用法: /language <zh|en>",
    "prompt.footer": "Enter:发送 | Tab:补全 | 上/下:选择 | Ctrl+C:退出",
    "slash.model": "切换当前模型",
    "slash.models": "列出或选择已探查模型",
    "slash.provider": "切换当前 provider",
    "slash.reasoning": "设置推理深度",
    "slash.context": "设置上下文窗口预算",
    "slash.settings": "显示当前会话设置",
    "slash.language": "切换 CLI 语言",
    "slash.auth": "确认当前会话的 provider 授权",
    "slash.agents": "查看 subagent 配置和路由",
    "slash.doctor": "探查 provider / runtime 就绪状态",
    "slash.setup": "显示设置和证据清单",
    "slash.status": "显示 odai 就绪状态",
    "slash.audit": "审计完成证据",
    "slash.evidence": "审计已保存的外部证据",
    "slash.sessions": "查看会话 transcript",
    "slash.continue": "从已保存 run/session 上下文继续",
    "slash.rollback": "从已保存 checkpoint 回滚",
    "slash.authorize": "授权受控风险范围",
    "slash.run": "在 REPL 中执行一次性任务",
    "slash.init": "创建 .odai 配置脚手架",
    "slash.policy": "显示当前 policy 配置",
    "slash.help": "显示命令帮助",
    "slash.retry": "重试上一个任务",
    "slash.exit": "退出 odai",
    "completion.provider": "Provider",
    "completion.configuredModel": "已配置模型提示",
    "completion.autoDefault": "使用 provider/model 默认值",
    "completion.reasoning.none": "请求不额外推理",
    "completion.reasoning.minimal": "最低推理强度",
    "completion.reasoning.low": "低推理强度",
    "completion.reasoning.medium": "中等推理强度",
    "completion.reasoning.high": "高推理强度",
    "completion.context.128k": "128k token 预算",
    "completion.context.200k": "200k token 预算",
    "completion.context.1m": "1m token 预算",
    "completion.auth.apiKey": "允许当前会话使用 API-key provider",
    "completion.auth.claudeCli": "只允许当前会话使用本机 Claude CLI provider",
    "completion.auth.providerCommand": "允许当前会话使用订阅 CLI provider",
    "completion.auth.all": "允许 API-key 和 provider-command",
    "completion.auth.clear": "清除当前会话授权确认",
    "completion.provider.auto": "让 odai 自动路由 provider",
    "completion.model.auto": "清除当前会话模型覆盖",
    "completion.model.select": "从已探查模型中选择",
    "completion.models.select": "打开模型选择器",
    "completion.models.json": "显示探查诊断",
    "completion.models.provider": "按 provider 过滤",
    "completion.models.model": "使用模型覆盖",
    "completion.models.useApiKey": "允许 API-key 探查",
    "completion.models.useProviderCommand": "允许 provider CLI 探查",
    "completion.providers.useApiKey": "显示 API-key provider 就绪状态",
    "completion.providers.useProviderCommand": "显示订阅 CLI 就绪状态",
    "completion.agents.useApiKey": "允许 API-key provider 路由预览",
    "completion.agents.useProviderCommand": "允许 CLI provider 路由预览",
    "completion.agents.mainProvider": "subagent 排除当前主 provider",
    "completion.agents.excludeProvider": "从自动路由中排除 provider",
    "completion.doctor.all": "探查所有符合条件的 provider",
    "completion.doctor.provider": "选择 provider",
    "completion.doctor.model": "使用模型覆盖",
    "completion.doctor.useApiKey": "允许 API-key provider 调用",
    "completion.doctor.useProviderCommand": "允许 provider CLI 调用",
    "completion.doctor.save": "保存 run 证据",
    "completion.doctor.stream": "流式显示 provider 输出和计量",
    "completion.continue.run": "重跑可恢复命令",
    "completion.continue.useApiKey": "重新确认 API-key provider",
    "completion.continue.useProviderCommand": "重新确认 provider CLI",
    "completion.continue.allowShell": "允许 shell tool gate",
    "completion.continue.allowNetwork": "允许 network tool gate",
    "completion.run.provider": "选择 provider",
    "completion.run.model": "使用模型覆盖",
    "completion.run.reasoning": "设置推理深度",
    "completion.run.context": "设置上下文预算",
    "completion.run.subagent": "添加 subagent 审查/挑战",
    "completion.run.excludeProvider": "从自动路由中排除 provider",
    "completion.run.useApiKey": "允许 API-key provider",
    "completion.run.useProviderCommand": "允许 provider CLI",
    "completion.run.allowShell": "允许 shell tool gate",
    "completion.run.allowNetwork": "允许 network tool gate",
    "completion.sessions.tail": "显示最近 transcript 事件",
    "completion.sessions.context": "读取紧凑 resume 上下文",
    "completion.sessions.compact": "写入脱敏上下文快照",
    "completion.language.zh": "使用中文 CLI 文案",
    "completion.language.en": "使用英文 CLI 文案",
    "setup.cliSetup.note":
      "在 package bin link 或安装为 odai 前，先使用本仓库的 ./cli/bin/odai.mjs；setup 不会修改 PATH。",
    "setup.note": "Setup 是只读指引，不会调用真实 provider、执行订阅 CLI 或运行 sandbox smoke 命令。",
    "update.notice": "发现新版本: {packageName} {currentVersion} -> {latestVersion}。更新: {installCommand}",
  },
};

export const SUPPORTED_LANGUAGES = [...SUPPORTED_LANGUAGE_SET];

export function normalizeLanguage(value, fallback = "en") {
  const hasExplicitFallback = fallback !== undefined && fallback !== null && fallback !== "";
  const fallbackLanguage = hasExplicitFallback
    ? (SUPPORTED_LANGUAGE_SET.has(fallback) ? fallback : "en")
    : "";
  const raw = String(value || "").trim().toLowerCase().replace("_", "-");
  if (!raw) return fallbackLanguage;
  if (raw === "中文" || raw === "chinese" || raw === "cn" || raw.startsWith("zh")) return "zh";
  if (raw === "english" || raw.startsWith("en")) return "en";
  return fallbackLanguage;
}

export function detectLanguage({ env = process.env, fallback = "en", includeSystemLocale = true } = {}) {
  if (env?.ODAI_LANG) {
    return normalizeLanguage(env.ODAI_LANG, fallback);
  }
  if (includeSystemLocale) {
    return normalizeLanguage(env?.LC_ALL || env?.LC_MESSAGES || env?.LANG, fallback);
  }
  return normalizeLanguage(fallback, "en");
}

export function languageName(language) {
  return t(language, "language.name");
}

export function t(language, key, values = {}) {
  const normalized = normalizeLanguage(language);
  const template = TRANSLATIONS[normalized]?.[key] || TRANSLATIONS.en[key] || key;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : `{${name}}`,
  );
}
