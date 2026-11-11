import { acquirePressureRuntime } from "./bootstrap.mjs";

export const name = "odai-compaction-engine";
/** Mount the unchanged native engine only after its pressure adapter exists. */
export async function apply(ctx: any, config: unknown = {}): Promise<void> {
  const shared = acquirePressureRuntime(ctx);
  await shared.installation;
  if (!shared.adapter) throw new Error("Native compaction adapter unavailable");
  await shared.adapter.mountEngine(ctx, config);
}
