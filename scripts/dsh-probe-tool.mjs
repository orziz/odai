// Use the same step admission for model declarations and tool execution.
export async function assembleProbePrompt(ctx, { agent, scope = agent, signal = new AbortController().signal }) {
  const toolSet = await ctx.tools.resolve({ agent: scope, signal, modelSelection: scope.model?.current() ?? { provider: "probe", model: "probe" } });
  try {
    return await ctx.systemPrompt.assemble({ agent, scope, signal, toolSet });
  } finally {
    toolSet?.dispose();
  }
}

// Invoke a tool through the real host executor without appending model-step events.
export async function runProbeTool(ctx, { callId, name, arguments: args, agent, signal, resolveAdmission = true }) {
  const toolSet = resolveAdmission ? await ctx.tools.resolve({ agent, signal, modelSelection: agent?.model?.current() ?? { provider: "probe", model: "probe" } }) : undefined;
  try {
    const batch = await ctx.tools.execute({
      calls: [{ type: "tool-call", id: callId, name, arguments: JSON.stringify(args) }],
      agent,
      signal,
      toolSet,
    });
    const entry = batch.results.find((item) => item.callId === callId);
    if (!entry) throw new Error(`DSH did not settle probe tool call ${callId}`);
    return entry.result;
  } finally {
    toolSet?.dispose();
  }
}
