import { isPathAllowed } from "../tool-dispatcher.mjs";
import { isProtectedModelPath } from "../path-classifier.mjs";
import path from "node:path";

export function policyGate(intent, context) {
  if (!["list", "read", "search", "write"].includes(intent.type) || !intent.path) {
    if (intent.type === "ask-user" || intent.type === "complete") {
      return {
        allow: false,
        gate: "policy",
        reason: `Model intent '${intent.type}' is not an executable runtime tool; use assistant text or the main interactive flow.`,
      };
    }

    if (intent.type === "network") {
      return networkPolicyDecision(intent, context);
    }

    if (intent.type === "shell" && context.allowShellExecution) {
      if (!Array.isArray(intent.command) || intent.command.length === 0) {
        return {
          allow: false,
          gate: "policy",
          reason: "Executable shell intents must use an argv array.",
        };
      }

      if (!isAllowedShellCommand(intent.command[0], context.allowedShellCommands || [])) {
        return {
          allow: false,
          gate: "policy",
          reason: `Shell command is not in the session allowlist: ${intent.command[0]}`,
        };
      }
    }
    return { allow: true };
  }

  if (isProtectedModelPath(intent.path, context)) {
    if (intent.type === "write") {
      return {
        allow: false,
        gate: "policy",
        reason:
          "Credential-like and private odai runtime files cannot be modified by model tool intents; edit them outside the model tool path.",
      };
    }

    if (intent.type === "list" || intent.type === "search") {
      return {
        allow: false,
        gate: "policy",
        reason: `Credential-like and private odai runtime files cannot be ${intent.type === "list" ? "listed" : "searched"} by model tool intents.`,
      };
    }

    if (intent.actor?.kind === "subagent") {
      return {
        allow: false,
        gate: "subagent-boundary",
        reason:
          "Subagents cannot read credential-like or private odai runtime files; the main flow must inspect minimal evidence under explicit authorization.",
      };
    }
  }

  if (isPathAllowed(intent.path, context)) {
    return { allow: true };
  }

  return {
    allow: false,
    gate: "policy",
    reason: `Path is outside allowed roots: ${intent.path}`,
  };
}

function isAllowedShellCommand(command, allowlist) {
  return allowlist.some((entry) => entry === command || entry === path.basename(command));
}

function networkPolicyDecision(intent, context) {
  if (!context.allowNetworkRequests) {
    return {
      allow: false,
      gate: "policy",
      reason: "Network tool intents require explicit --allow-network confirmation.",
    };
  }
  if (!context.networkPolicy?.allowRequests) {
    return {
      allow: false,
      gate: "policy",
      reason: "Network tool intents are disabled by project policy.",
    };
  }
  const url = parseUrl(intent.url);
  if (!url) {
    return {
      allow: false,
      gate: "policy",
      reason: `Invalid network URL: ${intent.url}`,
    };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return {
      allow: false,
      gate: "policy",
      reason: `Unsupported network protocol: ${url.protocol}`,
    };
  }
  if (!isAllowedNetworkHost(url.hostname, context.networkPolicy.allowedHosts || [])) {
    return {
      allow: false,
      gate: "policy",
      reason: `Network host is not in the project allowlist: ${url.hostname}`,
    };
  }
  return { allow: true };
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isAllowedNetworkHost(hostname, allowlist) {
  return allowlist.some((entry) => {
    const value = String(entry).toLowerCase();
    const host = String(hostname).toLowerCase();
    if (value === "*") return true;
    if (value.startsWith("*.")) {
      const suffix = value.slice(1);
      return host.endsWith(suffix) && host !== suffix.slice(1);
    }
    return host === value;
  });
}
