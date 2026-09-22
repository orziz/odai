import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spawnDsh, terminateDsh } from "./dsh-process.mjs";

const sourcePluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(process.env.ODAI_PLUGIN_PACKAGE_ROOT ?? sourcePluginRoot);
const repoRoot = resolve(sourcePluginRoot, "../..");
const firstExisting = (label: string, candidates: readonly string[]): string => {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`cannot locate ${label}; checked: ${candidates.join(", ")}`);
  return found;
};
const pluginPath = firstExisting("Odai DSH runtime", [
  resolve(pluginRoot, "runtime/index.mjs"),
  resolve(pluginRoot, "../runtime/build/index.mjs"),
]);
const routingConfigModulePath = firstExisting("Odai routing configuration runtime", [
  resolve(pluginRoot, "runtime/routing-config.mjs"),
  resolve(pluginRoot, "../runtime/build/routing-config.mjs"),
]);
const sessionEvidenceModulePath = firstExisting("Odai session evidence runtime", [
  resolve(pluginRoot, "runtime/session-evidence.mjs"),
  resolve(pluginRoot, "../runtime/build/session-evidence.mjs"),
]);
const skillPath = firstExisting("canonical Odai skill", [
  resolve(pluginRoot, "skills/odai/SKILL.md"),
  resolve(repoRoot, "skills/odai/SKILL.md"),
]);
const dsh = process.env.DSH_BIN ?? "dsh";
const scratch = await mkdtemp(resolve(tmpdir(), "odai-dsh-load-"));
const patchPath = resolve(scratch, "odai.patch.yml");
const wrapperPath = resolve(scratch, "load-probe.mjs");
const markerPath = resolve(scratch, "loaded.marker");
const deniedWritePath = resolve(scratch, "must-not-be-written.txt");
const protectedWritePath = resolve(scratch, "protected-controller-must-not-write.txt");
const routingConfigPath = resolve(scratch, "home", "odai", "routing.json");
const sourceConfigPath = resolve(scratch, "home", "odai", "source.json");
const outputConfigPath = resolve(scratch, "home", "odai", "output.json");
const compactionConfigPath = resolve(scratch, "home", "odai", "compaction.json");
const sessionEvidenceRoot = resolve(scratch, "home", "odai", "session-evidence");

const yamlString = (value: string): string => JSON.stringify(value);
const wrapper = [
  "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
  `import { apply as applyOdai, inject, name } from ${JSON.stringify(pathToFileURL(pluginPath).href)};`,
  `import { createRoutingConfigTool } from ${JSON.stringify(pathToFileURL(routingConfigModulePath).href)};`,
  `import { createSessionEvidence } from ${JSON.stringify(pathToFileURL(sessionEvidenceModulePath).href)};`,
  `import { createResponsibilityScopeOwner } from ${JSON.stringify(pathToFileURL(resolve(dirname(pluginPath), "responsibility-scope.mjs")).href)};`,
  "export { inject, name };",
  "export function apply(ctx, config) {",
  "  if (typeof ctx.llm?.resolveCallConfig !== 'function') throw new Error('DSH did not expose llm.resolveCallConfig');",
  "  applyOdai(ctx, config);",
  "  const child = { session: { header: { origin: 'subagent', delegationDepth: 1 }, snapshotEvents() { return []; }, append() {} } };",
  "  const protectedController = { session: { header: {}, snapshotEvents() { return []; }, append() {} } };",
  `  const protectionEvidence = createSessionEvidence({ root: ${JSON.stringify(sessionEvidenceRoot)} });`,
  "  const scopeOwner = createResponsibilityScopeOwner({ appendEvent: (agent, type, data) => protectionEvidence.append(agent, type, data), events: (agent) => protectionEvidence.events(agent), routeProtections: new WeakMap() });",
  "  const probeRoute = { provider: 'probe-provider', model: 'read-only-planner' };",
  "  const probeScope = scopeOwner.start(protectedController, { turn: 1, startStep: 1, role: 'planner', route: probeRoute });",
  "  scopeOwner.claim(protectedController, probeScope, { step: 1, baseRoute: { provider: 'probe-provider', model: 'controller' }, temporaryRoute: probeRoute, routeMode: 'same-turn' });",
  "  const probes = [",
  `    { callId: 'odai-child-boundary-probe', path: ${JSON.stringify(deniedWritePath)}, agent: child, prefix: 'ODAI_SUBAGENT_BOUNDARY:' },`,
  `    { callId: 'odai-route-protection-probe', path: ${JSON.stringify(protectedWritePath)}, agent: protectedController, prefix: 'ODAI_HIGH_IMPACT_ROUTE_BLOCKED:' },`,
  "  ];",
  "  const guardsReady = Promise.all(probes.map((probe) => ctx.tools.execute({",
  "    callId: probe.callId,",
  "    name: 'write',",
  "    arguments: { file_path: probe.path, content: 'governance failed' },",
  "    agent: probe.agent,",
  "    signal: new AbortController().signal,",
  "  }).then((result) => {",
  "    if (!result.isError || !result.error.message.startsWith(probe.prefix)) {",
  "      throw new Error(`${probe.callId} was not denied by odai: ${JSON.stringify(result)}`);",
  "    }",
  "    if (existsSync(probe.path)) throw new Error(`${probe.callId} reached the write tool body`);",
  "  }))).finally(() => { scopeOwner.stop(protectedController, 'probe-completed'); scopeOwner.dispose(); });",
  "  const controllerEvents = [];",
  "  const controller = { session: { header: {}, snapshotEvents() { return controllerEvents; }, append(type, data) { controllerEvents.push({ type, data }); } } };",
  "  const routingTool = ctx.tools.get('odai_routing_config');",
  "  if (!routingTool) throw new Error('odai_routing_config was not registered');",
  `  const configProbe = createRoutingConfigTool(${JSON.stringify(routingConfigPath)}).execute({`,
  "    action: 'set', responsibility: 'reviewer', provider: 'probe-provider', model: 'probe-model', reasoningEffort: 'high',",
  "  }, { agent: controller }).then(() => {",
  `    const stored = JSON.parse(readFileSync(${JSON.stringify(routingConfigPath)}, 'utf8'));`,
  "    if (stored.roles?.reviewer?.provider !== 'probe-provider' || stored.roles?.reviewer?.model !== 'probe-model') {",
  "      throw new Error(`routing config was not persisted: ${JSON.stringify(stored)}`);",
  "    }",
  "    return routingTool.execute({ action: 'set', responsibility: 'frontend', provider: 'missing-provider', model: 'missing-model' }, { agent: controller }).then(",
  "      () => { throw new Error('registered routing config accepted an unavailable model route'); },",
  "      (error) => { if (!/NO_ADAPTER/u.test(String(error?.message ?? error))) throw error; },",
  "    );",
  "  });",
  "  const sourceTool = ctx.tools.get('odai_skill_source_config');",
  "  if (!sourceTool) throw new Error('odai_skill_source_config was not registered');",
  "  const sourceProbe = sourceTool.execute({ action: 'set', source: 'auto' }, { agent: controller }).then(() => {",
  `    const stored = JSON.parse(readFileSync(${JSON.stringify(sourceConfigPath)}, 'utf8'));`,
  "    if (stored.source !== 'auto') throw new Error(`skill source config was not persisted: ${JSON.stringify(stored)}`);",
  "  });",
  "  const evolutionTool = ctx.tools.get('odai_skill_evolution');",
  "  if (!evolutionTool) throw new Error('odai_skill_evolution was not registered');",
  "  const evolutionProbe = evolutionTool.execute({ action: 'show' }, { agent: controller }).then((result) => {",
  "    if (result.status !== 'disabled') throw new Error(`explicit skillPath did not bypass evolution: ${JSON.stringify(result)}`);",
  "  });",
  "  const outputTool = ctx.tools.get('odai_output_config');",
  "  if (!outputTool) throw new Error('odai_output_config was not registered');",
  "  const outputProbe = outputTool.execute({ action: 'set', concise: true, maxTokens: 2500 }, { agent: controller }).then(() => {",
  `    const stored = JSON.parse(readFileSync(${JSON.stringify(outputConfigPath)}, 'utf8'));`,
  "    if (stored.policy?.concise !== true || stored.policy?.maxTokens !== 2500) throw new Error(`output config was not persisted: ${JSON.stringify(stored)}`);",
  "  });",
  "  const compactionTool = ctx.tools.get('odai_compaction_config');",
  "  if (!compactionTool) throw new Error('odai_compaction_config was not registered');",
  "  const compactionProbe = compactionTool.execute({ action: 'set', provider: 'missing-provider', model: 'missing-summary', reasoningEffort: 'high' }, { agent: controller }).then(",
  "    () => { throw new Error('registered compaction config accepted an unavailable model route'); },",
  "    (error) => {",
  "      if (!/NO_ADAPTER/u.test(String(error?.message ?? error))) throw error;",
  `      if (existsSync(${JSON.stringify(compactionConfigPath)})) throw new Error('rejected compaction route mutated the config store');`,
  "    },",
  "  );",
  "  const memoryTool = ctx.tools.get('odai_memory');",
  "  if (!memoryTool) throw new Error('odai_memory was not registered');",
  "  const memoryProbe = memoryTool.execute({ action: 'inspect' }, { agent: controller }).then((result) => {",
  "    if (result.mode !== 'auto' || result.entries.length !== 0) throw new Error(`semantic memory inspect failed: ${JSON.stringify(result)}`);",
  "    return Promise.resolve().then(() => memoryTool.execute({ action: 'inspect' }, { agent: child })).then(",
  "      () => { throw new Error('semantic memory allowed child inspection'); },",
  "      (error) => { if (!/child agents may not inspect or change/u.test(String(error?.message ?? error))) throw error; },",
  "    );",
  "  });",
  "  const safetyTool = ctx.tools.get('odai_human_safety');",
  "  if (!safetyTool) throw new Error('odai_human_safety was not registered');",
  "  const safetyProbe = safetyTool.execute({}, { agent: controller }).then((result) => {",
  "    if (result.priority !== 'highest' || result.userChannelOwner !== 'current-controller' || typeof result.contract !== 'string') throw new Error(`human safety probe failed: ${JSON.stringify(result)}`);",
  "  });",
  "  const continuityTool = ctx.tools.get('odai_human_safety_continuity');",
  "  if (!continuityTool) throw new Error('odai_human_safety_continuity was not registered');",
  "  if (!continuityTool.output?.schema || typeof continuityTool.output?.render !== 'function') throw new Error('human safety continuity output contract is unavailable');",
  "  const continuityProbe = Promise.resolve().then(() => continuityTool.execute({ action: 'show' }, { agent: child })).then(",
  "    () => { throw new Error('human safety continuity allowed child inspection'); },",
  "    (error) => { if (!/child agents may not inspect or change/u.test(String(error?.message ?? error))) throw error; },",
  "  );",
  `  const reviewProbe = Promise.all([import(${JSON.stringify(pathToFileURL(resolve(dirname(pluginPath), "runtime-support.mjs")).href)}), import(${JSON.stringify(pathToFileURL(resolve(dirname(pluginPath), "review-evidence.mjs")).href)})]).then(async ([support, evidence]) => {`,
  "    const snapshot = evidence.createReviewEvidenceSnapshot([{ index: 1, source: 'tool', label: 'native capture', kinds: ['tool'], text: 'x'.repeat(9000) + 'UNTRUNCATED_TAIL' }]);",
  "    const parentSession = ctx.sessions.create(undefined, { meta: { cwd: process.cwd() } });",
  "    const parent = { id: parentSession.id, session: parentSession };",
  "    let reviewer;",
  "    const outcome = await support.runRoutedRole({ provider: 'probe', decision: { role: 'reviewer' }, taskText: 'Inspect the canonical Odai skill source and supplied immutable capture; execution-dependent acceptance remains unjudged.', roleContract: 'Read-only source inspection and immutable evidence retrieval; no shell, writes or further delegation.', agent: parent, signal: new AbortController().signal, reviewEvidence: snapshot,",
  "      subagents: { async start(_provider, request) {",
  "        const session = ctx.sessions.create(undefined, { meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.id, delegationDepth: 1 } });",
  "        session.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'probe', label: request.label });",
  "        reviewer = { id: session.id, session, options: {} };",
  "        const page = await ctx.tools.execute({ name: 'odai_review_evidence', callId: 'review-page', arguments: { digest: snapshot.digest, action: 'read', id: 'tool-event-1', offset: 9000 }, agent: reviewer, signal: new AbortController().signal });",
  "        if (page.isError || !JSON.stringify(page).includes('UNTRUNCATED_TAIL')) throw new Error(`native evidence paging failed: ${JSON.stringify(page)}`);",
  `        const source = await ctx.tools.execute({ name: 'read', callId: 'review-source-read', arguments: { file_path: ${JSON.stringify(skillPath)} }, agent: reviewer, signal: new AbortController().signal });`,
  "        if (source.isError || !JSON.stringify(source).includes('name: odai')) throw new Error(`reviewer source read failed: ${JSON.stringify(source)}`);",
  "        const unchanged = await ctx.tools.execute({ name: 'odai_review_evidence', callId: 'review-page-after-read', arguments: { digest: snapshot.digest, action: 'read', id: 'tool-event-1', offset: 9000 }, agent: reviewer, signal: new AbortController().signal });",
  "        if (unchanged.isError || !JSON.stringify(unchanged).includes('UNTRUNCATED_TAIL')) throw new Error('source read changed captured evidence');",
  "        const shells = ['bash', 'pwsh'].filter((name) => ctx.tools.get(name));",
  "        if (!shells.length) throw new Error('load probe needs a registered native shell');",
  `        const reviewerWritePath = ${JSON.stringify(`${deniedWritePath}.reviewer`)};`,
  "        const blocked = [{ name: 'write', arguments: { file_path: reviewerWritePath, content: 'reviewer escaped read-only scope' } }, ...shells.map((name) => ({ name, arguments: { command: 'exit 0', description: 'Check read-only reviewer boundary' } }))];",
  "        for (const attempt of blocked) {",
  "          const denied = await ctx.tools.execute({ ...attempt, callId: `review-denied-${attempt.name}`, agent: reviewer, signal: new AbortController().signal });",
  "          if (!denied.isError || !JSON.stringify(denied).includes('ODAI_REVIEW_READ_ONLY')) throw new Error(`reviewer ${attempt.name} escaped its execution guard: ${JSON.stringify(denied)}`);",
  "        }",
  "        if (existsSync(reviewerWritePath)) throw new Error('reviewer write reached the native tool body');",
  "        return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'verified' }] }), async dispose() {} };",
  "      } },",
  "    });",
  "    if (outcome.status !== 'completed') throw new Error(`managed evidence probe failed: ${JSON.stringify(outcome)}`);",
  "    const late = await ctx.tools.execute({ name: 'odai_review_evidence', callId: 'review-late', arguments: { digest: snapshot.digest, action: 'list' }, agent: reviewer, signal: new AbortController().signal });",
  "    if (!late.isError) throw new Error('disposed review retained evidence access');",
  "  });",
  "  Promise.all([guardsReady, configProbe, sourceProbe, evolutionProbe, outputProbe, compactionProbe, memoryProbe, safetyProbe, continuityProbe, reviewProbe]).then(() => {",
  `    writeFileSync(${JSON.stringify(markerPath)}, 'loaded-guarded-and-configured\\n', 'utf8');`,
  "  }).catch((error) => process.stderr.write(`odai load probe: ${error.stack ?? error}\\n`));",
  "}",
  "",
].join("\n");
const patch = [
  "- id: headless-runner",
  "  disabled: true",
  "- insert:",
  "    - id: odai-governance-probe",
  `      name: ${yamlString(pathToFileURL(wrapperPath).href)}`,
  "      config:",
  `        skillPath: ${yamlString(skillPath)}`,
  "",
].join("\n");

try {
  await Promise.all([
    writeFile(patchPath, patch, "utf8"),
    writeFile(wrapperPath, wrapper, "utf8"),
  ]);
  const child = spawnDsh(dsh, [
    "--profile",
    "headless",
    "--patch",
    patchPath,
    "odai load probe",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DSH_HOME: resolve(scratch, "home"),
      DSH_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.stdout || !child.stderr) throw new Error("DSH load probe requires piped stdout and stderr");
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  let output = "";
  let verified = false;
  const completed = new Promise<void>((accept, reject) => {
    const timeout = setTimeout(() => {
      terminateDsh(child);
      reject(new Error(`timed out waiting for odai plugin load marker\n${output}`));
    }, 30_000);
    const markerPoll = setInterval(() => {
      if (!existsSync(markerPath)) return;
      verified = true;
      terminateDsh(child);
    }, 50);

    const capture = (chunk: Buffer) => {
      output += chunk.toString();
    };
    childStdout.on("data", capture);
    childStderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timeout);
      clearInterval(markerPoll);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      clearInterval(markerPoll);
      verified ||= existsSync(markerPath);
      if (verified) {
        accept();
      } else {
        reject(new Error(`dsh exited before odai plugin loaded (code=${code}, signal=${signal})\n${output}`));
      }
    });
  });

  await completed;

  process.stdout.write(`dsh plugin load verified with ${dsh}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
