import assert from "node:assert/strict";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  inspectAgentControlCenter,
  installAgentControlCenter,
  uninstallAgentControlCenter,
} from "../src/control-center-installer.mjs";

interface Invocation {
  command: string;
  args: string[];
  options: ExecFileSyncOptionsWithStringEncoding;
}

test("Agent Control Center profile management is explicit, idempotent, and removable", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-center-"));
  const dshHome = resolve(scratch, "home");
  const profileRoot = resolve(dshHome, "profiles/web");
  const packagePath = resolve(profileRoot, "package.json");
  const calls: Invocation[] = [];
  try {
    await mkdir(profileRoot, { recursive: true });
    await writeFile(packagePath, JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: { "odai-dsh-plugin": "0.2.16" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "odai-dsh-plugin"] } },
    }, null, 2));

    const execute = (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => {
      calls.push({ command, args, options });
      const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
      if (args.includes("add")) {
        metadata.dependencies = { ...(metadata.dependencies ?? {}), "odai-dsh-agent": "link:/repo/dsh/agent" };
        metadata.dsh.profile.bundles.push("odai-dsh-agent");
      } else {
        delete metadata.dependencies["odai-dsh-agent"];
        metadata.dsh.profile.bundles = metadata.dsh.profile.bundles.filter((entry: string) => entry !== "odai-dsh-agent");
      }
      writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      return "";
    };

    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "absent");
    const installed = await installAgentControlCenter({
      dshHome,
      packageSpec: "/repo/dsh/agent",
      execute,
    });
    assert.equal(installed.operation, "installed");
    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "installed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ["plugin", "--profile", "web", "add", "/repo/dsh/agent"]);
    assert.equal(calls[0]?.options.env?.DSH_HOME, dshHome);

    assert.equal((await installAgentControlCenter({ dshHome, execute })).operation, "unchanged");
    assert.equal(calls.length, 1);

    assert.equal((await uninstallAgentControlCenter({ dshHome, execute })).operation, "uninstalled");
    assert.equal((await inspectAgentControlCenter({ dshHome })).status, "absent");
    const afterRemoval = JSON.parse(readFileSync(packagePath, "utf8"));
    assert.equal(afterRemoval.dependencies["odai-dsh-plugin"], "0.2.16");
    assert.equal(afterRemoval.dsh.profile.bundles.includes("odai-dsh-plugin"), true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]?.args, ["plugin", "--profile", "web", "remove", "odai-dsh-agent"]);
    assert.equal((await uninstallAgentControlCenter({ dshHome, execute })).operation, "absent");
    assert.equal(calls.length, 2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Agent Control Center refuses partially owned profile state", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-control-drift-"));
  const dshHome = resolve(scratch, "home");
  const profileRoot = resolve(dshHome, "profiles/web");
  try {
    await mkdir(profileRoot, { recursive: true });
    await writeFile(resolve(profileRoot, "package.json"), JSON.stringify({
      dependencies: { "odai-dsh-agent": "0.2.16" },
      dsh: { profile: { bundles: [] } },
    }));
    const inspected = await inspectAgentControlCenter({ dshHome });
    assert.equal(inspected.status, "drifted");
    assert.match(inspected.issues.join(" "), /bundle entry/u);
    await assert.rejects(installAgentControlCenter({ dshHome, execute: () => "" }), /drifted/u);
    await assert.rejects(uninstallAgentControlCenter({ dshHome, execute: () => "" }), /drifted/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
