import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { redactString } from "../runtime/redaction.mjs";
import { createProviderPrompt } from "./odai-prompt.mjs";

export function createClaudeAgentSdkProvider({
  installed = false,
  allowProviderCommand = false,
  loadSdk = defaultLoadSdk,
  pathToClaudeCodeExecutable,
  timeoutMs = 120000,
  maxOutputChars = 200000,
  maxMessages = 100,
  model,
} = {}) {
  return {
    name: "claude-agent-sdk",
    kind: "subscription-sdk",
    auth: "subscription_or_api_key",
    source: {
      type: "package",
      package: "@anthropic-ai/claude-agent-sdk",
      packagePresent: installed,
      modelEnv: "ODAI_CLAUDE_MODEL",
      modelPresent: Boolean(model),
      executableEnv: "CLAUDE_CODE_EXECUTABLE",
      executableConfigured: Boolean(pathToClaudeCodeExecutable),
      confirmationFlag: "--use-provider-command",
    },
    capabilities: ["tool_loop", "code_agent", "long_context", "sandbox_bridge"],
    available: Boolean(installed && allowProviderCommand),
    blockedReason: blockedReason({ installed, allowProviderCommand }),
    async run({ agent, input, onEvent }) {
      const effectiveModel = input?.modelOverride || model;
      if (!installed) {
        throw new Error("Claude Agent SDK package is not available.");
      }
      if (!allowProviderCommand) {
        throw new Error("Claude Agent SDK provider requires explicit --use-provider-command confirmation.");
      }

      const sdk = await loadSdk();
      if (typeof sdk.query !== "function") {
        throw new Error("Claude Agent SDK does not expose query().");
      }

      const messages = [];
      const textBuffer = createTextBuffer(maxOutputChars);
      let messageOverflow = 0;
      let usage;
      let sessionId;
      let messageId;
      const abortController = new AbortController();
      const isolatedCwd = mkdtempSync(path.join(tmpdir(), "odai-claude-sdk-"));
      const query = sdk.query({
        prompt: createProviderPrompt({ agent, input, providerName: "claude-agent-sdk" }),
        options: {
          abortController,
          maxTurns: 1,
          cwd: isolatedCwd,
          env: scrubEnv(process.env),
          allowedTools: [],
          permissionMode: "dontAsk",
          disallowedTools: ["*"],
          strictMcpConfig: true,
          mcpServers: {},
          tools: [],
          ...(effectiveModel ? { model: effectiveModel } : {}),
          additionalDirectories: [],
          settingSources: [],
          persistSession: false,
          canUseTool: async (_toolName, _toolInput, options = {}) => ({
            behavior: "deny",
            message: "odai-runtime owns all local tool execution.",
            toolUseID: options.toolUseID,
          }),
          ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
        },
      });
      const iterator = query?.[Symbol.asyncIterator] ? query[Symbol.asyncIterator]() : query;
      if (!iterator || typeof iterator.next !== "function") {
        throw new Error("Claude Agent SDK query() did not return an async iterator.");
      }

      try {
        for (;;) {
          const next = await nextWithTimeout(iterator, {
            timeoutMs,
            onTimeout: () => {
              abortController.abort();
              query?.interrupt?.().catch?.(() => undefined);
              query?.close?.();
            },
          });
          if (next.done) break;
          const message = next.value;
          if (messages.length < maxMessages) {
            messages.push(summarizeSdkMessage(message));
          } else {
            messageOverflow += 1;
          }
          sessionId = message.session_id || sessionId;
          messageId = message.uuid || messageId;
          const text = extractMessageText(message);
          if (text) {
            textBuffer.push(text);
            onEvent?.({
              type: "provider-text",
              provider: "claude-agent-sdk",
              text: truncate(redactString(text), maxOutputChars),
            });
          }
          const messageUsage = extractUsage(message);
          if (messageUsage) {
            usage = messageUsage;
            onEvent?.({
              type: "provider-usage",
              provider: "claude-agent-sdk",
              model: effectiveModel,
              usage,
            });
          }
        }
      } finally {
        query?.close?.();
      }

      const parsed = parseToolIntentEnvelope(textBuffer.value());
      return {
        provider: "claude-agent-sdk",
        agent,
        model: effectiveModel,
        text: truncate(redactString(parsed.text), maxOutputChars),
        toolIntents: parsed.toolIntents,
        usage,
        providerSession: parsed.providerSession || {
          provider: "claude-agent-sdk",
          ...(effectiveModel ? { model: effectiveModel } : {}),
          sessionId: typeof sessionId === "string" ? redactString(sessionId) : sessionId,
          messageId: typeof messageId === "string" ? redactString(messageId) : messageId,
        },
        messages,
        messageOverflow,
        unverified: ["Provider output has not been adopted by the main flow."],
      };
    },
  };
}

function blockedReason({ installed, allowProviderCommand }) {
  if (!installed) return "sdk_package_not_installed";
  if (!allowProviderCommand) return "provider_command_requires_explicit_use";
  return "";
}

async function defaultLoadSdk() {
  return import("@anthropic-ai/claude-agent-sdk");
}

function summarizeSdkMessage(message = {}) {
  return {
    type: typeof message.type === "string" ? redactString(message.type) : message.type,
    subtype: typeof message.subtype === "string" ? redactString(message.subtype) : message.subtype,
    uuid: typeof message.uuid === "string" ? redactString(message.uuid) : message.uuid,
    session_id: typeof message.session_id === "string" ? redactString(message.session_id) : message.session_id,
  };
}

function extractMessageText(message = {}) {
  if (typeof message === "string") return message;
  if (typeof message.text === "string") return message.text;
  if (typeof message.result === "string") return message.result;
  const content = message.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
      .join("");
  }
  return "";
}

function extractUsage(message = {}) {
  return message.usage || message.message?.usage;
}

function createTextBuffer(limit = 200000) {
  const parts = [];
  let length = 0;
  let overflow = 0;
  return {
    push(value = "") {
      const text = String(value);
      if (!Number.isFinite(limit) || limit < 0) {
        parts.push(text);
        length += text.length;
        return;
      }
      const remaining = limit - length;
      if (remaining > 0) {
        parts.push(text.slice(0, remaining));
        length += Math.min(text.length, remaining);
      }
      if (text.length > remaining) {
        overflow += text.length - Math.max(remaining, 0);
      }
    },
    value() {
      const text = parts.join("");
      return overflow > 0 ? `${text}\n[truncated ${overflow} chars]` : text;
    },
  };
}

function nextWithTimeout(iterator, { timeoutMs, onTimeout } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return iterator.next();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Claude Agent SDK provider timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    iterator.next().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
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
