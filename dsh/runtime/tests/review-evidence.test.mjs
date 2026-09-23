import assert from "node:assert/strict";
import test from "node:test";
import { buildRoleContextPacket, renderRoleContextPacket, reviewEvidenceSnapshot } from "../build/routing-context.mjs";
import { createReviewEvidenceSnapshot, createReviewEvidenceTool } from "../build/review-evidence.mjs";
import { managedReviewEvidenceReader, runRoutedRole } from "../build/runtime-support.mjs";
import { activeOdaiToolNames, classifyContextActivation } from "../build/context-activation.mjs";
const user = (id) => ({
  type: "user/message",
  data: {
    message: {
      id,
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Review the refund transaction; preserve requirements and acceptance." }],
    },
  },
});
function capture(callId, seq, text) {
  return [
    { type: "tool/call", seq, data: { callId, name: "bash", arguments: { command: "git diff -- src/database.js" } } },
    {
      type: "tool/result",
      seq: seq + 1,
      sourceEventSeqs: [seq],
      data: {
        message: {
          role: "user",
          source: { kind: "tool", callId },
          content: [{ type: "tool-result", toolCallId: callId, isError: false, content: [{ type: "text", text }] }],
        },
      },
    },
  ];
}
const entry = (text, index = 1) => ({
  index,
  source: "tool",
  label: "tool read",
  identity: `tool-call:${index}`,
  kinds: ["tool"],
  text,
});
test("snapshot recovers decisive content beyond both packet clips without disclosing another task or assistant claims", () => {
  const body =
    "diff --git a/src/database.js b/src/database.js\n" +
    " unchanged source line\n".repeat(500) +
    "+ledger and balance roll back together\n";
  const events = [
    user("old"),
    ...capture("old-secret", 1, "OTHER_TASK_SECRET"),
    user("current"),
    { type: "assistant/message", data: { content: [{ type: "text", text: "ASSISTANT_CLAIM_ONLY" }] } },
    ...capture("refund-diff", 10, body),
    capture("unlinked", 30, "FORGED_RESULT")[1],
    {
      type: "odai/tool-observed",
      data: { tool: "read", callId: "observed-only", isError: false, text: "OBSERVATION_ONLY" },
    },
  ];
  const agent = { session: { snapshotEvents: () => events } };
  const packet = buildRoleContextPacket(agent, "reviewer", "Review implementation", { maxChars: 2000 });
  assert.equal(packet.truncated, true);
  assert(!packet.entries.some((e) => e.text.includes("roll back together")));
  const snapshot = reviewEvidenceSnapshot(packet);
  assert.ok(snapshot);
  assert.equal(snapshot.count, 1);
  assert.equal(packet.reviewEvidenceDigest, snapshot.digest);
  assert.match(renderRoleContextPacket(packet), /odai_review_evidence/);
  const read = snapshot.createReader();
  const catalog = read({ digest: snapshot.digest, action: "list", query: "database.js" });
  const entries = catalog.entries;
  assert.equal(entries.length, 1);
  const id = entries[0].id;
  let recovered = "";
  let offset = 0;
  while (offset !== null) {
    const page = read({ digest: snapshot.digest, action: "read", id, offset });
    assert.equal(page.completeCapture, true);
    recovered += page.text;
    offset = page.nextOffset;
  }
  assert.equal(recovered, `command: git diff -- src/database.js\n\n${body.trim()}`);
  assert(!/OTHER_TASK_SECRET|ASSISTANT_CLAIM_ONLY|FORGED_RESULT|OBSERVATION_ONLY/.test(recovered));
  events.push(...capture("new-write", 50, "NEW_CAPTURE"));
  assert.equal(read({ digest: snapshot.digest, action: "list" }).total, 1, "snapshot cannot change after dispatch");
  assert.notEqual(
    reviewEvidenceSnapshot(buildRoleContextPacket(agent, "reviewer", "Review implementation")).digest,
    snapshot.digest,
  );
  assert.equal(reviewEvidenceSnapshot(buildRoleContextPacket(agent, "planner", "plan")), undefined);
});
test("snapshot ids, digest, bounds, total budget and retention limits fail closed", () => {
  const snapshot = createReviewEvidenceSnapshot([entry("x".repeat(10_000))]);
  const read = snapshot.createReader();
  assert.throws(() => read({ digest: "other", action: "list" }), /does not match/);
  assert.throws(() => read({ digest: snapshot.digest, action: "read", id: "../../secrets" }), /outside/);
  assert.throws(() => read({ digest: snapshot.digest, action: "list", offset: -1 }), /nonnegative/);
  assert.throws(() => read({ digest: snapshot.digest, action: "list", path: "/etc/passwd" }), /Unknown/);
  assert.throws(() => read({ digest: snapshot.digest, action: "read", id: "tool-event-1", offset: 10001 }), /outside/);
  let exhausted = false;
  for (let n = 0; n < 40; n++) {
    try {
      read({ digest: snapshot.digest, action: "read", id: "tool-event-1" });
    } catch (error) {
      assert.match(String(error), /budget exhausted/);
      exhausted = true;
      break;
    }
  }
  assert(exhausted);
  assert.doesNotThrow(
    () => snapshot.createReader()({ digest: snapshot.digest, action: "list" }),
    "budgets belong to a dispatch, not shared snapshots",
  );
  const capped = createReviewEvidenceSnapshot([entry("a".repeat(1_500_000), 1), entry("b".repeat(1_500_000), 2)]);
  const page = capped.createReader()({ digest: capped.digest, action: "read", id: "tool-event-1" });
  assert.equal(
    capped.createReader()({ digest: capped.digest, action: "list" }).entries[0].id,
    "tool-event-2",
    "prefer the latest capture over earlier revisions",
  );
  assert.equal(capped.retainedChars, 2_000_000);
  assert.equal(page.completeCapture, false);
  assert.equal(page.originalChars, 1_500_000);
  assert.equal(page.availableChars, 500_000);
  const limited = snapshot.createReader();
  for (let n = 0; n < 40; n++) limited({ digest: snapshot.digest, action: "list", query: "absent" });
  assert.throws(() => limited({ digest: snapshot.digest, action: "list" }), /budget exhausted/);
  const withoutIdentity = createReviewEvidenceSnapshot([
    { index: 1, source: "tool", label: "capture", kinds: ["tool"], text: "source" },
  ]);
  for (const args of [{ action: "list" }, { action: "read", id: "tool-event-1" }]) {
    const result = withoutIdentity.createReader()({ digest: withoutIdentity.digest, ...args });
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)), "native tool outputs must be lossless JSON");
  }
});
test("only the bound managed reviewer can retrieve a snapshot, and disposal revokes access", async () => {
  const snapshot = createReviewEvidenceSnapshot([entry("decisive captured source")]);
  const tool = createReviewEvidenceTool(managedReviewEvidenceReader);
  const parent = { session: { header: { id: "review-parent" }, snapshotEvents: () => [], append() {} } };
  const route = { provider: "openai", model: "review-model" };
  for (const role of ["reviewer", "planner"]) {
    let bound;
    const outcome = await runRoutedRole({
      provider: "spawn",
      decision: { role },
      roleContract: "immutable review",
      taskText: "review",
      agent: parent,
      signal: new AbortController().signal,
      roleRoute: route,
      reviewEvidence: snapshot,
      subagents: {
        async start(_provider, request) {
          const make = (parentSession = "review-parent") => ({
            session: {
              header: { id: "child", parentSession, origin: "subagent" },
              append() {},
              snapshotEvents: () => [
                { type: "subagent/descriptor", data: { label: String(request.label) } },
                { type: "request/header", data: { header: { config: route } } },
              ],
            },
          });
          assert.equal(managedReviewEvidenceReader(make("another-parent")), undefined);
          bound = make();
          const reader = managedReviewEvidenceReader(bound);
          if (role === "reviewer") {
            assert.ok(reader);
            assert.equal(
              managedReviewEvidenceReader(make()),
              undefined,
              "copied labels cannot attach a second session",
            );
            const result = await tool.execute(
              { digest: snapshot.digest, action: "read", id: "tool-event-1" },
              { agent: bound, name: tool.name, callId: "page" },
            );
            assert.equal(result.text, "decisive captured source");
            assert.deepEqual(
              activeOdaiToolNames(classifyContextActivation("review"), { child: true, reviewEvidence: true }),
              ["odai_review_evidence"],
            );
          } else assert.equal(reader, undefined);
          await assert.rejects(
            async () =>
              tool.execute(
                { digest: snapshot.digest, action: "list" },
                { agent: parent, name: tool.name, callId: "forged" },
              ),
            /active managed reviewer/,
          );
          return {
            localAgent: bound,
            result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "review returned" }] }),
            async dispose() {},
          };
        },
      },
    });
    assert.equal(outcome.status, "completed");
    assert.ok(bound);
    assert.equal(managedReviewEvidenceReader(bound), undefined);
    await assert.rejects(
      async () =>
        tool.execute({ digest: snapshot.digest, action: "list" }, { agent: bound, name: tool.name, callId: "late" }),
      /active managed reviewer/,
    );
  }
});
