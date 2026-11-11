import { randomUUID } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireOwnedStoreLock } from "./store-lock.mjs";
import { resolveCompactionPressureMode, type CompactionPressureMode } from "./compaction-policy.mjs";

export interface CompactionPressureSnapshot {
  mode: CompactionPressureMode;
  valid: boolean;
  error?: string;
}
export function compactionPressurePath(compactionConfigPath: string): string { return `${compactionConfigPath}.pressure`; }
export function readCompactionPressure(path: string): CompactionPressureSnapshot {
  try {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return {mode: "host", valid: true};
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("pressure configuration must be an object");
    const stored = value as Record<string, unknown>;
    if (stored.schemaVersion !== 1 || stored.mode === undefined || Object.keys(stored).some(key => key !== "schemaVersion" && key !== "mode")) throw new TypeError("invalid pressure configuration schema");
    return {mode: resolveCompactionPressureMode(stored.mode), valid: true};
  } catch (error) {
    return {mode: "host", valid: false, error: error instanceof Error ? error.message : String(error)};
  }
}

/** Atomic independent storage leaves summarizer model configuration untouched. */
export function writeCompactionPressure(path: string, input: unknown): CompactionPressureSnapshot & {backupPath?: string} {
  if (input === undefined) throw new TypeError("pressure mode is required");
  const mode = resolveCompactionPressureMode(input);
  const release = acquireOwnedStoreLock(path, "Odai compaction pressure");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let backupPath: string | undefined;
  try {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    if (!readCompactionPressure(path).valid) {
      backupPath = `${path}.invalid-${randomUUID()}.bak`;
      copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
    }
    writeFileSync(temporary, `${JSON.stringify({schemaVersion: 1, mode}, null, 2)}\n`, {encoding: "utf8", mode: 0o600, flag: "wx"});
    renameSync(temporary, path);
    const result = readCompactionPressure(path);
    if (!result.valid || result.mode !== mode) throw new Error("pressure configuration verification failed");
    return {...result, ...(backupPath === undefined ? {} : {backupPath})};
  } finally {
    try { rmSync(temporary, {force: true}); } finally { release(); }
  }
}
