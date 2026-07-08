export function stopGate(intent, context) {
  const key = [intent.actor.kind, intent.type, intent.path || intent.command || "unknown"].join(":");
  if (!context.session.shouldStop(key)) {
    return { allow: true };
  }

  return {
    allow: false,
    gate: "stop",
    reason: `Repeated failure threshold reached for ${key}; switch direction or stabilize upstream criteria.`,
  };
}
