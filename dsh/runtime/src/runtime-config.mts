import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIGURABLE_ROLES, resolveRoleDispatch, resolveRoleRoute, resolveRoutingConfigPath } from "./routing-config.mjs";
import { resolveOutputConfigPath } from "./output-config.mjs";
import { resolveCompactionConfigPath } from "./compaction-config.mjs";
import { resolveSkillSourceConfigPath } from "./skill-source-config.mjs";
import { SKILL_SOURCE_MODES } from "./skill-bundle.mjs";
import { MEMORY_MODES, resolveMemoryStorePath } from "./semantic-memory-store.mjs";
import type { ModelRoute, RuntimeConfig, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

interface CompactionRequestOptions extends UnknownRecord {
  purpose?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  cacheRetention?: string;
}

interface SessionRouteStore {
  get(sessionId: string): {
    requestHeader?(): { config?: ModelRoute };
  } | undefined;
}

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTING_MODES = new Set(["off", "observe", "auto", "execute"]);
const COMPACTION_CACHE_RETENTIONS = new Set(["provider-default", "short", "long", "none"]);
export const ROUTED_ROLES = CONFIGURABLE_ROLES;
const DEFAULT_ROUTING_MODE = "auto";

function isRoutingMode(value: unknown): value is RuntimeConfig["routing"]["mode"] {
  return typeof value === "string" && ROUTING_MODES.has(value);
}

function isMemoryMode(value: unknown): value is RuntimeConfig["memory"]["mode"] {
  return typeof value === "string" && (MEMORY_MODES as readonly string[]).includes(value);
}

function isCacheRetention(value: unknown): value is RuntimeConfig["compaction"]["cacheRetention"] {
  return typeof value === "string" && COMPACTION_CACHE_RETENTIONS.has(value);
}

function isSkillSource(value: unknown): value is RuntimeConfig["governance"]["skillSource"] {
  return typeof value === "string" && (SKILL_SOURCE_MODES as readonly string[]).includes(value);
}

function assertPlainObject(value: unknown, field: string): UnknownRecord {
  if (value === undefined) return {};
  if (!isUnknownRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

export function resolveConfig(rawConfig: unknown = {}): RuntimeConfig {
  const raw = assertPlainObject(rawConfig, "config");
  const routing = assertPlainObject(raw.routing, "config.routing");
  const roles = assertPlainObject(routing.roles, "config.routing.roles");
  const dispatch = assertPlainObject(routing.dispatch, "config.routing.dispatch");
  const governance = assertPlainObject(raw.governance, "config.governance");
  const output = assertPlainObject(raw.output, "config.output");
  const compaction = assertPlainObject(raw.compaction, "config.compaction");
  const memory = assertPlainObject(raw.memory, "config.memory");
  const mode = routing.mode ?? DEFAULT_ROUTING_MODE;
  const provider = routing.provider ?? "spawn";
  const maxInputChars = routing.maxInputChars ?? 12_000;
  const configPath = resolveRoutingConfigPath(routing.configPath);
  const additionalDeniedTools = governance.additionalDeniedTools ?? [];
  const skillSource = governance.skillSource ?? "bundled";
  const skillConfigPath = resolveSkillSourceConfigPath(governance.skillConfigPath);
  const outputConfigPath = resolveOutputConfigPath(output.configPath);
  const compactionConfigPath = resolveCompactionConfigPath(compaction.configPath);
  const memoryStorePath = resolveMemoryStorePath(memory.storePath);
  const memoryMode = memory.mode ?? "auto";
  const memoryMaxRetrieved = memory.maxRetrieved ?? 6;
  const compactionCacheRetention = compaction.cacheRetention
    ?? process.env.ODAI_COMPACTION_CACHE_RETENTION
    ?? "provider-default";
  const unknownRoles = Object.keys(roles).filter((role) => !(ROUTED_ROLES as readonly string[]).includes(role));
  const unknownDispatchRoles = Object.keys(dispatch).filter((role) => !(ROUTED_ROLES as readonly string[]).includes(role));
  const unknownOutputFields = Object.keys(output).filter((field) => field !== "configPath");
  const unknownCompactionFields = Object.keys(compaction).filter((field) => !["cacheRetention", "configPath"].includes(field));
  const unknownMemoryFields = Object.keys(memory).filter((field) => !["mode", "storePath", "maxRetrieved"].includes(field));

  if (!isRoutingMode(mode)) {
    throw new TypeError("config.routing.mode must be off, observe, auto, or execute");
  }
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new TypeError("config.routing.provider must be a non-empty string");
  }
  if (typeof maxInputChars !== "number" || !Number.isSafeInteger(maxInputChars) || maxInputChars < 256) {
    throw new TypeError("config.routing.maxInputChars must be an integer of at least 256");
  }
  if (unknownRoles.length > 0) {
    throw new TypeError(`config.routing.roles has unknown roles: ${unknownRoles.join(", ")}`);
  }
  if (unknownDispatchRoles.length > 0) {
    throw new TypeError(`config.routing.dispatch has unknown roles: ${unknownDispatchRoles.join(", ")}`);
  }
  if (unknownOutputFields.length > 0) {
    throw new TypeError(`config.output has unknown fields: ${unknownOutputFields.join(", ")}`);
  }
  if (unknownCompactionFields.length > 0) {
    throw new TypeError(`config.compaction has unknown fields: ${unknownCompactionFields.join(", ")}`);
  }
  if (unknownMemoryFields.length > 0) {
    throw new TypeError(`config.memory has unknown fields: ${unknownMemoryFields.join(", ")}`);
  }
  if (!isMemoryMode(memoryMode)) {
    throw new TypeError("config.memory.mode must be auto or off");
  }
  if (typeof memoryMaxRetrieved !== "number" || !Number.isSafeInteger(memoryMaxRetrieved) || memoryMaxRetrieved < 1 || memoryMaxRetrieved > 12) {
    throw new TypeError("config.memory.maxRetrieved must be an integer from 1 to 12");
  }
  if (!isCacheRetention(compactionCacheRetention)) {
    throw new TypeError("config.compaction.cacheRetention must be provider-default, short, long, or none");
  }
  if (!Array.isArray(additionalDeniedTools)
    || additionalDeniedTools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw new TypeError("config.governance.additionalDeniedTools must be an array of non-empty strings");
  }
  if (!isSkillSource(skillSource)) {
    throw new TypeError("config.governance.skillSource must be bundled, auto, or user");
  }
  if (raw.skillPath !== undefined && (typeof raw.skillPath !== "string" || raw.skillPath.trim() === "")) {
    throw new TypeError("config.skillPath must be a non-empty string");
  }

  const deniedTools = additionalDeniedTools as string[];
  return Object.freeze({
    skillPath: raw.skillPath,
    routing: Object.freeze({
      mode,
      provider: provider.trim(),
      maxInputChars,
      configPath,
      roles: Object.freeze(Object.fromEntries(ROUTED_ROLES.map((role) => [
        role,
        resolveRoleRoute(roles[role], role),
      ]))),
      dispatch: Object.freeze(Object.fromEntries(ROUTED_ROLES.map((role) => [
        role,
        resolveRoleDispatch(dispatch[role], role),
      ]))),
    }),
    governance: Object.freeze({
      additionalDeniedTools: Object.freeze(deniedTools.map((tool) => tool.trim())),
      skillSource,
      skillConfigPath,
    }),
    output: Object.freeze({ configPath: outputConfigPath }),
    compaction: Object.freeze({
      cacheRetention: compactionCacheRetention,
      configPath: compactionConfigPath,
    }),
    memory: Object.freeze({
      mode: memoryMode,
      storePath: memoryStorePath,
      maxRetrieved: memoryMaxRetrieved,
    }),
  });
}

/** Mutate exact-route compaction options; returns true only when an option changed. */
export function inheritCompactionReasoning(
  options: CompactionRequestOptions,
  sessions: SessionRouteStore | undefined,
  cacheRetention: RuntimeConfig["compaction"]["cacheRetention"] = "provider-default",
): boolean {
  if (options?.purpose !== "compaction"
    || options.sessionId === undefined
    || !Object.isExtensible(options)) {
    return false;
  }

  const route = sessions?.get?.(options.sessionId)?.requestHeader?.()?.config;
  if (!route
    || route.provider !== options.provider
    || route.model !== options.model
    || typeof route.reasoningEffort !== "string"
    || route.reasoningEffort.length === 0) {
    return false;
  }

  let changed = false;
  if (options.reasoningEffort === undefined) {
    options.reasoningEffort = route.reasoningEffort;
    changed = true;
  }
  if (options.cacheRetention === undefined && cacheRetention !== "provider-default") {
    options.cacheRetention = cacheRetention;
    changed = true;
  }
  return changed;
}

export function resolveSkillPath(configuredPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = configuredPath ?? env.ODAI_SKILL_PATH;
  if (explicit !== undefined) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new Error(`explicit Odai canonical skill not found: ${path}`);
    return path;
  }

  const candidates = [
    resolve(PLUGIN_DIR, "skills/odai/SKILL.md"),
    resolve(PLUGIN_DIR, "../../skills/odai/SKILL.md"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(`Odai bundled canonical skill not found; checked: ${candidates.join(", ")}`);
}
