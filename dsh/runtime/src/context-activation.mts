import type { UnknownRecord } from "./runtime-types.mjs";

export const ODAI_CONTEXTUAL_TOOL_NAMES = Object.freeze([
  "odai_routing_config",
  "odai_human_care",
  "odai_human_safety",
  "odai_responsibility_return",
  "odai_skill_source_config",
  "odai_skill_evolution",
  "odai_output_config",
  "odai_compaction_config",
  "odai_memory",
  "odai_human_safety_continuity",
] as const);

export const ODAI_CORE_TOOL_NAMES = Object.freeze([
  "odai_context_capability",
  "odai_responsibility_gap",
  "odai_reference",
] as const);

export type OdaiToolName = (typeof ODAI_CONTEXTUAL_TOOL_NAMES)[number] | (typeof ODAI_CORE_TOOL_NAMES)[number];

export interface ContextActivation {
  readonly care: boolean;
  readonly safety: boolean;
  readonly routingConfig: boolean;
  readonly skillSource: boolean;
  readonly skillEvolution: boolean;
  readonly outputConfig: boolean;
  readonly compactionConfig: boolean;
  readonly memory: boolean;
  readonly continuity: boolean;
}

export interface ActivationOptions {
  child?: boolean;
  responsibilityReturn?: boolean;
}

interface ToolSchemaSummary {
  name: string;
  description?: string;
  parameters?: UnknownRecord;
}

const CARE_CUE = /(?:疲惫|心累|焦虑|紧张|自我怀疑|怀疑自己|否定自己|内耗|反刍|反复纠结|羞耻|丢脸|害怕犯错|怕犯错|持续消极|提不起劲|失去行动感|阿岱|欧黛|fatigue|burn(?:ed|t) out|anxi(?:ous|ety)|self[- ]doubt|doubt myself|ruminat(?:e|ing|ion)|shame|fear of mistakes?|persistent negativity|cannot get started|companionship style|practical support style)/iu;
const CRISIS_CUE = /(?:持续低落|越来越低落|绝望|无望|撑不住|活不下去|不想活|想死|结束生命|成为负担|自伤|自残|轻生|自杀|伤害自己|immediate danger|persistent low mood|hopeless|cannot go on|burden|self[- ]harm|suicid(?:e|al)|want to die|kill myself|end my life)/iu;
const ROUTING_CONFIG_CUE = /(?:(?:研究|调查|规划|计划|审查|验收|前端|researcher|planner|reviewer|frontend).{0,24}(?:模型|路由|映射|调度|派发|provider|model|route|mapping|dispatch|same-turn|child|同轮|子代理)|(?:模型|路由|映射|调度|派发|provider|model|route|mapping|dispatch|same-turn|child|同轮|子代理).{0,24}(?:研究|调查|规划|计划|审查|验收|前端|researcher|planner|reviewer|frontend)|(?:所有|当前|职责|责任)?(?:模型|路由|调度|派发)(?:配置|映射)|routing config)/iu;
const SKILL_SOURCE_CUE = /(?:(?:odai|阿岱|欧黛).{0,20}(?:skill|治理).{0,20}(?:来源|source|bundled|auto|user)|(?:skill|治理).{0,20}(?:来源|source).{0,20}(?:odai|阿岱|欧黛))/iu;
const SKILL_EVOLUTION_CUE = /(?:(?:odai|skill|治理).{0,24}(?:演化|代际|generation|evolution|rebase|rollback|activate|deactivate)|(?:演化|代际|generation|evolution|rebase|rollback).{0,24}(?:odai|skill|治理))/iu;
const OUTPUT_CONFIG_CUE = /(?:(?:输出|回复|回答).{0,20}(?:normal|正常|简洁|精简|concise|economy|经济|token|上限)|(?:maxTokens|token 上限|output mode|输出模式)|(?:(?:这个|当前|本次|本)(?:会话|对话)|\b(?:this|current)\s+(?:chat|conversation|session)\b).{0,24}(?:上限|限制|limit|cap|ceiling)|(?:\b(?:output|token)?\s*(?:limit|cap|ceiling)\b).{0,24}\b(?:this|current)\s+(?:chat|conversation|session)\b)/iu;
const COMPACTION_CONFIG_CUE = /(?:(?:压缩|compaction).{0,32}(?:模型|provider|model|推理|reasoning|配置|设置|查看|重置)|(?:模型|provider|model).{0,20}(?:压缩摘要|compaction summary))/iu;
const MEMORY_CUE = /(?:记住|记忆|忘记|以后默认|今后默认|从现在起|所有项目|每个项目|长期使用|一直使用|偏好|remember|memory|forget|from now on|going forward|by default|all projects|always use|never use)/iu;
const CONTINUITY_CUE = /(?:(?:跨会话|安全|关怀|照护|支持).{0,24}(?:档案|记录|连续性|记住|保存|查看|显示|导出|更正|删除|清空)|(?:continuity|safety|care|support).{0,24}(?:record|remember|save|show|export|correct|remove|clear))/iu;

export function classifyContextActivation(text: unknown): Readonly<ContextActivation> {
  const value = typeof text === "string" ? text : "";
  const safety = CRISIS_CUE.test(value);
  return Object.freeze({
    care: !safety && CARE_CUE.test(value),
    safety,
    routingConfig: ROUTING_CONFIG_CUE.test(value),
    skillSource: SKILL_SOURCE_CUE.test(value),
    skillEvolution: SKILL_EVOLUTION_CUE.test(value),
    outputConfig: OUTPUT_CONFIG_CUE.test(value),
    compactionConfig: COMPACTION_CONFIG_CUE.test(value),
    memory: MEMORY_CUE.test(value),
    continuity: CONTINUITY_CUE.test(value),
  });
}

export function activeOdaiToolNames(
  activation: ContextActivation,
  options: ActivationOptions = {},
): readonly OdaiToolName[] {
  if (options.child) return Object.freeze([]);
  const names = new Set<OdaiToolName>(ODAI_CORE_TOOL_NAMES);
  if (options.responsibilityReturn) names.delete("odai_reference");
  if (activation.routingConfig) names.add("odai_routing_config");
  if (activation.care) names.add("odai_human_care");
  if (activation.safety) names.add("odai_human_safety");
  if (options.responsibilityReturn) names.add("odai_responsibility_return");
  if (activation.skillSource) names.add("odai_skill_source_config");
  if (activation.skillEvolution) names.add("odai_skill_evolution");
  if (activation.outputConfig) names.add("odai_output_config");
  if (activation.compactionConfig) names.add("odai_compaction_config");
  if (activation.memory) names.add("odai_memory");
  if (activation.continuity) names.add("odai_human_safety_continuity");
  return Object.freeze([...names]);
}

export function inactiveOdaiToolNames(activeNames: Iterable<string>): readonly (typeof ODAI_CONTEXTUAL_TOOL_NAMES)[number][] {
  const active = new Set(activeNames);
  return Object.freeze(ODAI_CONTEXTUAL_TOOL_NAMES.filter((name) => !active.has(name)));
}

export function estimateContextTokens(value: unknown): number {
  return Math.ceil(String(value ?? "").length / 4);
}

export function estimateToolSchemaTokens(tools: readonly ToolSchemaSummary[] | null | undefined): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  return Math.ceil(JSON.stringify(schemas).length / 4) + 4;
}
