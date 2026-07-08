const ALLOWED_INTENT_TYPES = new Set(["list", "read", "search", "write", "shell", "network", "ask-user", "complete"]);

export function parseToolIntentEnvelope(text) {
  const payload = parseJsonPayload(text);
  if (!payload) {
    return {
      text,
      toolIntents: undefined,
    };
  }

  return {
    text: typeof payload.text === "string" ? payload.text : text,
    toolIntents: Array.isArray(payload.toolIntents)
      ? payload.toolIntents.map(normalizeToolIntent).filter(Boolean)
      : undefined,
    providerSession: payload.providerSession,
  };
}

function parseJsonPayload(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return undefined;
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function normalizeToolIntent(intent) {
  if (!intent || !ALLOWED_INTENT_TYPES.has(intent.type)) {
    return undefined;
  }

  if (intent.type === "list") {
    return {
      type: "list",
      path: typeof intent.path === "string" && intent.path ? intent.path : ".",
      maxEntries: normalizePositiveInteger(intent.maxEntries, 200),
      risk: normalizeRisk(intent.risk),
    };
  }

  if (intent.type === "read") {
    if (typeof intent.path !== "string") return undefined;
    return {
      type: "read",
      path: intent.path,
      risk: normalizeRisk(intent.risk),
    };
  }

  if (intent.type === "search") {
    if (typeof intent.pattern !== "string" || !intent.pattern) return undefined;
    return {
      type: "search",
      pattern: intent.pattern,
      path: typeof intent.path === "string" && intent.path ? intent.path : ".",
      maxResults: normalizePositiveInteger(intent.maxResults, 50),
      risk: normalizeRisk(intent.risk),
    };
  }

  if (intent.type === "write") {
    if (typeof intent.path !== "string") return undefined;
    return {
      type: "write",
      path: intent.path,
      content: typeof intent.content === "string" ? intent.content : "",
      risk: normalizeRisk(intent.risk),
      perception: intent.perception === true,
      acceptanceEvidence: intent.acceptanceEvidence,
      acceptanceCriteria: intent.acceptanceCriteria,
    };
  }

  if (intent.type === "shell") {
    if (!Array.isArray(intent.command) || intent.command.length === 0) return undefined;
    return {
      type: "shell",
      command: intent.command.map(String),
      risk: normalizeRisk(intent.risk),
    };
  }

  if (intent.type === "network") {
    if (typeof intent.url !== "string") return undefined;
    return {
      type: "network",
      url: intent.url,
      method: typeof intent.method === "string" ? intent.method.toUpperCase() : "GET",
      risk: normalizeRisk(intent.risk) || "external",
    };
  }

  if (intent.type === "ask-user") {
    return {
      type: "ask-user",
      question: typeof intent.question === "string" ? intent.question : "",
      risk: normalizeRisk(intent.risk),
    };
  }

  if (intent.type === "complete") {
    return {
      type: "complete",
      summary: typeof intent.summary === "string" ? intent.summary : "",
      risk: normalizeRisk(intent.risk),
    };
  }

  return undefined;
}

function normalizeRisk(risk) {
  return typeof risk === "string" && risk ? risk : undefined;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}
