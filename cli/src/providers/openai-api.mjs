import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { iterateSseEvents, readSseEvents } from "../runtime/sse.mjs";
import { openAiReasoningRequest } from "../runtime/model-options.mjs";
import { createProviderSystemPrompt, formatProviderInput } from "./odai-prompt.mjs";

export function createOpenAiApiProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.ODAI_OPENAI_MODEL,
  fetchImpl = globalThis.fetch,
  allowApiKey = false,
} = {}) {
  const hasApiKey = Boolean(apiKey);
  const hasModel = Boolean(model);
  return {
    name: "openai-api",
    kind: "api",
    auth: hasApiKey ? "api_key" : "missing",
    source: {
      type: "env",
      apiKeyEnv: "OPENAI_API_KEY",
      modelEnv: "ODAI_OPENAI_MODEL",
      apiKeyPresent: hasApiKey,
      modelPresent: hasModel,
    },
    capabilities: ["reasoning", "structured_output", "code", "tool_calling"],
    available: Boolean(hasApiKey && hasModel && allowApiKey && fetchImpl),
    blockedReason: blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl }),
    async run({ agent, input, onEvent }) {
      const effectiveModel = input?.modelOverride || model;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for the OpenAI provider.");
      }
      if (!allowApiKey) {
        throw new Error("OpenAI API key use requires explicit --use-api-key confirmation.");
      }
      if (!effectiveModel) {
        throw new Error("ODAI_OPENAI_MODEL or --model is required for the OpenAI provider.");
      }
      if (!fetchImpl) {
        throw new Error("fetch is not available in this Node runtime.");
      }

      const shouldStream = Boolean(onEvent);
      const reasoning = openAiReasoningRequest(input?.modelOptions);
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: effectiveModel,
          instructions: createProviderSystemPrompt({ agent, input, providerName: "openai-api" }),
          input: formatProviderInput(input),
          ...(reasoning ? { reasoning } : {}),
          ...(shouldStream ? { stream: true } : {}),
        }),
      });

      if (shouldStream && response.body) {
        return handleStreamingResponse({ response, agent, model: effectiveModel, onEvent });
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`OpenAI provider failed (${response.status}): ${body?.error?.message || response.statusText}`);
      }

      const parsed = parseToolIntentEnvelope(extractOutputText(body));
      return {
        provider: "openai-api",
        agent,
        model: effectiveModel,
        text: parsed.text,
        toolIntents: parsed.toolIntents,
        usage: body.usage,
        providerSession: parsed.providerSession || {
          provider: "openai-api",
          model: effectiveModel,
          responseId: body.id,
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
    throw new Error(`OpenAI provider failed (${response.status}): ${error?.error?.message || response.statusText}`);
  }

  const textParts = [];
  let usage;
  let responseId;
  const rawEvents = [];
  for await (const event of iterateSseEvents(response.body)) {
    rawEvents.push({ type: event.type });
    if (event.type === "response.output_text.delta" && typeof event.data?.delta === "string") {
      textParts.push(event.data.delta);
      onEvent?.({
        type: "provider-text",
        provider: "openai-api",
        model,
        text: event.data.delta,
      });
    }
    if (event.type === "response.completed") {
      responseId = event.data?.response?.id || responseId;
      usage = event.data?.response?.usage || usage;
      if (usage) {
        onEvent?.({
          type: "provider-usage",
          provider: "openai-api",
          model,
          usage,
        });
      }
    }
    if (event.type === "error") {
      throw new Error(`OpenAI provider stream failed: ${event.data?.error?.message || "unknown error"}`);
    }
  }

  const parsed = parseToolIntentEnvelope(textParts.join(""));
  return {
    provider: "openai-api",
    agent,
    model,
    text: parsed.text,
    toolIntents: parsed.toolIntents,
    usage,
    providerSession: parsed.providerSession || {
      provider: "openai-api",
      model,
      responseId,
    },
    rawEvents,
    unverified: ["Provider output has not been adopted by the main flow."],
  };
}

function blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl }) {
  if (!hasApiKey) return "api_key_missing";
  if (hasApiKey && !allowApiKey) return "api_key_requires_explicit_use";
  if (hasApiKey && allowApiKey && !hasModel) return "model_required";
  if (!fetchImpl) return "fetch_unavailable";
  return "";
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}
