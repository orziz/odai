import { dispatchModelToolIntents } from "./model-tool-intents.mjs";
import { normalizeProviderSession, prepareProviderInput, sanitizeProviderRuntimeValue } from "./provider-session.mjs";
import {
  providerToolResult,
  publicModelList,
  publicIntent,
  publicToolResult,
  publicUsage,
  redactModelValue,
  redactString,
} from "./redaction.mjs";

export async function runAgentLoop({
  provider,
  task,
  input = {},
  dispatcher,
  evidence,
  actor = { kind: "main", id: "main" },
  maxTurns = 4,
  onEvent,
  usageLedger,
} = {}) {
  if (!provider) {
    throw new Error("Agent loop requires a provider.");
  }
  if (provider.available === false) {
    const reason = provider.blockedReason ? ` (${provider.blockedReason})` : "";
    throw new Error(`Provider is not available: ${provider.name}${reason}`);
  }

  const agent = {
    id: `main:${provider.name}:${Date.now()}`,
    role: "main",
    provider: provider.name,
  };
  const toolResults = [];
  const turns = [];
  const providerInputBase = prepareProviderInput({
    input,
    provider,
    workspaceRoot: dispatcher?.workspaceRoot,
  });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const providerInput = {
      ...providerInputBase,
      task,
      mode: "agent_loop",
      turn,
      previousToolResults: sanitizeProviderRuntimeValue(toolResults, {
        workspaceRoot: dispatcher?.workspaceRoot,
      }),
    };
    onEvent?.({
      type: "agent-turn-start",
      agent,
      turn,
      provider: provider.name,
      estimatedInputTokens: estimateTokensFromValue(providerInput),
    });
    const profile = {
      name: "main",
      tools: "tool_intents",
    };
    const runProvider = () =>
      provider.run({
        agent,
        profile,
        input: providerInput,
        tools: {},
        onEvent: (event) =>
          onEvent?.({
            ...event,
            agent,
            turn,
            provider: provider.name,
          }),
      });
    const output = usageLedger
      ? (await usageLedger.trackProviderCall({
          provider,
          agent,
          profile,
          mode: "agent_loop",
          run: runProvider,
        })).output
      : await runProvider();
    const toolIntentDispatch = await dispatchModelToolIntents({
      output,
      dispatcher,
      actor,
      onResult: ({ intent, result }) =>
        onEvent?.({
          type: "tool-result",
          agent,
          turn,
          provider: provider.name,
          intent: publicIntent(intent),
          result: publicToolResult(result),
        }),
    });
    const intents = toolIntentDispatch.intents;
    const toolIntentResults = toolIntentDispatch.results;
    const turnRecord = {
      turn,
      provider: provider.name,
      output: summarizeOutput(output),
      toolIntents: intents.map(publicIntent),
      toolResults: toolIntentResults.map(publicToolResult),
      toolIntentOverflow: toolIntentDispatch.overflow,
    };
    turns.push(turnRecord);
    evidence?.recordEvent("agent-turn", {
      agent,
      turn,
      provider: provider.name,
      output: turnRecord.output,
      toolIntents: turnRecord.toolIntents,
      toolResults: turnRecord.toolResults,
      toolIntentOverflow: turnRecord.toolIntentOverflow,
    });

    for (let i = 0; i < toolIntentResults.length; i += 1) {
      toolResults.push({
        turn,
        intent: publicIntent(intents[i]),
        result: providerToolResult(toolIntentResults[i]),
      });
    }

    if (toolIntentDispatch.overflow) {
      return {
        completed: false,
        stopReason: "tool_intent_limit_exceeded",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
      };
    }

    if (intents.length === 0) {
      return {
        completed: true,
        stopReason: "provider_returned_no_tool_intents",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
      };
    }
  }

  return {
    completed: false,
    stopReason: "max_turns_reached",
    agent,
    turns,
  };
}

function estimateTokensFromValue(value) {
  return estimateTokensFromChars(estimateCharsFromValue(value, { seen: new Set() }));
}

function estimateCharsFromValue(value, { depth = 0, seen } = {}) {
  if (value === undefined || value === null || depth > 6) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + estimateCharsFromValue(entry, { depth: depth + 1, seen }) + 1, 2);
  }
  if (typeof value === "object") {
    if (seen.has(value)) return 0;
    seen.add(value);
    let total = 2;
    for (const [key, entry] of Object.entries(value)) {
      total += key.length + estimateCharsFromValue(entry, { depth: depth + 1, seen }) + 2;
    }
    seen.delete(value);
    return total;
  }
  return 0;
}

function estimateTokensFromChars(chars = 0) {
  return Math.max(0, Math.ceil(Number(chars || 0) / 4));
}

function summarizeOutput(output = {}) {
  return {
    provider: output.provider,
    model: output.model,
    text: typeof output.text === "string" ? redactString(output.text) : output.text,
    findings: Array.isArray(output.findings) ? output.findings.map(redactModelValue) : output.findings,
    usage: publicUsage(output.usage || output.usageMetadata),
    providerSession: normalizeProviderSession(output.providerSession, {
      provider: output.provider,
      model: output.model,
    }),
    unverified: publicModelList(output.unverified),
    toolIntentCount: Array.isArray(output.toolIntents) ? output.toolIntents.length : 0,
  };
}
