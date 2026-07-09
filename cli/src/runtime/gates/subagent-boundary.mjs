export function subagentBoundaryGate(intent) {
  if (intent.actor?.kind !== "subagent") {
    return { allow: true };
  }

  if (["write", "shell", "network"].includes(intent.type)) {
    return {
      allow: false,
      gate: "subagent-boundary",
      reason: "Subagents cannot directly execute write, shell, or network tools; return a proposal to the main flow.",
    };
  }

  if (intent.type === "ask-user" || intent.type === "complete" || intent.type === "spawn-subagent") {
    return {
      allow: false,
      gate: "subagent-boundary",
      reason: "Subagents do not own the user channel or completion decision.",
    };
  }

  return { allow: true };
}
