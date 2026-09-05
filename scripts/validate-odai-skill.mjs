#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertRepositoryVersionPolicy } from "./version-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assertRepositoryVersionPolicy({ repoRoot });
const skillRoot = path.join(repoRoot, "skills", "odai");
const ribaoRoot = path.join(repoRoot, "skills", "ribao");
const failures = [];
const warnings = [];

const files = listFiles(skillRoot);
const manifestPath = path.join(skillRoot, "manifest.json");
let canonicalManifest;
try {
  canonicalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`manifest.json: invalid JSON: ${error.message}`);
}
const ownerFiles = canonicalManifest && typeof canonicalManifest === "object" && !Array.isArray(canonicalManifest)
  ? [
      ...Object.values(canonicalManifest.roleFiles ?? {}),
      ...Object.values(canonicalManifest.referenceFiles ?? {}),
    ].filter((file) => typeof file === "string")
  : [];
const allowedFiles = new Set([
  "SKILL.md",
  "manifest.json",
  "agents/openai.yaml",
  "assets/codex-agents/config.toml",
  "assets/codex-agents/role.toml",
  "assets/claude-agents/agent.md",
  "assets/copilot-agents/agent.md",
  "assets/hooks-policy.example.json",
  "assets/task-state.md",
  "scripts/build-hooks.mjs",
  "scripts/build-routing.mjs",
  "scripts/install-routing.mjs",
  "scripts/run-role.mjs",
  "scripts/verify-routing.mjs",
  "scripts/odai-hook.mjs",
  ...ownerFiles,
]);

for (const relativePath of allowedFiles) {
  if (!files.includes(relativePath)) fail(`${relativePath}: required resource is missing`);
}
for (const relativePath of files) {
  if (!allowedFiles.has(relativePath)) fail(`${relativePath}: resource has no owner in the current architecture`);
}

const skillFile = path.join(skillRoot, "SKILL.md");
if (!existsSync(skillFile)) fail("SKILL.md: missing");
const skillText = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "";
validateFrontmatter(skillText);
validateConstitution(skillText);
validateStructure();
validateBehavior();
validateOpenaiMetadata();
validateHookSources();
validateRoutingSources();
await validateSkillManifest();
validateEvaluationIsolation();
validateReferences();
warnRepeatedRules();
validateRibaoSkill();

const entryTokenEstimate = estimateTokens(skillText);
const referenceTokenEstimate = files
  .filter((file) => /^references\/.*\.md$/u.test(file))
  .reduce((total, file) => total + estimateTokens(readFileSync(path.join(skillRoot, file), "utf8")), 0);
const roleContractTokenEstimate = files
  .filter((file) => /^assets\/routing-roles\/.*\.md$/u.test(file))
  .reduce((total, file) => total + estimateTokens(readFileSync(path.join(skillRoot, file), "utf8")), 0);
if (entryTokenEstimate > 2700) {
  warn(`SKILL.md: entry estimate ${entryTokenEstimate} exceeds capability-preserving review threshold 2700`);
}

if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (failures.length > 0) {
  console.error("Validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `odai skill ecosystem is valid (${files.length} odai files, ${listFiles(ribaoRoot).length} ribao files, ` +
    `${warnings.length} warnings, entry estimate ${entryTokenEstimate} tokens, ` +
    `on-demand references estimate ${referenceTokenEstimate} tokens, ` +
    `role contracts estimate ${roleContractTokenEstimate} tokens).`,
  );
}

function roleFile(name) {
  const value = canonicalManifest?.roleFiles?.[name];
  return typeof value === "string" ? value : `__missing-role-owner__/${name}`;
}

function referenceFile(name) {
  const value = canonicalManifest?.referenceFiles?.[name];
  return typeof value === "string" ? value : `__missing-reference-owner__/${name}`;
}

function validateFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return fail("SKILL.md: missing or invalid YAML frontmatter");

  const fields = new Map();
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    const field = line.match(/^([a-z0-9-]+):\s*(.*)$/);
    if (!field) {
      fail(`SKILL.md frontmatter line ${index + 2}: expected a top-level key/value`);
      continue;
    }
    fields.set(field[1], unquote(field[2].trim()));
  }

  for (const key of fields.keys()) {
    if (!new Set(["name", "description"]).has(key)) fail(`SKILL.md frontmatter: unexpected key ${key}`);
  }
  const name = fields.get("name") || "";
  const description = fields.get("description") || "";
  if (!/^[a-z0-9-]+$/.test(name)) fail(`SKILL.md frontmatter: invalid name ${JSON.stringify(name)}`);
  if (name !== path.basename(skillRoot)) fail(`SKILL.md frontmatter: name ${name} does not match folder`);
  if (!description) fail("SKILL.md frontmatter: description is required");
  if (description.length > 1024) fail(`SKILL.md frontmatter: description is ${description.length} chars`);
  if (/[<>]/.test(description)) fail("SKILL.md frontmatter: description contains angle brackets");
}

function validateConstitution(text) {
  const section = text.match(/^## 精神内核\r?\n([\s\S]*?)(?=^## )/m)?.[1] || "";
  const contracts = [
    /\*\*事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。\*\*/,
    /用户定义目标、价值取舍和不可接受结果[^。\n]*模型核实事实、纠正关键前提/,
    /成事是实现用户真正所求[^。\n]*不曲事实、不越权、不造事/,
    /证据变化就改判/,
    /相邻发现[^。\n]*有据建议[^。\n]*必要条件或另获授权[^。\n]*才实施/,
    /即时生命与人身安全高于任务进度[^。\n]*提前预警、及时干预、主动引导[^。\n]*防止二次伤害/,
  ];
  for (const contract of contracts) {
    if (!contract.test(section)) fail(`SKILL.md: spiritual core missing contract: ${contract}`);
  }
}

function validateStructure() {
  const checks = [
    {
      path: "SKILL.md",
      headings: ["精神内核", "当前判断", "按表现分配支撑", "共同行动边界", "完成"],
      anchors: [
        "`事｜实｜法｜成｜界`",
        "行动前须有充分且唯一的意图证据",
        "不能让目标变唯一",
        "**自主完成**",
        "**探索构想**",
        "讨论不授权写入或实施",
        "探索、决定与实施不自动切换",
        "**证据纠偏**",
        "**结构化支撑**",
        "**风险保护**",
        referenceFile("care"),
        referenceFile("human-safety"),
        referenceFile("dao"),
        referenceFile("craft"),
        referenceFile("planning"),
        referenceFile("leverage"),
        referenceFile("support"),
        referenceFile("verification"),
        ".odai/local.md",
      ],
    },
    {
      path: "assets/task-state.md",
      headings: ["任务状态"],
      anchors: ["用户当前主要语言"],
    },
    {
      path: referenceFile("dao"),
      headings: ["合作与决定", "目标、参考与写入", "高影响动作"],
    },
    {
      path: referenceFile("care"),
      headings: ["回应原则", "同一总控内的交互风格", "自然与透明"],
      anchors: [referenceFile("human-safety"), "阿岱与欧黛"],
    },
    {
      path: referenceFile("human-safety"),
      headings: ["优先级与边界", "主动识别与确认", "分级回应", "即时危险", "透明干预与防止二次伤害", "跨会话安全连续性", "隐私与现实支持"],
      anchors: [referenceFile("care"), "明显低落、绝望或难以支撑", "自伤、轻生或自杀信号"],
    },
    {
      path: referenceFile("craft"),
      headings: ["制作前定形", "实施", "设计", "界面与实时交互", "写作与文档", "审查"],
      anchors: [referenceFile("planning"), referenceFile("leverage")],
    },
    {
      path: referenceFile("planning"),
      headings: ["适用与授权", "事实基线", "计划缩放", "合同与工作包", "验证、状态与续作", "最小交付结构"],
      anchors: ["assets/task-state.md", referenceFile("craft"), referenceFile("leverage")],
    },
    {
      path: referenceFile("support"),
      headings: ["按表现升降", "连续性与记忆"],
      anchors: ["assets/task-state.md", referenceFile("planning"), referenceFile("leverage"), referenceFile("verification")],
    },
    {
      path: referenceFile("leverage"),
      headings: ["唯一总控与四项可选责任", "宿主能力与降级", "安装宿主路由", "使用、安装与创建其他能力", "组合与下放"],
    },
    {
      path: referenceFile("verification"),
      headings: ["建立验收", "判断完成"],
    },
  ];

  for (const check of checks) {
    const fullPath = path.join(skillRoot, check.path);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    for (const heading of check.headings) {
      if (!new RegExp(`^#{1,3}\\s+${escapeRegExp(heading)}\\s*$`, "m").test(text)) {
        fail(`${check.path}: missing required section: ${heading}`);
      }
    }
    for (const anchor of check.anchors || []) {
      if (!text.includes(anchor)) fail(`${check.path}: missing routing or schema anchor: ${anchor}`);
    }
  }
}

function validateBehavior() {
  const checks = [
    {
      path: "SKILL.md",
      label: "adaptive support",
      patterns: [
        /宿主已证能力[^。\n]*实际表现[^。\n]*最低充分能力/,
        /已暴露不再问，未暴露不猜/,
        /总控持有目标、状态、实施、修正与交付/,
        /独立责任只有能改变结果且净收益已证时才用/,
        /自主完成[\s\S]{0,160}直接闭环[^。\n]*不额外制造计划、清单或状态/,
        /结构化支撑[\s\S]{0,180}稳定后撤回/,
        /支撑只能补当前缺口[^。\n]*不能降低目标、删减验收/,
        /危机保护[\s\S]{0,260}明确自残、轻生或即时危险时任务让位/,
      ],
    },
    {
      path: "SKILL.md",
      label: "shared boundaries",
      patterns: [
        /新动作[^。\n]*事实依据、必要性和授权/,
        /用户点名局部结果[^。\n]*只改完成它所需对象/,
        /背景、约束、样式、示例和参考实现默认只读[^。\n]*不产生写入授权/,
        /根因和手段先作为待验证输入/,
        /方向性改进有多个合理交付物[^。\n]*完整呈现[^。\n]*范围分歧[^。\n]*真实结果、非目标与不可接受退化/,
        /低成本或可撤回不能替代对齐/,
        /用户纠正使目标、范围或授权变化时[^。\n]*重新对齐受影响部分/,
        /只指出遗漏、未执行或错误完成声明时[^。\n]*在仍有效的授权内补做并重验/,
        /状态依事实与事件改变[^。\n]*未结束原位更新[^。\n]*叙述不算迁移/,
        /修改共享对象或既有契约[^。\n]*保持默认行为/,
        /“严格、完整、增强”提高证据、反证、保持项和验收强度/,
        /用户确认只补授权、不补事实/,
        /未读、未做、未跑、未验证或未调用(?:都)?如实说明/,
        /明确要求须有结果或标明未决/,
      ],
    },
    {
      path: referenceFile("dao"),
      label: "authority and risk",
      patterns: [
        /事实判断由证据校准[^。\n]*价值冲突由用户决定/,
        /能自行查证的事实先查证/,
        /疑似误写、否定要求或彼此冲突的约束/,
        /感知目标先结合现有基线、参考和场景形成可逆方案/,
        /尚未对齐时[^。\n]*只供讨论比较[^。\n]*不因可撤回就写入/,
        /已获实施授权且结果与边界清楚时[^。\n]*自主选择实现细节并验证/,
        /读取不产生写入授权/,
        /证据不足时不实施，也不另拍一个“更保守”的值/,
        /用户可以决定价值取舍并承担仍可控的剩余风险/,
        /方案未被现有证据否定、安全依赖已经成立[^。\n]*才可在原授权范围内实施并标明未验证/,
        /用户确认不能让已否定的手段重新满足原目标[^。\n]*不能替代未证实的保护链/,
        /不授权模型另拍数值、扩大范围或弱化回退/,
        /拒绝原手段后仍承接原目标/,
        /不为凑完整虚构[^。\n]*环境[^。\n]*责任人[^。\n]*替代方案/,
        /默认使用用户当前主要语言[^。\n]*产物语言遵循用户要求或项目约定/,
      ],
    },
    {
      path: referenceFile("care"),
      label: "non-crisis care and interaction style",
      patterns: [
        /低负担的日常支持/,
        /不作诊断、风险评分、模型路由或状态持久化/,
        /焦虑时减少不必要的不确定项/,
        /自我怀疑或羞耻时区分已发生的事实与对自我的结论/,
        /内耗或反刍时不增加比较和自责材料/,
        /最多保留一个很小的可选动作/,
        /允许暂停、改变节奏或暂不解决/,
        /不用“想开点”“振作起来”/,
        /普通负面情绪只触发与强度相称的支持，不自动进入危机流程/,
        /转读 `references\/human-safety\.md`/,
        /阿岱与欧黛[^。\n]*可随时取消/,
        /不得改变执行责任边界、建立情绪画像/,
        /用户没有选择时采用自然混合/,
        /不得自动保存当下情绪/,
        /不使用虚假共情、未经告知的外部动作/,
      ],
    },
    {
      path: referenceFile("human-safety"),
      label: "human safety and crisis care",
      patterns: [
        /任务、路由、成本和交付节奏均不得压过本文件/,
        /即时生命与人身安全高于任务进度/,
        /不凭单一语气、用词、沉默或短暂低落/,
        /不得合成隐藏风险分或冒充临床诊断/,
        /不等待用户使用“抑郁、轻生”等标签/,
        /多个累积、持续或加重的信号改变安全判断时[^。\n]*可观察事实和关切/,
        /不建立跨任务监控、画像或隐性评分/,
        /安全判断只问真正会改变下一步的最少信息[^。\n]*一次一个/,
        /直接确认此刻是否安全/,
        /任何可信倾向都不得[^。\n]*被忽略/,
        /计划、手段与行动只决定紧急程度/,
        /明确提到自伤、轻生、自杀[^。\n]*当前任务降为次要/,
        /立即联系当地急救或前往最近急诊/,
        /不提供伤害方法、比较、优化、规避发现或善后建议/,
        /不连续盘问[^。\n]*不强迫复述创伤、伤害经过或方法细节/,
        /不一次倾倒大量热线与说明/,
        /同一理解上下文的回应者透明执行安全确认/,
        /独立、用户控制的安全连续性档案/,
        /默认不自动提取/,
        /只保存用户确认的关怀与沟通偏好、希望被留意的信号、有效支持方式和用户制定的安全计划/,
        /不得保存模型诊断、风险分、未确认推断、原始危机对话/,
        /可见、可检查、可更正、可撤回、可导出和可物理删除/,
        /每次仍以当下表达重新判断/,
        /不得用普通记忆或隐藏状态替代/,
        /不提取为通用长期记忆、用户画像/,
        /不把一次危机表达永久化为身份/,
      ],
    },
    {
      path: referenceFile("craft"),
      label: "built-in craft",
      patterns: [
        /首次写入前确认预期结果、写入对象、必须保持的行为和完成证据/,
        /只改解决目标所需的最小完整部分/,
        /不把未受信内容直接拼入可执行上下文/,
        /不靠放宽断言或吞错造绿/,
        /正文完成不冒充已发布/,
      ],
    },
    {
      path: referenceFile("planning"),
      label: "scaled implementation planning",
      patterns: [
        /仅仅“任务复杂”不自动触发计划文档/,
        /计划完成只表示路线、边界与验收已达到可执行标准，不表示实现已经完成/,
        /按后续执行真正需要的结构选择最小层级/,
        /同一任务只保留一个主状态/,
        /非主载体不能维护另一份进度/,
        /聊天摘要和执行者自报不能替代主状态或原始证据/,
      ],
    },
    {
      path: referenceFile("support"),
      label: "adaptive continuity support",
      patterns: [
        /同一路线没有新证据却继续尝试/,
        /把下一步缩成能独立验证的动作/,
        /触发支撑的缺口已闭合[^。\n]*撤掉对应额外结构/,
        /主状态、字段、唯一 owner 与续作统一遵循 `references\/planning\.md`/,
        /本文件只判断是否需要外化[^。\n]*不维护第二份进度或并行责任账本/,
        /只有稳定、跨任务有用且可复核的信息才保存/,
        /没有维护授权不自动修改技能或项目规则/,
      ],
    },
    {
      path: referenceFile("leverage"),
      label: "external leverage",
      patterns: [
        /odai 是唯一用户入口和最终交付 owner/,
        /实施始终由总控负责/,
        /researcher[^。\n]*只补多源事实获取与原始上下文压缩缺口/,
        /planner[^。\n]*只补独立判断缺口/,
        /reviewer[^。\n]*独立判断能改变尚未放行的具体属性/,
        /用户明确要求独立复核时[^。\n]*独立性本身就是验收属性/,
        /frontend[^。\n]*不是领域资料包/,
        /高后果只提高证据、授权和验收强度，不自动制造角色调用/,
        /路由是否成立看实际调用，不看配置或自报/,
        /不能取得所需能力时，继续当前能力可安全推进的部分/,
        /未安装路由器时，odai 仍完整可用/,
        /安装或启用前征得用户同意/,
        /单一能力已能完整解决就不组合/,
        /review 只读/,
      ],
    },
    {
      path: referenceFile("verification"),
      label: "honest completion",
      patterns: [
        /映射成可观察证据/,
        /每份证据绑定实际覆盖的交付对象与属性/,
        /配套构建或测试通过只证明对应配套结果[^。\n]*主要交付物仍须有与用户目标对应的完成证据/,
        /测试、构建、静态检查、diff、截图、日志和人工观察不能互相冒充/,
        /需要独立判断的组合属性[^。\n]*按 `references\/leverage\.md` 取得独立复核/,
        /权威筛选、查询、命令、样本或来源[^。\n]*按该入口核验/,
        /两个或更多写入批次[^。\n]*组件完成不具有传递性/,
        /唯一组合状态[^。\n]*共享契约[^。\n]*完整验收/,
        /冲突解决或兼容性编辑[^。\n]*新的获授权写入/,
        /明确区分已实施、已验证与未验证/,
        /前一状态未实际结束时更新同一状态[^。\n]*不创建后继值或把当前候选写成历史/,
        /权威载体与用户文档指向同一当前值/,
        /证据足够就停止/,
      ],
    },
  ];

  for (const check of checks) {
    const fullPath = path.join(skillRoot, check.path);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    for (const pattern of check.patterns) {
      if (!pattern.test(text)) fail(`${check.path}: missing ${check.label}: ${pattern}`);
    }
  }

  const entry = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const leverageOnlyPatterns = [
    /规划、判断、诊断或验收切片升至最低充分档/,
    /才迁移整个任务/,
  ];
  for (const pattern of leverageOnlyPatterns) {
    if (pattern.test(entry)) {
      fail(`SKILL.md: detailed capability-routing mechanism must live only in references/leverage.md: ${pattern}`);
    }
  }
}

function validateOpenaiMetadata() {
  const file = path.join(skillRoot, "agents", "openai.yaml");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  requireQuotedField(text, "display_name");
  const shortDescription = requireQuotedField(text, "short_description");
  const defaultPrompt = requireQuotedField(text, "default_prompt");
  if (shortDescription && (shortDescription.length < 25 || shortDescription.length > 64)) {
    fail(`agents/openai.yaml: short_description must be 25-64 chars, got ${shortDescription.length}`);
  }
  if (defaultPrompt && !defaultPrompt.includes("$odai")) {
    fail("agents/openai.yaml: default_prompt must mention $odai");
  }
  if (defaultPrompt && !defaultPrompt.includes("交付真实可用结果")) {
    fail("agents/openai.yaml: default_prompt must stay focused on the user-visible result");
  }
  if (defaultPrompt && /模型|推理档|subagent|升档|最高可靠能力/.test(defaultPrompt)) {
    fail("agents/openai.yaml: default_prompt must not expose internal capability routing");
  }
}

function validateHookSources() {
  const policyFile = path.join(skillRoot, "assets", "hooks-policy.example.json");
  const runtimeFile = path.join(skillRoot, "scripts", "odai-hook.mjs");
  const builderFile = path.join(skillRoot, "scripts", "build-hooks.mjs");
  if (![policyFile, runtimeFile, builderFile].every(existsSync)) return;

  try {
    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    if (policy.version !== 1) fail("assets/hooks-policy.example.json: version must be 1");
    if (!Array.isArray(policy.protectedPaths)) fail("assets/hooks-policy.example.json: protectedPaths must be an array");
    if (!Array.isArray(policy.checks)) fail("assets/hooks-policy.example.json: checks must be an array");
  } catch (error) {
    fail(`assets/hooks-policy.example.json: invalid JSON: ${error.message}`);
  }

  const runtime = readFileSync(runtimeFile, "utf8");
  for (const fragment of ["protectedPaths", "blockUnresolvedWrites", "stop_hook_active", "collectChangedPaths"]) {
    if (!runtime.includes(fragment)) fail(`scripts/odai-hook.mjs: missing hook boundary: ${fragment}`);
  }

  const builder = readFileSync(builderFile, "utf8");
  for (const host of ["codex", "claude", "copilot", "gemini", "grok", "kimi"]) {
    if (!builder.includes(`"${host}"`)) fail(`scripts/build-hooks.mjs: missing host adapter: ${host}`);
  }
}

function validateRoutingSources() {
  const codexRoot = path.join(skillRoot, "assets", "codex-agents");
  const configFile = path.join(codexRoot, "config.toml");
  const codexRoleFile = path.join(codexRoot, "role.toml");
  const claudeTemplateFile = path.join(skillRoot, "assets", "claude-agents", "agent.md");
  const copilotTemplateFile = path.join(skillRoot, "assets", "copilot-agents", "agent.md");
  const builderFile = path.join(skillRoot, "scripts", "build-routing.mjs");
  const installerFile = path.join(skillRoot, "scripts", "install-routing.mjs");
  const roleRunnerFile = path.join(skillRoot, "scripts", "run-role.mjs");
  const verifierFile = path.join(skillRoot, "scripts", "verify-routing.mjs");
  const roleFiles = ["controller", "researcher", "planner", "reviewer", "frontend"]
    .map((role) => path.join(skillRoot, roleFile(role)));
  if (![configFile, codexRoleFile, claudeTemplateFile, copilotTemplateFile, ...roleFiles, builderFile, installerFile, roleRunnerFile, verifierFile].every(existsSync)) return;

  const config = readFileSync(configFile, "utf8");
  for (const fragment of [
    "__ODAI_AGENT_SECTIONS__",
    "__ODAI_CONTROLLER_MODEL_LINE__",
    "__ODAI_CONTROLLER_BODY__",
  ]) {
    if (!config.includes(fragment)) fail(`assets/codex-agents/config.toml: missing controller contract: ${fragment}`);
  }
  const codexRole = readFileSync(codexRoleFile, "utf8");
  for (const fragment of ["__ODAI_ROLE_MODEL__", "__ODAI_ROLE_EFFORT_LINE__", "__ODAI_ROLE_BODY__"]) {
    if (!codexRole.includes(fragment)) fail(`assets/codex-agents/role.toml: missing host wrapper field: ${fragment}`);
  }
  const roleSources = [
    ["controller", readFileSync(roleFiles[0], "utf8"), ["唯一总控", "任务列表、计划、状态更新、委派说明与回交", "路线、实施、修正回路与最终交付", "直接谋定、行动、验证和交付", "不为展示路由", "独立判断能改变路线", "独立判断能改变放行结果", "总控在当前上下文做最小修正", "新鲜独立上下文与有界任务包", "不复制完整总控会话", "路线或验收设计失效", "已有决定性证据闭合所有要求时立即收口", "__ODAI_RESEARCHER_ROLE__", "__ODAI_RUNTIME_VERIFICATION__"]],
    ["researcher", readFileSync(roleFiles[1], "utf8"), ["researcher 证据获取责任", "会改变后续决定的具体事实问题", "单一权威来源", "只读", "精确来源指针", "相互冲突", "仍未知事项", "停止依据", "不得编辑、实施、选方案", "来源账本只是检索索引", "不宣称节省成本"]],
    ["planner", readFileSync(roleFiles[2], "utf8"), ["独立规划责任", "不预做实施", "当前上下文能可靠闭环", "mode: direct", "mode: planned", "target", "evidence", "scope", "decision", "交回总控", "review: none", "accept", "stop", "steps", "增量重规划", "researcher 来源账本"]],
    ["reviewer", readFileSync(roleFiles[3], "utf8"), ["独立验收责任", "按验收缺口裁剪", "不得包含完整会话转储", "不调用工具", "不扫描工作目录", "不重跑已成功的确定性检查", "完整 `accept`", "`pass`、`fail` 或 `unresolved`", "route: execution", "route: planning", "route: user", "route: blocked", "不得制造额外流程"]],
    ["frontend", readFileSync(roleFiles[4], "utf8"), ["frontend 专业责任", "不是第二个总控", "允许与禁止范围", "总控或 planner", "当前任务线程", "有界独立上下文", referenceFile("craft"), "局部修复保持最小", "不写入本通用责任合同"]],
  ];
  for (const [label, text, fragments] of roleSources) {
    if (!text.includes("跟随用户当前的主要语言")) {
      fail(`assets/routing-roles/${label}.md: missing user-language contract`);
    }
    for (const fragment of fragments) {
      if (!text.includes(fragment)) fail(`assets/routing-roles/${label}.md: missing routing contract: ${fragment}`);
    }
  }
  const hostTemplates = [
    ["claude", readFileSync(claudeTemplateFile, "utf8"), ["name: odai-__ODAI_ROLE__", "__ODAI_ROLE_MODEL__", "__ODAI_PERMISSION_MODE__", "__ODAI_TOOLS_LINE__", "__ODAI_ROLE_BODY__"]],
    ["copilot", readFileSync(copilotTemplateFile, "utf8"), ["name: odai-__ODAI_ROLE__", "__ODAI_ROLE_MODEL__", "__ODAI_DISABLE_MODEL_INVOCATION__", "__ODAI_TOOLS__", "__ODAI_ROLE_BODY__"]],
  ];
  for (const [host, text, fragments] of hostTemplates) {
    for (const fragment of fragments) {
      if (!text.includes(fragment)) fail(`assets/${host}-agents/agent.md: missing host wrapper field: ${fragment}`);
    }
  }
  const allRoutingSources = [config, codexRole, ...hostTemplates.map((item) => item[1]), ...roleSources.map((item) => item[1])];
  if (/gpt-5\.6-(?:sol|terra|luna)/.test(allRoutingSources.join("\n"))) {
    fail("assets/*-agents: canonical role sources must not hard-code a model family");
  }

  const builder = readFileSync(builderFile, "utf8");
  for (const fragment of [
    "--host", "--out", "--controller-model", "--researcher-model", "--planner-model", "--reviewer-model", "--frontend-model",
    "--verifier-command", "single-controller-conditional-routing", "controller_owns_implementation", "Canonical 制作工艺",
    "ownerFilePath", "requiredFiles", "realpathSync", "roleBody", "codexAgentSections", "odai-researcher", "odai-planner", "odai-reviewer", "odai-frontend", "ADAPTER.json", '"codex"', '"claude"', '"copilot"',
  ]) {
    if (!builder.includes(fragment)) fail(`scripts/build-routing.mjs: missing adapter behavior: ${fragment}`);
  }
  if (/route-hook\.mjs|codexRouteHooks|hooks\.json/.test(builder)) {
    fail("scripts/build-routing.mjs: managed routing must not inject a hidden per-turn hook");
  }

  const installer = readFileSync(installerFile, "utf8");
  for (const fragment of ["--scope", "--target", "--uninstall", "--yes", "--controller-model", "--researcher-model", "--planner-model", "--reviewer-model", "--frontend-model", "odai-routing.json", "odai-run-routing.mjs", "odai-run-role.mjs", "odai-verify-routing.mjs", "assertManagedState", "uninstall", "requiresNewSession", "settings.local.json", "目标已有非 odai 管理的配置", "拒绝删除"]) {
    if (!installer.includes(fragment)) fail(`scripts/install-routing.mjs: missing safe installation behavior: ${fragment}`);
  }

  const roleRunner = readFileSync(roleRunnerFile, "utf8");
  for (const fragment of ["--role", "controller", "researcher", "planner", "reviewer", "frontend", "model_verified", "tool_evidence", "odai-routing.json", "reasoning_efforts", "requested"] ) {
    if (!roleRunner.includes(fragment)) fail(`scripts/run-role.mjs: missing role routing behavior: ${fragment}`);
  }

  const verifier = readFileSync(verifierFile, "utf8");
  for (const fragment of ["--project", "--role", "--after", "--agent-path", "turn_context", "odai-routing.json", "verified: true"]) {
    if (!verifier.includes(fragment)) fail(`scripts/verify-routing.mjs: missing runtime verification behavior: ${fragment}`);
  }
}

async function validateSkillManifest() {
  const manifestFile = path.join(skillRoot, "manifest.json");
  if (!existsSync(manifestFile)) return;
  const manifest = canonicalManifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return fail("manifest.json: root must be an object");
  }
  const fields = new Set([
    "schemaVersion",
    "name",
    "skillVersion",
    "runtimeContract",
    "roleFiles",
    "referenceFiles",
    "requiredFiles",
  ]);
  for (const field of Object.keys(manifest)) {
    if (!fields.has(field)) fail(`manifest.json: unexpected field ${field}`);
  }
  if (manifest.schemaVersion !== 2) fail("manifest.json: schemaVersion must be 2");
  if (manifest.name !== "odai") fail("manifest.json: name must be odai");
  if (manifest.runtimeContract !== 6) fail("manifest.json: runtimeContract must be 6");
  validateOwnerMap(manifest, "roleFiles", ["controller", "researcher", "planner", "reviewer", "frontend"]);
  validateOwnerMap(manifest, "referenceFiles", ["dao", "planning", "craft", "verification", "support", "leverage", "care", "human-safety"]);
  const ownedPaths = [
    ...Object.values(manifest.roleFiles ?? {}),
    ...Object.values(manifest.referenceFiles ?? {}),
  ];
  if (new Set(ownedPaths).size !== ownedPaths.length) {
    fail("manifest.json: roleFiles and referenceFiles must not share an owner path");
  }
  if (!Array.isArray(manifest.requiredFiles)) {
    fail("manifest.json: requiredFiles must be an array");
  } else {
    const expected = [...allowedFiles].filter((file) => file !== "manifest.json").sort();
    const declared = [...manifest.requiredFiles].sort();
    if (new Set(manifest.requiredFiles).size !== manifest.requiredFiles.length) {
      fail("manifest.json: requiredFiles contains duplicates");
    }
    if (JSON.stringify(declared) !== JSON.stringify(expected)) {
      fail("manifest.json: requiredFiles must own every canonical skill resource except manifest.json itself");
    }
  }

  try {
    const bundleModule = await import(pathToFileURL(path.join(repoRoot, "dsh", "runtime", "build", "skill-bundle.mjs")));
    const bundle = bundleModule.loadSkillBundle(skillFile);
    if (bundle.manifest.runtimeContract !== bundleModule.ODAI_RUNTIME_CONTRACT) {
      fail("manifest.json: runtimeContract is not supported by the shared DSH runtime");
    }
    if (bundle.manifest.skillVersion !== manifest.skillVersion) {
      fail("manifest.json: runtime parser disagrees with canonical skillVersion");
    }
    if (JSON.stringify(Object.keys(bundle.roleContracts)) !== JSON.stringify(Object.keys(manifest.roleFiles))) {
      fail("manifest.json: runtime parser disagrees with roleFiles owner topology");
    }
    if (JSON.stringify(Object.keys(bundle.referenceContracts)) !== JSON.stringify(Object.keys(manifest.referenceFiles))) {
      fail("manifest.json: runtime parser disagrees with referenceFiles owner topology");
    }
  } catch (error) {
    fail(`manifest.json: runtime bundle validation failed: ${error.message}`);
  }
}

function validateOwnerMap(manifest, field, expectedNames) {
  const value = manifest[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`manifest.json: ${field} must be an object`);
    return;
  }
  const names = Object.keys(value);
  if (JSON.stringify(names.sort()) !== JSON.stringify([...expectedNames].sort())) {
    fail(`manifest.json: ${field} must declare exactly ${expectedNames.join(", ")}`);
  }
  const paths = Object.values(value);
  if (paths.some((file) => typeof file !== "string" || file.length === 0)) {
    fail(`manifest.json: ${field} values must be non-empty paths`);
  }
  if (new Set(paths).size !== paths.length) fail(`manifest.json: ${field} paths must be unique`);
  if (Array.isArray(manifest.requiredFiles)) {
    for (const file of paths) {
      if (!manifest.requiredFiles.includes(file)) fail(`manifest.json: ${field} path ${String(file)} must appear in requiredFiles`);
    }
  }
}

function validateEvaluationIsolation() {
  const isolationFile = path.join(repoRoot, "scripts", "canary-isolation.mjs");
  const harnessFile = path.join(repoRoot, "scripts", "odai-canary-harness.mjs");
  const adapters = [
    ["claude-canary-runner.mjs", "claude", ["--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--strict-mcp-config", "--settings"]],
    ["grok-canary-runner.mjs", "grok", ["--no-memory", "--no-subagents", "--disable-web-search"]],
    ["kimi-canary-runner.mjs", "kimi", ["--skills-dir"]],
    ["antigravity-canary-runner.mjs", "antigravity", ["--new-project", "--disable-slash-commands"]],
    ["openai-compatible-canary-runner.mjs", "openai-compatible", ["path escapes the fixture repository", "maxTurns"]],
    ["codex-canary-judge.mjs", "codex", ["--ephemeral", "--ignore-user-config", "--ignore-rules"]],
    ["grok-canary-judge.mjs", "grok", ["--no-memory", "--no-subagents", "--tools"]],
  ];
  const requiredFiles = [isolationFile, harnessFile, ...adapters.map(([file]) => path.join(repoRoot, "scripts", file))];
  for (const file of requiredFiles) {
    if (!existsSync(file)) fail(`${path.relative(repoRoot, file)}: required evaluation-isolation resource is missing`);
  }
  if (!requiredFiles.every(existsSync)) return;

  const isolation = readFileSync(isolationFile, "utf8");
  for (const fragment of ["odai-canary-isolation/v1", "ODAI_CANARY_SKILL_MODE", "ODAI_CANARY_HOME", "HOME must be the harness-owned isolated home"]) {
    if (!isolation.includes(fragment)) fail(`scripts/canary-isolation.mjs: missing isolation contract: ${fragment}`);
  }

  const harness = readFileSync(harnessFile, "utf8");
  for (const fragment of [
    "odai-canary-isolation/v1",
    "prepareCanaryIsolation",
    "assertFixtureIsolation",
    "runner-isolation-failed",
    "judge-isolation-failed",
    "isolation_contract: CANARY_ISOLATION_CONTRACT",
    "--out for a formal run must be outside the repository tree",
    "--ignore-user-config",
    "--ignore-rules",
  ]) {
    if (!harness.includes(fragment)) fail(`scripts/odai-canary-harness.mjs: missing evaluation isolation behavior: ${fragment}`);
  }
  if (!harness.includes("Handle the user request using the host's default capabilities")) {
    fail("scripts/odai-canary-harness.mjs: off-arm prompt must remain treatment-neutral");
  }

  for (const [file, adapter, boundaries] of adapters) {
    const text = readFileSync(path.join(repoRoot, "scripts", file), "utf8");
    if (!text.includes("emitCanaryIsolation")) fail(`scripts/${file}: missing isolation receipt`);
    if (!text.includes(`\"${adapter}\"`)) fail(`scripts/${file}: isolation receipt does not name adapter ${adapter}`);
    for (const boundary of boundaries) {
      if (!text.includes(boundary)) fail(`scripts/${file}: missing platform isolation boundary: ${boundary}`);
    }
  }
}

function validateReferences() {
  for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(path.join(skillRoot, relativePath), "utf8");
    for (const match of text.matchAll(/`((?:references|assets)\/[A-Za-z0-9_./-]+)`/g)) {
      const target = match[1];
      const resolved = path.resolve(skillRoot, target);
      if (!isInside(skillRoot, resolved)) fail(`${relativePath}: reference escapes skill root: ${target}`);
      else if (!existsSync(resolved)) fail(`${relativePath}: missing reference target: ${target}`);
    }
    if (/^assets\/(?:claude|copilot)-agents\//.test(relativePath) || /^assets\/routing-roles\//.test(relativePath)) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.length > 240) warn(`${relativePath}:${index + 1}: long rule line (${line.length} chars)`);
    });
  }
}

function validateRibaoSkill() {
  const ribaoFiles = listFiles(ribaoRoot);
  const allowed = new Set(["SKILL.md", "agents/openai.yaml"]);
  for (const relativePath of allowed) {
    if (!ribaoFiles.includes(relativePath)) fail(`skills/ribao/${relativePath}: required resource is missing`);
  }
  for (const relativePath of ribaoFiles) {
    if (!allowed.has(relativePath)) fail(`skills/ribao/${relativePath}: resource has no owner`);
  }

  const entryFile = path.join(ribaoRoot, "SKILL.md");
  if (!existsSync(entryFile)) return;
  const text = readFileSync(entryFile, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || "";
  if (!/^name:\s*ribao\s*$/m.test(frontmatter)) fail("skills/ribao/SKILL.md: name must be ribao");
  if (!/^description:\s*\S+/m.test(frontmatter)) fail("skills/ribao/SKILL.md: description is required");
  for (const heading of ["确认交付", "收集事实", "形成正文", "验收与交回"]) {
    if (!new RegExp(`^##\\s+${heading}\\s*$`, "m").test(text)) {
      fail(`skills/ribao/SKILL.md: missing required section: ${heading}`);
    }
  }
  for (const pattern of [
    /既有模板[^。\n]*标题[^。\n]*(?:日期|周期)[^。\n]*分区[^。\n]*字段[^。\n]*信息粒度/,
    /最终答复先给出同结构的完整正文/,
    /不用一段摘要或追问替代正文/,
    /不能单独推出工时、完成比例、负责人、承诺或业务效果/,
    /每个实质独立的事项单独呈现/,
    /没有完成证据的既有事项保留原状态、责任与日期/,
    /缺少工时、比例等字段只阻断依赖它们的填报/,
    /正文完成不等于已保存、已发送或已提交/,
    /由 odai 调用[^。\n]*odai 统一核对目标、边界与最终交付/,
  ]) {
    if (!pattern.test(text)) fail(`skills/ribao/SKILL.md: missing reporting behavior: ${pattern}`);
  }

  const metadataFile = path.join(ribaoRoot, "agents", "openai.yaml");
  if (existsSync(metadataFile)) {
    const metadata = readFileSync(metadataFile, "utf8");
    for (const field of ["display_name", "short_description", "default_prompt"]) {
      if (!new RegExp(`^\\s*${field}:\\s*\"[^\"]+\"\\s*$`, "m").test(metadata)) {
        fail(`skills/ribao/agents/openai.yaml: missing quoted ${field}`);
      }
    }
    if (!metadata.includes("$ribao")) fail("skills/ribao/agents/openai.yaml: default_prompt must mention $ribao");
    if (!/^\s*allow_implicit_invocation:\s*true\s*$/m.test(metadata)) {
      fail("skills/ribao/agents/openai.yaml: implicit invocation must be enabled");
    }
  }

  const tokenEstimate = estimateTokens(text);
  if (tokenEstimate > 2500) warn(`skills/ribao/SKILL.md: estimate ${tokenEstimate} exceeds threshold 2500`);
}

function warnRepeatedRules() {
  const seen = new Map();
  for (const relativePath of files.filter((file) => file.endsWith(".md")
    && !/^assets\/(?:claude|copilot)-agents\//.test(file)
    && !/^assets\/routing-roles\//.test(file))) {
    const lines = readFileSync(path.join(skillRoot, relativePath), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const normalized = line.replace(/^[#*\-\d.\s]+/, "").replace(/[`*_]/g, "").trim();
      if (normalized.length < 40) return;
      const previous = seen.get(normalized);
      if (previous && previous.path !== relativePath) {
        warn(`${relativePath}:${index + 1}: repeats ${previous.path}:${previous.line}`);
      } else {
        seen.set(normalized, { path: relativePath, line: index + 1 });
      }
    });
  }
}

function requireQuotedField(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"));
  if (!match) {
    fail(`agents/openai.yaml: missing quoted ${key}`);
    return "";
  }
  return JSON.parse(match[1]);
}

function listFiles(root) {
  const result = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) result.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }
  if (existsSync(root)) walk(root);
  return result.sort();
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}

function estimateTokens(value) {
  const text = String(value || "");
  const cjkChars = (
    text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g) || []
  ).length;
  return Math.ceil(cjkChars + (text.length - cjkChars) / 4);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}
