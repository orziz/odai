#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { attachFollowFixture } from "./fake-dsh-follow.mjs";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
if (!Number.isInteger(port) || port <= 0) throw new Error("--port requires a positive integer");
const patch = readFileSync(process.argv[process.argv.indexOf("--patch") + 1], "utf8");
const sessionRoot = JSON.parse(/^    root: (.+)$/mu.exec(patch)[1]);
const statePath = resolve(process.env.DSH_HOME, "fake-session.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sessionId: "session-test", events: [] };
const launchToken = "canary-launch-token";
const requiredCookie = "dsh-auth-canary=signed; dsh-csrf-canary=bound";
function append(type, data) { state.events.push({ type, seq: state.events.length, data }); }
function persist() {
  writeFileSync(statePath, JSON.stringify(state));
  const directory = resolve(sessionRoot, state.sessionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "session.v3.jsonl"), [{ id: state.sessionId, origin: "controller" }, ...state.events].map(value => JSON.stringify(value)).join("\n") + "\n");
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === `/?token=${launchToken}`) {
    response.statusCode = 303;
    response.setHeader("location", "/");
    response.setHeader("set-cookie", ["dsh-auth-canary=signed; Path=/; HttpOnly; SameSite=Strict", "dsh-csrf-canary=bound; Path=/; HttpOnly; SameSite=Strict"]);
    response.end();
    return;
  }
  if (request.method !== "POST" || !request.url?.startsWith("/api/")) { response.writeHead(404).end(); return; }
  if (request.headers.cookie !== requiredCookie) { response.writeHead(401).end(); return; }
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    try {
      const call = JSON.parse(body);
      if (request.url !== `/api/${call.method}`) throw new Error("wrong endpoint");
      const payload = call.payload?.args?.request;
      let value;
      if (call.method === "agentPresets/list") value = { presets: [{ id: "odai" }, { id: "standard" }] };
      else if (call.method === "session/create") {
        if (payload.sessionId && payload.sessionId !== state.sessionId) throw new Error("wrong adoption identity");
        state.preset = payload.agentPreset;
        value = { sessionId: state.sessionId, agentPreset: state.preset };
      } else if (call.method === "session/selectModel") {
        state.selection = payload;
        value = { selected: payload };
      } else if (call.method === "session/prompt") {
        if (typeof payload.requestId !== "string" || !payload.requestId) throw new Error("requestId is required");
        if (state.pending) throw new Error("previous turn is still active");
        let turn = state.events.filter(event => event.type === "turn/start").length + 1;
        if (state.events.length) {
          // A different queued turn finishes after the caller's before snapshot.
          append("turn/start", { turn });
          append("turn/end", { turn, reason: { kind: "completed" } });
          turn += 1;
        }
        const message = { id: `message-${turn}`, role: "user", source: { kind: "user", rpcId: payload.requestId }, content: payload.content };
        append("turn/start", { turn });
        if (process.env.ODAI_TEST_UNCLAIMED_MESSAGE === "1") {
          // The review counterexample violates native claiming order: reject it.
          append("user/message", message);
          append("turn/end", { turn, reason: { kind: "completed" } });
        } else {
          append("step/start", { turn, step: 1 });
          append("user/message", message);
          const policy = JSON.parse(readFileSync(resolve(process.env.DSH_HOME, "odai/output.json"), "utf8"));
          append("system/message", { turn, step: 1, message: { role: "system", content: [{ type: "text", text: policy.policy.concise ? "## Odai controller output policy" : "Plain host policy" }] } });
          if (!state.events.some(event => event.type === "request/header")) append("request/header", { turn, step: 1, header: { config: state.selection } });
          state.pending = { turn, polls: 0, text: payload.content.map(block => block.text ?? "").join("") };
        }
        value = { accepted: true };
      } else if (call.method === "session/page") {
        if (!Number.isSafeInteger(payload.throughSeq) || payload.throughSeq > (state.events.at(-1)?.seq ?? -1)) throw new Error("page cursor is past committed history");
        if (state.pending && payload.beforeSeq === undefined && ++state.pending.polls >= 2) {
          const { turn, text } = state.pending;
          const questionMode = process.env.ODAI_TEST_QUESTION_MODE;
          if (questionMode && !state.pending.asked) {
            // Real DSH nests callId under message.source; a prior completed
            // read must not hide the unanswered question that follows it.
            append("tool/call", { turn, step: 1, callId: "prior-read", name: "read", arguments: "{}" });
            append("tool/result", { turn, step: 1, message: { role: "user",
              source: { kind: "tool", callId: "prior-read" },
              content: [{ type: "tool-result", toolCallId: "prior-read", content: [] }],
            } });
            const args = questionMode === "malformed" ? "invalid-json" : JSON.stringify({ questions: [
              { id: "decision", question: "Which bounded next step?", options: [{ label: "Collect evidence", description: "Keep production unchanged while verifying idempotency." }] },
            ] });
            append("assistant/message", { turn, step: 1, message: { content: [
              { type: "text", text: JSON.stringify({ facts: "The request may already have succeeded." }) },
              { type: "tool-call", id: "question-call", name: "ask_user_question", arguments: args },
            ] }, usage: { inputTokens: 5, outputTokens: 5 } });
            append("tool/call", { turn, step: 1, callId: "question-call", name: "ask_user_question", arguments: args });
            state.pending.asked = true;
          }
          if (questionMode !== "pending") {
            if (questionMode) append("tool/result", { turn, step: 1, message: {
              source: { kind: "tool", callId: "question-call" }, role: "user",
              content: [{ type: "tool-result", toolCallId: "question-call", isError: questionMode === "malformed", content: [] }],
            } });
            writeFileSync(resolve(process.cwd(), "turn-state.txt"), text);
            append("assistant/message", { turn, step: 1, message: { content: [{ type: "text", text: JSON.stringify({ preset: state.preset, model: state.selection.model, permissionMode: process.env.DSH_PERMISSION_MODE }) }] }, usage: { inputTokens: 5, outputTokens: 5 } });
            append("step/end", { turn, step: 1 });
            append("turn/end", { turn, reason: { kind: "completed" } });
            delete state.pending;
          }
        }
        if (payload.beforeSeq === undefined) state.historyCut = payload.throughSeq;
        else if (payload.throughSeq !== state.historyCut) throw new Error("history page changed its fixed boundary");
        const selected = state.events.filter(event => event.seq <= payload.throughSeq && (process.env.ODAI_TEST_HISTORY_STALL === "1" || payload.beforeSeq === undefined || event.seq < payload.beforeSeq));
        // Deliberately paginate even short sessions to expose callers ignoring hasMore.
        value = { records: selected.slice(-2).map(event => ({ type: "event", event })), hasMore: selected.length > 2 };
      } else throw new Error(`unexpected method ${call.method}`);
      persist();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ result: { ok: true, value } }));
    } catch (error) { response.writeHead(400).end(String(error)); }
  });
});
attachFollowFixture(server, requiredCookie, request => {
  if (request.address.sessionId !== state.sessionId) throw new Error("wrong snapshot session");
  return { type: "snapshot", header: { id: state.sessionId }, cursor: state.events.at(-1)?.seq ?? -1, records: [], hasMore: false };
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=${launchToken}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
