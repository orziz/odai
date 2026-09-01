import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import {
  acceptsControlCenterInstall,
  promptForControlCenterInstall,
} from "../src/control-center-prompt.mjs";

test("Control Center install consent defaults an interactive empty answer to yes", () => {
  assert.equal(acceptsControlCenterInstall(""), true);
  assert.equal(acceptsControlCenterInstall("   "), true);
  assert.equal(acceptsControlCenterInstall("y"), true);
  assert.equal(acceptsControlCenterInstall("YES"), true);
  assert.equal(acceptsControlCenterInstall("n"), false);
  assert.equal(acceptsControlCenterInstall("no"), false);
  assert.equal(acceptsControlCenterInstall("later"), false);
});

test("Control Center prompt displays Y/n and accepts Enter", async () => {
  const output = new PassThrough();
  let displayed = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { displayed += chunk; });
  assert.equal(await promptForControlCenterInstall(Readable.from(["\n"]), output), true);
  assert.match(displayed, /profile “web”.*回车或 y\/yes 确认.*\[Y\/n\]/u);
});

test("Control Center prompt accepts explicit y and rejects n or EOF", async () => {
  assert.equal(await promptForControlCenterInstall(Readable.from(["y\n"]), new PassThrough()), true);
  assert.equal(await promptForControlCenterInstall(Readable.from(["n\n"]), new PassThrough()), false);
  assert.equal(await promptForControlCenterInstall(Readable.from([]), new PassThrough()), false);
});
