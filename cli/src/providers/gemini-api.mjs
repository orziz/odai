import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { createProviderSystemPrompt, formatProviderInput } from "./odai-prompt.mjs";

export function createGeminiApiProvider({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.ODAI_GEMINI_MODEL,
  fetchImpl = globalThis.fetch,
  allowApiKey = false,
} = {}) {
  const hasApiKey = Boolean(apiKey);
  const hasModel = Boolean(model);
  return {
    name: "gemini-api",
    kind: "api",
    auth: hasApiKey ? "api_key" : "missing",
    source: {
      type: "env",
      apiKeyEnv: "GEMINI_API_KEY",
      modelEnv: "ODAI_GEMINI_MODEL",
      apiKeyPresent: hasApiKey,
      modelPresent: hasModel,
    },
    capabilities: ["reasoning", "code", "long_context", "tool_calling"],
    available: Boolean(hasApiKey && hasModel && allowApiKey && fetchImpl),
    blockedReason: blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl }),
    async run({ agent, input }) {
      const effectiveModel = input?.modelOverride || model;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is required for the Gemini provider.");
      }
      if (!allowApiKey) {
        throw new Error("Gemini API key use requires explicit --use-api-key confirmation.");
      }
      if (!effectiveModel) {
        throw new Error("ODAI_GEMINI_MODEL or --model is required for the Gemini provider.");
      }
      if (!fetchImpl) {
        throw new Error("fetch is not available in this Node runtime.");
      }

      const url = new URL(
        `https://generativelanguage.googleapis.com/v1beta/${normalizeModelPath(effectiveModel)}:generateContent`,
      );
      url.searchParams.set("key", apiKey);
      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: createProviderSystemPrompt({ agent, input, providerName: "gemini-api" }),
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: formatProviderInput(input),
                },
              ],
            },
          ],
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`Gemini provider failed (${response.status}): ${body?.error?.message || response.statusText}`);
      }

      const parsed = parseToolIntentEnvelope(extractOutputText(body));
      return {
        provider: "gemini-api",
        agent,
        model: effectiveModel,
        text: parsed.text,
        toolIntents: parsed.toolIntents,
        usage: body.usageMetadata,
        providerSession: parsed.providerSession || {
          provider: "gemini-api",
          model: effectiveModel,
          responseId: body.responseId,
        },
        raw: body,
        unverified: ["Provider output has not been adopted by the main flow."],
      };
    },
  };
}

function blockedReason({ hasApiKey, hasModel, allowApiKey, fetchImpl }) {
  if (!hasApiKey) return "api_key_missing";
  if (hasApiKey && !allowApiKey) return "api_key_requires_explicit_use";
  if (hasApiKey && allowApiKey && !hasModel) return "model_required";
  if (!fetchImpl) return "fetch_unavailable";
  return "";
}

function normalizeModelPath(model) {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function extractOutputText(response) {
  const chunks = [];
  for (const candidate of response.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n");
}
