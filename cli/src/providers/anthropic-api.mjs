import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { iterateSseEvents, readSseEvents } from "../runtime/sse.mjs";
import { createProviderSystemPrompt, formatProviderInput } from "./odai-prompt.mjs";

export function createAnthropicApiProvider({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.ODAI_ANTHROPIC_MODEL,
  maxTokens = Number(process.env.ODAI_ANTHROPIC_MAX_TOKENS || 2048),
  fetchImpl = globalThis.fetch,
  allowApiKey = false,
} = {}) {
  const hasApiKey = Boolean(apiKey);
  const hasModel = Boolean(model);
  return {
    name: "anthropic-api",
    kind: "api",
    auth: hasApiKey ? "api_key" : "missing",
    source: {
      type: "env",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      modelEnv: "ODAI_ANTHROPIC_MODEL",
      apiKeyPresent: hasApiKey,
      modelPresent: hasModel,
    },
    capabilities: ["reasoning", "code", "tool_calling"],
    available: Boolean(hasApiKey && hasModel && allowApiKey && fetchImpl),
    blockedReason: blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl }),
    async run({ agent, input, onEvent }) {
      const effectiveModel = input?.modelOverride || model;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for the Anthropic provider.");
      }
      if (!allowApiKey) {
        throw new Error("Anthropic API key use requires explicit --use-api-key confirmation.");
      }
      if (!effectiveModel) {
        throw new Error("ODAI_ANTHROPIC_MODEL or --model is required for the Anthropic provider.");
      }
      if (!fetchImpl) {
        throw new Error("fetch is not available in this Node runtime.");
      }

      const shouldStream = Boolean(onEvent);
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: maxTokens,
          system: createProviderSystemPrompt({ agent, input, providerName: "anthropic-api" }),
          messages: [
            {
              role: "user",
              content: formatProviderInput(input),
            },
          ],
          ...(shouldStream ? { stream: true } : {}),
        }),
      });

      if (shouldStream && response.body) {
        return handleStreamingResponse({ response, agent, model: effectiveModel, onEvent });
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          `Anthropic provider failed (${response.status}): ${body?.error?.message || response.statusText}`,
        );
      }

      const parsed = parseToolIntentEnvelope(extractOutputText(body));
      return {
        provider: "anthropic-api",
        agent,
        model: effectiveModel,
        text: parsed.text,
        toolIntents: parsed.toolIntents,
        usage: body.usage,
        providerSession: parsed.providerSession || {
          provider: "anthropic-api",
          model: effectiveModel,
          messageId: body.id,
        },
        raw: body,
        unverified: ["Provider output has not been adopted by the main flow."],
      };
    },
  };
}

async function handleStreamingResponse({ response, agent, model, onEvent }) {
  if (!response.ok) {
    const events = await readSseEvents(response.body);
    const error = events.find((event) => event.type === "error")?.data;
    throw new Error(`Anthropic provider failed (${response.status}): ${error?.error?.message || response.statusText}`);
  }

  const textParts = [];
  const usage = {};
  let messageId;
  const rawEvents = [];
  for await (const event of iterateSseEvents(response.body)) {
    rawEvents.push({ type: event.type });
    if (event.type === "message_start") {
      messageId = event.data?.message?.id || messageId;
      mergeUsage(usage, event.data?.message?.usage);
      emitUsage(onEvent, { model, usage });
    }
    if (event.type === "content_block_delta" && event.data?.delta?.type === "text_delta") {
      const text = event.data.delta.text || "";
      if (text) {
        textParts.push(text);
        onEvent?.({
          type: "provider-text",
          provider: "anthropic-api",
          model,
          text,
        });
      }
    }
    if (event.type === "message_delta") {
      mergeUsage(usage, event.data?.usage);
      mergeUsage(usage, event.data?.delta?.usage);
      emitUsage(onEvent, { model, usage });
    }
    if (event.type === "error") {
      throw new Error(`Anthropic provider stream failed: ${event.data?.error?.message || "unknown error"}`);
    }
  }

  const parsed = parseToolIntentEnvelope(textParts.join(""));
  return {
    provider: "anthropic-api",
    agent,
    model,
    text: parsed.text,
    toolIntents: parsed.toolIntents,
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    providerSession: parsed.providerSession || {
      provider: "anthropic-api",
      model,
      messageId,
    },
    rawEvents,
    unverified: ["Provider output has not been adopted by the main flow."],
  };
}

function emitUsage(onEvent, { model, usage } = {}) {
  if (!onEvent || !usage || Object.keys(usage).length === 0) return;
  onEvent({
    type: "provider-usage",
    provider: "anthropic-api",
    model,
    usage,
  });
}

function mergeUsage(target, source) {
  if (!source || typeof source !== "object") return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number") {
      target[key] = value;
    }
  }
}

function blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl }) {
  if (!hasApiKey) return "api_key_missing";
  if (hasApiKey && !allowApiKey) return "api_key_requires_explicit_use";
  if (hasApiKey && allowApiKey && !hasModel) return "model_required";
  if (!fetchImpl) return "fetch_unavailable";
  return "";
}

function extractOutputText(response) {
  const chunks = [];
  for (const item of response.content || []) {
    if (item.type === "text" && item.text) {
      chunks.push(item.text);
    }
  }
  return chunks.join("\n");
}
