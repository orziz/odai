import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { runCommandAsync } from "./subprocess-runner.mjs";
import { createProviderPrompt } from "./odai-prompt.mjs";

export function createCommandJsonProvider({
  name,
  command,
  args = [],
  modelArgs = [],
  inputMode = "stdin",
  capabilities = ["reasoning", "code"],
  installed = false,
  allowProviderCommand = false,
  runCommand = defaultRunCommand,
  timeoutMs = 120000,
  maxOutputChars = 200000,
} = {}) {
  if (!name) {
    throw new Error("Command provider requires a name.");
  }
  if (!command) {
    throw new Error(`Command provider '${name}' requires a command.`);
  }

  return {
    name,
    kind: "command-json",
    auth: "external_command",
    source: {
      type: "command",
      command,
      commandPresent: installed,
      inputMode,
      configured: true,
      ...(Array.isArray(modelArgs) && modelArgs.length > 0 ? { modelArgsPresent: true } : {}),
      confirmationFlag: "--use-provider-command",
    },
    capabilities,
    available: Boolean(installed && allowProviderCommand),
    blockedReason: blockedReason({ installed, allowProviderCommand }),
    async run({ agent, input }) {
      const model = input?.modelOverride;
      if (!installed) {
        throw new Error(`Command provider '${name}' command is not available: ${command}`);
      }
      if (!allowProviderCommand) {
        throw new Error(`Command provider '${name}' requires explicit --use-provider-command confirmation.`);
      }

      const prompt = createProviderPrompt({ agent, input, providerName: name });
      const isolatedCwd = mkdtempSync(path.join(tmpdir(), "odai-command-json-"));
      const invocationArgs = [
        ...args.map(String),
        ...formatModelArgs({ model, modelArgs }),
        ...(inputMode === "append-arg" ? [prompt] : []),
      ];
      const result = await runCommand(command, invocationArgs, {
        input: inputMode === "stdin" ? prompt : undefined,
        cwd: isolatedCwd,
        timeoutMs,
        maxOutputChars,
      });
      if (result.status !== 0) {
        throw new Error(`Command provider '${name}' failed (${result.status}): ${result.stderr || result.stdout}`);
      }

      const stdout = truncate(result.stdout || "", maxOutputChars);
      const parsed = parseToolIntentEnvelope(stdout);
      return {
        provider: name,
        agent,
        model,
        text: parsed.text,
        toolIntents: parsed.toolIntents,
        stderr: truncate(result.stderr || "", maxOutputChars),
        usage: result.usage,
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

function formatModelArgs({ model, modelArgs = [] } = {}) {
  if (!model || !Array.isArray(modelArgs) || modelArgs.length === 0) {
    return [];
  }
  return modelArgs.map((arg) => String(arg).replaceAll("{model}", model));
}

function defaultRunCommand(command, args, options = {}) {
  return runCommandAsync(command, args, {
    input: options.input,
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
