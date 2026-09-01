import { installControlCenterRuntime } from "./control-center-runtime.mjs";
import { resolveRoutingConfigPath } from "./routing-config.mjs";
import type { DshRuntimeContext, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

export const name = "odai-control-center-host";
export const inject = ["connection", "llm"];

export function apply(ctx: DshRuntimeContext, rawConfig: unknown = {}): void {
  const config = isUnknownRecord(rawConfig) ? rawConfig : {};
  const routing = isUnknownRecord(config.routing) ? config.routing : {};
  const dispose = installControlCenterRuntime(ctx, {
    configPath: resolveRoutingConfigPath(routing.configPath),
  });
  if (dispose) ctx.effect?.(() => dispose, "odai: Control Center host RPC");
}

export type ControlCenterHostConfig = UnknownRecord & {
  routing?: { configPath?: string };
};
