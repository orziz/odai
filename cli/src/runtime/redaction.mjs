const REDACTED = "[redacted]";

const SENSITIVE_KEY_RE =
  /(?:^|[-_.])(api[-_]?key|authorization|auth|client[-_]?secret|credential|cookie|password|passwd|refresh[-_]?token|secret|session|token)(?:[-_.]|$)/i;
const HEADER_RE = /^([^:]+):\s*(.*)$/;
const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const JSON_SECRET_RE =
  /(["']?(?:api[-_]?key|authorization|auth|client[-_]?secret|credential|cookie|password|passwd|refresh[-_]?token|secret|session|token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const QUERY_SECRET_RE =
  /((?:api[-_]?key|authorization|auth|client[-_]?secret|credential|cookie|password|passwd|refresh[-_]?token|secret|session|token)=)([^&\s]+)/gi;
const PROVIDER_SESSION_SECRET_RE =
  /((?:api[-_]?key|authorization|auth|client[-_]?secret|credential|cookie|password|passwd|refresh[-_]?token|secret|session|token)=)([^&\s]+)/gi;
const LONG_SECRET_RE = /\b(?:sk|pk|ghp|github_pat|glpat|xoxb|xoxp)-[A-Za-z0-9_./+=-]{8,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9_./+=-]+/gi;
const ANSI_ESCAPE_RE =
  /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\))|(?:[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

const NEXT_VALUE_FLAGS = new Set([
  "--api-key",
  "--apikey",
  "--auth",
  "--authorization",
  "--client-secret",
  "--cookie",
  "--password",
  "--passwd",
  "--refresh-token",
  "--secret",
  "--session",
  "--token",
  "-u",
  "--user",
]);
const OMIT_VALUE_FLAGS = new Set(["--content", "--tool-intent-json"]);
const NON_RESTORABLE_FLAGS = new Set([
  "--allow-network",
  "--allow-shell",
  "--use-api-key",
  "--use-provider-command",
]);

export function publicIntent(intent = {}) {
  const output = {
    type: intent.type,
    path: intent.path,
    command: redactCommand(intent.command),
    url: redactUrl(intent.url),
    method: intent.method,
    question: typeof intent.question === "string" ? redactString(intent.question) : intent.question,
    summary: typeof intent.summary === "string" ? redactString(intent.summary) : intent.summary,
    actor: intent.actor,
    risk: intent.risk,
    perception: intent.perception,
  };
  if (typeof intent.pattern === "string") {
    output.pattern = redactString(intent.pattern);
  } else if (intent.pattern !== undefined) {
    output.pattern = intent.pattern;
  }
  if (intent.maxEntries !== undefined) {
    output.maxEntries = intent.maxEntries;
  }
  if (intent.maxResults !== undefined) {
    output.maxResults = intent.maxResults;
  }
  return output;
}

export function publicToolResult(result = {}) {
  const output = {
    ok: Boolean(result.ok),
    type: result.type,
    gate: result.gate,
    reason: typeof result.reason === "string" ? redactString(result.reason) : result.reason,
    error: typeof result.error === "string" ? redactString(result.error) : result.error,
    path: result.path,
    command: redactCommand(result.command),
    url: redactUrl(result.url),
    method: result.method,
    status: result.status,
    skipped: result.skipped,
    bytes: typeof result.body === "string" ? result.body.length : undefined,
    ...(typeof result.content === "string" ? { bytes: result.content.length } : {}),
  };
  if (Array.isArray(result.entries)) {
    output.entries = result.entries.map(publicListEntry);
  }
  if (Array.isArray(result.matches)) {
    output.matches = result.matches.map(publicSearchMatch);
  }
  if (result.truncated !== undefined) {
    output.truncated = Boolean(result.truncated);
  }
  return output;
}

export function providerToolResult(result = {}) {
  const base = publicToolResult(result);
  if (result.type === "read" && typeof result.content === "string") {
    if (result.privateContent) {
      return {
        ...base,
        privateContent: true,
        content: "[withheld from model context]",
      };
    }
    return {
      ...base,
      content: result.content,
    };
  }
  if (result.type === "shell") {
    return {
      ...base,
      sandbox: result.sandbox,
      stdout: typeof result.stdout === "string" ? result.stdout : undefined,
      stderr: typeof result.stderr === "string" ? result.stderr : undefined,
      timedOut: result.timedOut,
    };
  }
  if (result.type === "network") {
    return {
      ...base,
      headers: result.headers,
      body: typeof result.body === "string" ? redactString(result.body) : undefined,
      untrusted: typeof result.body === "string" ? true : undefined,
    };
  }
  return base;
}

function publicListEntry(entry = {}) {
  return {
    name: typeof entry.name === "string" ? redactString(entry.name) : entry.name,
    path: typeof entry.path === "string" ? redactString(entry.path) : entry.path,
    type: entry.type,
  };
}

function publicSearchMatch(match = {}) {
  return {
    path: typeof match.path === "string" ? redactString(match.path) : match.path,
    line: match.line,
    text: typeof match.text === "string" ? redactString(match.text) : match.text,
  };
}

export function publicTaskArgv(argv = []) {
  if (!Array.isArray(argv)) return [];

  const result = [];
  let omitNext = false;
  for (const part of argv) {
    const value = String(part);
    if (omitNext) {
      omitNext = false;
      continue;
    }

    const [name, ...rest] = value.split("=");
    if (OMIT_VALUE_FLAGS.has(name)) {
      omitNext = rest.length === 0;
      continue;
    }
    if (NON_RESTORABLE_FLAGS.has(name)) {
      continue;
    }
    result.push(redactString(redactUrl(value)));
  }
  return result;
}

export function publicInputLine(line = "") {
  const value = String(line);
  if (/(^|\s)(--content|--tool-intent-json)(=|\s|$)/.test(value)) {
    return "[redacted input]";
  }
  return redactString(value);
}

export function redactCommand(command) {
  if (!Array.isArray(command)) return command;

  const redacted = [];
  let redactNext = false;
  for (const part of command) {
    const value = String(part);
    if (redactNext) {
      redacted.push(REDACTED);
      redactNext = false;
      continue;
    }

    const option = redactOption(value);
    if (option.redacted) {
      redacted.push(option.value);
      redactNext = option.redactNext;
      continue;
    }

    const header = redactHeader(value);
    redacted.push(redactString(redactUrl(header)));
  }
  return redacted;
}

export function redactUrl(value) {
  if (typeof value !== "string" || value === "") return value;

  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY_RE.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactString(value = "") {
  if (typeof value !== "string") return value;
  return stripUnsafeControlSequences(value)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(LONG_SECRET_RE, REDACTED)
    .replace(JSON_SECRET_RE, (_match, prefix, rawValue) => `${prefix}${quoteLike(rawValue, REDACTED)}`)
    .replace(QUERY_SECRET_RE, (_match, prefix) => `${prefix}${REDACTED}`);
}

export function redactModelValue(value) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactModelValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" ? redactString(entry) : redactModelValue(entry),
    ]),
  );
}

export function publicModelList(value) {
  return Array.isArray(value) ? value.map(redactModelValue) : [];
}

export function publicUsage(value, depth = 0) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (!value || typeof value !== "object" || depth > 4) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map((entry) => publicUsage(entry, depth + 1)).filter((entry) => entry !== undefined);
    return items.length > 0 ? items : undefined;
  }

  const entries = Object.entries(value)
    .map(([key, entry]) => [key, publicUsage(entry, depth + 1)])
    .filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function redactProviderSessionValue(value = "") {
  if (typeof value !== "string") return value;
  return stripUnsafeControlSequences(redactUrl(value))
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(LONG_SECRET_RE, REDACTED)
    .replace(PROVIDER_SESSION_SECRET_RE, (_match, prefix) => `${prefix}${REDACTED}`);
}

function stripUnsafeControlSequences(value = "") {
  return String(value).replace(ANSI_ESCAPE_RE, "").replace(UNSAFE_CONTROL_RE, "");
}

function redactOption(value) {
  const [name, ...rest] = value.split("=");
  const normalized = name.toLowerCase();
  if (NEXT_VALUE_FLAGS.has(normalized)) {
    return {
      redacted: true,
      value: name,
      redactNext: rest.length === 0,
    };
  }

  if (SENSITIVE_KEY_RE.test(normalized) && rest.length > 0) {
    return {
      redacted: true,
      value: `${name}=${REDACTED}`,
      redactNext: false,
    };
  }

  const assignment = ENV_ASSIGNMENT_RE.exec(value);
  if (assignment && SENSITIVE_KEY_RE.test(assignment[1])) {
    return {
      redacted: true,
      value: `${assignment[1]}=${REDACTED}`,
      redactNext: false,
    };
  }

  return {
    redacted: false,
    value,
    redactNext: false,
  };
}

function redactHeader(value) {
  const header = HEADER_RE.exec(value);
  if (!header) return value;
  const name = header[1].trim();
  if (!SENSITIVE_KEY_RE.test(name)) return value;
  return `${name}: ${REDACTED}`;
}

function quoteLike(rawValue, value) {
  if (rawValue.startsWith('"')) return JSON.stringify(value);
  if (rawValue.startsWith("'")) return `'${value}'`;
  return value;
}
