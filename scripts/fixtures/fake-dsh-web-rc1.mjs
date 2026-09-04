#!/usr/bin/env node

import { createServer } from "node:http";

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
if (portIndex < 0 || !Number.isInteger(port) || port <= 0) {
  throw new Error("--port requires a positive integer");
}

const launchToken = "canary-launch-token";
const authCookie = "dsh-auth-canary=signed";
const csrfCookie = "dsh-csrf-canary=bound";
const requiredCookie = `${authCookie}; ${csrfCookie}`;
let preset;
let selection;

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === `/?token=${launchToken}`) {
    response.statusCode = 303;
    response.setHeader("location", "/");
    response.setHeader("set-cookie", [
      `${authCookie}; Path=/; HttpOnly; SameSite=Strict`,
      `${csrfCookie}; Path=/; HttpOnly; SameSite=Strict`,
    ]);
    response.end();
    return;
  }

  if (request.method !== "POST" || !request.url?.startsWith("/api/")) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  if (request.headers.cookie !== requiredCookie) {
    response.statusCode = 401;
    response.end("authentication required");
    return;
  }

  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const call = JSON.parse(body);
    if (request.url !== `/api/${call.method}`) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const requestPayload = call.payload?.args?.request;
    let value;
    if (call.method === "agentPresets/list") {
      value = { presets: [{ id: "odai" }] };
    } else if (call.method === "session/create") {
      preset = requestPayload?.agentPreset;
      value = { sessionId: "session-test", agentPreset: preset };
    } else if (call.method === "session/selectModel") {
      selection = requestPayload;
      value = { selected: requestPayload };
    } else if (call.method === "session/prompt") {
      value = { accepted: true };
    } else if (call.method === "session/page") {
      value = {
        records: [
          {
            type: "event",
            event: {
              type: "assistant/message",
              seq: 1,
              data: {
                message: {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      preset,
                      model: selection?.model,
                      permissionMode: process.env.DSH_PERMISSION_MODE,
                    }),
                  }],
                },
              },
            },
          },
          {
            type: "event",
            event: { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } },
          },
        ],
        hasMore: false,
      };
    } else {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { ok: true, value } }));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=${launchToken}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
