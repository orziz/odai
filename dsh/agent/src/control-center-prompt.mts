import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export function acceptsControlCenterInstall(answer: string): boolean {
  return /^(?:|y|yes)$/iu.test(answer.trim());
}

export async function promptForControlCenterInstall(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  profile = "web",
): Promise<boolean> {
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`同时把 Odai 控制中心安装到 DSH profile “${profile}”？[Y/n] `);
    return acceptsControlCenterInstall(answer);
  } finally {
    readline.close();
  }
}
