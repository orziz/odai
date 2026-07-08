export function perceptionGate(intent) {
  if (intent.type !== "write" || !isPerceptionSensitive(intent)) {
    return { allow: true };
  }

  if (hasAcceptanceEvidence(intent)) {
    return { allow: true };
  }

  return {
    allow: false,
    gate: "perception",
    reason: "Perception-sensitive writes require frozen acceptance evidence before changing files.",
  };
}

function isPerceptionSensitive(intent) {
  return intent.risk === "perception" || intent.perception === true;
}

function hasAcceptanceEvidence(intent) {
  return Boolean(intent.acceptanceEvidence || intent.acceptanceCriteria);
}
