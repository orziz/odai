import { createHash } from "node:crypto";
import type { RoleContextEntry } from "./routing-context.mjs";
import type { DshAgent, RuntimeTool, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord } from "./runtime-types.mjs";

const SNAPSHOT_CHARS = 2_000_000;
const PAGE_CHARS = 4000;
const READ_BUDGET = 64_000;
const MAX_REQUESTS = 40;
export type ReviewEvidenceReader = (args: unknown) => UnknownRecord;
export interface ReviewEvidenceSnapshot {
  readonly digest: string;
  readonly count: number;
  readonly omitted: number;
  readonly retainedChars: number;
  createReader(): ReviewEvidenceReader;
}

// Only caller-validated, task-bound native tool results enter this snapshot.
// No filesystem, parent session lookup, or execution capability exists here.
export function createReviewEvidenceSnapshot(entries: readonly RoleContextEntry[]): ReviewEvidenceSnapshot {
  let remaining = SNAPSHOT_CHARS;
  const retained = entries.slice(-500).reverse().map(entry => {
    const text = entry.text.slice(0, remaining);
    remaining -= text.length;
    return Object.freeze({ id: `tool-event-${entry.index}`, ...(entry.identity === undefined ? {} : { identity: entry.identity }),
      label: entry.label.slice(0, 200), kinds: Object.freeze([...entry.kinds]),
      originalChars: entry.text.length, sha256: createHash("sha256").update(entry.text).digest("hex"), text });
  }).reverse();
  const digest = createHash("sha256").update(JSON.stringify(retained)).digest("hex");
  const count = retained.length;
  const omitted = entries.length - count;
  const retainedChars = SNAPSHOT_CHARS - remaining;
  return Object.freeze({ digest, count, omitted, retainedChars, createReader() {
    let budget = READ_BUDGET;
    let requests = 0;
    return (args: unknown): UnknownRecord => {
      if (!isUnknownRecord(args) || args.digest !== digest) throw new Error("Review evidence snapshot does not match this dispatch");
      if (Object.keys(args).some(key => !["digest", "action", "id", "offset", "query"].includes(key))) throw new Error("Unknown evidence argument");
      const offset = args.offset ?? 0;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
      if (requests >= MAX_REQUESTS || budget <= 0) throw new Error("Review evidence budget exhausted; return the remaining gap to the controller");
      let result: UnknownRecord;
      if (args.action === "list") {
        if (args.id !== undefined || (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 160))) throw new Error("Invalid evidence catalog request");
        const query = typeof args.query === "string" ? args.query : "";
        const matches = retained.filter(entry => !query || entry.label.includes(query) || entry.text.includes(query)).reverse();
        if (offset > matches.length) throw new Error("Catalog offset is past the snapshot");
        const page = matches.slice(offset, offset + 8);
        result = { digest, action: "list", total: matches.length, omitted, offset,
          nextOffset: offset + page.length < matches.length ? offset + page.length : null,
          entries: page.map(({ text, ...entry }) => ({ ...entry, availableChars: text.length, preview: text.slice(0, 160) })) };
      } else if (args.action === "read") {
        if (args.query !== undefined || typeof args.id !== "string") throw new Error("Read requires a snapshot entry id");
        const entry = retained.find(candidate => candidate.id === args.id);
        if (!entry || offset > entry.text.length) throw new Error("Evidence id or offset is outside this snapshot");
        const text = entry.text.slice(offset, offset + PAGE_CHARS);
        result = { digest, action: "read", id: entry.id, ...(entry.identity === undefined ? {} : { identity: entry.identity }), sha256: entry.sha256,
          originalChars: entry.originalChars, availableChars: entry.text.length, offset, text,
          nextOffset: offset + text.length < entry.text.length ? offset + text.length : null,
          completeCapture: entry.text.length === entry.originalChars };
      } else throw new Error("Evidence action must be list or read");
      const cost = JSON.stringify({ ...result, remainingChars: budget, remainingRequests: MAX_REQUESTS - requests }).length;
      if (cost > budget) throw new Error("Review evidence budget exhausted; return the remaining gap to the controller");
      requests += 1;
      budget -= cost;
      return { ...result, remainingChars: budget, remainingRequests: MAX_REQUESTS - requests };
    };
  } });
}

export function createReviewEvidenceTool(readerFor: (agent: DshAgent) => ReviewEvidenceReader | undefined): RuntimeTool<unknown, UnknownRecord> {
  return {
    name: "odai_review_evidence",
    description: "Read captured evidence from this managed review's immutable snapshot. List entries newest first (optionally by literal query), then read necessary 4000-character pages by id and offset. No file access or execution; missing captures must return to the controller.",
    parameters: { type: "object", additionalProperties: false, required: ["digest", "action"], properties: {
      digest: { type: "string" }, action: { type: "string", enum: ["list", "read"] },
      id: { type: "string" }, offset: { type: "integer", minimum: 0 }, query: { type: "string", maxLength: 160 },
    } },
    output: { schema: { type: "object", additionalProperties: true }, render(_args, value) { return [{ type: "text", text: JSON.stringify(value) }]; } },
    async execute(args, execution) {
      const reader = execution.agent ? readerFor(execution.agent) : undefined;
      if (!reader) throw new Error("Evidence retrieval requires the active managed reviewer session");
      return reader(args);
    },
  };
}
