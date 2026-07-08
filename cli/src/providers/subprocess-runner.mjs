import { spawn } from "node:child_process";

export function runCommandAsync(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeout;
    let stdout = "";
    let stderr = "";
    const maxOutputChars = options.maxOutputChars;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        ...result,
        stdout: truncate(stdout, maxOutputChars),
        stderr: truncate(result.stderr || stderr, maxOutputChars),
      });
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: shouldUseWindowsCommandShell(command),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        status: 1,
        stderr: error?.message || String(error),
      });
      return;
    }
    timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          stderr ||= `Command timed out after ${options.timeoutMs} ms.`;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, maxOutputChars);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, maxOutputChars);
    });
    child.on("error", (error) => {
      finish({
        status: 1,
        stderr: error?.message || String(error),
      });
    });
    child.on("close", (code, signal) => {
      finish({
        status: timedOut ? 1 : code ?? 1,
        stderr: stderr || (timedOut ? `Command timed out after ${options.timeoutMs} ms.` : signal ? `Command exited with signal ${signal}.` : ""),
      });
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

function appendBounded(current = "", chunk = "", limit = 200000) {
  const next = `${current}${chunk}`;
  if (!Number.isFinite(limit) || next.length <= limit) return next;
  return next.slice(0, limit);
}

function truncate(value = "", limit = 200000) {
  if (!Number.isFinite(limit) || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function shouldUseWindowsCommandShell(command = "") {
  return process.platform === "win32" && /\.(?:bat|cmd)$/i.test(String(command));
}
