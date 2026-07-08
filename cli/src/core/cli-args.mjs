export function appendUnique(items, value) {
  if (!items.includes(value)) {
    items.push(value);
  }
}

export function optionToken(item = "") {
  const value = String(item);
  const separator = value.indexOf("=");
  if (separator <= 0) {
    return {
      name: value,
      value: undefined,
      hasInlineValue: false,
    };
  }
  return {
    name: value.slice(0, separator),
    value: value.slice(separator + 1),
    hasInlineValue: true,
  };
}

export function providerCommandAuthFromArgv(argv = []) {
  const args = {
    useProviderCommand: false,
    providerCommandProviders: [],
  };
  for (const item of argv) {
    const option = optionToken(item);
    if (option.name === "--use-provider-command") {
      applyProviderCommandOption(args, option);
    }
  }
  return args;
}

export function applyProviderCommandOption(args, option = {}) {
  if (!option.hasInlineValue) {
    args.useProviderCommand = true;
    args.providerCommandProviders = [];
    return;
  }

  const value = String(option.value || "").trim();
  const normalized = value.toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(normalized)) {
    args.useProviderCommand = true;
    args.providerCommandProviders = [];
    return;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    args.useProviderCommand = false;
    args.providerCommandProviders = [];
    return;
  }

  args.useProviderCommand = false;
  args.providerCommandProviders = normalizeProviderCommandProviders(value);
}

export function providerCommandAuthArgv(args = {}) {
  if (args.useProviderCommand) return ["--use-provider-command"];
  return normalizeProviderCommandProviders(args.providerCommandProviders)
    .map((providerName) => `--use-provider-command=${providerName}`);
}

export function normalizeProviderCommandProviders(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(
    items
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )].sort();
}

export function hasFlag(argv = [], name) {
  return argv.some((item) => {
    const option = optionToken(item);
    return option.name === name && enabledFlagValue(option);
  });
}

export function enabledFlagValue(option = {}) {
  if (!option.hasInlineValue) return true;
  const value = String(option.value || "").trim().toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return false;
}
