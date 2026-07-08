import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeLanguage } from "../runtime/i18n.mjs";
import {
  normalizeReasoningDepth,
  parseContextWindowTokens,
} from "../runtime/model-options.mjs";

const PREFERENCES_VERSION = 1;

export async function loadWorkspacePreferences({ workspaceRoot = process.cwd() } = {}) {
  const filePath = preferencesPath(workspaceRoot);
  try {
    const text = await readFile(filePath, "utf8");
    return normalizeWorkspacePreferences(JSON.parse(text));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    return {};
  }
}

export async function writeWorkspacePreferences({ workspaceRoot = process.cwd(), preferences = {} } = {}) {
  const normalized = normalizeWorkspacePreferences(preferences);
  const filePath = preferencesPath(workspaceRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ version: PREFERENCES_VERSION, ...normalized }, null, 2)}\n`, "utf8");
  return normalized;
}

export function mergeWorkspacePreferences(current = {}, patch = {}) {
  return normalizeWorkspacePreferences({
    ...current,
    ...patch,
  });
}

export function normalizeWorkspacePreferences(value = {}) {
  const result = {};
  const language = normalizeLanguage(value.language, "");
  if (language) result.language = language;

  if (typeof value.provider === "string" && value.provider.trim()) {
    result.provider = value.provider.trim();
  }

  if (typeof value.model === "string" && value.model.trim()) {
    result.model = value.model.trim();
  }

  const reasoning = normalizePreferenceReasoning(value.reasoning);
  if (reasoning) result.reasoning = reasoning;

  const contextWindowTokens = normalizePreferenceContextWindow(value.contextWindowTokens ?? value.context);
  if (Number.isFinite(contextWindowTokens)) result.contextWindowTokens = contextWindowTokens;

  if (value.auth && typeof value.auth === "object") {
    result.auth = {
      useApiKey: Boolean(value.auth.useApiKey),
      useProviderCommand: Boolean(value.auth.useProviderCommand),
      providerCommands: normalizeProviderCommandPreferences(value.auth.providerCommands),
    };
  }

  return result;
}

export function preferencesPath(workspaceRoot = process.cwd()) {
  return path.join(workspaceRoot, ".odai", "preferences.json");
}

function normalizePreferenceReasoning(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const normalized = normalizeReasoningDepth(value);
    return normalized === "auto" ? undefined : normalized;
  } catch {
    return undefined;
  }
}

function normalizePreferenceContextWindow(value) {
  if (value === undefined || value === null || value === "" || value === "auto") return undefined;
  if (Number.isFinite(value)) return value;
  try {
    return parseContextWindowTokens(value);
  } catch {
    return undefined;
  }
}

function normalizeProviderCommandPreferences(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(
    items
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )].sort();
}
