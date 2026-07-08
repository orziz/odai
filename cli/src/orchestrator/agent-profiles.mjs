import { redactString, redactUrl } from "../runtime/redaction.mjs";

const ALLOWED_TOOL_MODES = new Set(["none", "read_only", "virtual_patch_only"]);

export function createDefaultAgentProfiles() {
  const profiles = new Map();
  for (const profile of [
    {
      name: "reviewer",
      purpose: "code_review",
      tools: "read_only",
      providerRequirements: ["code"],
      allowedOutputs: ["findings", "risks", "questions"],
      source: "built-in",
    },
    {
      name: "challenger",
      purpose: "independent_challenge",
      tools: "none",
      providerRequirements: ["reasoning"],
      allowedOutputs: ["counterexamples", "missing_cases", "alternative_paths"],
      source: "built-in",
    },
    {
      name: "implementer_candidate",
      purpose: "candidate_patch",
      tools: "virtual_patch_only",
      providerRequirements: ["code"],
      allowedOutputs: ["unified_diff", "rationale", "test_plan"],
      source: "built-in",
    },
    {
      name: "bulk_reader",
      purpose: "large_context_summary",
      tools: "read_only",
      providerRequirements: ["long_context"],
      allowedOutputs: ["evidence_summary", "file_map"],
      source: "built-in",
    },
  ]) {
    const normalized = normalizeAgentProfile(profile);
    profiles.set(normalized.name, normalized);
  }
  return profiles;
}

export function normalizeAgentProfile(profile = {}, baseProfile = {}) {
  const name = normalizeProfileName(profile.name || baseProfile.name);
  const tools = normalizeToolMode(profile.tools ?? baseProfile.tools ?? "none", name);
  return {
    name,
    purpose: normalizeOptionalString(profile.purpose ?? baseProfile.purpose ?? "", "purpose", name),
    tools,
    providerRequirements: normalizeStringArray(
      profile.providerRequirements ?? profile.provider_requirements ?? baseProfile.providerRequirements ?? [],
      "providerRequirements",
      name,
    ),
    allowedOutputs: normalizeStringArray(
      profile.allowedOutputs ?? profile.allowed_outputs ?? baseProfile.allowedOutputs ?? [],
      "allowedOutputs",
      name,
    ),
    source: normalizeOptionalString(profile.source ?? baseProfile.source ?? "workspace", "source", name),
  };
}

export function describeAgentProfiles(profileMap) {
  return {
    profiles: [...profileMap.values()].map((profile) => ({
      name: publicProfileValue(profile.name),
      purpose: publicProfileValue(profile.purpose),
      tools: profile.tools,
      providerRequirements: profile.providerRequirements,
      allowedOutputs: profile.allowedOutputs,
      source: publicProfileValue(profile.source),
    })),
    ...(Array.isArray(profileMap.configErrors) && profileMap.configErrors.length > 0
      ? { configErrors: profileMap.configErrors.map(publicAgentConfigError) }
      : {}),
  };
}

function publicAgentConfigError(error = {}) {
  if (!error || typeof error !== "object") {
    return { message: publicProfileValue(String(error)) };
  }
  const result = {};
  for (const key of ["file", "field", "message"]) {
    if (error[key] !== undefined) {
      result[key] = publicProfileValue(error[key]);
    }
  }
  return result;
}

function publicProfileValue(value) {
  return typeof value === "string" ? redactString(redactUrl(value)) : value;
}

function normalizeProfileName(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Agent profile requires a non-empty name.");
  }
  const name = value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid agent profile name: ${name}`);
  }
  return name;
}

function normalizeToolMode(value, name) {
  if (typeof value !== "string") {
    throw new Error(`Agent profile '${name}' tools must be a string.`);
  }
  const tools = value.trim();
  if (!ALLOWED_TOOL_MODES.has(tools)) {
    throw new Error(
      `Agent profile '${name}' uses unsupported tools '${tools}'. Supported tools: ${[...ALLOWED_TOOL_MODES].join(", ")}.`,
    );
  }
  return tools;
}

function normalizeStringArray(value, fieldName, profileName) {
  if (!Array.isArray(value)) {
    throw new Error(`Agent profile '${profileName}' ${fieldName} must be an array.`);
  }
  const normalized = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`Agent profile '${profileName}' ${fieldName} must contain only non-empty strings.`);
    }
    const next = item.trim();
    if (!normalized.includes(next)) {
      normalized.push(next);
    }
  }
  return normalized;
}

function normalizeOptionalString(value, fieldName, profileName) {
  if (typeof value !== "string") {
    throw new Error(`Agent profile '${profileName}' ${fieldName} must be a string.`);
  }
  return value.trim();
}
