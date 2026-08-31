import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dshWebRpc, waitForDshWeb } from "../../../scripts/dsh-web-rpc.mjs";

interface ProbeResult extends Record<string, unknown> {
  canonicalSectionCount?: number;
  toolError?: string;
  writeReachedBody?: boolean;
  toolIsError?: boolean;
  toolExposureSynchronized?: boolean;
  routingProtected?: boolean;
}

interface ProbeResults extends Record<string, unknown> {
  probeError?: string;
  standard?: ProbeResult;
  odai?: ProbeResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new TypeError("expected a JSON object");
  return value;
}

const sourceAgentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = resolve(process.env.ODAI_AGENT_PACKAGE_ROOT ?? sourceAgentRoot);
const repoRoot = resolve(sourceAgentRoot, "../..");
const compiledPackage = process.env.ODAI_AGENT_PACKAGE_ROOT !== undefined;
const dshVersionModule: typeof import("../src/dsh-version.mjs") = await import(pathToFileURL(resolve(
  agentRoot,
  compiledPackage ? "build/src/dsh-version.mjs" : "src/dsh-version.mts",
)).href);
const installerModule: typeof import("../src/installer.mjs") = await import(pathToFileURL(resolve(
  agentRoot,
  compiledPackage ? "build/src/installer.mjs" : "src/installer.mts",
)).href);
const { spawnDsh } = dshVersionModule;
const { installAgentPreset, renderAgentCompositionForDsh, SUPPORTED_DSH_VERSIONS } = installerModule;
const dsh = process.env.DSH_BIN ?? "dsh";
const dshRoot = process.env.DSH_PACKAGE_ROOT
  ? resolve(process.env.DSH_PACKAGE_ROOT)
  : findDshPackageRoot(dsh);
const requireFromDsh = createRequire(resolve(dshRoot, "package.json"));
const scopeModule = requireFromDsh.resolve("@deepseek-ai/dsh-scope");
const targetDshVersion = await verifyPinnedComposition();
const scratch = await mkdtemp(resolve(tmpdir(), "odai-agent-scope-"));
const home = resolve(scratch, "home");
const workspace = resolve(scratch, "workspace");
const sourceRoot = resolve(scratch, "source-preset");
const markerPath = resolve(scratch, "scope-results.json");
const probePluginPath = resolve(scratch, "scope-probe-plugin.mjs");
const patchPath = resolve(scratch, "scope-probe.patch.yml");

const yaml = (value: string): string => JSON.stringify(value);

function findDshPackageRoot(command: string): string {
  const locator = process.platform === "win32" ? "where" : "which";
  const located = existsSync(command)
    ? [resolve(command)]
    : execFileSync(locator, [command], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
  const candidates = new Set<string>();
  for (const path of located) {
    const commandDir = dirname(realpathSync(path));
    candidates.add(commandDir);
    candidates.add(resolve(commandDir, "node_modules/@deepseek-ai/dsh"));
    candidates.add(resolve(commandDir, "../@deepseek-ai/dsh"));
  }
  for (const candidate of candidates) {
    let current = candidate;
    for (;;) {
      try {
        const metadata = parseRecord(readFileSync(resolve(current, "package.json"), "utf8"));
        if (metadata.name === "@deepseek-ai/dsh") return current;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`cannot locate the @deepseek-ai/dsh package behind ${command}`);
}

async function verifyPinnedComposition(): Promise<string> {
  const dshMetadata = parseRecord(await readFile(resolve(dshRoot, "package.json"), "utf8"));
  if (typeof dshMetadata.version !== "string") throw new Error("DSH package version is invalid");
  if (!SUPPORTED_DSH_VERSIONS.includes(dshMetadata.version)) {
    throw new Error(`agent preset expects one of ${SUPPORTED_DSH_VERSIONS.join(", ")}, found ${dshMetadata.version}`);
  }

  const legacyStandardPath = resolve(dshRoot, "config/agent-presets/standard/agent.cordis.yml");
  const standardPath = process.env.DSH_STANDARD_COMPOSITION
    ?? (existsSync(legacyStandardPath)
      ? legacyStandardPath
      : resolve(dirname(dirname(dshRoot)), "@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml"));
  const standard = (await readFile(standardPath, "utf8")).replace(/\r\n/gu, "\n");
  const odaiSuffix = [
    "# Odai contributes scoped prompt, guard, routing, user-owned responsibility",
    "# mappings, and evidence listeners. Base controller selection stays host-owned.",
    "- id: odai-governance",
    "  name: ./runtime/index.mjs",
    "  config:",
    "    routing:",
    "      mode: auto",
    "      provider: spawn",
  ].join("\n");
  const expected = `${standard
    .replace(
      "# The preset's own persona, shadowing the deployment default for this agent.\n# `{{model}}` and `{{cwd}}` resolve from the agent's own route and workspace.",
      "# The preset's own model-neutral persona shadows the deployment default. Auto\n# routing can upgrade after prompt assembly; `{{cwd}}` remains workspace-local.",
    )
    .replace(
      "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
      "You are Odai, a coding agent. Your working directory is {{cwd}}.",
    )
    .trimEnd()}\n\n${odaiSuffix}`;
  const actual = renderAgentCompositionForDsh(
    await readFile(resolve(agentRoot, "preset/odai/agent.cordis.yml"), "utf8"),
    dshMetadata.version,
  ).trimEnd();
  if (actual !== expected) {
    throw new Error(`Odai Agent composition drifted from the DSH ${dshMetadata.version} standard preset`);
  }
  return dshMetadata.version;
}

async function freePort(): Promise<number> {
  return await new Promise<number>((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port === undefined) reject(new Error("server did not expose a TCP port"));
        else accept(port);
      });
    });
  });
}

async function waitForMarker(child: ChildProcess, output: () => string): Promise<ProbeResults> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return parseRecord(await readFile(markerPath, "utf8"));
    if (child.exitCode !== null) throw new Error(`dsh web exited before probe completed (${child.exitCode})\n${output()}`);
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error(`timed out waiting for scope marker\n${output()}`);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  } else if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  await new Promise<void>((accept) => {
    if (child.exitCode !== null) return accept();
    const timeout = setTimeout(() => { child.kill("SIGKILL"); accept(); }, 3_000);
    child.once("exit", () => { clearTimeout(timeout); accept(); });
  });
}

await mkdir(workspace, { recursive: true });
await cp(resolve(agentRoot, "preset/odai"), sourceRoot, { recursive: true });
const developmentRuntime = resolve(repoRoot, "dsh/runtime/build");
const developmentSkill = resolve(repoRoot, "skills/odai");
if (existsSync(developmentRuntime) && existsSync(developmentSkill)) {
  await Promise.all([
    cp(developmentRuntime, resolve(sourceRoot, "runtime"), { recursive: true }),
    cp(developmentSkill, resolve(sourceRoot, "skills/odai"), { recursive: true }),
  ]);
} else if (!existsSync(resolve(sourceRoot, "runtime/index.mjs"))
  || !existsSync(resolve(sourceRoot, "skills/odai/SKILL.md"))) {
  throw new Error("Odai Agent verification requires either repository sources or packaged runtime and skill files");
}
await installAgentPreset({ dshHome: home, sourceRoot, dshVersion: targetDshVersion });

const probePlugin = `import { existsSync, writeFileSync } from "node:fs";\nimport { bindScopeParent } from ${JSON.stringify(pathToFileURL(scopeModule).href)};\n\nexport const name = "odai-agent-scope-probe";\nexport const inject = ["systemPrompt", "tools"];\n\nexport function apply(ctx, config) {\n  const results = {};\n  let writing = Promise.resolve();\n\n  ctx.on("agent/created", ({ agent }) => {\n    writing = writing.then(async () => {\n      const preset = agent.session?.header?.agentPreset;\n      if (preset !== "standard" && preset !== "odai") return;\n\n      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });\n      const canonicalSections = assembly.sections.filter((section) => section.name === "odai:canonical-governance");\n      if (preset === "odai") {\n        const coldNames = assembly.tools.map((tool) => tool.name).filter((toolName) => toolName.startsWith("odai_")).sort();\n        const expectedColdNames = ["odai_context_capability", "odai_reference", "odai_responsibility_gap"];\n        if (JSON.stringify(coldNames) !== JSON.stringify(expectedColdNames)) {\n          throw new Error(\`cold Odai tool schema mismatch: \${JSON.stringify(coldNames)}\`);\n        }\n        const hiddenResult = await ctx.tools.execute({\n          callId: "scope-probe-odai-hidden-routing",\n          name: "odai_routing_config",\n          arguments: { action: "show" },\n          agent,\n          signal: new AbortController().signal,\n        });\n        if (!hiddenResult.isError || !/unknown tool/u.test(hiddenResult.error?.message ?? "")) {\n          throw new Error(\`hidden Odai routing tool remained executable: \${JSON.stringify(hiddenResult)}\`);\n        }\n        agent.session.append("turn/start", { turn: 1 });\n        agent.session.append("step/start", { turn: 1, step: 1 });\n        const gatewayResult = await ctx.tools.execute({\n          callId: "scope-probe-odai-routing-gateway",\n          name: "odai_context_capability",\n          arguments: { capability: "routing-config" },\n          agent,\n          signal: new AbortController().signal,\n        });\n        if (gatewayResult.isError) throw new Error(\`Odai capability gateway failed: \${JSON.stringify(gatewayResult)}\`);\n        const activatedAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent });\n        const activatedNames = activatedAssembly.tools.map((tool) => tool.name).filter((toolName) => toolName.startsWith("odai_")).sort();\n        const expectedActivatedNames = ["odai_context_capability", "odai_reference", "odai_responsibility_gap", "odai_routing_config"].sort();\n        if (JSON.stringify(activatedNames) !== JSON.stringify(expectedActivatedNames)) {\n          throw new Error(\`activated Odai tool schema mismatch: \${JSON.stringify(activatedNames)}\`);\n        }\n      }\n      const writePath = preset === "odai" ? config.odaiWritePath : config.standardWritePath;\n      const childSession = new Proxy(agent.session, {\n        get(target, property) {\n          if (property === "header") {\n            return { ...target.header, origin: "subagent", delegationDepth: 1 };\n          }\n          return Reflect.get(target, property, target);\n        },\n      });\n      const child = { id: agent.id, session: childSession };\n      bindScopeParent(child, agent);\n      const toolResult = await ctx.tools.execute({\n        callId: \`scope-probe-\${preset}\`,\n        name: "write",\n        arguments: { file_path: writePath, content: \`\${preset} child write reached body\\n\` },\n        agent: child,\n        signal: new AbortController().signal,\n      });\n\n      let routingProtected;\n      if (preset === "odai") {\n        const routingResult = await ctx.tools.execute({\n          callId: "scope-probe-odai-routing-config",\n          name: "odai_routing_config",\n          arguments: { action: "set", responsibility: "planner", provider: "probe-provider", model: "probe-planner", reasoningEffort: "high" },\n          agent,\n          signal: new AbortController().signal,\n        });\n        routingProtected = routingResult.isError === true\n          && /NO_ADAPTER/u.test(routingResult.error?.message ?? "")\n          && !existsSync(config.routingConfigPath);\n      }\n\n      results[preset] = {\n        canonicalSectionCount: canonicalSections.length,\n        toolIsError: toolResult.isError === true,\n        toolError: toolResult.isError === true ? toolResult.error?.message : undefined,\n        writeReachedBody: existsSync(writePath),\n        ...(routingProtected === undefined ? {} : { routingProtected }),\n        ...(preset === "odai" ? { toolExposureSynchronized: true } : {}),\n      };\n      if (results.standard && results.odai) {\n        writeFileSync(config.markerPath, JSON.stringify(results, null, 2) + "\\n", "utf8");\n      }\n    }).catch((error) => {\n      writeFileSync(config.markerPath, JSON.stringify({ probeError: error?.stack ?? String(error) }, null, 2) + "\\n", "utf8");\n    });\n  }, { global: true });\n}\n`;
await writeFile(probePluginPath, probePlugin, "utf8");
await writeFile(patchPath, [
  "- insert:",
  "    - id: odai-agent-scope-probe",
  `      name: ${yaml(pathToFileURL(probePluginPath).href)}`,
  "      config:",
  `        markerPath: ${yaml(markerPath)}`,
  `        standardWritePath: ${yaml(resolve(workspace, "standard-child-write.txt"))}`,
  `        odaiWritePath: ${yaml(resolve(workspace, "odai-child-write.txt"))}`,
  `        routingConfigPath: ${yaml(resolve(home, "odai/routing.json"))}`,
  "",
].join("\n"), "utf8");

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawnDsh(dsh, [
  "--profile", "web",
  "--patch", patchPath,
  "--no-open",
  "--host", "127.0.0.1",
  "--port", String(port),
], {
  cwd: workspace,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_MODE: "DISABLED",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
if (!child.stdout || !child.stderr) throw new Error("DSH verification requires piped stdout and stderr");
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });
const capturedOutput = () => output;

try {
  const browserCookie = await waitForDshWeb(baseUrl, child, capturedOutput);
  const roster = await dshWebRpc(baseUrl, "agentPreset.list", {}, browserCookie);
  if (!isRecord(roster) || !Array.isArray(roster.presets)) throw new Error("agent preset roster is malformed");
  const ids = roster.presets.map((preset: unknown) => {
    if (!isRecord(preset) || typeof preset.id !== "string") throw new Error("agent preset entry is malformed");
    return preset.id;
  });
  if (!ids.includes("standard") || !ids.includes("odai")) {
    throw new Error(`expected standard and odai presets, got ${JSON.stringify(ids)}`);
  }
  await dshWebRpc(baseUrl, "session.create", { cwd: workspace, agentPreset: "standard" }, browserCookie);
  await dshWebRpc(baseUrl, "session.create", { cwd: workspace, agentPreset: "odai" }, browserCookie);
  const results = await waitForMarker(child, capturedOutput);
  if (results.probeError) throw new Error(results.probeError);
  if (results.standard?.canonicalSectionCount !== 0) {
    throw new Error(`standard saw odai canonical prompt: ${JSON.stringify(results)}`);
  }
  if (results.standard?.toolError?.startsWith("ODAI_SUBAGENT_BOUNDARY:")) {
    throw new Error(`standard child call reached the odai guard: ${JSON.stringify(results)}`);
  }
  if (results.odai?.canonicalSectionCount !== 1) {
    throw new Error(`odai canonical prompt count was not exactly one: ${JSON.stringify(results)}`);
  }
  if (results.odai?.writeReachedBody !== false || results.odai?.toolIsError !== true
    || !results.odai?.toolError?.startsWith("ODAI_SUBAGENT_BOUNDARY:")) {
    throw new Error(`odai child write was not denied by odai guard: ${JSON.stringify(results)}`);
  }
  if (results.odai?.toolExposureSynchronized !== true) {
    throw new Error(`odai tool schemas and execution visibility were not synchronized: ${JSON.stringify(results)}`);
  }
  if (results.odai?.routingProtected !== true) {
    throw new Error(`odai routing tool did not reject an unavailable route without mutation: ${JSON.stringify(results)}`);
  }
  process.stdout.write(`${JSON.stringify({ scratch, roster: ids, results }, null, 2)}\n`);
} finally {
  await terminateChild(child);
  if (process.env.KEEP_ODAI_SCOPE_PROBE !== "1") {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
