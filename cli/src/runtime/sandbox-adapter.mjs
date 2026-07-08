import { spawnSync } from "node:child_process";
import process from "node:process";

const SUPPORTED_SHELL_SANDBOX_MODES = new Set(["none", "macos-sandbox-exec", "docker", "devcontainer"]);

export function normalizeShellSandboxConfig(value = {}) {
  const config = typeof value === "string" ? { mode: value } : value || {};
  const mode = config.mode || "none";
  if (!SUPPORTED_SHELL_SANDBOX_MODES.has(mode)) {
    throw new Error(`Unsupported shell sandbox mode: ${mode}`);
  }
  if (mode === "docker") {
    return {
      mode,
      image: typeof config.image === "string" ? config.image : "",
      network: typeof config.network === "string" ? config.network : "none",
      readOnlyRoot: config.readOnlyRoot !== false,
      workdir: typeof config.workdir === "string" ? config.workdir : "/workspace",
    };
  }
  if (mode === "devcontainer") {
    return {
      mode,
      command: typeof config.command === "string" && config.command.trim() ? config.command : "devcontainer",
      workspaceFolder: typeof config.workspaceFolder === "string" ? config.workspaceFolder : "",
    };
  }
  return { mode };
}

export function planShellCommand({
  command,
  workspaceRoot,
  sessionTmp,
  sandbox = { mode: "none" },
  platform = process.platform,
  commandExists = defaultCommandExists,
  sandboxProbe = defaultSandboxProbe,
} = {}) {
  const normalized = normalizeShellSandboxConfig(sandbox);
  if (normalized.mode === "none") {
    return {
      ok: true,
      command,
      sandbox: normalized,
    };
  }

  if (normalized.mode === "macos-sandbox-exec") {
    if (platform !== "darwin") {
      return {
        ok: false,
        gate: "policy",
        reason: "macos-sandbox-exec sandbox requires macOS.",
      };
    }
    if (!commandExists("sandbox-exec")) {
      return {
        ok: false,
        gate: "policy",
        reason: "macos-sandbox-exec sandbox is configured but sandbox-exec is not available.",
      };
    }
    if (!sandboxProbe()) {
      return {
        ok: false,
        gate: "policy",
        reason: "macos-sandbox-exec sandbox is configured but sandbox-exec is not usable in this environment.",
      };
    }
    return {
      ok: true,
      command: ["sandbox-exec", "-p", createMacOsSandboxProfile({ workspaceRoot, sessionTmp }), ...command],
      sandbox: normalized,
    };
  }

  if (normalized.mode === "docker") {
    if (!normalized.image) {
      return {
        ok: false,
        gate: "policy",
        reason: "docker sandbox requires shell.sandbox.image.",
      };
    }
    if (!commandExists("docker")) {
      return {
        ok: false,
        gate: "policy",
        reason: "docker sandbox is configured but docker is not available.",
      };
    }
    return {
      ok: true,
      command: createDockerSandboxCommand({
        command,
        workspaceRoot,
        sessionTmp,
        sandbox: normalized,
      }),
      sandbox: normalized,
    };
  }

  if (normalized.mode === "devcontainer") {
    if (!commandExists(normalized.command)) {
      return {
        ok: false,
        gate: "policy",
        reason: `devcontainer sandbox is configured but ${normalized.command} is not available.`,
      };
    }
    return {
      ok: true,
      command: createDevcontainerSandboxCommand({
        command,
        workspaceRoot,
        sandbox: normalized,
      }),
      sandbox: {
        ...normalized,
        workspaceFolder: normalized.workspaceFolder || workspaceRoot,
      },
    };
  }

  return {
    ok: false,
    gate: "policy",
    reason: `Unsupported shell sandbox mode: ${normalized.mode}`,
  };
}

function createDevcontainerSandboxCommand({ command = [], workspaceRoot, sandbox }) {
  return [
    sandbox.command || "devcontainer",
    "exec",
    "--workspace-folder",
    sandbox.workspaceFolder || workspaceRoot,
    ...command,
  ];
}

function createDockerSandboxCommand({ command = [], workspaceRoot, sessionTmp, sandbox }) {
  return [
    "docker",
    "run",
    "--rm",
    "--network",
    sandbox.network || "none",
    ...(sandbox.readOnlyRoot ? ["--read-only"] : []),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--mount",
    `type=bind,source=${workspaceRoot},target=/workspace`,
    "--mount",
    `type=bind,source=${sessionTmp},target=/odai-session-tmp`,
    "--workdir",
    sandbox.workdir || "/workspace",
    sandbox.image,
    ...command,
  ];
}

function createMacOsSandboxProfile({ workspaceRoot, sessionTmp }) {
  return [
    "(version 1)",
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${quoteSandboxPath(workspaceRoot)}))`,
    `(allow file-write* (subpath ${quoteSandboxPath(sessionTmp)}))`,
  ].join("\n");
}

function quoteSandboxPath(filePath) {
  return JSON.stringify(String(filePath));
}

function defaultCommandExists(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function defaultSandboxProbe() {
  const result = spawnSync("sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], {
    stdio: "ignore",
  });
  return result.status === 0;
}
