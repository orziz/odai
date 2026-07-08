export const REASONING_DEPTHS = ["auto", "none", "minimal", "low", "medium", "high"];

const REASONING_ALIASES = new Map([
  ["default", "auto"],
  ["standard", "auto"],
  ["off", "none"],
  ["false", "none"],
  ["0", "none"],
  ["no", "none"],
  ["min", "minimal"],
  ["small", "low"],
  ["normal", "medium"],
  ["med", "medium"],
  ["deep", "high"],
  ["max", "high"],
  ["maximum", "high"],
]);

export function normalizeReasoningDepth(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim().toLowerCase();
  const normalized = REASONING_ALIASES.get(raw) || raw;
  if (REASONING_DEPTHS.includes(normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported reasoning depth: ${value}. Use auto, none, minimal, low, medium, or high.`);
}

export function parseContextWindowTokens(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim().toLowerCase();
  if (["auto", "default", "none", "off", "0"].includes(raw)) return undefined;
  const compact = raw.replaceAll("_", "").replaceAll(",", "").replace(/\s+/g, "");
  const match = compact.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!match) {
    throw new Error(`Unsupported context size: ${value}. Use a token count like 200k, 1m, or 1000000.`);
  }
  const number = Number(match[1]);
  const multiplier = match[2] === "m" ? 1000000 : match[2] === "k" ? 1000 : 1;
  const tokens = Math.floor(number * multiplier);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new Error(`Unsupported context size: ${value}. Use a positive token count.`);
  }
  return tokens;
}

export function normalizeModelOptions({ reasoning, contextWindow, contextWindowTokens } = {}) {
  const result = {};
  const reasoningDepth = normalizeReasoningDepth(reasoning);
  if (reasoningDepth && reasoningDepth !== "auto") {
    result.reasoning = reasoningDepth;
  }
  const tokens = Number.isFinite(contextWindowTokens)
    ? Math.floor(contextWindowTokens)
    : parseContextWindowTokens(contextWindow);
  if (Number.isFinite(tokens) && tokens > 0) {
    result.contextWindowTokens = tokens;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function formatContextWindowTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "auto";
  if (tokens % 1000000 === 0) return `${tokens / 1000000}m`;
  if (tokens % 1000 === 0) return `${tokens / 1000}k`;
  return String(tokens);
}

export function openAiReasoningRequest(modelOptions = {}) {
  const effort = openAiReasoningEffort(modelOptions.reasoning);
  return effort ? { effort } : undefined;
}

export function openAiCompatibleRequestOptions(modelOptions = {}) {
  const effort = openAiReasoningEffort(modelOptions.reasoning);
  return effort ? { reasoning_effort: effort } : {};
}

function openAiReasoningEffort(reasoning) {
  if (!reasoning || reasoning === "auto" || reasoning === "none") return undefined;
  if (reasoning === "minimal" || reasoning === "low" || reasoning === "medium" || reasoning === "high") {
    return reasoning;
  }
  return undefined;
}
