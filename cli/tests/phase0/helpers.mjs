import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Monorepo root (parent of cli/). */
export const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function streamText(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}


export async function runCliBin(args = [], stdinText = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(monorepoRoot, "cli", "bin", "odai.mjs"), ...args], {
      cwd: monorepoRoot,
      env: {
        PATH: process.env.PATH || "",
        TMPDIR: process.env.TMPDIR || tmpdir(),
        ODAI_LANG: "en",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(stdinText);
  });
}

export async function runCliExecutable(args = [], stdinText = "") {
  return new Promise((resolve, reject) => {
    const executablePath = path.join(monorepoRoot, "cli", "bin", "odai.mjs");
    const command = process.platform === "win32" ? process.execPath : executablePath;
    const commandArgs = process.platform === "win32" ? [executablePath, ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd: monorepoRoot,
      env: {
        PATH: process.env.PATH || "",
        TMPDIR: process.env.TMPDIR || tmpdir(),
        ODAI_LANG: "en",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(stdinText);
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePathForCompare(value) {
  const normalized = path.resolve(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeSlashes(value) {
  return String(value).replaceAll("\\", "/");
}

export async function symlinkOrCopyDirectory(source, target) {
  try {
    await symlink(source, target, "dir");
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOSYS"].includes(error?.code)) {
      throw error;
    }
    await cp(source, target, { recursive: true });
  }
}

export async function trySymlink(source, target, type) {
  try {
    await symlink(source, target, type);
    return true;
  } catch (error) {
    if (!["EACCES", "EPERM", "ENOSYS"].includes(error?.code)) {
      throw error;
    }
    return false;
  }
}
