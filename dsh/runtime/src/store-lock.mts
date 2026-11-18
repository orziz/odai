import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

interface LockOwner {
  value: string;
  pid: number;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const value = readFileSync(lockPath, "utf8").trim();
    const separator = value.indexOf(":");
    const pid = Number(separator < 0 ? "" : value.slice(0, separator));
    return Number.isSafeInteger(pid) && pid > 0 && separator < value.length - 1
      ? { value, pid }
      : undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function parseTicketPid(entry: string): number | undefined {
  const separator = entry.indexOf(".");
  const pid = Number(separator <= 0 ? "" : entry.slice(0, separator));
  return Number.isSafeInteger(pid) && pid > 0 && separator < entry.length - 1 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function isOrphanedEmptyLock(lockPath: string, graceMs = 2000): boolean {
  try {
    const info = statSync(lockPath);
    return info.size === 0 && Date.now() - info.mtimeMs > graceMs;
  } catch {
    return false;
  }
}

function pathExists(targetPath: string): boolean {
  try {
    statSync(targetPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function writeLockFile(targetPath: string, owner: string, lockPathForError: string): void {
  const handle = openSync(targetPath, "wx", 0o600);
  try {
    const content = Buffer.from(`${owner}\n`, "utf8");
    if (writeSync(handle, content, 0, content.length) !== content.length) {
      throw new Error(`short write while acquiring Odai configuration lock: ${lockPathForError}`);
    }
    fsyncSync(handle);
  } catch (error) {
    closeSync(handle);
    rmSync(targetPath, { force: true });
    throw error;
  }
  closeSync(handle);
}

function linkOrCreateLock(ticketPath: string, lockPath: string, owner: string): void {
  try {
    linkSync(ticketPath, lockPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOSYS" || code === "ENOTSUP" || code === "EPERM") {
      writeLockFile(lockPath, owner, lockPath);
      return;
    }
    throw error;
  }
}

function releaseLock(lockPath: string, owner: string): void {
  const current = readLockOwner(lockPath);
  if (current === undefined) throw new Error(`Odai configuration lock disappeared before release: ${lockPath}`);
  if (current.value !== owner) throw new Error(`Odai configuration lock ownership changed before release: ${lockPath}`);
  rmSync(lockPath);
}

function listDirEntries(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function cleanupEmptyDir(dirPath: string): void {
  try {
    rmdirSync(dirPath);
  } catch {
    // Only remove empty directories; active tickets must remain untouched.
  }
}

function releaseClaimTicket(claimDir: string, ticketPath: string): void {
  rmSync(ticketPath, { force: true });
  cleanupEmptyDir(claimDir);
}

function acquireClaimTicket(
  claimDir: string,
  owner: string,
  lockPath: string,
  label: string,
): string {
  const busyMessage = `${label} lock acquisition is already in progress; retry the tool call`;
  for (const entry of listDirEntries(claimDir)) {
    const entryPath = `${claimDir}/${entry}`;
    const pid = parseTicketPid(entry);
    if (pid === undefined && !pathExists(entryPath)) continue;
    if (pid !== undefined ? processIsAlive(pid) : !isOrphanedEmptyLock(entryPath)) {
      throw new Error(busyMessage);
    }
    rmSync(entryPath, { force: true });
  }

  const ticketName = `${process.pid}.${randomUUID()}`;
  const ticketPath = `${claimDir}/${ticketName}`;
  let created = false;
  for (let attempt = 0; attempt < 8 && !created; attempt += 1) {
    try {
      mkdirSync(claimDir, { mode: 0o700 });
    } catch (mkdirError) {
      const code = errorCode(mkdirError);
      if (code !== "EEXIST" && code !== "ENOENT") throw mkdirError;
    }
    try {
      writeLockFile(ticketPath, owner, lockPath);
      created = true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  if (!created) throw new Error(busyMessage);

  try {
    const entries = readdirSync(claimDir);
    if (!entries.includes(ticketName)) {
      throw new Error(busyMessage);
    }
    for (const entry of entries) {
      if (entry === ticketName) continue;
      const entryPath = `${claimDir}/${entry}`;
      const pid = parseTicketPid(entry);
      if (pid === undefined && !pathExists(entryPath)) continue;
      if (pid !== undefined ? processIsAlive(pid) : !isOrphanedEmptyLock(entryPath)) {
        throw new Error(busyMessage);
      }
      rmSync(entryPath, { force: true });
    }
  } catch (error) {
    releaseClaimTicket(claimDir, ticketPath);
    throw error;
  }

  return ticketPath;
}

function reconcileLegacyClaimFile(claimPath: string, label: string): void {
  if (!pathExists(claimPath)) return;
  const current = readLockOwner(claimPath);
  if (current === undefined && !pathExists(claimPath)) return;
  if (current ? processIsAlive(current.pid) : !isOrphanedEmptyLock(claimPath)) {
    throw new Error(`${label} lock acquisition is already in progress; retry the tool call`);
  }
  rmSync(claimPath, { force: true });
}

export function acquireOwnedStoreLock(path: string, label: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const legacyClaimPath = `${lockPath}.claim`;
  const claimDir = `${lockPath}.claims`;
  const owner = `${process.pid}:${randomUUID()}`;
  const ticketPath = acquireClaimTicket(claimDir, owner, lockPath, label);

  try {
    reconcileLegacyClaimFile(legacyClaimPath, label);
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      try {
        linkOrCreateLock(ticketPath, lockPath, owner);
        acquired = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const current = readLockOwner(lockPath);
        if (current === undefined && !pathExists(lockPath)) {
          continue;
        }
        if (current ? processIsAlive(current.pid) : !isOrphanedEmptyLock(lockPath)) {
          throw new Error(`${label} is being updated; retry the tool call`);
        }
        rmSync(lockPath, { force: true });
        linkOrCreateLock(ticketPath, lockPath, owner);
        acquired = true;
      }
    }
    if (!acquired) {
      throw new Error(`${label} is being updated; retry the tool call`);
    }
  } finally {
    releaseClaimTicket(claimDir, ticketPath);
  }

  return () => releaseLock(lockPath, owner);
}
