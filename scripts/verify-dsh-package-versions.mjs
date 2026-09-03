#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { satisfies, validRange } from "semver";

import { assertRepositoryVersionPolicy } from "./version-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assertRepositoryVersionPolicy({ repoRoot });
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const packages = [
  readPackage("dsh/plugin/package.json", "odai-dsh-plugin", "plugin"),
  readPackage("dsh/agent/package.json", "odai-dsh-agent", "agent"),
];
const versions = new Set(packages.map((entry) => entry.version));
const dshRanges = new Set(packages.map((entry) => entry.dshRange));

if (versions.size !== 1) {
  throw new Error(`DSH package versions must match: ${packages.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
}
if (dshRanges.size !== 1) {
  throw new Error(`DSH peer ranges must match: ${packages.map((entry) => `${entry.name}=>${entry.dshRange}`).join(", ")}`);
}

const matrix = readCompatibilityMatrix();
const packageVersion = packages[0].version;
const release = matrix.releases.get(packageVersion);
if (!release) {
  throw new Error(`dsh/compatibility.json must map package version ${packageVersion}`);
}
const currentSurfaces = packages.map((entry) => entry.surface).sort();
if (JSON.stringify([...release.surfaces].sort()) !== JSON.stringify(currentSurfaces)) {
  throw new Error(`DSH package ${packageVersion} must map surfaces ${currentSurfaces.join(", ")}, found ${release.surfaces.join(", ")}`);
}
if (packages[0].dshRange !== release.dshRange) {
  throw new Error(`DSH package ${packageVersion} peer must match compatibility matrix: expected ${release.dshRange}, found ${packages[0].dshRange}`);
}
const releaseContracts = readReleaseContracts();
if (releaseContracts.dshRange !== release.dshRange
  || releaseContracts.sourceDshVersion !== release.sourceDshVersion
  || JSON.stringify(releaseContracts.dshVersions) !== JSON.stringify(release.dshVersions)) {
  throw new Error(`dsh/release-contracts.json must match the ${packageVersion} range, source, and tested anchors`);
}

process.stdout.write(`DSH package versions match: ${packageVersion}; peer @deepseek-ai/dsh ${release.dshRange}; tested ${release.dshVersions.join(", ")}; compatibility matrix verified\n`);

function readPackage(relativePath, expectedName, surface) {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
  if (packageJson.name !== expectedName) {
    throw new Error(`${relativePath} must declare package name ${expectedName}`);
  }
  if (!VERSION_PATTERN.test(packageJson.version)) {
    throw new Error(`${relativePath} has an invalid version: ${packageJson.version || "(missing)"}`);
  }
  const dshRange = packageJson.peerDependencies?.["@deepseek-ai/dsh"];
  if (typeof dshRange !== "string" || validRange(dshRange) === null) {
    throw new Error(`${relativePath} must declare a valid @deepseek-ai/dsh SemVer range, found: ${dshRange || "(missing)"}`);
  }
  return { name: packageJson.name, version: packageJson.version, dshRange, surface };
}

function readReleaseContracts() {
  const relativePath = "dsh/release-contracts.json";
  const document = JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
  if (document.schemaVersion !== 2
    || typeof document.dshRange !== "string"
    || validRange(document.dshRange) === null
    || !VERSION_PATTERN.test(document.sourceDshVersion)
    || !Array.isArray(document.releases)
    || document.releases.length === 0) {
    throw new Error(`${relativePath} must declare schemaVersion 2, a valid range and source, and non-empty releases`);
  }
  const versions = document.releases.map((release, index) => {
    const label = `${relativePath} releases[${index}]`;
    if (!release || !VERSION_PATTERN.test(release.version)
      || !satisfies(release.version, document.dshRange)
      || typeof release.publishedBefore !== "string"
      || !Number.isSafeInteger(release.expectedDshPackages)
      || release.expectedDshPackages <= 0
      || typeof release.standardCompositionPath !== "string"
      || release.standardCompositionPath.startsWith("/")
      || release.standardCompositionPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      || typeof release.standardCompositionSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(release.standardCompositionSha256)) {
      throw new Error(`${label} is invalid or outside ${document.dshRange}`);
    }
    return release.version;
  });
  if (new Set(versions).size !== versions.length) throw new Error(`${relativePath} must list unique releases`);
  if (!versions.includes(document.sourceDshVersion)) throw new Error(`${relativePath} sourceDshVersion must be a tested release`);
  return { dshRange: document.dshRange, sourceDshVersion: document.sourceDshVersion, dshVersions: versions };
}

function readCompatibilityMatrix() {
  const relativePath = "dsh/compatibility.json";
  const document = JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
  if (document.schemaVersion !== 1) {
    throw new Error(`${relativePath} must use schemaVersion 1`);
  }
  for (const entry of packages) {
    if (document.packageNames?.[entry.surface] !== entry.name) {
      throw new Error(`${relativePath} must map ${entry.surface} to ${entry.name}`);
    }
  }
  if (!Array.isArray(document.compatibility) || document.compatibility.length === 0) {
    throw new Error(`${relativePath} must declare a non-empty compatibility array`);
  }

  const allowedSurfaces = new Set(packages.map((entry) => entry.surface));
  const releases = new Map();
  for (const [index, entry] of document.compatibility.entries()) {
    const label = `${relativePath} compatibility[${index}]`;
    const packageVersions = entry?.packageVersions;
    const surfaces = entry?.surfaces;
    const exactDshVersions = entry?.dshVersions;
    if (!Array.isArray(packageVersions) || packageVersions.length === 0
      || new Set(packageVersions).size !== packageVersions.length
      || packageVersions.some((version) => !VERSION_PATTERN.test(version))) {
      throw new Error(`${label} must list unique exact packageVersions`);
    }
    if (!Array.isArray(surfaces) || surfaces.length === 0
      || new Set(surfaces).size !== surfaces.length
      || surfaces.some((surface) => !allowedSurfaces.has(surface))) {
      throw new Error(`${label} must list unique known surfaces`);
    }
    if (!Array.isArray(exactDshVersions) || exactDshVersions.length === 0
      || new Set(exactDshVersions).size !== exactDshVersions.length
      || exactDshVersions.some((version) => !VERSION_PATTERN.test(version))) {
      throw new Error(`${label} must list unique exact dshVersions`);
    }
    const dshRange = entry.dshRange ?? exactDshVersions.join(" || ");
    const sourceDshVersion = entry.sourceDshVersion ?? exactDshVersions.at(-1);
    if (typeof dshRange !== "string" || validRange(dshRange) === null
      || exactDshVersions.some((version) => !satisfies(version, dshRange))) {
      throw new Error(`${label} must declare a valid dshRange containing every tested version`);
    }
    if (!exactDshVersions.includes(sourceDshVersion)) {
      throw new Error(`${label} sourceDshVersion must be a tested version`);
    }
    for (const version of packageVersions) {
      if (releases.has(version)) {
        throw new Error(`${relativePath} maps package version ${version} more than once`);
      }
      releases.set(version, { surfaces: [...surfaces], dshRange, dshVersions: [...exactDshVersions], sourceDshVersion });
    }
  }
  return { releases };
}
