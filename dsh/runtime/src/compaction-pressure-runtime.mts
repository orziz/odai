import { compactAtWindowRatio, resolveCompactionPressureMode, windowRatioRange, windowRatioThreshold } from "./compaction-policy.mjs";
import { readCompactionPressure, writeCompactionPressure } from "./compaction-pressure-store.mjs";
import type { CompactionPressureControl } from "./control-center-runtime.mjs";

// Dynamic host exports deliberately remain at this boundary: the plugin is also
// built and tested outside a DSH installation.
export interface PressureRuntimeOptions {
  storePath: string;
  agentForSession(id: string): any;
  engineForAgent(agent: any): any;
  warn(message: string): void;
}
export function installCompactionPressureRuntime(ctx: any, options: PressureRuntimeOptions) {
  let active = true, registering = false;
  let modules: any, loadError: string | undefined;
  let globalOwners = 0;
  const managedEngines = new Set<unknown>();
  const managed = (engine: any) => globalOwners > 0 || managedEngines.has(serviceIdentity(engine));
  function enableProfile(owner: any) {
    globalOwners++;
    owner.effect(() => () => { globalOwners--; });
  }
  const captures = new Map<number, {owner: any; callback: unknown; events: Map<string, number>}>();
  ctx.effect(() => () => { active = false; captures.clear(); });
  const exact = (record: any): boolean => active && !!modules && record.callback === modules.BasicCompactionEngine
    && record.events.get("agent/pre-step") === 1 && record.events.get("agent/request") === 1;

  async function pressure(owner: any, agent: any, header: any, signal: AbortSignal, requireBelowThreshold: boolean) {
    signal.throwIfAborted();
    const engine = owner.get("compaction"), meter = owner.get("tokenMeter"), llm = owner.get("llm");
    if (!engine || !meter || !llm) throw new Error("Odai compaction: scoped services unavailable");
    const info = await llm.resolveModelInfo(header.config.provider, header.config.model, signal);
    signal.throwIfAborted();
    for (let seq = agent.session.seq - 1; seq >= 0; seq--) {
      const event = agent.session.eventAt(modules.SessionSeq(seq));
      if (event.type === "compaction/end") break;
      if (event.type === "compaction/start") throw new Error("Odai compaction: another compaction is active");
    }
    const contextWindow = info.context?.contextWindow;
    const threshold = windowRatioThreshold(contextWindow);
    const policy = engine.config.modelPolicies.find((item: any) => item.provider === header.config.provider && item.model === header.config.model);
    if (meter.measure(agent.session, header).totalTokens >= threshold) owner.get("toolResultPruner")?.pruneSession(agent.session);
    return compactAtWindowRatio<number>({
      contextWindow, signal, retries: policy?.compactionRetries ?? engine.config.compactionRetries, requireBelowThreshold,
      measure() {
        const measurement = meter.measure(agent.session, header), surface = agent.session.surface.nodes;
        return {totalTokens: measurement.totalTokens, range: measurement.totalTokens < threshold ? null : windowRatioRange<number>({
          surface, priced: measurement.nodes, contextWindow,
          retainTokens: policy?.retainTokens ?? (policy?.retainRatio !== undefined
            ? Math.floor(contextWindow * policy.retainRatio)
            : engine.config.retainTokens ?? Math.floor(contextWindow * engine.config.retainRatio)),
          systemHead: surface.length > 0 && agent.session.eventAt(surface[0]).type === "system/message",
          balancedBefore: seq => modules.toolPairingBalancedBefore(agent.session, seq),
        })};
      },
      compact: (start, end, abort) => engine.compactRegion(start, end, agent, abort),
    });
  }

  // Capture registrations synchronously. Until module identities are loaded,
  // every provisional wrapper delegates; unrelated plugins always delegate.
  ctx.on("internal/listener", function(this: any, name: string, original: any, registrationOptions: unknown) {
    if (registering || (name !== "agent/pre-step" && name !== "agent/request")) return;
    const owner = this;
    const record = captures.get(owner.fiber.uid) ?? {owner, callback: owner.fiber.runtime?.callback, events: new Map<string, number>()};
    const wrapped = async function(this: unknown, payload: any, next: () => any) {
      if (!exact(record) || !managed(record.owner.get("compaction")) || record.owner.get("compaction")?.config.auto === false) return Reflect.apply(original, this, [payload, next]);
      const stored = readCompactionPressure(options.storePath);
      if (!stored.valid || stored.mode === "host") return Reflect.apply(original, this, [payload, next]);
      const {agent, signal} = payload;
      if (name === "agent/pre-step") {
        if (!signal.aborted) try {
          const header = agent.session.requestHeader();
          if (header?.config.provider && header.config.model) await pressure(owner, agent, header, signal, false);
        } catch (error) { options.warn(`Odai step compaction failed: ${String(error)}; continuing the turn`); }
        return next();
      }
      const config = await next(), previous = agent.session.requestHeader();
      if (signal.aborted || !previous || !config.provider || !config.model || (previous.config.provider === config.provider && previous.config.model === config.model)) return config;
      try { await pressure(owner, agent, {...previous, config}, signal, true); }
      catch (error) {
        signal.throwIfAborted();
        throw new modules.LlmError(`Cannot switch to ${config.provider}/${config.model}: context compaction failed: ${String(error)}. The previous request model is preserved; retry or select a model with a larger context window.`, "MODEL_SWITCH_COMPACTION_FAILED", {cause: error});
      }
      return config;
    };
    registering = true;
    try {
      const dispose = owner.on(name, wrapped, registrationOptions);
      record.events.set(name, (record.events.get(name) ?? 0) + 1); captures.set(owner.fiber.uid, record);
      let disposed = false;
      const replacementDispose = () => {
        if (disposed) return; disposed = true;
        record.events.set(name, (record.events.get(name) ?? 1) - 1);
        if ([...record.events.values()].every(count => count === 0)) captures.delete(owner.fiber.uid);
        return dispose();
      };
      owner.effect(() => replacementDispose);
      return replacementDispose;
    } finally { registering = false; }
  }, {global: true});

  const ready = new Promise<void>(resolve => { ctx.inject(["loader"], (available: any) => { void (async () => {
    try {
      const loader = available.get("loader");
      if (!loader) throw new Error("Host module loader unavailable");
      const [basic, compaction, llm, session, cordis] = await Promise.all(["@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-compaction", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-session", "@deepseek-ai/cordis"].map(name => loader.import(name)));
      const candidate = {BasicCompactionEngine: basic.BasicCompactionEngine, toolPairingBalancedBefore: compaction.toolPairingBalancedBefore, LlmError: llm.LlmError, SessionSeq: session.SessionSeq};
      if (Object.values(candidate).some(value => typeof value !== "function")) throw new Error("Required public DSH compaction APIs unavailable");
      if (typeof cordis.symbols?.original !== "symbol") throw new Error("Cordis service identity API unavailable");
      if (active) modules = {...candidate, original: cordis.symbols.original};
    } catch (error) { loadError = String(error); if (active) options.warn(`Odai pressure adapter unavailable: ${loadError}`); }
  })().finally(resolve); }); });
  function serviceIdentity(value: any): unknown {
    if (!modules) return undefined;
    const seen = new Set<unknown>();
    while (value !== null && (typeof value === "object" || typeof value === "function")) {
      if (seen.has(value)) return undefined;
      seen.add(value);
      const underlying = value[modules.original];
      if (underlying === undefined) return value;
      value = underlying;
    }
    return undefined;
  }
  function status(agent: any): CompactionPressureControl {
    const stored = readCompactionPressure(options.storePath), engine = agent ? options.engineForAgent(agent) : undefined;
    const identity = serviceIdentity(engine);
    const supported = managed(engine) && engine?.config.auto !== false && identity !== undefined && [...captures.values()].some(record => exact(record) && serviceIdentity(record.owner.get("compaction")) === identity);
    return {configuredMode: stored.mode, effectiveMode: stored.valid && supported ? stored.mode : "host", supported, valid: stored.valid,
      ...(!stored.valid ? {reason: `配置无效，使用宿主默认：${stored.error}`} : !supported ? {reason: loadError ? `自动压缩适配不可用：${loadError}` : "当前会话的自动压缩尚未接管，使用宿主默认。"} : {})};
  }
  async function control(payload: unknown, signal: AbortSignal): Promise<CompactionPressureControl> {
    signal.throwIfAborted();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Invalid pressure request");
    const input = payload as Record<string, unknown>;
    if (Object.keys(input).some(key => !["action", "sessionId", "mode"].includes(key)) || (input.action !== "show" && input.action !== "set") || typeof input.sessionId !== "string" || !input.sessionId) throw new TypeError("Invalid pressure request");
    const agent = options.agentForSession(input.sessionId);
    if (input.action === "show") { if (input.mode !== undefined) throw new TypeError("show does not accept mode"); return status(agent); }
    if (input.mode === undefined) throw new TypeError("pressure mode is required");
    const mode = resolveCompactionPressureMode(input.mode);
    if (mode === "window-ratio" && !status(agent).supported) throw new TypeError("当前会话不支持接管自动压缩，未修改设置");
    signal.throwIfAborted();
    const saved = writeCompactionPressure(options.storePath, mode);
    return {...status(agent), ...(saved.backupPath ? {reason: `原无效配置已备份：${saved.backupPath}`} : {})};
  }
  async function mountEngine(owner: any, config: unknown) {
    await ready;
    if (!modules) throw new Error(loadError ?? "Native compaction APIs unavailable");
    const fiber = await owner.plugin(modules.BasicCompactionEngine, config);
    const identity = serviceIdentity(owner.get("compaction"));
    if (identity === undefined) throw new Error("Native compaction engine did not activate");
    managedEngines.add(identity);
    owner.effect(() => () => { managedEngines.delete(identity); });
    return fiber;
  }
  return {ready, status, control, mountEngine, enableProfile};
}
