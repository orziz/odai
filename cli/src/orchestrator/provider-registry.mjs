export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (!provider?.name) {
      throw new Error("Provider must have a name.");
    }
    this.providers.set(provider.name, provider);
  }

  get(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider not found: ${name}`);
    }
    return provider;
  }

  has(name) {
    return this.providers.has(name);
  }

  findByCapabilities(required = [], { excludeNames = [], preferNonMock = false } = {}) {
    const excluded = new Set(excludeNames);
    const candidates = this.list()
      .filter((provider) => required.every((capability) => provider.capabilities.includes(capability)))
      .filter((provider) => !excluded.has(provider.name));
    const available = candidates.filter((provider) => provider.available !== false);
    if (preferNonMock) {
      return (
        available.find((provider) => provider.kind !== "mock") ||
        available[0] ||
        candidates.find((provider) => provider.kind !== "mock") ||
        candidates[0]
      );
    }
    return (
      available[0] ||
      candidates[0]
    );
  }

  list() {
    return [...this.providers.values()];
  }
}
