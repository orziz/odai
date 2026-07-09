export const CONTROL_INTENT_TYPES = new Set(["ask-user", "complete", "spawn-subagent"]);

/** Hard cap on spawn-subagent intents accepted from a single model turn. */
export const DEFAULT_MAX_SPAWN_REQUESTS_PER_TURN = 3;

export function isControlIntentType(type) {
  return CONTROL_INTENT_TYPES.has(type);
}

export function partitionModelIntents(intents = []) {
  const toolIntents = [];
  const controlIntents = [];
  for (const intent of intents) {
    if (!intent || typeof intent !== "object") continue;
    if (isControlIntentType(intent.type)) {
      controlIntents.push(intent);
    } else {
      toolIntents.push(intent);
    }
  }
  return { toolIntents, controlIntents };
}

export function summarizeControlIntents(controlIntents = []) {
  const askUser = controlIntents.find((intent) => intent.type === "ask-user");
  const complete = controlIntents.find((intent) => intent.type === "complete");
  const spawnRequests = controlIntents
    .filter((intent) => intent.type === "spawn-subagent")
    .map((intent) => ({
      profile: typeof intent.profile === "string" && intent.profile ? intent.profile : "reviewer",
      provider: typeof intent.provider === "string" && intent.provider ? intent.provider : "auto",
      model: typeof intent.model === "string" && intent.model ? intent.model : undefined,
      reason: typeof intent.reason === "string" ? intent.reason : undefined,
    }));
  return {
    askUser: askUser
      ? {
          question: typeof askUser.question === "string" ? askUser.question : "",
          risk: askUser.risk,
        }
      : undefined,
    complete: complete
      ? {
          summary: typeof complete.summary === "string" ? complete.summary : "",
          risk: complete.risk,
        }
      : undefined,
    spawnRequests,
  };
}

export function resolveAgentLoopMaxTurns({
  maxTurns,
  maxTurnsExplicit = false,
  reasoning,
  defaultMaxTurns = 4,
} = {}) {
  if (maxTurnsExplicit && Number.isFinite(maxTurns) && maxTurns > 0) {
    return Math.max(1, Math.floor(maxTurns));
  }
  if (Number.isFinite(maxTurns) && maxTurns > 0 && maxTurns !== defaultMaxTurns) {
    return Math.max(1, Math.floor(maxTurns));
  }
  switch (reasoning) {
    case "high":
      return 16;
    case "medium":
      return 10;
    case "low":
      return 6;
    case "minimal":
    case "none":
      return 4;
    default:
      return defaultMaxTurns;
  }
}
