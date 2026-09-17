import { randomUUID } from "node:crypto";

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function launchUrl(output) {
  const match = output.match(/dsh web:\s+(https?:\/\/[^\s]+)/u);
  if (!match) return undefined;
  try {
    const url = new URL(match[1]);
    return url.searchParams.has("token") ? url : undefined;
  } catch {
    return undefined;
  }
}

async function exchangeLaunchToken(url) {
  const response = await fetch(url, { redirect: "manual" });
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
  if (response.status !== 303 || !cookie) {
    throw new Error(`dsh web launch-token exchange failed with HTTP ${response.status}`);
  }
  return cookie;
}

const remoteMethods = Object.freeze({
  "agentPreset.list": { endpoint: "agentPresets/list", request: () => ({ args: {} }) },
  "session.create": { endpoint: "session/create", request: (payload) => ({ args: { request: payload } }) },
  "session.prompt": { endpoint: "session/prompt", request: (payload) => ({ args: { request: { ...payload, requestId: payload.requestId ?? randomUUID() } } }) },
  "session.selectModel": { endpoint: "session/selectModel", request: (payload) => ({ args: { request: payload } }) },
  "session.history": {
    endpoint: "session/page",
    request: (payload) => ({
      args: {
        request: {
          address: { kind: "session", sessionId: payload.sessionId },
          throughSeq: payload.throughSeq,
          ...(payload.beforeSeq === undefined ? {} : { beforeSeq: payload.beforeSeq }),
          ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
        },
      },
    }),
    response: (value) => {
      const page = record(value);
      if (!page || !Array.isArray(page.records) || typeof page.hasMore !== "boolean") {
        throw new Error("DSH Remote session/page response is malformed");
      }
      const events = page.records.filter((entry) => record(entry)?.type === "event");
      if (events.some((entry) => !record(entry.event))) {
        throw new Error("DSH Remote session/page event record is malformed");
      }
      return { events, hasMore: page.hasMore };
    },
  },
});

async function callRpc(baseUrl, endpoint, payload, cookie) {
  const rpcId = `${endpoint}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(`${baseUrl}/api/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload }),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${endpoint} HTTP ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }
  const body = record(JSON.parse(text));
  const result = record(body?.result);
  if (result?.ok !== true) throw new Error(`${endpoint} failed: ${text}`);
  return result.value;
}

async function sessionCursor(baseUrl, sessionId, cookie) {
  const url = new URL("/api/remote.mux", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const streamId = randomUUID();
  return await new Promise((accept, reject) => {
    const socket = new WebSocket(url, { headers: { origin: new URL(baseUrl).origin, ...(cookie ? { cookie } : {}) } });
    let settled = false;
    const finish = (error, cursor) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel", streamId }));
      socket.close();
      if (error) reject(error); else accept(cursor);
    };
    const timer = setTimeout(() => finish(new Error("timed out reading DSH session/follow cursor")), 20_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "open", streamId,
      endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId }, maxMessages: 1 } } } })));
    socket.addEventListener("message", (event) => {
      if (settled) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.streamId !== streamId) return;
        if (frame.type === "error") throw new Error(`session/follow failed: ${JSON.stringify(frame.error)}`);
        if (frame.type === "end") throw new Error("session/follow ended without a snapshot");
        if (frame.type !== "item" || frame.value?.type !== "snapshot") return;
        const { cursor, header } = frame.value;
        if (!Number.isSafeInteger(cursor) || cursor < -1 || header?.id !== sessionId) throw new Error("session/follow returned an invalid cursor or session identity");
        finish(undefined, cursor);
      } catch (error) { finish(error); }
    });
    socket.addEventListener("error", () => finish(new Error("DSH session/follow WebSocket failed")));
    socket.addEventListener("close", () => finish(new Error("DSH session/follow closed without a snapshot")));
  });
}

export async function dshWebRpc(baseUrl, method, payload, cookie) {
  if (method === "session.history" && payload.throughSeq === undefined) {
    payload = { ...payload, throughSeq: await sessionCursor(baseUrl, payload.sessionId, cookie) };
  }
  const remote = remoteMethods[method];
  if (!remote) return await callRpc(baseUrl, method, payload, cookie);
  const value = await callRpc(baseUrl, remote.endpoint, remote.request(payload), cookie);
  return remote.response ? remote.response(value) : value;
}

export async function waitForDshWeb(baseUrl, child, output, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let cookie;
  let exchangedUrl;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited early (${child.exitCode})\n${output()}`);
    try {
      const tokenUrl = launchUrl(output());
      if (tokenUrl && tokenUrl.href !== exchangedUrl) {
        cookie = await exchangeLaunchToken(tokenUrl);
        exchangedUrl = tokenUrl.href;
      }
      if (!cookie) throw new Error("waiting for the authenticated DSH Web transport");
      await dshWebRpc(baseUrl, "agentPreset.list", {}, cookie);
      return cookie;
    } catch (error) {
      lastError = error;
      await new Promise((accept) => setTimeout(accept, 75));
    }
  }
  const detail = lastError instanceof Error ? `\nlast RPC error: ${lastError.message}` : "";
  throw new Error(`timed out waiting for dsh web${detail}\n${output()}`);
}
