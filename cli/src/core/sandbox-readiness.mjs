import process from "node:process";
import { tmpdir } from "node:os";
import path from "node:path";
import { access, mkdtemp, unlink } from "node:fs/promises";
import { loadWorkspacePolicyConfig } from "../config/policy-config.mjs";
import { planShellCommand } from "../runtime/sandbox-adapter.mjs";
import { EvidenceLedger } from "../runtime/evidence-ledger.mjs";
import { SessionState } from "./session-state.mjs";
import { ToolDispatcher } from "../runtime/tool-dispatcher.mjs";

export function describeSandboxReadiness({
  workspaceRoot,
  platform = process.platform,
  commandExists,
  sandboxProbe,
} = {}) {
  if (!workspaceRoot) {
    throw new Error("describeSandboxReadiness requires workspaceRoot.");
  }
  const policy = loadWorkspacePolicyConfig({ workspaceRoot });
  const sessionTmp = path.join(tmpdir(), "odai-sandbox-readiness");
  const sampleCommand = [process.execPath, "--version"];
  const configured = inspectSandbox({
    name: "configured",
    sandbox: policy.shell.sandbox,
    workspaceRoot,
    sessionTmp,
    sampleCommand,
    platform,
    commandExists,
    sandboxProbe,
  });
  const dockerImage = policy.shell.sandbox?.mode === "docker" ? policy.shell.sandbox.image : "";
  const devcontainerConfig = policy.shell.sandbox?.mode === "devcontainer" ? policy.shell.sandbox : { mode: "devcontainer" };
  const candidates = [
    inspectSandbox({
      name: "macos-sandbox-exec",
      sandbox: { mode: "macos-sandbox-exec" },
      workspaceRoot,
      sessionTmp,
      sampleCommand,
      platform,
      commandExists,
      sandboxProbe,
    }),
    inspectSandbox({
      name: "docker",
      sandbox: { mode: "docker", image: dockerImage },
      workspaceRoot,
      sessionTmp,
      sampleCommand,
      platform,
      commandExists,
      sandboxProbe,
    }),
    inspectSandbox({
      name: "devcontainer",
      sandbox: devcontainerConfig,
      workspaceRoot,
      sessionTmp,
      sampleCommand,
      platform,
      commandExists,
      sandboxProbe,
    }),
  ];
  const configuredStrong = configured.strong === true;
  const readyCandidates = candidates.filter((candidate) => candidate.status === "ready").length;
  const policySummary = summarizePolicy(policy);
  return {
    status: configuredStrong ? "ready" : "partial",
    kind: "sandbox-readiness",
    policy: policySummary,
    summary: {
      configuredStrong,
      configuredStatus: configured.status,
      readyCandidates,
    },
    configured,
    candidates,
    remaining: configuredStrong
      ? []
      : [
          "Configure .odai/policy.json shell.sandbox.mode to a ready strong sandbox before claiming strong sandbox E2E.",
          "Run odai sandbox --smoke --allow-shell only after policy, allowlist, and sandbox preflight are ready.",
        ],
    note: "This preflight plans sandbox wrapping and fail-closed reasons. It does not execute Docker containers or prove a full strong sandbox E2E by itself.",
  };
}

export async function runSandboxSmoke({
  workspaceRoot,
  allowShell = false,
  platform = process.platform,
  commandExists,
  sandboxProbe,
  runShellCommand,
} = {}) {
  if (!workspaceRoot) {
    throw new Error("runSandboxSmoke requires workspaceRoot.");
  }
  const readiness = describeSandboxReadiness({
    workspaceRoot,
    platform,
    commandExists,
    sandboxProbe,
  });
  const policy = loadWorkspacePolicyConfig({ workspaceRoot });
  const base = {
    kind: "sandbox-smoke",
    readiness,
    policy: readiness.policy,
    smoke: {
      command: sandboxSmokeCommand(),
      escapeDescription: "Attempts to write a host temp file outside workspace/session roots; host file must not be created.",
    },
  };

  if (!allowShell) {
    return {
      ...base,
      status: "blocked",
      reason: "Sandbox smoke requires explicit --allow-shell confirmation.",
      note: "No shell command was executed.",
    };
  }

  if (!policy.shell.allowExecution) {
    return {
      ...base,
      status: "blocked",
      reason: "Shell execution is disabled by .odai/policy.json.",
      note: "No shell command was executed.",
    };
  }

  if (!readiness.summary.configuredStrong) {
    return {
      ...base,
      status: "blocked",
      reason: "Configured shell sandbox is not ready; run odai sandbox first and configure a strong sandbox.",
      note: "No shell command was executed.",
    };
  }

  const sessionTmp = await mkdtemp(path.join(tmpdir(), "odai-sandbox-smoke-"));
  const evidence = new EvidenceLedger();
  const session = new SessionState({ id: `sandbox-smoke-${Date.now()}` });
  const dispatcher = new ToolDispatcher({
    workspaceRoot,
    sessionTmp,
    evidence,
    session,
    allowShellExecution: true,
    allowedShellCommands: policy.shell.allowedCommands,
    shellSandbox: policy.shell.sandbox,
    shellSandboxPlatform: platform,
    shellSandboxCommandExists: commandExists,
    shellSandboxProbe: sandboxProbe,
    runShellCommand,
    maxOutputChars: 2000,
  });
  const result = await dispatcher.dispatch({
    actor: { kind: "main", id: "sandbox-smoke" },
    type: "shell",
    command: base.smoke.command,
  });
  const escapePath = path.join(tmpdir(), `odai-sandbox-escape-${process.pid}-${Date.now()}.txt`);
  const escapeResult = await dispatcher.dispatch({
    actor: { kind: "main", id: "sandbox-smoke" },
    type: "shell",
    command: sandboxEscapeCommand(escapePath),
  });
  const hostEscapeCreated = await fileExists(escapePath);
  if (hostEscapeCreated) {
    await unlink(escapePath).catch(() => {});
  }
  const escapeProbe = {
    ok: escapeResult.ok === false || hostEscapeCreated === false,
    hostEscapeCreated,
    result: escapeResult,
  };
  const smokeReady = Boolean(result.ok && !hostEscapeCreated);

  return {
    ...base,
    status: smokeReady ? "ready" : "blocked",
    sessionTmp,
    result,
    escapeProbe,
    evidence: evidence.snapshot(),
    note: smokeReady
      ? "Sandbox smoke executed a success probe and a host escape probe through odai policy, sandbox, dispatcher, and evidence gates."
      : "Sandbox smoke failed through odai dispatcher; inspect result and readiness.",
  };
}

function sandboxSmokeCommand() {
  return [process.execPath, "-e", "console.log('odai-sandbox-smoke')"];
}

function sandboxEscapeCommand(escapePath) {
  return [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'odai-sandbox-escape')",
    escapePath,
  ];
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function summarizePolicy(policy) {
  return {
    shell: {
      allowExecution: policy.shell.allowExecution,
      allowedCommands: policy.shell.allowedCommands,
      sandbox: policy.shell.sandbox,
    },
    network: policy.network,
    ...(Array.isArray(policy.configErrors) && policy.configErrors.length > 0
      ? { configErrors: policy.configErrors }
      : {}),
  };
}

function inspectSandbox({
  name,
  sandbox,
  workspaceRoot,
  sessionTmp,
  sampleCommand,
  platform,
  commandExists,
  sandboxProbe,
}) {
  const mode = sandbox?.mode || "none";
  try {
    const plan = planShellCommand({
      command: sampleCommand,
      workspaceRoot,
      sessionTmp,
      sandbox,
      platform,
      commandExists,
      sandboxProbe,
    });
    if (mode === "none") {
      return {
        name,
        mode,
        status: "not-isolated",
        strong: false,
        sandbox: plan.sandbox,
        reason: "No OS/container sandbox is configured; shell execution remains governed by policy gates only.",
      };
    }
    return {
      name,
      mode,
      status: plan.ok ? "ready" : "blocked",
      strong: Boolean(plan.ok),
      sandbox: plan.sandbox || sandbox,
      reason: plan.ok ? "" : plan.reason,
      commandPreview: plan.ok ? plan.command.slice(0, 12) : undefined,
    };
  } catch (error) {
    return {
      name,
      mode,
      status: "blocked",
      strong: false,
      sandbox,
      reason: error?.message || String(error),
    };
  }
}
