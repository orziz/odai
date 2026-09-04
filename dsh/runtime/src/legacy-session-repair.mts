import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import * as zlib from "node:zlib";

import { isUnknownRecord } from "./runtime-types.mjs";

const ZSTD_MAGIC = 4247762216;
const ODAI_EVENT_PREFIX = "odai/";
const LEGACY_ODAI_AUDIT_EVENT_TYPES = new Set<string>([
  "odai/governance-denied", "odai/research-decided", "odai/research-result", "odai/route-config-missing",
  "odai/route-decided", "odai/route-protection", "odai/route-result", "odai/route-upgrade",
  "odai/routing-configured", "odai/tool-observed",
]);

export interface ActiveDshProcess {
  readonly pid: number;
  readonly name: string;
}

interface ProcessRecord extends ActiveDshProcess {
  commandLine: unknown;
}

export interface LegacySessionRepairOptions {
  dshHome?: string;
  sessionRoot?: string;
  confirmDshStopped?: boolean;
  processScanner?: () => readonly ActiveDshProcess[];
}

export interface LegacySessionRepairFailure {
  path: string;
  error: string;
}

export interface LegacySessionRepairResult {
  dshHome: string;
  sessionRoot: string;
  scannedArtifacts: number;
  matchedArtifacts: number;
  matchedEvents: number;
  repairedArtifacts: number;
  repairedEvents: number;
  backupPaths: string[];
  tornArtifacts: string[];
  failures: LegacySessionRepairFailure[];
}

interface ZstdFrame { start: number; end: number }
interface FrameScan { frames: ZstdFrame[]; tornStart?: number }
interface JsonlTransform { text: string; repaired: number; torn: boolean }
interface ArtifactTransform { source: Buffer; buffer: Buffer; repaired: number; torn: boolean }

export function resolveDshHome(
  configured: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = configured ?? env.DSH_HOME ?? resolve(homedir(), ".dsh");
  if (typeof value !== "string" || value.trim() === "") throw new TypeError("DSH home must be a non-empty path");
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith(`~${sep}`)) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function isDshCommand(commandLine: unknown): boolean {
  if (typeof commandLine !== "string") return false;
  return /@deepseek-ai[\\/]dsh(?:[\\/]|$)/iu.test(commandLine)
    || /(?:^|[\s"'])[^\s"']*[\\/]dsh(?:\.cmd|\.mjs|\.js)?(?=$|[\s"'])/iu.test(commandLine)
    || /(?:^|[\s"'])dsh(?:\.cmd)?(?=$|[\s"'])/iu.test(commandLine);
}

function listWindowsProcesses(): ProcessRecord[] {
  const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true,
  }).trim();
  if (output === "") return [];
  const parsed: unknown = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
    if (!isUnknownRecord(entry)) return [];
    return [{
      pid: Number(entry.ProcessId),
      name: typeof entry.Name === "string" ? entry.Name : "unknown",
      commandLine: entry.CommandLine,
    }];
  });
}

function listPosixProcesses(): ProcessRecord[] {
  const output = execFileSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
  return output.split(/\r?\n/u).flatMap((line) => {
    const matched = /^\s*(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    return matched ? [{ pid: Number(matched[1]), name: matched[2], commandLine: matched[3] }] : [];
  });
}

export function listActiveDshProcesses(platform: NodeJS.Platform = process.platform): readonly ActiveDshProcess[] {
  const processes = platform === "win32" ? listWindowsProcesses() : listPosixProcesses();
  return processes
    .filter((entry) => Number.isSafeInteger(entry.pid) && entry.pid > 0 && entry.pid !== process.pid)
    .filter((entry) => isDshCommand(entry.commandLine))
    .map(({ pid, name }) => Object.freeze({ pid, name }));
}

function assertDshStopped(options: LegacySessionRepairOptions): void {
  let active: readonly ActiveDshProcess[];
  try {
    const scanner = options.processScanner ?? listActiveDshProcesses;
    active = scanner();
  } catch {
    throw new Error("cannot verify that DSH is stopped; run the repair from a normal terminal with permission to inspect local process command lines");
  }
  if (!Array.isArray(active)) throw new Error("DSH process scanner returned an invalid result");
  if (active.length > 0) {
    const owners = active.map((entry) => `${entry.name ?? "dsh"} (pid ${entry.pid ?? "unknown"})`).join(", ");
    throw new Error(`refusing to rewrite session artifacts while DSH is running: ${owners}`);
  }
}

function listSessionArtifacts(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && (entry.name === "session.jsonl" || entry.name === "session.jsonl.zstd")) found.push(path);
    }
  }
  return found.sort();
}

function transformLine(line: string): { line: string; repaired: number } {
  if (line === "") return { line, repaired: 0 };
  const parsed: unknown = JSON.parse(line);
  if (!isUnknownRecord(parsed)
    || typeof parsed.type !== "string"
    || !parsed.type.startsWith(ODAI_EVENT_PREFIX)
    || parsed.ignorable === true) return { line, repaired: 0 };
  if (!LEGACY_ODAI_AUDIT_EVENT_TYPES.has(parsed.type)) {
    throw new Error(`refusing unknown Odai session event type ${JSON.stringify(parsed.type)}; use a compatible Odai repair version`);
  }
  return { line: JSON.stringify({ ...parsed, ignorable: true }), repaired: 1 };
}

function transformCompleteJsonl(text: string): JsonlTransform {
  const output: string[] = [];
  let repaired = 0;
  let offset = 0;
  for (;;) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) break;
    const raw = text.slice(offset, newline);
    const carriageReturn = raw.endsWith("\r");
    const line = carriageReturn ? raw.slice(0, -1) : raw;
    const transformed = transformLine(line);
    output.push(transformed.line, carriageReturn ? "\r\n" : "\n");
    repaired += transformed.repaired;
    offset = newline + 1;
  }
  const tornTail = text.slice(offset);
  output.push(tornTail);
  return { text: output.join(""), repaired, torn: tornTail.length > 0 };
}

function scanZstdFrames(buffer: Buffer): FrameScan {
  const frames: ZstdFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function assertZstdAvailable(): void {
  if (typeof zlib.zstdCompressSync !== "function" || typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("this Node.js build cannot migrate Zstandard session logs");
  }
}

function compressZstdFrame(plaintext: Buffer): Buffer {
  return zlib.zstdCompressSync(plaintext, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
}

function transformZstd(source: Buffer): Omit<ArtifactTransform, "source"> {
  assertZstdAvailable();
  const { frames, tornStart } = scanZstdFrames(source);
  if (frames.length === 0) throw new Error("Zstandard session log has no complete header frame");
  const output: Buffer[] = [];
  let repaired = 0;
  for (const [index, frame] of frames.entries()) {
    const encoded = source.subarray(frame.start, frame.end);
    if (index === 0) {
      const header = zlib.zstdDecompressSync(encoded).toString("utf8");
      const headerValue: unknown = JSON.parse(header.trimEnd());
      if (!header.endsWith("\n") || !isUnknownRecord(headerValue) || headerValue.type !== "session") {
        throw new Error("Zstandard session log has an invalid header frame");
      }
      output.push(encoded);
      continue;
    }
    const plaintext = zlib.zstdDecompressSync(encoded);
    const transformed = transformCompleteJsonl(plaintext.toString("utf8"));
    if (transformed.torn) throw new Error("complete Zstandard event frame has an unterminated JSONL record");
    repaired += transformed.repaired;
    if (transformed.repaired === 0) { output.push(encoded); continue; }
    const replacementPlaintext = Buffer.from(transformed.text, "utf8");
    const replacement = compressZstdFrame(replacementPlaintext);
    if (!zlib.zstdDecompressSync(replacement).equals(replacementPlaintext)) throw new Error("Zstandard migration verification failed");
    output.push(replacement);
  }
  if (tornStart !== undefined) output.push(source.subarray(tornStart));
  return { buffer: repaired > 0 ? Buffer.concat(output) : source, repaired, torn: tornStart !== undefined };
}

function transformArtifact(path: string): ArtifactTransform {
  const source = readFileSync(path);
  if (path.endsWith(".zstd")) return { source, ...transformZstd(source) };
  const transformed = transformCompleteJsonl(source.toString("utf8"));
  return { source, buffer: transformed.repaired > 0 ? Buffer.from(transformed.text, "utf8") : source, repaired: transformed.repaired, torn: transformed.torn };
}

function writeDurably(path: string, content: Buffer, mode: number): void {
  const handle = openSync(path, "wx", mode);
  try {
    let offset = 0;
    while (offset < content.length) {
      const written = writeSync(handle, content, offset, content.length - offset);
      if (written <= 0) throw new Error(`short write while preparing session artifact: ${path}`);
      offset += written;
    }
    fsyncSync(handle);
  } finally { closeSync(handle); }
}

function syncDirectory(path: string): void {
  let handle: number | undefined;
  try { handle = openSync(path, "r"); fsyncSync(handle); } catch {} finally { if (handle !== undefined) closeSync(handle); }
}

function backupPathFor(path: string, source: Buffer): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${path}.odai-compat-${digest}.bak`;
}

function createVerifiedBackup(path: string, source: Buffer): string {
  const backupPath = backupPathFor(path, source);
  if (!existsSync(backupPath)) {
    copyFileSync(path, backupPath, fsConstants.COPYFILE_EXCL);
    const handle = openSync(backupPath, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    syncDirectory(dirname(path));
  }
  if (!readFileSync(backupPath).equals(source)) throw new Error(`session backup does not match the migration source: ${backupPath}`);
  return backupPath;
}

function replaceAtomically(path: string, source: Buffer, replacement: Buffer, backupPath: string): void {
  if (!readFileSync(path).equals(source)) throw new Error("session artifact changed while compatibility migration was preparing it; stop every DSH process and retry");
  const temporary = `${path}.odai-compat-${process.pid}-${randomUUID()}.tmp`;
  const mode = statSync(path).mode & 0o777;
  let published = false;
  try {
    writeDurably(temporary, replacement, mode);
    renameSync(temporary, path);
    published = true;
    syncDirectory(dirname(path));
    if (!readFileSync(path).equals(replacement)) throw new Error("published session artifact failed byte verification");
    const verified = transformArtifact(path);
    if (verified.repaired !== 0) throw new Error("published session artifact still contains required Odai events");
  } catch (error) {
    if (published) {
      const restore = `${path}.odai-restore-${process.pid}-${randomUUID()}.tmp`;
      try { writeDurably(restore, readFileSync(backupPath), mode); renameSync(restore, path); syncDirectory(dirname(path)); }
      finally { rmSync(restore, { force: true }); }
    }
    throw error;
  } finally { rmSync(temporary, { force: true }); }
}

function processLegacySessionLogs(options: LegacySessionRepairOptions, writeChanges: boolean): LegacySessionRepairResult {
  const dshHome = resolveDshHome(options.dshHome);
  const sessionRoot = resolve(options.sessionRoot ?? resolve(dshHome, "sessions"));
  const artifacts = listSessionArtifacts(sessionRoot);
  const result: LegacySessionRepairResult = {
    dshHome, sessionRoot, scannedArtifacts: artifacts.length, matchedArtifacts: 0, matchedEvents: 0,
    repairedArtifacts: 0, repairedEvents: 0, backupPaths: [], tornArtifacts: [], failures: [],
  };
  for (const path of artifacts) {
    try {
      const transformed = transformArtifact(path);
      if (transformed.torn) result.tornArtifacts.push(path);
      if (transformed.repaired === 0) continue;
      result.matchedArtifacts += 1;
      result.matchedEvents += transformed.repaired;
      if (!writeChanges) continue;
      const backupPath = createVerifiedBackup(path, transformed.source);
      replaceAtomically(path, transformed.source, transformed.buffer, backupPath);
      result.backupPaths.push(backupPath);
      result.repairedArtifacts += 1;
      result.repairedEvents += transformed.repaired;
    } catch (error) {
      result.failures.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function inspectLegacySessionLogs(options: LegacySessionRepairOptions = {}): LegacySessionRepairResult {
  return processLegacySessionLogs(options, false);
}

export function repairLegacySessionLogs(options: LegacySessionRepairOptions = {}): LegacySessionRepairResult {
  if (options.confirmDshStopped !== true) throw new Error("refusing to rewrite session artifacts until confirmDshStopped is true; stop every DSH process first");
  assertDshStopped(options);
  return processLegacySessionLogs(options, true);
}
