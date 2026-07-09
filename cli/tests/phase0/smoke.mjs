/**
 * Phase 0 smoke entry — ordered suites.
 *
 * 1. early-meta: skill / package / i18n / update-check
 * 2. config-routing: policy, preferences, providers, models, auth routing
 * 3. gates-orchestration: tool gates, agent loop, doctor/status/canary
 * 4. interactive-cli: interactive session + subscription CLI adapters
 */
await import("./suites/early-meta.mjs");
await import("./suites/config-routing.mjs");
await import("./suites/gates-orchestration.mjs");
await import("./suites/interactive-cli.mjs");
console.log("phase0 smoke ok");
