/** Odai's opt-in pressure policy; host mode delegates to the host engine unchanged. */
export type CompactionPressureMode = "host" | "window-ratio";

export function resolveCompactionPressureMode(value: unknown): CompactionPressureMode {
  if (value === undefined || value === "host") return "host";
  if (value === "window-ratio") return value;
  throw new TypeError("compaction pressure mode must be host or window-ratio");
}

/** Only model capacity determines this threshold; request output limits are independent. */
export function windowRatioThreshold(contextWindow: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new TypeError("compaction contextWindow must be a positive safe integer");
  }
  return Math.floor(contextWindow * 0.8);
}

/** Execute pressure reduction using host-owned durable transactions supplied by the adapter. */
export async function compactAtWindowRatio<Seq>(options: {
  contextWindow: number;
  signal: AbortSignal;
  retries: number;
  requireBelowThreshold: boolean;
  measure: () => { totalTokens: number; range: { start: Seq; end: Seq } | null };
  compact: (start: Seq, end: Seq, signal: AbortSignal) => Promise<unknown>;
}): Promise<boolean> {
  const threshold = windowRatioThreshold(options.contextWindow);
  if (!Number.isSafeInteger(options.retries) || options.retries < 0) throw new TypeError("invalid compaction retry count");
  let changed = false;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    options.signal.throwIfAborted();
    const measurement = options.measure();
    if (!Number.isFinite(measurement.totalTokens) || measurement.totalTokens < 0) throw new Error("invalid context measurement");
    if (measurement.totalTokens < threshold) return changed;
    if (measurement.range === null) {
      if (!changed && !options.requireBelowThreshold) return false;
      throw new Error("No balanced history range can reduce context below the window threshold");
    }
    await options.compact(measurement.range.start, measurement.range.end, options.signal);
    changed = true;
  }
  options.signal.throwIfAborted();
  if (options.measure().totalTokens >= threshold) throw new Error("Context remains above the window threshold after compaction");
  return changed;
}

export interface PricedSurfaceNode<Seq> {
  readonly seq: Seq;
  readonly tokens: number;
}

/** Select an old prefix while retaining recent context and complete tool exchanges. */
export function windowRatioRange<Seq>(options: {
  surface: readonly Seq[];
  priced: readonly PricedSurfaceNode<Seq>[];
  contextWindow: number;
  retainTokens?: number;
  systemHead: boolean;
  balancedBefore: (seq: Seq) => boolean;
}): { start: Seq; end: Seq } | null {
  const { surface, priced } = options;
  windowRatioThreshold(options.contextWindow);
  if (surface.length !== priced.length || surface.some((seq, index) => seq !== priced[index]?.seq)) {
    throw new Error("Odai compaction: measured surface is stale");
  }
  const first = options.systemHead ? 1 : 0;
  // Keep at least the latest node even when its token estimate is zero.
  const retain = options.retainTokens ?? Math.floor(options.contextWindow * 0.16);
  if (!Number.isSafeInteger(retain) || retain < 0 || retain >= windowRatioThreshold(options.contextWindow)) {
    throw new Error("Odai compaction: retained tail must be below the window threshold");
  }
  let accumulated = 0;
  let boundary = priced.length;
  for (let i = priced.length - 1; i >= first; i--) {
    const node = priced[i]!;
    if (!Number.isFinite(node.tokens) || node.tokens < 0) throw new Error("Odai compaction: invalid token estimate");
    accumulated += node.tokens;
    boundary = i;
    if (accumulated >= retain) break;
  }
  while (boundary > first && !options.balancedBefore(surface[boundary]!)) boundary--;
  if (boundary <= first || first >= surface.length) return null;
  return { start: surface[first]!, end: surface[boundary - 1]! };
}
