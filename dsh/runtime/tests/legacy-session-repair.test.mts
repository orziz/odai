import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  inspectLegacySessionLogs,
  repairLegacySessionLogs,
} from "../build/legacy-session-repair.mjs";
import {
  createSessionEvidence,
  readStoredSessionEvidence,
} from "../build/session-evidence.mjs";
import { isUnknownRecord } from "../build/runtime-types.mjs";
import type { DshAgent, DshEvent, RuntimeEventData, UnknownRecord } from "../build/runtime-types.mjs";

const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const noDshProcesses = (): never[] => [];

function parseRecord(text: string): UnknownRecord {
  const value: unknown = JSON.parse(text);
  if (!isUnknownRecord(value)) throw new TypeError("expected a JSON object");
  return value;
}

function testAgent(id: string, events: DshEvent[] = []): DshAgent {
  return { session: { header: { id }, snapshotEvents: () => events, append() {} } };
}

function event(type: string, seq: number, data: RuntimeEventData, extra: UnknownRecord = {}): string {
  return JSON.stringify({ type, seq, time: 1_700_000_000_000 + seq, data, ...extra });
}

function sessionHeader(id: string): string {
  return JSON.stringify({
    type: "session",
    version: 0,
    id,
    createdAt: 1_700_000_000_000,
    delegationDepth: 0,
  });
}

test("legacy plain and multi-frame Zstandard logs mark every known Odai audit event ignorable", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-legacy-repair-"));
  const sessions = resolve(scratch, "sessions");
  const plainPath = resolve(sessions, "plain", "session.jsonl");
  const zstdPath = resolve(sessions, "zstd", "session.jsonl.zstd");
  try {
    mkdirSync(resolve(sessions, "plain"), { recursive: true });
    mkdirSync(resolve(sessions, "zstd"), { recursive: true });
    writeFileSync(plainPath, [
      sessionHeader("plain-session"),
      event("request/context", 0, { provider: "p", model: "m" }),
      event("odai/governance-denied", 1, { callId: "denied" }),
      event("odai/tool-observed", 2, { callId: "observed" }),
      event("odai/routing-configured", 3, { responsibility: "reviewer" }),
      event("odai/route-protection", 4, { turn: 1, step: 1 }),
      "",
    ].join("\n"));

    const headerFrame = zstdCompressSync(Buffer.from(`${sessionHeader("zstd-session")}\n`), ZSTD_OPTIONS);
    const firstEventFrame = zstdCompressSync(Buffer.from([
      event("odai/route-decided", 0, { turn: 1, step: 1 }),
      event("request/context", 1, { provider: "p", model: "m" }),
      event("odai/route-config-missing", 2, { responsibility: "planner" }),
      "",
    ].join("\n")), ZSTD_OPTIONS);
    const secondEventFrame = zstdCompressSync(Buffer.from([
      event("odai/route-upgrade", 3, { turn: 1, step: 1 }),
      event("odai/route-result", 4, { status: "completed" }),
      event("odai/research-decided", 5, { role: "researcher" }),
      event("odai/research-result", 6, { status: "completed" }),
      "",
    ].join("\n")), ZSTD_OPTIONS);
    writeFileSync(zstdPath, Buffer.concat([headerFrame, firstEventFrame, secondEventFrame]));

    const repaired = repairLegacySessionLogs({ dshHome: scratch, confirmDshStopped: true, processScanner: noDshProcesses });
    assert.equal(repaired.failures.length, 0);
    assert.equal(repaired.repairedArtifacts, 2);
    assert.equal(repaired.repairedEvents, 10);
    assert.equal(repaired.backupPaths.length, 2);
    assert.ok(repaired.backupPaths.every((path) => readFileSync(path).length > 0));

    const plain = readFileSync(plainPath, "utf8").trim().split("\n").map(parseRecord);
    assert.equal(plain[1].ignorable, undefined);
    assert.deepEqual(plain.slice(2).map((record) => record.ignorable), [true, true, true, true]);

    const compressed = readFileSync(zstdPath);
    const frames = scanFrames(compressed);
    assert.equal(frames.length, 3);
    assert.deepEqual(compressed.subarray(frames[0].start, frames[0].end), headerFrame);
    const zstdEvents = frames.slice(1).flatMap((frame) => zstdDecompressSync(
      compressed.subarray(frame.start, frame.end),
    ).toString("utf8").trim().split("\n").map(parseRecord));
    assert.deepEqual(zstdEvents.map((record) => record.ignorable), [true, undefined, true, true, true, true, true]);

    const repeated = repairLegacySessionLogs({ dshHome: scratch, confirmDshStopped: true, processScanner: noDshProcesses });
    assert.equal(repeated.failures.length, 0);
    assert.equal(repeated.repairedArtifacts, 0);
    assert.equal(repeated.repairedEvents, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("repair refuses an unknown unmarked Odai event without rewriting its artifact", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-session-unknown-"));
  const path = resolve(scratch, "sessions/project/session/session.jsonl");
  try {
    mkdirSync(resolve(path, ".."), { recursive: true });
    const original = `${sessionHeader("unknown-session")}\n${event("odai/future-semantic-event", 0, { required: true })}\n`;
    writeFileSync(path, original);
    const repaired = repairLegacySessionLogs({ dshHome: scratch, confirmDshStopped: true, processScanner: noDshProcesses });
    assert.equal(repaired.repairedEvents, 0);
    assert.equal(repaired.backupPaths.length, 0);
    assert.equal(repaired.failures.length, 1);
    assert.match(repaired.failures[0].error, /refusing unknown Odai session event type/u);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("repair requires explicit stop confirmation and reports candidates without writing", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-session-inspect-"));
  const path = resolve(scratch, "sessions/project/session/session.jsonl");
  try {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, `${sessionHeader("inspect-session")}\n${event("odai/route-decided", 0, { turn: 1, step: 1 })}\n`);
    const inspected = inspectLegacySessionLogs({ dshHome: scratch });
    assert.equal(inspected.matchedEvents, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8").trim().split("\n")[1]).ignorable, undefined);
    assert.throws(
      () => repairLegacySessionLogs({ dshHome: scratch }),
      /confirmDshStopped is true/u,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("repair refuses an active DSH process even after explicit confirmation", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-session-active-dsh-"));
  const path = resolve(scratch, "sessions/project/session/session.jsonl");
  try {
    mkdirSync(resolve(path, ".."), { recursive: true });
    const original = `${sessionHeader("active-dsh-session")}\n${event("odai/route-decided", 0, { turn: 1, step: 1 })}\n`;
    writeFileSync(path, original);
    assert.throws(
      () => repairLegacySessionLogs({
        dshHome: scratch,
        confirmDshStopped: true,
        processScanner: () => [{ pid: 1234, name: "node" }],
      }),
      /while DSH is running.*pid 1234/u,
    );
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("repair preserves torn tails and refuses malformed committed records", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-session-torn-"));
  const plainPath = resolve(scratch, "sessions/plain/session.jsonl");
  const zstdPath = resolve(scratch, "sessions/zstd/session.jsonl.zstd");
  const malformedPath = resolve(scratch, "sessions/malformed/session.jsonl");
  try {
    for (const path of [plainPath, zstdPath, malformedPath]) mkdirSync(resolve(path, ".."), { recursive: true });
    const plainTail = "{\"type\":\"assistant/chunk\"";
    writeFileSync(plainPath, `${sessionHeader("plain-torn")}\n${event("odai/route-decided", 0, { turn: 1, step: 1 })}\n${plainTail}`);

    const headerFrame = zstdCompressSync(Buffer.from(`${sessionHeader("zstd-torn")}\n`), ZSTD_OPTIONS);
    const eventFrame = zstdCompressSync(Buffer.from(`${event("odai/route-decided", 0, { turn: 1, step: 1 })}\n`), ZSTD_OPTIONS);
    const tornFrame = zstdCompressSync(Buffer.from(`${event("request/context", 1, { provider: "p", model: "m" })}\n`), ZSTD_OPTIONS).subarray(0, 8);
    writeFileSync(zstdPath, Buffer.concat([headerFrame, eventFrame, tornFrame]));

    const malformed = `${sessionHeader("malformed")}\n${event("odai/route-decided", 0, { turn: 1, step: 1 })}\n{bad json}\n`;
    writeFileSync(malformedPath, malformed);
    const repaired = repairLegacySessionLogs({ dshHome: scratch, confirmDshStopped: true, processScanner: noDshProcesses });

    assert.equal(repaired.repairedArtifacts, 2);
    assert.deepEqual(repaired.tornArtifacts.sort(), [plainPath, zstdPath].sort());
    assert.equal(readFileSync(plainPath, "utf8").endsWith(plainTail), true);
    assert.equal(readFileSync(zstdPath).subarray(-tornFrame.length).equals(tornFrame), true);
    assert.equal(readFileSync(malformedPath, "utf8"), malformed);
    assert.equal(repaired.failures.some((failure) => failure.path === malformedPath), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("new evidence stays outside a real DSH session log and reloads by session id", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-session-evidence-"));
  const warnings: string[] = [];
  const logger = { warn(message: string) { warnings.push(message); } };
  let sessionAppends = 0;
  const firstAgent = {
    session: {
      header: { id: "session-with-durable-evidence" },
      snapshotEvents: () => [],
      append() { sessionAppends += 1; },
    },
  };
  try {
    const first = createSessionEvidence({ root: scratch, logger });
    first.append(firstAgent, "odai/route-decided", { turn: 1, step: 1 });
    assert.equal(sessionAppends, 0);
    assert.equal(first.has(firstAgent, "odai/route-decided", (data) => data.turn === 1), true);

    const secondAgent = {
      session: {
        header: { id: "session-with-durable-evidence" },
        snapshotEvents: () => [{ type: "odai/route-decided", data: { turn: 1, step: 1 } }],
        append() {},
      },
    };
    const second = createSessionEvidence({ root: scratch, logger });
    assert.equal(second.has(secondAgent, "odai/route-decided", (data) => data.step === 1), true);
    second.append(secondAgent, "odai/route-decided", { step: 1, turn: 1 });
    assert.equal(readStoredSessionEvidence(scratch, "session-with-durable-evidence", logger).length, 1);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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
      /being updated by another runtime/u,
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

test("an acquisition claim is never reclaimed automatically", () => {
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

test("transient probes without a session id retain the in-memory append fallback", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "odai-transient-evidence-"));
  const events: DshEvent[] = [];
  const agent: DshAgent = {
    session: {
      header: {},
      snapshotEvents: () => events,
      append(type: string, data: RuntimeEventData) { events.push({ type, data }); },
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

function scanFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    assert.equal(buffer.readUInt32LE(offset), 4247762216);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    offset += (singleSegment ? 0 : 1)
      + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag);
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}
