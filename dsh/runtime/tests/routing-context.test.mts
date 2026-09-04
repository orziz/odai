import assert from "node:assert/strict";
import test from "node:test";

import { buildRoleContextPacket, renderRoleContextPacket } from "../build/routing-context.mjs";
import { isUnknownRecord } from "../build/runtime-types.mjs";
import type { DshEvent, DshMessage } from "../build/runtime-types.mjs";

function eventCommand(event: DshEvent): string {
  let arguments_ = event.data?.arguments;
  if (typeof arguments_ === "string" && arguments_.trim().startsWith("{")) arguments_ = JSON.parse(arguments_) as unknown;
  return isUnknownRecord(arguments_) && typeof arguments_.command === "string" ? arguments_.command : "";
}

const userMessage = (text: string): DshMessage => ({
  id: "user-1",
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

function nativeToolEvents(
  callId: string,
  name: string,
  args: unknown,
  output: string,
  options: { callSeq?: number; isError?: boolean } = {},
): DshEvent[] {
  const callSeq = options.callSeq ?? 100;
  const isError = options.isError === true;
  return [
    {
      type: "tool/call",
      seq: callSeq,
      data: { turn: 1, step: 1, callId, name, arguments: args },
    },
    {
      type: "tool/result",
      seq: callSeq + 1,
      sourceEventSeqs: [callSeq],
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "user",
          source: { kind: "tool", callId },
          content: [{
            type: "tool-result",
            toolCallId: callId,
            content: [{ type: "text", text: output }],
            isError,
          }],
        },
        ...(isError ? { error: { code: "COMMAND_FAILED" } } : {}),
      },
    },
  ];
}

function agentFor(events: readonly DshEvent[]) {
  return { session: { snapshotEvents: () => events } };
}

function completeReviewEvents(options: {
  diffOutput?: string;
  diffIsError?: boolean;
  testCommand?: string;
  testOutput?: string;
  testIsError?: boolean;
} = {}): DshEvent[] {
  return [
    { type: "user/message", data: userMessage("实现请求：修复路由并保持默认行为。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：目标测试通过；A2：只修改目标模块。" }] } },
    ...nativeToolEvents(
      "diff-1",
      "pwsh",
      { command: "git diff -- dsh/runtime/src/router.mts" },
      options.diffOutput ?? "diff --git a/dsh/runtime/src/router.mts b/dsh/runtime/src/router.mts\n+bounded change",
      { callSeq: 10, isError: options.diffIsError },
    ),
    ...nativeToolEvents(
      "test-1",
      "pwsh",
      { command: options.testCommand ?? "node --test dsh/runtime/tests/router.test.mts" },
      options.testOutput ?? "tests 14\npass 14\nfail 0\nexit code: 0",
      { callSeq: 20, isError: options.testIsError },
    ),
  ];
}

test("reviewer packets require requirements, acceptance, diff, tests, and tool evidence", () => {
  const agent = agentFor(completeReviewEvents());
  const packet = buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现");

  assert.equal(packet.schemaVersion, 2);
  assert.equal(packet.sufficient, true);
  assert.deepEqual(packet.coverage, {
    requirements: true,
    requirementDecisionCount: 0,
    activeRequirementCount: 0,
    supersededRequirementCount: 0,
    requirementProvenance: false,
    acceptanceCount: 1,
    diffCount: 1,
    testCount: 1,
    failedTestCount: 0,
    checkCount: 0,
    failedCheckCount: 0,
    writeCount: 0,
    toolEvidenceCount: 2,
    latestWriteIndex: -1,
    latestDiffIndex: 3,
    latestTestIndex: 5,
    latestFailedTestIndex: -1,
    latestCheckIndex: -1,
    latestFailedCheckIndex: -1,
    currentEvidence: true,
  });
  assert.match(packet.digest, /^[a-f0-9]{64}$/u);
  assert.equal(buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现").digest, packet.digest);
  const rendered = renderRoleContextPacket(packet);
  assert.match(rendered, new RegExp(`digest: sha256:${packet.digest}`, "u"));
  assert.match(rendered, /kinds: tool, diff/u);
  assert.match(rendered, /kinds: tool, test/u);
});

test("reviewer packets preserve source-verified active and superseded requirement decisions", () => {
  const agent = agentFor(completeReviewEvents());
  const requirements = [
    {
      id: "R-old",
      statement: "Drop the legacy path.",
      status: "superseded" as const,
      sourceExcerpt: "先移除旧路径",
      supersededBy: "R-compatible",
      sourceMessageId: "user-old",
      sourceOrder: 1,
    },
    {
      id: "R-compatible",
      statement: "Keep both service generations.",
      status: "active" as const,
      sourceExcerpt: "保留两代服务",
      sourceMessageId: "user-current",
      sourceOrder: 2,
    },
    {
      id: "R-ui",
      statement: "Keep existing UI behavior.",
      status: "active" as const,
      sourceExcerpt: "保持现有 UI",
      sourceMessageId: "user-ui",
      sourceOrder: 3,
    },
  ];
  const packet = buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现", { requirements });
  const rendered = renderRoleContextPacket(packet);

  assert.equal(packet.coverage.requirementDecisionCount, 3);
  assert.equal(packet.coverage.activeRequirementCount, 2);
  assert.equal(packet.coverage.supersededRequirementCount, 1);
  assert.equal(packet.coverage.requirementProvenance, true);
  assert.deepEqual(packet.requirements, requirements);
  assert.match(rendered, /Frozen requirement decisions/u);
  assert.match(rendered, /R-compatible/u);
  assert.match(rendered, /"status": "superseded"/u);
  assert.doesNotMatch(rendered, /no source-verified requirement ledger/u);

  const changed = buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现", {
    requirements: requirements.map((requirement) => requirement.id === "R-ui"
      ? { ...requirement, statement: "Changed active requirement." }
      : requirement),
  });
  assert.notEqual(changed.digest, packet.digest);
  assert.notEqual(changed.evidenceDigest, packet.evidenceDigest);

  const mutable = requirements.map((requirement) => ({ ...requirement }));
  const frozen = buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现", { requirements: mutable });
  mutable[1]!.statement = "Mutated after packet creation.";
  assert.equal(frozen.requirements[1]?.statement, "Keep both service generations.");
  assert.equal(buildRoleContextPacket(agent, "reviewer", "请独立审查这次实现", {
    requirements: frozen.requirements,
  }).digest, frozen.digest);
});

test("current DSH native tool call/result replays produce grounded coverage", () => {
  const packet = buildRoleContextPacket(
    agentFor(completeReviewEvents({
      testCommand: "npm.cmd --prefix dsh/plugin test",
    }).map((event) => event.type === "tool/call"
      ? { ...event, data: { ...event.data, arguments: JSON.stringify(event.data.arguments) } }
      : event)),
    "reviewer",
    "review",
  );
  assert.equal(packet.sufficient, true);
  assert.equal(packet.coverage.diffCount, 1);
  assert.equal(packet.coverage.testCount, 1);
});

test("current JSON arguments and raw stream chunks remain reviewable", () => {
  const events = completeReviewEvents({
    testCommand: "npm run test:unit -- --run tests/store/auth.spec.ts",
    testOutput: "Test Files 2 passed\nTests 7 passed",
    diffOutput: `diff --git a/src/store/auth.ts b/src/store/auth.ts\n${"+compatibility change\n".repeat(800)}`,
  }).map((event) => event.type === "tool/call"
    ? { ...event, data: { ...event.data, arguments: JSON.stringify(event.data.arguments) } }
    : event);
  for (let index = 0; index < 160; index += 1) {
    events.push({ type: index % 2 === 0 ? "text-chunks" : "reasoning-chunks", seq: 1_000 + index, data: { text: "stream chunk" } });
  }
  const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
  assert.equal(packet.sufficient, true);
  assert.equal(packet.coverage.diffCount, 1);
  assert.equal(packet.coverage.testCount, 1);
  assert.equal(packet.diagnostics.rawEventCount, events.length);
  assert.equal(packet.diagnostics.nativeToolCallCount, 2);
  assert.equal(packet.diagnostics.linkedToolResultCount, 2);
  assert.equal(packet.diagnostics.hostEvidenceAvailable, true);
  assert.equal(packet.truncated, true);
});

test("user acceptance, namespaced tools, and external workspace paths produce current evidence", () => {
  const events: DshEvent[] = [
    { type: "user/message", data: userMessage("必须保持旧接口，并允许前后端分开发版。") },
    ...nativeToolEvents(
      "external-edit",
      "functions.edit",
      JSON.stringify({ file_path: "../../tutor-frontend/src/store/auth.ts" }),
      "updated external file",
      { callSeq: 30 },
    ),
    ...nativeToolEvents(
      "external-diff",
      "functions.bash",
      JSON.stringify({ command: "git diff -- src/store/auth.ts", workdir: "../../tutor-frontend" }),
      "diff --git a/src/store/auth.ts b/src/store/auth.ts\n+compatible fallback",
      { callSeq: 40 },
    ),
    ...nativeToolEvents(
      "external-test",
      "functions.bash",
      JSON.stringify({ command: "npm run test:unit -- --run tests/store/auth.spec.ts", workdir: "../../tutor-frontend" }),
      "Test Files 1 passed\nTests 7 passed",
      { callSeq: 50 },
    ),
  ];
  const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
  assert.equal(packet.coverage.acceptanceCount, 1);
  assert.equal(packet.coverage.writeCount, 1);
  assert.equal(packet.coverage.diffCount, 1);
  assert.equal(packet.coverage.testCount, 1);
  assert.equal(packet.coverage.currentEvidence, true);
  assert.equal(packet.sufficient, true);
});

test("ask_user_question preserves the full user decision as acceptance evidence", () => {
  const events: DshEvent[] = [
    { type: "user/message", data: userMessage("先讨论真实目标，不要实施。") },
    ...nativeToolEvents(
      "ask-user-1",
      "functions.ask_user_question",
      {
        questions: [{
          id: "scope",
          header: "目标范围",
          question: "这次总体检查应覆盖哪些层面？",
          multi_select: true,
          options: [
            { label: "Canonical Skill", description: "检查跨宿主治理语义。" },
            { label: "DSH Runtime", description: "检查状态、路由与证据。" },
          ],
        }],
      },
      JSON.stringify({
        answers: [{ id: "scope", selected: ["Canonical Skill", "DSH Runtime"], custom: "还要覆盖评测与发布" }],
      }),
      { callSeq: 60 },
    ),
  ];
  const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
  const rendered = renderRoleContextPacket(packet);

  assert.equal(packet.coverage.acceptanceCount, 2);
  assert.match(rendered, /这次总体检查应覆盖哪些层面/u);
  assert.match(rendered, /Canonical Skill/u);
  assert.match(rendered, /还要覆盖评测与发布/u);
  assert.match(rendered, /user-decision/u);

  const incomplete = buildRoleContextPacket(agentFor([
    { type: "user/message", data: userMessage("先讨论真实目标，不要实施。") },
    ...nativeToolEvents(
      "ask-user-empty",
      "functions.ask_user_question",
      { questions: [{ id: "scope", question: "覆盖哪些层面？" }] },
      JSON.stringify({ answers: [] }),
      { callSeq: 70 },
    ),
  ]), "reviewer", "review");
  assert.equal(incomplete.coverage.acceptanceCount, 1);
  assert.doesNotMatch(renderRoleContextPacket(incomplete), /user-decision/u);

  const malformedDecisions = [
    {
      questions: [{ id: "scope", question: "范围？" }, { id: "scope", question: "仍是范围？" }],
      answers: [{ id: "scope", selected: ["Canonical Skill"] }],
    },
    {
      questions: [{ id: "scope", question: "范围？" }],
      answers: [{ id: "scope", selected: ["Canonical Skill"] }, { id: "scope", selected: ["DSH Runtime"] }],
    },
    {
      questions: [{ id: "scope", question: "范围？" }],
      answers: [{ id: "scope", selected: ["Canonical Skill"] }, { id: "extra", selected: ["DSH Runtime"] }],
    },
    {
      questions: [{ id: "scope", question: "范围？" }, "malformed question"],
      answers: [{ id: "scope", selected: ["Canonical Skill"] }],
    },
  ];
  for (const [index, malformed] of malformedDecisions.entries()) {
    const packet = buildRoleContextPacket(agentFor([
      { type: "user/message", data: userMessage("先讨论真实目标，不要实施。") },
      ...nativeToolEvents(
        `ask-user-malformed-${index}`,
        "functions.ask_user_question",
        { questions: malformed.questions },
        JSON.stringify({ answers: malformed.answers }),
        { callSeq: 80 + index * 10 },
      ),
    ]), "reviewer", "review");
    assert.equal(packet.coverage.acceptanceCount, 1);
    assert.doesNotMatch(renderRoleContextPacket(packet), /user-decision/u);
  }
});

test("common JavaScript and JVM test entry points are recognized", () => {
  for (const command of [
    "npx vitest run tests/store/auth.spec.ts",
    "npm run test:unit -- --run tests/store/auth.spec.ts",
    "mvn test",
    "./mvnw verify",
    "./gradlew test",
  ]) {
    const packet = buildRoleContextPacket(
      agentFor(completeReviewEvents({ testCommand: command, testOutput: "Tests 7 passed\nfail 0" })),
      "reviewer",
      "review",
    );
    assert.equal(packet.coverage.testCount, 1, command);
    assert.equal(packet.sufficient, true, command);
  }
});

test("a successful native test result does not require a duplicate stdout verdict", () => {
  const packet = buildRoleContextPacket(agentFor(completeReviewEvents({ testOutput: "" })), "reviewer", "review");

  assert.equal(packet.coverage.testCount, 1);
  assert.equal(packet.coverage.failedTestCount, 0);
  assert.equal(packet.diagnostics.testWithoutVerdictCount, 1);
  assert.equal(packet.sufficient, true);
});

test("quoted test filters do not become shell mutations", () => {
  const packet = buildRoleContextPacket(agentFor(completeReviewEvents({
    testCommand: "node --test --test-name-pattern=\"pass|read-only\" dsh/runtime/tests/routing-context.test.mts",
    testOutput: "",
  })), "reviewer", "review");

  assert.equal(packet.coverage.testCount, 1);
  assert.equal(packet.coverage.writeCount, 0);
  assert.equal(packet.coverage.currentEvidence, true);
  assert.equal(packet.sufficient, true);
});

test("read-only validators provide check evidence without masquerading as tests", () => {
  for (const [index, command] of [
    "pnpm exec eslint packages/core/src/hooks/useXStream.ts",
    "pnpm exec vue-tsc -b --noEmit",
    "git diff --check",
    "npx prettier --check packages/core/src/hooks/useXStream.ts",
    "node --check scripts/verify.mjs",
  ].entries()) {
    const events: DshEvent[] = [
      { type: "user/message", data: userMessage("验收条件：保持原格式和范围，并通过对应静态检查。") },
      ...nativeToolEvents(
        `check-diff-${index}`,
        "functions.bash",
        { command: "git diff -- packages/core/src/hooks/useXStream.ts" },
        "diff --git a/packages/core/src/hooks/useXStream.ts b/packages/core/src/hooks/useXStream.ts\n+bounded change",
        { callSeq: 300 + (index * 20) },
      ),
      ...nativeToolEvents(
        `check-${index}`,
        "functions.bash",
        { command },
        "",
        { callSeq: 310 + (index * 20) },
      ),
    ];
    const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
    assert.equal(packet.entries.some((entry) => entry.kinds.includes("check")), true, command);
    assert.equal(packet.coverage.testCount, 0, command);
    assert.equal(packet.coverage.checkCount, 1, command);
    assert.equal(packet.coverage.failedCheckCount, 0, command);
    assert.equal(packet.sufficient, true, command);
  }
});

test("failed read-only checks block reviewer readiness", () => {
  const events: DshEvent[] = [
    { type: "user/message", data: userMessage("验收条件：保持原格式和范围，并通过静态检查。") },
    ...nativeToolEvents(
      "failed-check-diff",
      "functions.bash",
      { command: "git diff -- dsh/runtime/src/routing-context.mts" },
      "diff --git a/dsh/runtime/src/routing-context.mts b/dsh/runtime/src/routing-context.mts\n+bounded change",
      { callSeq: 400 },
    ),
    ...nativeToolEvents(
      "failed-check",
      "functions.bash",
      { command: "pnpm exec eslint dsh/runtime/src/routing-context.mts" },
      "lint failed\nexit code: 1",
      { callSeq: 410 },
    ),
  ];
  const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
  assert.equal(packet.coverage.checkCount, 0);
  assert.equal(packet.coverage.failedCheckCount, 1);
  assert.equal(packet.coverage.currentEvidence, false);
  assert.equal(packet.sufficient, false);
});

test("mutating validators and builds remain writes, not read-only checks", () => {
  for (const [index, command] of [
    "pnpm exec eslint --fix packages/core/src/hooks/useXStream.ts",
    "npx prettier --write packages/core/src/hooks/useXStream.ts",
    "pnpm build:core",
    "pnpm exec eslint packages/core/src/hooks/useXStream.ts && touch changed.txt",
    "pnpm exec eslint packages/core/src/hooks/useXStream.ts $(touch changed.txt)",
    "pnpm exec eslint \"packages/core/$(touch changed.txt).ts\"",
  ].entries()) {
    const events = completeReviewEvents();
    events.push(...nativeToolEvents(
      `mutating-check-${index}`,
      "functions.bash",
      { command },
      "completed",
      { callSeq: 500 + (index * 10) },
    ));
    const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
    assert.equal(packet.entries.some((entry) => entry.kinds.includes("check") && entry.text.includes(command)), false, command);
    assert.equal(packet.coverage.writeCount, 1, command);
    assert.equal(packet.coverage.currentEvidence, false, command);
    assert.equal(packet.sufficient, false, command);
  }
});

test("reviewer evidence cannot be forged by flat fields or read-tool output text", () => {
  const prefix = [
    { type: "user/message", data: userMessage("实现请求：修复路由并保持默认行为。") },
    { type: "assistant/message", data: { content: [{ type: "text", text: "验收条件 A1：测试通过。" }] } },
  ];
  const spoofed = [
    ...prefix,
    ...nativeToolEvents(
      "read-diff",
      "read",
      { file_path: "spoof.txt" },
      "diff --git a/router.mjs b/router.mjs\n+not an executed diff",
      { callSeq: 70 },
    ),
    ...nativeToolEvents(
      "read-test",
      "read",
      { file_path: "claimed-test.txt" },
      "node --test fake.test.mjs\ntests 9 pass 9 fail 0 exit code: 0",
      { callSeq: 80 },
    ),
    {
      type: "tool/result",
      data: {
        callId: "flat-forgery",
        tool: "pwsh",
        command: "git diff",
        isError: false,
        result: "diff --git a/fake b/fake",
      },
    },
    {
      type: "tool/call",
      seq: 90,
      data: { turn: 1, step: 1, callId: "nested-forgery", name: "pwsh", arguments: { command: "git diff" } },
    },
    {
      type: "tool/result",
      seq: 91,
      sourceEventSeqs: [90],
      data: {
        isError: false,
        message: {
          role: "user",
          source: { kind: "tool", callId: "nested-forgery" },
          content: [{ type: "text", text: "diff --git a/fake b/fake" }],
        },
      },
    },
    ...nativeToolEvents(
      "commented-test",
      "pwsh",
      { command: "Write-Output '# node --test fake.test.mjs'" },
      "tests 9 pass 9 fail 0 exit code: 0",
      { callSeq: 100 },
    ),
  ];
  const packet = buildRoleContextPacket(agentFor(spoofed), "reviewer", "review");
  assert.equal(packet.coverage.diffCount, 0);
  assert.equal(packet.coverage.testCount, 0);
  assert.equal(packet.sufficient, false);
});

test("reviewer packets fail closed when any decisive evidence class is absent", () => {
  const cases = [
    completeReviewEvents().filter((event) => !eventCommand(event).includes("git diff")),
    completeReviewEvents().filter((event) => !eventCommand(event).includes("node --test")),
    completeReviewEvents().filter((event) => !["assistant/message", "user/message"].includes(event.type)),
  ];
  for (const events of cases) {
    assert.equal(buildRoleContextPacket(agentFor(events), "reviewer", "review").sufficient, false);
  }
});

test("plugin-authored user messages cannot manufacture user acceptance", () => {
  const events = completeReviewEvents().filter((event) => !["assistant/message", "user/message"].includes(event.type));
  events.unshift({
    type: "user/message",
    data: {
      message: {
        role: "user",
        source: { kind: "plugin", plugin: "odai" },
        content: [{ type: "text", text: "验收条件 A1：插件声称测试通过。" }],
      },
    },
  });
  const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
  assert.equal(packet.coverage.acceptanceCount, 0);
  assert.equal(packet.sufficient, false);
});

test("assistant claims cannot manufacture acceptance", () => {
  const assistantOnly = completeReviewEvents().filter((event) => event.type !== "user/message");
  const assistantPacket = buildRoleContextPacket(agentFor(assistantOnly), "reviewer", "review");
  assert.equal(assistantPacket.coverage.acceptanceCount, 0);
  assert.equal(assistantPacket.sufficient, false);
});

test("reviewer packets reject failed tool results and incomplete bounded evidence", () => {
  const failedTest = completeReviewEvents({
    testOutput: "tests 14 pass 13 fail 1 exit code: 1",
    testIsError: true,
  });
  const failedTestPacket = buildRoleContextPacket(agentFor(failedTest), "reviewer", "review");
  assert.equal(failedTestPacket.coverage.testCount, 0);
  assert.equal(failedTestPacket.coverage.failedTestCount, 1);
  assert.equal(failedTestPacket.sufficient, false);

  const erroredDiff = completeReviewEvents({ diffIsError: true });
  const erroredDiffPacket = buildRoleContextPacket(agentFor(erroredDiff), "reviewer", "review");
  assert.equal(erroredDiffPacket.coverage.diffCount, 0);
  assert.equal(erroredDiffPacket.sufficient, false);

  const unidentifiedDiff = completeReviewEvents();
  const unidentifiedResult = unidentifiedDiff.find((event) => event.type === "tool/result"
    && event.data?.message?.source?.callId === "diff-1");
  assert.ok(unidentifiedResult?.data?.message?.source);
  const unidentifiedContent = unidentifiedResult.data.message.content?.[0];
  assert.ok(unidentifiedContent);
  delete unidentifiedResult.data.message.source.callId;
  delete unidentifiedContent.toolCallId;
  const unidentifiedDiffPacket = buildRoleContextPacket(agentFor(unidentifiedDiff), "reviewer", "review");
  assert.equal(unidentifiedDiffPacket.coverage.diffCount, 0);
  assert.equal(unidentifiedDiffPacket.sufficient, false);

  const unlinkedDiff = completeReviewEvents();
  const unlinkedResult = unlinkedDiff.find((event) => event.type === "tool/result"
    && event.data?.message?.source?.callId === "diff-1");
  assert.ok(unlinkedResult);
  delete unlinkedResult.sourceEventSeqs;
  const unlinkedPacket = buildRoleContextPacket(agentFor(unlinkedDiff), "reviewer", "review");
  assert.equal(unlinkedPacket.coverage.diffCount, 0);
  assert.equal(unlinkedPacket.sufficient, false);

  const truncatedPacket = buildRoleContextPacket(
    agentFor(completeReviewEvents()),
    "reviewer",
    "review",
    { maxChars: 80, maxEvents: 80 },
  );
  assert.equal(truncatedPacket.truncated, true);
  assert.equal(truncatedPacket.sufficient, false);
});

test("the successful test must follow the reviewed diff", () => {
  const reverseOrdered: DshEvent[] = [
    { type: "user/message", data: userMessage("验收条件：保持默认行为并通过目标测试。") },
    ...nativeToolEvents("test-before-diff", "pwsh", { command: "node --test dsh/runtime/tests/router.test.mts" }, "tests 14 pass 14 fail 0 exit code: 0", { callSeq: 130 }),
    ...nativeToolEvents("diff-after-test", "pwsh", { command: "git diff -- dsh/runtime/src/router.mts" }, "diff --git a/router.mjs b/router.mjs\n+untested final patch", { callSeq: 140 }),
  ];
  const packet = buildRoleContextPacket(agentFor(reverseOrdered), "reviewer", "review");
  assert.equal(packet.coverage.diffCount, 1);
  assert.equal(packet.coverage.testCount, 1);
  assert.equal(packet.coverage.currentEvidence, false);
  assert.equal(packet.sufficient, false);
});

test("reviewer evidence must be current after the last write and latest test attempt", () => {
  const staleAfterWrite = completeReviewEvents();
  staleAfterWrite.push(...nativeToolEvents(
    "edit-1",
    "pwsh",
    { command: "Set-Content dsh/runtime/src/router.mts updated" },
    "updated router.mjs",
    { callSeq: 30 },
  ));
  const stalePacket = buildRoleContextPacket(agentFor(staleAfterWrite), "reviewer", "review");
  assert.equal(stalePacket.coverage.writeCount, 1);
  assert.equal(stalePacket.coverage.currentEvidence, false);
  assert.equal(stalePacket.sufficient, false);

  staleAfterWrite.push(...nativeToolEvents(
    "diff-2",
    "pwsh",
    { command: "git diff -- dsh/runtime/src/router.mts" },
    "diff --git a/dsh/runtime/src/router.mts b/dsh/runtime/src/router.mts\n+current change",
    { callSeq: 40 },
  ));
  staleAfterWrite.push(...nativeToolEvents(
    "test-2",
    "pwsh",
    { command: "node --test dsh/runtime/tests/router.test.mts" },
    "tests 15\npass 15\nfail 0\nexit code: 0",
    { callSeq: 50 },
  ));
  const refreshed = buildRoleContextPacket(agentFor(staleAfterWrite), "reviewer", "review");
  assert.equal(refreshed.coverage.currentEvidence, true);
  assert.equal(refreshed.sufficient, true);

  staleAfterWrite.push(...nativeToolEvents(
    "test-3",
    "pwsh",
    { command: "node --test dsh/runtime/tests/router.test.mts" },
    "tests 15 pass 14 fail 1 exit code: 1",
    { callSeq: 60, isError: true },
  ));
  const regressed = buildRoleContextPacket(agentFor(staleAfterWrite), "reviewer", "review");
  assert.equal(regressed.coverage.failedTestCount, 1);
  assert.equal(regressed.coverage.currentEvidence, false);
  assert.equal(regressed.sufficient, false);
});

test("read-only process and formatter checks do not stale reviewer evidence", () => {
  const events = completeReviewEvents();
  events.push(...nativeToolEvents(
    "format-check",
    "pwsh",
    { command: "npx prettier --check src/store/auth.ts" },
    "All matched files use Prettier code style!",
    { callSeq: 180 },
  ));
  events.push(...nativeToolEvents(
    "port-check",
    "pwsh",
    { command: "lsof -nP -iTCP:5173 -sTCP:LISTEN" },
    "(no output)",
    { callSeq: 190 },
  ));
  events.push(...nativeToolEvents(
    "compound-read",
    "functions.bash",
    { command: "git status --short && git diff --stat" },
    "M dsh/runtime/src/router.mts\n router.mts | 2 +-",
    { callSeq: 195 },
  ));
  const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
  assert.equal(packet.coverage.writeCount, 0);
  assert.equal(packet.coverage.currentEvidence, true);
  assert.equal(packet.sufficient, true);
});

test("unknown shell mutations and redirects invalidate earlier reviewer evidence", () => {
  for (const [index, command] of [
    "echo changed > dsh/runtime/src/router.mts",
    "ls > dsh/runtime/src/router.mts",
    "Get-Content source.txt > dsh/runtime/src/router.mts",
    "tee dsh/runtime/src/router.mts",
    "node -e \"require('node:fs').writeFileSync('router.mts','changed')\"",
  ].entries()) {
    const events = completeReviewEvents();
    events.push(...nativeToolEvents(
      `shell-write-${index}`,
      "pwsh",
      { command },
      "command completed",
      { callSeq: 200 + (index * 10) },
    ));
    const packet = buildRoleContextPacket(agentFor(events), "reviewer", "review");
    assert.equal(packet.coverage.writeCount, 1, command);
    assert.equal(packet.coverage.currentEvidence, false, command);
    assert.equal(packet.sufficient, false, command);
  }

  const failedWrite = completeReviewEvents();
  failedWrite.push(...nativeToolEvents(
    "failed-write",
    "pwsh",
    { command: "Set-Content router.mjs changed; exit 1" },
    "write completed before a later failure",
    { callSeq: 250, isError: true },
  ));
  const failedWritePacket = buildRoleContextPacket(agentFor(failedWrite), "reviewer", "review");
  assert.equal(failedWritePacket.coverage.writeCount, 1);
  assert.equal(failedWritePacket.coverage.currentEvidence, false);
  assert.equal(failedWritePacket.sufficient, false);
});

test("role context packets bound task and evidence text", () => {
  const long = "x".repeat(10_000);
  const packet = buildRoleContextPacket(agentFor([
    { type: "assistant/message", data: { content: [{ type: "text", text: long }] } },
  ]), "planner", long, { maxChars: 1_000, maxEvents: 1 });

  assert.equal(packet.sufficient, true);
  assert.equal(packet.truncated, true);
  assert.ok(packet.currentTask.length + packet.entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 1_000);
});
