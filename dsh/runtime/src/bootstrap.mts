import * as runtime from "./index.mjs";
import { resolveConfig } from "./runtime-config.mjs";
import { loggerFor } from "./runtime-support.mjs";
import { compactionPressurePath } from "./compaction-pressure-store.mjs";
import { installCompactionPressureRuntime } from "./compaction-pressure-runtime.mjs";

export const name = runtime.name;
export { inheritCompactionReasoning, resolveConfig, resolveSkillPath, runRoutedRole } from "./index.mjs";
// No injection declaration: register interception before host engines activate.
type Adapter = ReturnType<typeof installCompactionPressureRuntime>;
interface Shared {
  path: string;
  configuredPath?: string;
  owners: Set<symbol>;
  installation: Promise<void>;
  failed?: unknown;
  fiber?: any;
  adapter?: Adapter;
  control: Adapter["control"];
}
type SharedGlobal = typeof globalThis & { __odaiPressureBootstrapV1?: WeakMap<object, Shared> };
export function acquirePressureRuntime(
  ctx: any,
  rawConfig?: unknown,
  options: { explicitConfig?: boolean } = {},
): Shared {
  const hasExplicitConfig = options.explicitConfig ?? rawConfig !== undefined;
  const defaultPath = compactionPressurePath(resolveConfig({}).compaction.configPath);
  const path = hasExplicitConfig
    ? compactionPressurePath(resolveConfig(rawConfig).compaction.configPath)
    : defaultPath;
  const root = ctx.root;
  if (!root?.plugin) throw new Error("Odai pressure bootstrap requires Cordis root");
  const sharedByRoot = (globalThis as SharedGlobal).__odaiPressureBootstrapV1 ??= new WeakMap<object, Shared>();
  let shared = sharedByRoot.get(root);
  if (shared && hasExplicitConfig) {
    if (shared.configuredPath !== undefined && shared.configuredPath !== path) {
      throw new Error("Agent and Plugin must use the same compaction configuration path");
    }
    shared.configuredPath = path;
    shared.path = path;
  }
  if (!shared) {
    const created: Shared = {
      path,
      ...(hasExplicitConfig ? { configuredPath: path } : {}),
      owners: new Set(), installation: Promise.resolve(),
      async control(payload, signal) {
        await created.installation;
        if (created.failed !== undefined) throw created.failed instanceof Error ? created.failed : new Error(String(created.failed));
        signal.throwIfAborted();
        if (!created.adapter) throw new Error("Pressure runtime unavailable");
        await created.adapter.ready;
        return created.adapter.control(payload, signal);
      },
    };
    sharedByRoot.set(root, created); shared = created;
    try {
      const installing = root.plugin(function odaiSharedPressure(owner: any) {
        created.adapter = installCompactionPressureRuntime(owner, {
          get storePath() { return created.path; },
          agentForSession: id => owner.get("agents")?.get(id),
          engineForAgent: agent => {
            const presets = owner.get("agentPresets");
            return presets ? presets.serviceFor(agent, "compaction") : owner.get("compaction");
          },
          warn: message => loggerFor(owner).warn(message),
        });
      });
      created.installation = Promise.resolve(installing).then(
        fiber => { created.fiber = fiber; },
        error => {
          created.failed = error;
          if (sharedByRoot.get(root) === created) sharedByRoot.delete(root);
        },
      );
    } catch (error) { sharedByRoot.delete(root); throw error; }
  }
  const current = shared, token = Symbol("odai-pressure-owner");
  current.owners.add(token);
  ctx.effect(() => async () => {
    current.owners.delete(token);
    await current.installation;
    if (current.owners.size !== 0 || sharedByRoot.get(root) !== current) return;
    sharedByRoot.delete(root);
    await current.fiber?.dispose();
  });
  return current;
}
export function applyPreset(ctx: any, rawConfig: unknown = {}): void {
  const current = acquirePressureRuntime(ctx, rawConfig, { explicitConfig: true });
  ctx.inject(runtime.inject, (available: any) => runtime.apply(available, rawConfig, current.control, "preset"));
}
export async function apply(ctx: any, rawConfig: unknown = {}): Promise<void> {
  const current = acquirePressureRuntime(ctx, rawConfig, { explicitConfig: true });
  await current.installation;
  if (current.failed !== undefined) throw current.failed instanceof Error ? current.failed : new Error(String(current.failed));
  current.adapter?.enableProfile(ctx);
  ctx.inject(runtime.inject, (available: any) => runtime.apply(available, rawConfig, current.control, "profile"));
}
