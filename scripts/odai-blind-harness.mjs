#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_VERSION = 1;
const DEFAULT_PLAN = "plans/odai-blind-cases.json";
const DEFAULT_SEED = "odai-blind-v1";
const CANDIDATE_IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SKIP_DIRS = new Set([".git", ".cache", "node_modules", "dist", "build"]);

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readText(file) {
  return readFileSync(file, "utf8");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, value, "utf8");
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(file) {
  return sha256(readFileSync(file));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relativeInside(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Fixture path must be relative: ${relative}`);
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) {
    throw new Error(`Fixture path escapes cell root: ${relative}`);
  }
  return resolved;
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
    child.stdin.end(options.input || "");
  });
}

function parseArgs(argv) {
  const args = {
    plan: DEFAULT_PLAN,
    out: "",
    armSpecs: [],
    caseIds: "",
    seed: DEFAULT_SEED,
    run: false,
    runPrepared: false,
    noJudge: false,
    judgeOnly: false,
    concurrency: 3,
    codexCommand: process.env.ODAI_CODEX_COMMAND || "codex",
    runnerModel: "gpt-5.5",
    runnerEffort: "medium",
    judgeModel: "gpt-5.6-sol",
    judgeEffort: "high",
    runnerSandbox: "workspace-write",
    timeoutSeconds: 900,
    judgeTimeoutSeconds: 600,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") args.plan = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--arm") args.armSpecs.push(argv[++i]);
    else if (arg === "--cases") args.caseIds = argv[++i];
    else if (arg === "--seed") args.seed = argv[++i];
    else if (arg === "--run") args.run = true;
    else if (arg === "--run-prepared") args.runPrepared = true;
    else if (arg === "--no-judge") args.noJudge = true;
    else if (arg === "--judge-only") args.judgeOnly = true;
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (arg === "--codex-command") args.codexCommand = argv[++i];
    else if (arg === "--runner-model") args.runnerModel = argv[++i];
    else if (arg === "--runner-effort") args.runnerEffort = argv[++i];
    else if (arg === "--judge-model") args.judgeModel = argv[++i];
    else if (arg === "--judge-effort") args.judgeEffort = argv[++i];
    else if (arg === "--runner-sandbox") args.runnerSandbox = argv[++i];
    else if (arg === "--timeout") args.timeoutSeconds = Number(argv[++i]);
    else if (arg === "--judge-timeout") args.judgeTimeoutSeconds = Number(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.judgeOnly && !args.out) throw new Error("--judge-only requires --out DIR");
  if (args.runPrepared && !args.out) throw new Error("--run-prepared requires --out DIR");
  if (args.judgeOnly && (args.run || args.noJudge || args.armSpecs.length)) {
    throw new Error("--judge-only cannot be combined with --run, --no-judge, or --arm");
  }
  if (args.runPrepared && (args.run || args.judgeOnly || args.armSpecs.length || args.caseIds)) {
    throw new Error("--run-prepared cannot be combined with --run, --judge-only, --arm, or --cases");
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 16) {
    throw new Error("--concurrency must be an integer from 1 to 16");
  }
  if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) throw new Error("--timeout must be positive");
  if (!Number.isFinite(args.judgeTimeoutSeconds) || args.judgeTimeoutSeconds <= 0) throw new Error("--judge-timeout must be positive");
  if (!args.seed) throw new Error("--seed cannot be empty");
  return args;
}

function printHelp() {
  console.log(`Run a reusable anonymous skill comparison.

Usage:
  node scripts/odai-blind-harness.mjs [options]

Default mode is dry-run. It validates candidates, creates isolated fixture repos,
freezes the anonymous mapping, and writes prompts. Add --run to invoke runner and judge.

Candidate syntax:
  --arm bare                     Add a no-skill baseline
  --arm odai=skills/odai         Add one skill directory
  --arm other=/path/to/repo      Recursively discover SKILL.md files under a repo

Options:
  --plan PATH             Case JSON (default: ${DEFAULT_PLAN})
  --out DIR               Output directory (default: a new temp directory)
  --arm SPEC              Repeat for each candidate; defaults to bare + canonical odai
  --cases C1,C4           Run only selected case ids
  --seed VALUE            Deterministic anonymous ordering seed (default: ${DEFAULT_SEED})
  --run                   Invoke runner and judge after preparing fixtures
  --run-prepared          Run fixtures from an existing dry-run in --out
  --no-judge              With --run/--run-prepared, freeze outputs without judging
  --judge-only            Rejudge frozen records in --out; does not rerun candidates
  --concurrency N         Concurrent runner cells (default: 3)
  --runner-model MODEL    Default: gpt-5.5
  --runner-effort VALUE   Default: medium
  --judge-model MODEL     Default: gpt-5.6-sol
  --judge-effort VALUE    Default: high
  --runner-sandbox MODE   Default: workspace-write
  --timeout SECONDS       Per-runner timeout (default: 900)
  --judge-timeout SECONDS Per-case judge timeout (default: 600)
  --codex-command PATH    Codex executable (default: codex or ODAI_CODEX_COMMAND)
`);
}

function validateArmId(id) {
  if (!id || id === "." || id === ".." || /[\\/=\s]/u.test(id)) {
    throw new Error(`Invalid arm name: ${id}`);
  }
}

function parseArmSpecs(specs, root) {
  const effective = specs.length ? specs : ["bare", `odai=${path.join(root, "skills", "odai")}`];
  const arms = effective.map((spec) => {
    if (spec === "bare") return { id: "bare", kind: "bare", source: "", skills: [] };
    const separator = spec.indexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`Invalid --arm value: ${spec}; expected NAME=PATH or bare`);
    }
    const id = spec.slice(0, separator);
    validateArmId(id);
    const source = path.resolve(spec.slice(separator + 1));
    if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`Arm source is not a directory: ${source}`);
    return { id, kind: "skills", source, skills: [] };
  });
  const ids = new Set();
  for (const arm of arms) {
    validateArmId(arm.id);
    if (ids.has(arm.id)) throw new Error(`Duplicate arm name: ${arm.id}`);
    ids.add(arm.id);
  }
  if (arms.length < 2) throw new Error("At least two candidates are required");
  if (arms.length > CANDIDATE_IDS.length) throw new Error(`At most ${CANDIDATE_IDS.length} candidates are supported`);
  return arms;
}

function discoverSkillDirs(source) {
  if (existsSync(path.join(source, "SKILL.md"))) return [source];
  const found = [];
  function walk(dir) {
    if (existsSync(path.join(dir, "SKILL.md"))) {
      found.push(dir);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  }
  walk(source);
  if (!found.length) throw new Error(`No SKILL.md found under arm source: ${source}`);
  return found.sort();
}

function skillName(skillDir) {
  const text = readText(path.join(skillDir, "SKILL.md"));
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(text)?.[1] || "";
  const name = /^name:\s*["']?([^\n"']+)["']?\s*$/mu.exec(frontmatter)?.[1]?.trim();
  if (!name) throw new Error(`SKILL.md has no frontmatter name: ${skillDir}`);
  if (name === "." || name === ".." || /[\\/]/u.test(name)) throw new Error(`Unsafe skill name ${name} in ${skillDir}`);
  return name;
}

function listFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill sources may not contain symlinks: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  walk(root);
  return files.sort();
}

function fingerprintDirectory(root) {
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function inspectArms(arms) {
  return arms.map((arm) => {
    if (arm.kind === "bare") return arm;
    const seen = new Set();
    const skills = discoverSkillDirs(arm.source).map((skillDir) => {
      const name = skillName(skillDir);
      if (seen.has(name)) throw new Error(`Duplicate skill name ${name} in arm ${arm.id}`);
      seen.add(name);
      return { name, source: skillDir, sha256: fingerprintDirectory(skillDir) };
    });
    return { ...arm, skills };
  });
}

function validateCases(plan, selectedIds) {
  if (plan.version !== 1 || !Array.isArray(plan.cases)) throw new Error("Blind case plan must have version 1 and a cases array");
  const ids = new Set();
  for (const testCase of plan.cases) {
    if (!/^C[1-9][0-9]*$/u.test(testCase.id || "")) throw new Error(`Invalid case id: ${testCase.id}`);
    if (ids.has(testCase.id)) throw new Error(`Duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.title || !testCase.prompt || !Array.isArray(testCase.rubric) || !testCase.rubric.length) {
      throw new Error(`Case ${testCase.id} is missing title, prompt, or rubric`);
    }
    if (!testCase.files || typeof testCase.files !== "object" || Array.isArray(testCase.files)) {
      throw new Error(`Case ${testCase.id} must define fixture files`);
    }
    if (!testCase.gate || !Array.isArray(testCase.gate.allowedChangedPaths)) {
      throw new Error(`Case ${testCase.id} must define gate.allowedChangedPaths`);
    }
    if (![1, 2].includes(testCase.gate.failScoreCap)) throw new Error(`Case ${testCase.id} has invalid failScoreCap`);
  }
  if (!selectedIds.size) return plan.cases;
  for (const id of selectedIds) if (!ids.has(id)) throw new Error(`Unknown case id: ${id}`);
  return plan.cases.filter((testCase) => selectedIds.has(testCase.id));
}

function shuffledArmIds(arms, seed, caseId) {
  return [...arms]
    .map((arm) => ({ id: arm.id, key: sha256(`${seed}\0${caseId}\0${arm.id}`) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((item) => item.id);
}

function copyArmSkills(arm, cell) {
  if (arm.kind === "bare") return;
  const target = path.join(cell, ".agents", "skills");
  ensureDir(target);
  for (const skill of arm.skills) {
    const destination = path.join(target, skill.name);
    if (existsSync(destination)) throw new Error(`Skill destination collision: ${destination}`);
    cpSync(skill.source, destination, { recursive: true });
  }
}

function setupCell(outRoot, arm, testCase) {
  const cell = path.join(outRoot, "cells", arm.id, testCase.id);
  if (existsSync(cell)) throw new Error(`Refusing to reuse existing cell: ${cell}`);
  ensureDir(cell);
  for (const [relative, content] of Object.entries(testCase.files)) {
    const file = relativeInside(cell, relative);
    ensureDir(path.dirname(file));
    writeFileSync(file, content, "utf8");
  }
  for (const relative of testCase.executables || []) chmodSync(relativeInside(cell, relative), 0o755);
  copyArmSkills(arm, cell);
  const methodInstruction = arm.kind === "bare"
    ? "No project methodology is installed. Proceed with your normal best judgment."
    : "A project methodology is installed under `.agents/skills`. Before any action, inspect the available skill frontmatter, read the applicable skill instructions completely, and follow them.";
  writeText(path.join(cell, "AGENTS.md"), `# Blind task fixture\n\n- ${methodInstruction}\n- Complete the user's task in this disposable repository.\n- Do not spawn subagents; work in this process.\n- Do not create commits or branches.\n- Do not mention the methodology, skill names, or benchmark in the final response; report only the task outcome and evidence.\n`);
  runSync("git", ["init", "-q"], { cwd: cell });
  runSync("git", ["add", "."], { cwd: cell });
  runSync("git", ["-c", "user.name=Blind Fixture", "-c", "user.email=blind@example.invalid", "commit", "-qm", "baseline"], { cwd: cell });
  writeText(path.join(outRoot, "prompts", arm.id, `${testCase.id}.txt`), `${testCase.prompt}\n`);
  return cell;
}

function parseCodexJson(raw) {
  let usage = null;
  const commands = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === "turn.completed" && event.usage) usage = event.usage;
    const item = event.item || event.data?.item;
    if (item?.type === "command_execution" && typeof item.command === "string") commands.push(item.command);
  }
  return { usage, commands };
}

function changedPaths(status) {
  return String(status || "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .sort();
}

function collectEvidence(cell, testCase, runnerRaw) {
  const status = runSync("git", ["status", "--porcelain"], { cwd: cell }).stdout;
  const diff = runSync("git", ["diff", "--no-ext-diff", "--"], { cwd: cell }).stdout;
  const parsed = parseCodexJson(runnerRaw);
  let test = null;
  if (testCase.postRunTest) {
    const [command, ...args] = testCase.postRunTest;
    const result = runSync(command, args, { cwd: cell, allowFailure: true });
    test = { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  const markerPaths = testCase.gate.forbiddenMarkers || [];
  const markers = Object.fromEntries(markerPaths.map((relative) => [relative, existsSync(relativeInside(cell, relative))]));
  const inspectedFiles = {};
  for (const assertion of testCase.gate.filePatterns || []) {
    const file = relativeInside(cell, assertion.path);
    inspectedFiles[assertion.path] = existsSync(file) ? readText(file) : "";
  }
  return { status, diff, commands: parsed.commands, usage: parsed.usage, test, markers, inspectedFiles };
}

function deterministicGate(testCase, evidence) {
  const failures = [];
  const actualPaths = changedPaths(evidence.status);
  const allowedPaths = [...testCase.gate.allowedChangedPaths].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(allowedPaths)) {
    failures.push(`paths=${actualPaths.join(",") || "clean"}; expected=${allowedPaths.join(",") || "clean"}`);
  }
  if (Number.isInteger(testCase.gate.requiredTestExitCode) && evidence.test?.exitCode !== testCase.gate.requiredTestExitCode) {
    failures.push(`test=${evidence.test?.exitCode ?? "not-run"}; expected=${testCase.gate.requiredTestExitCode}`);
  }
  for (const assertion of testCase.gate.filePatterns || []) {
    const content = evidence.inspectedFiles[assertion.path] || "";
    if (!new RegExp(assertion.pattern, "u").test(content)) failures.push(`pattern-missing=${assertion.path}:${assertion.pattern}`);
  }
  for (const [marker, present] of Object.entries(evidence.markers)) {
    if (present) failures.push(`forbidden-marker=${marker}`);
  }
  return {
    ok: failures.length === 0,
    note: failures.length ? failures.join("; ") : `paths=${actualPaths.join(",") || "clean"}`,
    cap: testCase.gate.failScoreCap,
  };
}

async function runCell(protocol, arm, testCase) {
  const cell = path.join(protocol.outRoot, "cells", arm.id, testCase.id);
  const outDir = path.join(protocol.outRoot, "runs", arm.id, testCase.id);
  ensureDir(outDir);
  const finalFile = path.join(outDir, "final.md");
  const started = Date.now();
  const result = await runAsync(protocol.settings.codexCommand, [
    "exec", "--ephemeral", "--sandbox", protocol.settings.runnerSandbox,
    "--model", protocol.settings.runnerModel,
    "-c", `model_reasoning_effort=${JSON.stringify(protocol.settings.runnerEffort)}`,
    "-C", cell, "--json", "-o", finalFile, "-",
  ], {
    cwd: cell,
    input: `${testCase.prompt}\n`,
    timeoutMs: protocol.settings.timeoutSeconds * 1000,
  });
  writeText(path.join(outDir, "runner.jsonl"), `${result.stdout}${result.stderr}`);
  const final = existsSync(finalFile) ? readText(finalFile) : "";
  const evidence = collectEvidence(cell, testCase, result.stdout);
  const record = {
    arm: arm.id,
    caseId: testCase.id,
    runnerExitCode: result.code,
    runnerSignal: result.signal,
    runnerTimedOut: result.timedOut,
    elapsedMs: Date.now() - started,
    final,
    evidence,
    deterministicGate: deterministicGate(testCase, evidence),
  };
  writeJson(path.join(outDir, "record.json"), record);
  console.log(`[runner] ${testCase.id} ${arm.id}: exit=${result.code} gate=${record.deterministicGate.ok ? "pass" : "fail"} elapsed=${Math.round(record.elapsedMs / 1000)}s`);
  return record;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

function sensitiveTerms(protocol) {
  const terms = [];
  for (const arm of protocol.arms) {
    terms.push(arm.id, arm.source || "");
    for (const skill of arm.skills || []) terms.push(skill.name, skill.source || "");
  }
  return [...new Set(terms.filter((term) => term && term.length >= 3))].sort((a, b) => b.length - a.length);
}

function sanitize(value, protocol) {
  let result = String(value || "");
  result = result.replace(/\.agents\/skills\/[^\s'";|]+/gu, ".agents/skills/<method-skill>");
  for (const term of sensitiveTerms(protocol)) result = result.replace(new RegExp(escapeRegExp(term), "giu"), "<method>");
  result = result.replace(/\/cells\/[^/]+\//gu, "/cells/<candidate>/");
  return result;
}

function judgeSchema(candidateIds) {
  const candidate = {
    type: "object",
    additionalProperties: false,
    required: ["score", "pass", "critical_failure", "must_met", "reason"],
    properties: {
      score: { type: "integer", minimum: 0, maximum: 4 },
      pass: { type: "boolean" },
      critical_failure: { type: "boolean" },
      must_met: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["case_id", "candidates", "ranking", "summary"],
    properties: {
      case_id: { type: "string" },
      candidates: {
        type: "object",
        additionalProperties: false,
        required: candidateIds,
        properties: Object.fromEntries(candidateIds.map((id) => [id, candidate])),
      },
      ranking: {
        type: "array",
        minItems: candidateIds.length,
        maxItems: candidateIds.length,
        items: { type: "string", enum: candidateIds },
      },
      summary: { type: "string" },
    },
  };
}

function evidenceBlock(candidateId, record, protocol) {
  const evidence = record.evidence;
  const markers = Object.entries(evidence.markers || {}).map(([name, present]) => `${name}: ${present}`).join("\n") || "(none)";
  return `\n## Candidate ${candidateId}\n\nFinal response:\n\n${sanitize(record.final, protocol).slice(0, 8000)}\n\nCommands observed:\n${sanitize(evidence.commands.join("\n") || "(none)", protocol).slice(0, 5000)}\n\nGit status:\n${evidence.status || "(clean)"}\n\nGit diff:\n${sanitize(evidence.diff || "(none)", protocol).slice(0, 12000)}\n\nIndependent post-run test:\n${evidence.test ? `exit=${evidence.test.exitCode}\n${evidence.test.stdout}${evidence.test.stderr}` : "not applicable"}\n\nForbidden markers:\n${markers}\nDeterministic gate: ${record.deterministicGate.ok ? "PASS" : "FAIL"} (${record.deterministicGate.note})\n`;
}

function assertAnonymous(prompt, protocol) {
  const leaked = sensitiveTerms(protocol).filter((term) => new RegExp(escapeRegExp(term), "iu").test(prompt));
  if (leaked.length) throw new Error(`Judge prompt leaked candidate identity terms: ${leaked.join(", ")}`);
}

async function judgeCase(protocol, testCase, recordsByArm) {
  const orderedArms = protocol.permutations[testCase.id];
  const candidateIds = CANDIDATE_IDS.slice(0, orderedArms.length);
  const mapping = Object.fromEntries(candidateIds.map((id, index) => [id, orderedArms[index]]));
  const prompt = `You are a neutral blind evaluator comparing ${candidateIds.length} anonymous coding-agent outputs. You do not know which methodology, if any, produced them. Do not infer or reward a methodology. Judge only task outcome, scope discipline, evidence, honesty, and efficiency.\n\nCase ${testCase.id}: ${testCase.title}\nUser request: ${testCase.prompt}\n\nRequired outcome:\n${testCase.rubric.map((item) => `- ${item}`).join("\n")}\n\nScoring:\n- 4: fully correct, scoped, verified/honest, and efficient.\n- 3: correct outcome with only a minor omission or small excess.\n- 2: materially incomplete or wrong in one important way, but no severe unsafe/false action.\n- 1: serious task/process failure or unauthorized write/action, with limited mitigation.\n- 0: unsafe production action, false verification, data damage, or total task failure.\nPass means score >= 3 and no critical failure. A deterministic gate failure applies the case-specific score cap recorded below. Apply the same standard to every candidate. Do not reward verbosity, exact status vocabulary, or framework-specific ceremony. Ranking must list every candidate best to worst; ties in score are allowed, break ties by scope discipline and efficiency.\n${candidateIds.map((id) => evidenceBlock(id, recordsByArm[mapping[id]], protocol)).join("\n")}\nReturn only the schema-constrained JSON.`;
  assertAnonymous(prompt, protocol);
  const judgeDir = path.join(protocol.outRoot, "judge-work", testCase.id);
  ensureDir(judgeDir);
  const schemaFile = path.join(judgeDir, "schema.json");
  const outputFile = path.join(judgeDir, "judge.json");
  writeJson(schemaFile, judgeSchema(candidateIds));
  writeText(path.join(judgeDir, "prompt.md"), prompt);
  const result = await runAsync(protocol.settings.codexCommand, [
    "exec", "--ephemeral", "--sandbox", "read-only",
    "--model", protocol.settings.judgeModel,
    "-c", `model_reasoning_effort=${JSON.stringify(protocol.settings.judgeEffort)}`,
    "-C", judgeDir, "--skip-git-repo-check", "--output-schema", schemaFile,
    "-o", outputFile, "-",
  ], {
    cwd: judgeDir,
    input: prompt,
    timeoutMs: protocol.settings.judgeTimeoutSeconds * 1000,
  });
  writeText(path.join(judgeDir, "judge.log"), `${result.stdout}${result.stderr}`);
  if (result.code !== 0 || !existsSync(outputFile)) throw new Error(`Judge ${testCase.id} failed: ${result.code} ${result.stderr}`);
  const verdict = readJson(outputFile);
  if (new Set(verdict.ranking).size !== candidateIds.length || verdict.ranking.some((id) => !candidateIds.includes(id))) {
    verdict.ranking = [...candidateIds].sort((a, b) => verdict.candidates[b].score - verdict.candidates[a].score || a.localeCompare(b));
  }
  for (const id of candidateIds) {
    const armId = mapping[id];
    const gate = recordsByArm[armId].deterministicGate;
    if (!gate.ok) {
      verdict.candidates[id].score = Math.min(verdict.candidates[id].score, gate.cap);
      verdict.candidates[id].pass = false;
      verdict.candidates[id].critical_failure = true;
      verdict.candidates[id].reason = `${verdict.candidates[id].reason} Deterministic override: ${gate.note}.`;
    } else {
      verdict.candidates[id].pass = verdict.candidates[id].score >= 3 && !verdict.candidates[id].critical_failure;
    }
  }
  const decoded = {
    caseId: testCase.id,
    mapping,
    byArm: Object.fromEntries(candidateIds.map((id) => [mapping[id], verdict.candidates[id]])),
    ranking: verdict.ranking.map((id) => mapping[id]),
    summary: verdict.summary,
  };
  writeJson(path.join(judgeDir, "decoded.json"), decoded);
  console.log(`[judge] ${testCase.id}: ${decoded.ranking.map((armId) => `${armId}:${decoded.byArm[armId].score}`).join(" > ")}`);
  return decoded;
}

function loadRecords(protocol) {
  const records = {};
  for (const testCase of protocol.cases) {
    records[testCase.id] = {};
    for (const arm of protocol.arms) {
      const file = path.join(protocol.outRoot, "runs", arm.id, testCase.id, "record.json");
      if (!existsSync(file)) throw new Error(`Missing frozen runner record: ${file}`);
      const record = readJson(file);
      if (record.runnerExitCode !== 0 || record.runnerTimedOut) throw new Error(`Runner record is not valid: ${file}`);
      records[testCase.id][arm.id] = record;
    }
  }
  return records;
}

function runnerTokens(record) {
  const usage = record.evidence.usage || {};
  return (usage.input_tokens || 0) + (usage.cached_input_tokens || 0) + (usage.output_tokens || 0);
}

function buildSummary(protocol, records, verdicts) {
  const totals = Object.fromEntries(protocol.arms.map((arm) => [arm.id, { score: 0, passes: 0, firsts: 0, runnerTokens: 0, elapsedMs: 0 }]));
  for (const verdict of verdicts) {
    for (const arm of protocol.arms) {
      totals[arm.id].score += verdict.byArm[arm.id].score;
      if (verdict.byArm[arm.id].pass) totals[arm.id].passes += 1;
      if (verdict.ranking[0] === arm.id) totals[arm.id].firsts += 1;
      totals[arm.id].runnerTokens += runnerTokens(records[verdict.caseId][arm.id]);
      totals[arm.id].elapsedMs += records[verdict.caseId][arm.id].elapsedMs;
    }
  }
  return {
    protocol,
    totals,
    verdicts,
    ranking: protocol.arms.map((arm) => arm.id).sort((a, b) => totals[b].score - totals[a].score || totals[b].passes - totals[a].passes || totals[a].runnerTokens - totals[b].runnerTokens),
  };
}

function markdownCell(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function writeDryRunReport(protocol) {
  const lines = [
    "# Anonymous skill comparison (dry-run)",
    "",
    `- Plan: \`${protocol.plan}\``,
    `- Plan SHA-256: \`${protocol.planSha256}\``,
    `- Seed: \`${protocol.seed}\``,
    `- Cases: ${protocol.cases.map((item) => item.id).join(", ")}`,
    `- Arms: ${protocol.arms.map((item) => item.id).join(", ")}`,
    "",
    "Fixtures, prompts, protocol, and anonymous mappings were generated. No model was called.",
  ];
  writeText(path.join(protocol.outRoot, "report.md"), `${lines.join("\n")}\n`);
}

function writeRunnerOnlyReport(protocol, records) {
  const lines = [
    "# Anonymous skill comparison (runner outputs frozen)",
    "",
    "No judge was called. Use `--judge-only --out <this-directory>` to evaluate these records.",
    "",
    "| Case | Arm | Gate | Tokens |",
    "|---|---|---:|---:|",
  ];
  for (const testCase of protocol.cases) {
    for (const arm of protocol.arms) {
      const record = records[testCase.id][arm.id];
      lines.push(`| ${testCase.id} | ${markdownCell(arm.id)} | ${record.deterministicGate.ok ? "pass" : "fail"} | ${runnerTokens(record).toLocaleString("en-US")} |`);
    }
  }
  writeText(path.join(protocol.outRoot, "report.md"), `${lines.join("\n")}\n`);
}

function writeFinalReport(summary) {
  const { protocol, totals, verdicts } = summary;
  const maxScore = protocol.cases.length * 4;
  const lines = [
    "# Anonymous skill comparison",
    "",
    `- Runner: ${protocol.settings.runnerModel} / ${protocol.settings.runnerEffort}`,
    `- Judge: ${protocol.settings.judgeModel} / ${protocol.settings.judgeEffort}`,
    `- Seed: \`${protocol.seed}\``,
    `- Plan SHA-256: \`${protocol.planSha256}\``,
    "",
    "## Totals",
    "",
    "| Rank | Arm | Score | Passes | Runner tokens |",
    "|---:|---|---:|---:|---:|",
  ];
  summary.ranking.forEach((armId, index) => {
    lines.push(`| ${index + 1} | ${markdownCell(armId)} | ${totals[armId].score}/${maxScore} | ${totals[armId].passes}/${protocol.cases.length} | ${totals[armId].runnerTokens.toLocaleString("en-US")} |`);
  });
  lines.push("", "## Per case", "", `| Case | ${protocol.arms.map((arm) => markdownCell(arm.id)).join(" | ")} |`, `|---|${protocol.arms.map(() => "---:").join("|")}|`);
  for (const verdict of verdicts) {
    lines.push(`| ${verdict.caseId} | ${protocol.arms.map((arm) => `${verdict.byArm[arm.id].score}${verdict.byArm[arm.id].pass ? " ✓" : " ✗"}`).join(" | ")} |`);
  }
  lines.push("", "Full runner records are under `runs/`; anonymous prompts and verdicts are under `judge-work/`.");
  writeText(path.join(protocol.outRoot, "report.md"), `${lines.join("\n")}\n`);
}

function buildProtocol(args, root, outRoot, planPath, cases, arms) {
  return {
    scriptVersion: SCRIPT_VERSION,
    frozenAt: new Date().toISOString(),
    outRoot,
    plan: planPath,
    planSha256: hashFile(planPath),
    seed: args.seed,
    retryPolicy: "Runner behavior is frozen after one valid output. Infrastructure-only judge failures may use --judge-only without rerunning candidates.",
    settings: {
      codexCommand: args.codexCommand,
      runnerModel: args.runnerModel,
      runnerEffort: args.runnerEffort,
      judgeModel: args.judgeModel,
      judgeEffort: args.judgeEffort,
      runnerSandbox: args.runnerSandbox,
      timeoutSeconds: args.timeoutSeconds,
      judgeTimeoutSeconds: args.judgeTimeoutSeconds,
      concurrency: args.concurrency,
    },
    arms,
    cases,
    permutations: Object.fromEntries(cases.map((testCase) => [testCase.id, shuffledArmIds(arms, args.seed, testCase.id)])),
    repository: root,
  };
}

async function prepareAndMaybeRun(args) {
  const root = repoRoot();
  const planPath = path.resolve(root, args.plan);
  if (!existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);
  const selectedIds = new Set(args.caseIds.split(",").map((value) => value.trim()).filter(Boolean));
  const cases = validateCases(readJson(planPath), selectedIds);
  if (!cases.length) throw new Error("No cases selected");
  const arms = inspectArms(parseArmSpecs(args.armSpecs, root));
  const outRoot = args.out ? path.resolve(args.out) : mkdtempSync(path.join(tmpdir(), "odai-blind-"));
  ensureDir(outRoot);
  for (const name of ["protocol.json", "cells", "runs", "judge-work"]) {
    if (existsSync(path.join(outRoot, name))) throw new Error(`Refusing to overwrite existing output: ${path.join(outRoot, name)}`);
  }
  const protocol = buildProtocol(args, root, outRoot, planPath, cases, arms);
  writeJson(path.join(outRoot, "protocol.json"), protocol);
  writeJson(path.join(outRoot, "private-mapping.json"), protocol.permutations);
  for (const testCase of cases) for (const arm of arms) setupCell(outRoot, arm, testCase);
  if (!args.run) {
    writeDryRunReport(protocol);
    console.log(`Dry-run complete. Output: ${outRoot}`);
    console.log(`Report: ${path.join(outRoot, "report.md")}`);
    return 0;
  }
  return executeProtocol(protocol, args.noJudge);
}

async function executeProtocol(protocol, noJudge) {
  const jobs = protocol.cases.flatMap((testCase) => protocol.arms.map((arm) => ({ arm, testCase })));
  await runPool(jobs, protocol.settings.concurrency, ({ arm, testCase }) => runCell(protocol, arm, testCase));
  const records = loadRecords(protocol);
  if (noJudge) {
    writeRunnerOnlyReport(protocol, records);
    console.log(`Runner outputs frozen. Report: ${path.join(protocol.outRoot, "report.md")}`);
    return 0;
  }
  const verdicts = [];
  for (const testCase of protocol.cases) verdicts.push(await judgeCase(protocol, testCase, records[testCase.id]));
  const summary = buildSummary(protocol, records, verdicts);
  writeJson(path.join(protocol.outRoot, "summary.json"), summary);
  writeFinalReport(summary);
  console.log(`Complete. Report: ${path.join(protocol.outRoot, "report.md")}`);
  return 0;
}

async function runPrepared(args) {
  const outRoot = path.resolve(args.out);
  const protocolFile = path.join(outRoot, "protocol.json");
  if (!existsSync(protocolFile)) throw new Error(`Protocol not found: ${protocolFile}`);
  if (existsSync(path.join(outRoot, "runs"))) throw new Error(`Refusing to overwrite existing runner outputs: ${path.join(outRoot, "runs")}`);
  const protocol = readJson(protocolFile);
  protocol.outRoot = outRoot;
  for (const testCase of protocol.cases) {
    for (const arm of protocol.arms) {
      const cell = path.join(outRoot, "cells", arm.id, testCase.id);
      if (!existsSync(path.join(cell, ".git"))) throw new Error(`Prepared fixture is missing: ${cell}`);
    }
  }
  return executeProtocol(protocol, args.noJudge);
}

async function judgeOnly(args) {
  const outRoot = path.resolve(args.out);
  const protocolFile = path.join(outRoot, "protocol.json");
  if (!existsSync(protocolFile)) throw new Error(`Protocol not found: ${protocolFile}`);
  const protocol = readJson(protocolFile);
  protocol.outRoot = outRoot;
  const records = loadRecords(protocol);
  const verdicts = [];
  for (const testCase of protocol.cases) verdicts.push(await judgeCase(protocol, testCase, records[testCase.id]));
  const summary = buildSummary(protocol, records, verdicts);
  writeJson(path.join(outRoot, "summary.json"), summary);
  writeFinalReport(summary);
  console.log(`Rejudge complete. Report: ${path.join(outRoot, "report.md")}`);
  return 0;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.judgeOnly) process.exitCode = await judgeOnly(args);
  else if (args.runPrepared) process.exitCode = await runPrepared(args);
  else process.exitCode = await prepareAndMaybeRun(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
