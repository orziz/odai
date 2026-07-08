export function createMockProvider(name, capabilities = []) {
  return {
    name,
    kind: "mock",
    auth: "none",
    capabilities,
    available: true,
    async run({ agent, input, tools, onEvent }) {
      const model = normalizeModelOverride(input?.modelOverride);
      if (input.mode === "agent_loop") {
        return runMockAgentLoopTurn({ name, agent, input, onEvent, model });
      }

      const readResults = [];
      if (tools.read && Array.isArray(input.files)) {
        for (const file of input.files) {
          readResults.push(await tools.read(file));
        }
      }

      const patchProposal = tools.proposePatch
        ? await tools.proposePatch({
            summary: "Mock patch proposal; main flow must review before applying.",
            edits:
              input.target && typeof input.content === "string"
                ? [{ path: input.target, content: input.content }]
                : [],
            diff: "",
          })
        : undefined;

      const output = {
        provider: name,
        agent,
        model,
        observations: readResults.map((result) => ({
          path: result.path,
          ok: result.ok,
          bytes: result.content ? result.content.length : 0,
        })),
        findings: [
          {
            severity: "info",
            message: "Mock provider completed without direct write access.",
          },
        ],
        providerSession: {
          provider: name,
          model,
          sessionId: `mock:${agent?.id || name}`,
        },
        unverified: ["No real model was called in Phase 0."],
      };

      if (patchProposal) {
        output.patchProposal = patchProposal;
      }
      if (Array.isArray(input.toolIntents)) {
        output.toolIntents = input.toolIntents;
      }

      return output;
    },
  };
}

function runMockAgentLoopTurn({ name, agent, input, onEvent, model }) {
  if (/provider error redaction/i.test(String(input.task || ""))) {
    throw new Error(
      "\u001b[31mMock provider failed\u001b[0m api_key=odai-provider-error-secret Bearer odai-provider-error-bearer-secret token=odai-provider-error-token-secret.",
    );
  }

  const turn = Number(input.turn || 1);
  const output = {
    provider: name,
    agent,
    model,
    text: `Mock agent loop turn ${turn}.`,
    findings: [
      {
        severity: "info",
        message: "Mock main agent returned tool intents for odai runtime dispatch.",
      },
    ],
    providerSession: {
      provider: name,
      model,
      sessionId: `mock:${agent?.id || name}`,
      turn,
    },
    unverified: ["No real model was called in the mock agent loop."],
  };

  if (/model output redaction/i.test(String(input.task || ""))) {
    output.text = "Mock model output api_key=odai-model-output-secret and Bearer odai-model-bearer-secret.";
    output.findings = [
      {
        severity: "info",
        message: "Mock finding includes token=odai-model-finding-secret.",
      },
    ];
    output.toolIntents = [];
    onEvent?.({
      type: "provider-text",
      text: output.text,
    });
    return output;
  }

  if (/provider session redaction/i.test(String(input.task || ""))) {
    output.text = "Mock provider session redaction completed.";
    output.providerSession = {
      provider: name,
      sessionId: "session:normal-id",
      responseId: "resp-api_key=odai-provider-session-secret",
      requestId: "Bearer odai-provider-session-bearer-secret",
      threadId: "thread-token=odai-provider-session-token-secret",
    };
    output.toolIntents = [];
    onEvent?.({
      type: "provider-text",
      text: output.text,
    });
    return output;
  }

  if (/provider context redaction/i.test(String(input.task || ""))) {
    output.text = `Mock provider context ${JSON.stringify(input.conversationContext || {})}`;
    output.toolIntents = [];
    onEvent?.({
      type: "provider-text",
      text: output.text,
    });
    return output;
  }

  onEvent?.({
    type: "provider-text",
    text: output.text,
  });

  if (turn === 1 && Array.isArray(input.toolIntents) && input.toolIntents.length > 0) {
    output.toolIntents = input.toolIntents;
    return output;
  }

  if (turn === 1 && input.target && typeof input.content === "string") {
    output.toolIntents = [
      {
        type: "read",
        path: input.target,
      },
    ];
    return output;
  }

  if (turn === 2 && input.target && typeof input.content === "string") {
    output.toolIntents = [
      {
        type: "write",
        path: input.target,
        content: input.content,
      },
    ];
    return output;
  }

  if (turn === 1 && Array.isArray(input.files) && input.files.length > 0) {
    output.toolIntents = input.files.map((file) => ({
      type: "read",
      path: file,
    }));
    return output;
  }

  output.text = "Mock agent loop completed without more tool intents.";
  output.toolIntents = [];
  return output;
}

function normalizeModelOverride(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
