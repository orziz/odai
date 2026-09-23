import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnDsh } from "./dsh-process.mjs";
import { resolveControllerSelection, selectController } from "./live-routing-smoke-config.mjs";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseReport(text) {
  const value = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.calls)) throw new TypeError("cache report is invalid");
  const calls = value.calls.flatMap((call) => {
    if (!isRecord(call) || typeof call.label !== "string") return [];
    const usage = isRecord(call.usage)
      ? {
          ...(typeof call.usage.cacheReadTokens === "number" ? { cacheReadTokens: call.usage.cacheReadTokens } : {}),
          ...(typeof call.usage.inputTokens === "number" ? { inputTokens: call.usage.inputTokens } : {}),
        }
      : undefined;
    return [
      {
        label: call.label,
        ...(usage ? { usage } : {}),
        ...(typeof call.effectiveReasoningEffort === "string" || call.effectiveReasoningEffort === null
          ? { effectiveReasoningEffort: call.effectiveReasoningEffort }
          : {}),
      },
    ];
  });
  return { calls };
}
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");
const workspaceRoot = resolve(process.env.INIT_CWD ?? process.cwd());
const args = parseArgs(process.argv.slice(2));
const runtimeCacheRetention = process.env.ODAI_COMPACTION_CACHE_RETENTION ?? "long";
if (!["provider-default", "short", "long", "none"].includes(runtimeCacheRetention)) {
  throw new Error("ODAI_COMPACTION_CACHE_RETENTION must be provider-default, short, long, or none");
}
if (!args.yes) {
  throw new Error(
    "live compaction cache smoke calls an external model; rerun with --yes after confirming cost and credentials",
  );
}
const sourceHome = resolve(args.sourceHome ?? resolve(homedir(), ".dsh"));
const sourceSettings = resolve(sourceHome, "settings.yaml");
const sourceCredentials = resolve(sourceHome, ".credentials.yaml");
const runtimePath = [resolve(pluginRoot, "runtime/index.mjs"), resolve(pluginRoot, "../runtime/build/index.mjs")].find(
  (candidate) => existsSync(candidate),
);
const skillPath = [resolve(pluginRoot, "skills/odai/SKILL.md"), resolve(repoRoot, "skills/odai/SKILL.md")].find(
  (candidate) => existsSync(candidate),
);
const scratch = await mkdtemp(resolve(tmpdir(), "odai-compaction-cache-"));
const dshHome = resolve(scratch, "home");
const probePath = resolve(scratch, "probe-plugin.mjs");
const reportPath = resolve(scratch, "report.json");
const patchPath = resolve(scratch, "probe.patch.yml");
const dsh = process.env.DSH_BIN ?? "dsh";
try {
  if (!existsSync(sourceSettings)) throw new Error(`dsh settings not found: ${sourceSettings}`);
  if (
    args.runtime &&
    (runtimePath === undefined || skillPath === undefined || !existsSync(runtimePath) || !existsSync(skillPath))
  ) {
    throw new Error("source Odai runtime or canonical skill is unavailable");
  }
  await mkdir(dshHome, { recursive: true });
  const sourceSettingsText = await readFile(sourceSettings, "utf8");
  const controller = resolveControllerSelection(sourceSettingsText, {});
  await writeFile(resolve(dshHome, "settings.yaml"), selectController(sourceSettingsText, controller), "utf8");
  if (existsSync(sourceCredentials)) {
    await copyFile(sourceCredentials, resolve(dshHome, ".credentials.yaml"));
  }
  await writeFile(probePath, renderProbePlugin(), "utf8");
  await writeFile(
    patchPath,
    renderPatch({
      probePath: pathToFileURL(probePath).href,
      reportPath,
      runtimePath: runtimePath ? pathToFileURL(runtimePath).href : "",
      skillPath: skillPath ?? "",
      runtime: args.runtime,
      ordinaryOnly: args.ordinaryOnly,
      provider: controller.provider,
      model: controller.model,
      reasoningEffort: controller.reasoningEffort,
      compactionMaxTokens: args.compactionMaxTokens,
      cacheRetention: args.cacheRetention,
      compactionCacheRetention: args.compactionCacheRetention,
      runtimeCacheRetention,
      marker: randomUUID(),
    }),
    "utf8",
  );
  const run = await runProcess(dsh, ["--profile", "headless", "--patch", patchPath, "Reply with OK only."], {
    cwd: workspaceRoot,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_MODE: "DISABLED" },
    timeoutMs: args.timeoutMs,
  });
  if (!existsSync(reportPath)) {
    throw new Error(`cache probe produced no report (exit ${run.code})\n${run.stderr}`);
  }
  const report = parseReport(await readFile(reportPath, "utf8"));
  const verification = verifyReport(report, args.runtime, args.compactionMaxTokens === 16, args.ordinaryOnly);
  const output = {
    ok: run.code === 0 && verification.ok,
    mode: args.runtime ? "candidate-runtime" : "baseline",
    scenario: args.ordinaryOnly ? "ordinary-prefix-reuse" : "compaction-cache",
    controller: { provider: controller.provider, model: controller.model, reasoningEffort: controller.reasoningEffort },
    budgets: { warmMaxTokens: 16, ...(args.ordinaryOnly ? {} : { compactionMaxTokens: args.compactionMaxTokens }) },
    requestedCacheRetentionOverrides: {
      warm: args.cacheRetention ?? "none",
      ...(args.ordinaryOnly ? {} : { compaction: args.compactionCacheRetention ?? args.cacheRetention ?? "none" }),
    },
    runtimeCacheRetention,
    verification,
    calls: report.calls,
    dshExitCode: run.code,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
function parseArgs(argv) {
  const parsed = {
    yes: false,
    runtime: false,
    ordinaryOnly: false,
    sourceHome: undefined,
    timeoutMs: 180_000,
    compactionMaxTokens: 16,
    cacheRetention: undefined,
    compactionCacheRetention: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") parsed.yes = true;
    else if (arg === "--runtime") parsed.runtime = true;
    else if (arg === "--ordinary-only") parsed.ordinaryOnly = true;
    else if (arg === "--source-home") parsed.sourceHome = argv[++index];
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else if (arg === "--compaction-max-tokens") parsed.compactionMaxTokens = Number(argv[++index]);
    else if (arg === "--cache-retention" || arg === "--compaction-cache-retention") {
      const value = argv[++index];
      if (value !== "short" && value !== "long" && value !== "none") {
        throw new Error(`${arg.slice(2)} must be short, long, or none`);
      }
      if (arg === "--cache-retention") parsed.cacheRetention = value;
      else parsed.compactionCacheRetention = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1_000) {
    throw new Error("timeoutMs must be an integer of at least 1000");
  }
  if (!Number.isSafeInteger(parsed.compactionMaxTokens) || parsed.compactionMaxTokens < 16) {
    throw new Error("compactionMaxTokens must be an integer of at least 16");
  }
  for (const field of ["cacheRetention", "compactionCacheRetention"]) {
    if (parsed[field] !== undefined && !["short", "long", "none"].includes(parsed[field])) {
      throw new Error(`${field} must be short, long, or none`);
    }
  }
  return parsed;
}
function renderPatch(input) {
  const quote = (value) => JSON.stringify(value);
  return [
    "- insert:",
    ...(input.runtime
      ? [
          "    - id: odai-compaction-cache-candidate",
          `      name: ${quote(input.runtimePath)}`,
          "      config:",
          `        skillPath: ${quote(input.skillPath)}`,
          "        routing:",
          "          mode: off",
        ]
      : []),
    "    - id: odai-compaction-cache-probe",
    `      name: ${quote(input.probePath)}`,
    "      config:",
    `        reportPath: ${quote(input.reportPath)}`,
    `        provider: ${quote(input.provider)}`,
    `        model: ${quote(input.model)}`,
    `        reasoningEffort: ${quote(input.reasoningEffort)}`,
    `        ordinaryOnly: ${input.ordinaryOnly}`,
    `        compactionMaxTokens: ${input.compactionMaxTokens}`,
    ...(input.cacheRetention === undefined ? [] : [`        cacheRetention: ${quote(input.cacheRetention)}`]),
    ...(input.compactionCacheRetention === undefined
      ? []
      : [`        compactionCacheRetention: ${quote(input.compactionCacheRetention)}`]),
    `        marker: ${quote(input.marker)}`,
    ...(input.runtime
      ? [
          `        runtimeModule: ${quote(input.runtimePath)}`,
          `        runtimeCacheRetention: ${quote(input.runtimeCacheRetention)}`,
        ]
      : []),
    "",
  ].join("\n");
}
function renderProbePlugin() {
  return `import { writeFile } from "node:fs/promises";

export const name = "odai-compaction-cache-probe";
export const inject = ["llm"];

export function apply(ctx, config) {
  let ran = false;
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    if (ran) return next();
    ran = true;
    const stablePrefix = config.marker + "\\n" + "stable compaction cache prefix ".repeat(2048);
    const base = {
      provider: config.provider,
      model: config.model,
      system: "You are a cache probe. Reply with OK only.",
      maxTokens: 16,
      sessionId: agent.session.id,
      ...(config.cacheRetention === undefined ? {} : { cacheRetention: config.cacheRetention }),
    };
    const prefix = message("prefix", stablePrefix);
    const calls = [];
    calls.push(await invoke(ctx, "warm", {
      ...base,
      reasoningEffort: config.reasoningEffort,
      messages: [prefix, message("warm-tail", "Warm this exact prefix. Reply OK.")],
    }));
    if (!config.ordinaryOnly) {
      const compaction = {
        ...base,
        maxTokens: config.compactionMaxTokens,
        ...(config.compactionCacheRetention === undefined
          ? {}
          : { cacheRetention: config.compactionCacheRetention }),
        purpose: "compaction",
        messages: [prefix, message("compaction-tail", "Condense the prefix. Reply OK.")],
      };
      if (config.runtimeModule) {
        const runtime = await import(config.runtimeModule);
        runtime.inheritCompactionReasoning(compaction, {
          get(sessionId) {
            if (sessionId !== agent.session.id) return undefined;
            return {
              requestHeader() {
                return {
                  config: {
                    provider: config.provider,
                    model: config.model,
                    reasoningEffort: config.reasoningEffort,
                  },
                };
              },
            };
          },
        }, config.runtimeCacheRetention);
      }
      calls.push(await invoke(ctx, "compaction", compaction));
    }
    calls.push(await invoke(ctx, "matched", {
      ...base,
      ...(config.ordinaryOnly ? {} : { purpose: "compaction" }),
      reasoningEffort: config.reasoningEffort,
      messages: [prefix, message("matched-tail", "Confirm this prefix. Reply OK.")],
    }));
    await writeFile(config.reportPath, JSON.stringify({ calls }, null, 2) + "\\n", "utf8");
    return next();
  }, { prepend: true });
}

function message(id, text) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name },
  };
}

async function invoke(ctx, label, options) {
  let usage;
  let finish;
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === "usage") usage = chunk.usage;
    if (chunk.type === "finish") finish = chunk.reason;
  }
  return {
    label,
    effectiveReasoningEffort: options.reasoningEffort ?? null,
    effectiveMaxTokens: options.maxTokens ?? null,
    effectiveCacheRetention: options.cacheRetention ?? null,
    usage: usage ?? null,
    finish: finish ?? null,
  };
}
`;
}
function verifyReport(report, runtime, requireCompactionCache, ordinaryOnly) {
  const errors = [];
  const calls = Object.fromEntries(report.calls.map((call) => [call.label, call]));
  for (const label of ordinaryOnly ? ["warm", "matched"] : ["warm", "compaction", "matched"]) {
    if (!calls[label]?.usage) errors.push(`${label} call has no usage`);
  }
  const compactionCache = calls.compaction?.usage?.cacheReadTokens ?? 0;
  const matchedCache = calls.matched?.usage?.cacheReadTokens ?? 0;
  const compactionInput = calls.compaction?.usage?.inputTokens ?? 0;
  const matchedInput = calls.matched?.usage?.inputTokens ?? 0;
  const compactionCoverage = ratio(compactionCache, compactionCache + compactionInput);
  const matchedCoverage = ratio(matchedCache, matchedCache + matchedInput);
  if (matchedCache < 1_024) errors.push(`matched reasoning cache read was only ${matchedCache}`);
  if (!ordinaryOnly && runtime) {
    if (calls.compaction?.effectiveReasoningEffort !== calls.warm?.effectiveReasoningEffort) {
      errors.push("candidate runtime did not inherit the routed reasoning effort");
    }
    if (requireCompactionCache && compactionCache < 1_024) {
      errors.push(`candidate compaction cache read was only ${compactionCache}`);
    }
  } else if (!ordinaryOnly) {
    if (calls.compaction?.effectiveReasoningEffort !== null) {
      errors.push("baseline compaction unexpectedly had a reasoning effort");
    }
    if (compactionCache >= matchedCache) {
      errors.push(`baseline mismatch did not reduce cache reuse (${compactionCache} >= ${matchedCache})`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    compactionCacheReadTokens: compactionCache,
    matchedCacheReadTokens: matchedCache,
    compactionCacheCoverage: compactionCoverage,
    matchedCacheCoverage: matchedCoverage,
    cacheStatus:
      matchedCoverage < 0.5
        ? "upstream-low-hit"
        : !ordinaryOnly && !requireCompactionCache && compactionCache < matchedCache
          ? "budget-partitioned"
          : "reused",
    budgetMismatchReducedCache: !ordinaryOnly && !requireCompactionCache && compactionCache < matchedCache,
  };
}
function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}
function runProcess(command, commandArgs, options) {
  return new Promise((accept, reject) => {
    const child = spawnDsh(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      reject(new Error("cache smoke requires piped stdout and stderr"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
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
        stderr: timedOut ? `${stderr}\ncache smoke timed out` : stderr,
      });
    });
  });
}
