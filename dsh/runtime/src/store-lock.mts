import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
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
      throw new Error(`short write while acquiring Odai configuration lock: ${lockPath}`);
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
  if (current === undefined) throw new Error(`Odai configuration lock disappeared before release: ${lockPath}`);
  if (current.value !== owner) throw new Error(`Odai configuration lock ownership changed before release: ${lockPath}`);
  rmSync(lockPath);
}

function acquireClaim(claimPath: string, label: string): { handle: number; owner: string } {
  const owner = `${process.pid}:${randomUUID()}`;
  try {
    return { handle: createLock(claimPath, owner), owner };
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const current = readLockOwner(claimPath);
  if (current === undefined || processIsAlive(current.pid)) {
    throw new Error(`${label} lock acquisition is already in progress; retry the tool call`);
  }

  const displacedPath = `${claimPath}.recovery-${process.pid}-${randomUUID()}`;
  try {
    renameSync(claimPath, displacedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`${label} lock acquisition changed during recovery; retry the tool call`);
    }
    throw error;
  }

  let displacedWasStale = false;
  try {
    const displaced = readLockOwner(displacedPath);
    if (displaced?.value !== current.value) {
      throw new Error(`${label} lock acquisition ownership changed during recovery; displaced successor preserved at ${displacedPath}; retry the tool call`);
    }
    displacedWasStale = true;
    return { handle: createLock(claimPath, owner), owner };
  } finally {
    if (displacedWasStale) rmSync(displacedPath, { force: true });
  }
}

export function acquireOwnedStoreLock(path: string, label: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const claimPath = `${lockPath}.claim`;
  const owner = `${process.pid}:${randomUUID()}`;
  const claim = acquireClaim(claimPath, label);

  let handle: number | undefined;
  try {
    const activeClaim = readLockOwner(claimPath);
    if (activeClaim?.value !== claim.owner) {
      throw new Error(`${label} lock acquisition ownership changed before update; retry the tool call`);
    }
    try {
      handle = createLock(lockPath, owner);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const current = readLockOwner(lockPath);
      if (current === undefined || processIsAlive(current.pid)) {
        throw new Error(`${label} is being updated; retry the tool call`);
      }
      rmSync(lockPath);
      handle = createLock(lockPath, owner);
    }
  } finally {
    try {
      releaseLock(claim.handle, claimPath, claim.owner);
    } catch (error) {
      if (handle !== undefined) {
        try {
          releaseLock(handle, lockPath, owner);
        } catch {}
        handle = undefined;
      }
      throw error;
    }
  }

  if (handle === undefined) throw new Error(`could not lock ${label}`);
  const ownedHandle = handle;
  return () => releaseLock(ownedHandle, lockPath, owner);
}
