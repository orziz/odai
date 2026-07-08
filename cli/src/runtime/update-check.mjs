import { readFile } from "node:fs/promises";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 1200;
const packageJsonUrl = new URL("../../package.json", import.meta.url);

let cachedPackageMetadata;

export async function readRuntimePackageMetadata({ readFileImpl = readFile } = {}) {
  if (cachedPackageMetadata) return cachedPackageMetadata;
  const text = await readFileImpl(packageJsonUrl, "utf8");
  const parsed = JSON.parse(text);
  cachedPackageMetadata = {
    name: parsed.name,
    version: parsed.version,
  };
  return cachedPackageMetadata;
}

export function shouldRunStartupUpdateCheck({
  env = process.env,
  outputIsTTY = process.stdout.isTTY,
  now = Date.now(),
} = {}) {
  if (!outputIsTTY) return false;
  if (disabledFlag(env?.ODAI_DISABLE_UPDATE_CHECK) || disabledFlag(env?.ODAI_NO_UPDATE_CHECK)) return false;
  const intervalMs = parseUpdateIntervalMs(env?.ODAI_UPDATE_CHECK_INTERVAL_MS);
  if (intervalMs <= 0) return true;
  const lastCheckedAt = Number(env?.ODAI_LAST_UPDATE_CHECK_AT || 0);
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;
  return now - lastCheckedAt >= intervalMs;
}

export async function checkForPackageUpdate({
  packageName = "odai-cli",
  currentVersion,
  registryUrl = DEFAULT_REGISTRY_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!packageName || !currentVersion) {
    return { status: "skipped", reason: "missing_package_metadata" };
  }
  if (typeof fetchImpl !== "function") {
    return { status: "skipped", reason: "fetch_unavailable" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const latestVersion = await fetchLatestPackageVersion({
      packageName,
      registryUrl,
      fetchImpl,
      signal: controller.signal,
    });
    if (!latestVersion) {
      return { status: "blocked", reason: "latest_version_missing" };
    }
    const comparison = compareSemver(latestVersion, currentVersion);
    if (comparison > 0) {
      return {
        status: "available",
        packageName,
        currentVersion,
        latestVersion,
        installCommand: `npm install -g ${packageName}`,
      };
    }
    return {
      status: "current",
      packageName,
      currentVersion,
      latestVersion,
    };
  } catch (error) {
    return {
      status: "blocked",
      reason: error?.name === "AbortError" ? "timeout" : "fetch_failed",
      error: error?.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLatestPackageVersion({
  packageName = "odai-cli",
  registryUrl = DEFAULT_REGISTRY_URL,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const base = String(registryUrl || DEFAULT_REGISTRY_URL).replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(packageName)}/latest`;
  const response = await fetchImpl(url, {
    signal,
    headers: {
      accept: "application/json",
    },
  });
  if (!response?.ok) {
    return undefined;
  }
  const body = await response.json();
  return typeof body?.version === "string" ? body.version : undefined;
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] > b.core[index]) return 1;
    if (a.core[index] < b.core[index]) return -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined && rightPart === undefined) return 0;
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = numericIdentifier(leftPart);
    const rightNumber = numericIdentifier(rightPart);
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber > rightNumber) return 1;
      if (leftNumber < rightNumber) return -1;
      continue;
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function parseSemver(value) {
  const [versionPart, prereleasePart = ""] = String(value || "0.0.0").trim().replace(/^v/i, "").split("-", 2);
  const core = versionPart
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  while (core.length < 3) core.push(0);
  return {
    core,
    prerelease: prereleasePart ? prereleasePart.split(".").filter(Boolean) : [],
  };
}

function numericIdentifier(value) {
  if (!/^(0|[1-9]\d*)$/.test(String(value))) return undefined;
  return Number.parseInt(value, 10);
}

function disabledFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseUpdateIntervalMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
