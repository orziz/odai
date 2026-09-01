import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export function acceptsControlCenterInstall(answer: string): boolean {
  return /^(?:y|yes)$/iu.test(answer.trim());
}

export async function promptForControlCenterInstall(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  profile = "web",
  action = `把 Odai 控制中心安装到 DSH profile “${profile}”`,
): Promise<boolean> {
  if (input.readableEnded) return false;
  const readline = createInterface({ input, output });
  try {
    const answer = await Promise.race([
      readline.question(`${action}？输入 y/yes 确认 [y/N] `),
      once(input, "end").then(() => ""),
    ]);
    return acceptsControlCenterInstall(answer);
  } catch {
    return false;
  } finally {
    readline.close();
  }
}
