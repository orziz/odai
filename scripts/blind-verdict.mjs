export function applyDeterministicOverrides(verdict, candidateIds, mapping, recordsByArm) {
  const priorRank = new Map(verdict.ranking.map((id, index) => [id, index]));
  for (const id of candidateIds) {
    const armId = mapping[id];
    const gate = recordsByArm[armId].deterministicGate;
    if (!gate.ok) {
      verdict.candidates[id].score = Math.min(verdict.candidates[id].score, gate.cap);
      verdict.candidates[id].pass = false;
      verdict.candidates[id].critical_failure = true;
      verdict.candidates[id].reason = `${verdict.candidates[id].reason} Deterministic override: ${gate.note}.`;
    } else {
      verdict.candidates[id].pass = verdict.candidates[id].score >= 3 && !verdict.candidates[id].critical_failure;
    }
  }
  verdict.ranking = [...candidateIds].sort((left, right) =>
    verdict.candidates[right].score - verdict.candidates[left].score
      || (priorRank.get(left) ?? candidateIds.length) - (priorRank.get(right) ?? candidateIds.length));
  return verdict;
}
