import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installAgentPreset } from "../dsh/agent/build/src/installer.mjs";
import { readDshVersion, spawnDsh } from "../dsh/agent/build/src/dsh-version.mjs";
import { dshWebRpc, waitForDshWeb } from "./dsh-web-rpc.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(repoRoot, "dsh/plugin");
const agentRoot = resolve(repoRoot, "dsh/agent");
const runtimeRoot = resolve(repoRoot, "dsh/runtime/build");
const canonicalSkillRoot = resolve(repoRoot, "skills/odai");
const sharedStateModule = resolve(runtimeRoot, "skill-selection-state.mjs");
const dsh = process.env.DSH_BIN ?? (process.platform === "win32" ? "dsh.cmd" : "dsh");
const targetDshVersion = readDshVersion({ dsh });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const scratch = await mkdtemp(resolve(tmpdir(), "odai-dsh-coexistence-"));
const home = resolve(scratch, "home");
const workspace = resolve(scratch, "workspace");
const sourcePreset = resolve(scratch, "source-preset");
const markerPath = resolve(scratch, "coexistence-results.json");
const probePluginPath = resolve(scratch, "coexistence-probe.mjs");
const patchPath = resolve(scratch, "coexistence.patch.yml");
const globalSourcePath = resolve(scratch, "global-source.json");
const profileName = "web";
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_MODE: "DISABLED",
  DSH_TELEMETRY_DISABLED: "1",
};
const yaml = (value) => JSON.stringify(value);
let child;
let output = "";
let finalReport;
let bundledSkillVersion;
let projectSkillVersion;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? env,
    encoding: options.encoding,
    stdio: options.stdio ?? "inherit",
    shell: process.platform === "win32",
  });
}

async function freePort() {
  return await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : accept(port));
    });
  });
}

async function waitForMarker() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) return JSON.parse(await readFile(markerPath, "utf8"));
    if (child.exitCode !== null) throw new Error(`dsh web exited before coexistence probe completed (${child.exitCode})\n${output}`);
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error(`timed out waiting for coexistence marker\n${output}`);
}

async function terminateChild() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((accept) => {
    if (child.exitCode !== null) return accept();
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      accept();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      accept();
    });
  });
}

async function prepareProjectSkill() {
  const target = resolve(workspace, ".dsh/skills/odai");
  await mkdir(resolve(workspace, ".git"), { recursive: true });
  await cp(canonicalSkillRoot, target, { recursive: true });
  const manifestPath = resolve(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = String(manifest.skillVersion).match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!version) throw new Error(`canonical skillVersion is not a stable SemVer: ${String(manifest.skillVersion)}`);
  bundledSkillVersion = manifest.skillVersion;
  projectSkillVersion = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
  manifest.skillVersion = projectSkillVersion;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const skillPath = resolve(target, "SKILL.md");
  const plannerPath = resolve(target, "assets/routing-roles/planner.md");
  await writeFile(
    skillPath,
    `${(await readFile(skillPath, "utf8")).trimEnd()}\n\nCOEXISTENCE_SKILL_MARKER\n`,
    "utf8",
  );
  await writeFile(
    plannerPath,
    `${(await readFile(plannerPath, "utf8")).trimEnd()}\n\nCOEXISTENCE_PLANNER_MARKER\n`,
    "utf8",
  );
}

async function prepareAgent() {
  await cp(resolve(agentRoot, "preset/odai"), sourcePreset, { recursive: true });
  await Promise.all([
    cp(runtimeRoot, resolve(sourcePreset, "runtime"), { recursive: true }),
    cp(canonicalSkillRoot, resolve(sourcePreset, "skills/odai"), { recursive: true }),
  ]);
  await installAgentPreset({ dshHome: home, sourceRoot: sourcePreset, dshVersion: targetDshVersion });
}

async function installPlugin() {
  run(npm, ["pack", "--pack-destination", scratch], { cwd: pluginRoot });
  const tarballs = (await readdir(scratch)).filter((entry) => /^odai-dsh-plugin-.*\.tgz$/u.test(entry));
  if (tarballs.length !== 1) throw new Error(`expected one Plugin tarball, found: ${tarballs.join(", ")}`);
  const tarball = resolve(scratch, tarballs[0]);
  run(dsh, ["plugin", "--profile", profileName, "add", tarball], { cwd: workspace });

  const profilePath = resolve(home, "profiles", profileName, "package.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  if (!profile.dsh?.profile?.bundles?.includes("odai-dsh-plugin")) {
    throw new Error(`Plugin was installed but not activated as a profile bundle: ${JSON.stringify(profile)}`);
  }
}

async function installAgentControlCenterPackage() {
  run(npm, ["pack", "--pack-destination", scratch], { cwd: agentRoot });
  const tarballs = (await readdir(scratch)).filter((entry) => /^odai-dsh-agent-.*\.tgz$/u.test(entry));
  if (tarballs.length !== 1) throw new Error(`expected one Agent tarball, found: ${tarballs.join(", ")}`);
  run(dsh, ["plugin", "--profile", profileName, "add", resolve(scratch, tarballs[0])], { cwd: workspace });

  const profilePath = resolve(home, "profiles", profileName, "package.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  for (const packageName of ["odai-dsh-plugin", "odai-dsh-agent"]) {
    if (typeof profile.dependencies?.[packageName] !== "string"
      || !profile.dsh?.profile?.bundles?.includes(packageName)) {
      throw new Error(`coexistence profile does not own ${packageName} completely: ${JSON.stringify(profile)}`);
    }
  }
}

async function readControlCenterBoot(baseUrl, browserCookie) {
  const response = await fetch(baseUrl, {
    headers: browserCookie ? { cookie: browserCookie } : {},
  });
  if (!response.ok) throw new Error(`Control Center boot fetch failed: HTTP ${response.status}`);
  const html = await response.text();
  const match = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\});?\s*<\/script>/su);
  if (!match) throw new Error("DSH Web boot payload is missing");
  const boot = JSON.parse(match[1]);
  const odaiEntries = (boot.entries ?? []).filter((entry) => entry.id === "odai-dsh-plugin" || entry.id === "odai-dsh-agent");
  const ids = odaiEntries.map((entry) => entry.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(["odai-dsh-agent", "odai-dsh-plugin"])) {
    throw new Error(`coexistence boot graph does not contain both clients exactly once: ${JSON.stringify(ids)}`);
  }
  return ids;
}

async function probeControlCenterRpc(baseUrl, browserCookie) {
  const rpcId = randomUUID();
  const response = await fetch(`${baseUrl}/odai-control-center/routing`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(browserCookie ? { cookie: browserCookie } : {}),
    },
    body: JSON.stringify({ type: "client-request", rpcId, method: "routing", payload: { action: "show" } }),
  });
  const body = await response.json();
  if (!response.ok || body.rpcId !== rpcId || body.result?.ok !== true) {
    throw new Error(`coexistence Control Center RPC failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
}

async function prepareProbe() {
  const probe = `import { writeFileSync } from "node:fs";\nimport { sharedSkillSelection } from ${JSON.stringify(pathToFileURL(sharedStateModule).href)};\n\nexport const name = "odai-coexistence-probe";\nexport const inject = ["systemPrompt", "tools"];\n\nexport function apply(ctx, config) {\n  const results = {};\n  let writing = Promise.resolve();\n  ctx.on("agent/created", ({ agent }) => {\n    writing = writing.then(async () => {\n      const preset = agent.session?.header?.agentPreset;\n      if (preset !== "standard" && preset !== "odai") return;\n      const signal = new AbortController().signal;\n      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal });\n      const coldNames = assembly.tools.map((tool) => tool.name).filter((toolName) => toolName.startsWith("odai_")).sort();\n      const expectedColdNames = ["odai_context_capability", "odai_reference", "odai_responsibility_gap"];\n      if (JSON.stringify(coldNames) !== JSON.stringify(expectedColdNames)) {\n        throw new Error(\`cold Odai tool schema mismatch for \${preset}: \${JSON.stringify(coldNames)}\`);\n      }\n      const hiddenResult = await ctx.tools.execute({\n        callId: \`coexistence-hidden-routing-\${preset}\`,\n        name: "odai_routing_config",\n        arguments: { action: "show" },\n        agent,\n        signal,\n      });\n      if (!hiddenResult.isError || !/unknown tool/u.test(hiddenResult.error?.message ?? "")) {\n        throw new Error(\`hidden Odai routing tool remained executable for \${preset}: \${JSON.stringify(hiddenResult)}\`);\n      }\n      agent.session.append("turn/start", { turn: 1 });\n      agent.session.append("step/start", { turn: 1, step: 1 });\n      const gatewayResult = await ctx.tools.execute({\n        callId: \`coexistence-routing-gateway-\${preset}\`,\n        name: "odai_context_capability",\n        arguments: { capability: "routing-config" },\n        agent,\n        signal,\n      });\n      if (gatewayResult.isError) throw new Error(\`Odai capability gateway failed for \${preset}: \${JSON.stringify(gatewayResult)}\`);\n      const activatedAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal });\n      const activatedNames = activatedAssembly.tools.map((tool) => tool.name).filter((toolName) => toolName.startsWith("odai_")).sort();\n      const expectedActivatedNames = ["odai_context_capability", "odai_reference", "odai_responsibility_gap", "odai_routing_config"].sort();\n      if (JSON.stringify(activatedNames) !== JSON.stringify(expectedActivatedNames)) {\n        throw new Error(\`activated Odai tool schema mismatch for \${preset}: \${JSON.stringify(activatedNames)}\`);\n      }\n      const routingResult = await ctx.tools.execute({\n        callId: \`coexistence-visible-routing-\${preset}\`,\n        name: "odai_routing_config",\n        arguments: { action: "show" },\n        agent,\n        signal,\n      });\n      if (routingResult.isError) throw new Error(\`visible Odai routing tool was not executable for \${preset}: \${JSON.stringify(routingResult)}\`);\n      const canonical = activatedAssembly.sections.filter((section) => section.name === "odai:canonical-governance");\n      const selection = sharedSkillSelection(agent);\n      const text = canonical[0]?.text ?? "";\n      const promptDigest = text.match(/digest: ([a-f0-9]{64})\\./u)?.[1];\n      results[preset] = {\n        canonicalSectionCount: canonical.length,\n        mode: selection?.mode,\n        source: selection?.bundle?.source,\n        skillVersion: selection?.bundle?.manifest?.skillVersion,\n        digest: selection?.bundle?.digest,\n        promptDigest,\n        promptHasProjectMarker: text.includes("COEXISTENCE_SKILL_MARKER"),\n        roleHasProjectMarker: selection?.bundle?.roleContracts?.planner?.includes("COEXISTENCE_PLANNER_MARKER") === true,\n        toolExposureSynchronized: true,\n      };\n      if (results.standard && results.odai) writeFileSync(config.markerPath, JSON.stringify(results, null, 2) + "\\n", "utf8");\n    }).catch((error) => {\n      writeFileSync(config.markerPath, JSON.stringify({ probeError: error.stack ?? String(error) }, null, 2) + "\\n", "utf8");\n    });\n  });\n}\n`;
  await writeFile(probePluginPath, probe, "utf8");
  await writeFile(patchPath, [
    "- id: odai-governance",
    "  config:",
    "    routing:",
    "      mode: off",
    "      provider: spawn",
    "    governance:",
    "      skillSource: bundled",
    `      skillConfigPath: ${yaml(globalSourcePath)}`,
    "- insert:",
    "    - id: odai-coexistence-probe",
    `      name: ${yaml(pathToFileURL(probePluginPath).href)}`,
    "      config:",
    `        markerPath: ${yaml(markerPath)}`,
    "",
  ].join("\n"), "utf8");
}

function assertResults(results) {
  if (results.probeError) throw new Error(results.probeError);
  const standard = results.standard;
  const odai = results.odai;
  if (standard?.canonicalSectionCount !== 1
    || standard.mode !== "bundled"
    || standard.source !== "bundled"
    || standard.skillVersion !== bundledSkillVersion
    || standard.promptHasProjectMarker !== false
    || standard.roleHasProjectMarker !== false
    || standard.toolExposureSynchronized !== true
    || standard.promptDigest !== standard.digest) {
    throw new Error(`global Plugin did not remain on bundled governance: ${JSON.stringify(results)}`);
  }
  if (odai?.canonicalSectionCount !== 1
    || odai.mode !== "auto"
    || odai.source !== "project-dsh"
    || odai.skillVersion !== projectSkillVersion
    || odai.promptHasProjectMarker !== true
    || odai.roleHasProjectMarker !== true
    || odai.toolExposureSynchronized !== true
    || odai.promptDigest !== odai.digest) {
    throw new Error(`Agent-scoped project selection did not atomically override the global Plugin: ${JSON.stringify(results)}`);
  }
}

try {
  await mkdir(workspace, { recursive: true });
  await prepareProjectSkill();
  await prepareAgent();
  await mkdir(resolve(home, "odai"), { recursive: true });
  await writeFile(
    resolve(home, "odai/source.json"),
    `${JSON.stringify({ schemaVersion: 1, source: "auto" }, null, 2)}\n`,
    "utf8",
  );
  await installPlugin();
  await installAgentControlCenterPackage();
  await prepareProbe();

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawnDsh(dsh, [
    "--profile", profileName,
    "--patch", patchPath,
    "--no-open",
    "--host", "127.0.0.1",
    "--port", String(port),
  ], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const browserCookie = await waitForDshWeb(baseUrl, child, () => output, 30_000);
  const controlCenterClientIds = await readControlCenterBoot(baseUrl, browserCookie);
  await probeControlCenterRpc(baseUrl, browserCookie);
  const roster = await dshWebRpc(baseUrl, "agentPreset.list", {}, browserCookie);
  const presetIds = roster.presets.map((preset) => preset.id);
  if (!presetIds.includes("standard") || !presetIds.includes("odai")) {
    throw new Error(`expected standard and odai presets, got ${JSON.stringify(presetIds)}`);
  }
  await dshWebRpc(baseUrl, "session.create", { cwd: workspace, agentPreset: "standard" }, browserCookie);
  await dshWebRpc(baseUrl, "session.create", { cwd: workspace, agentPreset: "odai" }, browserCookie);
  const results = await waitForMarker();
  assertResults(results);
  finalReport = {
    profilePluginInstalled: true,
    profileAgentControlCenterInstalled: true,
    agentPresetInstalled: true,
    controlCenterClientIds,
    controlCenterRpcAvailable: true,
    presetIds,
    results,
  };
  process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
} finally {
  await terminateChild();
  if (process.env.KEEP_ODAI_COEXISTENCE_PROBE !== "1") {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else {
    process.stderr.write(`kept coexistence probe at ${scratch}\n`);
  }
}
