import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillPack } from "./skill-pack.mjs";
import { SessionState } from "./session-state.mjs";
import { EvidenceLedger } from "../runtime/evidence-ledger.mjs";
import { ToolDispatcher } from "../runtime/tool-dispatcher.mjs";
import { UsageLedger } from "../runtime/usage-ledger.mjs";
import { collectProviderSessions } from "../runtime/provider-session.mjs";
import { Scheduler } from "../orchestrator/scheduler.mjs";
import {
  createProviderRegistryFromEnvironment,
  loadWorkspaceEnvironment,
  loadWorkspaceProviderConfig,
} from "../config/provider-config.mjs";
import { loadWorkspaceAgentProfiles } from "../config/agent-config.mjs";

export async function runPhase0Demo({ repoRoot: root = process.cwd(), allowApiKey = false } = {}) {
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "odai-cli-phase0-"));
  const sampleFile = path.join(sessionTmp, "sample.txt");
  await writeFile(sampleFile, "before\n", "utf8");

  const skillPack = await loadSkillPack({ repoRoot: root });
  const session = new SessionState({ id: "phase0-demo" });
  const evidence = new EvidenceLedger();
  const usageLedger = new UsageLedger({ evidence });
  const dispatcher = new ToolDispatcher({
    workspaceRoot: root,
    sessionTmp,
    evidence,
    session,
    checkpointDir: path.join(sessionTmp, "checkpoints"),
  });

  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env: process.env });
  const providers = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey,
    allowProviderCommand: false,
    config: loadWorkspaceProviderConfig({ workspaceRoot: root }),
  });

  const scheduler = new Scheduler({
    providers,
    agentProfiles: loadWorkspaceAgentProfiles({ workspaceRoot: root }),
    dispatcher,
    evidence,
    usageLedger,
  });

  const blockedWrite = await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "write",
    path: sampleFile,
    content: "blocked\n",
  });

  await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "read",
    path: sampleFile,
  });

  const allowedWrite = await dispatcher.dispatch({
    actor: { kind: "main", id: "main" },
    type: "write",
    path: sampleFile,
    content: "after\n",
  });

  const subagentResult = await scheduler.runSubagent({
    profileName: "reviewer",
    providerName: "mock-reviewer",
    input: {
      task: "Review a phase0 patch proposal.",
      files: [sampleFile],
    },
  });

  const patchCandidate = await scheduler.runSubagent({
    profileName: "implementer_candidate",
    providerName: "mock-main",
    input: {
      task: "Propose a patch for phase0.",
      target: sampleFile,
      content: "candidate after\n",
    },
  });

  const subagentBlockedWrite = await dispatcher.dispatch({
    actor: { kind: "subagent", id: subagentResult.agent.id },
    type: "write",
    path: sampleFile,
    content: "subagent direct write\n",
  });

  const usageSnapshot = usageLedger.snapshot();
  return {
    status: "ok",
    skill: {
      name: skillPack.name,
      entry: skillPack.entry,
      bytes: skillPack.entryText.length,
      entrySha256: skillPack.entrySha256,
      supportFileCount: skillPack.supportFiles.length,
    },
    providers: providers.list().map((provider) => ({
      name: provider.name,
      capabilities: provider.capabilities,
    })),
    gates: {
      blockedWrite,
      allowedWrite,
      subagentBlockedWrite,
    },
    subagent: subagentResult,
    patchCandidate,
    providerSessions: collectProviderSessions(usageSnapshot.calls),
    usage: usageSnapshot,
    evidence: evidence.snapshot(),
  };
}
