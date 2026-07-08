import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createDefaultAgentProfiles,
  describeAgentProfiles,
  normalizeAgentProfile,
} from "../orchestrator/agent-profiles.mjs";
import { redactString, redactUrl } from "../runtime/redaction.mjs";

export function loadWorkspaceAgentProfiles({ workspaceRoot }) {
  const profiles = createDefaultAgentProfiles();
  const filePath = path.join(workspaceRoot, ".odai", "agents.json");
  let config;
  try {
    config = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return profiles;
    }
    profiles.configErrors = [
      agentConfigError(filePath, undefined, `Failed to read agent config: ${error.message}`),
    ];
    return profiles;
  }

  const normalizedConfig = normalizeWorkspaceAgentConfig(config, filePath);
  if (normalizedConfig.errors.length > 0) {
    profiles.configErrors = normalizedConfig.errors;
  }

  for (const configuredProfile of normalizedConfig.profiles) {
    try {
      const baseProfile = profiles.get(configuredProfile.name);
      const normalized = normalizeAgentProfile(
        {
          ...configuredProfile,
          source: "workspace",
        },
        baseProfile,
      );
      profiles.set(normalized.name, normalized);
    } catch (error) {
      profiles.configErrors ||= [];
      profiles.configErrors.push(
        agentConfigError(
          filePath,
          `agents.${configuredProfile.name || "unknown"}`,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return profiles;
}

export function describeWorkspaceAgentProfiles({ workspaceRoot }) {
  return describeAgentProfiles(loadWorkspaceAgentProfiles({ workspaceRoot }));
}

function normalizeWorkspaceAgentConfig(config = {}, filePath) {
  const profiles = [];
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      profiles,
      errors: [agentConfigError(filePath, undefined, "Agent config must be a JSON object.")],
    };
  }
  if (config.agents === undefined) {
    return { profiles, errors };
  }
  if (Array.isArray(config.agents)) {
    for (let index = 0; index < config.agents.length; index += 1) {
      const profile = config.agents[index];
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        errors.push(agentConfigError(filePath, `agents[${index}]`, `Agent config agents[${index}] must be an object.`));
        continue;
      }
      profiles.push(profile);
    }
    return { profiles, errors };
  }
  if (config.agents && typeof config.agents === "object") {
    for (const [name, profile] of Object.entries(config.agents)) {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        errors.push(agentConfigError(filePath, `agents.${name}`, `Agent config agents.${name} must be an object.`));
        continue;
      }
      if (profile.name !== undefined && profile.name !== name) {
        errors.push(
          agentConfigError(
            filePath,
            `agents.${name}.name`,
            `Agent config agents.${name} cannot override name with '${profile.name}'.`,
          ),
        );
        continue;
      }
      profiles.push({
        ...profile,
        name,
      });
    }
    return { profiles, errors };
  }
  return {
    profiles,
    errors: [agentConfigError(filePath, "agents", "Agent config field 'agents' must be an array or object.")],
  };
}

function agentConfigError(file, field, message) {
  return field
    ? {
        file: publicConfigValue(file),
        field: publicConfigValue(field),
        message: publicConfigValue(message),
      }
    : {
        file: publicConfigValue(file),
        message: publicConfigValue(message),
      };
}

function publicConfigValue(value) {
  return typeof value === "string" ? redactString(redactUrl(value)) : value;
}
