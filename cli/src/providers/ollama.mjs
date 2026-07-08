import { parseToolIntentEnvelope } from "../runtime/tool-intent-codec.mjs";
import { createProviderSystemPrompt, formatProviderInput } from "./odai-prompt.mjs";

export function createOllamaProvider({
  name = "ollama-local",
  baseUrl = "http://localhost:11434",
  model = process.env.ODAI_OLLAMA_MODEL,
  capabilities = ["reasoning", "code", "offline", "local"],
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!name) {
    throw new Error("Ollama providers require a name.");
  }
  const hasModel = Boolean(model);
  return {
    name,
    kind: "local-http",
    auth: "none",
    source: {
      type: "local-http",
      baseUrl,
      modelEnv: "ODAI_OLLAMA_MODEL",
      modelPresent: hasModel,
    },
    capabilities,
    available: Boolean(hasModel && fetchImpl),
    blockedReason: hasModel ? "" : "model_required",
    async run({ agent, input }) {
      const effectiveModel = input?.modelOverride || model;
      if (!effectiveModel) {
        throw new Error(`Ollama provider '${name}' requires a model or --model.`);
      }
      if (!fetchImpl) {
        throw new Error("fetch is not available in this Node runtime.");
      }

      const response = await fetchImpl(`${trimSlash(baseUrl)}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: effectiveModel,
          stream: false,
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

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`Ollama provider '${name}' failed (${response.status}): ${body?.error || response.statusText}`);
      }

      const parsed = parseToolIntentEnvelope(body?.message?.content || "");
      return {
        provider: name,
        agent,
        model: effectiveModel,
        text: parsed.text,
        toolIntents: parsed.toolIntents,
        usage: summarizeOllamaUsage(body),
        providerSession: parsed.providerSession || {
          provider: name,
          model: effectiveModel,
          createdAt: body.created_at,
        },
        raw: body,
        unverified: ["Provider output has not been adopted by the main flow."],
      };
    },
  };
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function summarizeOllamaUsage(body = {}) {
  const usage = {};
  for (const key of [
    "total_duration",
    "load_duration",
    "prompt_eval_count",
    "prompt_eval_duration",
    "eval_count",
    "eval_duration",
  ]) {
    if (typeof body[key] === "number") {
      usage[key] = body[key];
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
