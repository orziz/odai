import assert from "node:assert/strict";
import test from "node:test";
import {
  bindResponsibilityGapToTask,
  createResponsibilityGapTool,
  isBoundRequirementLedger,
  resolveResponsibilityGap,
} from "../build/responsibility-gap.mjs";
import { recognizeNamedRequests } from "../build/responsibility-gap.mjs";
export const namedRoutes = {
  planner: { backend: "local-cli", cli: "claude", model: "opus" },
  reviewer: { backend: "local-cli", cli: "claude", model: "opus" },
  creative: { backend: "local-cli", cli: "claude", model: "opus" },
  writer: { backend: "local-cli", cli: "antigravity", model: "gemini" },
  frontend: { backend: "local-cli", cli: "antigravity", model: "gemini" },
};
export const namedExamples = [
  ["先让 Claude 规划一下再动手", [["planner", "start"]]],
  ["做完让 Claude 验收", [["reviewer", "completion"]]],
  ["先让 Claude 规划，做完再让 Claude 验收", [["planner", "start"], ["reviewer", "completion"]]],
  ["文案让 Gemini 写", [["writer", "start"]]],
  ["让 Claude 定方向，Gemini 写文案，写完让 Claude 审", [["creative", "start"], ["writer", "start"], ["creative", "completion"]]],
  ["让 Claude 写这段文案", [["creative", "start"]]],
  ["用 Gemini 做这个页面的界面", [["frontend", "start"]]],
  ["have Claude plan this first, then let Claude review when done", [["planner", "start"], ["reviewer", "completion"]]],
];
export const notNamedExamples = [
  '“让 Claude 规划”', '"让 Claude 规划"', '`让 Claude 规划`', '‘让 Claude 规划’', '> 让 Claude 规划',
  "你规划了吗", "上次 Claude 审过了", "Claude 的规划写得不错",
  "规划用本机 claude opus，推理档 max", "以后文案都让 Gemini 写",
  "给 odai 加一个让 Claude 规划的开关", "写一下让 Claude 审查代码的测试", "先规划一下再做",
];
for (const [text, expected] of namedExamples) test(`named delegation: ${text}`, () => {
  assert.deepEqual(recognizeNamedRequests(text, namedRoutes).map(({ responsibility, timing }) => [responsibility, timing]), expected);
});
for (const text of notNamedExamples) test(`not a named delegation: ${text}`, () => assert.deepEqual(recognizeNamedRequests(text, namedRoutes), []));
test("named mappings fail closed and cancellation does not request dispatch", () => {
  assert.equal(recognizeNamedRequests("让 Claude 规划", { ...namedRoutes, planner: { provider: "openai", model: "gpt" } })[0].issue, "mapping-mismatch");
  assert.equal(recognizeNamedRequests("文案让 Gemini 写", { ...namedRoutes, writer: undefined })[0].issue, "mapping-mismatch");
  assert.equal(recognizeNamedRequests("不用让 Claude 审了", namedRoutes)[0].canceled, true);
});
export const reviewExamples = [
  ["做完让 Claude 验收，记得跑测试", namedRoutes, [["reviewer", "completion"]]],
  ["先让 Claude 规划一下配置文件的迁移", namedRoutes, [["planner", "start"]]],
  ["先让 Claude 规划，做完跑一下单元测试，再让 Claude 验收", namedRoutes, [["planner", "start"], ["reviewer", "completion"]]],
  ["做完让 Claude 验收，默认分支是 main", namedRoutes, [["reviewer", "completion"]]],
  ["先让 Claude 规划一下这个开关怎么实现", namedRoutes, [["planner", "start"]]],
  ...["请审查一下这段代码", "请规划一下路线", "请调查一下这个报错的原因"].map(text => [text, namedRoutes, []]),
  ["让 Claude 定方向，GPT 实现，做完让 Claude 验收代码", namedRoutes, [["creative", "start"], ["reviewer", "completion"]]],
  ["做完让 Kimi 验收", { reviewer: { provider: "kimi", model: "kimi-coding" } }, [["reviewer", "completion"]]],
  ["做完让 DeepSeek 验收", { reviewer: { provider: "custom", model: "deepseek-v4-pro" } }, [["reviewer", "completion"]]],
  ["做完让 KIMI 验收", { reviewer: { provider: "custom", model: "kimi-coding" } }, [["reviewer", "completion"]]],
  ["做完让 Kimi 验收", namedRoutes, []],
];
for (const [text, routes, expected] of reviewExamples) test(`review regression: ${text} (${JSON.stringify(routes)})`, () => {
  const actual = recognizeNamedRequests(text, routes);
  assert.deepEqual(actual.map(({ responsibility, timing }) => [responsibility, timing]), expected);
  assert.ok(actual.every(item => !item.issue));
});
for (const text of ["交给审查", "让审查职责检查代码", "请 reviewer 检查代码"]) test(`explicit role object: ${text}`, () => {
  assert.equal(recognizeNamedRequests(text, namedRoutes)[0]?.responsibility, "reviewer");
});
for (const text of ["做完让 ordinary 验收", "做完让 Kimiko 验收", "给 odai 写一个让 Kimi 验收的测试"]) test(`bounded names: ${text}`, () => {
  assert.deepEqual(recognizeNamedRequests(text, { reviewer: { provider: "custom", model: "kimi-coding" } }), []);
});
test("responsibility gaps are structured, grounded, and content addressed", () => {
  const proposal = resolveResponsibilityGap({
    responsibility: "planner",
    gap: "Two public contract routes remain possible.",
    evidenceRefs: ["read:api.md", "read:implementation.mjs"],
    expectedChange: "Select the compatible contract before implementation.",
  });
  assert.match(proposal.stateDigest, /^[a-f0-9]{64}$/u);
  assert.equal(proposal.responsibility, "planner");
  assert.throws(
    () =>
      resolveResponsibilityGap({
        responsibility: "planner",
        gap: "Task is complex.",
        evidenceRefs: [],
        expectedChange: "Maybe help.",
      }),
    /1 to 12/u,
  );
  assert.throws(
    () =>
      resolveResponsibilityGap({
        responsibility: "user",
        gap: "Priority changes the route.",
        evidenceRefs: ["user-request"],
        expectedChange: "Choose compatibility or speed.",
      }),
    /question is required/u,
  );
});
test("responsibility gap identity is bound to the direct user task", () => {
  const proposal = resolveResponsibilityGap({
    responsibility: "reviewer",
    gap: "Review the current target against its acceptance.",
    evidenceRefs: ["current-target"],
    expectedChange: "Return blocking findings or acceptance.",
  });
  const first = bindResponsibilityGapToTask(proposal, "user-task-1");
  const second = bindResponsibilityGapToTask(proposal, "user-task-2");
  assert.equal(first.taskMessageId, "user-task-1");
  assert.equal(second.taskMessageId, "user-task-2");
  assert.notEqual(first.stateDigest, proposal.stateDigest);
  assert.notEqual(first.stateDigest, second.stateDigest);
  assert.throws(() => bindResponsibilityGapToTask(proposal, "x".repeat(201)), /at most 200/u);
});
test("requirement ledgers bind exact user excerpts and preserve unrelated active decisions", () => {
  const proposal = resolveResponsibilityGap({
    responsibility: "reviewer",
    gap: "Review the frozen compatibility requirements.",
    evidenceRefs: ["current-target", "final-diff"],
    expectedChange: "Reject only changes that violate active requirements.",
    requirements: [
      {
        id: "R-old-runtime",
        statement: "Support only the old runtime.",
        status: "superseded",
        sourceExcerpt: "先只支持旧 runtime",
        supersededBy: "R-new-runtime",
      },
      {
        id: "R-keep-ui",
        statement: "Keep the existing UI behavior.",
        status: "active",
        sourceExcerpt: "现有 UI 行为必须保留",
      },
      {
        id: "R-new-runtime",
        statement: "Support both runtime generations.",
        status: "active",
        sourceExcerpt: "改为同时支持两代 runtime",
      },
    ],
  });
  const bound = bindResponsibilityGapToTask(proposal, "user-task-3", [
    { messageId: "user-old", text: "先只支持旧 runtime。", order: 1 },
    { messageId: "user-keep", text: "现有 UI 行为必须保留。", order: 2 },
    { messageId: "user-new", text: "纠正：改为同时支持两代 runtime。", order: 3 },
  ]);
  assert.ok(bound.requirements);
  assert.deepEqual(
    bound.requirements.map(({ id, status, supersededBy, sourceMessageId }) => ({
      id,
      status,
      ...(supersededBy ? { supersededBy } : {}),
      sourceMessageId,
    })),
    [
      { id: "R-old-runtime", status: "superseded", supersededBy: "R-new-runtime", sourceMessageId: "user-old" },
      { id: "R-keep-ui", status: "active", sourceMessageId: "user-keep" },
      { id: "R-new-runtime", status: "active", sourceMessageId: "user-new" },
    ],
  );
  assert.notEqual(bound.stateDigest, proposal.stateDigest);
  assert.equal(isBoundRequirementLedger(bound.requirements), true);
  assert.equal(
    isBoundRequirementLedger(
      bound.requirements.map((requirement) =>
        requirement.id === "R-keep-ui" ? { ...requirement, supersededBy: "R-new-runtime" } : requirement,
      ),
    ),
    false,
  );
  assert.equal(
    isBoundRequirementLedger(
      bound.requirements.map((requirement) =>
        requirement.id === "R-old-runtime" ? { ...requirement, sourceOrder: 4 } : requirement,
      ),
    ),
    false,
  );
  assert.equal(
    isBoundRequirementLedger(bound.requirements.map((requirement) => ({ ...requirement, injected: true }))),
    false,
  );
  assert.throws(
    () =>
      bindResponsibilityGapToTask(proposal, "user-task-3", [
        { messageId: "duplicate-1", text: "先只支持旧 runtime。", order: 1 },
        { messageId: "duplicate-2", text: "再次引用：先只支持旧 runtime。", order: 2 },
        { messageId: "user-keep", text: "现有 UI 行为必须保留。", order: 3 },
        { messageId: "user-new", text: "改为同时支持两代 runtime。", order: 4 },
      ]),
    /must match exactly one authenticated direct-user message/u,
  );
  assert.throws(
    () =>
      bindResponsibilityGapToTask(proposal, "user-task-3", [
        { messageId: "user-new", text: "改为同时支持两代 runtime。", order: 1 },
        { messageId: "user-old", text: "先只支持旧 runtime。", order: 2 },
        { messageId: "user-keep", text: "现有 UI 行为必须保留。", order: 3 },
      ]),
    /must precede its replacement/u,
  );
  assert.throws(
    () =>
      bindResponsibilityGapToTask(proposal, "user-task-3", [
        { messageId: "user-old", text: "先只支持旧 runtime。", order: 1 },
        { messageId: "user-keep", text: "现有 UI 行为必须保留。", order: 1 },
        { messageId: "user-new", text: "改为同时支持两代 runtime。", order: 3 },
      ]),
    /inconsistent source provenance/u,
  );
});
test("requirement ledgers reject invalid status relationships", () => {
  assert.throws(
    () =>
      resolveResponsibilityGap({
        responsibility: "planner",
        gap: "Freeze requirements.",
        evidenceRefs: ["current-task"],
        expectedChange: "Produce active acceptance.",
        requirements: [
          {
            id: "R-old",
            statement: "Old behavior.",
            status: "superseded",
            sourceExcerpt: "old behavior",
            supersededBy: "R-missing",
          },
        ],
      }),
    /must form an acyclic chain ending at an active requirement/u,
  );
  assert.throws(
    () =>
      resolveResponsibilityGap({
        responsibility: "planner",
        gap: "Freeze requirements.",
        evidenceRefs: ["current-task"],
        expectedChange: "Produce active acceptance.",
        requirements: [
          {
            id: "R-active",
            statement: "Active behavior.",
            status: "active",
            sourceExcerpt: "active behavior",
            supersededBy: "R-other",
          },
        ],
      }),
    /active decisions cannot set supersededBy/u,
  );
  assert.throws(
    () =>
      resolveResponsibilityGap({
        responsibility: "researcher",
        gap: "Do not attach decision state to source research.",
        evidenceRefs: ["source-question"],
        expectedChange: "Keep requirement provenance on planner/reviewer gaps.",
        requirements: [
          { id: "R-active", statement: "Active behavior.", status: "active", sourceExcerpt: "active behavior" },
        ],
      }),
    /requirements are only valid for planner or reviewer gaps/u,
  );
  assert.throws(
    () =>
      resolveResponsibilityGap({
        responsibility: "reviewer",
        gap: "Reject a cyclic replacement graph.",
        evidenceRefs: ["decision-ledger"],
        expectedChange: "Fail closed.",
        requirements: [
          {
            id: "R-one",
            statement: "First choice.",
            status: "superseded",
            sourceExcerpt: "first choice",
            supersededBy: "R-two",
          },
          {
            id: "R-two",
            statement: "Second choice.",
            status: "superseded",
            sourceExcerpt: "second choice",
            supersededBy: "R-one",
          },
        ],
      }),
    /must form an acyclic chain ending at an active requirement/u,
  );
  const chain = resolveResponsibilityGap({
    responsibility: "reviewer",
    gap: "Review the final decision after two explicit corrections.",
    evidenceRefs: ["current-task", "decision-ledger"],
    expectedChange: "Apply the final active requirement without losing the correction history.",
    requirements: [
      {
        id: "R-one",
        statement: "First choice.",
        status: "superseded",
        sourceExcerpt: "first choice",
        supersededBy: "R-two",
      },
      {
        id: "R-two",
        statement: "Second choice.",
        status: "superseded",
        sourceExcerpt: "second choice",
        supersededBy: "R-three",
      },
      { id: "R-three", statement: "Final choice.", status: "active", sourceExcerpt: "final choice" },
    ],
  });
  const boundChain = bindResponsibilityGapToTask(chain, "user-final", [
    { messageId: "user-one", text: "first choice", order: 1 },
    { messageId: "user-two", text: "second choice", order: 2 },
    { messageId: "user-three", text: "final choice", order: 3 },
  ]);
  assert.equal(isBoundRequirementLedger(boundChain.requirements), true);
});
test("only the controller can submit a responsibility or user-decision gap", async () => {
  const proposals = [];
  const tool = createResponsibilityGapTool({
    onProposed(_agent, proposal) {
      proposals.push(proposal);
    },
  });
  const agent = { session: { header: {}, snapshotEvents: () => [], append() {} } };
  const result = await tool.execute(
    {
      responsibility: "user",
      gap: "The request does not choose which behavior to preserve.",
      evidenceRefs: ["user-request", "current-contract"],
      expectedChange: "Choose the compatibility boundary.",
      question: "Should the existing API remain backward compatible?",
    },
    { name: "odai_responsibility_gap", agent },
  );
  assert.equal(result.recorded, true);
  assert.equal("accepted" in result, false);
  assert.equal(result.responsibility, "user");
  assert.ok(tool.output);
  assert.deepEqual(tool.output.schema.required, ["recorded", "responsibility", "stateDigest", "next"]);
  const outputProperties = tool.output.schema.properties;
  assert.equal("recorded" in outputProperties, true);
  assert.equal("accepted" in outputProperties, false);
  const rendered = tool.output.render({}, result)[0]?.text;
  assert.ok(rendered);
  assert.match(rendered, /Recorded user gap/u);
  assert.match(rendered, /has not been routed or started/u);
  assert.match(rendered, /Ask exactly the accepted concise question/u);
  const plannerResult = await tool.execute(
    {
      responsibility: "planner",
      gap: "Independent rollout contracts can change implementation order.",
      evidenceRefs: ["user-rollout-requirement", "current-api-contract"],
      expectedChange: "Freeze compatibility and rollback acceptance before edits.",
    },
    { name: "odai_responsibility_gap", agent },
  );
  const plannerRendered = tool.output.render({}, plannerResult)[0]?.text;
  assert.ok(plannerRendered);
  assert.match(plannerRendered, /Recorded planner gap/u);
  assert.match(plannerRendered, /not been routed or started/u);
  assert.match(plannerRendered, /will reassess the recorded proposal/u);
  assert.equal(proposals.length, 2);
  const childTool = createResponsibilityGapTool({ isChild: () => true });
  assert.throws(
    () =>
      childTool.execute(
        {
          responsibility: "planner",
          gap: "A route is unresolved.",
          evidenceRefs: ["source"],
          expectedChange: "Select a route.",
        },
        { name: "odai_responsibility_gap", agent },
      ),
    /child agents may not own/u,
  );
});
