import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadWorkspaceProviderConfig,
  publicProviderSource,
} from "../config/provider-config.mjs";
import { withRegistryModelOverride } from "../orchestrator/provider-model.mjs";
import { describeSandboxReadiness } from "./sandbox-readiness.mjs";
import {
  normalizeProviderCommandProviders,
} from "./cli-args.mjs";

export function describeE2EReadiness({
  workspaceRoot,
  env = process.env,
  allowApiKey = false,
  allowProviderCommand = false,
  allowedProviderCommands = [],
  modelOverride,
  sandboxOptions = {},
} = {}) {
  if (!workspaceRoot) {
    throw new Error("describeE2EReadiness requires workspaceRoot.");
  }
  const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot });
  const registry = createProviderRegistryFromEnvironment(env, {
    allowApiKey,
    allowProviderCommand,
    allowedProviderCommands,
    config: providerConfig,
  });
  const effectiveRegistry = withRegistryModelOverride(registry, modelOverride);
  const providers = describeProviders(effectiveRegistry, env);
  const sandbox = describeSandboxReadiness({ workspaceRoot, ...sandboxOptions });
  const realProviders = providers.providers.filter((provider) => provider.kind !== "mock");
  const availableRealProviders = realProviders.filter((provider) => provider.available);
  const apiProviders = realProviders.filter((provider) => ["api", "openai-compatible"].includes(provider.kind));
  const availableApiProviders = apiProviders.filter((provider) => provider.available);
  const runtimeProviders = realProviders.filter((provider) =>
    ["subscription-cli", "subscription-sdk"].includes(provider.kind),
  );
  const availableRuntimeProviders = runtimeProviders.filter((provider) => provider.available);
  const subscriptionCliProviders = realProviders.filter((provider) => provider.kind === "subscription-cli");
  const readySubscriptionCliProviders = subscriptionCliProviders.filter((provider) => provider.available);
  const requirements = [
    {
      id: "provider-api",
      status: availableApiProviders.length > 0 ? "ready" : "blocked",
      need: "At least one real API-key or OpenAI-compatible provider is explicitly available.",
      evidence: availableApiProviders.map(providerSummary),
      blocked: apiProviders.filter((provider) => !provider.available).map(providerSummary),
      next: availableApiProviders.length > 0
        ? []
        : [
            "Set an API key and model env var such as OPENAI_API_KEY + ODAI_OPENAI_MODEL, then rerun with --use-api-key.",
            "Or pass --model <name> with --use-api-key for this readiness/probe run.",
            "Or configure .odai/providers.json with an openai-compatible provider and rerun with --use-api-key.",
          ],
    },
    {
      id: "provider-runtime",
      status: availableRuntimeProviders.length > 0 ? "ready" : "blocked",
      need: "At least one subscription CLI/SDK runtime provider is explicitly available.",
      evidence: availableRuntimeProviders.map(providerSummary),
      blocked: runtimeProviders.filter((provider) => !provider.available).map(providerSummary),
      next: availableRuntimeProviders.length > 0
        ? []
        : [
            "Install and authenticate a supported CLI/SDK provider such as Codex CLI, Grok CLI, Claude CLI, or Claude Agent SDK.",
            "If a supported CLI is installed outside PATH, set ODAI_CODEX_COMMAND, ODAI_GROK_COMMAND, or ODAI_CLAUDE_COMMAND to its executable path.",
            "Rerun with --use-provider-command so odai can confirm subscription/CLI execution explicitly.",
          ],
    },
    {
      id: "provider-subscription-cli",
      status: readySubscriptionCliProviders.length > 0 ? "ready" : "blocked",
      need: "At least one subscription CLI provider is explicitly available for CLI E2E.",
      evidence: readySubscriptionCliProviders.map(providerSummary),
      blocked: subscriptionCliProviders.filter((provider) => !provider.available).map(providerSummary),
      next: readySubscriptionCliProviders.length > 0
        ? []
        : [
            "Install/authenticate a supported CLI provider.",
            "If a supported CLI is installed outside PATH, set ODAI_CODEX_COMMAND, ODAI_CLAUDE_COMMAND, or ODAI_GROK_COMMAND to its executable path.",
            "Rerun with --use-provider-command before invoking doctor --provider <name>.",
          ],
    },
    {
      id: "strong-sandbox",
      status: sandbox.summary.configuredStrong ? "ready" : "blocked",
      need: "Configured shell sandbox preflight is ready before claiming strong sandbox E2E.",
      evidence: sandbox.summary.configuredStrong ? [sandbox.configured] : [],
      blocked: sandbox.summary.configuredStrong ? [] : [sandbox.configured, ...sandbox.candidates],
      next: sandbox.summary.configuredStrong
        ? []
        : sandbox.remaining,
    },
  ];
  const ready = requirements.filter((requirement) => requirement.status === "ready").length;
  const blocked = requirements.length - ready;
  return {
    status: blocked === 0 ? "ready" : "partial",
    kind: "e2e-readiness",
    summary: {
      total: requirements.length,
      ready,
      blocked,
      availableRealProviders: availableRealProviders.length,
    },
    flags: {
      useApiKey: allowApiKey,
      useProviderCommand: allowProviderCommand,
      providerCommandProviders: normalizeProviderCommandProviders(allowedProviderCommands),
      model: modelOverride || undefined,
    },
    providers,
    sandbox,
    requirements,
    runnableCommands: buildRunnableCommands({ requirements, availableRealProviders, modelOverride }),
    note: "This readiness report does not call real providers or execute shell sandboxes. Use the listed commands only after the required credentials, CLI auth, and sandbox policy are intentionally configured.",
  };
}

function providerSummary(provider) {
  return {
    name: provider.name,
    kind: provider.kind,
    auth: provider.auth,
    available: provider.available,
    blockedReason: provider.blockedReason,
    source: publicProviderSource(provider.source),
    capabilities: provider.capabilities,
    cost: provider.cost || "unknown",
  };
}

function buildRunnableCommands({ requirements, availableRealProviders, modelOverride }) {
  const commands = [];
  for (const provider of availableRealProviders) {
    commands.push([
      "odai",
      "doctor",
      "--provider",
      provider.name,
      ...providerDoctorFlags(provider, modelOverride),
      "--save",
    ].join(" "));
  }
  if (isRequirementReady(requirements, "provider-api") && isRequirementReady(requirements, "provider-runtime")) {
    commands.push([
      "odai",
      "doctor",
      "--all",
      "--use-api-key",
      "--use-provider-command",
      ...(modelOverride ? ["--model", modelOverride] : []),
      "--save",
    ].join(" "));
  }
  if (isRequirementReady(requirements, "strong-sandbox")) {
    commands.push("odai doctor --sandbox --smoke --allow-shell --save");
  }
  return commands;
}

function isRequirementReady(requirements, id) {
  return requirements.some((requirement) => requirement.id === id && requirement.status === "ready");
}

function providerDoctorFlags(provider, modelOverride) {
  const flags = [];
  if (["api", "openai-compatible"].includes(provider.kind)) {
    flags.push("--use-api-key");
  }
  if (["subscription-cli", "subscription-sdk"].includes(provider.kind)) {
    flags.push("--use-provider-command");
  }
  if (modelOverride) {
    flags.push("--model", modelOverride);
  }
  return flags;
}
