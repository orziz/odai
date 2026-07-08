import {
  publicToolResult as redactToolResult,
  publicModelList,
  redactCommand,
  redactModelValue,
  redactString,
  redactUrl,
} from "./redaction.mjs";
import { publicOutputKeys } from "./subagent-output-policy.mjs";

export class EvidenceLedger {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.reads = new Set();
    this.writes = [];
    this.commands = [];
    this.network = [];
    this.subagents = [];
    this.denials = [];
    this.checkpoints = [];
    this.locations = [];
    this.located = new Set();
    this.events = [];
    this.clock = clock;
    this.nextSeq = 1;
  }

  recordRead(filePath) {
    this.reads.add(filePath);
    this.located.add(filePath);
    this.recordEvent("read", { path: filePath });
  }

  hasRead(filePath) {
    return this.reads.has(filePath);
  }

  recordLocation(filePath, reason) {
    this.located.add(filePath);
    this.locations.push({ path: filePath, reason });
    this.recordEvent("location", { path: filePath, reason });
  }

  hasLocation(filePath) {
    return this.located.has(filePath);
  }

  recordWrite(filePath, actor, checkpoint) {
    this.writes.push({ path: filePath, actor, checkpoint });
    this.recordEvent("write", { path: filePath, actor, checkpoint });
  }

  recordCheckpoint(checkpoint) {
    this.checkpoints.push(checkpoint);
    this.recordEvent("checkpoint", {
      id: checkpoint.id,
      path: checkpoint.path,
      checkpointPath: checkpoint.checkpointPath,
      existed: checkpoint.existed,
      actor: checkpoint.actor,
    });
  }

  recordCommand(command, actor) {
    const entry = { command: redactCommand(command), actor };
    this.commands.push(entry);
    this.recordEvent("command", entry);
  }

  recordNetwork(result, actor) {
    const entry = {
      url: redactUrl(result.url),
      method: result.method,
      status: result.status,
      ok: result.ok,
      error: typeof result.error === "string" ? redactString(result.error) : result.error,
      actor,
    };
    this.network.push(entry);
    this.recordEvent("network", entry);
  }

  recordSubagent(event) {
    const entry = publicSubagentEvent(event);
    this.subagents.push(entry);
    this.recordEvent("subagent", {
      agent: entry.agent,
      adopted: entry.adopted,
      outputKeys: entry.output.outputKeys,
      outputPolicy: entry.outputPolicy,
      providerSession: entry.output.providerSession,
      unverified: entry.output.unverified,
    });
  }

  recordDenial(denial) {
    this.denials.push(denial);
    this.recordEvent("denial", {
      gate: denial.gate,
      reason: denial.reason,
      intent: denial.intent,
    });
  }

  recordError(error) {
    this.recordEvent("error", {
      message: redactString(error?.message || String(error)),
      name: error?.name || "Error",
    });
  }

  recordEvent(type, data = {}) {
    this.events.push({
      seq: this.nextSeq,
      at: this.clock(),
      type,
      ...data,
    });
    this.nextSeq += 1;
  }

  snapshot() {
    return {
      reads: [...this.reads],
      writes: this.writes,
      commands: this.commands,
      network: this.network,
      subagents: this.subagents,
      denials: this.denials,
      checkpoints: this.checkpoints,
      locations: this.locations,
      events: this.events,
    };
  }
}

function publicSubagentEvent(event = {}) {
  return {
    agent: event.agent,
    adopted: Boolean(event.adopted),
    output: publicSubagentOutput(event.output || {}),
    outputPolicy: event.outputPolicy,
  };
}

function publicSubagentOutput(output = {}) {
  return {
    outputKeys: publicOutputKeys(output),
    provider: output.provider,
    model: output.model,
    text: typeof output.text === "string" ? truncate(redactString(output.text), 2000) : undefined,
    observations: Array.isArray(output.observations) ? output.observations.map(redactModelValue) : undefined,
    findings: Array.isArray(output.findings) ? output.findings.map(redactModelValue) : undefined,
    patchProposal: summarizePatchProposal(output.patchProposal),
    toolIntentCount: Array.isArray(output.toolIntents) ? output.toolIntents.length : undefined,
    toolIntentResults: Array.isArray(output.toolIntentResults)
      ? output.toolIntentResults.map(publicToolResult)
      : undefined,
    toolIntentOverflow: output.toolIntentOverflow,
    providerSession: output.providerSession,
    unverified: publicModelList(output.unverified),
  };
}

function summarizePatchProposal(proposal = {}) {
  if (!proposal) return undefined;
  const edits = Array.isArray(proposal.patch?.edits) ? proposal.patch.edits : [];
  return {
    ok: Boolean(proposal.ok),
    type: proposal.type,
    summary: typeof proposal.patch?.summary === "string" ? redactString(proposal.patch.summary) : proposal.patch?.summary,
    editCount: edits.length,
    editPaths: edits.map((edit) => edit.path).filter(Boolean),
  };
}

function publicToolResult(result = {}) {
  return redactToolResult(result);
}

function truncate(value = "", limit = 2000) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}
