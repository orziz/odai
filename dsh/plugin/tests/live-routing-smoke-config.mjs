function controllerSection(settings) {
  const lines = settings.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === "agent-default-model:");
  if (start < 0) throw new Error("settings.yaml has no agent-default-model section");
  let end = start + 1;
  while (end < lines.length && (/^\s/u.test(lines[end] ?? "") || lines[end] === "")) end += 1;
  return { lines, start, end };
}
function parseYamlString(value, field) {
  const text = value.trim();
  if (text.startsWith('"')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`settings.yaml ${field} is not a valid quoted string: ${message}`);
    }
    if (typeof parsed !== "string" || parsed.trim() === "") {
      throw new Error(`settings.yaml ${field} must be a non-empty string`);
    }
    return parsed.trim();
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new Error(`settings.yaml ${field} is not a valid quoted string`);
    }
    const parsed = text.slice(1, -1).replace(/''/gu, "'").trim();
    if (!parsed) throw new Error(`settings.yaml ${field} must be a non-empty string`);
    return parsed;
  }
  const comment = text.search(/\s+#/u);
  const parsed = (comment < 0 ? text : text.slice(0, comment)).trim();
  if (!parsed) throw new Error(`settings.yaml ${field} must be a non-empty string`);
  return parsed;
}
export function resolveControllerSelection(settings, options = {}) {
  const { lines, start, end } = controllerSection(settings);
  const current = Object.fromEntries(
    lines.slice(start + 1, end).flatMap((line) => {
      const match = line.match(/^\s+(provider|model|reasoningEffort):\s*(\S(?:.*\S)?)\s*$/u);
      if (!match?.[1] || !match[2]) return [];
      return [[match[1], parseYamlString(match[2], `agent-default-model.${match[1]}`)]];
    }),
  );
  const provider = current.provider;
  const model = current.model;
  if (!provider || !model) {
    throw new Error("settings.yaml agent-default-model must define provider and model");
  }
  const explicitModel = options.controllerProvider !== undefined;
  return {
    provider: options.controllerProvider ?? provider,
    model: options.controllerModel ?? model,
    reasoningEffort: options.controllerReasoning ?? (explicitModel ? undefined : current.reasoningEffort),
  };
}
export function selectController(settings, selection) {
  const { lines, start, end } = controllerSection(settings);
  const replacement = [
    "agent-default-model:",
    `  provider: ${JSON.stringify(selection.provider)}`,
    `  model: ${JSON.stringify(selection.model)}`,
    ...(selection.reasoningEffort ? [`  reasoningEffort: ${JSON.stringify(selection.reasoningEffort)}`] : []),
  ];
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}
