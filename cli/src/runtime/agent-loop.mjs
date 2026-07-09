import { dispatchModelToolIntents, prepareModelIntents } from "./model-tool-intents.mjs";
import {
  DEFAULT_MAX_SPAWN_REQUESTS_PER_TURN,
  summarizeControlIntents,
} from "./agent-control.mjs";
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
  const spawnRequests = [];
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

    const rawIntents = Array.isArray(output?.toolIntents) ? output.toolIntents : [];
    const prepared = prepareModelIntents({
      intents: rawIntents,
      actor,
    });
    if (prepared.overflow) {
      const denial = prepared.overflow.denial;
      dispatcher?.evidence?.recordDenial(denial);
      dispatcher?.session?.recordFailure?.(
        `${actor?.kind || "unknown"}:tool-intent-batch:${prepared.overflow.count}`,
      );
      onEvent?.({
        type: "tool-result",
        agent,
        turn,
        provider: provider.name,
        intent: publicIntent(denial.intent),
        result: publicToolResult(denial),
      });
      const turnRecord = {
        turn,
        provider: provider.name,
        output: summarizeOutput(output),
        toolIntents: [],
        toolResults: [publicToolResult(denial)],
        toolIntentOverflow: {
          count: prepared.overflow.count,
          limit: prepared.overflow.limit,
        },
        controlIntents: [],
        control: summarizeControlIntents([]),
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
        controlIntents: turnRecord.controlIntents,
        control: turnRecord.control,
      });
      // Overflow rejects the whole batch: no tools, no control, no spawn fan-out.
      // Drop any earlier-turn spawnRequests too — failed loops must not schedule fan-out.
      return finishLoop({
        completed: false,
        stopReason: "tool_intent_limit_exceeded",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
        spawnRequests: [],
      });
    }

    for (const denial of prepared.payloadDenials) {
      dispatcher?.evidence?.recordDenial(denial);
      dispatcher?.session?.recordFailure?.(
        `${actor?.kind || "unknown"}:tool-intent-payload:${denial.intent?.originalType || "unknown"}`,
      );
      onEvent?.({
        type: "tool-result",
        agent,
        turn,
        provider: provider.name,
        intent: publicIntent(denial.intent),
        result: publicToolResult(denial),
      });
    }
    let control = summarizeControlIntents(prepared.controlIntents);
    let spawnOverflowDenial;
    if (control.spawnRequests.length > DEFAULT_MAX_SPAWN_REQUESTS_PER_TURN) {
      spawnOverflowDenial = {
        ok: false,
        gate: "policy",
        reason: `Model returned ${control.spawnRequests.length} spawn-subagent intents, exceeding the per-turn spawn limit of ${DEFAULT_MAX_SPAWN_REQUESTS_PER_TURN}.`,
        intent: {
          type: "tool-intent-batch",
          count: control.spawnRequests.length,
          limit: DEFAULT_MAX_SPAWN_REQUESTS_PER_TURN,
          originalType: "spawn-subagent",
          actor,
        },
      };
      dispatcher?.evidence?.recordDenial(spawnOverflowDenial);
      dispatcher?.session?.recordFailure?.(
        `${actor?.kind || "unknown"}:spawn-intent-batch:${control.spawnRequests.length}`,
      );
      onEvent?.({
        type: "tool-result",
        agent,
        turn,
        provider: provider.name,
        intent: publicIntent(spawnOverflowDenial.intent),
        result: publicToolResult(spawnOverflowDenial),
      });
      // Drop all spawn requests for this turn; other tools/control still follow normal rules.
      control = {
        ...control,
        spawnRequests: [],
      };
      prepared.controlIntents = prepared.controlIntents.filter((intent) => intent.type !== "spawn-subagent");
    }

    const toolIntentDispatch = await dispatchModelToolIntents({
      output: {
        ...output,
        toolIntents: prepared.toolIntents,
      },
      dispatcher,
      actor,
      // Batch already enforced on raw intents; payload already validated above.
      maxToolIntents: Number.POSITIVE_INFINITY,
      maxToolIntentChars: Number.POSITIVE_INFINITY,
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
    const publicToolIntents = toolIntentDispatch.intents.map(publicIntent);
    const publicControlIntents = prepared.controlIntents.map(publicIntent);
    const publicPayloadDenials = prepared.payloadDenials.map((denial) => publicIntent(denial.intent));
    const intents = [...publicToolIntents, ...publicControlIntents, ...publicPayloadDenials];
    const toolIntentResults = [
      ...prepared.payloadDenials,
      ...(spawnOverflowDenial ? [spawnOverflowDenial] : []),
      ...toolIntentDispatch.results,
    ];
    const turnRecord = {
      turn,
      provider: provider.name,
      output: summarizeOutput(output),
      toolIntents: intents,
      toolResults: toolIntentResults.map(publicToolResult),
      toolIntentOverflow: toolIntentDispatch.overflow,
      controlIntents: publicControlIntents,
      control,
      spawnOverflow: spawnOverflowDenial
        ? {
            count: spawnOverflowDenial.intent.count,
            limit: spawnOverflowDenial.intent.limit,
          }
        : undefined,
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
      controlIntents: turnRecord.controlIntents,
      control: turnRecord.control,
    });

    for (let i = 0; i < toolIntentDispatch.results.length; i += 1) {
      toolResults.push({
        turn,
        intent: publicToolIntents[i],
        result: providerToolResult(toolIntentDispatch.results[i]),
      });
    }

    // Only accept spawn requests after the batch limit path is clear.
    if (control.spawnRequests.length > 0) {
      spawnRequests.push(...control.spawnRequests);
    }

    if (toolIntentDispatch.overflow) {
      return finishLoop({
        completed: false,
        stopReason: "tool_intent_limit_exceeded",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
        spawnRequests: [],
      });
    }

    // Oversized control intents are denials, not valid stop signals.
    if (prepared.payloadDenials.length > 0 && prepared.toolIntents.length === 0 && prepared.controlIntents.length === 0) {
      return finishLoop({
        completed: false,
        stopReason: "tool_intent_payload_denied",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
        spawnRequests,
      });
    }

    if (control.askUser) {
      onEvent?.({
        type: "agent-needs-user",
        agent,
        turn,
        provider: provider.name,
        question: redactString(control.askUser.question || ""),
      });
      return finishLoop({
        completed: false,
        stopReason: "needs_user",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
        userPrompt: redactString(control.askUser.question || ""),
        spawnRequests,
      });
    }

    if (control.complete) {
      return finishLoop({
        completed: true,
        stopReason: "provider_complete",
        agent,
        turns,
        finalOutput: {
          ...summarizeOutput(output),
          summary: redactString(control.complete.summary || ""),
        },
        completionSummary: redactString(control.complete.summary || ""),
        spawnRequests,
      });
    }

    // Legacy: empty toolIntents means the provider is done talking.
    if (prepared.toolIntents.length === 0 && prepared.controlIntents.length === 0) {
      return finishLoop({
        completed: true,
        stopReason: "provider_returned_no_tool_intents",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
        spawnRequests,
      });
    }

    // Only spawn control intents and no executable tools: stop so the host can schedule.
    if (prepared.toolIntents.length === 0 && control.spawnRequests.length > 0) {
      return finishLoop({
        completed: true,
        stopReason: "spawn_subagent_requested",
        agent,
        turns,
        finalOutput: summarizeOutput(output),
        spawnRequests,
      });
    }
  }

  return finishLoop({
    completed: false,
    stopReason: "max_turns_reached",
    agent,
    turns,
    spawnRequests,
  });
}

function finishLoop(result) {
  if (!Array.isArray(result.spawnRequests) || result.spawnRequests.length === 0) {
    const { spawnRequests, ...rest } = result;
    return rest;
  }
  return result;
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
