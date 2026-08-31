#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { delimiter, dirname, extname, resolve } from "node:path";
import { emitCanaryIsolation } from "./canary-isolation.mjs";
import { observeProviderOutputCeiling } from "./dsh-output-budget-observation.mjs";
import { dshWebRpc, waitForDshWeb } from "./dsh-web-rpc.mjs";

const args = parseArgs(process.argv.slice(2));
emitCanaryIsolation("dsh");
const sourceHome = resolve(args.sourceHome);
const sourceSettings = resolve(sourceHome, "settings.yaml");
const sourceCredentials = resolve(sourceHome, ".credentials.yaml");

if (!existsSync(sourceSettings)) throw new Error(`dsh settings not found: ${sourceSettings}`);
if (!existsSync(sourceCredentials)) throw new Error(`dsh credentials not found: ${sourceCredentials}`);

const scratch = await mkdtemp(resolve(tmpdir(), "odai-dsh-canary-"));
const dshHome = resolve(scratch, "home");
const sessionRoot = resolve(scratch, "sessions");
const evidenceRoot = resolve(dshHome, "odai", "session-evidence");
const patchPath = resolve(scratch, "session.patch.yml");

try {
  if (args.profileHome) await cp(resolve(args.profileHome), dshHome, { recursive: true });
  else await mkdir(dshHome, { recursive: true });
  await rm(resolve(dshHome, "odai"), { recursive: true, force: true });

  const sourceSettingsText = await readFile(sourceSettings, "utf8");
  let settings = selectController(sourceSettingsText, {
    provider: args.provider,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
  });
  if (args.surface === "agent") settings = selectAgentPreset(settings, args.agentPreset);
  await writeFile(resolve(dshHome, "settings.yaml"), settings, "utf8");
  await copyFile(sourceCredentials, resolve(dshHome, ".credentials.yaml"));

  if (args.surface === "agent") {
    const compositionPath = resolve(dshHome, ".agent-presets", args.agentPreset, "agent.cordis.yml");
    const composition = await readFile(compositionPath, "utf8");
    await writeFile(compositionPath, configureAgentRouting(composition, args), "utf8");
  }
  const outputRoot = resolve(dshHome, "odai");
  await mkdir(outputRoot, { recursive: true });
  await writeFile(resolve(outputRoot, "output.json"), `${JSON.stringify({
    schemaVersion: 1,
    policy: {
      concise: args.outputConcise,
      ...(args.controllerMaxTokens === undefined ? {} : { maxTokens: args.controllerMaxTokens }),
    },
  }, null, 2)}\n`, "utf8");

  const patch = [
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${JSON.stringify(sessionRoot)}`,
    "    compression: none",
    "    packChunks: false",
  ];
  if (args.surface === "plugin") {
    patch.push(
      "- id: odai-governance",
      "  config:",
      "    routing:",
      `      mode: ${args.routingMode}`,
      "      provider: spawn",
      "      roles:",
      "        planner:",
      `          provider: ${JSON.stringify(args.plannerProvider)}`,
      `          model: ${JSON.stringify(args.plannerModel)}`,
      `          reasoningEffort: ${JSON.stringify(args.plannerReasoningEffort)}`,
      `          maxTokens: ${args.plannerMaxTokens}`,
    );
  } else if (args.surface === "source-plugin") {
    const roles = [
      ...(args.researcherProvider ? [{
        name: "researcher",
        provider: args.researcherProvider,
        model: args.researcherModel,
        reasoningEffort: args.researcherReasoningEffort,
        maxTokens: args.researcherMaxTokens,
      }] : []),
      ...(args.frontendProvider ? [{
        name: "frontend",
        provider: args.frontendProvider,
        model: args.frontendModel,
        reasoningEffort: args.frontendReasoningEffort,
        maxTokens: args.frontendMaxTokens,
      }] : [{
        name: "planner",
        provider: args.plannerProvider,
        model: args.plannerModel,
        reasoningEffort: args.plannerReasoningEffort,
        maxTokens: args.plannerMaxTokens,
      }]),
    ];
    patch.push(
      "- insert:",
      "    - id: odai-governance-canary-source",
      `      name: ${JSON.stringify(resolve(args.runtimePluginPath))}`,
      "      config:",
      `        skillPath: ${JSON.stringify(resolve(args.runtimeSkillPath))}`,
      "        routing:",
      `          mode: ${args.routingMode}`,
      "          provider: spawn",
      "          roles:",
      ...roles.flatMap((role) => [
        `            ${role.name}:`,
        `              provider: ${JSON.stringify(role.provider)}`,
        `              model: ${JSON.stringify(role.model)}`,
        ...(role.reasoningEffort ? [`              reasoningEffort: ${JSON.stringify(role.reasoningEffort)}`] : []),
        ...(role.maxTokens === undefined ? [] : [`              maxTokens: ${role.maxTokens}`]),
      ]),
    );
  }
  patch.push("");
  await writeFile(patchPath, patch.join("\n"), "utf8");

  let prompt = (await readFile(resolve(args.promptFile), "utf8")).trim();
  if (args.controllerEmbedsSkill) {
    const treatment = /^Use the odai skill at `[^`]+` to handle the user request below\. Read that SKILL\.md completely before taking task actions\./u;
    if (!treatment.test(prompt)) throw new Error("embedded-skill runner prompt did not contain the expected treatment preface");
    const surface = args.surface === "agent" ? "Agent preset" : "plugin";
    prompt = prompt.replace(
      treatment,
      `The installed odai DSH ${surface} already embeds the complete canonical skill. Apply it directly; do not reread that same SKILL.md.`,
    );
  }
  const processOptions = {
    cwd: resolve(args.cwd),
    timeoutMs: args.timeoutMs,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: "DISABLED",
    },
  };
  const agentCompositionPath = resolve(dshHome, ".agent-presets", args.agentPreset, "agent.cordis.yml");
  const run = args.preflight
    ? {
      code: 0,
      signal: null,
      stdout: JSON.stringify({
        settings: await readFile(resolve(dshHome, "settings.yaml"), "utf8"),
        patch: await readFile(patchPath, "utf8"),
        hasAgent: existsSync(agentCompositionPath),
        agentComposition: existsSync(agentCompositionPath) ? await readFile(agentCompositionPath, "utf8") : "",
        hasGlobalPlugin: existsSync(resolve(dshHome, "profiles/headless/node_modules/odai-dsh-plugin/runtime/index.mjs")),
        outputPolicy: existsSync(resolve(dshHome, "odai", "output.json"))
          ? JSON.parse(await readFile(resolve(dshHome, "odai", "output.json"), "utf8"))
          : null,
      }),
      stderr: "",
    }
    : args.surface === "agent"
      ? await runWebAgent(args.dshBin, patchPath, prompt, args, processOptions)
      : await runProcess(args.dshBin, [
        "--profile",
        "headless",
        "--patch",
        patchPath,
        prompt,
      ], processOptions);

  const sessions = await readSessions(sessionRoot, evidenceRoot);
  const summaries = sessions.map(summarizeSession);
  const controller = summaries.find((item) => item.origin !== "subagent" && !item.parentSession)
    ?? summaries[0];
  const finalText = controller?.assistantText || run.stdout.trim();
  await writeFile(resolve(args.lastMessage), `${finalText}\n`, "utf8");

  for (const session of sessions) {
    process.stdout.write(`[dsh-session ${session.header.id ?? "unknown"}]\n`);
    for (const record of session.records) process.stdout.write(`${JSON.stringify(record)}\n`);
    for (const event of session.events.slice(session.records.length - 1)) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  }
  if (run.stderr.trim()) process.stdout.write(`[dsh-stderr]\n${run.stderr.trim()}\n`);

  const usage = sumUsage(summaries.map((item) => item.usage));
  const totalTokens = tokenTotal(usage);
  const routes = summaries.flatMap((item) => item.requestRoutes);
  const actualModels = [...new Set(routes.map((item) => item.model).filter(Boolean))];
  const actualProviders = [...new Set(routes.map((item) => item.provider).filter(Boolean))];
  const actualEfforts = [...new Set(routes.map((item) => item.reasoningEffort).filter(Boolean))];
  const actualMaxTokens = [...new Set(routes.map((item) => item.maxTokens).filter(Number.isSafeInteger))];
  const controllerRoutes = controller?.requestRoutes ?? [];
  const expectedRequestMaxTokens = args.frontendProvider
    ? args.frontendMaxTokens ?? args.controllerMaxTokens
    : args.controllerMaxTokens;
  const outputCeilingObservation = observeProviderOutputCeiling(
    controller?.usageSamples ?? [],
    expectedRequestMaxTokens,
  );
  const expectsOutputPolicy = args.outputConcise || args.controllerMaxTokens !== undefined;
  if (!args.preflight) {
    if (controllerRoutes.length > 0) {
      const observedCount = controller?.outputPolicyPromptCount ?? 0;
      if (expectsOutputPolicy && observedCount !== controllerRoutes.length) {
        throw new Error(`controller output policy prompt was observed on ${observedCount}/${controllerRoutes.length} requests`);
      }
      if (!expectsOutputPolicy && observedCount !== 0) {
        throw new Error("controller output policy prompt leaked into the baseline arm");
      }
      if (args.frontendProvider && controllerRoutes.some((route) => route.maxTokens !== expectedRequestMaxTokens)) {
        throw new Error(`frontend maxTokens override was not attached to every request header: ${JSON.stringify(controllerRoutes)}`);
      }
      if (!args.frontendProvider && args.controllerMaxTokens !== undefined && controllerRoutes.some(
        (route) => !Number.isSafeInteger(route.maxTokens) || route.maxTokens <= 0 || route.maxTokens > args.controllerMaxTokens,
      )) {
        throw new Error(`controller maxTokens request ceiling was not attached to every request header: ${JSON.stringify(controllerRoutes)}`);
      }
    } else if (expectsOutputPolicy) {
      throw new Error("controller output policy was requested but no controller request/header was observed");
    }
    if (args.frontendProvider) {
      const routeEvents = controller?.routeEvents ?? [];
      const decision = routeEvents.find((event) => event.type === "odai/route-decided");
      const upgrade = routeEvents.find((event) => event.type === "odai/route-upgrade");
      const override = routeEvents.find((event) => event.type === "odai/output-budget-overridden");
      if (summaries.some((item) => item.origin === "subagent")) {
        throw new Error("frontend routing canary started an unexpected child session");
      }
      if (decision?.data?.targetRole !== "frontend" || decision?.data?.action !== "upgrade") {
        throw new Error(`frontend routing decision was not observed: ${JSON.stringify(decision)}`);
      }
      if (upgrade?.data?.requestedRoute?.provider !== args.frontendProvider
        || upgrade?.data?.requestedRoute?.model !== args.frontendModel
        || (args.frontendReasoningEffort
          && upgrade?.data?.requestedRoute?.reasoningEffort !== args.frontendReasoningEffort)) {
        throw new Error(`frontend requested route mismatched: ${JSON.stringify(upgrade)}`);
      }
      if (override?.data?.configuredControllerMaxTokens !== args.controllerMaxTokens
        || override?.data?.effectiveMaxTokens !== expectedRequestMaxTokens) {
        throw new Error(`frontend budget override evidence mismatched: ${JSON.stringify(override)}`);
      }
    }
    if (args.researcherProvider) {
      const routeEvents = controller?.routeEvents ?? [];
      const researchDecision = routeEvents.find((event) => event.type === "odai/research-decided");
      const researchResult = routeEvents.find((event) => event.type === "odai/research-result");
      const childSessions = summaries.filter((item) => item.origin === "subagent" || item.parentSession);
      if (args.expectResearcher === "triggered") {
        if (researchDecision?.data?.role !== "researcher" || researchDecision?.data?.action !== "delegate") {
          throw new Error(`researcher routing decision was not observed: ${JSON.stringify(researchDecision)}`);
        }
        if (researchResult?.data?.status !== "completed"
          || !Number.isSafeInteger(researchResult?.data?.sourceCount)
          || researchResult.data.sourceCount < 2
          || !/^[a-f0-9]{64}$/u.test(researchResult?.data?.packetDigest || "")) {
          throw new Error(`researcher packet evidence was not accepted: ${JSON.stringify(researchResult)}`);
        }
        if (childSessions.length !== 1) {
          throw new Error(`researcher routing expected exactly one child session, got ${childSessions.length}`);
        }
        const researcherRoute = childSessions[0].requestRoutes.find((route) => (
          route.provider === args.researcherProvider
          && route.model === args.researcherModel
          && (!args.researcherReasoningEffort || route.reasoningEffort === args.researcherReasoningEffort)
          && route.maxTokens === args.researcherMaxTokens
        ));
        if (!researcherRoute) {
          throw new Error(`researcher actual route mismatched: ${JSON.stringify(childSessions[0].requestRoutes)}`);
        }
        const primaryDecision = routeEvents.find((event) => event.type === "odai/route-decided");
        if (primaryDecision?.data?.targetRole !== "planner" || primaryDecision?.data?.action !== "upgrade") {
          throw new Error(`researcher replaced or bypassed the planner decision route: ${JSON.stringify(primaryDecision)}`);
        }
      } else {
        if (researchDecision || researchResult || childSessions.length > 0) {
          throw new Error(`researcher should have been skipped: ${JSON.stringify({ researchDecision, researchResult, childSessions: childSessions.length })}`);
        }
      }
    }
    if (args.requireOutputCeilingCompliance
      && outputCeilingObservation.status !== "within-requested-ceiling") {
      throw new Error(`provider output ceiling compliance failed: ${JSON.stringify(outputCeilingObservation)}`);
    }
  }

  const researchAudit = args.researcherProvider ? {
    expected: args.expectResearcher,
    decision: (controller?.routeEvents ?? []).find((event) => event.type === "odai/research-decided")?.data ?? null,
    result: (controller?.routeEvents ?? []).find((event) => event.type === "odai/research-result")?.data ?? null,
    childRoutes: summaries
      .filter((item) => item.origin === "subagent" || item.parentSession)
      .flatMap((item) => item.requestRoutes),
    controllerRoutes,
  } : null;

  process.stdout.write(`\n[dsh-runner requested_provider ${args.provider}]\n`);
  process.stdout.write(`[dsh-runner requested_model ${args.model}]\n`);
  process.stdout.write(`[dsh-runner requested_reasoning_effort ${args.reasoningEffort}]\n`);
  process.stdout.write(`[dsh-runner surface ${args.surface}]\n`);
  process.stdout.write(`[dsh-runner routing_mode ${args.surface === "plain" ? "unmanaged" : args.routingMode}]\n`);
  process.stdout.write(`[dsh-runner agent_preset ${args.surface === "agent" ? args.agentPreset : "none"}]\n`);
  process.stdout.write(`[dsh-runner permission_mode ${args.surface === "agent" ? "danger-full-access" : "inherited"}]\n`);
  process.stdout.write(`[dsh-runner actual_providers ${actualProviders.join(",") || "unknown"}]\n`);
  process.stdout.write(`[dsh-runner actual_models ${actualModels.join(",") || "unknown"}]\n`);
  process.stdout.write(`[dsh-runner actual_reasoning_efforts ${actualEfforts.join(",") || "unknown"}]\n`);
  if (researchAudit) process.stdout.write(`[dsh-runner research_audit ${JSON.stringify(researchAudit)}]\n`);
  process.stdout.write(`[dsh-runner requested_output_concise ${args.outputConcise}]\n`);
  process.stdout.write(`[dsh-runner requested_controller_max_tokens ${args.controllerMaxTokens ?? "none"}]\n`);
  process.stdout.write(`[dsh-runner actual_controller_max_tokens ${actualMaxTokens.join(",") || "none"}]\n`);
  process.stdout.write(`[dsh-runner provider_output_ceiling ${JSON.stringify(outputCeilingObservation)}]\n`);
  process.stdout.write(`[dsh-runner output_policy_prompt_observed ${controller?.outputPolicyPromptCount ?? 0}/${controllerRoutes.length}]\n`);
  process.stdout.write(`[dsh-runner usage ${JSON.stringify(usage)}]\n`);
  process.stdout.write(`[dsh-runner session_count ${sessions.length}]\n`);
  if (Number.isFinite(totalTokens)) process.stdout.write(`tokens used\n${totalTokens}\n`);

  if (run.code !== 0) {
    throw new Error(`dsh exited with code ${run.code}${run.signal ? ` (${run.signal})` : ""}`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = {
    promptFile: "",
    cwd: process.cwd(),
    lastMessage: "",
    sourceHome: resolve(process.env.ODAI_CANARY_SOURCE_HOME || homedir(), ".dsh"),
    dshBin: "dsh",
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    reasoningEffort: "max",
    profileHome: "",
    surface: "",
    runtimePluginPath: "",
    runtimeSkillPath: "",
    routingMode: "off",
    plannerProvider: "openai",
    plannerModel: "gpt-5.6-sol",
    plannerReasoningEffort: "high",
    plannerMaxTokens: 2_048,
    researcherProvider: "",
    researcherModel: "",
    researcherReasoningEffort: "",
    researcherMaxTokens: undefined,
    expectResearcher: "",
    frontendProvider: "",
    frontendModel: "",
    frontendReasoningEffort: "",
    frontendMaxTokens: undefined,
    agentPreset: "odai",
    outputConcise: false,
    controllerMaxTokens: undefined,
    requireOutputCeilingCompliance: false,
    controllerEmbedsSkill: false,
    preflight: false,
    timeoutMs: 900_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt-file") parsed.promptFile = argv[++index];
    else if (arg === "--cwd") parsed.cwd = argv[++index];
    else if (arg === "--last-message") parsed.lastMessage = argv[++index];
    else if (arg === "--source-home") parsed.sourceHome = argv[++index];
    else if (arg === "--dsh-bin") parsed.dshBin = argv[++index];
    else if (arg === "--provider") parsed.provider = argv[++index];
    else if (arg === "--model") parsed.model = argv[++index];
    else if (arg === "--reasoning-effort") parsed.reasoningEffort = argv[++index];
    else if (arg === "--profile-home") parsed.profileHome = argv[++index];
    else if (arg === "--surface") parsed.surface = argv[++index];
    else if (arg === "--runtime-plugin-path") parsed.runtimePluginPath = argv[++index];
    else if (arg === "--runtime-skill-path") parsed.runtimeSkillPath = argv[++index];
    else if (arg === "--routing-mode") parsed.routingMode = argv[++index];
    else if (arg === "--planner-provider") parsed.plannerProvider = argv[++index];
    else if (arg === "--planner-model") parsed.plannerModel = argv[++index];
    else if (arg === "--planner-reasoning-effort") parsed.plannerReasoningEffort = argv[++index];
    else if (arg === "--planner-max-tokens") parsed.plannerMaxTokens = Number(argv[++index]);
    else if (arg === "--researcher-provider") parsed.researcherProvider = argv[++index];
    else if (arg === "--researcher-model") parsed.researcherModel = argv[++index];
    else if (arg === "--researcher-reasoning-effort") parsed.researcherReasoningEffort = argv[++index];
    else if (arg === "--researcher-max-tokens") parsed.researcherMaxTokens = Number(argv[++index]);
    else if (arg === "--expect-researcher") parsed.expectResearcher = argv[++index];
    else if (arg === "--frontend-provider") parsed.frontendProvider = argv[++index];
    else if (arg === "--frontend-model") parsed.frontendModel = argv[++index];
    else if (arg === "--frontend-reasoning-effort") parsed.frontendReasoningEffort = argv[++index];
    else if (arg === "--frontend-max-tokens") parsed.frontendMaxTokens = Number(argv[++index]);
    else if (arg === "--agent-preset") parsed.agentPreset = argv[++index];
    else if (arg === "--output-concise") parsed.outputConcise = true;
    else if (arg === "--controller-max-tokens") parsed.controllerMaxTokens = Number(argv[++index]);
    else if (arg === "--require-output-ceiling-compliance") parsed.requireOutputCeilingCompliance = true;
    else if (arg === "--controller-embeds-skill") parsed.controllerEmbedsSkill = true;
    else if (arg === "--preflight") parsed.preflight = true;
    else if (arg === "--timeout") parsed.timeoutMs = Number(argv[++index]) * 1000;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of ["promptFile", "cwd", "lastMessage", "sourceHome", "dshBin", "provider", "model", "reasoningEffort"]) {
    if (typeof parsed[field] !== "string" || parsed[field].trim() === "") {
      throw new Error(`${field} is required`);
    }
    parsed[field] = parsed[field].trim();
  }
  parsed.profileHome = parsed.profileHome.trim();
  parsed.runtimePluginPath = parsed.runtimePluginPath.trim();
  parsed.runtimeSkillPath = parsed.runtimeSkillPath.trim();
  parsed.surface = parsed.surface.trim() || (parsed.profileHome ? "plugin" : "plain");
  if (!["plain", "plugin", "agent", "source-plugin"].includes(parsed.surface)) {
    throw new Error("surface must be plain, plugin, agent, or source-plugin");
  }
  if (["plugin", "agent"].includes(parsed.surface) !== (parsed.profileHome !== "")) {
    throw new Error("plugin and agent surfaces require --profile-home; plain and source-plugin forbid it");
  }
  if (parsed.profileHome && !existsSync(parsed.profileHome)) {
    throw new Error(`profile home not found: ${parsed.profileHome}`);
  }
  if (parsed.surface === "source-plugin") {
    if (!parsed.runtimePluginPath || !existsSync(parsed.runtimePluginPath)) {
      throw new Error("source-plugin requires an existing --runtime-plugin-path");
    }
    if (!parsed.runtimeSkillPath || !existsSync(parsed.runtimeSkillPath)) {
      throw new Error("source-plugin requires an existing --runtime-skill-path");
    }
  } else if (parsed.runtimePluginPath || parsed.runtimeSkillPath) {
    throw new Error("runtime plugin and skill paths require --surface source-plugin");
  }
  if (!["off", "observe", "auto", "execute"].includes(parsed.routingMode)) {
    throw new Error("routing mode must be off, observe, auto, or execute");
  }
  for (const field of ["plannerProvider", "plannerModel", "plannerReasoningEffort", "agentPreset"]) {
    if (typeof parsed[field] !== "string" || parsed[field].trim() === "") throw new Error(`${field} is required`);
    parsed[field] = parsed[field].trim();
  }
  for (const field of [
    "researcherProvider", "researcherModel", "researcherReasoningEffort", "expectResearcher",
    "frontendProvider", "frontendModel", "frontendReasoningEffort",
  ]) {
    parsed[field] = parsed[field].trim();
  }
  if ((parsed.researcherProvider === "") !== (parsed.researcherModel === "")) {
    throw new Error("researcher provider and model must be supplied together");
  }
  if (parsed.researcherProvider && parsed.surface !== "source-plugin") {
    throw new Error("researcher routing canary requires --surface source-plugin");
  }
  if (parsed.researcherProvider && parsed.routingMode !== "auto") {
    throw new Error("researcher routing canary requires --routing-mode auto");
  }
  if (parsed.researcherProvider && !["triggered", "skipped"].includes(parsed.expectResearcher)) {
    throw new Error("researcher routing canary requires --expect-researcher triggered or skipped");
  }
  if (!parsed.researcherProvider && parsed.expectResearcher) {
    throw new Error("--expect-researcher requires a researcher provider and model");
  }
  if ((parsed.frontendProvider === "") !== (parsed.frontendModel === "")) {
    throw new Error("frontend provider and model must be supplied together");
  }
  if (parsed.frontendProvider && parsed.surface !== "source-plugin") {
    throw new Error("frontend routing canary requires --surface source-plugin");
  }
  if (parsed.frontendProvider && parsed.routingMode !== "auto") {
    throw new Error("frontend routing canary requires --routing-mode auto");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parsed.agentPreset)) {
    throw new Error("agent preset contains unsupported characters");
  }
  if (parsed.controllerEmbedsSkill && parsed.surface === "plain") {
    throw new Error("--controller-embeds-skill requires plugin or agent surface");
  }
  if (!Number.isSafeInteger(parsed.plannerMaxTokens) || parsed.plannerMaxTokens <= 0) {
    throw new Error("planner max tokens must be a positive integer");
  }
  if (parsed.researcherMaxTokens !== undefined
    && (!Number.isSafeInteger(parsed.researcherMaxTokens) || parsed.researcherMaxTokens <= 0)) {
    throw new Error("researcher max tokens must be a positive integer");
  }
  if (parsed.researcherMaxTokens !== undefined && !parsed.researcherProvider) {
    throw new Error("researcher max tokens require a researcher provider and model");
  }
  if (parsed.researcherProvider && parsed.researcherMaxTokens === undefined) {
    throw new Error("researcher routing canary requires researcher max tokens");
  }
  if (parsed.frontendMaxTokens !== undefined
    && (!Number.isSafeInteger(parsed.frontendMaxTokens) || parsed.frontendMaxTokens <= 0)) {
    throw new Error("frontend max tokens must be a positive integer");
  }
  if (parsed.frontendMaxTokens !== undefined && !parsed.frontendProvider) {
    throw new Error("frontend max tokens require a frontend provider and model");
  }
  if (parsed.frontendProvider && (parsed.frontendMaxTokens === undefined || parsed.controllerMaxTokens === undefined)) {
    throw new Error("frontend routing canary requires both frontend and controller max tokens");
  }
  if (parsed.frontendProvider && parsed.frontendMaxTokens <= parsed.controllerMaxTokens) {
    throw new Error("frontend routing canary requires a frontend max tokens value above the controller ceiling");
  }
  if (parsed.controllerMaxTokens !== undefined
    && (!Number.isSafeInteger(parsed.controllerMaxTokens) || parsed.controllerMaxTokens <= 0)) {
    throw new Error("controller max tokens must be a positive integer");
  }
  if (parsed.requireOutputCeilingCompliance && parsed.controllerMaxTokens === undefined) {
    throw new Error("--require-output-ceiling-compliance requires --controller-max-tokens");
  }
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
    throw new Error("timeout must be at least one second");
  }
  return parsed;
}

function selectController(settings, selection) {
  const lines = settings.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === "agent-default-model:");
  if (start < 0) throw new Error("settings.yaml has no agent-default-model section");
  let end = start + 1;
  while (end < lines.length && (/^\s/u.test(lines[end]) || lines[end] === "")) end += 1;
  const replacement = [
    "agent-default-model:",
    `  provider: ${selection.provider}`,
    `  model: ${selection.model}`,
    `  reasoningEffort: ${selection.reasoningEffort}`,
  ];
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}

function selectAgentPreset(settings, presetId) {
  const lines = settings.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === "agent-presets:");
  const replacement = ["agent-presets:", `  default: ${presetId}`];
  if (start < 0) return `${settings.trimEnd()}\n${replacement.join("\n")}\n`;
  let end = start + 1;
  while (end < lines.length && (/^\s/u.test(lines[end]) || lines[end] === "")) end += 1;
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}

function configureAgentRouting(composition, options) {
  const newline = composition.includes("\r\n") ? "\r\n" : "\n";
  const normalized = composition.replaceAll("\r\n", "\n");
  const original = [
    "    routing:",
    "      mode: auto",
    "      provider: spawn",
  ].join("\n");
  const replacement = [
    "    routing:",
    `      mode: ${options.routingMode}`,
    "      provider: spawn",
    "      roles:",
    "        planner:",
    `          provider: ${JSON.stringify(options.plannerProvider)}`,
    `          model: ${JSON.stringify(options.plannerModel)}`,
    `          reasoningEffort: ${JSON.stringify(options.plannerReasoningEffort)}`,
    `          maxTokens: ${options.plannerMaxTokens}`,
  ].join("\n");
  if (!normalized.includes(original)) {
    throw new Error("Agent preset routing block does not match the pinned default template");
  }
  return normalized.replace(original, replacement).replaceAll("\n", newline);
}

function locateCommand(command, env) {
  if (existsSync(command)) return resolve(command);
  if (command.includes("/") || command.includes("\\")) return command;
  const extensions = process.platform === "win32"
    ? (extname(command) ? [""] : (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.toLowerCase()))
    : [""];
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory.replace(/^"|"$/gu, ""), `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function resolveDshSpawn(command, env) {
  const located = locateCommand(command, env);
  const extension = extname(located).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { command: process.execPath, prefix: [located] };
  }
  if (process.platform === "win32" && [".cmd", ".bat"].includes(extension)) {
    let shimTarget;
    try {
      const shim = readFileSync(located, "utf8");
      const match = /%dp0%[\\/]([^"\r\n]*?@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)/iu.exec(shim);
      if (match) shimTarget = resolve(dirname(located), match[1].replaceAll("\\", "/"));
    } catch (error) {
      throw new Error(`cannot read Windows DSH shim ${located}`, { cause: error });
    }
    const candidates = [
      shimTarget,
      resolve(dirname(located), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      resolve(dirname(process.execPath), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ].filter(Boolean);
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) {
      throw new Error(`cannot resolve the DSH Node entry behind Windows shim ${located}`);
    }
    return { command: process.execPath, prefix: [entry] };
  }
  return { command: located, prefix: [] };
}

function spawnDsh(command, args, options) {
  const resolved = resolveDshSpawn(command, options.env);
  return spawn(resolved.command, [...resolved.prefix, ...args], options);
}

async function runWebAgent(command, patchPath, prompt, args, options) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnDsh(command, [
    "--profile", "web",
    "--patch", patchPath,
    "--no-open",
    "--host", "127.0.0.1",
    "--port", String(port),
  ], {
    cwd: options.cwd,
    env: {
      ...options.env,
      DSH_PERMISSION_MODE: "danger-full-access",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + options.timeoutMs;

  try {
    const browserCookie = await waitForDshWeb(baseUrl, child, () => output, Math.max(1, deadline - Date.now()));
    const roster = await dshWebRpc(baseUrl, "agentPreset.list", {}, browserCookie);
    if (!roster.presets?.some((preset) => preset.id === args.agentPreset)) {
      throw new Error(`Agent preset ${args.agentPreset} was not discovered`);
    }
    const created = await dshWebRpc(baseUrl, "session.create", {
      cwd: options.cwd,
      agentPreset: args.agentPreset,
    }, browserCookie);
    if (created.agentPreset !== args.agentPreset) {
      throw new Error(`session mounted ${created.agentPreset ?? "<none>"}, expected ${args.agentPreset}`);
    }
    await dshWebRpc(baseUrl, "session.selectModel", {
      sessionId: created.sessionId,
      provider: args.provider,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
    }, browserCookie);
    await dshWebRpc(baseUrl, "session.prompt", {
      sessionId: created.sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    }, browserCookie);
    const events = await waitForTurnEnd(baseUrl, created.sessionId, child, () => output, deadline, browserCookie);
    const finalText = [...events].reverse().find((event) => event.type === "assistant/message")
      ?.data?.message?.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("") ?? "";
    const reason = [...events].reverse().find((event) => event.type === "turn/end")?.data?.reason;
    return {
      code: reason?.kind === "completed" ? 0 : 1,
      signal: null,
      stdout: finalText,
      stderr: reason?.kind === "error"
        ? `${output}\ndsh: ${reason.error?.code ?? "error"}: ${reason.error?.message ?? "unknown error"}`
        : output,
    };
  } finally {
    await stopProcess(child);
  }
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

async function waitForTurnEnd(baseUrl, sessionId, child, output, deadline, browserCookie) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited during the turn (${child.exitCode})\n${output()}`);
    const history = await dshWebRpc(baseUrl, "session.history", { sessionId, maxMessages: 2_000 }, browserCookie);
    const events = history.events.map((entry) => entry.event);
    if (events.some((event) => event.type === "turn/end")) return events;
    await delay(100);
  }
  throw new Error(`timed out waiting for Agent turn\n${output()}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((accept) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      accept();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      accept();
    });
  });
}

function delay(ms) {
  return new Promise((accept) => setTimeout(accept, ms));
}

function runProcess(command, commandArgs, options) {
  return new Promise((accept, reject) => {
    const child = spawnDsh(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      accept({
        code: timedOut ? 124 : (code ?? 1),
        signal,
        stdout,
        stderr: timedOut ? `${stderr}\ndsh runner timed out` : stderr,
      });
    });
  });
}

async function readSessions(root, evidenceRoot) {
  if (!existsSync(root)) return [];
  const evidence = await readEvidence(evidenceRoot);
  const files = await listFiles(root);
  const sessions = [];
  for (const file of files.filter((candidate) => candidate.endsWith("session.jsonl"))) {
    const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const records = lines.map((line) => JSON.parse(line));
    sessions.push({
      header: records[0],
      records,
      events: [...records.slice(1), ...(evidence.get(records[0].id) ?? [])],
    });
  }
  return sessions;
}

async function readEvidence(root) {
  const bySession = new Map();
  if (!existsSync(root)) return bySession;
  for (const file of await listFiles(root)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await readFile(file, "utf8");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (record?.schemaVersion !== 1 || typeof record.sessionId !== "string") continue;
      const events = bySession.get(record.sessionId) ?? [];
      events.push({ type: record.type, time: record.time, data: record.data });
      bySession.set(record.sessionId, events);
    }
  }
  return bySession;
}

async function listFiles(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function summarizeSession(session) {
  const usageByStep = new Map();
  const requestRoutes = [];
  const routeEvents = [];
  let assistantText = "";
  let outputPolicyPromptCount = 0;
  for (const event of session.events) {
    if (event.type === "request/header") {
      const config = event.data?.header?.config;
      const system = event.data?.header?.system;
      if (typeof system === "string" && system.includes("## Odai controller output policy")) {
        outputPolicyPromptCount += 1;
      }
      requestRoutes.push({
        provider: config?.provider,
        model: config?.model,
        reasoningEffort: config?.reasoningEffort,
        maxTokens: config?.maxTokens,
      });
    }
    if ([
      "odai/research-decided",
      "odai/research-result",
      "odai/route-decided",
      "odai/route-upgrade",
      "odai/output-budget-overridden",
    ].includes(event.type)) {
      routeEvents.push({ type: event.type, data: event.data });
    }
    if (event.type === "assistant/message") {
      const text = event.data?.message?.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "";
      if (text) assistantText = text;
      if (event.data?.usage) {
        usageByStep.set(`${event.data.turn}:${event.data.step}`, {
          turn: event.data.turn,
          step: event.data.step,
          usage: event.data.usage,
        });
      }
    }
    if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
      usageByStep.set(`${event.data.turn}:${event.data.step}`, {
        turn: event.data.turn,
        step: event.data.step,
        usage: event.data.chunk.usage,
      });
    }
  }
  const usageSamples = [...usageByStep.values()];
  return {
    id: session.header.id,
    origin: session.header.origin ?? "controller",
    parentSession: session.header.parentSession,
    requestRoutes,
    routeEvents,
    usage: sumUsage(usageSamples.map((sample) => sample.usage)),
    usageSamples,
    assistantText,
    outputPolicyPromptCount,
  };
}

function sumUsage(items) {
  const total = {};
  for (const usage of items) {
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}

function tokenTotal(usage) {
  const direct = ["totalTokens", "total_tokens"].find((key) => Number.isFinite(usage[key]));
  if (direct) return usage[direct];
  const input = usage.inputTokens ?? usage.input_tokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cached_input_tokens ?? 0;
  const output = usage.outputTokens ?? usage.output_tokens ?? 0;
  return input + cacheRead + output;
}
