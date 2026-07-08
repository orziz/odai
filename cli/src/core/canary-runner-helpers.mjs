import path from "node:path";
import { DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS } from "../runtime/model-tool-intents.mjs";
import { applyProviderCommandOption, enabledFlagValue, optionToken } from "./cli-args.mjs";

export function buildCanaryTaskArgv({ args, prompt, root }) {
  const riskFlags = [
    ...(args.useApiKey ? ["--use-api-key"] : []),
    ...(args.useProviderCommand ? ["--use-provider-command"] : []),
  ];
  const maxTurnFlags = Number.isFinite(args.maxTurns) && args.maxTurns !== 4
    ? ["--max-turns", String(args.maxTurns)]
    : [];
  const providerFlags = args.provider ? ["--provider", args.provider] : [];
  const runtimeCase = normalizeRuntimeCanaryCase(args.runtimeCase);

  if (runtimeCase === "subagent-write-denied") {
    return [
      prompt || "runtime canary: subagent write denied",
      "--profile",
      "reviewer",
      "--provider",
      args.provider || "mock-reviewer",
      "--tool-intent-json",
      JSON.stringify({
        type: "write",
        path: path.join(root, "src", "app.js"),
        content: "subagent should not write\n",
      }),
      ...riskFlags,
    ];
  }

  if (runtimeCase === "network-default-denied") {
    return [
      prompt || "runtime canary: network denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "network",
        url: "https://example.com/odai-runtime-canary",
        method: "GET",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "new-file-checkpoint") {
    return [
      prompt || "runtime canary: new file checkpoint",
      "--agent-loop",
      ...providerFlags,
      "--target",
      path.join(root, ".odai", "runs", `runtime-canary-created-${process.pid}-${Date.now()}.txt`),
      "--content",
      "runtime canary created\n",
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "secret-read-denied") {
    return [
      prompt || "runtime canary: secret read denied",
      "--agent-loop",
      ...providerFlags,
      "--file",
      path.join(root, ".env"),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "secret-write-denied") {
    return [
      prompt || "runtime canary: secret write denied",
      "--agent-loop",
      ...providerFlags,
      "--target",
      path.join(root, ".env"),
      "--content",
      "ODAI_RUNTIME_CANARY_SECRET=must-not-be-written\n",
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "sensitive-intent-redaction") {
    return [
      prompt || "runtime canary: sensitive intent redaction",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "network",
        url: "https://example.com/odai-runtime-canary?token=odai-runtime-secret&ok=1",
        method: "GET",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "stop-repeated-failure") {
    const target = path.join(root, "runtime-canary-stop-target.txt");
    const repeatedWrite = {
      type: "write",
      path: target,
      content: "stop canary should not write\n",
    };
    return [
      prompt || "runtime canary: stop repeated failure",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify(repeatedWrite),
      "--tool-intent-json",
      JSON.stringify(repeatedWrite),
      "--tool-intent-json",
      JSON.stringify(repeatedWrite),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "perception-write-denied") {
    return [
      prompt || "runtime canary: perception write denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "write",
        path: path.join(root, "runtime-canary-perception-target.txt"),
        content: "perception canary should not write\n",
        risk: "perception",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "shell-intent-record-only") {
    const target = path.join(root, "runtime-canary-shell-target.txt");
    return [
      prompt || "runtime canary: shell intent record only",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "shell",
        command: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(target)}, "shell canary executed\\n")`,
          "Authorization: Bearer odai-shell-secret-token",
          "TOKEN=odai-shell-env-secret",
        ],
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "subagent-user-channel-denied") {
    return [
      prompt || "runtime canary: subagent user channel denied",
      "--profile",
      "reviewer",
      "--provider",
      args.provider || "mock-reviewer",
      "--tool-intent-json",
      JSON.stringify({
        type: "ask-user",
        question: "Can the subagent ask the user directly?",
      }),
      "--tool-intent-json",
      JSON.stringify({
        type: "complete",
        summary: "Subagent claims the task is complete.",
      }),
      ...riskFlags,
    ];
  }

  if (runtimeCase === "tool-intent-overflow-denied") {
    const readIntent = {
      type: "read",
      path: path.join(root, "src", "app.js"),
    };
    return [
      prompt || "runtime canary: tool intent overflow denied",
      "--agent-loop",
      ...providerFlags,
      ...Array.from({ length: 21 }, () => ["--tool-intent-json", JSON.stringify(readIntent)]).flat(),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "tool-intent-payload-denied") {
    return [
      prompt || "runtime canary: tool intent payload denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "write",
        path: path.join(root, ".odai", "runs", "runtime-canary-payload-target.txt"),
        content: "x".repeat(DEFAULT_MAX_MODEL_TOOL_INTENT_CHARS + 1),
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "production-authorization-denied") {
    return [
      prompt || "runtime canary: production authorization denied",
      "--agent-loop",
      ...providerFlags,
      "--tool-intent-json",
      JSON.stringify({
        type: "shell",
        command: ["deploy", "production"],
        risk: "production",
      }),
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "model-output-redaction") {
    return [
      prompt || "runtime canary: model output redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "provider-error-redaction") {
    return [
      prompt || "runtime canary: provider error redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "provider-session-redaction") {
    return [
      prompt || "runtime canary: provider session redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "provider-context-redaction") {
    return [
      prompt || "runtime canary: provider context redaction",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  if (runtimeCase === "task-persistence-redaction") {
    return [
      prompt || "runtime canary: task persistence redaction api_key=odai-task-secret Bearer odai-task-bearer-secret token=odai-task-token-secret",
      "--agent-loop",
      ...providerFlags,
      ...maxTurnFlags,
      ...riskFlags,
    ];
  }

  return [
    prompt || "canary prompt",
    "--agent-loop",
    ...providerFlags,
    ...args.files.flatMap((file) => ["--file", file]),
    ...maxTurnFlags,
    ...riskFlags,
  ];
}

export function buildCanaryConversationContext({ runtimeCase } = {}) {
  if (runtimeCase !== "provider-context-redaction") {
    return undefined;
  }
  return {
    status: "ready",
    kind: "session-compact-context",
    sourceSessionId: "runtime-canary-context-source",
    sourceTranscriptPath: "/tmp/odai-runtime-canary-context-transcript-secret.jsonl",
    currentTranscriptPath: "/tmp/odai-runtime-canary-current-transcript-secret.jsonl",
    notRestored: ["api-key-confirmation", "provider-command-confirmation"],
    authorizations: {
      approvedScopes: ["risk:production"],
      deniedScopes: ["risk:external"],
    },
    providerSessions: [
      { provider: "other-provider", sessionId: "other-context-session-should-not-leak" },
      { provider: "mock-main", sessionId: "mock-main-context-session" },
    ],
    lastResult: {
      status: "ready",
      task: "previous provider context canary",
      savedRecordPath: "/tmp/odai-runtime-canary-run-record-secret.json",
      requiredAuthorizations: ["risk:credential"],
      requiredAuthorizationCount: 1,
      providerSessions: [{ provider: "mock-main", sessionId: "mock-main-last-result-session" }],
    },
    recent: [
      { type: "authorization-result", scope: "risk:billing", approved: true, answered: true },
    ],
  };
}

export function normalizeRuntimeCanaryCase(value = "") {
  const item = String(value || "").trim();
  if (!item) return "";
  const aliases = {
    "1": "subagent-write-denied",
    "subagent-write": "subagent-write-denied",
    "subagent-write-denied": "subagent-write-denied",
    "2": "network-default-denied",
    "network-deny": "network-default-denied",
    "network-default-denied": "network-default-denied",
    "3": "new-file-checkpoint",
    "new-file": "new-file-checkpoint",
    "new-file-checkpoint": "new-file-checkpoint",
    "4": "secret-read-denied",
    "secret-read": "secret-read-denied",
    "secret-read-denied": "secret-read-denied",
    "5": "secret-write-denied",
    "secret-write": "secret-write-denied",
    "secret-write-denied": "secret-write-denied",
    "6": "sensitive-intent-redaction",
    "redaction": "sensitive-intent-redaction",
    "sensitive-intent-redaction": "sensitive-intent-redaction",
    "7": "stop-repeated-failure",
    "stop": "stop-repeated-failure",
    "stop-repeated-failure": "stop-repeated-failure",
    "8": "perception-write-denied",
    "perception": "perception-write-denied",
    "perception-write-denied": "perception-write-denied",
    "9": "shell-intent-record-only",
    "shell": "shell-intent-record-only",
    "shell-record-only": "shell-intent-record-only",
    "shell-intent-record-only": "shell-intent-record-only",
    "10": "subagent-user-channel-denied",
    "subagent-user-channel": "subagent-user-channel-denied",
    "subagent-ask-complete": "subagent-user-channel-denied",
    "subagent-user-channel-denied": "subagent-user-channel-denied",
    "11": "tool-intent-overflow-denied",
    "overflow": "tool-intent-overflow-denied",
    "tool-intent-overflow": "tool-intent-overflow-denied",
    "tool-intent-overflow-denied": "tool-intent-overflow-denied",
    "12": "production-authorization-denied",
    "production": "production-authorization-denied",
    "production-authorization": "production-authorization-denied",
    "production-authorization-denied": "production-authorization-denied",
    "13": "model-output-redaction",
    "model-output": "model-output-redaction",
    "model-output-redaction": "model-output-redaction",
    "14": "provider-error-redaction",
    "provider-error": "provider-error-redaction",
    "provider-error-redaction": "provider-error-redaction",
    "15": "provider-session-redaction",
    "provider-session": "provider-session-redaction",
    "provider-session-redaction": "provider-session-redaction",
    "16": "provider-context-redaction",
    "provider-context": "provider-context-redaction",
    "provider-context-redaction": "provider-context-redaction",
    "17": "task-persistence-redaction",
    "task-persistence": "task-persistence-redaction",
    "task-persistence-redaction": "task-persistence-redaction",
    "18": "tool-intent-payload-denied",
    "payload": "tool-intent-payload-denied",
    "tool-intent-payload": "tool-intent-payload-denied",
    "tool-intent-payload-denied": "tool-intent-payload-denied",
  };
  const normalized = aliases[item];
  if (!normalized) {
    throw new Error(`Unknown --runtime-case: ${value}`);
  }
  return normalized;
}

export function summarizeEvidenceCounts(evidence = {}) {
  return {
    events: Array.isArray(evidence.events) ? evidence.events.length : 0,
    denials: Array.isArray(evidence.denials) ? evidence.denials.length : 0,
    commands: Array.isArray(evidence.commands) ? evidence.commands.length : 0,
    checkpoints: Array.isArray(evidence.checkpoints) ? evidence.checkpoints.length : 0,
  };
}

export function parseCanaryArgs(argv) {
  const args = {
    lastMessage: "",
    provider: "",
    runtimeCase: "",
    files: [],
    maxTurns: 4,
    useApiKey: false,
    useProviderCommand: false,
    providerCommandProviders: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--last-message") {
      args.lastMessage = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--runtime-case") {
      args.runtimeCase = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--provider") {
      args.provider = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--file") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.files.push(path.resolve(value));
    } else if (option.name === "--max-turns") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.maxTurns = Number(value);
    } else if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      applyProviderCommandOption(args, option);
    }
  }
  return args;
}
