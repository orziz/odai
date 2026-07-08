import { readFileSync } from "node:fs";
import path from "node:path";
import { redactString, redactUrl } from "../runtime/redaction.mjs";
import { normalizeShellSandboxConfig } from "../runtime/sandbox-adapter.mjs";

const DEFAULT_POLICY = {
  shell: {
    allowExecution: false,
    allowedCommands: [],
    sandbox: {
      mode: "none",
    },
  },
  network: {
    allowRequests: false,
    allowedHosts: [],
    timeoutMs: 10000,
  },
};

export function loadWorkspacePolicyConfig({ workspaceRoot }) {
  const filePath = path.join(workspaceRoot, ".odai", "policy.json");
  try {
    return normalizePolicy(JSON.parse(readFileSync(filePath, "utf8")), filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaultPolicy();
    }
    return withConfigErrors(defaultPolicy(), [
      policyConfigError(filePath, undefined, `Failed to read policy config: ${error.message}`),
    ]);
  }
}

function normalizePolicy(policy = {}, filePath) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return withConfigErrors(defaultPolicy(), [
      policyConfigError(filePath, undefined, "Policy config must be a JSON object."),
    ]);
  }

  const shell = normalizeShellPolicy(policy.shell, { errors, filePath });
  const network = normalizeNetworkPolicy(policy.network, { errors, filePath });
  const normalized = { shell, network };
  return errors.length > 0 ? withConfigErrors(normalized, errors) : normalized;
}

function normalizeShellPolicy(shell, { errors, filePath }) {
  if (shell === undefined) {
    return defaultPolicy().shell;
  }
  const sectionErrors = [];
  if (!shell || typeof shell !== "object" || Array.isArray(shell)) {
    sectionErrors.push(policyConfigError(filePath, "shell", "Policy field 'shell' must be an object."));
    errors.push(...sectionErrors);
    return defaultPolicy().shell;
  }

  const allowExecution = normalizeBoolean(shell.allowExecution, {
    field: "shell.allowExecution",
    filePath,
    errors: sectionErrors,
    fallback: DEFAULT_POLICY.shell.allowExecution,
  });
  const allowedCommands = normalizeStringArray(shell.allowedCommands, {
    field: "shell.allowedCommands",
    filePath,
    errors: sectionErrors,
    fallback: DEFAULT_POLICY.shell.allowedCommands,
  });
  let sandbox = defaultPolicy().shell.sandbox;
  try {
    sandbox = normalizeShellSandboxConfig(shell.sandbox || DEFAULT_POLICY.shell.sandbox);
  } catch (error) {
    sectionErrors.push(
      policyConfigError(
        filePath,
        "shell.sandbox",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  if (sectionErrors.length > 0) {
    errors.push(...sectionErrors);
    return defaultPolicy().shell;
  }
  return {
    allowExecution,
    allowedCommands,
    sandbox,
  };
}

function normalizeNetworkPolicy(network, { errors, filePath }) {
  if (network === undefined) {
    return defaultPolicy().network;
  }
  const sectionErrors = [];
  if (!network || typeof network !== "object" || Array.isArray(network)) {
    sectionErrors.push(policyConfigError(filePath, "network", "Policy field 'network' must be an object."));
    errors.push(...sectionErrors);
    return defaultPolicy().network;
  }

  const allowRequests = normalizeBoolean(network.allowRequests, {
    field: "network.allowRequests",
    filePath,
    errors: sectionErrors,
    fallback: DEFAULT_POLICY.network.allowRequests,
  });
  const allowedHosts = normalizeStringArray(network.allowedHosts, {
    field: "network.allowedHosts",
    filePath,
    errors: sectionErrors,
    fallback: DEFAULT_POLICY.network.allowedHosts,
  });
  const timeoutMs = normalizePositiveNumber(network.timeoutMs, {
    field: "network.timeoutMs",
    filePath,
    errors: sectionErrors,
    fallback: DEFAULT_POLICY.network.timeoutMs,
  });

  if (sectionErrors.length > 0) {
    errors.push(...sectionErrors);
    return defaultPolicy().network;
  }
  return {
    allowRequests,
    allowedHosts,
    timeoutMs,
  };
}

function normalizeBoolean(value, { field, filePath, errors, fallback }) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  errors.push(policyConfigError(filePath, field, `Policy field '${field}' must be a boolean.`));
  return fallback;
}

function normalizeStringArray(value, { field, filePath, errors, fallback }) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    errors.push(policyConfigError(filePath, field, `Policy field '${field}' must be an array of strings.`));
    return [...fallback];
  }
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || !item.trim()) {
      errors.push(
        policyConfigError(
          filePath,
          `${field}[${index}]`,
          `Policy field '${field}[${index}]' must be a non-empty string.`,
        ),
      );
      continue;
    }
    normalized.push(item);
  }
  return normalized;
}

function normalizePositiveNumber(value, { field, filePath, errors, fallback }) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  errors.push(policyConfigError(filePath, field, `Policy field '${field}' must be a positive number.`));
  return fallback;
}

function defaultPolicy() {
  return structuredClone(DEFAULT_POLICY);
}

function withConfigErrors(policy, errors) {
  return {
    ...policy,
    configErrors: errors,
  };
}

function policyConfigError(file, field, message) {
  const error = field
    ? { field: publicConfigValue(field), message: publicConfigValue(message) }
    : { message: publicConfigValue(message) };
  if (file) error.file = publicConfigValue(file);
  return error;
}

function publicConfigValue(value) {
  return typeof value === "string" ? redactString(redactUrl(value)) : value;
}
