import {
  appendUnique,
  normalizeProviderCommandProviders,
} from "../cli-args.mjs";
import { hasOption } from "./args.mjs";

export function appendSessionAuthArgv(argv = [], sessionAuth = {}) {
  const result = [...argv];
  if (sessionAuth?.useApiKey && !hasOption(result, "--use-api-key")) {
    result.push("--use-api-key");
  }
  if (sessionAuth?.useProviderCommand && !hasOption(result, "--use-provider-command")) {
    result.push("--use-provider-command");
  } else if (!sessionAuth?.useProviderCommand) {
    for (const providerName of normalizeProviderCommandList(sessionAuth?.providerCommands)) {
      const value = `--use-provider-command=${providerName}`;
      if (!result.includes(value)) {
        result.push(value);
      }
    }
  }
  // Session-only elevation: never restored across processes / preferences.
  if (sessionAuth?.allowShell && !hasOption(result, "--allow-shell")) {
    result.push("--allow-shell");
  }
  if (sessionAuth?.allowNetwork && !hasOption(result, "--allow-network")) {
    result.push("--allow-network");
  }
  return result;
}


export function updateSessionAuth({ argv = [], current = {} } = {}) {
  if (argv.length === 0) {
    return {
      status: "ready",
      session: {
        useApiKey: Boolean(current.useApiKey),
        useProviderCommand: Boolean(current.useProviderCommand),
        providerCommands: normalizeProviderCommandList(current.providerCommands),
        allowShell: Boolean(current.allowShell),
        allowNetwork: Boolean(current.allowNetwork),
      },
      persist: false,
      note:
        "Use /auth api-key|claude-cli|provider-command|all|clear (durable) or /auth shell|network (session-only). risk:* still needs /authorize.",
    };
  }

  const next = {
    useApiKey: Boolean(current.useApiKey),
    useProviderCommand: Boolean(current.useProviderCommand),
    providerCommands: normalizeProviderCommandList(current.providerCommands),
    allowShell: Boolean(current.allowShell),
    allowNetwork: Boolean(current.allowNetwork),
  };
  let touchedDurable = false;
  let touchedSessionOnly = false;
  for (const raw of argv) {
    const value = String(raw).trim().toLowerCase();
    if (["api-key", "api", "--use-api-key"].includes(value)) {
      next.useApiKey = true;
      touchedDurable = true;
    } else if (["provider-command", "command", "cli", "--use-provider-command"].includes(value)) {
      next.useProviderCommand = true;
      next.providerCommands = [];
      touchedDurable = true;
    } else if (["claude-cli", "claude"].includes(value)) {
      next.providerCommands = addUniqueProviderCommand(next.providerCommands, "claude-cli");
      touchedDurable = true;
    } else if (["claude-agent-sdk", "claude-sdk"].includes(value)) {
      next.providerCommands = addUniqueProviderCommand(next.providerCommands, "claude-agent-sdk");
      touchedDurable = true;
    } else if (["shell", "--allow-shell"].includes(value)) {
      next.allowShell = true;
      touchedSessionOnly = true;
    } else if (["network", "--allow-network"].includes(value)) {
      next.allowNetwork = true;
      touchedSessionOnly = true;
    } else if (value === "all") {
      next.useApiKey = true;
      next.useProviderCommand = true;
      next.providerCommands = [];
      touchedDurable = true;
    } else if (["clear", "none", "off", "reset"].includes(value)) {
      next.useApiKey = false;
      next.useProviderCommand = false;
      next.providerCommands = [];
      next.allowShell = false;
      next.allowNetwork = false;
      touchedDurable = true;
      touchedSessionOnly = true;
    } else {
      return {
        status: "blocked",
        session: next,
        reason:
          "Usage: /auth [api-key|claude-cli|claude-agent-sdk|provider-command|shell|network|all|clear]",
      };
    }
  }
  const onlySession = touchedSessionOnly && !touchedDurable;
  return {
    status: "ready",
    session: next,
    persist: !onlySession,
    note: onlySession
      ? "Session-only auth updated (shell/network). Not saved to preferences; risk scopes still use /authorize."
      : "Auth updated. Durable provider confirmations are saved in .odai/preferences.json; shell/network stay session-only.",
  };
}


export function normalizeProviderCommandList(value) {
  return normalizeProviderCommandProviders(value);
}


export function addUniqueProviderCommand(list = [], providerName) {
  return normalizeProviderCommandList([...normalizeProviderCommandList(list), providerName]);
}


export function formatSessionAuth(session = {}) {
  const enabled = [];
  if (session?.useApiKey) enabled.push("api-key");
  if (session?.useProviderCommand) enabled.push("provider-command");
  for (const providerName of normalizeProviderCommandList(session?.providerCommands)) {
    enabled.push(providerName);
  }
  if (session?.allowShell) enabled.push("shell(session)");
  if (session?.allowNetwork) enabled.push("network(session)");
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

