import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { iterateSseEvents } from "../runtime/sse.mjs";
import { openAiCompatibleRequestOptions } from "../runtime/model-options.mjs";
import { createProviderSystemPrompt, formatProviderInput } from "./odai-prompt.mjs";

export function createOpenAiCompatibleProvider({
  name,
  baseUrl,
  apiKey,
  apiKeyEnv,
  modelEnv,
  model,
  capabilities = ["reasoning", "code"],
  fetchImpl = globalThis.fetch,
  allowApiKey = false,
  requiresApiKey = false,
} = {}) {
  if (!name) {
    throw new Error("OpenAI-compatible providers require a name.");
  }
  if (!baseUrl) {
    throw new Error(`OpenAI-compatible provider '${name}' requires a baseUrl.`);
  }

  const hasApiKey = Boolean(apiKey);
  const hasModel = Boolean(model);
  const auth = hasApiKey || requiresApiKey ? "api_key" : "none";
  return {
    name,
    kind: "openai-compatible",
    auth,
    source: {
      type: "openai-compatible",
      baseUrl,
      apiKeyEnv,
      modelEnv,
      apiKeyPresent: hasApiKey,
      modelPresent: hasModel,
      requiresApiKey: Boolean(requiresApiKey),
      configured: true,
    },
    capabilities,
    available: Boolean(fetchImpl && hasModel && (!requiresApiKey || hasApiKey) && (!hasApiKey || allowApiKey)),
    blockedReason: blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl, requiresApiKey }),
    async run({ agent, input, onEvent }) {
      const effectiveModel = input?.modelOverride || model;
      if (requiresApiKey && !apiKey) {
        throw new Error(`OpenAI-compatible provider '${name}' requires an API key.`);
      }
      if (hasApiKey && !allowApiKey) {
        throw new Error(`Provider '${name}' API key use requires explicit --use-api-key confirmation.`);
      }
      if (!fetchImpl) {
        throw new Error("fetch is not available in this Node runtime.");
      }
      if (!effectiveModel) {
        throw new Error(`OpenAI-compatible provider '${name}' requires a model or --model.`);
      }

      const headers = {
        "content-type": "application/json",
      };
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }

      const shouldStream = Boolean(onEvent);
      const requestOptions = openAiCompatibleRequestOptions(input?.modelOptions);
      const response = await fetchImpl(`${openAiCompatibleApiRoot(baseUrl)}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: effectiveModel,
          ...requestOptions,
          ...(shouldStream
            ? {
                stream: true,
                stream_options: {
                  include_usage: true,
                },
              }
            : {}),
          messages: [
            {
              role: "system",
              content: createProviderSystemPrompt({ agent, input, providerName: name }),
            },
            {
              role: "user",
              content: formatProviderInput(input),
            },
          ],
        }),
      });

      if (!response.ok) {
        const body = await readJsonResponseBody(response);
        throw new Error(
          `OpenAI-compatible provider '${name}' failed (${response.status}): ${
            body?.error?.message || body?.message || body?.text || response.statusText
          }`,
        );
      }

      if (shouldStream && response.body) {
        return handleStreamingResponse({ response, agent, name, model: effectiveModel, onEvent, maxOutputChars: 200000 });
      }

      const body = await readJsonResponseBody(response);
      const parsed = parseToolIntentEnvelope(extractChatText(body));
      return {
        provider: name,
        agent,
        model: effectiveModel,
        text: parsed.text,
        toolIntents: parsed.toolIntents,
        usage: body.usage,
        providerSession: parsed.providerSession || {
          provider: name,
          model: effectiveModel,
          responseId: body.id,
        },
        raw: body,
        unverified: ["Provider output has not been adopted by the main flow."],
      };
    },
  };
}

async function handleStreamingResponse({ response, agent, name, model, onEvent, maxOutputChars }) {
  const textParts = [];
  let usage;
  let responseId;
  const rawEvents = [];

  for await (const event of iterateSseEvents(response.body)) {
    rawEvents.push({ type: event.type || event.data?.object || "chat.completion.chunk" });
    if (event.data?.error) {
      throw new Error(
        `OpenAI-compatible provider '${name}' stream failed: ${event.data.error.message || "unknown error"}`,
      );
    }

    responseId = event.data?.id || responseId;
    if (event.data?.usage) {
      usage = event.data.usage;
      onEvent?.({
        type: "provider-usage",
        provider: name,
        model,
        usage,
      });
    }

    for (const choice of event.data?.choices || []) {
      const text = choice?.delta?.content || choice?.message?.content || "";
      if (!text) continue;
      textParts.push(text);
      onEvent?.({
        type: "provider-text",
        provider: name,
        model,
        text,
      });
    }
  }

  const parsed = parseToolIntentEnvelope(truncate(textParts.join(""), maxOutputChars));
  return {
    provider: name,
    agent,
    model,
    text: parsed.text,
    toolIntents: parsed.toolIntents,
    usage,
    providerSession: parsed.providerSession || {
      provider: name,
      model,
      responseId,
    },
    rawEvents,
    unverified: ["Provider output has not been adopted by the main flow."],
  };
}

function blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl, requiresApiKey }) {
  if (requiresApiKey && !hasApiKey) return "api_key_missing";
  if (hasApiKey && !allowApiKey) return "api_key_requires_explicit_use";
  if (!hasModel) return "model_required";
  if (!fetchImpl) return "fetch_unavailable";
  return "";
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function openAiCompatibleApiRoot(value) {
  const trimmed = trimSlash(value);
  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/v1";
      return trimSlash(url.toString());
    }
  } catch {
    // Non-URL values are handled by the caller's fetch implementation.
  }
  return trimmed;
}

function extractChatText(response) {
  return response?.choices?.map((choice) => choice?.message?.content || "").filter(Boolean).join("\n") || "";
}

async function readJsonResponseBody(response) {
  if (!response) return {};
  if (typeof response.text === "function") {
    const text = await response.text().catch(() => "");
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { text: text.slice(0, 500) };
    }
  }
  if (typeof response.json === "function") {
    return await response.json().catch(() => ({}));
  }
  return {};
}

function truncate(value = "", limit = 200000) {
  if (!Number.isFinite(limit) || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}
