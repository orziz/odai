import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillPack } from "../../src/core/skill-pack.mjs";
import { monorepoRoot } from "./helpers.mjs";

/**
 * Shared path fixtures for sequential runtime suites.
 * Suites run in order and may attach session/evidence onto `shared`.
 */
export const shared = {
  /** @type {null | object} */
  runtime: null,
  /** long-lived roots created during config-routing suite */
  roots: {},
};

export async function createBaseFixtures() {
  process.env.ODAI_LANG = "en";
  const repoRoot = monorepoRoot;
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "odai-cli-smoke-"));
  const policyRoot = await mkdtemp(path.join(tmpdir(), "odai-cli-policy-"));
  const sampleFile = path.join(sessionTmp, "sample.txt");
  const stopFile = path.join(sessionTmp, "stop.txt");
  const patchFile = path.join(sessionTmp, "patch.txt");
  const resetFile = path.join(sessionTmp, "reset.txt");
  const perceptionFile = path.join(sessionTmp, "perception.txt");
  const intentFile = path.join(sessionTmp, "intent.txt");
  const secretFile = path.join(sessionTmp, ".env");
  const envExampleFile = path.join(sessionTmp, ".env.example");
  const cliAdoptFile = path.join(sessionTmp, "cli-adopt.txt");
  const agentLoopFile = path.join(sessionTmp, "agent-loop.txt");
  const agentLoopNewFile = path.join(sessionTmp, "agent-loop-new-file.txt");
  const overflowFile = path.join(sessionTmp, "overflow.txt");
  const checkpointDir = path.join(sessionTmp, "checkpoints");
  const rollbackWorkspaceFile = path.join(repoRoot, ".odai", "runs", "rollback-smoke.txt");
  const rollbackNewFile = path.join(repoRoot, ".odai", "runs", "rollback-new-file-smoke.txt");
  await writeFile(sampleFile, "before\n", "utf8");
  await writeFile(stopFile, "stop\n", "utf8");
  await writeFile(patchFile, "patch-before\n", "utf8");
  await writeFile(resetFile, "reset-before\n", "utf8");
  await writeFile(perceptionFile, "perception-before\n", "utf8");
  await writeFile(intentFile, "intent-before\n", "utf8");
  await writeFile(secretFile, "OPENAI_API_KEY=should-not-enter-model-context\n", "utf8");
  await writeFile(envExampleFile, "OPENAI_API_KEY=\n", "utf8");
  await writeFile(cliAdoptFile, "cli-before\n", "utf8");
  await writeFile(agentLoopFile, "agent-before\n", "utf8");
  await writeFile(overflowFile, "overflow-before\n", "utf8");
  await mkdir(path.dirname(rollbackWorkspaceFile), { recursive: true });
  await writeFile(rollbackWorkspaceFile, "rollback-before\n", "utf8");
  await writeFile(rollbackNewFile, "new file content\n", "utf8");
  const skillPack = await loadSkillPack({ repoRoot });
  const fx = {
    repoRoot,
    sessionTmp,
    policyRoot,
    sampleFile,
    stopFile,
    patchFile,
    resetFile,
    perceptionFile,
    intentFile,
    secretFile,
    envExampleFile,
    cliAdoptFile,
    agentLoopFile,
    agentLoopNewFile,
    overflowFile,
    checkpointDir,
    rollbackWorkspaceFile,
    rollbackNewFile,
    skillPack,
  };
  Object.assign(shared, fx);
  return fx;
}

export function bindRuntime(runtime) {
  shared.runtime = runtime;
  Object.assign(shared, runtime);
  return shared;
}

export function bindRoots(roots = {}) {
  Object.assign(shared.roots, roots);
  Object.assign(shared, roots);
  return shared;
}
