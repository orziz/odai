import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { runCommandAsync } from "./subprocess-runner.mjs";
import { createProviderPrompt } from "./odai-prompt.mjs";

export function createClaudeCliProvider({
  command = "claude",
  installed = false,
  allowProviderCommand = false,
  runCommand = defaultRunCommand,
  timeoutMs = 120000,
  maxOutputChars = 200000,
  executableEnv,
  executableConfigured = false,
  executableDiscovered = false,
  model,
} = {}) {
  return {
    name: "claude-cli",
    kind: "subscription-cli",
    auth: "subscription_or_api_key",
    source: {
      type: "command",
      command,
      commandPresent: installed,
      modelEnv: "ODAI_CLAUDE_MODEL",
      modelPresent: Boolean(model),
      confirmationFlag: "--use-provider-command",
      ...(executableEnv
        ? {
            executableEnv,
            executableConfigured: Boolean(executableConfigured),
          }
        : {}),
      ...(executableDiscovered
        ? {
            executableDiscovered: true,
          }
        : {}),
    },
    capabilities: ["reasoning", "code", "long_context"],
    available: Boolean(installed && allowProviderCommand),
    blockedReason: blockedReason({ installed, allowProviderCommand }),
    async run({ agent, input }) {
      const effectiveModel = input?.modelOverride || model;
      if (!installed) {
        throw new Error("Claude CLI is not available.");
      }
      if (!allowProviderCommand) {
        throw new Error("Claude CLI provider requires explicit --use-provider-command confirmation.");
      }

      const prompt = createProviderPrompt({ agent, input, providerName: "claude-cli" });

      const isolatedCwd = mkdtempSync(path.join(tmpdir(), "odai-claude-cli-"));
      const result = await runCommand(
        command,
        [
          "--bare",
          "--disallowedTools",
          "*",
          "--max-turns",
          "1",
          ...(effectiveModel ? ["--model", effectiveModel] : []),
          "-p",
          prompt,
        ],
        {
          cwd: isolatedCwd,
          timeoutMs,
          maxOutputChars,
        },
      );

      if (result.status !== 0) {
        throw new Error(`Claude CLI provider failed (${result.status}): ${result.stderr || result.stdout}`);
      }

      const parsed = parseToolIntentEnvelope(truncate(result.stdout || "", maxOutputChars));
      return {
        provider: "claude-cli",
        agent,
        model: effectiveModel,
        text: parsed.text,
        toolIntents: parsed.toolIntents,
        stderr: truncate(result.stderr || "", maxOutputChars),
        providerSession: parsed.providerSession,
        unverified: ["Provider output has not been adopted by the main flow."],
      };
    },
  };
}

function blockedReason({ installed, allowProviderCommand }) {
  if (!installed) return "command_not_found";
  if (!allowProviderCommand) return "provider_command_requires_explicit_use";
  return "";
}

function defaultRunCommand(command, args, options = {}) {
  return runCommandAsync(command, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
    env: scrubEnv(process.env),
  });
}

function scrubEnv(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key)) {
      delete next[key];
    }
  }
  return next;
}

function truncate(value = "", limit = 200000) {
  if (!Number.isFinite(limit) || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}
