import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { DshAgent, RuntimeEventData, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const STORE_SCHEMA_VERSION = 1;
const GLOBAL_STATE_KEY = Symbol.for("odai.dsh.session-evidence.v2");

export interface SessionEvidenceEvent extends UnknownRecord {
  readonly id: string;
  readonly type: string;
  readonly time?: number;
  readonly data: RuntimeEventData;
}

interface EvidenceState {
  events: SessionEvidenceEvent[];
  ids: Set<string>;
  sessionId?: string;
}

interface SessionEvidenceSharedState {
  bySession: WeakMap<object, Map<string, EvidenceState>>;
}

interface SymbolIndexedGlobal {
  [key: symbol]: unknown;
}

interface EvidenceLogger {
  warn(message: string): void;
}

interface StoredEvidenceRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  type: string;
  time: number;
  data: RuntimeEventData;
}

export interface SessionEvidence {
  readonly root: string;
  append(agent: DshAgent, type: string, data: object): SessionEvidenceEvent | undefined;
  events(agent: DshAgent): SessionEvidenceEvent[];
  has(agent: DshAgent, type: string, predicate?: (data: RuntimeEventData) => boolean): boolean;
}

export interface CreateSessionEvidenceOptions {
  root: string;
  logger?: EvidenceLogger;
}

function isSessionEvidenceSharedState(value: unknown): value is SessionEvidenceSharedState {
  return isUnknownRecord(value) && value.bySession instanceof WeakMap;
}

function sharedState(): SessionEvidenceSharedState {
  const root = globalThis as typeof globalThis & SymbolIndexedGlobal;
  const existing = root[GLOBAL_STATE_KEY];
  if (isSessionEvidenceSharedState(existing)) return existing;
  const created: SessionEvidenceSharedState = { bySession: new WeakMap() };
  Object.defineProperty(root, GLOBAL_STATE_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  });
  return created;
}

function isOdaiEvent(event: unknown): event is { type: string; data: RuntimeEventData; id?: string; time?: number } {
  return isUnknownRecord(event)
    && typeof event.type === "string"
    && event.type.startsWith("odai/")
    && isUnknownRecord(event.data);
}

function sessionIdOf(agent: DshAgent | undefined): string | undefined {
  const id = agent?.session?.header?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function evidencePath(root: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return resolve(root, `${key}.jsonl`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isUnknownRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceId(type: string, data: RuntimeEventData): string {
  let identity: string;
  if (Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)) {
    identity = `${type}:${data.turn}:${data.step}`;
  } else if (typeof data?.callId === "string" && data.callId !== "") {
    identity = `${type}:${data.callId}`;
  } else {
    identity = `${type}:${stableJson(data)}`;
  }
  return createHash("sha256").update(identity).digest("hex");
}

function snapshotData(data: object, type: string): RuntimeEventData {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(data);
  } catch (error) {
    throw new Error(`odai evidence ${type} is not JSON-serializable`, { cause: error });
  }
  if (encoded === undefined) throw new Error(`odai evidence ${type} is not JSON-serializable`);
  const snapshot: unknown = JSON.parse(encoded);
  if (!isUnknownRecord(snapshot)) throw new Error(`odai evidence ${type} must be an object`);
  return snapshot;
}

function readCompleteLines(path: string, strict: boolean): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (strict && text !== "" && !text.endsWith("\n")) {
    throw new Error(`odai evidence log has an unterminated final record: ${path}`);
  }
  const completeLength = text.endsWith("\n") ? text.length : text.lastIndexOf("\n") + 1;
  if (completeLength <= 0) return [];
  return text.slice(0, completeLength).split("\n").filter(Boolean);
}

function parseStoredRecord(value: unknown, sessionId: string): StoredEvidenceRecord | undefined {
  if (!isUnknownRecord(value)
    || value.schemaVersion !== STORE_SCHEMA_VERSION
    || value.sessionId !== sessionId
    || !isOdaiEvent(value)
    || typeof value.time !== "number"
    || !Number.isSafeInteger(value.time)
    || value.time < 0) return undefined;
  const id = typeof value.id === "string" && value.id !== "" ? value.id : evidenceId(value.type, value.data);
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    id,
    sessionId,
    type: value.type,
    time: value.time,
    data: value.data,
  };
}

function readStoredState(root: string, sessionId: string, logger: EvidenceLogger, strict = false): EvidenceState {
  const path = evidencePath(root, sessionId);
  const events: SessionEvidenceEvent[] = [];
  const ids = new Set<string>();
  for (const [index, line] of readCompleteLines(path, strict).entries()) {
    try {
      const parsed: unknown = JSON.parse(line);
      const record = parseStoredRecord(parsed, sessionId);
      if (!record) throw new Error("invalid evidence record");
      if (ids.has(record.id)) continue;
      ids.add(record.id);
      events.push(Object.freeze({ id: record.id, type: record.type, time: record.time, data: record.data }));
    } catch (error) {
      if (strict) throw new Error(`invalid odai evidence at ${path}:${index + 1}`, { cause: error });
      logger.warn(`ignored invalid odai evidence at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { events, ids, sessionId };
}

function mergeUnique(target: EvidenceState, events: readonly { id?: string; type: string; time?: number; data: RuntimeEventData }[]): void {
  for (const event of events) {
    const id = event.id ?? evidenceId(event.type, event.data);
    if (target.ids.has(id)) continue;
    target.ids.add(id);
    target.events.push(Object.freeze({ id, type: event.type, time: event.time, data: event.data }));
  }
}

function stateFor(agent: DshAgent | undefined, root: string, logger: EvidenceLogger): EvidenceState {
  const session = agent?.session;
  const owner = session && typeof session === "object"
    ? session
    : agent && typeof agent === "object"
      ? agent
      : undefined;
  if (!owner) return { events: [], ids: new Set(), sessionId: undefined };

  const shared = sharedState();
  let roots = shared.bySession.get(owner);
  if (!roots) {
    roots = new Map();
    shared.bySession.set(owner, roots);
  }
  const existing = roots.get(root);
  if (existing) return existing;

  const sessionId = sessionIdOf(agent);
  const state: EvidenceState = { events: [], ids: new Set(), sessionId };
  if (sessionId) mergeUnique(state, readStoredState(root, sessionId, logger).events);
  roots.set(root, state);
  return state;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function readLockOwner(lockPath: string): { value: string; pid: number } | undefined {
  try {
    const value = readFileSync(lockPath, "utf8").trim();
    const separator = value.indexOf(":");
    const pid = Number(separator < 0 ? "" : value.slice(0, separator));
    return Number.isSafeInteger(pid) && pid > 0 && separator < value.length - 1 ? { value, pid } : undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function createLock(lockPath: string, owner: string): number {
  const handle = openSync(lockPath, "wx", 0o600);
  try {
    const content = Buffer.from(`${owner}\n`, "utf8");
    if (writeSync(handle, content, 0, content.length) !== content.length) {
      throw new Error(`short write while acquiring odai evidence lock: ${lockPath}`);
    }
    fsyncSync(handle);
    return handle;
  } catch (error) {
    closeSync(handle);
    rmSync(lockPath, { force: true });
    throw error;
  }
}

function releaseLock(handle: number, lockPath: string, owner: string): void {
  closeSync(handle);
  const current = readLockOwner(lockPath);
  if (current === undefined) throw new Error(`odai evidence lock disappeared before release: ${lockPath}`);
  if (current.value !== owner) throw new Error(`odai evidence lock ownership changed before release: ${lockPath}`);
  rmSync(lockPath);
}

function acquireLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const claimPath = `${lockPath}.claim`;
  const owner = `${process.pid}:${randomUUID()}`;
  const claimOwner = `${process.pid}:${randomUUID()}`;
  let claimHandle: number;
  try {
    claimHandle = createLock(claimPath, claimOwner);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error(`odai evidence lock acquisition is already in progress: ${path}`);
    throw error;
  }

  let handle: number | undefined;
  try {
    try {
      handle = createLock(lockPath, owner);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const current = readLockOwner(lockPath);
      if (current === undefined || processIsAlive(current.pid)) throw new Error(`odai evidence is being updated by another runtime: ${path}`);
      rmSync(lockPath);
      handle = createLock(lockPath, owner);
    }
  } finally {
    try {
      releaseLock(claimHandle, claimPath, claimOwner);
    } catch (error) {
      if (handle !== undefined) {
        try { releaseLock(handle, lockPath, owner); } catch {}
        handle = undefined;
      }
      throw error;
    }
  }

  if (handle === undefined) throw new Error(`could not lock odai evidence: ${path}`);
  const ownedHandle = handle;
  return () => releaseLock(ownedHandle, lockPath, owner);
}

function syncDirectory(path: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    fsyncSync(handle);
  } catch {
    // Windows does not expose directory fsync; the evidence file itself was synced.
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function persistRecord(root: string, sessionId: string, record: StoredEvidenceRecord, logger: EvidenceLogger): boolean {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = evidencePath(root, sessionId);
  const release = acquireLock(path);
  try {
    const stored = readStoredState(root, sessionId, logger, true);
    if (stored.ids.has(record.id)) return false;
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    const originalSize = existsSync(path) ? statSync(path).size : 0;
    const handle = openSync(path, "a", 0o600);
    try {
      let offset = 0;
      while (offset < encoded.length) {
        const written = writeSync(handle, encoded, offset, encoded.length - offset);
        if (written <= 0) throw new Error(`short write while persisting odai evidence: ${path}`);
        offset += written;
      }
      fsyncSync(handle);
    } catch (error) {
      ftruncateSync(handle, originalSize);
      fsyncSync(handle);
      throw error;
    } finally {
      closeSync(handle);
    }
    syncDirectory(root);
    return true;
  } finally {
    release();
  }
}

export function resolveSessionEvidenceRoot(routingConfigPath: string): string {
  return resolve(dirname(routingConfigPath), "session-evidence");
}

export function storedSessionEvidenceRevision(root: string, sessionId: string): string {
  if (typeof sessionId !== "string" || sessionId === "") return "0";
  const path = evidencePath(resolve(root), sessionId);
  try {
    const snapshot = statSync(path);
    return `${snapshot.size}:${snapshot.mtimeMs}`;
  } catch (error) {
    if (isUnknownRecord(error) && error.code === "ENOENT") return "0";
    throw error;
  }
}

export function readStoredSessionEvidence(
  root: string,
  sessionId: string,
  logger: EvidenceLogger = { warn() {} },
): SessionEvidenceEvent[] {
  if (typeof sessionId !== "string" || sessionId === "") return [];
  return readStoredState(resolve(root), sessionId, logger).events;
}

export function createSessionEvidence(options: CreateSessionEvidenceOptions): Readonly<SessionEvidence> {
  const root = resolve(options.root);
  const logger = options.logger ?? { warn() {} };

  const events = (agent: DshAgent): SessionEvidenceEvent[] => stateFor(agent, root, logger).events.slice();
  const has = (agent: DshAgent, type: string, predicate: (data: RuntimeEventData) => boolean = () => true): boolean => stateFor(agent, root, logger)
    .events
    .some((event) => event.type === type && predicate(event.data));
  const append = (agent: DshAgent, type: string, data: object): SessionEvidenceEvent | undefined => {
    if (typeof type !== "string" || !type.startsWith("odai/")) {
      throw new TypeError("odai evidence type must start with odai/");
    }
    const state = stateFor(agent, root, logger);
    const snapshot = snapshotData(data, type);
    const id = evidenceId(type, snapshot);
    const event = Object.freeze({ id, type, time: Date.now(), data: snapshot });
    if (state.ids.has(id)) return state.events.find((candidate) => candidate.id === id);

    if (!state.sessionId) {
      state.ids.add(id);
      state.events.push(event);
      try {
        agent?.session?.append?.(type, event.data);
      } catch (error) {
        logger.warn(`failed to append transient ${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return event;
    }

    const record: StoredEvidenceRecord = {
      schemaVersion: STORE_SCHEMA_VERSION,
      id,
      sessionId: state.sessionId,
      type,
      time: event.time,
      data: event.data,
    };
    persistRecord(root, state.sessionId, record, logger);
    state.ids.add(id);
    state.events.push(event);
    return event;
  };

  return Object.freeze({ append, events, has, root });
}
