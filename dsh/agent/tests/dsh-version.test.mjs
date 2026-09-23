import assert from "node:assert/strict";
import test from "node:test";
import { readDshVersion, spawnDsh } from "../build/src/dsh-version.mjs";
test("DSH version probe uses a shell for Windows npm command shims", () => {
  const calls = [];
  const actual = readDshVersion({
    dsh: "dsh",
    platform: "win32",
    execute(command, args, options) {
      calls.push({ command, args, options });
      return "0.1.2-rc.1\r\n";
    },
  });
  assert.equal(actual, "0.1.2-rc.1");
  assert.deepEqual(calls, [{ command: "dsh.cmd", args: ["-V"], options: { encoding: "utf8", shell: true } }]);
});
test("Windows keeps an explicit DSH binary unchanged", () => {
  const calls = [];
  const explicit = "C:\\tools\\dsh.cmd";
  readDshVersion({
    dsh: explicit,
    platform: "win32",
    execute(command, args, options) {
      calls.push({ command, args, options });
      return "0.1.2-rc.1\r\n";
    },
  });
  spawnDsh(
    explicit,
    ["web"],
    {},
    {
      platform: "win32",
      execute(command, args, options) {
        calls.push({ command, args, options });
        return {};
      },
    },
  );
  assert.deepEqual(calls, [
    { command: explicit, args: ["-V"], options: { encoding: "utf8", shell: true } },
    { command: explicit, args: ["web"], options: { shell: true } },
  ]);
});
test("DSH version probe directly executes binaries outside Windows", () => {
  const calls = [];
  readDshVersion({
    dsh: "/usr/local/bin/dsh",
    platform: "linux",
    execute(command, args, options) {
      calls.push({ command, args, options });
      return "0.1.2-rc.1\n";
    },
  });
  assert.deepEqual(calls, [{ command: "/usr/local/bin/dsh", args: ["-V"], options: { encoding: "utf8" } }]);
});
test("DSH process spawn uses a shell only on Windows", () => {
  const calls = [];
  const child = {};
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  assert.equal(spawnDsh("dsh", ["web"], { cwd: "workspace" }, { platform: "win32", execute }), child);
  spawnDsh("dsh", ["web"], { cwd: "workspace" }, { platform: "linux", execute });
  assert.deepEqual(calls, [
    { command: "dsh.cmd", args: ["web"], options: { cwd: "workspace", shell: true } },
    { command: "dsh", args: ["web"], options: { cwd: "workspace" } },
  ]);
});
