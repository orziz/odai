import { redactString, redactUrl } from "./redaction.mjs";

const RUNTIME_OUTPUT_KEYS = new Set([
  "agent",
  "model",
  "provider",
  "providerSession",
  "stderr",
  "text",
  "toolIntentOverflow",
  "toolIntentResults",
  "toolIntents",
  "unverified",
  "usage",
]);

const ALLOWED_OUTPUT_KEY_ALIASES = {
  alternative_paths: ["alternative_paths", "alternativePaths"],
  assumptions: ["assumptions"],
  counterexamples: ["counterexamples"],
  evidence_summary: ["evidence_summary", "evidenceSummary"],
  file_map: ["file_map", "fileMap"],
  findings: ["findings"],
  missing_cases: ["missing_cases", "missingCases"],
  questions: ["questions"],
  rationale: ["rationale"],
  risks: ["risks"],
  test_plan: ["test_plan", "testPlan"],
  unified_diff: ["unified_diff", "unifiedDiff", "patchProposal"],
};

export function summarizeSubagentOutputPolicy({ output = {}, profile = {} } = {}) {
  const rawKeys = Object.keys(output || {});
  const allowedOutputs = normalizeAllowedOutputs(profile.allowedOutputs);
  const allowedDataKeys = allowedOutputDataKeys(allowedOutputs);
  const runtimeKeys = [];
  const allowedKeys = [];
  const unexpectedKeys = [];

  for (const key of rawKeys) {
    const publicKey = publicOutputKey(key);
    if (RUNTIME_OUTPUT_KEYS.has(key)) {
      addUnique(runtimeKeys, publicKey);
    } else if (allowedDataKeys.has(key)) {
      addUnique(allowedKeys, publicKey);
    } else {
      addUnique(unexpectedKeys, publicKey);
    }
  }

  return {
    allowedOutputs: allowedOutputs.map(publicOutputKey),
    runtimeKeys,
    allowedKeys,
    unexpectedKeys,
  };
}

export function publicOutputKeys(output = {}) {
  return Object.keys(output || {}).map(publicOutputKey);
}

function normalizeAllowedOutputs(outputs = []) {
  if (!Array.isArray(outputs)) {
    return [];
  }
  const normalized = [];
  for (const output of outputs) {
    if (typeof output !== "string" || output.trim() === "") {
      continue;
    }
    addUnique(normalized, output.trim());
  }
  return normalized;
}

function allowedOutputDataKeys(outputs = []) {
  const keys = new Set();
  for (const output of outputs) {
    for (const key of ALLOWED_OUTPUT_KEY_ALIASES[output] || [output]) {
      keys.add(key);
    }
  }
  return keys;
}

function publicOutputKey(key = "") {
  return redactString(redactUrl(String(key)));
}

function addUnique(items, value) {
  if (!items.includes(value)) {
    items.push(value);
  }
}
