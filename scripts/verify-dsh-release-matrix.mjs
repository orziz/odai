#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { satisfies, validRange } from "semver";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsPath = resolve(repoRoot, "dsh/release-contracts.json");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const document = JSON.parse(await readFile(contractsPath, "utf8"));
if (document.schemaVersion !== 2
  || typeof document.dshRange !== "string"
  || validRange(document.dshRange) === null
  || typeof document.sourceDshVersion !== "string"
  || !Array.isArray(document.releases)
  || document.releases.length === 0
  || !document.releases.some((release) => release.version === document.sourceDshVersion)) {
  throw new Error("dsh/release-contracts.json must declare schemaVersion 2, a valid range and source, and non-empty releases");
}

const options = parseArguments(process.argv.slice(2));
const releases = options.versions.length === 0
  ? document.releases
  : options.versions.map((version) => {
    const release = document.releases.find((candidate) => candidate.version === version);
    if (!release) throw new Error(`unknown DSH release contract ${version}`);
    return release;
  });
const scratch = await mkdtemp(resolve(tmpdir(), "odai-dsh-release-matrix-"));
const results = [];
try {
  for (const release of releases) {
    validateRelease(release);
    const root = resolve(scratch, release.version);
    const installArguments = [
      "install",
      "--prefix", root,
      "--registry=https://registry.npmjs.org/",
      `--before=${release.publishedBefore}`,
      "--fetch-timeout=60000",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `@deepseek-ai/dsh@${release.version}`,
      ...(options.pluginTgz ? [options.pluginTgz, options.agentTgz] : []),
    ];
    run(npm, installArguments);
    const dshBin = resolve(root, "node_modules/.bin", process.platform === "win32" ? "dsh.cmd" : "dsh");
    const actualVersion = run(dshBin, ["-V"], { capture: true }).trim();
    if (actualVersion !== release.version) throw new Error(`expected DSH ${release.version}, found ${actualVersion}`);

    const packages = await dshPackages(resolve(root, "node_modules"));
    const mismatched = packages.filter((entry) => entry.version !== release.version);
    if (mismatched.length > 0) {
      throw new Error(`mixed DSH graph for ${release.version}: ${mismatched.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
    }
    if (packages.length !== release.expectedDshPackages) {
      throw new Error(`DSH ${release.version} graph has ${packages.length} packages, expected ${release.expectedDshPackages}`);
    }
    const standardPath = resolve(root, "node_modules", release.standardCompositionPath);
    const standardDigest = createHash("sha256").update(await readFile(standardPath)).digest("hex");
    if (standardDigest !== release.standardCompositionSha256) {
      throw new Error(`DSH ${release.version} Standard digest ${standardDigest} does not match ${release.standardCompositionSha256}`);
    }

    const env = {
      ...process.env,
      DSH_BIN: dshBin,
      DSH_PACKAGE_ROOT: resolve(root, "node_modules/@deepseek-ai/dsh"),
      DSH_STANDARD_COMPOSITION: standardPath,
    };
    if (options.pluginTgz) {
      const packageEnv = {
        ...env,
        ODAI_PLUGIN_PACKAGE_ROOT: resolve(root, "node_modules/odai-dsh-plugin"),
        ODAI_AGENT_PACKAGE_ROOT: resolve(root, "node_modules/odai-dsh-agent"),
      };
      run(npm, ["exec", "--", "tsx", "dsh/plugin/tests/verify-legacy-session-repair.mts"], { env: packageEnv });
      run(npm, ["exec", "--", "tsx", "dsh/plugin/tests/verify-dsh-load.mts"], { env: packageEnv });
      run(npm, ["exec", "--", "tsx", "dsh/agent/tests/verify-agent-load.mts"], { env: packageEnv });
    } else {
      run(npm, ["--prefix", "dsh/plugin", "run", "verify:dsh"], { env });
      run(npm, ["--prefix", "dsh/agent", "run", "verify:dsh"], { env });
      run(process.execPath, ["scripts/verify-dsh-coexistence.mjs"], { env });
    }
    results.push({
      version: release.version,
      dshPackages: packages.length,
      standardCompositionSha256: standardDigest,
      pureGraph: true,
      mode: options.pluginTgz ? "installed-artifacts" : "source",
    });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ dshRange: document.dshRange, sourceDshVersion: document.sourceDshVersion, releases: results, verified: true }, null, 2)}\n`);

function parseArguments(arguments_) {
  const versions = [];
  let pluginTgz;
  let agentTgz;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--version") versions.push(requiredValue(arguments_, ++index, argument));
    else if (argument === "--plugin-tgz") pluginTgz = resolve(requiredValue(arguments_, ++index, argument));
    else if (argument === "--agent-tgz") agentTgz = resolve(requiredValue(arguments_, ++index, argument));
    else throw new Error(`unknown argument ${argument}`);
  }
  if (Boolean(pluginTgz) !== Boolean(agentTgz)) throw new Error("--plugin-tgz and --agent-tgz must be provided together");
  return { versions, pluginTgz, agentTgz };
}

function requiredValue(arguments_, index, option) {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function validateRelease(release) {
  if (!release || typeof release.version !== "string"
    || !satisfies(release.version, document.dshRange)
    || typeof release.publishedBefore !== "string"
    || !Number.isSafeInteger(release.expectedDshPackages)
    || release.expectedDshPackages <= 0
    || typeof release.standardCompositionPath !== "string"
    || release.standardCompositionPath.startsWith("/")
    || release.standardCompositionPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || !/^[a-f0-9]{64}$/u.test(release.standardCompositionSha256)) {
    throw new Error(`invalid DSH release contract ${JSON.stringify(release)}`);
  }
}

function run(command, arguments_, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, arguments_, {
    cwd: repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? [result.stderr, result.stdout].filter(Boolean).join("\n").trim() : "";
    throw new Error(`${command} ${arguments_.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout.trim() : "";
}

async function dshPackages(root) {
  const packages = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "package.json") {
        const packageJson = JSON.parse(await readFile(path, "utf8"));
        if (typeof packageJson.name === "string" && packageJson.name.startsWith("@deepseek-ai/dsh")) {
          packages.push({ name: packageJson.name, version: packageJson.version });
        }
      }
    }
  };
  await visit(root);
  return packages;
}
