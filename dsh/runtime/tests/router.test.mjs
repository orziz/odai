import assert from "node:assert/strict";
import test from "node:test";
import {
  OUTPUT_LIMIT_CONTINUATION_REASON,
  classifyPendingReviewerText,
  classifyResponsibilityInterruptionText,
  decideResearchPrefetch,
  decideRoute,
  extractLatestUserText,
  extractRoutingText,
  hasExplicitRequestRevision,
  renderDelegationPrompt,
  renderMissingRouteConfigNotice,
  renderRouteFailureNotice,
  renderRouteNotice,
} from "../build/router.mjs";
function gap(responsibility, overrides = {}) {
  return {
    responsibility,
    gap: `${responsibility} can change the current result.`,
    evidenceRefs: ["current-task", "project-evidence"],
    expectedChange: "Resolve the affected decision or artifact.",
    stateDigest: "a".repeat(64),
    ...overrides,
  };
}
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
  for (const text of [
    "继续",
    "继续；A1 还必须覆盖回滚",
    "补充验收证据：目标测试已经通过",
    "continue with the previous review; add rollback acceptance",
  ]) {
    assert.equal(classifyPendingReviewerText(text), "continue", text);
  }
  for (const text of ["开始另一个任务", "改做一个无关的新问题", "start a separate task", "review another project"]) {
    assert.equal(classifyPendingReviewerText(text), "supersede", text);
  }
  for (const text of ["现在几点？", "解释一下这个术语", "为 API 添加测试", "审查 API", "把『开始另一个任务』改短"]) {
    assert.equal(classifyPendingReviewerText(text), "dormant", text);
  }
  for (const text of ["继续；A1 还必须覆盖回滚", "continue with the previous review; add rollback acceptance"]) {
    assert.equal(hasExplicitRequestRevision(text), true, text);
  }
  for (const text of ["继续", "补充验收证据：目标测试已经通过"]) {
    assert.equal(hasExplicitRequestRevision(text), false, text);
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
  assert.deepEqual(decision.signals, ["evidence-grounded-responsibility-gap", `state:${proposal.stateDigest}`]);
  assert.equal(decideRoute({ text: causal }).targetRole, undefined);
  assert.equal(decideRoute({ text: causal }).reasonCode, "HIGH_IMPACT_EVIDENCE_REQUIRED");
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
test("high-impact causal claims require evidence without inventing a capability gap", () => {
  for (const text of [
    "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
    "It looks like the billing provider is unstable. Reduce the client timeout to 3 seconds and increase retries to 3 as a hotfix.",
  ]) {
    const decision = decideRoute({ text });
    assert.equal(decision.role, "controller");
    assert.equal(decision.action, "direct");
    assert.equal(decision.targetRole, undefined);
    assert.equal(decision.reasonCode, "HIGH_IMPACT_EVIDENCE_REQUIRED");
    assert.ok(decision.signals.includes("risk-present"));
    const supported = decideRoute({ text, proposal: gap("planner") });
    assert.equal(supported.targetRole, "planner");
    assert.equal(supported.reasonCode, "PLANNER_EVIDENCE_STATE_GAP");
  }
});
test("quoted risk examples and evaluation requests do not trigger roles or protection", () => {
  const risk =
    "It looks like the billing provider is unstable. Reduce the client timeout to 3 seconds and increase retries to 3 as a hotfix.";
  for (const text of [
    `Explain this example: \"${risk}\"`,
    `翻译以下内容：\n\n\`\`\`\n${risk}\n\`\`\``,
    `解释这段话：\n> ${risk}`,
  ]) {
    const decision = decideRoute({ text });
    assert.equal(decision.action, "direct");
    assert.equal(decision.targetRole, undefined);
    assert.equal(decision.signals.includes("risk-present"), false);
  }
});
test("route availability notices preserve unresolved independence and action boundaries without whole-turn lockout", () => {
  const decision = decideRoute({
    text: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。",
    proposal: gap("planner"),
  });
  const observe = renderRouteNotice(decision, "observe");
  assert.match(observe, /No independent role was run/u);
  assert.match(observe, /independence as incomplete/u);
  assert.match(observe, /necessary high-impact protections/u);
  assert.doesNotMatch(observe, /Use read-only evidence only|do not implement, persist, or publish/u);
  const upgrade = renderRouteNotice(decision, "auto", {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  assert.match(upgrade, /action: upgrade/u);
  assert.match(upgrade, /no child was started/u);
  assert.match(
    upgrade,
    /requested controller route: openai\/gpt-5\.6-sol \(reasoning: high, maxTokens: inherited from Controller policy\)/u,
  );
  const failure = renderRouteFailureNotice(decision, "provider unavailable");
  assert.match(failure, /no verified delegated result was obtained/u);
  assert.match(failure, /provider unavailable/u);
  assert.match(failure, /Continue authorized work as controller/u);
  assert.match(failure, /independence as incomplete/u);
  assert.match(failure, /necessary high-impact protections/u);
  assert.doesNotMatch(failure, /High-impact fail-closed protection is active|Use read-only evidence only/u);
});
test("missing responsibility mappings do not require configuration before unrelated authorized work", () => {
  for (const role of ["planner", "reviewer"]) {
    for (const signals of [[], ["risk-present", "irreversible-action"]]) {
      const notice = renderMissingRouteConfigNotice(
        {
          role,
          mode: "delegate",
          action: "delegate",
          reasonCode: `${role.toUpperCase()}_TEST_GAP`,
          reason: "test responsibility mapping",
          signals,
        },
        "auto",
      );
      assert.match(notice, new RegExp(`required responsibility: ${role}`, "u"));
      assert.match(notice, new RegExp(`No ${role} model was called`, "u"));
      assert.match(notice, /Continue authorized work/u);
      assert.match(notice, /independence as incomplete/u);
      assert.match(notice, /host plan mode, execution permissions/u);
      assert.doesNotMatch(
        notice,
        /Ask them to name|High-impact fail-closed protection is active|Use read-only evidence only/u,
      );
    }
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
test("frontend scope alone stays direct; an actual capability gap still obtains the specialist", () => {
  const text = "整体改版这个运维仪表盘，覆盖移动端和多状态，并用 Playwright 做浏览器验收。";
  const redesign = decideRoute({ text });
  assert.equal(redesign.role, "controller");
  assert.equal(redesign.action, "direct");
  assert.equal(redesign.targetRole, undefined);
  assert.equal(redesign.considerations?.[0]?.reasonCode, "FRONTEND_GAP_NOT_PROVEN");
  const withGap = decideRoute({
    text,
    proposal: gap("frontend", {
      gap: "Current controller cannot resolve the conflicting interaction and information hierarchy requirements.",
    }),
  });
  assert.equal(withGap.action, "upgrade");
  assert.equal(withGap.targetRole, "frontend");
  const handoff = decideRoute({
    text: "值班同学说这个运维台找事故太慢，给设计和前端一份能直接交接的改版说明，先别改代码。",
  });
  assert.equal(handoff.action, "direct");
  assert.equal(handoff.targetRole, undefined);
  const incident = decideRoute({
    text: "评估一下这个：把小松同学登录页面、登录后的首页以及个人空间截图发上去，帮我们优化界面介绍，看怎么让大家一眼就能明白小松同学是做什么的。",
  });
  assert.equal(incident.action, "direct");
  assert.equal(incident.targetRole, undefined);
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
  assert.deepEqual(partial.considerations, [
    {
      role: "frontend",
      match: "partial",
      action: "skip",
      reasonCode: "FRONTEND_BELOW_SPECIALIST_THRESHOLD",
      signals: ["frontend-interface-scope", "frontend-delivery-request"],
      unmet: ["specialist-or-substantial-scope", "evidence-grounded-capability-gap"],
    },
  ]);
  const apiOnly = decideRoute({ text: "优化登录页面、首页和个人空间的 API 接口调用。" });
  assert.deepEqual(apiOnly.considerations, [
    {
      role: "frontend",
      match: "partial",
      action: "skip",
      reasonCode: "FRONTEND_API_REQUEST",
      signals: ["frontend-interface-scope", "frontend-delivery-request", "frontend-multi-surface"],
      unmet: ["ui-production-request"],
    },
  ]);
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
  const user = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
  const sessionEvents = [
    { type: "user/message", data: user(highImpact) },
    { type: "assistant/message", data: { role: "assistant", content: [{ type: "text", text: "不能直接执行。" }] } },
    { type: "user/message", data: user("用一句话重述刚才的结论") },
    {
      type: "user/message",
      data: { role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "routing notice" }] },
    },
  ];
  assert.equal(extractRoutingText([user("把结论压缩成十个汉字以内")], sessionEvents), "把结论压缩成十个汉字以内");
  const continued = extractRoutingText([user("继续深入判断刚才这个迁移是否可以安全发布")], sessionEvents);
  assert.match(continued, /Referenced earlier high-impact user context/u);
  assert.match(continued, /确认超时改成 30 秒/u);
  assert.equal(decideRoute({ text: continued }).action, "direct");
  assert.equal(decideRoute({ text: continued }).targetRole, undefined);
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
  const user = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
  const incident = "优化登录页面、首页和个人空间的界面介绍，让家长一眼明白产品做什么，并检查截图。";
  const continued = extractRoutingText([user("你能做不？")], [{ type: "user/message", data: user(incident) }]);
  assert.match(continued, /Referenced earlier frontend user context/u);
  assert.equal(decideRoute({ text: continued }).action, "direct");
  const explicitContinuation = extractRoutingText([user("继续")], [{ type: "user/message", data: user(incident) }]);
  assert.match(explicitContinuation, /Referenced earlier frontend user context/u);
  assert.equal(decideRoute({ text: explicitContinuation }).action, "direct");
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
test("creative routing requires a mapping and adjacent creative production or review", () => {
  const positives = [
    "帮我润色这段对白",
    "给新地图写三版商店页宣传语",
    "审一下第二章的台词有没有 AI 味",
    "这个玩法的数值平衡你评估一下",
    "rewrite the store page copy",
    // Domain-neutral requests, not only games.
    "帮我润色一下这段产品介绍",
    "给新功能想几个名字",
    "帮我脑暴一些创意",
    "润色一下我的简历",
    "给发布会写三版宣传语",
    "审一下这段文字的语气",
    "brainstorm taglines for the launch",
    "polish the copy on the landing page",
    "come up with names for the new app",
  ];
  for (const text of positives) {
    assert.equal(decideRoute({ text }).action, "direct", `unmapped: ${text}`);
    const decision = decideRoute({ text, creativeConfigured: true });
    assert.equal(decision.role, "creative", text);
    assert.equal(decision.action, "delegate", text);
  }
  const negatives = [
    "把文案常量改成从配置读取",
    "台词表加一列 speaker",
    "修一下对白组件的渲染 bug",
    "给这个函数起个名字",
    "把剧情模块拆成两个文件",
    "改一下 PR 描述",
    "review this code",
    "写一下玩法的单元测试",
    "优化一下剧情的加载速度",
    "审一下玩法代码",
    "把剧情写进存档",
    "文案写到配置里",
    "write a copy of the config to /tmp",
    "review the balance sheet export",
    "优化剧情系统的性能",
    "评估一下玩法逻辑的复杂度",
    "写一个函数，旁白由配置读取",
    "文案先保留。评估一下数据库迁移",
    "请润色 README，它解释对白的存储机制",
    "引用示例：‘帮我润色这段对白’",
    "> rewrite the store page copy",
    "`rewrite the store page copy`",
    "rewrite the store page copy field",
    "写\n文案",
    "write\nthe copy",
    "给这个变量想个名字",
    "写一下 API 接口的介绍文档",
    "把简历导出成 PDF",
    "brainstorm names for the database tables",
    "润色一下 commit message",
    "改一下按钮名称",
    "review the API naming",
  ];
  for (const text of negatives) {
    assert.equal(decideRoute({ text, creativeConfigured: true }).action, "direct", text);
  }
  for (const suffix of ["常量", "变量", "字段", "文件", "配置", "键", "key", "表", "列", "模块", "组件", "接口", "函数", "id"]) {
    for (const text of [`优化文案${suffix}`, `文案${suffix}你评估一下`, `重写商店页宣传语${suffix}`]) {
      assert.equal(decideRoute({ text, creativeConfigured: true }).action, "direct", text);
    }
  }
});
test("creative lexical veto stays within the clause and excludes storage actions and copy-of", () => {
  for (const text of [
    "测试完成后润色这段对白",
    "please review the copy for the export",
    "review a copy of the story",
    ...["进", "到", "入", "在"].map((suffix) => `把文案写${suffix}这里`),
  ]) {
    assert.equal(decideRoute({ text, creativeConfigured: true }).action, "direct", text);
  }
  for (const separator of ["，", ",", "。", ".", "；", ";", "：", ":", "\n"]) {
    const text = `测试加载性能${separator}帮我润色这段对白`;
    assert.equal(decideRoute({ text, creativeConfigured: true }).role, "creative", text);
  }
});
test("creative complaint followed by a bare fix request routes; engineering complaints do not", () => {
  for (const text of [
    "这段话 AI 味太重，帮我改改",
    "第三章旁白太啰嗦了，帮我改写一下",
    "首页文案有点生硬。润色一下",
  ]) {
    assert.equal(decideRoute({ text, creativeConfigured: true }).role, "creative", text);
    assert.equal(decideRoute({ text }).action, "direct", `unmapped: ${text}`);
  }
  for (const text of [
    "这个函数有 bug，帮我改改",
    "剧情加载太慢，帮我优化一下",
    "文案先保留，帮我优化一下",
    "文案太长，帮我优化一下数据库查询",
    "这段文案太长，帮我改改配置",
    "文案太长，测试一下，帮我改改",
  ]) {
    assert.equal(decideRoute({ text, creativeConfigured: true }).action, "direct", text);
  }
});
test("creative proposals use child routing and lexical routing excludes appended context", () => {
  const proposal = gap("creative");
  assert.equal(decideRoute({ text: "继续", proposal }).action, "direct");
  const decision = decideRoute({ text: "继续", proposal, creativeConfigured: true });
  assert.equal(decision.role, "creative");
  assert.equal(decision.action, "delegate");
  assert.equal(decision.reasonCode, "CREATIVE_EVIDENCE_STATE_GAP");
  assert.equal(decideRoute({ text: "继续\n\nReferenced earlier context:\n帮我润色这段对白", creativeText: "继续", creativeConfigured: true }).action, "direct");
  assert.equal(decideRoute({ text: "帮我润色这段对白", proposal: gap("user"), creativeConfigured: true }).reasonCode, "USER_DECISION_REQUIRED");
});
test("delegation prompt requires a canonical role contract and bounded context", () => {
  const decision = { role: "planner" };
  assert.throws(() => renderDelegationPrompt(decision, "task", undefined), /canonical planner role contract/u);
  const prompt = renderDelegationPrompt(decision, "task", "Canonical planner body.");
  assert.ok(prompt.includes("Canonical planner body."));
  assert.ok(prompt.includes("task"));
});

 test("writer splits production from direction only when configured", () => {
  const options = { creativeConfigured: true, writerConfigured: true };
  for (const text of ["帮我润色这段对白", "给新地图写三版商店页宣传语", "把这段文案翻译成英文", "rewrite the store page copy", "这段话 AI 味太重，帮我改改", "优化一下这段介绍"]) {
    assert.equal(decideRoute({ text, ...options }).role, "writer", text);
  }
  for (const text of ["审一下第二章的台词有没有 AI 味", "这个玩法的数值平衡你评估一下", "给这个功能起个名字", "写一下世界观设定"]) {
    assert.equal(decideRoute({ text, ...options }).role, "creative", text);
  }
  for (const text of ["写一下玩法的单元测试", "优化一下剧情的加载速度", "审一下玩法代码", "把剧情写进存档", "文案写到配置里", "write a copy of the config to /tmp", "review the balance sheet export", "优化剧情系统的性能", "评估一下玩法逻辑的复杂度", "翻译这段报错", "把这个变量的名字改一下"]) {
    assert.equal(decideRoute({ text, ...options }).action, "direct", text);
  }
  const decision = decideRoute({ text: "继续", proposal: gap("writer"), ...options });
  assert.equal(decision.role, "writer");
  assert.ok(decision.signals.includes("evidence-grounded-responsibility-gap"));
  assert.ok(decision.signals.includes(`state:${gap("writer").stateDigest}`));
  for (const text of ["这个玩法挺好的", "你的名字叫什么", "这个点子不错，先记下", "I have some ideas about the refactor", "check the balance first", "改一下项目名称", "这个创意来自用户反馈", "我们用这个名字当包名吧", "the gameplay loop feels slow, profile it", "用户说玩法太难了"]) {
    assert.equal(decideRoute({ text, ...options }).action, "direct", text);
    assert.equal(decideRoute({ text, creativeConfigured: true }).action, "direct", text);
  }
 });
