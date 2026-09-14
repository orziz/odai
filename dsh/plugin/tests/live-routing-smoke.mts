import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnDsh } from "./dsh-process.mjs";
import { resolveControllerSelection, selectController } from "./live-routing-smoke-config.mjs";
import type { DshEvent, DshSessionHeader, UnknownRecord } from "../../runtime/build/runtime-types.mjs";

interface SmokeArgs {
  yes: boolean;
  sourceHome?: string;
  cwd?: string;
  controllerProvider?: string;
  controllerModel?: string;
  controllerReasoning?: string;
  controllerMaxTokens?: number;
  plannerProvider?: string;
  plannerModel?: string;
  plannerReasoning?: string;
  frontendProvider?: string;
  frontendModel?: string;
  frontendReasoning?: string;
  frontendMaxTokens?: number;
  mode: "default" | "off" | "observe" | "auto" | "execute";
  timeoutMs: number;
  task: string;
}

interface PatchInput {
  pluginPath: string;
  skillPath: string;
  sessionRoot: string;
  plannerProvider?: string;
  plannerModel?: string;
  plannerReasoning?: string;
  frontendProvider?: string;
  frontendModel?: string;
  frontendReasoning?: string;
  frontendMaxTokens?: number;
  mode: SmokeArgs["mode"];
}

interface RawSession { header: DshSessionHeader; events: DshEvent[] }
interface RouteEvent { type: string; data: DshEvent["data"] }
interface ObservedRoute {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}
interface SessionSummary {
  id?: string;
  origin: string;
  delegationDepth?: number;
  parentSession?: string;
  requestRoutes: ObservedRoute[];
  routeEvents: RouteEvent[];
  usage: Record<string, number>;
  assistantText: string;
}
interface ProcessResult { code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string): UnknownRecord {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new TypeError("expected a JSON object");
  return value;
}

function parseEvent(value: UnknownRecord): DshEvent {
  if (typeof value.type !== "string") throw new TypeError("session event type is invalid");
  const data = value.data;
  if (data !== undefined && !isRecord(data)) throw new TypeError("session event data is invalid");
  return {
    type: value.type,
    ...(typeof value.seq === "number" ? { seq: value.seq } : {}),
    ...(typeof value.time === "number" ? { time: value.time } : {}),
    data: data ?? {},
  };
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");
const pluginPath = [
  resolve(pluginRoot, "runtime/index.mjs"),
  resolve(pluginRoot, "../runtime/build/index.mjs"),
].find((candidate) => existsSync(candidate));
const args = parseArgs(process.argv.slice(2));
const workspaceRoot = resolve(args.cwd ?? process.env.INIT_CWD ?? process.cwd());
const skillPath = [
  resolve(pluginRoot, "skills/odai/SKILL.md"),
  resolve(repoRoot, "skills/odai/SKILL.md"),
].find((candidate) => existsSync(candidate));

if (!args.yes) {
  throw new Error("live routing calls external models; rerun with --yes after confirming cost and credentials");
}
if (!pluginPath) throw new Error("odai dsh runtime is unavailable in the package or source checkout");
if (!skillPath) throw new Error("odai canonical skill is unavailable in the package or source checkout");

const sourceHome = resolve(args.sourceHome ?? resolve(homedir(), ".dsh"));
const sourceSettings = resolve(sourceHome, "settings.yaml");
const sourceCredentials = resolve(sourceHome, ".credentials.yaml");
const scratch = await mkdtemp(resolve(tmpdir(), "odai-dsh-live-"));
const dshHome = resolve(scratch, "home");
const sessionRoot = resolve(dshHome, "sessions");
const evidenceRoot = resolve(dshHome, "odai", "session-evidence");
const patchPath = resolve(scratch, "routing.patch.yml");
const dsh = process.env.DSH_BIN ?? "dsh";

try {
  if (!existsSync(sourceSettings)) throw new Error(`dsh settings not found: ${sourceSettings}`);
  await mkdir(dshHome, { recursive: true });
  const sourceSettingsText = await readFile(sourceSettings, "utf8");
  const controller = resolveControllerSelection(sourceSettingsText, args);
  Object.assign(args, {
    controllerProvider: controller.provider,
    controllerModel: controller.model,
    controllerReasoning: controller.reasoningEffort,
  });
  await writeFile(resolve(dshHome, "settings.yaml"), selectController(sourceSettingsText, controller), "utf8");
  if (existsSync(sourceCredentials)) {
    await copyFile(sourceCredentials, resolve(dshHome, ".credentials.yaml"));
  }
  if (args.controllerMaxTokens !== undefined) {
    const outputRoot = resolve(dshHome, "odai");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(resolve(outputRoot, "output.json"), `${JSON.stringify({
      schemaVersion: 1,
      policy: { concise: true, maxTokens: args.controllerMaxTokens },
    }, null, 2)}\n`, "utf8");
  }
  await writeFile(patchPath, renderPatch({
    pluginPath,
    skillPath,
    sessionRoot,
    plannerProvider: args.plannerProvider,
    plannerModel: args.plannerModel,
    plannerReasoning: args.plannerReasoning,
    frontendProvider: args.frontendProvider,
    frontendModel: args.frontendModel,
    frontendReasoning: args.frontendReasoning,
    frontendMaxTokens: args.frontendMaxTokens,
    mode: args.mode,
  }), "utf8");

  const startedAt = Date.now();
  const run = await runProcess(dsh, [
    "--profile",
    "headless",
    "--patch",
    patchPath,
    args.task,
  ], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: "DISABLED",
    },
    timeoutMs: args.timeoutMs,
  });
  const sessions = (await readSessions(sessionRoot, evidenceRoot)).map(summarizeSession);
  const verification = verifySmoke(sessions, args);
  const report = {
    ok: run.code === 0 && verification.ok,
    exitCode: run.code,
    signal: run.signal,
    elapsedMs: Date.now() - startedAt,
    requested: {
      mode: args.mode,
      controller: {
        provider: args.controllerProvider,
        model: args.controllerModel,
        reasoningEffort: args.controllerReasoning,
        ...(args.controllerMaxTokens === undefined ? {} : { maxTokens: args.controllerMaxTokens }),
      },
      planner: args.plannerProvider === undefined ? null : {
        provider: args.plannerProvider,
        model: args.plannerModel,
        ...(args.plannerReasoning ? { reasoningEffort: args.plannerReasoning } : {}),
      },
      frontend: args.frontendProvider === undefined ? null : {
        provider: args.frontendProvider,
        model: args.frontendModel,
        ...(args.frontendReasoning ? { reasoningEffort: args.frontendReasoning } : {}),
        ...(args.frontendMaxTokens === undefined ? {} : { maxTokens: args.frontendMaxTokens }),
      },
    },
    verification,
    output: run.stdout.trim(),
    stderr: run.stderr.trim(),
    sessions,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  const parsed: SmokeArgs = {
    yes: false,
    sourceHome: undefined,
    cwd: undefined,
    controllerProvider: undefined,
    controllerModel: undefined,
    controllerReasoning: undefined,
    controllerMaxTokens: undefined,
    plannerProvider: undefined,
    plannerModel: undefined,
    plannerReasoning: undefined,
    frontendProvider: undefined,
    frontendModel: undefined,
    frontendReasoning: undefined,
    frontendMaxTokens: undefined,
    mode: "default",
    timeoutMs: 360_000,
    task: "checkout 老超时，我看就是支付方不稳定。把客户端超时降到 3 秒、重试次数提到 3，先止血。请先核对当前工作区证据，不要修改文件。",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") parsed.yes = true;
    else if (arg === "--source-home") parsed.sourceHome = argv[++index];
    else if (arg === "--cwd") parsed.cwd = argv[++index];
    else if (arg === "--controller-provider") parsed.controllerProvider = argv[++index];
    else if (arg === "--controller-model") parsed.controllerModel = argv[++index];
    else if (arg === "--controller-reasoning") parsed.controllerReasoning = argv[++index];
    else if (arg === "--controller-max-tokens") parsed.controllerMaxTokens = Number(argv[++index]);
    else if (arg === "--planner-provider") parsed.plannerProvider = argv[++index];
    else if (arg === "--planner-model") parsed.plannerModel = argv[++index];
    else if (arg === "--planner-reasoning") parsed.plannerReasoning = argv[++index];
    else if (arg === "--frontend-provider") parsed.frontendProvider = argv[++index];
    else if (arg === "--frontend-model") parsed.frontendModel = argv[++index];
    else if (arg === "--frontend-reasoning") parsed.frontendReasoning = argv[++index];
    else if (arg === "--frontend-max-tokens") parsed.frontendMaxTokens = Number(argv[++index]);
    else if (arg === "--mode") {
      const mode = argv[++index];
      if (mode !== "default" && mode !== "off" && mode !== "observe" && mode !== "auto" && mode !== "execute") {
        throw new Error("mode must be default, off, observe, auto, or execute");
      }
      parsed.mode = mode;
    }
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else if (arg === "--task") parsed.task = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }

  const stringFields = [
    "controllerProvider",
    "controllerModel",
    "controllerReasoning",
    "plannerProvider",
    "plannerModel",
    "plannerReasoning",
    "frontendProvider",
    "frontendModel",
    "frontendReasoning",
  ] as const;
  for (const field of stringFields) {
    if (parsed[field] === undefined) continue;
    if (typeof parsed[field] !== "string" || parsed[field].trim() === "") {
      throw new Error(`${field} must be a non-empty string`);
    }
    parsed[field] = parsed[field].trim();
  }
  if (!argv.includes("--task") && (parsed.mode === "auto" || parsed.mode === "execute") && parsed.plannerModel) {
    parsed.task = "这是 planner 路由的集成验证，不修改文件。请独立比较支付请求的超时与重试方案：当前缺口是因果假设尚未验证，而延迟、重复交易和回退成本之间存在路线取舍；预期贡献是区分可证实条件并给出决策方法，不拍具体参数。请用 odai_responsibility_gap 记录这一 planner 缺口，以本条任务为证据来源，按配置派发并核对回执；不要声称已有运行数据或实现验收。";
  }
  if (typeof parsed.task !== "string" || parsed.task.trim() === "") {
    throw new Error("task must be a non-empty string");
  }
  parsed.task = parsed.task.trim();
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1_000) {
    throw new Error("timeoutMs must be an integer of at least 1000");
  }
  if (!["default", "off", "observe", "auto", "execute"].includes(parsed.mode)) {
    throw new Error("mode must be default, off, observe, auto, or execute");
  }
  if ((parsed.controllerProvider === undefined) !== (parsed.controllerModel === undefined)) {
    throw new Error("controller provider and model must be supplied together");
  }
  if ((parsed.plannerProvider === undefined) !== (parsed.plannerModel === undefined)) {
    throw new Error("planner provider and model must be supplied together");
  }
  if ((parsed.frontendProvider === undefined) !== (parsed.frontendModel === undefined)) {
    throw new Error("frontend provider and model must be supplied together");
  }
  if (parsed.frontendProvider === undefined
    && (parsed.frontendReasoning !== undefined || parsed.frontendMaxTokens !== undefined)) {
    throw new Error("frontend reasoning and max tokens require a frontend provider and model");
  }
  if (parsed.plannerProvider !== undefined && parsed.frontendProvider !== undefined) {
    throw new Error("configure only one routed responsibility per live smoke");
  }
  for (const field of ["controllerMaxTokens", "frontendMaxTokens"] as const) {
    if (parsed[field] !== undefined && (!Number.isSafeInteger(parsed[field]) || parsed[field] < 1)) {
      throw new Error(`${field} must be a positive integer`);
    }
  }
  if (["auto", "execute"].includes(parsed.mode)
    && parsed.plannerProvider === undefined
    && parsed.frontendProvider === undefined) {
    throw new Error(`${parsed.mode} mode requires an explicit planner or frontend provider and model`);
  }
  if (parsed.frontendProvider !== undefined && parsed.mode !== "auto") {
    throw new Error("frontend live smoke currently requires --mode auto");
  }
  return parsed;
}

function renderPatch(input: PatchInput): string {
  const quote = (value: unknown): string => JSON.stringify(value);
  const role = input.frontendProvider !== undefined ? {
    name: "frontend",
    provider: input.frontendProvider,
    model: input.frontendModel,
    reasoningEffort: input.frontendReasoning,
    maxTokens: input.frontendMaxTokens,
  } : input.plannerProvider !== undefined ? {
    name: "planner",
    provider: input.plannerProvider,
    model: input.plannerModel,
    reasoningEffort: input.plannerReasoning,
    maxTokens: 2_048,
  } : undefined;
  const roleMapping = role === undefined ? [] : [
    "          roles:",
    `            ${role.name}:`,
    `              provider: ${quote(role.provider)}`,
    `              model: ${quote(role.model)}`,
    ...(role.reasoningEffort ? [`              reasoningEffort: ${quote(role.reasoningEffort)}`] : []),
    ...(role.maxTokens === undefined ? [] : [`              maxTokens: ${role.maxTokens}`]),
  ];
  const routing = input.mode === "default" ? [] : [
    "        routing:",
    `          mode: ${input.mode}`,
    "          provider: spawn",
    ...roleMapping,
  ];
  return [
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${quote(input.sessionRoot)}`,
    "    compression: none",
    "    packChunks: false",
    "- insert:",
    "    - id: odai-governance-live-smoke",
    `      name: ${quote(input.pluginPath)}`,
    "      config:",
    `        skillPath: ${quote(input.skillPath)}`,
    ...routing,
    "",
  ].join("\n");
}

function verifySmoke(sessions: readonly SessionSummary[], options: SmokeArgs) {
  const errors: string[] = [];
  const expectedMode = options.mode === "default" ? "auto-unconfigured" : options.mode;
  const targetRole = options.frontendProvider === undefined ? "planner" : "frontend";
  const expectedRoute = ["auto", "execute"].includes(options.mode)
    ? targetRole === "frontend"
      ? {
          provider: options.frontendProvider,
          model: options.frontendModel,
          reasoningEffort: options.frontendReasoning,
        }
      : {
          provider: options.plannerProvider,
          model: options.plannerModel,
          reasoningEffort: options.plannerReasoning,
        }
    : {
        provider: options.controllerProvider,
        model: options.controllerModel,
        reasoningEffort: options.controllerReasoning,
      };
  const children = sessions.filter((session) => session.origin === "subagent");
  const controllers = sessions.filter((session) => session.origin !== "subagent");
  const events = controllers.flatMap((session) => session.routeEvents);
  const decision = events.find((event) => event.type === "odai/route-decided"
    && ((expectedMode !== "auto" && expectedMode !== "execute") || event.data.targetRole === targetRole));
  const configMissing = events.find((event) => event.type === "odai/route-config-missing");
  const upgrade = events.find((event) => event.type === "odai/route-upgrade");
  const result = events.find((event) => event.type === "odai/route-result");
  const protection = events.find((event) => event.type === "odai/route-protection");
  const budgetOverride = events.find((event) => event.type === "odai/output-budget-overridden");
  const sameRoute = (route: unknown): route is ObservedRoute => isRecord(route)
    && route.provider === expectedRoute.provider
    && route.model === expectedRoute.model
    && route.reasoningEffort === expectedRoute.reasoningEffort;
  const controllerRoute = controllers
    .flatMap((session) => session.requestRoutes)
    .find(sameRoute);

  if (controllers.length !== 1) errors.push(`expected one controller session, found ${controllers.length}`);
  if (expectedMode === "off") {
    if (children.length !== 0) errors.push(`off mode started ${children.length} child sessions`);
    if (events.length !== 0) errors.push(`off mode emitted ${events.length} route events`);
  } else if (expectedMode === "observe" || expectedMode === "auto-unconfigured") {
    if (children.length !== 0) errors.push(`${expectedMode} started ${children.length} child sessions`);
    if (decision?.data?.role !== "controller"
      || decision?.data?.action !== "direct"
      || decision?.data?.targetRole !== undefined
      || decision?.data?.mode !== (expectedMode === "observe" ? "observe" : "auto")) {
      errors.push("risk language alone must keep the original controller without inventing a responsibility gap");
    }
    if (configMissing || upgrade || result || protection) {
      errors.push("risk-only smoke unexpectedly requested a role, switched models, or activated whole-turn protection");
    }
    if (!controllerRoute) errors.push(`${expectedMode} did not remain on the base controller route`);
  } else if (expectedMode === "auto") {
    if (children.length !== 0) errors.push(`auto mode started ${children.length} child sessions`);
    if (decision?.data?.role !== "controller"
      || decision?.data?.action !== "upgrade"
      || decision?.data?.targetRole !== targetRole
      || decision?.data?.mode !== "auto") {
      errors.push(`auto mode did not record the expected ${targetRole} controller-upgrade decision`);
    }
    if (upgrade?.data?.status !== "requested" || !sameRoute(upgrade?.data?.requestedRoute)) {
      errors.push("auto mode did not record the expected requested controller route");
    }
    if (!controllerRoute) {
      errors.push(`controller request/header did not match the configured ${targetRole} route`);
    } else if (targetRole === "frontend") {
      const expectedMaxTokens = options.frontendMaxTokens ?? options.controllerMaxTokens;
      if (controllerRoute.maxTokens !== expectedMaxTokens) {
        errors.push(`frontend request/header maxTokens was ${controllerRoute.maxTokens}, expected ${expectedMaxTokens}`);
      }
      if (options.frontendMaxTokens !== undefined && (
        budgetOverride?.data?.responsibility !== "frontend"
        || budgetOverride?.data?.configuredControllerMaxTokens !== options.controllerMaxTokens
        || budgetOverride?.data?.effectiveMaxTokens !== options.frontendMaxTokens
      )) {
        errors.push("frontend budget override audit evidence was missing or mismatched");
      }
    } else if (controllerRoute.maxTokens !== options.controllerMaxTokens) {
      errors.push(`planner in-place route maxTokens was ${controllerRoute.maxTokens}, expected ${options.controllerMaxTokens}`);
    }
  } else {
    if (children.length !== 1) errors.push(`execute mode expected one child session, found ${children.length}`);
    if (decision?.data?.role !== "controller"
      || decision?.data?.action !== "upgrade"
      || decision?.data?.targetRole !== "planner"
      || decision?.data?.mode !== "execute") {
      errors.push("execute mode did not record the expected upgrade gap before delegation");
    }
    if (result?.data?.status !== "completed" || !sameRoute(result?.data?.actualRoute)) {
      errors.push("execute mode did not complete with the expected verified planner route");
    }
    if (!children.some((session) => session.requestRoutes.some(
      (route) => sameRoute(route) && route.maxTokens === 2_048,
    ))) {
      errors.push("no child request/header matched the expected planner route and maxTokens cap");
    }
  }

  return { ok: errors.length === 0, expectedMode, targetRole, expectedRoute, errors };
}

function runProcess(
  command: string,
  commandArgs: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((accept, reject) => {
    const child = spawnDsh(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      reject(new Error("live routing smoke requires piped stdout and stderr"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      accept({
        code: timedOut ? 124 : (code ?? 1),
        signal,
        stdout,
        stderr: timedOut ? `${stderr}\nlive routing smoke timed out` : stderr,
      });
    });
  });
}

async function readSessions(root: string, evidenceRoot: string): Promise<RawSession[]> {
  if (!existsSync(root)) return [];
  const evidence = await readEvidence(evidenceRoot);
  const files = await listFiles(root);
  const sessions: RawSession[] = [];
  for (const file of files.filter((candidate: string) => candidate.endsWith("session.jsonl"))) {
    const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const records = lines.map(parseRecord);
    const header = records[0];
    if (!header) continue;
    const id = typeof header.id === "string" ? header.id : undefined;
    sessions.push({
      header,
      events: [...records.slice(1).map(parseEvent), ...(id ? evidence.get(id) ?? [] : [])],
    });
  }
  return sessions;
}

async function readEvidence(root: string): Promise<Map<string, DshEvent[]>> {
  const bySession = new Map<string, DshEvent[]>();
  if (!existsSync(root)) return bySession;
  for (const file of await listFiles(root)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await readFile(file, "utf8");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n").filter(Boolean)) {
      const record = parseRecord(line);
      if (record.schemaVersion !== 1 || typeof record.sessionId !== "string"
        || typeof record.type !== "string" || !isRecord(record.data)) continue;
      const events = bySession.get(record.sessionId) ?? [];
      events.push({
        type: record.type,
        ...(typeof record.time === "number" ? { time: record.time } : {}),
        data: record.data,
      });
      bySession.set(record.sessionId, events);
    }
  }
  return bySession;
}

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function summarizeSession(session: RawSession): SessionSummary {
  const usageByStep = new Map<string, UnknownRecord>();
  const requestRoutes: ObservedRoute[] = [];
  const routeEvents: RouteEvent[] = [];
  let assistantText = "";
  for (const event of session.events) {
    if (event.type === "request/header") {
      const header = event.data?.header;
      const config = isRecord(header) && isRecord(header.config) ? header.config : undefined;
      requestRoutes.push({
        ...(typeof config?.provider === "string" ? { provider: config.provider } : {}),
        ...(typeof config?.model === "string" ? { model: config.model } : {}),
        ...(typeof config?.reasoningEffort === "string" ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(typeof config?.maxTokens === "number" ? { maxTokens: config.maxTokens } : {}),
      });
    }
    if (["odai/route-decided", "odai/route-config-missing", "odai/route-upgrade", "odai/route-result", "odai/route-protection", "odai/output-budget-overridden"].includes(event.type)) {
      routeEvents.push({ type: event.type, data: event.data });
    }
    if (event.type === "assistant/message") {
      const text = event.data?.message?.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "";
      if (text) assistantText = text;
      if (isRecord(event.data?.usage)) usageByStep.set(`${event.data?.turn}:${event.data?.step}`, event.data.usage);
    }
    if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage"
      && isRecord(event.data.chunk.usage)) {
      usageByStep.set(`${event.data.turn}:${event.data.step}`, event.data.chunk.usage);
    }
  }

  return {
    id: session.header.id,
    origin: session.header.origin ?? "controller",
    delegationDepth: session.header.delegationDepth,
    parentSession: typeof session.header.parentSession === "string" ? session.header.parentSession : undefined,
    requestRoutes,
    routeEvents,
    usage: sumUsage([...usageByStep.values()]),
    assistantText,
  };
}

function sumUsage(items: readonly UnknownRecord[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const usage of items) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}
