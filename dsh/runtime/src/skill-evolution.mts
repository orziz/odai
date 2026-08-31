import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import { ODAI_RUNTIME_CONTRACT, loadSkillBundle, readSkillBundleFile } from "./skill-bundle.mjs";
import type { SkillBundle, SkillManifest } from "./skill-bundle.mjs";
import { acquireOwnedStoreLock } from "./store-lock.mjs";
import type { DshAgent, DshEvent, RuntimeTool, ToolExecution, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

type EvolutionAction = "show" | "inspect" | "propose" | "validate" | "activate" | "rebase" | "rollback" | "deactivate";
type StateAction = "activate" | "rollback" | "deactivate";
type AuthorizationAction = "propose" | "activate" | "rebase" | "rollback" | "deactivate";
type AuthorizationLevel = "standard" | "breaking";

interface ManifestSnapshot {
  schemaVersion: number;
  name: string;
  skillVersion: string;
  runtimeContract: number;
  roleFiles: Record<string, string>;
  referenceFiles: Record<string, string>;
  requiredFiles: string[];
}
interface BundleSnapshot { manifest: ManifestSnapshot; files: Map<string, Buffer> }
interface Replacement { readonly oldString: string; readonly newString: string }
interface ProposedChange { readonly path: string; readonly expectedSha256: string; readonly replacements: readonly Replacement[] }
interface EvolutionPatch {
  readonly path: string;
  readonly baseSha256: string;
  readonly resultSha256: string;
  readonly replacements: readonly Replacement[];
}
interface MutableEvolutionPatch { path: string; baseSha256: string; resultSha256?: string; replacements: Replacement[] }
type PatchMergeResult =
  | { readonly status: "absorbed"; readonly snapshot: BundleSnapshot; readonly patches: readonly EvolutionPatch[] }
  | { readonly status: "candidate"; readonly snapshot: BundleSnapshot; readonly patches: readonly EvolutionPatch[] };
export interface GenerationAuthorization {
  readonly action: "propose" | "rebase";
  readonly phrase: string;
  readonly turn: number;
  readonly eventSeq: number;
  readonly messageId: string;
}
interface HumanAuthorization {
  readonly action: AuthorizationAction;
  readonly phrase: string;
  readonly turn: number;
  readonly eventSeq: number;
  readonly messageId: string;
}
interface EvolutionBaseMetadata { source: string; provider: string; skillVersion: string; runtimeContract: unknown; digest: string }
interface EvolutionResultMetadata { skillVersion: string; runtimeContract: unknown; digest: string }
interface InitialGenerationMetadata {
  schemaVersion: 1; generationId: string; parentGenerationId?: string; createdAt: string; objective: string;
  authorization?: GenerationAuthorization; base: EvolutionBaseMetadata; result: EvolutionResultMetadata; patches: unknown;
}
interface GenerationMetadata {
  schemaVersion: 1;
  generationId: string;
  parentGenerationId?: string;
  createdAt: string;
  objective: string;
  authorization?: GenerationAuthorization;
  base: EvolutionBaseMetadata;
  result: EvolutionResultMetadata;
  patches: readonly EvolutionPatch[];
}
interface HistoryEvent {
  readonly revision: number;
  readonly action: StateAction;
  readonly from: string | null;
  readonly to: string | null;
  readonly at: string;
  readonly evidence: readonly string[];
}
export interface SkillEvolutionState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly activeGenerationId?: string;
  readonly history: readonly HistoryEvent[];
}
interface GenerationAuthorizationProfile { readonly level: AuthorizationLevel; readonly breakingReasons: readonly string[] }
interface ValidatedGeneration {
  readonly root: string;
  readonly metadata: Readonly<GenerationMetadata>;
  readonly baseBundle: SkillBundle;
  readonly resultBundle: SkillBundle;
  readonly baseSnapshot: Readonly<BundleSnapshot>;
  readonly resultSnapshot: Readonly<BundleSnapshot>;
  readonly authorization: GenerationAuthorizationProfile;
}
export interface GenerationSummary extends UnknownRecord {
  generationId: string;
  parentGenerationId?: string;
  createdAt: string;
  objective: string;
  baseDigest: string;
  resultDigest: string;
  skillVersion: string;
  runtimeContract: unknown;
  changedPaths: readonly string[];
  authorizationLevel: AuthorizationLevel;
  activationPhrase: string;
  breakingReasons: readonly string[];
  creationAuthorization?: GenerationAuthorization;
}
interface GenerationDiagnostic { readonly generationId: string; readonly error: string }
interface GenerationList { readonly generations: readonly GenerationSummary[]; readonly diagnostics: readonly GenerationDiagnostic[] }
export interface RebaseConflict { readonly path: string; readonly replacement: number; readonly reason: string }
interface CreateGenerationOptions {
  readonly parentGenerationId?: string;
  readonly objective: string;
  readonly authorization: GenerationAuthorization;
  readonly now: () => string;
}
type RebaseGenerationResult =
  | { readonly status: "up-to-date"; readonly generation: Readonly<ValidatedGeneration> }
  | { readonly status: "absorbed" }
  | { readonly status: "conflict"; readonly report: Readonly<ConflictReport> }
  | { readonly status: "reused" | "candidate"; readonly generation: Readonly<ValidatedGeneration> };
type CreateGenerationResult =
  | { readonly status: "absorbed" }
  | { readonly status: "reused" | "candidate"; readonly generation: Readonly<ValidatedGeneration> };
interface ConflictReport extends UnknownRecord {
  schemaVersion: 1; attemptId: string; createdAt: string; generationId: string;
  oldBaseDigest: string; upstreamDigest: string; authorization: HumanAuthorization; conflicts: readonly RebaseConflict[];
}
interface SelectionEvolutionState extends UnknownRecord {
  status?: string;
  generationId?: string;
  baseDigest?: string;
  upstreamDigest?: string;
  rebaseRequired?: boolean;
  hostOverride?: boolean;
}
export interface EvolutionSelection {
  readonly mode: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly detail?: string;
  readonly bundle: SkillBundle;
  readonly candidate?: SkillBundle;
  readonly rejections: readonly { readonly source: string; readonly reasonCode: string; readonly detail?: string }[];
  readonly upstream?: EvolutionSelection;
  readonly evolution?: Readonly<SelectionEvolutionState>;
}
export interface EvolutionToolArguments extends UnknownRecord {
  action?: unknown; path?: unknown; generationId?: unknown; objective?: unknown;
  expectedBundleDigest?: unknown; expectedUpstreamDigest?: unknown; changes?: unknown;
}
export interface EvolutionToolResult extends UnknownRecord {
  action: string; status: string; error?: string; path?: string; bundleDigest?: string;
  proposalPhrase?: string; attemptId?: string; conflicts?: readonly RebaseConflict[];
  sha256?: string; content?: string; requiresNextTurn?: boolean;
  generations?: readonly GenerationSummary[];
  activeGenerationId?: string; active?: GenerationSummary & { rebaseRequired: boolean }; generation?: GenerationSummary;
}
interface CreateEvolutionToolOptions {
  currentSelectionFor?: (agent: DshAgent) => EvolutionSelection;
  selection?: EvolutionSelection;
  onChanged?: (agent: DshAgent, result: EvolutionToolResult) => void;
  now?: () => string;
  disabled?: boolean;
}

const STORE_SCHEMA_VERSION = 1;
const STATE_FILE = "state.json";
const METADATA_FILE = "metadata.json";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const EVOLVABLE_PATH = /^(?:SKILL\.md|assets\/task-state\.md|assets\/routing-roles\/[a-z0-9-]+\.md|references\/[a-z0-9-]+\.md)$/u;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_REPLACEMENT_BYTES = 512 * 1024;
const MAX_OBJECTIVE_CHARS = 2_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_CHARS = 2_000;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainObject(value: unknown, field: string): UnknownRecord {
  if (!isUnknownRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function assertExactFields(value: UnknownRecord, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${field} has unknown fields: ${unknown.join(", ")}`);
}

function nonEmptyString(value: unknown, field: string, maximum = Number.POSITIVE_INFINITY): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${field} exceeds ${maximum} characters`);
  return normalized;
}

function exactDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function validTimestamp(value: unknown, field: string): string {
  const timestamp = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError(`${field} must be an ISO timestamp`);
  return timestamp;
}

function utf8Text(buffer: Buffer, field: string): string {
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error(`${field} exceeds ${MAX_FILE_BYTES} bytes`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(`${field} must be valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertUtf8String(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (Buffer.from(value, "utf8").toString("utf8") !== value) throw new TypeError(`${field} must be valid UTF-8`);
  return value;
}

function stringList(value: unknown, field: string, minimum = 0): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_EVIDENCE_ITEMS) {
    throw new TypeError(`${field} must contain ${minimum}-${MAX_EVIDENCE_ITEMS} strings`);
  }
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${field}[${index}]`, MAX_EVIDENCE_CHARS)));
}

function safeGenerationId(value: unknown, field = "generationId"): string {
  return exactDigest(value, field);
}

function safePath(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Odai evolution path escapes its root: ${target}`);
  }
  return target;
}

function assertRegularFile(path: string, label: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
  return stat;
}

function assertRegularDirectory(path: string, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular directory`);
  return path;
}

function ensureStoreRoot(root: string): string {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  return assertRegularDirectory(root, "Odai skill evolution root");
}

function ensureStoreDirectory(root: string, name: string): string {
  ensureStoreRoot(root);
  const path = safePath(root, name);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  return assertRegularDirectory(path, `Odai skill evolution ${name} directory`);
}

function requireStoreDirectory(root: string, name: string): string {
  ensureStoreRoot(root);
  const path = safePath(root, name);
  if (!existsSync(path)) throw new Error(`Odai skill evolution ${name} directory is missing`);
  return assertRegularDirectory(path, `Odai skill evolution ${name} directory`);
}

function readJsonFile(path: string, label: string, maximumBytes: number): UnknownRecord {
  const stat = assertRegularFile(path, label);
  if (stat.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return assertPlainObject(parsed, label);
}

function syncDirectory(path: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    fsyncSync(handle);
  } catch {
    // Directory fsync is unavailable on Windows; each file is still synced.
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function writeDurableFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const handle = openSync(path, "wx", 0o600);
  try {
    writeFileSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function writeJsonAtomic(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error(`Odai skill evolution state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeDurableFile(temporary, serialized);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function emptyState(): Readonly<SkillEvolutionState> {
  return Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION, revision: 0, history: Object.freeze([]) });
}

function normalizeHistoryEvent(value: unknown, index: number): Readonly<HistoryEvent> {
  const event = assertPlainObject(value, `Odai evolution state.history[${index}]`);
  assertExactFields(event, ["revision", "action", "from", "to", "at", "evidence"], `Odai evolution state.history[${index}]`);
  if (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) || event.revision !== index + 1) {
    throw new TypeError(`Odai evolution state.history[${index}].revision must be ${index + 1}`);
  }
  if (event.action !== "activate" && event.action !== "rollback" && event.action !== "deactivate") {
    throw new TypeError(`Odai evolution state.history[${index}].action is invalid`);
  }
  const from = event.from === null ? null : safeGenerationId(event.from, `Odai evolution state.history[${index}].from`);
  const to = event.to === null ? null : safeGenerationId(event.to, `Odai evolution state.history[${index}].to`);
  if (from === to) throw new TypeError(`Odai evolution state.history[${index}] does not change the active generation`);
  return Object.freeze({
    revision: event.revision,
    action: event.action,
    from,
    to,
    at: validTimestamp(event.at, `Odai evolution state.history[${index}].at`),
    evidence: stringList(event.evidence, `Odai evolution state.history[${index}].evidence`, 1),
  });
}

export function readSkillEvolutionState(root: string): Readonly<SkillEvolutionState> {
  if (!existsSync(root)) return emptyState();
  assertRegularDirectory(root, "Odai skill evolution root");
  const path = resolve(root, STATE_FILE);
  if (!existsSync(path)) return emptyState();
  const value = readJsonFile(path, "Odai skill evolution state", MAX_STATE_BYTES);
  assertExactFields(value, ["schemaVersion", "revision", "activeGenerationId", "history"], "Odai skill evolution state");
  if (value.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new TypeError(`Odai skill evolution state has unsupported schemaVersion ${String(value.schemaVersion)}`);
  }
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new TypeError("Odai skill evolution state.revision must be a non-negative integer");
  }
  if (!Array.isArray(value.history) || value.history.length !== value.revision) {
    throw new TypeError("Odai skill evolution state.history must match revision");
  }
  const history = Object.freeze(value.history.map(normalizeHistoryEvent));
  let prior: string | null = null;
  for (const [index, event] of history.entries()) {
    if (event.from !== prior) throw new TypeError(`Odai skill evolution state.history[${index}].from breaks the active-pointer chain`);
    if (event.action === "activate" && event.to === null) {
      throw new TypeError(`Odai skill evolution state.history[${index}].activate requires a target generation`);
    }
    if (event.action === "deactivate" && (event.from === null || event.to !== null)) {
      throw new TypeError(`Odai skill evolution state.history[${index}].deactivate must clear an active generation`);
    }
    if (event.action === "rollback" && event.from === null) {
      throw new TypeError(`Odai skill evolution state.history[${index}].rollback requires an active generation`);
    }
    prior = event.to;
  }
  const activeGenerationId = value.activeGenerationId === undefined
    ? undefined
    : safeGenerationId(value.activeGenerationId, "Odai skill evolution state.activeGenerationId");
  const expectedActive = prior ?? undefined;
  if (activeGenerationId !== expectedActive) {
    throw new TypeError("Odai skill evolution state.activeGenerationId does not match its history");
  }
  return Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: value.revision,
    ...(activeGenerationId ? { activeGenerationId } : {}),
    history,
  });
}

export function resolveSkillEvolutionRoot(
  configuredPath: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (configuredPath !== undefined) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") {
      throw new TypeError("config.governance.evolutionRoot must be a non-empty string");
    }
    return resolve(configuredPath.trim());
  }
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
    ? resolve(env.DSH_HOME.trim())
    : resolve(homedir(), ".dsh");
  return resolve(dshHome, "odai", "skill-evolution");
}

export function skillEvolutionDisabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.ODAI_DISABLE_EVOLUTION === "1";
}

function manifestValue(bundle: SkillBundle): ManifestSnapshot {
  return {
    schemaVersion: bundle.manifest.schemaVersion,
    name: bundle.manifest.name,
    skillVersion: bundle.manifest.skillVersion,
    runtimeContract: bundle.manifest.runtimeContract,
    roleFiles: { ...bundle.manifest.roleFiles },
    referenceFiles: { ...bundle.manifest.referenceFiles },
    requiredFiles: [...bundle.manifest.requiredFiles],
  };
}

function snapshotBundle(bundle: SkillBundle): Readonly<BundleSnapshot> {
  const files = new Map<string, Buffer>();
  for (const path of bundle.manifest.requiredFiles) {
    const content = readSkillBundleFile(bundle, path);
    if (content.byteLength > MAX_FILE_BYTES) throw new Error(`Odai skill file ${path} exceeds ${MAX_FILE_BYTES} bytes`);
    files.set(path, content);
  }
  return Object.freeze({ manifest: Object.freeze(manifestValue(bundle)), files });
}

function cloneSnapshot(snapshot: Readonly<BundleSnapshot>): BundleSnapshot {
  return {
    manifest: {
      ...snapshot.manifest,
      roleFiles: { ...snapshot.manifest.roleFiles },
      referenceFiles: { ...snapshot.manifest.referenceFiles },
      requiredFiles: [...snapshot.manifest.requiredFiles],
    },
    files: new Map([...snapshot.files].map(([path, content]) => [path, Buffer.from(content)])),
  };
}

function writeBundleSnapshot(root: string, snapshot: Readonly<BundleSnapshot>): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeDurableFile(resolve(root, "manifest.json"), `${JSON.stringify(snapshot.manifest, null, 2)}\n`);
  for (const [path, content] of snapshot.files) {
    writeDurableFile(resolve(root, ...path.split("/")), content);
  }
  syncDirectory(root);
}

function assertEvolvablePath(
  path: unknown,
  manifest: { readonly requiredFiles: readonly string[] },
  field = "path",
): string {
  const normalized = nonEmptyString(path, field);
  if (!EVOLVABLE_PATH.test(normalized) || !manifest.requiredFiles.includes(normalized)) {
    throw new TypeError(`${field} must name an existing Odai governance Markdown file`);
  }
  return normalized;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function normalizeProposedChanges(
  value: unknown,
  manifest: { readonly requiredFiles: readonly string[] },
): readonly Readonly<ProposedChange>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new TypeError("changes must contain 1-20 file changes");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  return Object.freeze(value.map((raw, index) => {
    const change = assertPlainObject(raw, `changes[${index}]`);
    assertExactFields(change, ["path", "expectedSha256", "replacements"], `changes[${index}]`);
    const path = assertEvolvablePath(change.path, manifest, `changes[${index}].path`);
    if (paths.has(path)) throw new TypeError(`changes contains duplicate path ${path}`);
    paths.add(path);
    const expectedSha256 = exactDigest(change.expectedSha256, `changes[${index}].expectedSha256`);
    if (!Array.isArray(change.replacements) || change.replacements.length === 0 || change.replacements.length > 20) {
      throw new TypeError(`changes[${index}].replacements must contain 1-20 replacements`);
    }
    const replacements = Object.freeze(change.replacements.map((rawReplacement, replacementIndex) => {
      const replacement = assertPlainObject(rawReplacement, `changes[${index}].replacements[${replacementIndex}]`);
      assertExactFields(replacement, ["oldString", "newString"], `changes[${index}].replacements[${replacementIndex}]`);
      const oldString = assertUtf8String(replacement.oldString, `changes[${index}].replacements[${replacementIndex}].oldString`);
      const newString = assertUtf8String(replacement.newString, `changes[${index}].replacements[${replacementIndex}].newString`);
      if (oldString.length === 0) throw new TypeError(`changes[${index}].replacements[${replacementIndex}].oldString must not be empty`);
      if (oldString === newString) throw new TypeError(`changes[${index}].replacements[${replacementIndex}] does not change content`);
      totalBytes += Buffer.byteLength(oldString) + Buffer.byteLength(newString);
      if (totalBytes > MAX_TOTAL_REPLACEMENT_BYTES) {
        throw new TypeError(`changes exceeds ${MAX_TOTAL_REPLACEMENT_BYTES} replacement bytes`);
      }
      return Object.freeze({ oldString, newString });
    }));
    return Object.freeze({ path, expectedSha256, replacements });
  }));
}

function applyExactReplacements(text: string, replacements: readonly Replacement[], field: string): string {
  let result = text;
  for (const [index, replacement] of replacements.entries()) {
    const count = countOccurrences(result, replacement.oldString);
    if (count !== 1) throw new Error(`${field}.replacements[${index}].oldString must match exactly once; found ${count}`);
    result = result.replace(replacement.oldString, replacement.newString);
  }
  return result;
}

function mergePatchGroups(
  parentPatches: readonly EvolutionPatch[],
  proposedChanges: readonly ProposedChange[],
  upstreamSnapshot: Readonly<BundleSnapshot>,
  effectiveSnapshot: Readonly<BundleSnapshot>,
): PatchMergeResult {
  const patches = new Map<string, MutableEvolutionPatch>(parentPatches.map((patch) => [patch.path, {
    path: patch.path,
    baseSha256: patch.baseSha256,
    replacements: patch.replacements.map((replacement) => ({ ...replacement })),
  }]));
  const finalSnapshot = cloneSnapshot(effectiveSnapshot);

  for (const change of proposedChanges) {
    const current = finalSnapshot.files.get(change.path);
    if (!current) throw new Error(`current Odai bundle is missing ${change.path}`);
    if (sha256(current) !== change.expectedSha256) throw new Error(`changes for ${change.path} use a stale file digest`);
    const text = utf8Text(current, change.path);
    const next = applyExactReplacements(text, change.replacements, `changes for ${change.path}`);
    const nextBuffer = Buffer.from(next, "utf8");
    if (nextBuffer.byteLength > MAX_FILE_BYTES) throw new Error(`${change.path} exceeds ${MAX_FILE_BYTES} bytes after replacement`);
    finalSnapshot.files.set(change.path, nextBuffer);
    const upstreamBase = upstreamSnapshot.files.get(change.path);
    if (!upstreamBase) throw new Error(`upstream Odai bundle is missing ${change.path}`);
    const patch = patches.get(change.path) ?? {
      path: change.path,
      baseSha256: sha256(upstreamBase),
      replacements: [],
    };
    patch.replacements.push(...change.replacements.map((replacement) => ({ ...replacement })));
    patches.set(change.path, patch);
  }

  const normalized: Readonly<EvolutionPatch>[] = [];
  for (const patch of [...patches.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const base = upstreamSnapshot.files.get(patch.path);
    const result = finalSnapshot.files.get(patch.path);
    if (!base || !result) throw new Error(`Odai evolution patch path disappeared: ${patch.path}`);
    if (sha256(base) === sha256(result)) continue;
    normalized.push(Object.freeze({
      path: patch.path,
      baseSha256: sha256(base),
      resultSha256: sha256(result),
      replacements: Object.freeze(patch.replacements.map((replacement) => Object.freeze({ ...replacement }))),
    }));
  }
  if (normalized.length === 0) return { status: "absorbed", snapshot: finalSnapshot, patches: Object.freeze([]) };
  return { status: "candidate", snapshot: finalSnapshot, patches: Object.freeze(normalized) };
}

function normalizePatchMetadata(
  value: unknown,
  manifest: { readonly requiredFiles: readonly string[] },
): readonly Readonly<EvolutionPatch>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new TypeError("Odai evolution metadata.patches must contain 1-20 patches");
  }
  const paths = new Set<string>();
  return Object.freeze(value.map((raw, index) => {
    const patch = assertPlainObject(raw, `Odai evolution metadata.patches[${index}]`);
    assertExactFields(patch, ["path", "baseSha256", "resultSha256", "replacements"], `Odai evolution metadata.patches[${index}]`);
    const path = assertEvolvablePath(patch.path, manifest, `Odai evolution metadata.patches[${index}].path`);
    if (paths.has(path)) throw new TypeError(`Odai evolution metadata contains duplicate patch path ${path}`);
    paths.add(path);
    if (!Array.isArray(patch.replacements) || patch.replacements.length === 0 || patch.replacements.length > 100) {
      throw new TypeError(`Odai evolution metadata.patches[${index}].replacements is invalid`);
    }
    return Object.freeze({
      path,
      baseSha256: exactDigest(patch.baseSha256, `Odai evolution metadata.patches[${index}].baseSha256`),
      resultSha256: exactDigest(patch.resultSha256, `Odai evolution metadata.patches[${index}].resultSha256`),
      replacements: Object.freeze(patch.replacements.map((rawReplacement, replacementIndex) => {
        const replacement = assertPlainObject(rawReplacement, `Odai evolution metadata.patches[${index}].replacements[${replacementIndex}]`);
        assertExactFields(replacement, ["oldString", "newString"], `Odai evolution metadata.patches[${index}].replacements[${replacementIndex}]`);
        const oldString = assertUtf8String(replacement.oldString, `Odai evolution metadata.patches[${index}].replacements[${replacementIndex}].oldString`);
        const newString = assertUtf8String(replacement.newString, `Odai evolution metadata.patches[${index}].replacements[${replacementIndex}].newString`);
        if (!oldString || oldString === newString) throw new TypeError(`Odai evolution metadata.patches[${index}].replacements[${replacementIndex}] is invalid`);
        return Object.freeze({ oldString, newString });
      })),
    });
  }));
}

function normalizeGenerationAuthorization(value: unknown): Readonly<GenerationAuthorization> {
  const authorization = assertPlainObject(value, "Odai evolution generation metadata.authorization");
  assertExactFields(authorization, ["action", "phrase", "turn", "eventSeq", "messageId"], "Odai evolution generation metadata.authorization");
  if (authorization.action !== "propose" && authorization.action !== "rebase") {
    throw new TypeError("Odai evolution generation metadata.authorization.action is invalid");
  }
  if (typeof authorization.turn !== "number" || !Number.isSafeInteger(authorization.turn) || authorization.turn < 0) {
    throw new TypeError("Odai evolution generation metadata.authorization.turn must be a non-negative integer");
  }
  if (typeof authorization.eventSeq !== "number" || !Number.isSafeInteger(authorization.eventSeq) || authorization.eventSeq < 0) {
    throw new TypeError("Odai evolution generation metadata.authorization.eventSeq must be a non-negative integer");
  }
  return Object.freeze({
    action: authorization.action,
    phrase: nonEmptyString(authorization.phrase, "Odai evolution generation metadata.authorization.phrase", 200),
    turn: authorization.turn,
    eventSeq: authorization.eventSeq,
    messageId: nonEmptyString(authorization.messageId, "Odai evolution generation metadata.authorization.messageId", 200),
  });
}

function generationIdentity(metadata: Omit<GenerationMetadata, "generationId">): UnknownRecord {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    parentGenerationId: metadata.parentGenerationId ?? null,
    createdAt: metadata.createdAt,
    objective: metadata.objective,
    ...(metadata.authorization ? {
      authorization: {
        action: metadata.authorization.action,
        phrase: metadata.authorization.phrase,
        turn: metadata.authorization.turn,
        eventSeq: metadata.authorization.eventSeq,
        messageId: metadata.authorization.messageId,
      },
    } : {}),
    base: {
      source: metadata.base.source,
      provider: metadata.base.provider,
      skillVersion: metadata.base.skillVersion,
      runtimeContract: metadata.base.runtimeContract,
      digest: metadata.base.digest,
    },
    result: {
      skillVersion: metadata.result.skillVersion,
      runtimeContract: metadata.result.runtimeContract,
      digest: metadata.result.digest,
    },
    patches: metadata.patches.map((patch) => ({
      path: patch.path,
      baseSha256: patch.baseSha256,
      resultSha256: patch.resultSha256,
      replacements: patch.replacements.map((replacement) => ({
        oldString: replacement.oldString,
        newString: replacement.newString,
      })),
    })),
  };
}

function generationIdFor(metadata: Omit<GenerationMetadata, "generationId">): string {
  return sha256(Buffer.from(JSON.stringify(generationIdentity(metadata)), "utf8"));
}

function normalizeGenerationMetadata(value: unknown, expectedId: string): InitialGenerationMetadata {
  const metadata = assertPlainObject(value, "Odai evolution generation metadata");
  assertExactFields(metadata, ["schemaVersion", "generationId", "parentGenerationId", "createdAt", "objective", "authorization", "base", "result", "patches"], "Odai evolution generation metadata");
  if (metadata.schemaVersion !== STORE_SCHEMA_VERSION) throw new TypeError("Odai evolution generation metadata schema is unsupported");
  const generationId = safeGenerationId(metadata.generationId, "Odai evolution generation metadata.generationId");
  if (generationId !== expectedId) throw new Error(`Odai evolution generation directory ${expectedId} contains metadata for ${generationId}`);
  const parentGenerationId = metadata.parentGenerationId === undefined
    ? undefined
    : safeGenerationId(metadata.parentGenerationId, "Odai evolution generation metadata.parentGenerationId");
  if (parentGenerationId === generationId) throw new Error("Odai evolution generation cannot parent itself");
  const base = assertPlainObject(metadata.base, "Odai evolution generation metadata.base");
  const result = assertPlainObject(metadata.result, "Odai evolution generation metadata.result");
  assertExactFields(base, ["source", "provider", "skillVersion", "runtimeContract", "digest"], "Odai evolution generation metadata.base");
  assertExactFields(result, ["skillVersion", "runtimeContract", "digest"], "Odai evolution generation metadata.result");
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    generationId,
    ...(parentGenerationId ? { parentGenerationId } : {}),
    createdAt: validTimestamp(metadata.createdAt, "Odai evolution generation metadata.createdAt"),
    objective: nonEmptyString(metadata.objective, "Odai evolution generation metadata.objective", MAX_OBJECTIVE_CHARS),
    ...(metadata.authorization === undefined ? {} : { authorization: normalizeGenerationAuthorization(metadata.authorization) }),
    base: {
      source: nonEmptyString(base.source, "Odai evolution generation metadata.base.source"),
      provider: nonEmptyString(base.provider, "Odai evolution generation metadata.base.provider"),
      skillVersion: nonEmptyString(base.skillVersion, "Odai evolution generation metadata.base.skillVersion"),
      runtimeContract: base.runtimeContract,
      digest: exactDigest(base.digest, "Odai evolution generation metadata.base.digest"),
    },
    result: {
      skillVersion: nonEmptyString(result.skillVersion, "Odai evolution generation metadata.result.skillVersion"),
      runtimeContract: result.runtimeContract,
      digest: exactDigest(result.digest, "Odai evolution generation metadata.result.digest"),
    },
    patches: metadata.patches,
  };
}

function walkTree(root: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Odai evolution bundle contains a symbolic link: ${path}`);
    if (entry.isDirectory()) found.push(...walkTree(resolve(root, entry.name), path));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`Odai evolution bundle contains an unsupported filesystem entry: ${path}`);
  }
  return found;
}

function assertExactBundleTree(root: string, manifest: SkillManifest): void {
  const expected = new Set(["manifest.json", ...manifest.requiredFiles]);
  const actual = walkTree(root);
  for (const path of actual) {
    if (!expected.has(path)) throw new Error(`Odai evolution bundle contains undeclared file ${path}`);
  }
  for (const path of expected) {
    if (!actual.includes(path)) throw new Error(`Odai evolution bundle is missing ${path}`);
  }
}

function generationAuthorizationProfile(
  baseSnapshot: Readonly<BundleSnapshot>,
  resultSnapshot: Readonly<BundleSnapshot>,
  patches: readonly EvolutionPatch[],
): Readonly<GenerationAuthorizationProfile> {
  const reasons = new Set<string>();
  const protectedGovernanceFiles = new Set([
    "SKILL.md",
    baseSnapshot.manifest.referenceFiles.dao,
    resultSnapshot.manifest.referenceFiles.dao,
  ]);
  for (const path of protectedGovernanceFiles) {
    const base = baseSnapshot.files.get(path);
    const result = resultSnapshot.files.get(path);
    if (!base || !result || !base.equals(result)) reasons.add(`protected-file:${path}`);
  }
  for (const patch of patches) {
    if (patch.replacements.some((replacement) => !replacement.newString.includes(replacement.oldString))) {
      reasons.add(`destructive-replacement:${patch.path}`);
    }
  }
  const breakingReasons = Object.freeze([...reasons].sort());
  return Object.freeze({
    level: breakingReasons.length > 0 ? "breaking" : "standard",
    breakingReasons,
  });
}

function activationPhrase(generationId: string, level: AuthorizationLevel): string {
  return `ACTIVATE${level === "breaking" ? " BREAKING" : ""} ODAI EVOLUTION ${generationId}`;
}

function validateGeneration(
  root: string,
  generationId: unknown,
  ancestry: ReadonlySet<string> = new Set<string>(),
): Readonly<ValidatedGeneration> {
  const id = safeGenerationId(generationId);
  if (ancestry.has(id)) throw new Error(`Odai evolution lineage contains a cycle at ${id}`);
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(id);
  requireStoreDirectory(root, "generations");
  const generationRoot = safePath(root, "generations", id);
  const stat = lstatSync(generationRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Odai evolution generation ${id} must be a regular directory`);
  const children = readdirSync(generationRoot).sort();
  if (JSON.stringify(children) !== JSON.stringify(["base", "bundle", METADATA_FILE].sort())) {
    throw new Error(`Odai evolution generation ${id} contains undeclared entries`);
  }
  const rawMetadata = readJsonFile(resolve(generationRoot, METADATA_FILE), `Odai evolution generation ${id} metadata`, MAX_METADATA_BYTES);
  const initial = normalizeGenerationMetadata(rawMetadata, id);
  const baseBundle = loadSkillBundle(resolve(generationRoot, "base/SKILL.md"), { source: "evolution-base", provider: "odai-evolution-store" });
  const resultBundle = loadSkillBundle(resolve(generationRoot, "bundle/SKILL.md"), { source: "evolution", provider: "odai-evolution-store" });
  assertExactBundleTree(resolve(generationRoot, "base"), baseBundle.manifest);
  assertExactBundleTree(resolve(generationRoot, "bundle"), resultBundle.manifest);
  if (baseBundle.digest !== initial.base.digest) throw new Error(`Odai evolution generation ${id} base digest does not match metadata`);
  if (resultBundle.digest !== initial.result.digest) {
    throw new Error(`Odai evolution generation ${id} result digest does not match metadata`);
  }
  if (JSON.stringify(manifestValue(baseBundle)) !== JSON.stringify(manifestValue(resultBundle))) {
    throw new Error(`Odai evolution generation ${id} changes the skill manifest`);
  }
  if (initial.base.skillVersion !== baseBundle.manifest.skillVersion
    || initial.base.runtimeContract !== baseBundle.manifest.runtimeContract
    || initial.result.skillVersion !== resultBundle.manifest.skillVersion
    || initial.result.runtimeContract !== resultBundle.manifest.runtimeContract) {
    throw new Error(`Odai evolution generation ${id} metadata does not match its manifests`);
  }
  const patches = normalizePatchMetadata(initial.patches, baseBundle.manifest);
  if (generationIdFor({ ...initial, patches }) !== id) {
    throw new Error(`Odai evolution generation ${id} identity does not cover its stored provenance`);
  }
  const baseSnapshot = snapshotBundle(baseBundle);
  const replay = cloneSnapshot(baseSnapshot);
  for (const patch of patches) {
    const baseContent = baseSnapshot.files.get(patch.path);
    if (!baseContent) throw new Error(`Odai evolution patch path is missing from base: ${patch.path}`);
    if (sha256(baseContent) !== patch.baseSha256) throw new Error(`Odai evolution patch ${patch.path} base digest is invalid`);
    const resultText = applyExactReplacements(utf8Text(baseContent, patch.path), patch.replacements, `Odai evolution patch ${patch.path}`);
    const resultContent = Buffer.from(resultText, "utf8");
    if (sha256(resultContent) !== patch.resultSha256) throw new Error(`Odai evolution patch ${patch.path} result digest is invalid`);
    replay.files.set(patch.path, resultContent);
  }
  const resultSnapshot = snapshotBundle(resultBundle);
  for (const path of baseBundle.manifest.requiredFiles) {
    const expected = replay.files.get(path);
    const actual = resultSnapshot.files.get(path);
    if (!expected || !actual || !expected.equals(actual)) throw new Error(`Odai evolution generation ${id} has an untracked change in ${path}`);
  }
  const authorization = generationAuthorizationProfile(baseSnapshot, resultSnapshot, patches);
  if (initial.parentGenerationId) validateGeneration(root, initial.parentGenerationId, nextAncestry);
  return Object.freeze({
    root: generationRoot,
    metadata: Object.freeze({
      ...initial,
      base: Object.freeze(initial.base),
      result: Object.freeze(initial.result),
      patches,
    }),
    baseBundle,
    resultBundle,
    baseSnapshot,
    resultSnapshot,
    authorization,
  });
}

function generationSummary(validated: ValidatedGeneration): Readonly<GenerationSummary> {
  return Object.freeze({
    generationId: validated.metadata.generationId,
    ...(validated.metadata.parentGenerationId ? { parentGenerationId: validated.metadata.parentGenerationId } : {}),
    createdAt: validated.metadata.createdAt,
    objective: validated.metadata.objective,
    ...(validated.metadata.authorization ? { creationAuthorization: validated.metadata.authorization } : {}),
    baseDigest: validated.metadata.base.digest,
    resultDigest: validated.metadata.result.digest,
    skillVersion: validated.metadata.result.skillVersion,
    runtimeContract: validated.metadata.result.runtimeContract,
    changedPaths: Object.freeze(validated.metadata.patches.map((patch) => patch.path)),
    authorizationLevel: validated.authorization.level,
    activationPhrase: activationPhrase(validated.metadata.generationId, validated.authorization.level),
    breakingReasons: validated.authorization.breakingReasons,
  });
}

function listGenerations(root: string): GenerationList {
  if (existsSync(root)) assertRegularDirectory(root, "Odai skill evolution root");
  const generationsRoot = resolve(root, "generations");
  if (!existsSync(generationsRoot)) return { generations: Object.freeze([]), diagnostics: Object.freeze([]) };
  assertRegularDirectory(generationsRoot, "Odai skill evolution generations directory");
  const generations: GenerationSummary[] = [];
  const diagnostics: GenerationDiagnostic[] = [];
  for (const entry of readdirSync(generationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DIGEST_PATTERN.test(entry.name)) {
      diagnostics.push(Object.freeze({ generationId: entry.name, error: "invalid generation entry" }));
      continue;
    }
    try {
      generations.push(generationSummary(validateGeneration(root, entry.name)));
    } catch (error) {
      diagnostics.push(Object.freeze({ generationId: entry.name, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  generations.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  diagnostics.sort((left, right) => left.generationId.localeCompare(right.generationId));
  return { generations: Object.freeze(generations), diagnostics: Object.freeze(diagnostics) };
}

function createGeneration(
  root: string,
  upstreamBundle: SkillBundle,
  finalSnapshot: Readonly<BundleSnapshot>,
  patches: readonly EvolutionPatch[],
  options: CreateGenerationOptions,
): CreateGenerationResult {
  const upstreamSnapshot = snapshotBundle(upstreamBundle);
  const generationsRoot = ensureStoreDirectory(root, "generations");
  const temporary = safePath(root, "generations", `.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeBundleSnapshot(resolve(temporary, "base"), upstreamSnapshot);
    writeBundleSnapshot(resolve(temporary, "bundle"), finalSnapshot);
    const baseBundle = loadSkillBundle(resolve(temporary, "base/SKILL.md"));
    const resultBundle = loadSkillBundle(resolve(temporary, "bundle/SKILL.md"));
    if (baseBundle.digest !== upstreamBundle.digest) throw new Error("Odai evolution base changed while creating a candidate");
    if (resultBundle.digest === baseBundle.digest) return { status: "absorbed" };
    const identity: Omit<GenerationMetadata, "generationId"> = {
      schemaVersion: STORE_SCHEMA_VERSION,
      ...(options.parentGenerationId ? { parentGenerationId: options.parentGenerationId } : {}),
      createdAt: options.now(),
      objective: options.objective,
      authorization: options.authorization,
      base: {
        source: upstreamBundle.source,
        provider: upstreamBundle.provider,
        skillVersion: baseBundle.manifest.skillVersion,
        runtimeContract: baseBundle.manifest.runtimeContract,
        digest: baseBundle.digest,
      },
      result: {
        skillVersion: resultBundle.manifest.skillVersion,
        runtimeContract: resultBundle.manifest.runtimeContract,
        digest: resultBundle.digest,
      },
      patches,
    };
    const generationId = generationIdFor(identity);
    const metadata = { generationId, ...identity };
    writeDurableFile(resolve(temporary, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
    syncDirectory(temporary);
    const destination = safePath(root, "generations", generationId);
    if (existsSync(destination)) {
      const existing = validateGeneration(root, generationId);
      return { status: "reused", generation: existing };
    }
    renameSync(temporary, destination);
    syncDirectory(generationsRoot);
    return { status: "candidate", generation: validateGeneration(root, generationId) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function appendStateChange(
  root: string,
  state: Readonly<SkillEvolutionState>,
  action: StateAction,
  target: string | undefined,
  evidence: readonly string[],
  now: () => string,
): Readonly<SkillEvolutionState> {
  const from = state.activeGenerationId ?? null;
  const to = target ?? null;
  if (from === to) return state;
  const event: HistoryEvent = {
    revision: state.revision + 1,
    action,
    from,
    to,
    at: now(),
    evidence,
  };
  const next = {
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: event.revision,
    ...(target ? { activeGenerationId: target } : {}),
    history: [...state.history, event],
  };
  writeJsonAtomic(resolve(root, STATE_FILE), next);
  return readSkillEvolutionState(root);
}

function preserveConflict(
  root: string,
  generation: ValidatedGeneration,
  upstreamBundle: SkillBundle,
  conflicts: readonly RebaseConflict[],
  authorization: HumanAuthorization,
  now: () => string,
): Readonly<ConflictReport> {
  const attemptId = randomUUID();
  const conflictsRoot = ensureStoreDirectory(root, "conflicts");
  const temporary = safePath(root, "conflicts", `.tmp-${process.pid}-${attemptId}`);
  const destination = safePath(root, "conflicts", attemptId);
  try {
    for (const path of new Set(conflicts.map((conflict) => conflict.path))) {
      const base = generation.baseSnapshot.files.get(path);
      const ours = generation.resultSnapshot.files.get(path);
      const theirs = upstreamBundle.manifest.requiredFiles.includes(path) ? readSkillBundleFile(upstreamBundle, path) : undefined;
      if (base) writeDurableFile(resolve(temporary, "base", ...path.split("/")), base);
      if (ours) writeDurableFile(resolve(temporary, "ours", ...path.split("/")), ours);
      if (theirs) writeDurableFile(resolve(temporary, "theirs", ...path.split("/")), theirs);
    }
    const report: ConflictReport = {
      schemaVersion: STORE_SCHEMA_VERSION,
      attemptId,
      createdAt: now(),
      generationId: generation.metadata.generationId,
      oldBaseDigest: generation.metadata.base.digest,
      upstreamDigest: upstreamBundle.digest,
      authorization,
      conflicts,
    };
    writeDurableFile(resolve(temporary, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    syncDirectory(temporary);
    renameSync(temporary, destination);
    syncDirectory(conflictsRoot);
    return Object.freeze(report);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function rebaseGeneration(
  root: string,
  generation: ValidatedGeneration,
  upstreamBundle: SkillBundle,
  authorization: GenerationAuthorization,
  now: () => string,
): RebaseGenerationResult {
  if (generation.metadata.base.digest === upstreamBundle.digest) return { status: "up-to-date", generation };
  const upstreamSnapshot = snapshotBundle(upstreamBundle);
  const result = cloneSnapshot(upstreamSnapshot);
  const nextPatches: Readonly<EvolutionPatch>[] = [];
  const conflicts: RebaseConflict[] = [];

  for (const patch of generation.metadata.patches) {
    const upstreamContent = upstreamSnapshot.files.get(patch.path);
    if (!upstreamContent) {
      conflicts.push({ path: patch.path, replacement: 0, reason: "path-removed-upstream" });
      continue;
    }
    let text = utf8Text(upstreamContent, patch.path);
    const retained: Replacement[] = [];
    for (const [index, replacement] of patch.replacements.entries()) {
      const oldCount = countOccurrences(text, replacement.oldString);
      if (oldCount === 1) {
        text = text.replace(replacement.oldString, replacement.newString);
        retained.push(replacement);
        continue;
      }
      const alreadyApplied = replacement.newString === ""
        ? oldCount === 0
        : oldCount === 0 && countOccurrences(text, replacement.newString) === 1;
      if (!alreadyApplied) {
        conflicts.push({
          path: patch.path,
          replacement: index,
          reason: oldCount > 1 ? "old-context-ambiguous" : "old-context-missing",
        });
      }
    }
    if (conflicts.some((conflict) => conflict.path === patch.path)) continue;
    const content = Buffer.from(text, "utf8");
    result.files.set(patch.path, content);
    if (sha256(content) !== sha256(upstreamContent)) {
      nextPatches.push(Object.freeze({
        path: patch.path,
        baseSha256: sha256(upstreamContent),
        resultSha256: sha256(content),
        replacements: Object.freeze(retained.map((replacement) => Object.freeze({ ...replacement }))),
      }));
    }
  }

  if (conflicts.length > 0) {
    return { status: "conflict", report: preserveConflict(root, generation, upstreamBundle, conflicts, authorization, now) };
  }
  if (nextPatches.length === 0) return { status: "absorbed" };
  return createGeneration(root, upstreamBundle, result, Object.freeze(nextPatches), {
    parentGenerationId: generation.metadata.generationId,
    objective: `Rebase ${generation.metadata.generationId.slice(0, 12)}: ${generation.metadata.objective}`.slice(0, MAX_OBJECTIVE_CHARS),
    authorization,
    now,
  });
}

function upstreamSelection(selection: EvolutionSelection): EvolutionSelection {
  return selection?.upstream ?? selection;
}

function selectionSummary(selection: EvolutionSelection): Readonly<UnknownRecord> {
  return Object.freeze({
    source: selection.bundle.source,
    skillVersion: selection.bundle.manifest.skillVersion,
    runtimeContract: selection.bundle.manifest.runtimeContract,
    digest: selection.bundle.digest,
  });
}

export function applySkillEvolutionSelection(
  upstream: EvolutionSelection,
  root: string,
  options: { disabled?: boolean } = {},
): EvolutionSelection {
  if (!upstream?.bundle) throw new TypeError("an upstream Odai skill selection is required");
  if (options.disabled === true) {
    return Object.freeze({
      ...upstream,
      evolution: Object.freeze({ status: "disabled", hostOverride: true }),
      upstream,
    });
  }
  let state;
  try {
    state = readSkillEvolutionState(root);
  } catch (error) {
    return Object.freeze({
      ...upstream,
      status: "fallback",
      reasonCode: "evolution-state-invalid",
      detail: error instanceof Error ? error.message : String(error),
      evolution: Object.freeze({ status: "fallback", reasonCode: "evolution-state-invalid" }),
      upstream,
    });
  }
  if (!state.activeGenerationId) return upstream;
  let generation;
  try {
    generation = validateGeneration(root, state.activeGenerationId);
  } catch (error) {
    return Object.freeze({
      ...upstream,
      status: "fallback",
      reasonCode: "evolution-generation-invalid",
      detail: error instanceof Error ? error.message : String(error),
      evolution: Object.freeze({
        status: "fallback",
        reasonCode: "evolution-generation-invalid",
        generationId: state.activeGenerationId,
      }),
      upstream,
    });
  }
  if (generation.metadata.base.source !== "bundled" || upstream.bundle.source !== "bundled") {
    return Object.freeze({
      ...upstream,
      status: "fallback",
      reasonCode: "evolution-scope-mismatch",
      detail: `active evolution is based on ${generation.metadata.base.source}, current upstream is ${upstream.bundle.source}`,
      evolution: Object.freeze({
        status: "fallback",
        reasonCode: "evolution-scope-mismatch",
        generationId: state.activeGenerationId,
      }),
      upstream,
    });
  }
  if (generation.resultBundle.manifest.runtimeContract !== ODAI_RUNTIME_CONTRACT) {
    return Object.freeze({
      ...upstream,
      status: "fallback",
      reasonCode: "evolution-runtime-contract-mismatch",
      detail: `active evolution runtimeContract ${generation.resultBundle.manifest.runtimeContract} is incompatible with ${ODAI_RUNTIME_CONTRACT}`,
      evolution: Object.freeze({
        status: "fallback",
        reasonCode: "evolution-runtime-contract-mismatch",
        generationId: state.activeGenerationId,
      }),
      upstream,
    });
  }
  const rebaseRequired = generation.metadata.base.digest !== upstream.bundle.digest;
  return Object.freeze({
    ...upstream,
    status: "selected",
    reasonCode: "evolution-active",
    bundle: generation.resultBundle,
    evolution: Object.freeze({
      status: "active",
      generationId: state.activeGenerationId,
      baseDigest: generation.metadata.base.digest,
      upstreamDigest: upstream.bundle.digest,
      rebaseRequired,
    }),
    upstream,
  });
}

function requireController(execution: ToolExecution): asserts execution is ToolExecution & { agent: DshAgent } {
  if (!execution.agent) throw new Error("odai_skill_evolution requires an owning agent session");
  const header = execution.agent.session?.header;
  const delegationDepth = header?.delegationDepth;
  if (header?.origin === "subagent" || (typeof delegationDepth === "number" && Number.isSafeInteger(delegationDepth) && delegationDepth > 0)) {
    throw new Error("child agents may not inspect or change Odai skill evolution");
  }
}

function requireHumanAuthorization<TAction extends AuthorizationAction>(
  agent: DshAgent,
  phrase: string,
  action: TAction,
): Readonly<HumanAuthorization & { action: TAction }> {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) throw new Error(`current open turn must contain exactly this direct human message: ${phrase}`);
  let boundaryIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn/start" || events[index]?.type === "turn/end") {
      boundaryIndex = index;
      break;
    }
  }
  const boundary = events[boundaryIndex];
  const boundaryTurn = boundary?.data?.turn;
  if (boundary?.type !== "turn/start" || typeof boundaryTurn !== "number" || !Number.isSafeInteger(boundaryTurn) || boundaryTurn < 0) {
    throw new Error(`current open turn must contain exactly this direct human message: ${phrase}`);
  }
  let event: DshEvent | undefined;
  for (let index = events.length - 1; index > boundaryIndex; index -= 1) {
    const candidate = events[index];
    if (candidate?.type === "user/message"
      && candidate.data?.role === "user"
      && isUnknownRecord(candidate.data?.source)
      && candidate.data.source.kind === "user") {
      event = candidate;
      break;
    }
  }
  const message = event?.data;
  const block = Array.isArray(message?.content) && message.content.length === 1 ? message.content[0] : undefined;
  const eventSeq = event?.seq;
  if (!event
    || typeof eventSeq !== "number"
    || !Number.isSafeInteger(eventSeq)
    || eventSeq < 0
    || !message
    || typeof message.id !== "string"
    || message.id.length === 0
    || message.id.length > 200
    || block?.type !== "text"
    || typeof block.text !== "string"
    || block.text !== phrase) {
    throw new Error(`current open turn must contain exactly this direct human message: ${phrase}`);
  }
  return Object.freeze({
    action,
    phrase,
    turn: boundaryTurn,
    eventSeq,
    messageId: message.id,
  });
}

function authorizationEvidence(authorization: HumanAuthorization): readonly string[] {
  return Object.freeze([
    `direct-human-action:${authorization.action}`,
    `direct-human-turn:${authorization.turn}`,
    `direct-human-event-seq:${authorization.eventSeq}`,
    `direct-human-message-id:${authorization.messageId}`,
    `direct-human-phrase:${authorization.phrase}`,
  ]);
}

function actionAuthorizationPhrase(
  action: "rebase" | "rollback" | "deactivate",
  current?: string,
  target?: string,
): string {
  if (action === "rebase") return `REBASE ODAI EVOLUTION ${target}`;
  if (action === "rollback") return `ROLLBACK ODAI EVOLUTION ${current} TO ${target ?? "BUNDLED"}`;
  if (action === "deactivate") return `DEACTIVATE ODAI EVOLUTION ${current}`;
  throw new TypeError(`unsupported Odai evolution authorization action: ${action}`);
}

function proposalAuthorization(
  objective: string,
  expectedBundleDigest: string,
  changes: readonly ProposedChange[],
): Readonly<{ proposalDigest: string; proposalPhrase: string }> {
  const proposalDigest = sha256(Buffer.from(JSON.stringify({
    objective,
    expectedBundleDigest,
    changes: changes.map((change) => ({
      path: change.path,
      expectedSha256: change.expectedSha256,
      replacements: change.replacements.map((replacement) => ({
        oldString: replacement.oldString,
        newString: replacement.newString,
      })),
    })),
  }), "utf8"));
  return Object.freeze({
    proposalDigest,
    proposalPhrase: `PROPOSE ODAI EVOLUTION ${proposalDigest}`,
  });
}

function assertActionArguments(
  args: EvolutionToolArguments,
  action: EvolutionAction,
  allowed: readonly string[],
): void {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("arguments must be an object");
  if (args.action !== action) throw new TypeError(`action must be ${action}`);
  assertExactFields(args, ["action", ...allowed], `${action} arguments`);
}

function activeSummary(
  root: string,
  state: SkillEvolutionState,
  currentUpstream: EvolutionSelection,
): Readonly<GenerationSummary & { rebaseRequired: boolean }> | undefined {
  if (!state.activeGenerationId) return undefined;
  const generation = validateGeneration(root, state.activeGenerationId);
  return Object.freeze({
    ...generationSummary(generation),
    rebaseRequired: generation.metadata.base.digest !== currentUpstream.bundle.digest,
  });
}

function renderEvolutionResult(value: EvolutionToolResult): string {
  if (value.action === "show") {
    if (value.status === "inactive") return "No Odai user evolution is active.";
    if (value.status === "disabled") return "Odai user evolution is bypassed by ODAI_DISABLE_EVOLUTION=1.";
    if (value.status === "fallback") return `Odai user evolution is unavailable: ${value.error}`;
    return value.active
      ? `Active Odai evolution ${value.active.generationId}; rebaseRequired=${String(value.active.rebaseRequired)}.`
      : "No Odai user evolution is active.";
  }
  if (value.action === "inspect") return `Inspected ${value.path} from bundle ${value.bundleDigest}.`;
  if (value.action === "propose" && value.status === "authorization-required") {
    return `No candidate was written. To authorize this exact proposal, the current direct human message must be exactly: ${value.proposalPhrase}`;
  }
  if (["propose", "rebase"].includes(value.action) && ["candidate", "reused"].includes(value.status)) {
    return value.generation
      ? `Created inactive Odai evolution candidate ${value.generation.generationId}. Explicit activation is still required.`
      : "Created an inactive Odai evolution candidate. Explicit activation is still required.";
  }
  if (value.status === "conflict") return `Odai evolution rebase conflict ${value.attemptId}; the active generation was not changed.`;
  if (value.status === "absorbed") return "The proposed evolution is already represented by the upstream bundle; no generation was created.";
  if (value.status === "up-to-date") return "The evolution generation already uses the current upstream digest.";
  if (value.action === "validate") {
    if (!value.generation) return "Odai evolution validation returned no generation.";
    const reasons = value.generation.breakingReasons.length > 0
      ? ` Breaking reasons: ${value.generation.breakingReasons.join(", ")}.`
      : "";
    return `Validated Odai evolution generation ${value.generation.generationId} (${value.generation.authorizationLevel}).${reasons} To authorize activation, the latest direct human message must be exactly: ${value.generation.activationPhrase}`;
  }
  if (["activate", "rollback"].includes(value.action)) return `Odai evolution ${value.activeGenerationId ?? "bundled upstream"} will become active from the next user turn.`;
  if (value.action === "deactivate") return "Odai user evolution is deactivated from the next user turn.";
  return `Odai evolution ${value.action}: ${value.status}.`;
}

export function createSkillEvolutionTool(
  root: string,
  options: CreateEvolutionToolOptions = {},
): RuntimeTool<EvolutionToolArguments, EvolutionToolResult> {
  const currentSelectionFor: (agent: DshAgent) => EvolutionSelection | undefined = typeof options.currentSelectionFor === "function"
    ? options.currentSelectionFor
    : () => options.selection;
  const onChanged = typeof options.onChanged === "function" ? options.onChanged : () => {};
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const disabled = options.disabled === true;

  const current = (agent: DshAgent): EvolutionSelection => {
    const selection = currentSelectionFor(agent);
    if (!selection?.bundle) throw new Error("current Odai skill selection is unavailable");
    return selection;
  };
  const requireEnabled = () => {
    if (disabled) throw new Error("Odai skill evolution is disabled by ODAI_DISABLE_EVOLUTION=1");
  };

  return {
    name: "odai_skill_evolution",
    description: [
      "Inspect and manage immutable user evolution generations for Odai governance Markdown only when the user asks.",
      "Every write action requires an action- and content-bound phrase as the only block in the current open turn's latest genuine user message; model text and model-supplied evidence never authorize mutation.",
      "Propose and rebase create inactive candidates. Any SKILL.md or manifest-owned dao reference change, or a replacement that removes its old text, requires the distinct ACTIVATE BREAKING phrase. Active-pointer changes start next turn.",
      "Never change manifests, scripts, runtime code, or installed package files.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["show", "inspect", "propose", "validate", "activate", "rebase", "rollback", "deactivate"] },
        path: { type: "string" },
        generationId: { type: "string" },
        objective: { type: "string" },
        expectedBundleDigest: { type: "string" },
        expectedUpstreamDigest: { type: "string" },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "expectedSha256", "replacements"],
            properties: {
              path: { type: "string" },
              expectedSha256: { type: "string" },
              replacements: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["oldString", "newString"],
                  properties: { oldString: { type: "string" }, newString: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        required: ["action", "status"],
        properties: { action: { type: "string" }, status: { type: "string" } },
      },
      render(_args, value) {
        return [{ type: "text", text: renderEvolutionResult(value) }];
      },
    },
    execute(args, execution) {
      requireController(execution);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("arguments must be an object");
      const selection = current(execution.agent);
      const upstream = upstreamSelection(selection);

      if (args.action === "show") {
        assertActionArguments(args, "show", []);
        if (disabled) return Promise.resolve(Object.freeze({ action: "show", status: "disabled", root, upstream: selectionSummary(upstream) }));
        let state;
        try {
          state = readSkillEvolutionState(root);
          const listed = listGenerations(root);
          const active = activeSummary(root, state, upstream);
          return Promise.resolve(Object.freeze({
            action: "show",
            status: active ? "active" : "inactive",
            root,
            upstream: selectionSummary(upstream),
            ...(active ? { active } : {}),
            generations: listed.generations,
            diagnostics: listed.diagnostics,
          }));
        } catch (error) {
          return Promise.resolve(Object.freeze({
            action: "show",
            status: "fallback",
            root,
            upstream: selectionSummary(upstream),
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      if (args.action === "inspect") {
        assertActionArguments(args, "inspect", ["path", "generationId"]);
        const bundle = args.generationId === undefined
          ? selection.bundle
          : validateGeneration(root, safeGenerationId(args.generationId)).resultBundle;
        const path = assertEvolvablePath(args.path, bundle.manifest);
        const content = readSkillBundleFile(bundle, path);
        return Promise.resolve(Object.freeze({
          action: "inspect",
          status: "inspected",
          path,
          source: args.generationId ? "generation" : "effective",
          bundleDigest: bundle.digest,
          upstreamDigest: upstream.bundle.digest,
          sha256: sha256(content),
          content: utf8Text(content, path),
          rebaseRequired: selection.evolution?.rebaseRequired === true,
        }));
      }

      requireEnabled();
      if (args.action === "propose") {
        assertActionArguments(args, "propose", ["objective", "expectedBundleDigest", "changes"]);
        if (upstream.bundle.source !== "bundled") throw new Error("Odai evolution proposals require the bundled upstream source");
        if (selection.evolution?.rebaseRequired === true) throw new Error("active Odai evolution requires rebase before another proposal");
        const expectedBundleDigest = exactDigest(args.expectedBundleDigest, "expectedBundleDigest");
        if (expectedBundleDigest !== selection.bundle.digest) throw new Error("expectedBundleDigest does not match the current immutable turn snapshot");
        const objective = nonEmptyString(args.objective, "objective", MAX_OBJECTIVE_CHARS);
        const changes = normalizeProposedChanges(args.changes, selection.bundle.manifest);
        const proposal = proposalAuthorization(objective, expectedBundleDigest, changes);
        let humanAuthorization;
        try {
          humanAuthorization = requireHumanAuthorization(execution.agent, proposal.proposalPhrase, "propose");
        } catch {
          return Promise.resolve(Object.freeze({
            action: "propose",
            status: "authorization-required",
            proposalDigest: proposal.proposalDigest,
            proposalPhrase: proposal.proposalPhrase,
          }));
        }
        const release = acquireOwnedStoreLock(resolve(root, STATE_FILE), "Odai skill evolution store");
        try {
          const state = readSkillEvolutionState(root);
          if ((state.activeGenerationId ?? undefined) !== (selection.evolution?.generationId ?? undefined)) {
            throw new Error("Odai evolution active pointer changed; retry from a new user turn");
          }
          const parent = state.activeGenerationId ? validateGeneration(root, state.activeGenerationId) : undefined;
          const upstreamSnapshot = snapshotBundle(upstream.bundle);
          const effectiveSnapshot = snapshotBundle(selection.bundle);
          const merged = mergePatchGroups(parent?.metadata.patches ?? [], changes, upstreamSnapshot, effectiveSnapshot);
          if (merged.status === "absorbed") return Promise.resolve(Object.freeze({ action: "propose", status: "absorbed" }));
          const created = createGeneration(root, upstream.bundle, merged.snapshot, merged.patches, {
            ...(parent ? { parentGenerationId: parent.metadata.generationId } : {}),
            objective,
            authorization: humanAuthorization,
            now,
          });
          if (created.status === "absorbed") {
            return Promise.resolve(Object.freeze({ action: "propose", status: "absorbed" }));
          }
          const result = Object.freeze({
            action: "propose",
            status: created.status,
            generation: generationSummary(created.generation),
            activeGenerationId: state.activeGenerationId,
          });
          onChanged(execution.agent, result);
          return Promise.resolve(result);
        } finally {
          release();
        }
      }

      if (args.action === "validate") {
        assertActionArguments(args, "validate", ["generationId"]);
        const generation = validateGeneration(root, safeGenerationId(args.generationId));
        return Promise.resolve(Object.freeze({ action: "validate", status: "valid", generation: generationSummary(generation) }));
      }

      if (args.action === "activate") {
        assertActionArguments(args, "activate", ["generationId", "expectedUpstreamDigest"]);
        const generationId = safeGenerationId(args.generationId);
        const expectedUpstreamDigest = exactDigest(args.expectedUpstreamDigest, "expectedUpstreamDigest");
        if (upstream.bundle.source !== "bundled" || upstream.bundle.digest !== expectedUpstreamDigest) {
          throw new Error("current bundled upstream does not match expectedUpstreamDigest");
        }
        const generation = validateGeneration(root, generationId);
        if (generation.metadata.base.digest !== upstream.bundle.digest) throw new Error("candidate must be rebased onto the current bundled upstream before activation");
        const expectedState = readSkillEvolutionState(root);
        if (expectedState.activeGenerationId === generationId) {
          return Promise.resolve(Object.freeze({ action: "activate", status: "already-active", activeGenerationId: generationId, requiresNextTurn: false }));
        }
        const authorization = requireHumanAuthorization(
          execution.agent,
          activationPhrase(generationId, generation.authorization.level),
          "activate",
        );
        const release = acquireOwnedStoreLock(resolve(root, STATE_FILE), "Odai skill evolution store");
        try {
          validateGeneration(root, generationId);
          const state = readSkillEvolutionState(root);
          if (state.revision !== expectedState.revision || state.activeGenerationId !== expectedState.activeGenerationId) {
            throw new Error("Odai evolution active pointer changed after authorization; retry from a new user turn");
          }
          const next = appendStateChange(root, state, "activate", generationId, authorizationEvidence(authorization), now);
          const result = Object.freeze({ action: "activate", status: "active", activeGenerationId: next.activeGenerationId, requiresNextTurn: true });
          onChanged(execution.agent, result);
          return Promise.resolve(result);
        } finally {
          release();
        }
      }

      if (args.action === "rebase") {
        assertActionArguments(args, "rebase", ["generationId", "expectedUpstreamDigest"]);
        const generationId = safeGenerationId(args.generationId);
        const expectedUpstreamDigest = exactDigest(args.expectedUpstreamDigest, "expectedUpstreamDigest");
        if (upstream.bundle.source !== "bundled" || upstream.bundle.digest !== expectedUpstreamDigest) {
          throw new Error("current bundled upstream does not match expectedUpstreamDigest");
        }
        validateGeneration(root, generationId);
        const authorization = requireHumanAuthorization(
          execution.agent,
          actionAuthorizationPhrase("rebase", undefined, generationId),
          "rebase",
        );
        const release = acquireOwnedStoreLock(resolve(root, STATE_FILE), "Odai skill evolution store");
        try {
          const lockedGeneration = validateGeneration(root, generationId);
          const rebased = rebaseGeneration(root, lockedGeneration, upstream.bundle, authorization, now);
          let result;
          if (rebased.status === "candidate" || rebased.status === "reused") {
            result = Object.freeze({ action: "rebase", status: rebased.status, generation: generationSummary(rebased.generation), activeGenerationId: readSkillEvolutionState(root).activeGenerationId });
          } else if (rebased.status === "conflict") {
            result = Object.freeze({ action: "rebase", status: "conflict", attemptId: rebased.report.attemptId, conflicts: Object.freeze(rebased.report.conflicts), activeGenerationId: readSkillEvolutionState(root).activeGenerationId });
          } else {
            result = Object.freeze({ action: "rebase", status: rebased.status, activeGenerationId: readSkillEvolutionState(root).activeGenerationId });
          }
          onChanged(execution.agent, result);
          return Promise.resolve(result);
        } finally {
          release();
        }
      }

      if (args.action === "rollback") {
        assertActionArguments(args, "rollback", ["generationId"]);
        const expectedState = readSkillEvolutionState(root);
        if (!expectedState.activeGenerationId) return Promise.resolve(Object.freeze({ action: "rollback", status: "inactive", requiresNextTurn: false }));
        let target = args.generationId === undefined ? undefined : safeGenerationId(args.generationId);
        if (target === undefined) {
          const previous = [...expectedState.history].reverse().find((event) => event.to === expectedState.activeGenerationId && event.from !== event.to);
          target = previous?.from ?? undefined;
        }
        if (target === expectedState.activeGenerationId) {
          return Promise.resolve(Object.freeze({ action: "rollback", status: "already-active", activeGenerationId: target, requiresNextTurn: false }));
        }
        if (target && !expectedState.history.some((event) => event.to === target)) {
          throw new Error(`rollback target ${target} was never an active Odai evolution generation`);
        }
        if (target) {
          const generation = validateGeneration(root, target);
          if (generation.resultBundle.manifest.runtimeContract !== ODAI_RUNTIME_CONTRACT) {
            throw new Error(`rollback target ${target} is incompatible with runtime contract ${ODAI_RUNTIME_CONTRACT}`);
          }
        }
        const authorization = requireHumanAuthorization(
          execution.agent,
          actionAuthorizationPhrase("rollback", expectedState.activeGenerationId, target),
          "rollback",
        );
        const release = acquireOwnedStoreLock(resolve(root, STATE_FILE), "Odai skill evolution store");
        try {
          const state = readSkillEvolutionState(root);
          if (state.revision !== expectedState.revision || state.activeGenerationId !== expectedState.activeGenerationId) {
            throw new Error("Odai evolution active pointer changed after authorization; retry from a new user turn");
          }
          const next = appendStateChange(root, state, "rollback", target, authorizationEvidence(authorization), now);
          const result = Object.freeze({ action: "rollback", status: target ? "active" : "inactive", activeGenerationId: next.activeGenerationId, requiresNextTurn: true });
          onChanged(execution.agent, result);
          return Promise.resolve(result);
        } finally {
          release();
        }
      }

      if (args.action === "deactivate") {
        assertActionArguments(args, "deactivate", []);
        const expectedState = readSkillEvolutionState(root);
        if (!expectedState.activeGenerationId) return Promise.resolve(Object.freeze({ action: "deactivate", status: "inactive", requiresNextTurn: false }));
        const authorization = requireHumanAuthorization(
          execution.agent,
          actionAuthorizationPhrase("deactivate", expectedState.activeGenerationId),
          "deactivate",
        );
        const release = acquireOwnedStoreLock(resolve(root, STATE_FILE), "Odai skill evolution store");
        try {
          const state = readSkillEvolutionState(root);
          if (state.revision !== expectedState.revision || state.activeGenerationId !== expectedState.activeGenerationId) {
            throw new Error("Odai evolution active pointer changed after authorization; retry from a new user turn");
          }
          appendStateChange(root, state, "deactivate", undefined, authorizationEvidence(authorization), now);
          const result = Object.freeze({ action: "deactivate", status: "inactive", requiresNextTurn: true });
          onChanged(execution.agent, result);
          return Promise.resolve(result);
        } finally {
          release();
        }
      }

      throw new TypeError("action must be show, inspect, propose, validate, activate, rebase, rollback, or deactivate");
    },
  };
}
