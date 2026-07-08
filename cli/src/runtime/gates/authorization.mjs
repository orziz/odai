export function authorizationGate(intent, context) {
  if (!["destructive", "external", "production", "credential", "cost"].includes(intent.risk)) {
    return { allow: true };
  }

  const scope = `risk:${intent.risk}`;
  if (context.session.isAuthorized(scope)) {
    return { allow: true };
  }

  return {
    allow: false,
    gate: "authorization",
    reason: `Risk '${intent.risk}' requires explicit authorization and stop conditions.`,
  };
}
