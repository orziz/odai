import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSessionEvidence, readStoredSessionEvidence } from "../build/session-evidence.mjs";
import { activeRouteProtection } from "../build/governance.mjs";
function testAgent(id, events = []) {
  return { session: { header: { id }, snapshotEvents: () => events, append() {} } };
}
test("new evidence stays outside a real DSH session log and reloads by session id", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-session-evidence-"));
  const warnings = [];
  const logger = {
    warn(message) {
      warnings.push(message);
    },
  };
  let sessionAppends = 0;
  const firstAgent = {
    session: {
      header: { id: "session-with-durable-evidence" },
      snapshotEvents: () => [],
      append() {
        sessionAppends += 1;
      },
    },
  };
  try {
    const first = createSessionEvidence({ root: scratch, logger });
    first.append(firstAgent, "odai/route-decided", { turn: 1, step: 1 });
    assert.equal(sessionAppends, 0);
    assert.equal(
      first.has(firstAgent, "odai/route-decided", (data) => data.turn === 1),
      true,
    );
    const secondAgent = {
      session: {
        header: { id: "session-with-durable-evidence" },
        snapshotEvents: () => [{ type: "odai/route-decided", data: { turn: 1, step: 1 } }],
        append() {},
      },
    };
    const second = createSessionEvidence({ root: scratch, logger });
    assert.equal(
      second.has(secondAgent, "odai/route-decided", (data) => data.step === 1),
      true,
    );
    second.append(secondAgent, "odai/route-decided", { step: 1, turn: 1 });
    assert.equal(readStoredSessionEvidence(scratch, "session-with-durable-evidence", logger).length, 1);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("legacy sidecar reload preserves active scopes but cannot revive released protection through route failure", () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-protection-identity-"));
  const sessionId = "protection-transition";
  const legacyId = createHash("sha256").update("odai/route-protection:1:1").digest("hex");
  try {
    const path = resolve(root, `${createHash("sha256").update(sessionId).digest("hex")}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId,
        id: legacyId,
        time: 1,
        type: "odai/route-protection",
        data: { turn: 1, step: 1, mode: "read-only", scopeId: "scope", source: "responsibility-scope-planner" },
      })}\n`,
    );
    const evidence = createSessionEvidence({ root });
    const agent = testAgent(sessionId, [{ type: "turn/start", data: { turn: 1 } }]);
    evidence.append(agent, "odai/route-decided", { turn: 1, step: 1 });
    const reloadProtection = () => {
      const resumed = testAgent(sessionId, [{ type: "turn/start", data: { turn: 1 } }]);
      return activeRouteProtection(resumed, createSessionEvidence({ root }).events(resumed));
    };
    assert.equal(reloadProtection()?.scopeId, "scope", "an active read-only scope must survive sidecar reload");
    evidence.append(agent, "odai/route-protection-released", {
      turn: 1,
      scopeId: "scope",
      reason: "route-request-failed",
    });
    assert.equal(reloadProtection(), undefined);
    const protection = {
      turn: 1,
      step: 1,
      mode: "read-only",
      source: "route-request-failure",
      reasonCode: "PLANNER_EVIDENCE_STATE_GAP",
    };
    evidence.append(agent, "odai/route-protection", protection);
    evidence.append(agent, "odai/route-protection", { ...protection });
    const stored = readStoredSessionEvidence(root, sessionId);
    assert.equal(stored.length, 4);
    assert.equal(stored[0].id, legacyId);
    assert.deepEqual(stored[3].data, protection, "historical failure evidence remains intact");
    assert.equal(
      reloadProtection(),
      undefined,
      "a historical route failure cannot reinstate released write protection",
    );
    assert.deepEqual(readStoredSessionEvidence(root, sessionId), stored, "reload must not rewrite historical evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a durable evidence write failure does not create process-only evidence", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-evidence-failure-"));
  const blockedRoot = resolve(scratch, "not-a-directory");
  const agent = testAgent("failed-evidence");
  try {
    writeFileSync(blockedRoot, "file");
    const evidence = createSessionEvidence({ root: blockedRoot });
    assert.throws(
      () => evidence.append(agent, "odai/route-decided", { turn: 1, step: 1 }),
      /EEXIST|ENOENT|not a directory|not-a-directory/iu,
    );
    assert.equal(evidence.has(agent, "odai/route-decided"), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("a live evidence lock is never reclaimed from age alone", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-evidence-live-lock-"));
  const sessionId = "live-lock-session";
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const lockPath = resolve(scratch, `${digest}.jsonl.lock`);
  const owner = `${process.pid}:still-live\n`;
  const agent = testAgent(sessionId);
  try {
    writeFileSync(lockPath, owner, "utf8");
    const old = new Date(0);
    utimesSync(lockPath, old, old);
    const evidence = createSessionEvidence({ root: scratch });
    assert.throws(
      () => evidence.append(agent, "odai/route-decided", { turn: 1, step: 1 }),
      /odai evidence is being updated/u,
    );
    assert.equal(readFileSync(lockPath, "utf8"), owner);
    assert.equal(evidence.has(agent, "odai/route-decided"), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("a dead evidence owner is reclaimed only while holding the acquisition claim", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-evidence-dead-lock-"));
  const sessionId = "dead-lock-session";
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const lockPath = resolve(scratch, `${digest}.jsonl.lock`);
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.equal(child.status, 0);
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  const agent = testAgent(sessionId);
  try {
    writeFileSync(lockPath, `${child.pid}:dead-owner\n`, "utf8");
    const evidence = createSessionEvidence({ root: scratch });
    evidence.append(agent, "odai/route-decided", { turn: 1, step: 1 });
    assert.equal(readStoredSessionEvidence(scratch, sessionId).length, 1);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(`${lockPath}.claim`), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("a live acquisition claim is never reclaimed automatically", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-evidence-claim-lock-"));
  const sessionId = "claim-lock-session";
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const claimPath = resolve(scratch, `${digest}.jsonl.lock.claim`);
  const claim = `${process.pid}:active-claim\n`;
  const agent = testAgent(sessionId);
  try {
    writeFileSync(claimPath, claim, "utf8");
    const old = new Date(0);
    utimesSync(claimPath, old, old);
    const evidence = createSessionEvidence({ root: scratch });
    assert.throws(
      () => evidence.append(agent, "odai/route-decided", { turn: 1, step: 1 }),
      /lock acquisition is already in progress/u,
    );
    assert.equal(readFileSync(claimPath, "utf8"), claim);
    assert.equal(evidence.has(agent, "odai/route-decided"), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("a dead acquisition claim is reclaimed before evidence append", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-evidence-dead-claim-"));
  const sessionId = "dead-claim-session";
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const claimPath = resolve(scratch, `${digest}.jsonl.lock.claim`);
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.equal(child.status, 0);
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  const agent = testAgent(sessionId);
  try {
    writeFileSync(claimPath, `${child.pid}:dead-claim\n`, "utf8");
    const evidence = createSessionEvidence({ root: scratch });
    evidence.append(agent, "odai/route-decided", { turn: 1, step: 1 });
    assert.equal(readStoredSessionEvidence(scratch, sessionId).length, 1);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("transient probes without a session id retain the in-memory append fallback", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-transient-evidence-"));
  const events = [];
  const agent = {
    session: {
      header: {},
      snapshotEvents: () => events,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
  try {
    const evidence = createSessionEvidence({ root: scratch });
    evidence.append(agent, "odai/route-decided", { turn: 1, step: 1 });
    assert.equal(events.length, 1);
    assert.equal(evidence.has(agent, "odai/route-decided"), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
