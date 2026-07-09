/**
 * @typedef {Object} OdaiProvider
 * @property {string} name
 * @property {string} kind
 * @property {string} [auth]
 * @property {string[]} [capabilities]
 * @property {boolean} [available]
 * @property {string} [blockedReason]
 * @property {(args: {
 *   agent?: object,
 *   profile?: object,
 *   input?: object,
 *   tools?: object,
 *   onEvent?: (event: object) => void,
 * }) => Promise<object>} run
 * @property {(args?: object) => Promise<string[]|object>} [listModels]
 */

/**
 * Validate the minimal odai provider surface without throwing.
 * @param {unknown} provider
 * @returns {{ ok: true, provider: OdaiProvider } | { ok: false, reason: string }}
 */
export function validateProvider(provider) {
  if (!provider || typeof provider !== "object") {
    return { ok: false, reason: "Provider must be an object." };
  }
  if (typeof provider.name !== "string" || !provider.name.trim()) {
    return { ok: false, reason: "Provider.name must be a non-empty string." };
  }
  if (typeof provider.kind !== "string" || !provider.kind.trim()) {
    return { ok: false, reason: "Provider.kind must be a non-empty string." };
  }
  if (typeof provider.run !== "function") {
    return { ok: false, reason: "Provider.run must be a function." };
  }
  if (provider.capabilities !== undefined && !Array.isArray(provider.capabilities)) {
    return { ok: false, reason: "Provider.capabilities must be an array when present." };
  }
  if (provider.listModels !== undefined && typeof provider.listModels !== "function") {
    return { ok: false, reason: "Provider.listModels must be a function when present." };
  }
  return { ok: true, provider };
}

export function assertProvider(provider) {
  const result = validateProvider(provider);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.provider;
}
