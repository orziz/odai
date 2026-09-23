import assert from "node:assert/strict";
import test from "node:test";
import { resolveControllerSelection, selectController } from "./live-routing-smoke-config.mjs";
const settings = [
  "ui-onboarding:",
  "  welcomeNoticeVersion: 1",
  "agent-default-model:",
  '  provider: "provider-x"',
  "  model: 'model-x'",
  "  reasoningEffort: high # inherited effort",
  "other-setting: true",
  "",
].join("\n");
test("live smoke normalizes quoted inherited controller settings", () => {
  assert.deepEqual(resolveControllerSelection(settings), {
    provider: "provider-x",
    model: "model-x",
    reasoningEffort: "high",
  });
});
test("live smoke accepts an explicit model without inheriting incompatible reasoning", () => {
  assert.deepEqual(
    resolveControllerSelection(settings, { controllerProvider: "provider-y", controllerModel: "model-y" }),
    { provider: "provider-y", model: "model-y", reasoningEffort: undefined },
  );
});
test("live smoke writes controller values as valid quoted YAML scalars", () => {
  const selected = selectController(settings, {
    provider: "provider:y",
    model: "model with spaces",
    reasoningEffort: "very-high",
  });
  assert.match(selected, /provider: "provider:y"/u);
  assert.match(selected, /model: "model with spaces"/u);
  assert.match(selected, /reasoningEffort: "very-high"/u);
  assert.match(selected, /other-setting: true/u);
});
