import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export function acceptsControlCenterInstall(answer: string): boolean {
  return /^(?:|y|yes)$/iu.test(answer.trim());
}

export async function promptForControlCenterInstall(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  profile = "web",
  action = `把 Odai 控制中心安装到 DSH profile “${profile}”`,
): Promise<boolean> {
  if (input.readableEnded) return false;
  const readline = createInterface({ input, output });
  const eof = Symbol("control-center-prompt-eof");
  try {
    const answer = await Promise.race([
      readline.question(`${action}？回车或 y/yes 确认，n/no 取消 [Y/n] `),
      once(input, "end").then(() => eof),
    ]);
    if (typeof answer !== "string") return false;
    return acceptsControlCenterInstall(answer);
  } catch {
    return false;
  } finally {
    readline.close();
  }
}
