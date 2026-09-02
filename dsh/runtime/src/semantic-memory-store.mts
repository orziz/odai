import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { acquireOwnedStoreLock } from "./store-lock.mjs";
import type { DshAgent, DshMessage, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord, sessionEvents } from "./runtime-types.mjs";

export const MEMORY_STORE_SCHEMA_VERSION = 1;
export const MEMORY_EXTRACTOR_VERSION = 1;
export const MEMORY_MODES = Object.freeze(["auto", "off"] as const);
export const MEMORY_CATEGORIES = Object.freeze(["preference", "decision", "constraint", "fact"] as const);
export const MEMORY_STATUSES = Object.freeze(["pending", "active", "superseded"] as const);

export type MemoryMode = (typeof MEMORY_MODES)[number];
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryConfidence = "high" | "medium";
export type MemoryExtraction = "local-explicit" | "tool-exact-excerpt";

export interface MemorySettings { readonly mode?: MemoryMode }
export interface EffectiveMemorySettings { readonly mode: MemoryMode; readonly source: "deployment-config" | "deployment-default" | "persisted" }
export interface MemoryScope { readonly kind: "global" | "project"; readonly key: string; readonly label?: string }
export interface MemoryProvenance {
  readonly sourceKind: "direct-user";
  readonly sessionHash: string;
  readonly messageHash: string;
  readonly turn: number;
  readonly eventSeq?: number;
  readonly excerptSha256: string;
  readonly observedAt: number;
  readonly extraction: MemoryExtraction;
  readonly extractorVersion: 1;
}
export interface MemoryEntry {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly category: MemoryCategory;
  readonly subject: string;
  readonly value: string;
  readonly status: MemoryStatus;
  readonly confidence: MemoryConfidence;
  readonly supersedes: readonly string[];
  readonly conflictsWith: readonly string[];
  readonly provenance: readonly MemoryProvenance[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly occurrences: number;
}
export interface MemoryStore { readonly schemaVersion: 1; readonly settings: MemorySettings; readonly entries: readonly MemoryEntry[] }
export interface MutableMemoryEntry {
  id: string; scope: MemoryScope; category: MemoryCategory; subject: string; value: string; status: MemoryStatus;
  confidence: MemoryConfidence; supersedes: string[]; conflictsWith: string[]; provenance: MemoryProvenance[];
  createdAt: number; updatedAt: number; occurrences: number;
}
export interface MutableMemoryStore { schemaVersion: 1; settings: { mode?: MemoryMode }; entries: MutableMemoryEntry[] }
export interface MemoryMutationOutcome extends UnknownRecord { changed?: boolean }
export interface DirectUserProvenanceOptions {
  agent: DshAgent;
  message: DshMessage;
  turn: number | undefined;
  excerpt: string;
  extraction: MemoryExtraction;
  now?: number;
}

export const DEFAULT_MEMORY_SETTINGS: Readonly<{ mode: MemoryMode }> = Object.freeze({ mode: "auto" });
export const MAX_MEMORY_ENTRIES = 1_000;
export const MAX_MEMORY_PROVENANCE = 8;
export const MAX_MEMORY_VALUE_CHARS = 600;

const STORE_FIELDS = new Set<string>(["schemaVersion", "settings", "entries"]);
const SETTINGS_FIELDS = new Set<string>(["mode"]);
const ENTRY_FIELDS = new Set<string>([
  "id", "scope", "category", "subject", "value", "status", "confidence", "supersedes", "conflictsWith",
  "provenance", "createdAt", "updatedAt", "occurrences",
]);
const SCOPE_FIELDS = new Set<string>(["kind", "key", "label"]);
const PROVENANCE_FIELDS = new Set<string>([
  "sourceKind", "sessionHash", "messageHash", "turn", "eventSeq", "excerptSha256", "observedAt", "extraction", "extractorVersion",
]);

export class MemoryStoreValidationError extends Error {}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
function rejectUnknown(value: UnknownRecord, allowed: ReadonlySet<string>, field: string): void {
  const unknownFields = Object.keys(value).filter((name) => !allowed.has(name));
  if (unknownFields.length > 0) throw new TypeError(`${field} has unknown fields: ${unknownFields.join(", ")}`);
}
function requiredString(value: unknown, field: string, max = 1_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}
function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}
function isMemoryMode(value: unknown): value is MemoryMode { return typeof value === "string" && (MEMORY_MODES as readonly string[]).includes(value); }
function isMemoryCategory(value: unknown): value is MemoryCategory { return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value); }
function isMemoryStatus(value: unknown): value is MemoryStatus { return typeof value === "string" && (MEMORY_STATUSES as readonly string[]).includes(value); }
function validateMode(mode: unknown, field = "memory mode"): MemoryMode {
  if (!isMemoryMode(mode)) throw new TypeError(`${field} must be auto or off`);
  return mode;
}

function validateScope(value: unknown, field: string): Readonly<MemoryScope> {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  rejectUnknown(value, SCOPE_FIELDS, field);
  if (value.kind !== "global" && value.kind !== "project") throw new TypeError(`${field}.kind must be global or project`);
  const key = requiredString(value.key, `${field}.key`, 64);
  if (value.kind === "global" && key !== "global") throw new TypeError(`${field}.key must be global for global scope`);
  if (value.kind === "project" && !/^[a-f0-9]{64}$/u.test(key)) throw new TypeError(`${field}.key must be a sha256 project key`);
  const label = value.label === undefined ? undefined : requiredString(value.label, `${field}.label`, 120);
  return Object.freeze({ kind: value.kind, key, ...(label === undefined ? {} : { label }) });
}

function validateProvenance(value: unknown, field: string): Readonly<MemoryProvenance> {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  rejectUnknown(value, PROVENANCE_FIELDS, field);
  if (value.sourceKind !== "direct-user") throw new TypeError(`${field}.sourceKind must be direct-user`);
  const sessionHash = requiredString(value.sessionHash, `${field}.sessionHash`, 64);
  const messageHash = requiredString(value.messageHash, `${field}.messageHash`, 64);
  const excerptSha256 = requiredString(value.excerptSha256, `${field}.excerptSha256`, 64);
  if (!/^[a-f0-9]{64}$/u.test(sessionHash)) throw new TypeError(`${field}.sessionHash must be sha256`);
  if (!/^[a-f0-9]{64}$/u.test(messageHash)) throw new TypeError(`${field}.messageHash must be sha256`);
  if (!/^[a-f0-9]{64}$/u.test(excerptSha256)) throw new TypeError(`${field}.excerptSha256 must be sha256`);
  const turn = safeInteger(value.turn, `${field}.turn`);
  const eventSeq = value.eventSeq === undefined ? undefined : safeInteger(value.eventSeq, `${field}.eventSeq`);
  const observedAt = safeInteger(value.observedAt, `${field}.observedAt`);
  if (value.extraction !== "local-explicit" && value.extraction !== "tool-exact-excerpt") throw new TypeError(`${field}.extraction is unsupported`);
  if (value.extractorVersion !== MEMORY_EXTRACTOR_VERSION) throw new TypeError(`${field}.extractorVersion is unsupported`);
  return Object.freeze({
    sourceKind: "direct-user", sessionHash, messageHash, turn, ...(eventSeq === undefined ? {} : { eventSeq }),
    excerptSha256, observedAt, extraction: value.extraction, extractorVersion: MEMORY_EXTRACTOR_VERSION,
  });
}

function validateEntry(value: unknown, field: string): Readonly<MemoryEntry> {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  rejectUnknown(value, ENTRY_FIELDS, field);
  const id = requiredString(value.id, `${field}.id`, 80);
  const scope = validateScope(value.scope, `${field}.scope`);
  if (!isMemoryCategory(value.category)) throw new TypeError(`${field}.category is unsupported`);
  const subject = requiredString(value.subject, `${field}.subject`, 64);
  const entryValue = requiredString(value.value, `${field}.value`, MAX_MEMORY_VALUE_CHARS);
  if (!isMemoryStatus(value.status)) throw new TypeError(`${field}.status is unsupported`);
  if (value.confidence !== "high" && value.confidence !== "medium") throw new TypeError(`${field}.confidence is unsupported`);
  if (!Array.isArray(value.supersedes) || value.supersedes.length > 64) throw new TypeError(`${field}.supersedes must be an array with at most 64 entries`);
  const supersedes = value.supersedes.map((entryId, index) => requiredString(entryId, `${field}.supersedes[${index}]`, 80));
  if (!Array.isArray(value.conflictsWith) || value.conflictsWith.length > 64) throw new TypeError(`${field}.conflictsWith must be an array with at most 64 entries`);
  const conflictsWith = value.conflictsWith.map((entryId, index) => requiredString(entryId, `${field}.conflictsWith[${index}]`, 80));
  if (!Array.isArray(value.provenance) || value.provenance.length === 0 || value.provenance.length > MAX_MEMORY_PROVENANCE) {
    throw new TypeError(`${field}.provenance must contain 1-${MAX_MEMORY_PROVENANCE} entries`);
  }
  const provenance = value.provenance.map((item, index) => validateProvenance(item, `${field}.provenance[${index}]`));
  const createdAt = safeInteger(value.createdAt, `${field}.createdAt`);
  const updatedAt = safeInteger(value.updatedAt, `${field}.updatedAt`);
  if (updatedAt < createdAt) throw new TypeError(`${field}.updatedAt must not precede createdAt`);
  const occurrences = safeInteger(value.occurrences, `${field}.occurrences`);
  if (occurrences < 1) throw new TypeError(`${field}.occurrences must be positive`);
  return Object.freeze({ id, scope, category: value.category, subject, value: entryValue, status: value.status, confidence: value.confidence,
    supersedes: Object.freeze(supersedes), conflictsWith: Object.freeze(conflictsWith), provenance: Object.freeze(provenance), createdAt, updatedAt, occurrences });
}

function validateStore(value: unknown, field: string): Readonly<MemoryStore> {
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  rejectUnknown(value, STORE_FIELDS, field);
  if (value.schemaVersion !== MEMORY_STORE_SCHEMA_VERSION) throw new TypeError(`${field} has unsupported schemaVersion ${String(value.schemaVersion)}`);
  const settingsValue = value.settings === undefined ? {} : value.settings;
  if (!isUnknownRecord(settingsValue)) throw new TypeError(`${field}.settings must be an object`);
  rejectUnknown(settingsValue, SETTINGS_FIELDS, `${field}.settings`);
  const settings: MemorySettings = Object.freeze({ ...(settingsValue.mode === undefined ? {} : { mode: validateMode(settingsValue.mode, `${field}.settings.mode`) }) });
  if (!Array.isArray(value.entries) || value.entries.length > MAX_MEMORY_ENTRIES) throw new TypeError(`${field}.entries must be an array with at most ${MAX_MEMORY_ENTRIES} records`);
  const entries = value.entries.map((entry, index) => validateEntry(entry, `${field}.entries[${index}]`));
  const ids = new Set<string>();
  for (const entry of entries) { if (ids.has(entry.id)) throw new TypeError(`${field}.entries contains duplicate id ${entry.id}`); ids.add(entry.id); }
  return Object.freeze({ schemaVersion: MEMORY_STORE_SCHEMA_VERSION, settings, entries: Object.freeze(entries) });
}

function emptyStore(): Readonly<MemoryStore> { return Object.freeze({ schemaVersion: MEMORY_STORE_SCHEMA_VERSION, settings: Object.freeze({}), entries: Object.freeze([]) }); }
interface DirectoryIdentity { path: string; dev: number; ino: number }
function assertNoSymlink(path: string, label: string): void { if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`); }
function assertSafeStorePath(storePath: string): readonly DirectoryIdentity[] {
  const parent = dirname(storePath); const grandparent = dirname(parent);
  assertNoSymlink(grandparent, "Odai memory parent"); assertNoSymlink(parent, "Odai memory directory"); assertNoSymlink(storePath, "Odai memory store");
  if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Odai memory directory is not a directory: ${parent}`);
  if (existsSync(storePath) && !lstatSync(storePath).isFile()) throw new Error(`Odai memory store is not a regular file: ${storePath}`);
  return [grandparent, parent].filter((path) => existsSync(path)).map((path) => { const stat = lstatSync(path); return Object.freeze({ path, dev: stat.dev, ino: stat.ino }); });
}
function assertDirectoryIdentities(identities: readonly DirectoryIdentity[]): void {
  for (const identity of identities) { const stat = lstatSync(identity.path); if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error(`Odai memory directory identity changed during an operation: ${identity.path}`); }
}
function readRegularFileNoFollow(path: string): string {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0; let fd: number | undefined;
  try { fd = openSync(path, constants.O_RDONLY | noFollow); const stat = fstatSync(fd); if (!stat.isFile()) throw new Error(`Odai memory store is not a regular file: ${path}`); return readFileSync(fd, "utf8"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function resolveMemoryStorePath(configuredPath: unknown, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (configuredPath !== undefined) { if (typeof configuredPath !== "string" || configuredPath.trim() === "") throw new TypeError("config.memory.storePath must be a non-empty string"); return resolve(configuredPath.trim()); }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== "" ? resolve(env.DSH_HOME.trim()) : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "memory", "store.json");
}

export function readMemoryStore(storePath: string): Readonly<MemoryStore> {
  const identities = assertSafeStorePath(storePath); let text: string;
  try { text = readRegularFileNoFollow(storePath); }
  catch (error) { assertDirectoryIdentities(identities); if (errorCode(error) === "ENOENT") return emptyStore(); throw new Error(`cannot read Odai semantic memory ${storePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  assertDirectoryIdentities(identities); let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch (error) { throw new MemoryStoreValidationError(`Odai semantic memory ${storePath} is not valid JSON`, { cause: error }); }
  try { return validateStore(parsed, `Odai semantic memory ${storePath}`); }
  catch (error) { if (error instanceof MemoryStoreValidationError) throw error; throw new MemoryStoreValidationError(`Odai semantic memory ${storePath} failed validation: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

function writeMemoryStore(storePath: string, store: MutableMemoryStore): Readonly<MemoryStore> {
  const value = validateStore(store, "Odai semantic memory write"); const parent = dirname(storePath); assertSafeStorePath(storePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 }); const identities = assertSafeStorePath(storePath); const temporary = `${storePath}.tmp-${process.pid}-${randomUUID()}`; const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try { let fd: number | undefined; try { fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" }); fsyncSync(fd); } finally { if (fd !== undefined) closeSync(fd); }
    assertSafeStorePath(storePath); assertDirectoryIdentities(identities); renameSync(temporary, storePath); assertDirectoryIdentities(identities);
  } finally { rmSync(temporary, { force: true }); }
  return value;
}

export function mutateMemoryStore<TOutcome extends MemoryMutationOutcome>(storePath: string, mutate: (store: MutableMemoryStore) => TOutcome): Readonly<TOutcome & { store: Readonly<MemoryStore> }> {
  if (typeof mutate !== "function") throw new TypeError("memory mutator must be a function"); const identities = assertSafeStorePath(storePath); const releaseLock = acquireOwnedStoreLock(storePath, "Odai semantic memory");
  try { assertDirectoryIdentities(identities); const current = readMemoryStore(storePath); const mutable: MutableMemoryStore = { schemaVersion: MEMORY_STORE_SCHEMA_VERSION, settings: { ...current.settings }, entries: current.entries.map((entry) => ({ ...entry, scope: { ...entry.scope }, supersedes: [...entry.supersedes], conflictsWith: [...entry.conflictsWith], provenance: entry.provenance.map((source) => ({ ...source })) })) };
    const outcome = mutate(mutable); if (!outcome || outcome.changed !== true) return Object.freeze({ store: current, ...outcome }) as Readonly<TOutcome & { store: Readonly<MemoryStore> }>;
    const store = writeMemoryStore(storePath, mutable); return Object.freeze({ ...outcome, changed: true, store }) as Readonly<TOutcome & { store: Readonly<MemoryStore> }>;
  } finally { releaseLock(); }
}

export function resetMemoryStore(storePath: string): Readonly<MemoryStore> {
  const identities = assertSafeStorePath(storePath); const releaseLock = acquireOwnedStoreLock(storePath, "Odai semantic memory");
  try { assertSafeStorePath(storePath); assertDirectoryIdentities(identities); rmSync(storePath, { force: true }); assertDirectoryIdentities(identities); return writeMemoryStore(storePath, { schemaVersion: MEMORY_STORE_SCHEMA_VERSION, settings: {}, entries: [] }); }
  finally { releaseLock(); }
}

export function effectiveMemorySettings(storePath: string, configured: { mode?: MemoryMode } = {}): Readonly<EffectiveMemorySettings> {
  const configuredMode = validateMode(configured.mode ?? DEFAULT_MEMORY_SETTINGS.mode, "config.memory.mode"); const store = readMemoryStore(storePath);
  if (configuredMode === "off") return Object.freeze({ mode: "off", source: "deployment-config" });
  return Object.freeze({ mode: store.settings.mode ?? configuredMode, source: store.settings.mode === undefined ? "deployment-default" : "persisted" });
}
export function globalMemoryScope(): Readonly<MemoryScope> { return Object.freeze({ kind: "global", key: "global", label: "global" }); }
export function projectMemoryScope(cwd: unknown): Readonly<MemoryScope> | undefined {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined; let canonical: string;
  try { canonical = realpathSync.native(resolve(cwd.trim())); if (!lstatSync(canonical).isDirectory()) return undefined; } catch { return undefined; }
  return Object.freeze({ kind: "project", key: hash(canonical), label: basename(canonical) || "project" });
}
function eventSeqFor(agent: DshAgent, messageId: string): number | undefined {
  const events = sessionEvents(agent?.session);
  for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]; if (event?.type === "user/message" && event.data?.id === messageId && Number.isSafeInteger(event.seq)) return event.seq; }
  return undefined;
}
export function directUserProvenance(options: DirectUserProvenanceOptions): Readonly<MemoryProvenance> | undefined {
  const { agent, message, turn, excerpt, extraction, now = Date.now() } = options; const sessionId = agent?.session?.header?.id; const messageId = message?.id;
  if (typeof sessionId !== "string" || sessionId === "" || typeof messageId !== "string" || messageId === "") return undefined;
  if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0) return undefined; const eventSeq = eventSeqFor(agent, messageId);
  return Object.freeze({ sourceKind: "direct-user", sessionHash: hash(sessionId), messageHash: hash(messageId), turn, ...(eventSeq === undefined ? {} : { eventSeq }), excerptSha256: hash(excerpt), observedAt: now, extraction, extractorVersion: MEMORY_EXTRACTOR_VERSION });
}
export function memoryRecordId(scope: MemoryScope, category: MemoryCategory, subject: string, value: string): string { return `mem-${hash(JSON.stringify([scope.kind, scope.key, category, subject, value])).slice(0, 32)}`; }
export function memoryValueDigest(value: string): string { return hash(value); }
