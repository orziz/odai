import type { DshEvent, DshMessage, ModelRoute, RuntimeEventData } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export type OdaiRouteRole = "controller" | "researcher" | "planner" | "reviewer" | "frontend";
export type OdaiRouteAction = "direct" | "delegate" | "upgrade";

export interface RouteConsideration {
  readonly role: string;
  readonly match: string;
  readonly action: "skip";
  readonly reasonCode: string;
  readonly signals: readonly string[];
  readonly unmet: readonly string[];
}

export interface RouteDecision {
  readonly role: OdaiRouteRole;
  readonly mode: OdaiRouteAction;
  readonly action: OdaiRouteAction;
  readonly targetRole?: OdaiRouteRole;
  readonly reasonCode: string;
  readonly reason: string;
  readonly signals: readonly string[];
  readonly considerations?: readonly RouteConsideration[];
}

export interface ResponsibilityGapState {
  readonly responsibility: string;
  readonly gap: string;
  readonly stateDigest: string;
}

export interface ResponsibilityInterruptionState {
  readonly responsibility?: string;
  readonly continuationText?: string;
}

export interface RouteDecisionInput {
  readonly text?: string;
  readonly proposal?: ResponsibilityGapState;
  readonly interruption?: ResponsibilityInterruptionState;
}

export interface FrontendSpecializationSignals {
  readonly explicit: boolean;
  readonly scope: boolean;
  readonly delivery: boolean;
  readonly strongWork: boolean;
  readonly nonUiRequest: boolean;
  readonly specialistDepth: boolean;
  readonly surfaceCount: number;
  readonly axes: readonly string[];
  readonly substantial: boolean;
}

function isContinuationRole(value: unknown): value is "planner" | "frontend" {
  return value === "planner" || value === "frontend";
}

export const HIGH_IMPACT_PLANNER_REASON = "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE";
export const RESEARCHER_EVIDENCE_REASON = "RESEARCHER_MULTI_SOURCE_DECISION_EVIDENCE";
export const FRONTEND_SPECIALIST_REASON = "FRONTEND_SUBSTANTIAL_INTERFACE_WORK";
export const OUTPUT_LIMIT_CONTINUATION_REASON = "RESPONSIBILITY_OUTPUT_LIMIT_CONTINUATION";

const PLANNER_PATTERNS = [
  /独立(?:判断|规划|分析|决定|决策)/iu,
  /比较(?:一下)?(?:方案|路线|架构)/iu,
  /架构选型/iu,
  /先(?:判断|规划)(?:路线|方案)/iu,
  /second opinion (?:on|for) (?:the )?(?:plan|approach|architecture)/iu,
  /compare (?:the )?(?:approaches|options|architectures)/iu,
  /architecture decision/iu,
  /(?:independently decide|independent decision)/iu,
];

const PLANNER_META_PATTERNS = [
  /(?:你|是否|有没有|有没).{0,12}(?:规划|计划)(?:了|过|吗|没有)/iu,
  /(?:did you|have you).{0,24}\bplan(?:ned|ning)?\b/iu,
];

const REVIEWER_PATTERNS = [
  /独立(?:审查|复核|评审)/iu,
  /(?:代码|安全|变更)(?:审查|复核|评审)/iu,
  /code review/iu,
  /security review/iu,
  /independent review/iu,
  /challenge (?:the )?(?:plan|implementation|result)/iu,
];

const RISK_PATTERNS = [
  /(?:高风险|安全|权限|删除|迁移|发布|生产环境)/iu,
  /(?:支付|付款|结算|扣款|退款|订单)[^。！？\n]{0,60}(?:提供方|服务|接口|请求|结果|状态|超时|重试|金额|交易|配置|回调|不稳定)/iu,
  /(?:high[- ]risk|security|permission|delete|migration|production)/iu,
  /(?:checkout|payment|billing|charge|refund)[^.!?\n]{0,80}(?:provider|service|request|result|status|timeout|retry|transaction|configuration|unstable|fail|超时|重试|不稳定)/iu,
];

const UNVERIFIED_CAUSAL_PATTERNS = [
  /(?:我看|看起来|看来|估计|大概|八成|明显|肯定)(?:就)?是/iu,
  /(?:问题|原因|根因)(?:应该|可能|大概|估计)(?:就)?在/iu,
  /\b(?:it\s+)?(?:looks?|seems)\s+like\b/iu,
  /\b(?:i think|probably|apparently|clearly|obviously)\b[^.!?\n]{0,80}\b(?:is|are|because|caused by|comes from)\b/iu,
];

const CONCRETE_CHANGE_PATTERNS = [
  /把[^。！？\n]{1,120}(?:降到|提到|提高到|改成|设为|设置为|切到|换成|开启|关闭|删除|清空|迁移到|发布到|上线)/iu,
  /(?:降低|提高|增加|减少|修改|设置|开启|关闭|删除|清空|迁移|发布|上线)[^。！？\n]{0,80}(?:\d|配置|超时|重试|权限|数据|服务)/iu,
  /\b(?:set|change|reduce|lower|increase|raise|disable|enable|delete|drop|clear|migrate|deploy|release)\b[^.!?\n]{0,100}\b(?:to|from|timeout|retries|permission|data|service|production)\b/iu,
];

const SPECIFIC_PARAMETER_PATTERNS = [
  /\d+(?:\.\d+)?\s*(?:毫秒|秒|分钟|小时|次|%|％|ms|sec(?:ond)?s?|min(?:ute)?s?|hours?|retries?|mb|gb)/iu,
];

const URGENCY_PATTERNS = [
  /(?:先止血|立即|马上|赶紧|紧急|热修)/iu,
  /\b(?:hotfix|immediately|right away|stop the bleeding)\b/iu,
];

const IRREVERSIBLE_ACTION_PATTERNS = [
  /(?:删除|清空|迁移|发布|上线|关闭)/iu,
  /\b(?:delete|drop|clear|migrate|deploy|release|disable)\b/iu,
];

const CONTINUATION_PATTERNS = [
  /(?:继续|接着|进一步|深入|再(?:判断|分析|评估|检查|处理)|按(?:照)?(?:刚才|上面|上述|前面|这个|该)|那就|就按|能做不|能不能做|可以做不|可以做吗)/iu,
  /\b(?:continue|proceed|go ahead|follow up|dig deeper|based on (?:that|the previous|the above)|can you (?:do|handle|implement) (?:it|that))\b/iu,
];

const PURE_RESPONSIBILITY_CONTINUATION_PATTERNS = [
  /^\s*(?:请)?(?:继续|接着|接下去|续上|恢复)(?:(?:执行|完成|处理|做|推进|设计|分析|规划))?(?:(?:刚才|之前|上次|这个|该|原来)的?)?(?:任务|工作|实现|方案|设计|分析|规划)?(?:下去|完成|吧)?[。！!]?\s*$/iu,
  /^\s*(?:please\s+)?(?:continue|go on|resume|carry on|keep going)(?:\s+(?:the\s+)?(?:previous|interrupted|same)?\s*(?:task|work|implementation|plan|design|analysis))?[.!]?\s*$/iu,
];
const OUTPUT_LIMIT_DIAGNOSTIC_PATTERNS = [
  /(?:截断|断掉|中断|输出[^。！？\n]{0,12}(?:上限|预算)|(?:上限|预算)[^。！？\n]{0,12}输出|max\s*[_-]?\s*tokens?)/iu,
  /(?:token|令牌)[^。！？\n]{0,16}(?:limit|budget|上限|预算|截断)/iu,
  /(?:为什么|为何|怎么)[^。！？\n]{0,20}(?:停|断|中断|没继续|不继续)/iu,
];

const LOW_RISK_TRANSFORM_PATTERNS = [
  /(?:重述|总结|概括|压缩|翻译|改写|润色|格式化|解释(?:一下)?)/iu,
  /\b(?:restate|summari[sz]e|translate|shorten|rewrite|format|explain)\b/iu,
];

const EXECUTION_REVISION_PATTERNS = [
  /(?:但(?:是)?|不过|然而|改(?:成|为)|换(?:成|为)|不要|别|去掉|删除|新增|加上|追加|同时|还(?:要|必须|需)|也(?:要|必须|需)|范围)/iu,
  /\b(?:but|however|instead|switch|replace|remove|drop|add|also|scope)\b|\bchange\s+(?:the|this|that|its|to|from)\b/iu,
];
const NON_IMPLEMENTATION_QUERY_PATTERNS = [
  /(?:有什么|有何|哪些|是什么|为何|为什么|怎么样|怎么看|发生了什么|有变化吗|影响(?:是|有)?什么)[^。！？\n]*[？?]?$/iu,
  /^\s*(?:what|why|how)\b[^.!?\n]*[?]\s*$/iu,
  /\b(?:what changed|what changes|what impact|which changes|difference between)\b[^.!?\n]*[?]?$/iu,
];
const NEW_TASK_PATTERNS = [
  /(?:另一个|另一项|另一件|另外(?:一个|一项|一件)|新(?:的)?(?:问题|任务|需求|工作))/iu,
  /\b(?:another|(?:a )?new|different|separate)\s+(?:task|issue|problem|request|change|project)\b/iu,
];
const REVIEWER_PENDING_CONTEXT_PATTERNS = [
  /(?:验收条件|证据包|前述|上述|刚才|之前|原任务)/iu,
  /(?:补充|更新|新增|修改|还有|同时)[^。！？\n]{0,28}(?:验收|审查|复核|证据|测试|差异|改动)/iu,
  /\b(?:A\d+|acceptance criteria|evidence packet|previous|above|same task)\b/iu,
  /\b(?:add|update|clarify|also|additionally)\b[^.!?\n]{0,36}\b(?:acceptance|review|evidence|tests?|diff|patch)\b/iu,
];

const FRONTEND_SCOPE_PATTERNS = [
  /(?:前端|界面|页面|网页|网站|着陆页|应用界面|仪表盘|控制台|组件|交互界面|移动端|桌面端|游戏界面|3D场景)/iu,
  /\b(?:front[- ]?end|ui|ux|interface|web(?:site| app)?|landing page|page|dashboard|component|mobile|desktop|game ui|3d scene)\b/iu,
];
const FRONTEND_DELIVERY_PATTERNS = [
  /(?:设计|制作|实现|开发|构建|创建|搭建|改版|重做|重构|优化|美化|修复)/iu,
  /\b(?:design|build|implement|develop|create|craft|redesign|revamp|rework|optimi[sz]e|fix)\b/iu,
];
const FRONTEND_STRONG_WORK_PATTERNS = [
  /(?:从零|新建|新做|整页|整站|整体改版|完整界面|设计并实现|重新设计|重做|改版|搭建)/iu,
  /\b(?:build|create|design and implement|redesign|revamp|rebuild)\b[^.!?\n]{0,60}\b(?:ui|interface|page|website|web app|dashboard|component|game)\b/iu,
];
const FRONTEND_SURFACE_PATTERNS = [
  /登录(?:页|页面)/iu,
  /(?:登录后)?首页/iu,
  /(?:个人空间|个人中心|用户中心|个人主页)/iu,
  /(?:注册|设置|搜索|列表|详情|结算|支付)(?:页|页面)/iu,
  /\b(?:login page|home page|profile|personal space|settings page|search page|list page|detail page|checkout page)\b/iu,
];
const FRONTEND_NON_UI_PATTERNS = [
  /(?:API|接口)(?:调用|请求|响应|超时|缓存|鉴权|数据|字段|契约)/iu,
  /\b(?:api|endpoint|backend|server-side)\b/iu,
];
const FRONTEND_UI_PRODUCTION_PATTERNS = [
  /(?:UI|UX|用户界面|界面介绍|布局|样式|排版|配色|交互|视觉|响应式|移动端|桌面端|截图|浏览器验收)/iu,
  /\b(?:ui|ux|interface|layout|styling|typography|interaction|visual|responsive|mobile|desktop|screenshot|browser acceptance)\b/iu,
];
const FRONTEND_EXPLICIT_SPECIALIST_PATTERNS = [
  /(?:交给|使用|用)[^。！？\n]{0,30}(?:前端|UI|UX)(?:专长|专家|模型)/iu,
  /\b(?:use|with|via)\b[^.!?\n]{0,30}\b(?:front[- ]?end|ui|ux) (?:specialist|expert|model)\b/iu,
];
const FRONTEND_AXIS_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
  responsive: [/(?:响应式|移动端|桌面端|多端|窄屏|宽屏|视口)/iu, /\b(?:responsive|mobile|desktop|viewport|breakpoint)\b/iu],
  interaction: [/(?:交互|动效|动画|拖拽|手势|状态流转|多状态)/iu, /\b(?:interaction|animation|motion|drag|gesture|state flow|multiple states)\b/iu],
  visual: [/(?:视觉|品牌|排版|配色|设计系统|素材|图片|图标|3D|游戏界面)/iu, /\b(?:visual|brand|typography|palette|design system|asset|image|icon|3d|game ui)\b/iu],
  comprehension: [/(?:一眼(?:就)?(?:看懂|明白|理解)|做什么|首屏认知|价值表达|信息架构|界面介绍)/iu, /\b(?:understand at a glance|first-screen comprehension|value proposition|information architecture|what (?:it|the product) does)\b/iu],
  acceptance: [/(?:截图|浏览器验收|视觉验收|无障碍|Playwright|真机)/iu, /\b(?:screenshot|browser acceptance|visual acceptance|accessibility|playwright|device testing)\b/iu],
});

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function stripQuotedMaterial(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》|"[^"\n]*"/gu, " ");
}

export function classifyResponsibilityInterruptionText(text: unknown): "continue" | "preserve" | "clear" {
  const explicit = stripQuotedMaterial(String(text ?? "")).trim();
  if (!explicit) return "clear";
  if (matchesAny(explicit, PURE_RESPONSIBILITY_CONTINUATION_PATTERNS)) return "continue";
  if (matchesAny(explicit, OUTPUT_LIMIT_DIAGNOSTIC_PATTERNS)) return "preserve";
  return "clear";
}

export function classifyPendingReviewerText(text: unknown): "continue" | "supersede" | "dormant" {
  const explicit = stripQuotedMaterial(String(text ?? "")).trim();
  if (!explicit) return "dormant";
  if (matchesAny(explicit, NEW_TASK_PATTERNS)) return "supersede";
  if (matchesAny(explicit, PURE_RESPONSIBILITY_CONTINUATION_PATTERNS)
    || matchesAny(explicit, CONTINUATION_PATTERNS)
    || matchesAny(explicit, REVIEWER_PENDING_CONTEXT_PATTERNS)) return "continue";
  return "dormant";
}

export function hasExplicitRequestRevision(text: unknown): boolean {
  const explicit = stripQuotedMaterial(String(text ?? "")).trim();
  return explicit.length > 0 && matchesAny(explicit, EXECUTION_REVISION_PATTERNS);
}

function hasHighImpactEvidenceGap(text: string): boolean {
  text = stripQuotedMaterial(text);
  if (isLowRiskTransform(text) || matchesAny(text, NON_IMPLEMENTATION_QUERY_PATTERNS)) return false;
  return matchesAny(text, RISK_PATTERNS)
    && matchesAny(text, UNVERIFIED_CAUSAL_PATTERNS)
    && matchesAny(text, CONCRETE_CHANGE_PATTERNS)
    && (matchesAny(text, SPECIFIC_PARAMETER_PATTERNS)
      || matchesAny(text, URGENCY_PATTERNS)
      || matchesAny(text, IRREVERSIBLE_ACTION_PATTERNS));
}

function isLowRiskTransform(text: string): boolean {
  return matchesAny(stripQuotedMaterial(text), LOW_RISK_TRANSFORM_PATTERNS);
}

function frontendSpecializationSignals(text: string): Readonly<FrontendSpecializationSignals> {
  const explicit = matchesAny(text, FRONTEND_EXPLICIT_SPECIALIST_PATTERNS);
  const surfaceCount = FRONTEND_SURFACE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const explicitScope = matchesAny(text, FRONTEND_SCOPE_PATTERNS);
  const scope = surfaceCount > 0 || explicitScope;
  const delivery = matchesAny(text, FRONTEND_DELIVERY_PATTERNS);
  const strongWork = matchesAny(text, FRONTEND_STRONG_WORK_PATTERNS);
  const axes = Object.entries(FRONTEND_AXIS_PATTERNS)
    .filter(([, patterns]) => matchesAny(text, patterns))
    .map(([axis]) => axis);
  const nonUiRequest = matchesAny(text, FRONTEND_NON_UI_PATTERNS)
    && !matchesAny(text, FRONTEND_UI_PRODUCTION_PATTERNS);
  const specialistDepth = explicit
    || strongWork
    || axes.length >= 2
    || (surfaceCount >= 2 && (explicitScope || axes.length >= 1));
  return Object.freeze({
    explicit,
    scope,
    delivery,
    strongWork,
    nonUiRequest,
    specialistDepth,
    surfaceCount,
    axes: Object.freeze(axes),
    substantial: scope && delivery && specialistDepth && !nonUiRequest,
  });
}

function frontendRouteSignals(frontend: FrontendSpecializationSignals): string[] {
  return [
    ...(frontend.scope ? ["frontend-interface-scope"] : []),
    ...(frontend.delivery ? ["frontend-delivery-request"] : []),
    ...(frontend.explicit ? ["explicit-frontend-specialist"] : []),
    ...(frontend.strongWork ? ["substantial-frontend-work"] : []),
    ...(frontend.surfaceCount >= 2 ? ["frontend-multi-surface"] : []),
    ...frontend.axes.map((axis) => `frontend-${axis}`),
  ];
}

function genuineUserText(message: DshMessage | RuntimeEventData | undefined): string {
  const source = message?.source;
  if (message?.role !== "user" || !isUnknownRecord(source) || source.kind !== "user" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function genuineUserTexts(
  messages: readonly DshMessage[] | undefined,
  sessionEvents: readonly DshEvent[] = [],
): string[] {
  const candidates: (DshMessage | RuntimeEventData)[] = [
    ...(Array.isArray(messages) ? [...messages].reverse() : []),
    ...(Array.isArray(sessionEvents)
      ? [...sessionEvents].reverse()
        .filter((event) => event?.type === "user/message")
        .map((event) => event.data)
      : []),
  ];
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const message of candidates) {
    const text = genuineUserText(message);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
}

function route(
  role: OdaiRouteRole,
  reasonCode: string,
  reason: string,
  signals: readonly string[],
  action: OdaiRouteAction = role === "controller" ? "direct" : "delegate",
  targetRole?: OdaiRouteRole,
): Readonly<RouteDecision> {
  return Object.freeze({
    role,
    mode: action,
    action,
    ...(targetRole === undefined ? {} : { targetRole }),
    reasonCode,
    reason,
    signals: Object.freeze([...new Set(signals)]),
  });
}

export function decideResearchPrefetch(input: RouteDecisionInput = {}): Readonly<RouteDecision> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const explicitIntentText = stripQuotedMaterial(text);
  const proposal = input.proposal?.responsibility === "researcher" ? input.proposal : undefined;
  if (!proposal || !explicitIntentText || isLowRiskTransform(explicitIntentText)) {
    return route("controller", "RESEARCHER_PREFETCH_NOT_NEEDED", "No evidence-grounded research gap was proposed.", ["no-research-prefetch"]);
  }
  return route(
    "researcher",
    RESEARCHER_EVIDENCE_REASON,
    proposal.gap,
    ["evidence-grounded-responsibility-gap", `state:${proposal.stateDigest}`],
  );
}

/**
 * Choose the smallest useful odai role. Risk alone never creates another role,
 * and implementation remains with the controller.
 */
export function decideRoute(input: RouteDecisionInput = {}): Readonly<RouteDecision> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const explicitIntentText = stripQuotedMaterial(text);
  const proposal = input.proposal;
  const signals: string[] = [];
  const considerations: RouteConsideration[] = [];
  const riskPresent = matchesAny(explicitIntentText, RISK_PATTERNS);
  const unverifiedCausalClaim = matchesAny(explicitIntentText, UNVERIFIED_CAUSAL_PATTERNS);
  const concreteChangeRequest = matchesAny(explicitIntentText, CONCRETE_CHANGE_PATTERNS);
  const specificOperationalParameter = matchesAny(explicitIntentText, SPECIFIC_PARAMETER_PATTERNS);
  const urgencyPressure = matchesAny(explicitIntentText, URGENCY_PATTERNS);
  const irreversibleAction = matchesAny(explicitIntentText, IRREVERSIBLE_ACTION_PATTERNS);
  const frontend = frontendSpecializationSignals(explicitIntentText);

  if (riskPresent) signals.push("risk-present");
  if (unverifiedCausalClaim) signals.push("unverified-causal-claim");
  if (concreteChangeRequest) signals.push("concrete-change-request");
  if (specificOperationalParameter) signals.push("specific-operational-parameter");
  if (urgencyPressure) signals.push("urgency-pressure");
  if (irreversibleAction) signals.push("irreversible-action");

  const interruption = input.interruption;
  if (isContinuationRole(interruption?.responsibility)
    && classifyResponsibilityInterruptionText(interruption?.continuationText) === "continue") {
    return route(
      "controller",
      OUTPUT_LIMIT_CONTINUATION_REASON,
      `The verified ${interruption.responsibility} responsibility was interrupted by the provider output limit and the user explicitly continued it.`,
      ["verified-output-limit-interruption", "explicit-continuation"],
      "upgrade",
      interruption.responsibility,
    );
  }

  if (proposal?.responsibility === "user") {
    signals.push("user-decision-gap", `state:${proposal.stateDigest}`);
    return route(
      "controller",
      "USER_DECISION_REQUIRED",
      proposal.gap,
      signals,
    );
  }
  if (proposal?.responsibility === "reviewer") {
    signals.push("evidence-grounded-responsibility-gap", `state:${proposal.stateDigest}`);
    return route("reviewer", "REVIEWER_EVIDENCE_STATE_GAP", proposal.gap, signals);
  }
  if (proposal?.responsibility === "planner") {
    signals.push("evidence-grounded-responsibility-gap", `state:${proposal.stateDigest}`);
    return route("controller", "PLANNER_EVIDENCE_STATE_GAP", proposal.gap, signals, "upgrade", "planner");
  }
  if (proposal?.responsibility === "frontend") {
    signals.push("evidence-grounded-responsibility-gap", `state:${proposal.stateDigest}`);
    return route("controller", "FRONTEND_EVIDENCE_STATE_GAP", proposal.gap, signals, "upgrade", "frontend");
  }

  if (matchesAny(explicitIntentText, REVIEWER_PATTERNS)) {
    signals.push("review-language-present");
    considerations.push(Object.freeze({
      role: "reviewer",
      match: "lexical",
      action: "skip",
      reasonCode: "REVIEWER_GAP_NOT_PROVEN",
      signals: Object.freeze(["review-language-present"]),
      unmet: Object.freeze(["current-evidence-package", "acceptance-impact"]),
    }));
  }

  if (matchesAny(explicitIntentText, PLANNER_PATTERNS)) {
    signals.push("planning-language-present");
    considerations.push(Object.freeze({
      role: "planner",
      match: "lexical",
      action: "skip",
      reasonCode: "PLANNER_GAP_NOT_PROVEN",
      signals: Object.freeze(["planning-language-present"]),
      unmet: Object.freeze(["evidence-grounded-decision-branch", "observable-capability-benefit"]),
    }));
  } else if (matchesAny(explicitIntentText, PLANNER_META_PATTERNS)) {
    signals.push("planner-meta-question");
    considerations.push(Object.freeze({
      role: "planner",
      match: "meta-question",
      action: "skip",
      reasonCode: "PLANNER_META_QUERY_NO_INDEPENDENT_GAP",
      signals: Object.freeze(["planner-meta-question"]),
      unmet: Object.freeze(["prior-task-state-with-unresolved-decision-branch"]),
    }));
  }

  const highImpactEvidenceGap = riskPresent
    && unverifiedCausalClaim
    && concreteChangeRequest
    && (specificOperationalParameter || urgencyPressure || irreversibleAction);
  if (highImpactEvidenceGap && !isLowRiskTransform(explicitIntentText)
    && !matchesAny(explicitIntentText, NON_IMPLEMENTATION_QUERY_PATTERNS)) {
    return route(
      "controller",
      "HIGH_IMPACT_EVIDENCE_REQUIRED",
      "The requested high-impact change relies on an unverified causal claim. Verify the evidence and authorization; risk alone does not establish an independent capability gap.",
      signals,
    );
  }

  const frontendSignals = frontend.scope || frontend.explicit ? frontendRouteSignals(frontend) : [];
  signals.push(...frontendSignals, "no-independent-gap");
  const direct = route(
    "controller",
    "DIRECT_DEFAULT_NO_INDEPENDENT_GAP",
    "No evidence-grounded independent decision, execution, or acceptance gap was found.",
    signals,
  );
  if (frontendSignals.length > 0) {
    const lowRiskTransform = isLowRiskTransform(explicitIntentText);
    considerations.push(Object.freeze({
      role: "frontend",
      match: "partial",
      action: "skip",
      reasonCode: frontend.nonUiRequest
        ? "FRONTEND_API_REQUEST"
        : lowRiskTransform
          ? "FRONTEND_LOW_RISK_TRANSFORM"
          : frontend.substantial ? "FRONTEND_GAP_NOT_PROVEN" : "FRONTEND_BELOW_SPECIALIST_THRESHOLD",
      signals: Object.freeze(frontendSignals),
      unmet: Object.freeze(frontend.nonUiRequest
        ? ["ui-production-request"]
        : [
            ...(frontend.scope ? [] : ["interface-scope"]),
            ...(frontend.delivery ? [] : ["delivery-request"]),
            ...(frontend.specialistDepth ? [] : ["specialist-or-substantial-scope"]),
            "evidence-grounded-capability-gap",
          ]),
    }));
  }
  return considerations.length === 0
    ? direct
    : Object.freeze({ ...direct, considerations: Object.freeze(considerations) });
}

export function extractLatestUserText(messages: readonly DshMessage[] | undefined): string {
  return genuineUserTexts(messages)[0] ?? "";
}

export function extractRoutingText(
  messages: readonly DshMessage[] | undefined,
  sessionEvents: readonly DshEvent[] | undefined,
): string {
  const texts = genuineUserTexts(messages, sessionEvents);
  const latest = texts[0] ?? "";
  if (!latest
    || hasHighImpactEvidenceGap(latest)
    || !matchesAny(stripQuotedMaterial(latest), CONTINUATION_PATTERNS)
    || isLowRiskTransform(latest)) {
    return latest;
  }

  let referencedHighImpact;
  let referencedFrontend;
  for (const text of texts.slice(1)) {
    if (hasHighImpactEvidenceGap(text)) {
      referencedHighImpact = text;
      break;
    }
    const frontend = frontendSpecializationSignals(stripQuotedMaterial(text));
    if (frontend.scope && frontend.delivery) {
      referencedFrontend = text;
      break;
    }
    if (!isLowRiskTransform(text)) break;
  }
  if (referencedHighImpact) {
    return `${latest}\n\nReferenced earlier high-impact user context:\n${referencedHighImpact}`;
  }
  if (referencedFrontend) {
    return `${latest}\n\nReferenced earlier frontend user context:\n${referencedFrontend}`;
  }
  return latest;
}

function observeProtocol(_decision: RouteDecision): string[] {
  return [
    "Observe-mode controller protocol:",
    "- No independent role was run. Do not claim independent planning or review.",
    "- Continue authorized work with available evidence and capabilities. Local reasoning cannot satisfy explicitly required independence.",
    "- Report missing independence as incomplete; hold only actions that depend on unresolved evidence, authorization, or necessary high-impact protections.",
    "- Routing availability does not alter user authorization, host plan mode, or execution permissions.",
  ];
}

export function renderRouteNotice(
  decision: RouteDecision,
  runtimeMode: string,
  actualRoute?: ModelRoute,
  dispatch?: "same-turn" | "child",
): string {
  const routeRole = decision.targetRole ?? decision.role;
  const isUpgrade = dispatch
    ? dispatch === "same-turn"
    : decision.action === "upgrade"
      && (runtimeMode === "auto" || ["frontend"].includes(routeRole));
  const action = isUpgrade
    ? "The current controller turn requested an in-place upgrade; no child was started."
    : runtimeMode === "observe"
      ? `The ${routeRole} gap was selected in observe mode; do not start a child automatically.`
      : `The ${routeRole} route was selected and executed as an independent child.`;
  const routeIdentity = actualRoute
    ? [`${isUpgrade ? "requested controller route" : "verified child route"}: ${actualRoute.provider}/${actualRoute.model} (reasoning: ${actualRoute.reasoningEffort ?? "unspecified"}, maxTokens: ${actualRoute.maxTokens ?? (isUpgrade ? "inherited from Controller policy" : "provider default")})`]
    : [];

  return [
    "odai automatic routing decision",
    `role: ${decision.role}`,
    `action: ${isUpgrade ? "upgrade" : decision.action}`,
    ...(decision.targetRole ? [`target responsibility: ${decision.targetRole}`] : []),
    `reason: ${decision.reasonCode}`,
    `runtime: ${runtimeMode}`,
    action,
    ...routeIdentity,
    ...(runtimeMode === "observe" ? ["", ...observeProtocol(decision)] : []),
  ].join("\n");
}

export function renderMissingRouteConfigNotice(
  decision: RouteDecision,
  runtimeMode: string,
  configFailure?: string,
): string {
  const routeRole = decision.targetRole ?? decision.role;
  const invalidConfig = typeof configFailure === "string" && configFailure !== "";
  return [
    `odai routing capability is ${invalidConfig ? "invalid" : "not configured"}`,
    `required responsibility: ${routeRole}`,
    `runtime: ${runtimeMode}`,
    ...(invalidConfig ? [`configuration error: ${configFailure}`] : []),
    `No ${routeRole} model was called. Do not claim that this responsibility ran or that the controller was upgraded.`,
    "Continue authorized work with available capabilities. Report explicitly required independence as incomplete, and hold only outcomes that depend on it.",
    "Do not require model configuration as a universal prerequisite for continuing the task. Change routing only when the user requests it and supplies the required values.",
    "Routing availability does not alter user authorization, host plan mode, execution permissions, or necessary high-impact evidence and protections.",
  ].join("\n");
}

export function renderRouteFailureNotice(decision: RouteDecision, failure: unknown): string {
  const routeRole = decision.targetRole ?? decision.role;
  return [
    `odai ${routeRole} route failed (${failure}); no verified delegated result was obtained.`,
    "Continue authorized work as controller with available capabilities. Do not claim the configured responsibility ran successfully.",
    "Report explicitly required independence as incomplete. Hold only actions that depend on unresolved evidence, authorization, or necessary high-impact protections.",
    "Routing failure does not impose a whole-turn read-only restriction and does not waive host plan mode or execution permissions.",
  ].join("\n");
}

export function renderDelegationPrompt(
  decision: Pick<RouteDecision, "role">,
  taskText: string,
  roleContract: unknown,
): string {
  if (typeof roleContract !== "string" || roleContract.trim() === "") {
    throw new TypeError(`canonical ${decision.role} role contract must be a non-empty string`);
  }

  return [
    `You are the odai ${decision.role}.`,
    roleContract.trim(),
    "Runtime boundary: do not edit files, run shell commands, ask the user, or delegate further. The controller owns all final decisions and delivery.",
    "Context boundary: this is a bounded task and evidence packet, not an inherited controller transcript. Use only the supplied contract, task, evidence, and source pointers; do not request or reconstruct the controller's full history.",
    "",
    "Task:",
    taskText,
  ].join("\n");
}
