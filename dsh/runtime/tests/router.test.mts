import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTPUT_LIMIT_CONTINUATION_REASON,
  classifyImplementationAuthorization,
  classifyPendingReviewerText,
  classifyResponsibilityInterruptionText,
  decideResearchPrefetch,
  decideRoute,
  extractLatestUserText,
  extractRoutingText,
  isExecutionContinuation,
  renderDelegationPrompt,
  renderMissingRouteConfigNotice,
  renderRouteFailureNotice,
  renderRouteNotice,
  requiresFailClosedProtection,
} from "../build/router.mjs";
import type { Responsibility, ResponsibilityGapProposal } from "../build/responsibility-gap.mjs";
import type { DshEvent, DshMessage } from "../build/runtime-types.mjs";

function gap(
  responsibility: Responsibility,
  overrides: Partial<ResponsibilityGapProposal> = {},
): ResponsibilityGapProposal {
  return {
    responsibility,
    gap: `${responsibility} can change the current result.`,
    evidenceRefs: ["current-task", "project-evidence"],
    expectedChange: "Resolve the affected decision or artifact.",
    stateDigest: "a".repeat(64),
    ...overrides,
  };
}

test("implementation authorization distinguishes delivery, plan-only, and unknown requests", () => {
  assert.equal(classifyImplementationAuthorization("把这个修复完成并跑测试").status, "authorized");
  assert.equal(classifyImplementationAuthorization("把按钮文案改清楚并运行现有测试").status, "authorized");
  assert.equal(classifyImplementationAuthorization("把这些问题一起校验并处理了").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Please implement and verify the fix").status, "authorized");
  assert.equal(classifyImplementationAuthorization("只做规划，不要改文件").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("只做代码审查，不要改文件").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Review only; do not implement or make changes").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Review the code, then implement the required fixes").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Review the code and implement the necessary fix").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Review the code and update me on the findings").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Review the code and update the team on the findings").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Review the code and update stakeholders on the findings").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Review the code and update management about the findings").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Review the existing fix and update stakeholders on the findings").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Can you update customers on the findings?").status, "unknown");
  assert.equal(classifyImplementationAuthorization("Review the code, implement the fix, and update stakeholders on the findings").status, "authorized");
  assert.equal(classifyImplementationAuthorization("审查代码并更新一下进展").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Review only the failing test, then implement the fix").status, "authorized");
  assert.equal(classifyImplementationAuthorization("只审查失败的测试，然后修复问题").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Do not modify the existing tests; implement the production fix").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Do not modify the lockfile; update the package manifest").status, "authorized");
  assert.equal(classifyImplementationAuthorization("不要修改测试，只修复生产代码").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Do not modify tests; do not implement the fix").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Do not modify tests; no need to implement the fix").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("不要修改测试，同时无需执行修复").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Do not modify anything; implement the fix").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("只帮我分析一下这次更新的影响").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("帮我分析一下这次更新的影响").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("just analyze the update impact").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Analyze the update impact").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("列一下需要修改的地方").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("给我一份需要新增的接口清单").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("Explain what the fix would look like").status, "plan-only");
  assert.equal(classifyImplementationAuthorization("列一下需要修改的地方，然后按清单修改代码").status, "authorized");
  assert.equal(classifyImplementationAuthorization("给我一份需要新增的接口清单，然后实现这些接口").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Explain what the fix would look like, then implement it").status, "authorized");
  assert.equal(classifyImplementationAuthorization("这次更新有什么变化？").status, "unknown");
  assert.equal(classifyImplementationAuthorization("What changed in this update?").status, "unknown");
  assert.equal(classifyImplementationAuthorization("Can you update me on the impact of this change?").status, "unknown");
  assert.equal(classifyImplementationAuthorization("帮我更新这个依赖").status, "authorized");
  assert.equal(classifyImplementationAuthorization("Please update the dependency").status, "authorized");
  assert.equal(classifyImplementationAuthorization("你做了吗？").status, "unknown");
  assert.equal(classifyImplementationAuthorization("你觉得这个方向怎么样").status, "unknown");
});

test("output-limit interruption text only resumes on a pure continuation", () => {
  for (const text of ["继续", "请继续完成刚才的任务", "resume the interrupted work", "keep going"]) {
    assert.equal(classifyResponsibilityInterruptionText(text), "continue", text);
  }
  for (const text of ["又被截断，到底是什么问题？", "怎么断掉之后就不继续设计了？", "token limit 还是 500 吗？"]) {
    assert.equal(classifyResponsibilityInterruptionText(text), "preserve", text);
  }
  for (const text of ["继续修复登录页", "顺便改一下 API", "开始另一个任务"]) {
    assert.equal(classifyResponsibilityInterruptionText(text), "clear", text);
  }
});

test("pending reviewer text distinguishes continuation, supersession, and dormancy", () => {
  for (const text of ["继续", "继续；A1 还必须覆盖回滚", "补充验收证据：目标测试已经通过", "continue with the previous review; add rollback acceptance"]) {
    assert.equal(classifyPendingReviewerText(text), "continue", text);
  }
  for (const text of ["开始另一个任务", "改做一个无关的新问题", "start a separate task", "review another project"]) {
    assert.equal(classifyPendingReviewerText(text), "supersede", text);
  }
  for (const text of ["现在几点？", "解释一下这个术语", "为 API 添加测试", "审查 API", "把『开始另一个任务』改短"]) {
    assert.equal(classifyPendingReviewerText(text), "dormant", text);
  }
});

test("execution continuation rejects target or scope revisions", () => {
  for (const text of ["继续", "按上述计划执行", "continue with the previous plan", "go ahead with it", "go ahead with that change"]) {
    assert.equal(isExecutionContinuation(text), true, text);
  }
  for (const text of [
    "继续这个计划，但改成只处理文档",
    "按上述计划执行，同时加上发布",
    "continue with the plan, but change the scope",
    "continue with the plan; change the target to documentation",
    "go ahead with it and also remove the compatibility layer",
  ]) {
    assert.equal(isExecutionContinuation(text), false, text);
  }
});

test("verified output-limit interruptions restore each in-place responsibility", () => {
  for (const responsibility of ["planner", "frontend"]) {
    const decision = decideRoute({
      text: "继续\n\nReferenced earlier task context that is not itself a pure continuation.",
      interruption: { responsibility, continuationText: "继续" },
    });
    assert.equal(decision.role, "controller", responsibility);
    assert.equal(decision.action, "upgrade", responsibility);
    assert.equal(decision.targetRole, responsibility, responsibility);
    assert.equal(decision.reasonCode, OUTPUT_LIMIT_CONTINUATION_REASON, responsibility);
    assert.deepEqual(decision.signals, ["verified-output-limit-interruption", "explicit-continuation"], responsibility);
  }
});

test("direct is the default even when risk is present", () => {
  const decision = decideRoute({ text: "这是一次高风险生产迁移，请帮我实现" });
  assert.equal(decision.role, "controller");
  assert.equal(decision.reasonCode, "DIRECT_DEFAULT_NO_INDEPENDENT_GAP");
  assert.deepEqual(decision.signals, ["risk-present", "irreversible-action", "no-independent-gap"]);
});

test("early emotional support signals never switch responsibility or model routes", () => {
  for (const text of [
    "我现在很焦虑，一直怀疑自己是不是做错了。",
    "我反复想这件事，越想越内耗，完全提不起劲。",
    "最近总是很消极，也很怕犯错，你先听我说说。",
    "I feel anxious, keep doubting myself, and cannot stop ruminating.",
  ]) {
    const decision = decideRoute({ text });
    assert.equal(decision.role, "controller", text);
    assert.equal(decision.action, "direct", text);
    assert.equal(decideResearchPrefetch({ text }).action, "direct", text);
  }
});

test("research prefetch requires an evidence-grounded source gap and stays independent from the primary route", () => {
  const causal = "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。";
  assert.equal(decideResearchPrefetch({ text: causal }).action, "direct");
  const proposal = gap("researcher", { gap: "Two repository sources are required to test the causal claim." });
  const decision = decideResearchPrefetch({ text: causal, proposal });
  assert.equal(decision.role, "researcher");
  assert.equal(decision.action, "delegate");
  assert.equal(decision.reasonCode, "RESEARCHER_MULTI_SOURCE_DECISION_EVIDENCE");
  assert.deepEqual(decision.signals, [
    "evidence-grounded-responsibility-gap",
    `state:${proposal.stateDigest}`,
  ]);
  assert.equal(decideRoute({ text: causal }).targetRole, "planner");

  for (const text of [
    "README 的安装命令是什么？",
    "结合这三份材料，设计设置页保存体验。",
    "这是一次高风险生产迁移，请帮我实现",
    "把『先调查多个供应商』改成更短的按钮文案",
    "先调查跨供应商的多个权威来源，只建立事实基线",
  ]) {
    assert.equal(decideResearchPrefetch({ text }).action, "direct", text);
  }
});

test("planning language is only a candidate until task state proves a planner gap", () => {
  const lexical = decideRoute({ text: "请独立规划一下这次架构选型，再给我建议" });
  assert.equal(lexical.action, "direct");
  assert.ok(lexical.considerations);
  assert.equal(lexical.considerations[0].reasonCode, "PLANNER_GAP_NOT_PROVEN");

  const decision = decideRoute({
    text: "比较当前兼容路线后完成修复",
    proposal: gap("planner", { gap: "Two public contract routes remain unresolved." }),
  });
  assert.equal(decision.role, "controller");
  assert.equal(decision.action, "upgrade");
  assert.equal(decision.targetRole, "planner");
  assert.equal(decision.reasonCode, "PLANNER_EVIDENCE_STATE_GAP");
});

test("cross-contract planner branches require an evidence-grounded proposal", () => {
  const branches = [
    "Frontend and backend deploy independently, and rollout order changes which compatibility shim is required.",
    "The authentication state machine has two externally observable transition contracts with different rollback behavior.",
    "The rollback boundary differs depending on whether old and new API clients coexist during release.",
  ];
  for (const text of branches) {
    const direct = decideRoute({ text });
    assert.equal(direct.action, "direct", text);
    const planned = decideRoute({
      text,
      proposal: gap("planner", {
        gap: "Two independently valid contract branches change implementation order and acceptance.",
        evidenceRefs: ["deployment-contract", "rollback-contract"],
      }),
    });
    assert.equal(planned.action, "upgrade", text);
    assert.equal(planned.targetRole, "planner", text);
    assert.equal(planned.reasonCode, "PLANNER_EVIDENCE_STATE_GAP", text);
  }
  for (const text of [
    "This rollout is complicated but its compatibility contract and order are already frozen.",
    "Shorten the quoted example: ‘rollback order may require a planner’. ",
  ]) {
    assert.equal(decideRoute({ text }).action, "direct", text);
  }
});

test("planner meta questions trigger state explanation rather than becoming a role password", () => {
  const direct = decideRoute({ text: "你规划了吗？还是你觉得不用规划？" });
  assert.equal(direct.action, "direct");
  assert.ok(direct.considerations);
  assert.equal(direct.considerations[0].reasonCode, "PLANNER_META_QUERY_NO_INDEPENDENT_GAP");
  const routed = decideRoute({
    text: "你规划了吗？还是你觉得不用规划？",
    proposal: gap("planner", { gap: "The prior task still has two unresolved contract routes." }),
  });
  assert.equal(routed.targetRole, "planner");
  assert.equal(routed.reasonCode, "PLANNER_EVIDENCE_STATE_GAP");
});

test("quoted role language does not create an independent gap", () => {
  const cases = [
    "请把 README 中“请独立规划一下架构选型”这句话改短",
    "把 `architecture decision` 改成 decision",
    "将下面引用改短：\n> 请独立审查这个架构方案",
    "把代码块里的提示词改成小写：\n```text\nindependent review\n```",
  ];
  for (const text of cases) {
    assert.equal(decideRoute({ text }).role, "controller", text);
  }
});

test("review language is only a candidate while current acceptance evidence can route reviewer", () => {
  const lexical = decideRoute({ text: "请独立审查这个架构方案并 challenge the plan" });
  assert.equal(lexical.action, "direct");
  assert.ok(lexical.considerations);
  assert.equal(lexical.considerations[0].reasonCode, "REVIEWER_GAP_NOT_PROVEN");

  const decision = decideRoute({
    text: "实现和测试已经完成",
    proposal: gap("reviewer", { gap: "Independent acceptance can change A1." }),
  });
  assert.equal(decision.role, "reviewer");
  assert.equal(decision.reasonCode, "REVIEWER_EVIDENCE_STATE_GAP");
});

test("unverified causal claim plus concrete high-impact change upgrades the controller", () => {
  const decision = decideRoute({
    text: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
  });
  assert.equal(decision.role, "controller");
  assert.equal(decision.action, "upgrade");
  assert.equal(decision.targetRole, "planner");
  assert.equal(decision.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
  assert.deepEqual(decision.signals, [
    "risk-present",
    "unverified-causal-claim",
    "concrete-change-request",
    "specific-operational-parameter",
    "urgency-pressure",
  ]);
});

test("contextual planner gap works without C04-specific wording", () => {
  const decision = decideRoute({
    text: "It looks like the billing provider is unstable. Reduce the client timeout to 3 seconds and increase retries to 3 as a hotfix.",
  });
  assert.equal(decision.role, "controller");
  assert.equal(decision.action, "upgrade");
  assert.equal(decision.targetRole, "planner");
  assert.equal(decision.reasonCode, "PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE");
});

test("high-impact observe and route failure notices require a read-only decision path", () => {
  const decision = decideRoute({
    text: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
  });
  assert.equal(requiresFailClosedProtection(decision), true);

  const observe = renderRouteNotice(decision, "observe");
  assert.match(observe, /No independent role was run/u);
  assert.match(observe, /concrete evidence-gathering steps and explicit decision criteria/u);
  assert.match(observe, /do not implement, persist, or publish/u);
  assert.match(observe, /Use read-only evidence only/u);
  assert.match(observe, /unavailable environments, tools, owners, thresholds, and protections as missing conditions/u);

  const upgrade = renderRouteNotice(decision, "auto", {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  assert.match(upgrade, /action: upgrade/u);
  assert.match(upgrade, /no child was started/u);
  assert.match(upgrade, /requested controller route: openai\/gpt-5\.6-sol \(reasoning: high, maxTokens: inherited from Controller policy\)/u);

  const failure = renderRouteFailureNotice(decision, "provider unavailable");
  assert.match(failure, /High-impact fail-closed protection is active/u);
  assert.match(failure, /provider unavailable/u);
  assert.doesNotMatch(failure, /continue directly/u);

  const stateBackedHighImpact = decideRoute({
    text: "这是生产发布，审批已经完成，按方案上线。",
    proposal: gap("planner", { gap: "The release protection path is unresolved." }),
  });
  assert.equal(stateBackedHighImpact.reasonCode, "PLANNER_EVIDENCE_STATE_GAP");
  assert.equal(requiresFailClosedProtection(stateBackedHighImpact), true);
  assert.doesNotMatch(renderRouteFailureNotice(stateBackedHighImpact, "provider unavailable"), /continue directly/u);

  const lexicalOnly = decideRoute({ text: "请独立规划一下架构方案" });
  assert.equal(requiresFailClosedProtection(lexicalOnly), false);
  assert.match(renderRouteFailureNotice(lexicalOnly, "provider unavailable"), /continue directly/u);
});

test("every missing responsibility asks for a natural-language model choice", () => {
  for (const role of ["planner", "reviewer"] as const) {
    const notice = renderMissingRouteConfigNotice({
      role,
      mode: "delegate",
      action: "delegate",
      reasonCode: `${role.toUpperCase()}_TEST_GAP`,
      reason: "test responsibility mapping",
      signals: [],
    }, "auto");
    assert.match(notice, new RegExp(`required responsibility: ${role}`, "u"));
    assert.match(notice, /Ask them to name the provider, model, and optional reasoning effort in natural language/u);
    assert.match(notice, /call the odai_routing_config tool/u);
    assert.doesNotMatch(notice, /routing:\n/u);
    assert.match(notice, /Do not ask the user to edit YAML or JSON, run a command/u);
  }

  const protectedNotice = renderMissingRouteConfigNotice(decideRoute({
    text: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
  }), "auto");
  assert.match(protectedNotice, /High-impact fail-closed protection is active/u);

  for (const role of ["reviewer"] as const) {
    assert.match(renderMissingRouteConfigNotice({
      role,
      mode: "delegate",
      action: "delegate",
      reasonCode: `${role.toUpperCase()}_HIGH_IMPACT_GAP`,
      reason: "test high-impact gap",
      signals: ["risk-present", "irreversible-action"],
    }, "execute"), /High-impact fail-closed protection is active/u);
  }
});

test("contextual signals do not delegate unless the complete planner gap exists", () => {
  const cases = [
    "这是一次高风险生产迁移，审批和路线已经冻结，请按文档实现。",
    "我看就是支付方不稳定，先帮我查日志和提供方说明。",
    "我看就是按钮颜色太淡，把灰色改成黑色。",
    "我看就是支付按钮太小。把宽度改成 44px，马上修。",
    "提供方 SLO 已确认 8 秒超时，请把生产配置从 6 秒设为 8 秒。",
  ];
  for (const text of cases) {
    assert.equal(decideRoute({ text }).role, "controller", text);
  }
});

test("implementation continuation stays with the controller", () => {
  for (const text of ["请执行这个方案", "按上述计划", "继续执行这个方案", "implement the plan"]) {
    const decision = decideRoute({ text });
    assert.equal(decision.role, "controller", text);
    assert.equal(decision.targetRole, undefined, text);
    assert.equal(decision.reasonCode, "DIRECT_DEFAULT_NO_INDEPENDENT_GAP", text);
  }
  const planned = decideRoute({
    text: "开始处理另一个问题：修复登录页错位",
    proposal: gap("planner", { gap: "A separate plan can change the login fix." }),
  });
  assert.equal(planned.targetRole, "planner");
});

test("substantial frontend work upgrades in place while narrow fixes stay direct", () => {
  const redesign = decideRoute({ text: "整体改版这个运维仪表盘，覆盖移动端和多状态，并用 Playwright 做浏览器验收。" });
  assert.equal(redesign.role, "controller");
  assert.equal(redesign.action, "upgrade");
  assert.equal(redesign.targetRole, "frontend");
  assert.equal(redesign.reasonCode, "FRONTEND_SUBSTANTIAL_INTERFACE_WORK");

  const handoff = decideRoute({ text: "值班同学说这个运维台找事故太慢，给设计和前端一份能直接交接的改版说明，先别改代码。" });
  assert.equal(handoff.action, "upgrade");
  assert.equal(handoff.targetRole, "frontend");

  const incident = decideRoute({
    text: "评估一下这个：把小松同学登录页面、登录后的首页以及个人空间截图发上去，帮我们优化界面介绍，看怎么让大家一眼就能明白小松同学是做什么的。",
  });
  assert.equal(incident.action, "upgrade");
  assert.equal(incident.targetRole, "frontend");
  assert.ok(incident.signals.includes("frontend-multi-surface"));
  assert.ok(incident.signals.includes("frontend-comprehension"));
  assert.ok(incident.signals.includes("frontend-acceptance"));

  for (const text of [
    "修复这个组件的 padding。",
    "题目选项一多，手机上文字就会换行错位，帮我把这个界面优化稳一点。",
    "把按钮文案改成保存。",
    "总结一下这个界面改版方案。",
    "请把 README 中“整体改版这个网站”这句话缩短。",
    "优化登录页面、首页和个人空间的 API 接口调用。",
  ]) {
    assert.equal(decideRoute({ text }).action, "direct", text);
  }
  const partial = decideRoute({ text: "修复这个组件的 padding。" });
  assert.deepEqual(partial.considerations, [{
    role: "frontend",
    match: "partial",
    action: "skip",
    reasonCode: "FRONTEND_BELOW_SPECIALIST_THRESHOLD",
    signals: ["frontend-interface-scope", "frontend-delivery-request"],
    unmet: ["specialist-or-substantial-scope"],
  }]);
  const apiOnly = decideRoute({ text: "优化登录页面、首页和个人空间的 API 接口调用。" });
  assert.deepEqual(apiOnly.considerations, [{
    role: "frontend",
    match: "partial",
    action: "skip",
    reasonCode: "FRONTEND_API_REQUEST",
    signals: ["frontend-interface-scope", "frontend-delivery-request", "frontend-multi-surface"],
    unmet: ["ui-production-request"],
  }]);
});

test("latest genuine user text ignores plugin notices", () => {
  const messages = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "real task" }] },
    { role: "user", source: { kind: "plugin", plugin: "x" }, content: [{ type: "text", text: "notice" }] },
  ];
  assert.equal(extractLatestUserText(messages), "real task");
});

test("routing text inherits referenced high-impact context but keeps low-risk transforms direct", () => {
  const highImpact = "线上退款偶尔重复入账，我看就是确认超时太短。把确认超时改成 30 秒、最多重试 3 次。";
  const user = (text: string): DshMessage => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
  const sessionEvents: DshEvent[] = [
    { type: "user/message", data: user(highImpact) },
    { type: "assistant/message", data: { role: "assistant", content: [{ type: "text", text: "不能直接执行。" }] } },
    { type: "user/message", data: user("用一句话重述刚才的结论") },
    { type: "user/message", data: { role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "routing notice" }] } },
  ];

  assert.equal(extractRoutingText([user("把结论压缩成十个汉字以内")], sessionEvents), "把结论压缩成十个汉字以内");

  const continued = extractRoutingText([user("继续深入判断刚才这个迁移是否可以安全发布")], sessionEvents);
  assert.match(continued, /Referenced earlier high-impact user context/u);
  assert.match(continued, /确认超时改成 30 秒/u);
  assert.equal(decideRoute({ text: continued }).action, "upgrade");

  const unrelated = extractRoutingText([user("把普通按钮文案改清楚")], sessionEvents);
  assert.equal(unrelated, "把普通按钮文案改清楚");
  assert.equal(decideRoute({ text: unrelated }).action, "direct");

  const afterNewTask = extractRoutingText(
    [user("继续处理")],
    [...sessionEvents, { type: "user/message", data: user("把普通按钮文案改清楚") }],
  );
  assert.equal(afterNewTask, "继续处理");
  assert.equal(decideRoute({ text: afterNewTask }).action, "direct");
});

test("frontend continuation inherits only the immediately referenced substantive task", () => {
  const user = (text: string): DshMessage => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
  const incident = "优化登录页面、首页和个人空间的界面介绍，让家长一眼明白产品做什么，并检查截图。";
  const continued = extractRoutingText(
    [user("你能做不？")],
    [{ type: "user/message", data: user(incident) }],
  );
  assert.match(continued, /Referenced earlier frontend user context/u);
  assert.equal(decideRoute({ text: continued }).targetRole, "frontend");

  const explicitContinuation = extractRoutingText(
    [user("继续")],
    [{ type: "user/message", data: user(incident) }],
  );
  assert.match(explicitContinuation, /Referenced earlier frontend user context/u);
  assert.equal(decideRoute({ text: explicitContinuation }).targetRole, "frontend");

  const unrelated = extractRoutingText(
    [user("你能做不？")],
    [
      { type: "user/message", data: user(incident) },
      { type: "user/message", data: user("排查后端缓存键错乱") },
    ],
  );
  assert.equal(unrelated, "你能做不？");
  assert.equal(decideRoute({ text: unrelated }).action, "direct");
});

test("delegation prompt requires a canonical role contract and bounded context", () => {
  const decision = { role: "planner" } as const;
  assert.throws(() => renderDelegationPrompt(decision, "task", undefined), /canonical planner role contract/u);
  const prompt = renderDelegationPrompt(decision, "task", "Canonical planner body.");
  assert.match(prompt, /Canonical planner body\.[\s\S]*Task:\ntask/u);
  assert.match(prompt, /bounded task and evidence packet, not an inherited controller transcript/u);
  assert.match(prompt, /do not request or reconstruct the controller's full history/u);
});
