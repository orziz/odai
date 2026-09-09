import type {
  DshMessage,
  DshSession,
  ModelRoute,
  RuntimeConfig,
  RuntimeLogger,
  UnknownRecord,
} from "./runtime-types.mjs";

interface CompactionRequest extends UnknownRecord {
  purpose?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  cacheRetention?: string;
  messages?: DshMessage[];
  signal?: AbortSignal;
}

interface StreamChunk extends UnknownRecord {
  type?: string;
  reason?: { kind?: string; failure?: unknown };
}

interface RouteFailure {
  kind: string;
  code: string;
  message: string;
}

interface RouteValidation {
  status: "verified" | "rejected" | "unavailable";
  failure?: RouteFailure;
}

interface CompactionSelection {
  source: "inherit" | "persisted";
  target?: ModelRoute;
  status?: "fallback";
  reasonCode?: string;
}

interface InvalidationResult {
  invalidated: boolean;
  backupPath?: string;
  error?: string;
}

interface RuntimeSessions {
  get(sessionId: string): DshSession | undefined;
}

interface CompactionDependencies {
  appendEvent(agent: { session: DshSession }, type: string, data: UnknownRecord): void;
  applyCompactionStateProtocol(options: CompactionRequest, target: ModelRoute | undefined): boolean;
  applyCompactionTarget(options: CompactionRequest, target: ModelRoute | undefined, sessions?: RuntimeSessions): boolean;
  classifyModelRouteFailure(failure: unknown): RouteFailure;
  config: RuntimeConfig;
  ctx: {
    on(event: "llm/stream", handler: CallableFunction): void;
    llm: {
      resolveCallConfig(route: ModelRoute, signal?: AbortSignal): unknown;
      stream(options: CompactionRequest): AsyncIterable<StreamChunk>;
    };
    sessions?: RuntimeSessions;
  };
  effectiveCompactionTarget(configPath: string): CompactionSelection;
  inheritCompactionReasoning(
    options: CompactionRequest,
    sessions: RuntimeSessions | undefined,
    cacheRetention: RuntimeConfig["compaction"]["cacheRetention"],
  ): boolean;
  invalidatePersistedCompactionTarget(configPath: string, target: ModelRoute): InvalidationResult;
  logger: RuntimeLogger;
  probeModelRoute(
    resolve: (route: ModelRoute, signal?: AbortSignal) => unknown,
    route: ModelRoute,
    signal?: AbortSignal,
  ): Promise<RouteValidation>;
  routeFromConfig(config: UnknownRecord): ModelRoute | undefined;
  sameRequestModelRoute(left: UnknownRecord, right: UnknownRecord): boolean;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamChunk> {
  return value !== null
    && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === "function";
}

export function installCompactionRuntime(deps: CompactionDependencies): void {
  const {
    appendEvent,
    applyCompactionStateProtocol,
    applyCompactionTarget,
    classifyModelRouteFailure,
    config,
    ctx,
    effectiveCompactionTarget,
    inheritCompactionReasoning,
    invalidatePersistedCompactionTarget,
    logger,
    probeModelRoute,
    routeFromConfig,
    sameRequestModelRoute,
  } = deps;
  const selectCompactionTarget = (): CompactionSelection => {
    try {
      return effectiveCompactionTarget(config.compaction.configPath);
    } catch (error) {
      logger.warn(`Odai compaction model configuration is invalid; inheriting the conversation route: ${error instanceof Error ? error.message : String(error)}`);
      return Object.freeze({ source: "inherit", status: "fallback", reasonCode: "compaction-config-invalid" });
    }
  };
  const compactionFallbackRequests = new WeakSet<CompactionRequest>();
  ctx.on("llm/stream", (options: CompactionRequest, next: () => unknown) => {
    if (options.purpose !== "compaction" || compactionFallbackRequests.has(options)) return next();
    const selection = selectCompactionTarget();
    const target = selection.target;
    const downstream = next();
    if (!target || !isAsyncIterable(downstream)) {
      applyCompactionTarget(options, target, ctx.sessions);
      applyCompactionStateProtocol(options, target);
      inheritCompactionReasoning(options, ctx.sessions, config.compaction.cacheRetention);
      return downstream;
    }

    const original: Readonly<CompactionRequest> = Object.freeze({ ...options, messages: options.messages });
    const session = options.sessionId === undefined ? undefined : ctx.sessions?.get(options.sessionId);
    const record = (data: UnknownRecord) => {
      if (session) appendEvent({ session }, "odai/compaction-route", data);
    };
    const restoreOriginal = () => {
      for (const key of Object.keys(options)) {
        if (!Object.hasOwn(original, key)) delete options[key];
      }
      Object.assign(options, original);
    };
    return (async function* configuredCompactionRoute() {
      const validation = await probeModelRoute(
        (candidate, signal) => ctx.llm.resolveCallConfig(candidate, signal),
        target,
        options.signal,
      );
      if (validation.status === "rejected") {
        const routeFailure = validation.failure;
        if (!routeFailure) throw new Error("rejected compaction route did not include failure evidence");
        let invalidation: InvalidationResult = { invalidated: false };
        if (routeFailure.kind === "deterministic" && selection.source === "persisted") {
          try {
            invalidation = invalidatePersistedCompactionTarget(config.compaction.configPath, target);
          } catch (error) {
            invalidation = { invalidated: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        record({
          status: "fallback",
          requestedRoute: target,
          fallbackRoute: routeFromConfig(original),
          fallbackUsed: true,
          failureKind: routeFailure.kind,
          errorCode: routeFailure.code,
          error: routeFailure.message,
          invalidated: invalidation.invalidated,
          ...(invalidation.backupPath ? { backupPath: invalidation.backupPath } : {}),
          ...(invalidation.error ? { cleanupError: invalidation.error } : {}),
        });
        applyCompactionStateProtocol(options, undefined);
        inheritCompactionReasoning(options, ctx.sessions, config.compaction.cacheRetention);
        for await (const chunk of downstream) yield chunk;
        return;
      }

      applyCompactionTarget(options, target, ctx.sessions);
      applyCompactionStateProtocol(options, target);
      inheritCompactionReasoning(options, ctx.sessions, config.compaction.cacheRetention);
      const buffered: StreamChunk[] = [];
      let terminalFailure: unknown;
      for await (const chunk of downstream) {
        buffered.push(chunk);
        if (chunk.type === "finish" && ["error", "aborted"].includes(chunk.reason?.kind ?? "")) {
          terminalFailure = chunk.reason?.kind === "aborted"
            ? { code: "ABORTED", message: "Compaction stream aborted", failure: chunk.reason.failure }
            : chunk.reason?.failure ?? new Error("Compaction stream finished with error");
        }
      }
      if (options.signal?.aborted) terminalFailure = { code: "ABORTED", message: "Compaction cancelled" };
      if (!terminalFailure) {
        record({
          status: "applied",
          requestedRoute: target,
          effectiveRoute: routeFromConfig(options),
          fallbackUsed: false,
        });
        for (const chunk of buffered) yield chunk;
        return;
      }

      const failure = classifyModelRouteFailure(terminalFailure);
      if (failure.kind === "cancelled" || options.signal?.aborted) {
        record({
          status: "failed",
          requestedRoute: target,
          fallbackUsed: false,
          failureKind: failure.kind,
          errorCode: failure.code,
          error: failure.message,
        });
        for (const chunk of buffered) yield chunk;
        return;
      }

      if (sameRequestModelRoute(original, options)) {
        record({
          status: "failed",
          requestedRoute: target,
          effectiveRoute: routeFromConfig(options),
          fallbackUsed: false,
          failureKind: failure.kind,
          errorCode: failure.code,
          error: failure.message,
          stopReason: "configured-and-inherited-routes-match",
        });
        for (const chunk of buffered) yield chunk;
        return;
      }

      let invalidation: InvalidationResult = { invalidated: false };
      if (failure.kind === "deterministic" && selection.source === "persisted") {
        try {
          invalidation = invalidatePersistedCompactionTarget(config.compaction.configPath, target);
        } catch (error) {
          invalidation = { invalidated: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      restoreOriginal();
      const fallbackOptions: CompactionRequest = { ...original, messages: original.messages };
      applyCompactionStateProtocol(fallbackOptions, undefined);
      inheritCompactionReasoning(fallbackOptions, ctx.sessions, config.compaction.cacheRetention);
      compactionFallbackRequests.add(fallbackOptions);
      record({
        status: "fallback",
        requestedRoute: target,
        fallbackRoute: routeFromConfig(fallbackOptions),
        fallbackUsed: true,
        failureKind: failure.kind,
        errorCode: failure.code,
        error: failure.message,
        invalidated: invalidation.invalidated,
        ...(invalidation.backupPath ? { backupPath: invalidation.backupPath } : {}),
        ...(invalidation.error ? { cleanupError: invalidation.error } : {}),
      });
      for await (const chunk of ctx.llm.stream(fallbackOptions)) yield chunk;
    })();
  });
}
