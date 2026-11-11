import assert from "node:assert/strict";
import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {installCompactionPressureRuntime} from "../../runtime/build/compaction-pressure-runtime.mjs";

const binary = realpathSync(execFileSync("which", [process.env.DSH_BIN ?? "dsh"], {encoding: "utf8"}).trim());
const requireHost = createRequire(binary);
const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
const {Context} = await load("@deepseek-ai/cordis");
const {BasicCompactionEngine} = await load("@deepseek-ai/dsh-compaction-basic");
const root = new Context(), fibers = [], warnings = [];
const temporary = mkdtempSync(join(tmpdir(), "odai-pressure-native-"));
let adapter, engine, measured = 0, total = 799, resolved = 0;
const header = {config: {provider: "probe", model: "large", maxTokens: 999}};
const agent = {options: {}, session: {seq: 0, surface: {nodes: []}, requestHeader: () => header, eventAt() {throw new Error("Unexpected empty surface access");}}};
const signal = new AbortController().signal;
try {
  fibers.push(await root.plugin(ctx => {
    ctx.provide("loader", {import: load});
    ctx.provide("llm", {async resolveModelInfo() {resolved++; return {context: {contextWindow: 1000}, defaultMaxTokens: 999};}});
    ctx.provide("tokenMeter", {measure() {measured++; return {totalTokens: total, nodes: []};}});
    ctx.provide("sessions", {});
  }));
  const adapterFiber = await root.plugin(ctx => {
    adapter = installCompactionPressureRuntime(ctx, {storePath: join(temporary, "settings"), agentForSession: () => agent, engineForAgent: () => engine, warn: message => warnings.push(message)});
    adapter.enableProfile(ctx);
  });
  fibers.push(adapterFiber);
  fibers.push(await root.plugin(BasicCompactionEngine, {}));
  engine = root.get("compaction");
  await adapter.ready;
  assert.equal(adapter.status(agent).supported, true);
  assert.equal(adapter.status(agent).effectiveMode, "host");
  await adapter.control({action: "set", sessionId: "probe", mode: "window-ratio"}, signal);
  let terminal = 0;
  await root.waterfall("agent/pre-step", {agent, signal}, () => {terminal++;});
  assert.equal(terminal, 1); assert.ok(measured > 0); assert.deepEqual(warnings, []);
  const changed = {provider: "probe", model: "other", maxTokens: 999};
  assert.equal(await root.waterfall("agent/request", {agent, signal}, () => changed), changed);
  total = 800;
  await assert.rejects(root.waterfall("agent/request", {agent, signal}, () => changed), error => error.code === "MODEL_SWITCH_COMPACTION_FAILED");
  const aborted = new AbortController(); aborted.abort();
  const before = resolved;
  await root.waterfall("agent/pre-step", {agent, signal: aborted.signal}, () => {terminal++;});
  assert.equal(resolved, before);
  let overflowNext = 0;
  await root.waterfall("agent/request-error", {agent, signal: aborted.signal, failure: {code: "CONTEXT_WINDOW_EXCEEDED"}}, () => {overflowNext++;});
  assert.equal(overflowNext, 1);
  await adapterFiber.dispose();
  assert.equal(adapter.status(agent).effectiveMode, "host");
  await root.waterfall("agent/pre-step", {agent, signal: aborted.signal}, () => {terminal++;});
  assert.equal(terminal, 3);
  console.log("Native pressure adapter: threshold, output reservation, switch rejection, cancellation, overflow bypass and unload passed");
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  rmSync(temporary, {recursive: true, force: true});
}
