import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { packageManagerInvocation, runPackagePack } from "./run-package-pack.mjs";

test("pack runner uses the Windows command shim through a shell", () => {
  assert.deepEqual(packageManagerInvocation("win32", undefined), {
    command: "npm.cmd",
    prefixArgs: [],
    shell: true,
  });
  assert.deepEqual(packageManagerInvocation("linux", undefined), {
    command: "npm",
    prefixArgs: [],
    shell: false,
  });
});

test("pack runner cleans generated roots when the pack command fails", async () => {
  const packageRoot = await mkdtemp(resolve(tmpdir(), "odai-pack-runner-"));
  try {
    await Promise.all([
      mkdir(resolve(packageRoot, "runtime"), { recursive: true }),
      mkdir(resolve(packageRoot, "skills/odai"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(packageRoot, "runtime/index.mjs"), "export default {};\n", "utf8"),
      writeFile(resolve(packageRoot, "skills/odai/SKILL.md"), "---\nname: odai\n---\n", "utf8"),
    ]);

    let invocation;
    const code = await runPackagePack({
      packageRoot,
      cleanRoots: ["runtime", "skills"],
      packArgs: ["--dry-run"],
      async runCommand(packArgs, cwd) {
        invocation = { packArgs, cwd };
        return 37;
      },
    });

    assert.equal(code, 37);
    assert.deepEqual(invocation, { packArgs: ["--dry-run"], cwd: packageRoot });
    await assert.rejects(stat(resolve(packageRoot, "runtime")), { code: "ENOENT" });
    await assert.rejects(stat(resolve(packageRoot, "skills")), { code: "ENOENT" });
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("pack runner rejects cleanup outside the package root", async () => {
  const packageRoot = await mkdtemp(resolve(tmpdir(), "odai-pack-boundary-"));
  try {
    await assert.rejects(
      runPackagePack({ packageRoot, cleanRoots: ["../outside"], runCommand: async () => 0 }),
      /must stay below the package root/u,
    );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
