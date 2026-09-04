import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { dshWebRpc, waitForDshWeb } from "./dsh-web-rpc.mjs";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())),
  };
}

function rpcResponse(request, response, requiredCookie, validate) {
  if (request.method !== "POST" || !request.url?.startsWith("/api/")) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  if (requiredCookie && request.headers.cookie !== requiredCookie) {
    response.statusCode = 401;
    response.end("authentication required");
    return;
  }
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const call = JSON.parse(body);
    assert.equal(request.url, `/api/${call.method}`);
    const value = validate?.(call) ?? { presets: [{ id: "standard" }] };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { ok: true, value } }));
  });
}

const runningChild = { exitCode: null };

test("DSH Web RPC exchanges the rc.1 launch token and uses Remote endpoints", async () => {
  const authCookie = "dsh-auth-test=signed";
  const csrfCookie = "dsh-csrf-test=bound";
  const cookieHeader = `${authCookie}; ${csrfCookie}`;
  let baseUrl = "";
  const server = await listen((request, response) => {
    if (request.method === "GET" && request.url === "/?token=launch-secret") {
      response.statusCode = 303;
      response.setHeader("location", "/");
      response.setHeader("set-cookie", [
        `${authCookie}; Path=/; HttpOnly; SameSite=Strict`,
        `${csrfCookie}; Path=/; HttpOnly; SameSite=Strict`,
      ]);
      response.end();
      return;
    }
    rpcResponse(request, response, cookieHeader, (call) => {
      if (call.method === "agentPresets/list") {
        assert.deepEqual(call.payload, { args: {} });
        return { presets: [{ id: "standard" }] };
      }
      if (call.method === "session/create") {
        assert.deepEqual(call.payload, { args: { request: { cwd: "/workspace", agentPreset: "odai" } } });
        return { sessionId: "session-current", agentPreset: "odai" };
      }
      if (call.method === "session/selectModel") return { selected: call.payload.args.request };
      if (call.method === "session/prompt") return { accepted: true };
      if (call.method === "custom.ping") return { pong: true };
      if (call.method === "session/page") {
        assert.deepEqual(call.payload.args.request.address, { kind: "session", sessionId: "session-current" });
        assert.equal(call.payload.args.request.throughSeq, Number.MAX_SAFE_INTEGER);
        if (call.payload.args.request.maxMessages === 0) return { records: null, hasMore: false };
        return { records: [{ type: "event", event: { type: "turn/end", seq: 1 } }], hasMore: false };
      }
      throw new Error(`unexpected Remote method ${call.method}`);
    });
  });
  baseUrl = server.baseUrl;
  try {
    const output = () => `dsh web: ${baseUrl}/?token=launch-secret\n`;
    const exchanged = await waitForDshWeb(baseUrl, runningChild, output);
    assert.equal(exchanged, cookieHeader);
    assert.deepEqual(await dshWebRpc(baseUrl, "agentPreset.list", {}, exchanged), {
      presets: [{ id: "standard" }],
    });
    assert.deepEqual(await dshWebRpc(baseUrl, "session.create", {
      cwd: "/workspace",
      agentPreset: "odai",
    }, exchanged), { sessionId: "session-current", agentPreset: "odai" });
    assert.deepEqual(await dshWebRpc(baseUrl, "session.selectModel", {
      sessionId: "session-current",
      provider: "provider",
      model: "model",
    }, exchanged), {
      selected: { sessionId: "session-current", provider: "provider", model: "model" },
    });
    assert.deepEqual(await dshWebRpc(baseUrl, "session.prompt", {
      sessionId: "session-current",
      mode: "queue",
      content: [{ type: "text", text: "probe" }],
    }, exchanged), { accepted: true });
    assert.deepEqual(await dshWebRpc(baseUrl, "custom.ping", { value: 1 }, exchanged), { pong: true });
    assert.deepEqual(await dshWebRpc(baseUrl, "session.history", {
      sessionId: "session-current",
      maxMessages: 10,
    }, exchanged), {
      events: [{ type: "event", event: { type: "turn/end", seq: 1 } }],
      hasMore: false,
    });
    await assert.rejects(
      dshWebRpc(baseUrl, "session.history", { sessionId: "session-current", maxMessages: 0 }, exchanged),
      /session\/page response is malformed/u,
    );
  } finally {
    await server.close();
  }
});
