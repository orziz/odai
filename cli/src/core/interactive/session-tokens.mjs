import { publicUsage } from "../../runtime/redaction.mjs";

export function formatUsageTokens(usage = {}) {
  const input = firstNumber(usage.input_tokens, usage.prompt_tokens, usage.promptTokenCount);
  const output = firstNumber(usage.output_tokens, usage.completion_tokens, usage.candidatesTokenCount);
  const total = firstNumber(usage.total_tokens, usage.totalTokenCount);
  const parts = [];
  if (input !== undefined) parts.push(`input ${input} tok`);
  if (output !== undefined) parts.push(`output ${output} tok`);
  if (total !== undefined) parts.push(`total ${total} tok`);
  return parts.join(" ");
}



export function firstNumber(...values) {
  return values.find((value) => Number.isFinite(value));
}



export function estimateTokensFromText(value = "") {
  return estimateTokensFromTextByChars(String(value || "").length);
}



export function estimateTokensFromTextByChars(chars = 0) {
  return Math.max(0, Math.ceil(Number(chars || 0) / 4));
}



export function estimateThinkingTokensFromElapsedMs(elapsedMs = 0) {
  // External CLIs often do not stream hidden reasoning or usage; this is only a visible activity estimate.
  return Math.max(0, Math.ceil((Number(elapsedMs || 0) / 1000) * 8));
}



export function estimateMeterTotalTokens({
  estimatedInputTokens,
  estimatedThinkingTokens = 0,
  estimatedOutputTokens = 0,
} = {}) {
  const input = Number.isFinite(estimatedInputTokens) ? estimatedInputTokens : 0;
  return input + Math.max(estimatedThinkingTokens || 0, estimatedOutputTokens || 0);
}


