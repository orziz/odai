import { describeWorkspaceAgentProfiles } from "../config/agent-config.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadWorkspaceEnvironment,
  loadWorkspaceProviderConfig,
  publicProviderSource,
} from "../config/provider-config.mjs";
import { redactString } from "../runtime/redaction.mjs";
import {
  appendUnique,
  optionToken,
  applyProviderCommandOption,
  normalizeProviderCommandProviders,
  enabledFlagValue,
} from "./cli-args.mjs";

const defaultRepoRoot = process.cwd();
export function runAgents({ repoRoot: root = defaultRepoRoot, argv = [], env = process.env } = {}) {
  const args = parseAgentsArgs(argv);
  const description = describeWorkspaceAgentProfiles({ workspaceRoot: root });
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: root });
  const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    allowedProviderCommands: args.providerCommandProviders,
    config: providerConfig,
  });
  const providers = describeProviders(registry, workspaceEnv).providers || [];
  return {
    ...description,
    flags: {
      useApiKey: args.useApiKey,
      useProviderCommand: args.useProviderCommand,
      providerCommandProviders: args.providerCommandProviders,
      mainProvider: args.mainProvider ? redactString(args.mainProvider) : undefined,
      excludeProviderNames: args.excludeProviderNames.map(redactString),
    },
    routing: description.profiles.map((profile) =>
      agentRoutingSummary({
        profile,
        providers,
        excludeProviderNames: args.excludeProviderNames,
      }),
    ),
  };
}


function agentRoutingSummary({ profile = {}, providers = [], excludeProviderNames = [] } = {}) {
  const requirements = Array.isArray(profile.providerRequirements) ? profile.providerRequirements : [];
  const excluded = new Set(excludeProviderNames);
  const candidates = providers
    .filter((provider) => requirements.every((capability) => (provider.capabilities || []).includes(capability)))
    .map((provider) => publicProviderRoutingCandidate(provider, { excluded: excluded.has(provider.name) }));
  const effectiveCandidates = candidates.filter((provider) => !provider.excluded);
  const available = effectiveCandidates.filter((provider) => provider.available);
  const nonMockAvailable = available.filter((provider) => provider.kind !== "mock");
  const selected = selectAutoProviderSummary({ available, nonMockAvailable });
  return {
    profile: profile.name,
    requirements,
    tools: profile.tools,
    toolBoundary: toolBoundarySummary(profile.tools),
    auto: autoRoutingStatus({
      candidates: effectiveCandidates,
      available,
      nonMockAvailable,
      selected,
      excludedProviderNames: excludeProviderNames,
    }),
    candidates,
  };
}

function publicProviderRoutingCandidate(provider = {}, { excluded = false } = {}) {
  return {
    name: provider.name,
    kind: provider.kind,
    available: Boolean(provider.available),
    excluded,
    blockedReason: provider.blockedReason || "",
    capabilities: provider.capabilities || [],
    source: publicProviderSource(provider.source),
  };
}

function selectAutoProviderSummary({ available = [], nonMockAvailable = [] } = {}) {
  if (nonMockAvailable.length === 1) {
    return nonMockAvailable[0].name;
  }
  if (nonMockAvailable.length === 0 && available.length > 0) {
    return available[0].name;
  }
  return undefined;
}

function autoRoutingStatus({
  candidates = [],
  available = [],
  nonMockAvailable = [],
  selected,
  excludedProviderNames = [],
} = {}) {
  const exclusionNote = excludedProviderNames.length > 0
    ? ` Excluded providers: ${excludedProviderNames.map(redactString).join(", ")}.`
    : "";
  if (nonMockAvailable.length > 1) {
    return {
      status: "ambiguous",
      selected,
      reason: `Multiple available non-mock providers match: ${nonMockAvailable.map((provider) => provider.name).join(", ")}.${exclusionNote}`,
    };
  }
  if (selected) {
    const selectedProvider = available.find((provider) => provider.name === selected);
    return {
      status: selectedProvider?.kind === "mock" ? "mock-fallback" : "ready",
      selected,
      reason: selectedProvider?.kind === "mock"
        ? `Only mock providers are currently available for this profile.${exclusionNote}`
        : `Exactly one available non-mock provider matches this profile.${exclusionNote}`,
    };
  }
  if (candidates.length > 0) {
    return {
      status: "blocked",
      selected,
      reason: `Matching providers exist, but none are currently available under the active flags, environment, and exclusions.${exclusionNote}`,
    };
  }
  return {
    status: "blocked",
    selected,
    reason: `No provider advertises all required capabilities for this profile after exclusions.${exclusionNote}`,
  };
}

function toolBoundarySummary(tools) {
  if (tools === "read_only") {
    return "Read-only dispatcher tools are exposed; direct write, shell, network, user-channel, and completion intents are denied.";
  }
  if (tools === "virtual_patch_only") {
    return "The subagent may return a virtual patch proposal; the main flow must adopt it through runtime gates.";
  }
  return "No runtime tools are exposed to this subagent.";
}


function parseAgentsArgs(argv = []) {
  const args = {
    useApiKey: false,
    useProviderCommand: false,
    providerCommandProviders: [],
    mainProvider: "",
    excludeProviderNames: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      applyProviderCommandOption(args, option);
    } else if (option.name === "--main-provider") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      if (value) {
        args.mainProvider = String(value);
        appendUnique(args.excludeProviderNames, String(value));
      }
    } else if (option.name === "--exclude-provider") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      if (value) {
        appendUnique(args.excludeProviderNames, String(value));
      }
    }
  }
  return args;
}
