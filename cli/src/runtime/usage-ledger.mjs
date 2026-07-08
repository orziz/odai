import { normalizeProviderSession } from "./provider-session.mjs";
import { publicModelList, publicUsage, redactString } from "./redaction.mjs";

export class UsageLedger {
  constructor({ clock = () => new Date().toISOString(), now = () => Date.now(), evidence } = {}) {
    this.clock = clock;
    this.now = now;
    this.evidence = evidence;
    this.calls = [];
  }

  async trackProviderCall({ provider, agent, profile, mode, adopted = false, run }) {
    const startedAt = this.clock();
    const startedMs = this.now();
    try {
      const output = await run();
      const call = this.recordProviderOutput({
        provider,
        agent,
        profile,
        mode,
        adopted,
        output,
        startedAt,
        elapsedMs: Math.max(0, this.now() - startedMs),
      });
      return { output, call };
    } catch (error) {
      this.recordProviderError({
        provider,
        agent,
        profile,
        mode,
        startedAt,
        elapsedMs: Math.max(0, this.now() - startedMs),
        error,
      });
      throw error;
    }
  }

  recordProviderOutput({ provider, agent, profile, mode, adopted = false, output = {}, startedAt, elapsedMs }) {
    const call = {
      status: "ready",
      at: startedAt || this.clock(),
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
      provider: provider?.name || output.provider || "unknown",
      providerKind: provider?.kind || "unknown",
      auth: provider?.auth || "unknown",
      model: output.model,
      agent: publicAgent(agent || output.agent),
      profile: profile?.name || profile,
      mode,
      adopted: Boolean(adopted),
      usage: publicUsage(output.usage || output.usageMetadata),
      providerSession: normalizeProviderSession(output.providerSession, {
        provider: provider?.name || output.provider,
        providerKind: provider?.kind,
        model: output.model,
      }),
      cost: { status: "unknown", reason: "provider_cost_not_reported" },
      toolIntentCount: Array.isArray(output.toolIntents) ? output.toolIntents.length : 0,
      unverified: publicModelList(output.unverified),
    };
    this.calls.push(call);
    this.evidence?.recordEvent("provider-call", publicProviderCall(call));
    return call;
  }

  recordProviderError({ provider, agent, profile, mode, startedAt, elapsedMs, error }) {
    const call = {
      status: "failed",
      at: startedAt || this.clock(),
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
      provider: provider?.name || "unknown",
      providerKind: provider?.kind || "unknown",
      auth: provider?.auth || "unknown",
      agent: publicAgent(agent),
      profile: profile?.name || profile,
      mode,
      cost: { status: "unknown", reason: "provider_call_failed" },
      error: {
        name: error?.name || "Error",
        message: redactString(error?.message || String(error)),
      },
    };
    this.calls.push(call);
    this.evidence?.recordEvent("provider-call", publicProviderCall(call));
    return call;
  }

  markAgentAdopted(agentId) {
    let changed = 0;
    for (const call of this.calls) {
      if (call.agent?.id === agentId) {
        call.adopted = true;
        changed += 1;
      }
    }
    if (changed > 0) {
      this.evidence?.recordEvent("provider-call-adopted", { agentId, calls: changed });
    }
    return changed;
  }

  snapshot() {
    return {
      calls: this.calls,
      totals: summarizeCalls(this.calls),
    };
  }
}

function summarizeCalls(calls = []) {
  const byProvider = {};
  for (const call of calls) {
    const provider = call.provider || "unknown";
    byProvider[provider] ||= {
      calls: 0,
      failed: 0,
      elapsedMs: 0,
      usage: {},
      cost: { status: "unknown" },
    };
    byProvider[provider].calls += 1;
    if (call.status === "failed") byProvider[provider].failed += 1;
    byProvider[provider].elapsedMs += call.elapsedMs || 0;
    mergeUsage(byProvider[provider].usage, call.usage);
  }
  return {
    calls: calls.length,
    byProvider,
  };
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") {
      target[key] = (target[key] || 0) + value;
    }
  }
}

function publicAgent(agent = {}) {
  return {
    id: agent.id,
    role: agent.role,
    profile: agent.profile,
    provider: agent.provider,
  };
}

function publicProviderCall(call = {}) {
  return {
    status: call.status,
    provider: call.provider,
    providerKind: call.providerKind,
    auth: call.auth,
    model: call.model,
    agent: call.agent,
    profile: call.profile,
    mode: call.mode,
    adopted: call.adopted,
    usage: call.usage,
    providerSession: call.providerSession,
    cost: call.cost,
    elapsedMs: call.elapsedMs,
    toolIntentCount: call.toolIntentCount,
    error: call.error,
  };
}
