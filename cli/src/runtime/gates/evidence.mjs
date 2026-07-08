export function evidenceGate(intent, context) {
  if (intent.type !== "write") {
    return { allow: true };
  }

  if (context.evidence.hasRead(intent.path) || context.evidence.hasLocation?.(intent.path)) {
    return { allow: true };
  }

  return {
    allow: false,
    gate: "evidence",
    reason: `Refusing write before target has been read or located as evidence: ${intent.path}`,
  };
}
