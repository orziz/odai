export const DEFAULT_MAX_MODEL_TOOL_INTENTS = 20;
export const DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS = 200000;

export async function dispatchModelToolIntents({
  output,
  dispatcher,
  actor,
  onResult,
  maxToolIntents = DEFAULT_MAX_MODEL_TOOL_INTENTS,
  maxToolIntentChars = DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS,
}) {
  const intents = Array.isArray(output?.toolIntents) ? output.toolIntents : [];
  if (intents.length > maxToolIntents) {
    const denial = {
      ok: false,
      gate: "policy",
      reason: `Model returned ${intents.length} tool intents, exceeding the per-turn limit of ${maxToolIntents}.`,
      intent: {
        type: "tool-intent-batch",
        count: intents.length,
        limit: maxToolIntents,
        actor,
      },
    };
    dispatcher?.evidence?.recordDenial(denial);
    dispatcher?.session?.recordFailure?.(`${actor?.kind || "unknown"}:tool-intent-batch:${intents.length}`);
    onResult?.({ intent: denial.intent, result: denial });
    return {
      intents: [],
      results: [denial],
      overflow: {
        count: intents.length,
        limit: maxToolIntents,
      },
    };
  }

  const results = [];
  const recordedIntents = [];
  for (const intent of intents) {
    const payloadLimit = validateToolIntentPayload({
      intent,
      actor,
      maxChars: maxToolIntentChars,
    });
    if (!payloadLimit.ok) {
      const denial = {
        ok: false,
        gate: "policy",
        reason: payloadLimit.reason,
        intent: payloadLimit.intent,
      };
      dispatcher?.evidence?.recordDenial(denial);
      dispatcher?.session?.recordFailure?.(`${actor?.kind || "unknown"}:tool-intent-payload:${intent?.type || "unknown"}`);
      results.push(denial);
      recordedIntents.push(payloadLimit.intent);
      onResult?.({ intent: payloadLimit.intent, result: denial });
      continue;
    }
    const result = await dispatcher.dispatch({
      ...intent,
      actor,
    });
    results.push(result);
    recordedIntents.push(intent);
    onResult?.({ intent, result });
  }
  return { intents: recordedIntents, results };
}

function validateToolIntentPayload({ intent = {}, actor, maxChars } = {}) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { ok: true };
  }
  const size = measureIntentPayload(intent);
  if (size <= maxChars) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Model tool intent payload is ${size} characters, exceeding the per-intent limit of ${maxChars}.`,
    intent: {
      type: "tool-intent-payload",
      originalType: intent?.type,
      size,
      limit: maxChars,
      actor,
    },
  };
}

function measureIntentPayload(intent = {}) {
  if (!intent || typeof intent !== "object") {
    return 0;
  }
  let total = 0;
  for (const key of ["path", "content", "url", "method", "question", "summary", "risk"]) {
    if (typeof intent[key] === "string") {
      total += intent[key].length;
    }
  }
  if (Array.isArray(intent.command)) {
    total += intent.command.reduce((sum, part) => sum + String(part).length, 0);
  }
  total += measureJsonPayload(intent.acceptanceEvidence);
  total += measureJsonPayload(intent.acceptanceCriteria);
  return total;
}

function measureJsonPayload(value) {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return String(value).length;
  }
}
