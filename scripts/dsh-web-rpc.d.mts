import type { ChildProcess } from "node:child_process";

export function dshWebRpc(
  baseUrl: string,
  method: string,
  payload: unknown,
  cookie?: string,
): Promise<unknown>;

export function waitForDshWeb(
  baseUrl: string,
  child: ChildProcess,
  output: () => string,
  timeoutMs?: number,
): Promise<string | undefined>;
