import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import {
  acceptsControlCenterInstall,
  promptForControlCenterInstall,
} from "../src/control-center-prompt.mjs";

test("Control Center install consent accepts only explicit yes", () => {
  assert.equal(acceptsControlCenterInstall(""), false);
  assert.equal(acceptsControlCenterInstall("   "), false);
  assert.equal(acceptsControlCenterInstall("y"), true);
  assert.equal(acceptsControlCenterInstall("YES"), true);
  assert.equal(acceptsControlCenterInstall("n"), false);
  assert.equal(acceptsControlCenterInstall("no"), false);
  assert.equal(acceptsControlCenterInstall("later"), false);
});

test("Control Center prompt displays y/N and rejects Enter", async () => {
  const output = new PassThrough();
  let displayed = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { displayed += chunk; });
  assert.equal(await promptForControlCenterInstall(Readable.from(["\n"]), output), false);
  assert.match(displayed, /profile “web”.*输入 y\/yes 确认 \[y\/N\]/u);
});

test("Control Center prompt accepts explicit y and rejects n or EOF", async () => {
  assert.equal(await promptForControlCenterInstall(Readable.from(["y\n"]), new PassThrough()), true);
  assert.equal(await promptForControlCenterInstall(Readable.from(["n\n"]), new PassThrough()), false);
  assert.equal(await promptForControlCenterInstall(Readable.from([]), new PassThrough()), false);
});
