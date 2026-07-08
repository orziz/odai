import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { publicProviderSource } from "../config/provider-config.mjs";
import { redactCommand, redactString } from "../runtime/redaction.mjs";

const API_PROVIDER_KINDS = new Set(["api", "openai-compatible"]);
const CLAUDE_RUNTIME_PROVIDER_NAMES = new Set(["claude-cli", "claude-agent-sdk"]);
const SUBSCRIPTION_RUNTIME_KINDS = new Set(["subscription-cli", "subscription-sdk"]);

export function describeExternalEvidence({ workspaceRoot } = {}) {
  if (!workspaceRoot) {
    throw new Error("describeExternalEvidence requires workspaceRoot.");
  }

  const { records, errors } = readWorkspaceRunRecords({ workspaceRoot });
  const providerEvidence = collectProviderEvidence(records);
  const sandboxSmokeEvidence = collectSandboxSmokeEvidence(records);
  const providerRequirement = buildProviderRequirement(providerEvidence);
  const subscriptionCliRequirement = buildSubscriptionCliRequirement(providerEvidence);
  const sandboxRequirement = buildSandboxRequirement(sandboxSmokeEvidence);
  const requirements = [providerRequirement, subscriptionCliRequirement, sandboxRequirement];
  const ready = requirements.filter((requirement) => requirement.status === "ready").length;
  const blocked = requirements.length - ready;

  return {
    status: blocked === 0 ? "ready" : "partial",
    kind: "external-evidence",
    summary: {
      recordsScanned: records.length,
      parseErrors: errors.length,
      ready,
      blocked,
      apiProviders: providerEvidence.apiProviders.length,
      claudeRuntimeProviders: providerEvidence.claudeRuntimeProviders.length,
      subscriptionRuntimeProviders: providerEvidence.subscriptionRuntimeProviders.length,
      subscriptionCliProviders: providerEvidence.subscriptionCliProviders.length,
      strongSandboxSmokes: sandboxSmokeEvidence.length,
    },
    requirements,
    providerEvidence,
    sandboxSmokeEvidence,
    errors,
    note: "Saved external evidence is read from .odai/runs. Readiness-only reports, mock providers, blocked probes, and sandbox smoke without a non-none sandbox plus host escape probe are not counted.",
  };
}

function readWorkspaceRunRecords({ workspaceRoot }) {
  const runsDir = path.join(workspaceRoot, ".odai", "runs");
  if (!existsSync(runsDir)) {
    return { records: [], errors: [] };
  }

  const records = [];
  const errors = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "latest.json") {
      continue;
    }
    const sourcePath = path.join(runsDir, entry.name);
    try {
      records.push({
        recordId: publicRecordId(entry.name),
        rawRecordId: entry.name,
        record: JSON.parse(readFileSync(sourcePath, "utf8")),
      });
    } catch (error) {
      errors.push({
        recordId: publicRecordId(entry.name),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { records, errors };
}

function collectProviderEvidence(records) {
  const apiProviders = [];
  const claudeRuntimeProviders = [];
  const subscriptionRuntimeProviders = [];
  const subscriptionCliProviders = [];
  const seen = new Set();

  for (const entry of records) {
    if (entry.record?.mode !== "doctor") {
      continue;
    }
    for (const probe of providerProbes(entry.record)) {
      if (probe?.status !== "ready" || !probe.provider || probe.provider.kind === "mock") {
        continue;
      }
      const evidence = providerEvidenceItem({ provider: probe.provider, recordId: entry.recordId });
      const key = `${evidence.provider.name}:${evidence.provider.kind}:${entry.rawRecordId || entry.recordId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (API_PROVIDER_KINDS.has(evidence.provider.kind)) {
        apiProviders.push(evidence);
      }
      if (CLAUDE_RUNTIME_PROVIDER_NAMES.has(evidence.provider.name)) {
        claudeRuntimeProviders.push(evidence);
      }
      if (SUBSCRIPTION_RUNTIME_KINDS.has(evidence.provider.kind)) {
        subscriptionRuntimeProviders.push(evidence);
      }
      if (evidence.provider.kind === "subscription-cli") {
        subscriptionCliProviders.push(evidence);
      }
    }
  }

  return {
    apiProviders,
    claudeRuntimeProviders,
    subscriptionRuntimeProviders,
    subscriptionCliProviders,
  };
}

function publicRecordId(name = "") {
  return redactString(String(name || ""));
}

function providerProbes(record) {
  if (Array.isArray(record.probes)) {
    return record.probes;
  }
  if (record.provider) {
    return [record];
  }
  return [];
}

function providerEvidenceItem({ provider, recordId }) {
  return {
    recordId,
    provider: {
      name: provider.name,
      kind: provider.kind,
      auth: provider.auth,
      available: provider.available,
      capabilities: provider.capabilities,
      cost: provider.cost || "unknown",
      source: publicProviderSource(provider.source),
    },
  };
}

function collectSandboxSmokeEvidence(records) {
  const smokes = [];
  for (const entry of records) {
    const record = entry.record;
    const sandboxMode = record?.result?.sandbox?.mode;
    if (
      record?.mode === "doctor" &&
      record?.kind === "sandbox-smoke" &&
      record?.status === "ready" &&
      record?.result?.ok === true &&
      record?.escapeProbe?.hostEscapeCreated === false &&
      typeof sandboxMode === "string" &&
      sandboxMode !== "none"
    ) {
      smokes.push({
        recordId: entry.recordId,
        sandbox: {
          mode: sandboxMode,
          command: redactCommand(record.result.command),
          status: record.result.status,
        },
        escapeProbe: {
          hostEscapeCreated: false,
          status: record.escapeProbe?.result?.status,
        },
      });
    }
  }
  return smokes;
}

function buildProviderRequirement(providerEvidence) {
  const hasApiProvider = providerEvidence.apiProviders.length > 0;
  const hasRuntimeProvider = providerEvidence.subscriptionRuntimeProviders.length > 0;
  const ready = hasApiProvider && hasRuntimeProvider;
  return {
    id: "provider-api-and-runtime",
    status: ready ? "ready" : "blocked",
    need: "At least one saved successful real API provider probe and one saved successful subscription CLI/SDK runtime probe.",
    evidence: {
      apiProviders: providerEvidence.apiProviders,
      runtimeProviders: providerEvidence.subscriptionRuntimeProviders,
    },
    remaining: ready
      ? []
      : providerRequirementRemaining({ hasApiProvider, hasRuntimeProvider }),
  };
}

function providerRequirementRemaining({ hasApiProvider, hasRuntimeProvider }) {
  const remaining = [];
  if (!hasApiProvider && !hasRuntimeProvider) {
    remaining.push(
      "Run odai doctor --all --use-api-key --use-provider-command --save with a real API-key provider and subscription CLI/SDK runtime provider available; add --model <name> if no provider model env is configured.",
    );
    return remaining;
  }
  if (!hasApiProvider) {
    remaining.push(
      "Run odai doctor --provider <api-provider> --use-api-key --model <name> --save with a real API-key or openai-compatible provider.",
    );
  }
  if (!hasRuntimeProvider) {
    remaining.push(
      "Run odai doctor --provider codex-cli --use-provider-command --save, odai doctor --provider grok-cli --use-provider-command --save, or another supported subscription CLI/SDK provider probe after local auth is available.",
    );
  }
  return remaining;
}

function buildSubscriptionCliRequirement(providerEvidence) {
  const ready = providerEvidence.subscriptionCliProviders.length > 0;
  return {
    id: "provider-subscription-cli",
    status: ready ? "ready" : "blocked",
    need: "At least one saved successful subscription CLI provider probe, such as Codex CLI, Claude CLI, or Grok CLI.",
    evidence: providerEvidence.subscriptionCliProviders,
    remaining: ready
      ? []
      : [
          "Run odai doctor --provider codex-cli --use-provider-command --save, odai doctor --provider grok-cli --use-provider-command --save, or another supported subscription CLI probe after local CLI auth is available.",
        ],
  };
}

function buildSandboxRequirement(sandboxSmokeEvidence) {
  const ready = sandboxSmokeEvidence.length > 0;
  return {
    id: "strong-sandbox-smoke",
    status: ready ? "ready" : "blocked",
    need: "At least one saved successful sandbox smoke through odai dispatcher using a non-none shell sandbox and a host escape probe.",
    evidence: sandboxSmokeEvidence,
    remaining: ready
      ? []
      : [
          "Configure a strong sandbox, enable policy for the smoke commands, then run odai doctor --sandbox --smoke --allow-shell --save.",
        ],
  };
}
