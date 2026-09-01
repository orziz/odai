import {
  applyRoutingConfigAction,
  type RoleDispatches,
  type RoleRoutes,
  type RoutingConfigResult,
} from "./routing-config.mjs";
import { readStoredSessionEvidence, resolveSessionEvidenceRoot } from "./session-evidence.mjs";
import type { SessionEvidenceEvent } from "./session-evidence.mjs";
import type { DshRuntimeContext, RuntimeLogger, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const CONTROL_CENTER_CHANNEL = "/odai-control-center";
const CONTROL_CENTER_ENDPOINT = "routing";
const CONTROL_CENTER_EVIDENCE_ENDPOINT = "evidence";
const MAX_EVIDENCE_EVENTS = 2_000;

interface RpcFailure {
  code: "bad-request" | "route-rejected" | "unavailable" | "internal";
  message: string;
}

export interface ControlCenterResponse {
  ok: boolean;
  config?: Omit<RoutingConfigResult, "configPath" | "latestRoute">;
  events?: readonly SessionEvidenceEvent[];
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
}

interface SharedRegistration {
  owners: Map<symbol, ControlCenterRuntimeOptions>;
  dispose: () => Promise<void>;
}

interface SharedControlCenterState {
  registration?: SharedRegistration;
}

type ControlCenterGlobal = typeof globalThis & {
  __odaiControlCenterRpc?: SharedControlCenterState;
};

export interface ControlCenterRuntimeOptions {
  configPath: string;
  evidenceRoot?: string;
  configuredRoles?: Readonly<RoleRoutes>;
  configuredDispatch?: Readonly<RoleDispatches>;
  logger?: RuntimeLogger;
}

function effectiveOptions(owners: ReadonlyMap<symbol, ControlCenterRuntimeOptions>): ControlCenterRuntimeOptions {
  let selected: ControlCenterRuntimeOptions | undefined;
  let selectedWeight = -1;
  for (const options of owners.values()) {
    const weight = Object.keys(options.configuredRoles ?? {}).length
      + Object.keys(options.configuredDispatch ?? {}).length;
    if (selected === undefined || weight > selectedWeight) {
      selected = options;
      selectedWeight = weight;
    }
  }
  if (!selected) throw new Error("Control Center RPC has no active runtime owner");
  return selected;
}

function connectionFrom(ctx: DshRuntimeContext): HostConnection | undefined {
  const candidate = ctx.get?.("connection");
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

function evidenceSessionId(payload: unknown): string {
  if (!isUnknownRecord(payload) || Object.keys(payload).some((key) => key !== "sessionId")
    || typeof payload.sessionId !== "string" || payload.sessionId === "" || payload.sessionId.length > 512) {
    throw new TypeError("evidence request requires only a non-empty sessionId");
  }
  return payload.sessionId;
}

function failureFor(error: unknown): RpcFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = isUnknownRecord(error) && typeof error.code === "string"
    ? error.code.toUpperCase()
    : "";
  if (code || /responsibility route rejected/iu.test(message)) {
    return { code: "route-rejected", message };
  }
  if (error instanceof TypeError) return { code: "bad-request", message };
  return { code: "internal", message };
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
    existing.owners.set(owner, options);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await releaseOwner(existing);
    };
  }

  const owners = new Map<symbol, ControlCenterRuntimeOptions>([[owner, options]]);
  const dispose = connection.rpc.handle(CONTROL_CENTER_CHANNEL, async (endpoint, payload, signal) => {
    if (endpoint !== CONTROL_CENTER_ENDPOINT && endpoint !== CONTROL_CENTER_EVIDENCE_ENDPOINT) {
      return { ok: true, value: { ok: false, error: { code: "unavailable", message: "unknown Odai Control Center endpoint" } } };
    }
    const active = effectiveOptions(owners);
    try {
      if (endpoint === CONTROL_CENTER_EVIDENCE_ENDPOINT) {
        const sessionId = evidenceSessionId(payload);
        const events = readStoredSessionEvidence(
          active.evidenceRoot ?? resolveSessionEvidenceRoot(active.configPath),
          sessionId,
          { warn: (message) => active.logger?.warn(message) },
        ).slice(-MAX_EVIDENCE_EVENTS);
        return { ok: true, value: { ok: true, events } };
      }
      const config = await applyRoutingConfigAction(active.configPath, payload, {
        configuredRoles: active.configuredRoles,
        configuredDispatch: active.configuredDispatch,
        resolveCallConfig: (route, callSignal) => ctx.llm.resolveCallConfig(route as UnknownRecord, callSignal),
        signal,
      });
      return { ok: true, value: { ok: true, config: publicResult(config) } };
    } catch (error) {
      active.logger?.warn(`Control Center routing request failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: true, value: { ok: false, error: failureFor(error) } };
    }
  }, { authority: "loopback" });
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
