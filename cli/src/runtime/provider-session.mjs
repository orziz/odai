import path from "node:path";
import { redactProviderSessionValue } from "./redaction.mjs";
import { isProtectedModelPath } from "./path-classifier.mjs";

const PUBLIC_SESSION_KEYS = [
  "id",
  "responseId",
  "messageId",
  "sessionId",
  "conversationId",
  "threadId",
  "requestId",
  "provider",
  "providerKind",
  "model",
  "turn",
  "source",
  "createdAt",
];

const PROVIDER_CONTEXT_OMIT_KEYS = new Set([
  "authorization",
  "authorizationEvent",
  "authorizations",
  "answered",
  "approved",
  "approvedScopes",
  "contextPath",
  "currentTranscriptPath",
  "deniedScopes",
  "notRestored",
  "providerSession",
  "providerSessions",
  "recordPath",
  "requiredAuthorizationCount",
  "requiredAuthorizations",
  "scope",
  "savedRecordPath",
  "sourceTranscriptPath",
  "transcriptPath",
]);

export function normalizeProviderSession(session, defaults = {}) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return undefined;
  }
  if (!hasSessionIdentity(session)) {
    return undefined;
  }
  const source = session;
  const merged = {
    ...defaults,
    ...source,
  };
  const result = {};
  for (const key of PUBLIC_SESSION_KEYS) {
    const value = merged[key];
    if (typeof value === "string" && value.trim() !== "") {
      result[key] = truncate(redactProviderSessionValue(value.trim()), 500);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function collectProviderSessions(calls = []) {
  const sessions = [];
  const seen = new Set();
  for (const call of calls) {
    const session = normalizeProviderSession(call.providerSession, {
      provider: call.provider,
      providerKind: call.providerKind,
      model: call.model,
    });
    if (!session) continue;
    const key = JSON.stringify(session);
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(session);
  }
  return sessions;
}

export function prepareProviderInput({ input = {}, provider, workspaceRoot } = {}) {
  const resumeProviderSession = selectResumeProviderSession({
    conversationContext: input.conversationContext,
    provider,
  });
  const prepared = sanitizeProviderInput({
    ...input,
    conversationContext: sanitizeProviderConversationContext(input.conversationContext, { workspaceRoot }),
  }, { workspaceRoot });
  if (resumeProviderSession) {
    prepared.resumeProviderSession = resumeProviderSession;
  } else {
    delete prepared.resumeProviderSession;
  }
  return prepared;
}

function sanitizeProviderInput(input = {}, { workspaceRoot } = {}) {
  const prepared = { ...input };
  if (Array.isArray(prepared.files)) {
    prepared.files = prepared.files.map((filePath) => sanitizeProviderPath(filePath, { workspaceRoot }));
  }
  if (typeof prepared.target === "string") {
    prepared.target = sanitizeProviderPath(prepared.target, { workspaceRoot });
  }
  if (typeof prepared.content === "string" && isProtectedModelPath(prepared.target, { workspaceRoot })) {
    prepared.content = "[withheld from model context]";
  }
  if (Array.isArray(prepared.toolIntents)) {
    prepared.toolIntents = prepared.toolIntents.map((intent) => sanitizeProviderToolIntent(intent, { workspaceRoot }));
  }
  return prepared;
}

function sanitizeProviderToolIntent(intent = {}, { workspaceRoot } = {}) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    return intent;
  }
  if (
    intent.type === "write"
    && typeof intent.content === "string"
    && isProtectedModelPath(intent.path, { workspaceRoot })
  ) {
    return {
      ...intent,
      path: sanitizeProviderPath(intent.path, { workspaceRoot }),
      content: "[withheld from model context]",
    };
  }
  if (typeof intent.path === "string") {
    return {
      ...intent,
      path: sanitizeProviderPath(intent.path, { workspaceRoot }),
    };
  }
  return intent;
}

export function sanitizeProviderRuntimeValue(value, { workspaceRoot } = {}) {
  return sanitizeProviderValue(value, { workspaceRoot });
}

export function selectResumeProviderSession({ conversationContext, provider } = {}) {
  const providerName = typeof provider === "string" ? provider : provider?.name;
  if (!providerName || !conversationContext || typeof conversationContext !== "object") {
    return undefined;
  }
  const sessions = collectContextProviderSessions(conversationContext);
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const session = normalizeProviderSession(sessions[i]);
    if (session?.provider === providerName) {
      return normalizeProviderSession(session, {
        provider: providerName,
        providerKind: provider?.kind,
      });
    }
  }
  return undefined;
}

function collectContextProviderSessions(context = {}) {
  const sessions = [];
  collectFromContext(context, sessions, 0);
  return sessions;
}

function collectFromContext(value, sessions, depth) {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFromContext(item, sessions, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "providerSessions" || key === "providerSession") continue;
    collectFromContext(child, sessions, depth + 1);
  }
  if (Array.isArray(value.providerSessions)) {
    sessions.push(...value.providerSessions);
  }
  if (value.providerSession && typeof value.providerSession === "object") {
    sessions.push(value.providerSession);
  }
}

function sanitizeProviderConversationContext(value, { workspaceRoot } = {}, depth = 0) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return sanitizeProviderString(value, { workspaceRoot });
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderConversationContext(item, { workspaceRoot }, depth + 1));
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (PROVIDER_CONTEXT_OMIT_KEYS.has(key)) continue;
    result[key] = sanitizeProviderConversationContext(child, { workspaceRoot }, depth + 1);
  }
  return result;
}

function sanitizeProviderValue(value, { workspaceRoot } = {}, depth = 0) {
  if (typeof value === "string") return sanitizeProviderString(value, { workspaceRoot });
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderValue(item, { workspaceRoot }, depth + 1));
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /path$/i.test(key)) {
      result[key] = sanitizeProviderPath(child, { workspaceRoot });
    } else {
      result[key] = sanitizeProviderValue(child, { workspaceRoot }, depth + 1);
    }
  }
  return result;
}

function sanitizeProviderPath(value, { workspaceRoot } = {}) {
  if (typeof value !== "string" || value === "") return value;
  if (!path.isAbsolute(value)) return sanitizeProviderString(value, { workspaceRoot });
  const root = path.resolve(workspaceRoot || process.cwd());
  const relative = path.relative(root, path.resolve(value));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return sanitizeProviderString(value, { workspaceRoot });
}

function sanitizeProviderString(value, { workspaceRoot } = {}) {
  if (typeof value !== "string" || value === "") return value;
  if (!workspaceRoot) return value;
  const root = path.resolve(workspaceRoot);
  return value
    .split(`${root}${path.sep}`)
    .join("")
    .split(root)
    .join(".");
}

function truncate(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function hasSessionIdentity(session) {
  return [
    "id",
    "responseId",
    "messageId",
    "sessionId",
    "conversationId",
    "threadId",
    "requestId",
    "turn",
    "createdAt",
  ].some((key) => session[key] !== undefined && session[key] !== "");
}
