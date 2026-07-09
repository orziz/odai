import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadProviderConfig,
  loadProviderSecretEnv,
  loadWorkspaceEnvironment,
} from "../config/provider-config.mjs";
import { withRegistryModelOverride } from "../orchestrator/provider-model.mjs";
import { redactString } from "../runtime/redaction.mjs";
import {
  blockedModelDiscoveries,
  configuredModelMap,
  defaultModelDiscoveryRunCommand,
  discoverModelChoices,
  modelCatalogProvider,
  parseModelArgs,
} from "./model-discovery.mjs";

const defaultRepoRoot = process.cwd();

export async function runModels({
  repoRoot: root = defaultRepoRoot,
  argv = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  runCommand = defaultModelDiscoveryRunCommand,
} = {}) {
  const args = parseModelArgs(argv);
  const secretEnv = loadProviderSecretEnv({ workspaceRoot: root, env });
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });
  const providerConfig = loadProviderConfig({ workspaceRoot: root, env });
  const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    allowedProviderCommands: args.providerCommandProviders,
    config: providerConfig,
  });
  const effectiveRegistry = withRegistryModelOverride(registry, args.model);
  const providerReport = describeProviders(effectiveRegistry, workspaceEnv);
  const configuredModels = configuredModelMap({ env: workspaceEnv, providerConfig });
  const reportedProviders = (providerReport.providers || []).filter((provider) =>
    args.provider ? provider.name === args.provider : true,
  );
  const discovery = await discoverModelChoices({
    providers: reportedProviders,
    providerConfig,
    env: workspaceEnv,
    secretEnv,
    args,
    fetchImpl,
    runCommand,
  });
  const providers = reportedProviders.map((provider) =>
    modelCatalogProvider({
      provider,
      configured: configuredModels.get(provider.name),
      modelOverride: args.model,
      discovery: discovery.byProvider.get(provider.name),
    }),
  );
  const models = discovery.models;
  return {
    status: "ready",
    kind: "model-catalog",
    flags: {
      useApiKey: args.useApiKey,
      useProviderCommand: args.useProviderCommand,
      providerCommandProviders: args.providerCommandProviders,
      model: args.model ? redactString(args.model) : undefined,
      provider: args.provider ? redactString(args.provider) : undefined,
      select: args.select,
      json: args.json,
    },
    summary: {
      total: providers.length,
      providers: providers.length,
      models: models.length,
      availableModels: models.length,
      configuredModels: providers.filter((provider) => Boolean(provider.configuredModel)).length,
      available: providers.filter((provider) => provider.available).length,
      modelOverrideActive: Boolean(args.model),
      discoveryReady: discovery.results.filter((entry) => entry.status === "ready").length,
      discoveryBlocked: discovery.results.filter((entry) => entry.status !== "ready").length,
    },
    models,
    discovery: discovery.results,
    providers,
    ...(Array.isArray(providerReport.configErrors) && providerReport.configErrors.length > 0
      ? { configErrors: providerReport.configErrors }
      : {}),
    note:
      "This actively discovers model names from provider list endpoints or provider-specific local probes. Managed .odai/secrets.env provider keys are used for model discovery only; other API keys and external provider commands still require explicit /auth or --use-* confirmation.",
  };
}


export function formatModelsList(result = {}) {
  const models = Array.isArray(result.models) ? result.models : [];
  const blocked = blockedModelDiscoveries(result.discovery);
  const lines = [
    `status: ${result.status || "unknown"}`,
    `models: ${models.filter((model) => model.available).length}/${models.length} available`,
  ];
  if (result.flags?.model) {
    lines.push(`override: ${result.flags.model}`);
  }
  if (result.flags?.provider) {
    lines.push(`provider: ${result.flags.provider}`);
  }
  if (models.length === 0) {
    lines.push("No provider returned a model list.");
    const blockedReasons = new Set((result.discovery || []).map((entry) => entry.reason).filter(Boolean));
    if (blockedReasons.has("api_key_requires_explicit_use")) {
      lines.push("A provider has an API key outside .odai/secrets.env; use --use-api-key to probe it.");
    } else if (blockedReasons.has("provider_command_requires_explicit_use")) {
      lines.push("A provider requires an external command; use --use-provider-command to probe it.");
    } else {
      lines.push("Check --json discovery diagnostics for the provider-specific reason.");
    }
  } else {
    const maxLabel = Math.min(48, Math.max(...models.map((model) => model.label.length), 12));
    for (const model of models) {
      const marker = model.current ? "*" : " ";
      const status = model.available ? "ready" : model.blockedReason || "blocked";
      lines.push(`${marker} ${model.label.padEnd(maxLabel)} ${status} ${model.source || ""}`.trimEnd());
    }
  }
  if (blocked.length > 0) {
    lines.push(`blocked providers: ${blocked.length}`);
    for (const entry of blocked.slice(0, 8)) {
      lines.push(`  ${entry.provider}: ${entry.reason || "blocked"}${entry.source ? ` (${entry.source})` : ""}`);
    }
    if (blocked.length > 8) {
      lines.push(`  ... ${blocked.length - 8} more`);
    }
  }
  if (Array.isArray(result.configErrors) && result.configErrors.length > 0) {
    lines.push(`config errors: ${result.configErrors.length}`);
  }
  lines.push("Use /models select in the interactive CLI, or /model <provider>:<model>.");
  lines.push("Use --json for discovery diagnostics and provider readiness.");
  return lines.join("\n");
}
