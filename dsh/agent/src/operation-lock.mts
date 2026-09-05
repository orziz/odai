import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function acquireAgentOperationLock(path: string, label: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = `${process.pid}:${randomUUID()}`;
  let handle: number;
  try {
    handle = openSync(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`${label} is already in progress; lock retained at ${path}`);
    }
    throw error;
  }
  try {
    const content = Buffer.from(`${owner}\n`, "utf8");
    if (writeSync(handle, content, 0, content.length) !== content.length) {
      throw new Error(`short write while acquiring ${label} lock: ${path}`);
    }
    fsyncSync(handle);
  } catch (error) {
    closeSync(handle);
    rmSync(path, { force: true });
    throw error;
  }
  return () => {
    closeSync(handle);
    let current: string;
    try {
      current = readFileSync(path, "utf8").trim();
    } catch (error) {
      throw new Error(`${label} lock disappeared before release: ${path}`, { cause: error });
    }
    if (current !== owner) throw new Error(`${label} lock ownership changed before release: ${path}`);
    rmSync(path);
  };
}
