export function withProviderModelOverride(provider, modelOverride) {
  const model = normalizeModelOverride(modelOverride);
  if (!provider || !model) {
    return provider;
  }
  return {
    ...provider,
    source: {
      ...(provider.source || {}),
      modelPresent: true,
      modelOverridePresent: true,
    },
    available: provider.blockedReason === "model_required" ? true : provider.available,
    blockedReason: provider.blockedReason === "model_required" ? "" : provider.blockedReason,
    async run(args = {}) {
      return provider.run({
        ...args,
        input: {
          ...(args.input || {}),
          modelOverride: model,
        },
      });
    },
  };
}

export function withRegistryModelOverride(registry, modelOverride) {
  const model = normalizeModelOverride(modelOverride);
  if (!registry || !model) {
    return registry;
  }
  return {
    configErrors: registry.configErrors,
    list() {
      return registry.list().map((provider) => withProviderModelOverride(provider, model));
    },
  };
}

function normalizeModelOverride(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
