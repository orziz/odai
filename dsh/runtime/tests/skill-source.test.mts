import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolve } from "node:path";

import { apply, resolveSkillPath } from "../build/index.mjs";
import {
  chooseSkillBundle,
  compareSkillVersions,
  loadSkillBundle,
} from "../build/skill-bundle.mjs";
import {
  createSkillSourceConfigTool,
  effectiveSkillSource,
  readSkillSourceStore,
} from "../build/skill-source-config.mjs";
import { resolveSkillSelection } from "../build/skill-selector.mjs";
import {
  selectSharedSkillForTurn,
  sharedSkillSelection,
} from "../build/skill-selection-state.mjs";
import { isUnknownRecord } from "../build/runtime-types.mjs";
import type {
  DshAgent,
  DshEvent,
  DshMessage,
  DshRuntimeContext,
  PromptSection,
  RuntimeTool,
  ToolExecution,
  UnknownRecord,
} from "../build/runtime-types.mjs";

interface TurnAgent extends DshAgent { phase: { turn: number } }

interface CapturedContext extends DshRuntimeContext {
  captured: {
    handlers: Map<string, CallableFunction>;
    sections: PromptSection[];
    guards: unknown[];
    tools: RuntimeTool<unknown, UnknownRecord>[];
    logs: string[];
  };
}

function turnAgent(cwd?: string, events: DshEvent[] = []): TurnAgent {
  return {
    phase: { turn: 1 },
    session: { header: cwd ? { cwd } : {}, events, append() {} },
  };
}

function testExecution(origin?: string): ToolExecution {
  return {
    name: "odai_skill_source_config",
    agent: { session: { header: origin ? { origin } : {}, events: [], append() {} } },
  };
}

function isRuntimeTool(value: unknown): value is RuntimeTool<unknown, UnknownRecord> {
  return isUnknownRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

const canonicalRoot = resolve(import.meta.dirname, "../../../skills/odai");
const canonicalPath = resolve(canonicalRoot, "SKILL.md");
const bundled = loadSkillBundle(canonicalPath);

function fixtureRoot(label: string): string {
  return mkdtempSync(resolve(tmpdir(), `odai-${label}-`));
}

function installBundle(root: string, version: string, marker = ""): string {
  cpSync(canonicalRoot, root, { recursive: true });
  const manifestPath = resolve(root, "manifest.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isUnknownRecord(manifest)) throw new TypeError("fixture manifest must be an object");
  manifest.skillVersion = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (marker) {
    writeFileSync(resolve(root, "SKILL.md"), `${readFileSync(resolve(root, "SKILL.md"), "utf8").trimEnd()}\n\n${marker}\n`, "utf8");
    writeFileSync(
      resolve(root, "assets/routing-roles/planner.md"),
      `${readFileSync(resolve(root, "assets/routing-roles/planner.md"), "utf8").trimEnd()}\n\n${marker}_PLANNER\n`,
      "utf8",
    );
    writeFileSync(
      resolve(root, "references/planning.md"),
      `${readFileSync(resolve(root, "references/planning.md"), "utf8").trimEnd()}\n\n${marker}_PLANNING\n`,
      "utf8",
    );
  }
  return resolve(root, "SKILL.md");
}

function userMessage(text: string): DshMessage {
  return {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function fakeContext(extra: Partial<DshRuntimeContext> = {}): CapturedContext {
  const captured: CapturedContext["captured"] = {
    handlers: new Map(), sections: [], guards: [], tools: [], logs: [],
  };
  return {
    llm: {
      resolveCallConfig() { return {}; },
      async *stream() { yield {}; },
    },
    ...extra,
    captured,
    systemPrompt: {
      section(value: PromptSection) { captured.sections.push(value); },
    },
    tools: {
      register(value: unknown) {
        if (!isRuntimeTool(value)) throw new TypeError("expected a runtime tool");
        captured.tools.push(value);
      },
      guard(value) { captured.guards.push(value); },
    },
    on(event: string, handler: CallableFunction) { captured.handlers.set(event, handler); },
    logger() {
      return {
        info(message: string) { captured.logs.push(message); },
        warn(message: string) { captured.logs.push(message); },
      };
    },
  };
}

function handler(ctx: CapturedContext, event: string): CallableFunction {
  const value = ctx.captured.handlers.get(event);
  if (!value) throw new Error(`missing ${event} handler`);
  return value;
}

function assemblyFor(ctx: CapturedContext) {
  return {
    sections: ctx.captured.sections.map(({ name, text }) => ({ name, text })),
    contexts: [],
    tools: [],
    variables: {},
  };
}

test("bundle manifest validates complete content and full SemVer precedence", () => {
  assert.equal(bundled.manifest.skillVersion, "0.3.8");
  assert.equal(bundled.manifest.runtimeContract, 6);
  assert.equal(bundled.manifest.requiredFiles.length, 27);
  assert.match(bundled.roleContracts.researcher, /来源账本只是检索索引/u);
  assert.match(bundled.roleContracts.reviewer, /来源绑定本身不证明语义冲突/u);
  assert.ok(bundled.manifest.requiredFiles.includes("references/care.md"));
  assert.deepEqual(Object.keys(bundled.referenceContracts), [
    "dao",
    "planning",
    "craft",
    "verification",
    "support",
    "leverage",
    "care",
    "human-safety",
  ]);
  assert.match(bundled.referenceContracts.craft, /通用制作工艺/u);
  assert.match(bundled.referenceContracts.verification, /验证与完成/u);
  const leverage = readFileSync(resolve(canonicalRoot, "references/leverage.md"), "utf8");
  assert.match(leverage, /唯一总控与四项可选责任/u);
  assert.match(leverage, /实施始终由总控负责/u);
  assert.match(bundled.digest, /^[a-f0-9]{64}$/u);
  assert.equal(compareSkillVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  assert.equal(compareSkillVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareSkillVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSkillVersions("999999999999999999999.0.0", "999999999999999999998.9.9"), 1);

  const scratch = fixtureRoot("bundle-conflict");
  try {
    const conflicting = loadSkillBundle(installBundle(resolve(scratch, "odai"), bundled.manifest.skillVersion, "CONFLICT"), {
      source: "user-dsh",
    });
    const selection = chooseSkillBundle({ mode: "auto", bundled, candidate: conflicting });
    assert.equal(selection.bundle, bundled);
    assert.equal(selection.reasonCode, "same-version-content-conflict");
    writeFileSync(
      resolve(scratch, "odai", "SKILL.md"),
      "---\nname: not-odai\n---\n\nname: odai\n---\n",
      "utf8",
    );
    assert.throws(
      () => loadSkillBundle(resolve(scratch, "odai", "SKILL.md")),
      /does not declare name odai/u,
    );
    rmSync(resolve(scratch, "odai", "assets/routing-roles/planner.md"));
    assert.throws(() => loadSkillBundle(resolve(scratch, "odai", "SKILL.md")), /missing assets\/routing-roles\/planner\.md/u);

    const topologyRoot = resolve(scratch, "topology");
    installBundle(topologyRoot, bundled.manifest.skillVersion);
    const topologyManifestPath = resolve(topologyRoot, "manifest.json");
    const topologyManifest: unknown = JSON.parse(readFileSync(topologyManifestPath, "utf8"));
    if (!isUnknownRecord(topologyManifest) || !isUnknownRecord(topologyManifest.referenceFiles)) {
      throw new TypeError("fixture manifest must expose referenceFiles");
    }
    const supportPath = topologyManifest.referenceFiles.support;
    delete topologyManifest.referenceFiles.support;
    writeFileSync(topologyManifestPath, `${JSON.stringify(topologyManifest, null, 2)}\n`, "utf8");
    assert.throws(() => loadSkillBundle(resolve(topologyRoot, "SKILL.md")), /referenceFiles/u);
    topologyManifest.referenceFiles.support = topologyManifest.referenceFiles.dao;
    writeFileSync(topologyManifestPath, `${JSON.stringify(topologyManifest, null, 2)}\n`, "utf8");
    assert.throws(() => loadSkillBundle(resolve(topologyRoot, "SKILL.md")), /unique file/u);
    topologyManifest.referenceFiles.support = supportPath;
    topologyManifest.referenceFiles.unknown = "references/dao.md";
    writeFileSync(topologyManifestPath, `${JSON.stringify(topologyManifest, null, 2)}\n`, "utf8");
    assert.throws(() => loadSkillBundle(resolve(topologyRoot, "SKILL.md")), /unknown owners/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("bundle files cannot escape lexical or realpath boundaries", (t) => {
  const scratch = fixtureRoot("bundle-boundary");
  try {
    const lexicalRoot = resolve(scratch, "lexical");
    installBundle(lexicalRoot, bundled.manifest.skillVersion);
    const lexicalManifestPath = resolve(lexicalRoot, "manifest.json");
    const lexicalManifest: unknown = JSON.parse(readFileSync(lexicalManifestPath, "utf8"));
    if (!isUnknownRecord(lexicalManifest) || !Array.isArray(lexicalManifest.requiredFiles)) {
      throw new TypeError("fixture manifest must expose requiredFiles");
    }
    lexicalManifest.requiredFiles.push("../outside.md");
    writeFileSync(lexicalManifestPath, `${JSON.stringify(lexicalManifest, null, 2)}\n`, "utf8");
    assert.throws(() => loadSkillBundle(resolve(lexicalRoot, "SKILL.md")), /unsafe required file/u);

    const symlinkRoot = resolve(scratch, "symlink");
    installBundle(symlinkRoot, bundled.manifest.skillVersion);
    const outside = resolve(scratch, "outside-craft.md");
    const craftPath = resolve(symlinkRoot, "references/craft.md");
    writeFileSync(outside, "outside bundle content\n", "utf8");
    rmSync(craftPath);
    try {
      symlinkSync(outside, craftPath, "file");
    } catch (error) {
      const code = isUnknownRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (code && ["EPERM", "EACCES", "ENOTSUP"].includes(code)) {
        t.skip(`symlinks unavailable: ${code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => loadSkillBundle(resolve(symlinkRoot, "SKILL.md")), /escapes through a symlink/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("auto source keeps project pins scoped and selects newer user installs elsewhere", async () => {
  const scratch = fixtureRoot("source-scope");
  try {
    const projectA = resolve(scratch, "project-a");
    const projectB = resolve(scratch, "project-b");
    const dshHome = resolve(scratch, "dsh-home");
    const agentsHome = resolve(scratch, "agents-home");
    mkdirSync(resolve(projectA, ".git"), { recursive: true });
    mkdirSync(resolve(projectB, ".git"), { recursive: true });
    installBundle(resolve(projectA, ".dsh/skills/odai"), "0.0.9", "PROJECT_A");
    installBundle(resolve(dshHome, "skills/odai"), "0.4.0", "USER_DSH");
    const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };

    const projectSelection = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: resolve(projectA, "src"),
      env,
    });
    assert.equal(projectSelection.bundle.source, "project-dsh");
    assert.equal(projectSelection.bundle.manifest.skillVersion, "0.0.9");
    assert.match(projectSelection.bundle.skillText, /PROJECT_A/u);

    const userSelection = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: projectB,
      env,
    });
    assert.equal(userSelection.bundle.source, "user-dsh");
    assert.equal(userSelection.bundle.manifest.skillVersion, "0.4.0");
    assert.doesNotMatch(userSelection.bundle.skillText, /PROJECT_A/u);

    const forcedUser = await resolveSkillSelection({
      mode: "user",
      bundled,
      cwd: projectA,
      env,
    });
    assert.equal(forcedUser.bundle.source, "user-dsh");
    assert.doesNotMatch(forcedUser.bundle.skillText, /PROJECT_A/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("invalid and conflicting candidates continue to the next compatible source", async () => {
  const scratch = fixtureRoot("source-fallback");
  try {
    const project = resolve(scratch, "project");
    const dshHome = resolve(scratch, "dsh-home");
    const agentsHome = resolve(scratch, "agents-home");
    mkdirSync(resolve(project, ".git"), { recursive: true });
    installBundle(resolve(project, ".dsh/skills/odai"), "0.5.0", "BROKEN_PROJECT");
    rmSync(resolve(project, ".dsh/skills/odai/assets/routing-roles/reviewer.md"));
    installBundle(resolve(dshHome, "skills/odai"), bundled.manifest.skillVersion, "SAME_VERSION_CONFLICT");
    installBundle(resolve(agentsHome, "skills/odai"), "0.4.0", "USER_AGENTS");

    const selection = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: project,
      env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
    });
    assert.equal(selection.bundle.source, "user-agents");
    assert.equal(selection.bundle.manifest.skillVersion, "0.4.0");
    assert.deepEqual(selection.rejections.map(({ source, reasonCode }) => [source, reasonCode]), [
      ["project-dsh", "external-invalid"],
      ["user-dsh", "same-version-content-conflict"],
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("custom registry candidates participate without making bundled mode depend on skills", async () => {
  const scratch = fixtureRoot("custom-source");
  try {
    const customPath = installBundle(resolve(scratch, "custom/odai"), "0.4.0", "CUSTOM_SOURCE");
    let lookups = 0;
    const skills = {
      async get(...arguments_: unknown[]) {
        lookups += 1;
        const [name, options] = arguments_;
        assert.equal(name, "odai");
        assert.ok(isUnknownRecord(options));
        assert.equal(options.cwd, undefined);
        return {
          name: "odai",
          source: "custom",
          provider: "fixture-custom",
          path: customPath,
        };
      },
    };
    const selected = await resolveSkillSelection({
      mode: "auto",
      bundled,
      cwd: scratch,
      skills,
      scope: {},
      env: { DSH_HOME: resolve(scratch, "empty-dsh"), DSH_AGENTS_HOME: resolve(scratch, "empty-agents") },
    });
    assert.equal(selected.bundle.source, "custom");
    assert.equal(lookups, 1);

    const pinned = await resolveSkillSelection({ mode: "bundled", bundled, skills });
    assert.equal(pinned.bundle, bundled);
    assert.equal(lookups, 1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("source configuration is atomic, explicit, repairable, and denied to child agents", async () => {
  const scratch = fixtureRoot("source-config");
  try {
    const configPath = resolve(scratch, "odai/source.json");
    const tool = createSkillSourceConfigTool(configPath, "bundled");
    const rootExecution = testExecution();
    assert.throws(() => tool.execute({ action: "set" }, rootExecution), /source must be bundled, auto, or user/u);
    assert.throws(() => tool.execute({ action: "show", source: "auto" }, rootExecution), /source must be omitted for show/u);
    assert.throws(() => tool.execute({ action: "show", extra: true }, rootExecution), /unknown arguments/u);
    assert.equal((await tool.execute({ action: "show" }, rootExecution)).source, "bundled");
    assert.equal((await tool.execute({ action: "set", source: "auto" }, rootExecution)).source, "auto");
    assert.equal(effectiveSkillSource(configPath, "bundled"), "auto");
    assert.deepEqual(readSkillSourceStore(configPath), { schemaVersion: 1, source: "auto" });

    const lockPath = `${configPath}.lock`;
    writeFileSync(lockPath, `${process.pid}:live-owner\n`, "utf8");
    utimesSync(lockPath, new Date(0), new Date(0));
    assert.throws(
      () => tool.execute({ action: "set", source: "user" }, rootExecution),
      /is being updated; retry/u,
    );
    rmSync(lockPath);

    assert.throws(
      () => tool.execute({ action: "set", source: "user" }, testExecution("subagent")),
      /child agents may not change/u,
    );

    writeFileSync(configPath, "{broken\n", "utf8");
    const repaired = await tool.execute({ action: "set", source: "user" }, rootExecution);
    assert.equal(repaired.recoveredInvalidStore, true);
    assert.equal(effectiveSkillSource(configPath, "bundled"), "user");
    assert.equal((await tool.execute({ action: "remove" }, rootExecution)).source, "bundled");
    assert.equal(effectiveSkillSource(configPath, "bundled"), "bundled");

    const explicitPathTool = createSkillSourceConfigTool(configPath, "bundled", { explicitPath: true });
    const explicitView = await explicitPathTool.execute({ action: "show" }, rootExecution);
    assert.equal(explicitView.source, "bundled");
    assert.equal(explicitView.effectiveSource, "path");
    assert.equal(explicitView.hostOverride, true);
    const explicitSet = await explicitPathTool.execute({ action: "set", source: "auto" }, rootExecution);
    assert.equal(explicitSet.source, "auto");
    assert.equal(explicitSet.effectiveSource, "path");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("shared selection is single-flight within a turn and refreshes on the next turn", async () => {
  const agent = turnAgent();
  let selections = 0;
  const select = async () => ({ generation: ++selections });
  const [first, second] = await Promise.all([
    selectSharedSkillForTurn(agent, select),
    selectSharedSkillForTurn(agent, select),
  ]);
  assert.equal(first, second);
  assert.equal(selections, 1);
  assert.equal(sharedSkillSelection(agent, 1), first);

  agent.phase.turn = 2;
  const nextTurn = await selectSharedSkillForTurn(agent, select);
  assert.equal(nextTurn.generation, 2);
  assert.equal(selections, 2);
  assert.equal(sharedSkillSelection(agent, 1), undefined);
  assert.equal(sharedSkillSelection(agent, 2), nextTurn);
});

test("scoped runtime selection wins once and the global runtime follows it", async () => {
  const scratch = fixtureRoot("dual-runtime-selection");
  const previousDshHome = process.env.DSH_HOME;
  try {
    const project = resolve(scratch, "project");
    const dshHome = resolve(scratch, "dsh-home");
    mkdirSync(resolve(project, ".git"), { recursive: true });
    installBundle(resolve(project, ".dsh/skills/odai"), "0.0.7", "SCOPED_SELECTION");
    process.env.DSH_HOME = dshHome;

    const globalCtx = fakeContext();
    const scopedCtx = fakeContext();
    apply(globalCtx, {
      governance: { skillSource: "bundled", skillConfigPath: resolve(dshHome, "global-source.json") },
      routing: { mode: "off" },
    });
    apply(scopedCtx, {
      governance: { skillSource: "auto", skillConfigPath: resolve(dshHome, "scoped-source.json") },
      routing: { mode: "off" },
    });
    const agent = turnAgent(project);
    const context = { agent, scope: agent, signal: new AbortController().signal };
    const assembly = assemblyFor(scopedCtx);
    const globalAssemble = handler(globalCtx, "system-prompt/assemble");
    const scopedAssemble = handler(scopedCtx, "system-prompt/assemble");
    const selected = await globalAssemble(assembly, context, () => scopedAssemble(
      assembly,
      context,
      async () => assembly,
    ));

    const shared = sharedSkillSelection(agent, 1);
    assert.ok(isUnknownRecord(shared) && isUnknownRecord(shared.bundle));
    assert.equal(shared.bundle.source, "project-dsh");
    assert.match(selected.sections[0].text, /Canonical source: project-dsh/u);
    assert.match(selected.sections[0].text, /SCOPED_SELECTION/u);
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("runtime injects one project snapshot into both prompt and routed role contract", async () => {
  const scratch = fixtureRoot("runtime-selection");
  const previousDshHome = process.env.DSH_HOME;
  try {
    const project = resolve(scratch, "project");
    const dshHome = resolve(scratch, "dsh-home");
    mkdirSync(resolve(project, ".git"), { recursive: true });
    installBundle(resolve(project, ".dsh/skills/odai"), "0.0.8", "PROJECT_RUNTIME");
    process.env.DSH_HOME = dshHome;
    let startRequest: UnknownRecord | undefined;
    const ctx = fakeContext({
      subagents: {
        async start(_provider: unknown, request: UnknownRecord) {
          startRequest = request;
          return {
            localAgent: {
              session: {
                events: [{
                  type: "request/header",
                  data: { header: { config: { provider: "fixture", model: "planner" } } },
                }],
              },
            },
            result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "planned" }] }),
            async dispose() {},
          };
        },
      },
    });
    const sourceConfigPath = resolve(dshHome, "odai/source.json");
    apply(ctx, {
      governance: { skillSource: "auto", skillConfigPath: sourceConfigPath },
      routing: {
        mode: "execute",
        roles: { planner: { provider: "fixture", model: "planner" } },
      },
    });
    const agent = turnAgent(project, [{
      type: "odai/responsibility-gap",
      data: {
        turn: 1,
        step: 0,
        responsibility: "planner",
        gap: "Two architecture routes can change the implementation contract.",
        evidenceRefs: ["current-task", "project-contract"],
        expectedChange: "Select the compatible route before implementation.",
        stateDigest: "b".repeat(64),
      },
    }]);
    const signal = new AbortController().signal;
    const assemble = handler(ctx, "system-prompt/assemble");
    const baseAssembly = assemblyFor(ctx);
    const selectedAssembly = await assemble(baseAssembly, { agent, scope: agent, signal }, async () => baseAssembly);
    const governance = selectedAssembly.sections.find(({ name }: PromptSection) => name === "odai:canonical-governance");
    assert.ok(governance);
    assert.match(governance.text, /Canonical source: project-dsh/u);
    assert.match(governance.text, /PROJECT_RUNTIME/u);
    const referenceTool = ctx.captured.tools.find(({ name }) => name === "odai_reference");
    assert.ok(referenceTool);
    const planning = await referenceTool.execute({ reference: "planning" }, { name: referenceTool.name, agent });
    assert.ok(typeof planning.contract === "string");
    assert.match(planning.contract, /PROJECT_RUNTIME_PLANNING/u);
    const referenceSnapshot = sharedSkillSelection(agent, 1);
    assert.ok(isUnknownRecord(referenceSnapshot) && isUnknownRecord(referenceSnapshot.bundle));
    assert.equal(planning.digest, referenceSnapshot.bundle.digest);

    const preStep = handler(ctx, "agent/pre-step");
    await preStep({ agent, turn: 1, step: 1, signal }, async () => ({
      kind: "enter",
      messages: [userMessage("请独立规划一下架构选型")],
    }));
    assert.ok(startRequest);
    const prompt = startRequest.prompt;
    assert.ok(Array.isArray(prompt) && isUnknownRecord(prompt[0]) && typeof prompt[0].text === "string");
    assert.match(prompt[0].text, /PROJECT_RUNTIME_PLANNER/u);

    const sourceTool = ctx.captured.tools.find(({ name }) => name === "odai_skill_source_config");
    assert.ok(sourceTool);
    await sourceTool.execute({ action: "set", source: "bundled" }, { name: sourceTool.name, agent });
    const sameTurn = await assemble(baseAssembly, { agent, scope: agent, signal }, async () => baseAssembly);
    assert.match(sameTurn.sections[0].text, /Canonical source: project-dsh/u);
    agent.phase.turn = 2;
    const nextTurn = await assemble(baseAssembly, { agent, scope: agent, signal }, async () => baseAssembly);
    assert.match(nextTurn.sections[0].text, /Canonical source: bundled/u);
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("explicit skill paths fail fast instead of silently falling back", () => {
  assert.throws(
    () => resolveSkillPath(resolve(tmpdir(), `missing-odai-${Date.now()}`, "SKILL.md"), {}),
    /explicit Odai canonical skill not found/u,
  );
});
