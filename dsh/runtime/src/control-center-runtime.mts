import { discoverCliModels } from "./local-cli-catalog.mjs";
import { applySessionControl, type SessionControlsSnapshot } from "./session-controls.mjs";
import {
  applyRoutingConfigAction,
  type RoleDispatches,
  type RoleRoutes,
  type RoutingConfigResult,
} from "./routing-config.mjs";
import {
  readStoredSessionEvidence,
  resolveSessionEvidenceRoot,
  storedSessionEvidenceRevision,
} from "./session-evidence.mjs";
import type { SessionEvidenceEvent } from "./session-evidence.mjs";
import type { DshRuntimeContext, RuntimeLogger, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const CONTROL_CENTER_CHANNEL = "/odai-control-center";
const CONTROL_CENTER_ENDPOINT = "routing";
const CONTROL_CENTER_EVIDENCE_ENDPOINT = "evidence";
const CONTROL_CENTER_SESSION_ENDPOINT = "session";
const CONTROL_CENTER_PRESSURE_ENDPOINT = "compaction-pressure";
const MAX_EVIDENCE_EVENTS = 2_000;

interface RpcFailure {
  code: "bad-request" | "route-rejected" | "unavailable" | "internal";
  message: string;
}

export interface CompactionPressureControl {
  configuredMode: "host" | "window-ratio";
  effectiveMode: "host" | "window-ratio";
  supported: boolean;
  valid: boolean;
  reason?: string;
}

export interface ControlCenterResponse {
  pressure?: CompactionPressureControl;
  ok: boolean;
  session?: SessionControlsSnapshot;
  choices?: Array<{ id: string; name: string }>;
  config?: Omit<RoutingConfigResult, "configPath" | "latestRoute">;
  events?: readonly SessionEvidenceEvent[];
  revision?: string;
  unchanged?: boolean;
  error?: RpcFailure;
}

interface ConnectionRpcResult {
  ok: true;
  value: ControlCenterResponse;
}

interface HostConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult>,
    options: { authority: "loopback" },
  ): () => Promise<void>;
}

interface HostConnection {
  rpc: HostConnectionRpc;
  fetch?: {
    register(route: { path: string; methods: string[]; requestBody: "buffered"; fetch(request: Request): Promise<Response> }): () => void | Promise<void>;
  };
}

function registerControlCenter(connection: HostConnection,
  handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult>,
): () => Promise<void> {
  if (!connection.fetch) return connection.rpc.handle(CONTROL_CENTER_CHANNEL, handler, { authority: "loopback" });
  const disposers = [CONTROL_CENTER_ENDPOINT, CONTROL_CENTER_EVIDENCE_ENDPOINT, CONTROL_CENTER_SESSION_ENDPOINT, CONTROL_CENTER_PRESSURE_ENDPOINT].map((endpoint) => {
    const method = `${CONTROL_CENTER_CHANNEL.slice(1)}/${endpoint}`;
    return connection.fetch!.register({
      path: `/api/${method}`, methods: ["POST"], requestBody: "buffered",
      async fetch(request) {
        let body: unknown;
        try { body = await request.json(); } catch { return new Response("body is not JSON", { status: 400 }); }
        if (!isUnknownRecord(body) || body.type !== "client-request" || typeof body.rpcId !== "string"
          || body.rpcId.length === 0 || body.method !== method) return new Response("invalid RPC envelope", { status: 400 });
        return Response.json({ type: "server-response", rpcId: body.rpcId,
          result: await handler(endpoint, body.payload, request.signal) });
      },
    });
  });
  return async () => { for (const dispose of disposers) await dispose(); };
}

interface RegisteredOwner {
  ctx: DshRuntimeContext;
  options: ControlCenterRuntimeOptions;
}

interface SharedRegistration {
  owners: Map<symbol, RegisteredOwner>;
  dispose: () => Promise<void>;
}

interface SharedControlCenterState {
  registration?: SharedRegistration;
}

type ControlCenterGlobal = typeof globalThis & {
  __odaiControlCenterRpc?: SharedControlCenterState;
};

export interface ControlCenterRuntimeOptions {
  pressure?: (payload: unknown, signal: AbortSignal) => Promise<CompactionPressureControl>;
  scope?: "profile" | "preset";
  configPath: string;
  routingMode?: string;
  evidenceRoot?: string;
  configuredRoles?: Readonly<RoleRoutes>;
  configuredDispatch?: Readonly<RoleDispatches>;
  logger?: RuntimeLogger;
}

function effectiveOwner(owners: ReadonlyMap<symbol, RegisteredOwner>): RegisteredOwner {
  let selected: RegisteredOwner | undefined;
  let selectedWeight = -1;
  for (const entry of owners.values()) {
    const { options } = entry;
    const weight = Object.keys(options.configuredRoles ?? {}).length
      + Object.keys(options.configuredDispatch ?? {}).length;
    if (selected === undefined || weight > selectedWeight
      || (weight === selectedWeight && selected.options.routingMode === undefined && options.routingMode !== undefined)) {
      selected = entry;
      selectedWeight = weight;
    }
  }
  if (!selected) throw new Error("Control Center RPC has no active runtime owner");
  return selected;
}

function activeLlm(owners: ReadonlyMap<symbol, RegisteredOwner>, preferred: DshRuntimeContext): DshRuntimeContext["llm"] | undefined {
  if (preferred.llm) return preferred.llm;
  for (const entry of owners.values()) {
    if (entry.ctx.llm) return entry.ctx.llm;
  }
  return undefined;
}

function unmanagedSessionReason(owners: ReadonlyMap<symbol, RegisteredOwner>, payload: unknown): string | undefined {
  if (!isUnknownRecord(payload) || typeof payload.sessionId !== "string" || !payload.sessionId) return undefined;
  const entries = [...owners.values()];
  if (entries.some((entry) => entry.options.scope === "profile")) return undefined;
  if (!entries.some((entry) => entry.options.scope === "preset")) return undefined;
  for (const entry of entries) {
    const session = entry.ctx.sessions?.get(payload.sessionId);
    const preset = session?.header?.agentPreset;
    if (typeof preset === "string" && preset.trim() !== "") {
      return preset === "odai" ? undefined : "当前会话未启用 Odai 预设";
    }
  }
  return undefined;
}

function connectionFrom(ctx: DshRuntimeContext): HostConnection | undefined {
  // Property access retains Cordis's injected caller; reflect.get may bind the service's owner instead.
  const candidate = ctx.inject
    ? (ctx as DshRuntimeContext & { connection?: unknown }).connection
    : ctx.get?.("connection");
  if (!isUnknownRecord(candidate) || !isUnknownRecord(candidate.rpc)
    || typeof candidate.rpc.handle !== "function") return undefined;
  return candidate as unknown as HostConnection;
}

function publicResult(result: RoutingConfigResult): Omit<RoutingConfigResult, "configPath" | "latestRoute"> {
  const visible: Partial<RoutingConfigResult> = { ...result };
  delete visible.configPath;
  delete visible.latestRoute;
  return visible as Omit<RoutingConfigResult, "configPath" | "latestRoute">;
}

function evidenceRequest(payload: unknown): { sessionId: string; revision?: string } {
  if (!isUnknownRecord(payload) || Object.keys(payload).some((key) => key !== "sessionId" && key !== "revision")
    || typeof payload.sessionId !== "string" || payload.sessionId === "" || payload.sessionId.length > 512
    || (payload.revision !== undefined && (typeof payload.revision !== "string" || payload.revision.length > 128))) {
    throw new TypeError("evidence request requires a non-empty sessionId and optional revision");
  }
  return {
    sessionId: payload.sessionId,
    ...(typeof payload.revision === "string" ? { revision: payload.revision } : {}),
  };
}

const SYSTEM_ERROR_CODES = new Set([
  "ABORT_ERR", "EACCES", "EEXIST", "EISDIR", "EMFILE", "ENAMETOOLONG", "ENFILE",
  "ENOENT", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EROFS", "ERR_ABORTED", "EXDEV",
]);

function failureFor(error: unknown): RpcFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = isUnknownRecord(error) && typeof error.code === "string"
    ? error.code.toUpperCase()
    : "";
  if (/responsibility route rejected/iu.test(message)
    || (code !== "" && !SYSTEM_ERROR_CODES.has(code) && !code.startsWith("ERR_FS_"))) {
    return { code: "route-rejected", message };
  }
  if (error instanceof TypeError) return { code: "bad-request", message };
  return { code: "internal", message };
}

export function installControlCenterRuntimeWhenAvailable(
  ctx: DshRuntimeContext,
  options: ControlCenterRuntimeOptions,
): () => Promise<void> {
  let release: (() => Promise<void>) | undefined;
  let stopped = false;
  if (ctx.inject) {
    const binding = ctx.inject(["connection", "webServer"], (available) => {
      if (stopped) return;
      const mounted = installControlCenterRuntime(available, options);
      release = mounted;
      available.effect?.(() => async () => {
        if (release === mounted) release = undefined;
        await mounted?.();
      }, "odai: Control Center transport ownership");
    });
    return async () => {
      stopped = true;
      await binding.dispose();
      const current = release;
      release = undefined;
      await current?.();
    };
  }
  const mount = (): void => {
    if (stopped || release) return;
    release = installControlCenterRuntime(ctx, options);
  };
  ctx.on("internal/service", (serviceName: string) => {
    if (serviceName === "connection") mount();
  });
  mount();
  return async () => {
    stopped = true;
    const current = release;
    release = undefined;
    await current?.();
  };
}

export function installControlCenterRuntime(
  ctx: DshRuntimeContext,
  options: ControlCenterRuntimeOptions,
): (() => Promise<void>) | undefined {
  const connection = connectionFrom(ctx);
  if (!connection) {
    options.logger?.info("Control Center RPC unavailable outside a DSH client-connection host");
    return undefined;
  }

  const root = globalThis as ControlCenterGlobal;
  const shared = root.__odaiControlCenterRpc ??= {};
  const owner = Symbol("odai-control-center-owner");
  const releaseOwner = async (registration: SharedRegistration): Promise<void> => {
    registration.owners.delete(owner);
    if (registration.owners.size > 0 || shared.registration !== registration) return;
    delete shared.registration;
    await registration.dispose();
  };
  const existing = shared.registration;
  if (existing) {
    existing.owners.set(owner, { ctx, options });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await releaseOwner(existing);
    };
  }

  const owners = new Map<symbol, RegisteredOwner>([[owner, { ctx, options }]]);
  const dispose = registerControlCenter(connection, async (endpoint, payload, signal) => {
    if (endpoint !== CONTROL_CENTER_ENDPOINT && endpoint !== CONTROL_CENTER_EVIDENCE_ENDPOINT && endpoint !== CONTROL_CENTER_SESSION_ENDPOINT && endpoint !== CONTROL_CENTER_PRESSURE_ENDPOINT) {
      return { ok: true, value: { ok: false, error: { code: "unavailable", message: "unknown Odai Control Center endpoint" } } };
    }
    const activeOwner = effectiveOwner(owners);
    const active = activeOwner.options;
    const llm = activeLlm(owners, activeOwner.ctx);
    try {
      if (endpoint === CONTROL_CENTER_PRESSURE_ENDPOINT) {
        const handlers = [...new Set([...owners.values()].flatMap(entry => entry.options.pressure ? [entry.options.pressure] : []))];
        if (handlers.length !== 1) return { ok: true, value: { ok: false, error: { code: "unavailable", message: handlers.length === 0 ? "自动压缩设置尚未连接到运行时" : "存在多个自动压缩配置所有者，无法确定设置作用域" } } };
        signal.throwIfAborted();
        return { ok: true, value: { ok: true, pressure: await handlers[0]!(payload, signal) } };
      }
      if (endpoint === CONTROL_CENTER_ENDPOINT && isUnknownRecord(payload) && payload.action === "choices") {
        if (typeof payload.cli === "string") return { ok: true, value: { ok: true, choices: await discoverCliModels(payload.cli, signal) } };
        const catalog = llm as unknown as {
          listProviders?(): Array<{ id: string; name: string }>;
          listModels?(provider: string): Promise<Array<{ id: string; name: string }>>;
          resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts: Array<{ id: string; name: string }> } }>;
        } | undefined;
        if (!catalog?.listProviders) throw new TypeError("宿主未提供模型目录，请手动输入");
        if (payload.provider !== undefined && typeof payload.provider !== "string") throw new TypeError("invalid provider");
        if (payload.model !== undefined && typeof payload.model !== "string") throw new TypeError("invalid model");
        let choices;
        if (typeof payload.provider !== "string" || !payload.provider) choices = catalog.listProviders();
        else if (typeof payload.model !== "string" || !payload.model) {
          if (!catalog.listModels) throw new TypeError("宿主未提供模型列表，请手动输入");
          choices = await catalog.listModels(payload.provider);
        } else {
          if (!catalog.resolveModelInfo) throw new TypeError("宿主未提供推理档位，请手动输入");
          choices = (await catalog.resolveModelInfo(payload.provider, payload.model, signal)).reasoning?.efforts ?? [];
        }
        return { ok: true, value: { ok: true, choices: choices.map(({ id, name }) => ({ id, name })) } };
      }
      if (endpoint === CONTROL_CENTER_SESSION_ENDPOINT) {
        return {
          ok: true,
          value: {
            ok: true,
            session: applySessionControl(payload, {
              ...active,
              evidenceRoot: active.evidenceRoot ?? resolveSessionEvidenceRoot(active.configPath),
              unmanagedReason: unmanagedSessionReason(owners, payload),
            }),
          },
        };
      }
      if (endpoint === CONTROL_CENTER_EVIDENCE_ENDPOINT) {
        const request = evidenceRequest(payload);
        const evidenceRoot = active.evidenceRoot ?? resolveSessionEvidenceRoot(active.configPath);
        const revision = storedSessionEvidenceRevision(evidenceRoot, request.sessionId);
        if (request.revision === revision) {
          return { ok: true, value: { ok: true, revision, unchanged: true } };
        }
        const events = readStoredSessionEvidence(
          evidenceRoot,
          request.sessionId,
          { warn: (message) => active.logger?.warn(message) },
        ).slice(-MAX_EVIDENCE_EVENTS);
        return { ok: true, value: { ok: true, events, revision, unchanged: false } };
      }
      const config = await applyRoutingConfigAction(active.configPath, payload, {
        configuredRoles: active.configuredRoles,
        configuredDispatch: active.configuredDispatch,
        resolveCallConfig: llm ? (route, callSignal) => llm.resolveCallConfig(route as UnknownRecord, callSignal) : undefined,
        signal,
      });
      return { ok: true, value: { ok: true, config: publicResult(config) } };
    } catch (error) {
      active.logger?.warn(`Control Center routing request failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: true, value: { ok: false, error: failureFor(error) } };
    }
  });
  const registration: SharedRegistration = { owners, dispose };
  shared.registration = registration;

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releaseOwner(registration);
  };
}

export { CONTROL_CENTER_CHANNEL, CONTROL_CENTER_ENDPOINT, CONTROL_CENTER_EVIDENCE_ENDPOINT };
