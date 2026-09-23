import { execFileSync, spawn } from "node:child_process";
export function spawnDsh(command, args, options = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const spawnOptions = platform === "win32" ? { ...options, shell: true } : options;
  const command_ = normalizeDshCommand(command, platform);
  if (dependencies.execute) return dependencies.execute(command_, args, spawnOptions);
  return spawn(command_, args, spawnOptions);
}
function normalizeDshCommand(command, platform) {
  return platform === "win32" && command === "dsh" ? "dsh.cmd" : command;
}
export function terminateDsh(child, { platform = process.platform, execute = execFileSync } = {}) {
  if (!child || child.exitCode !== null) return;
  if (platform === "win32" && child.pid) {
    try {
      execute("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {}
  }
  child.kill?.("SIGTERM");
}
