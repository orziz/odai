import { createHash } from "node:crypto";

import { classifyResponsibilityInterruptionText } from "./router.mjs";
import type { RequirementDecision } from "./responsibility-gap.mjs";
import type { DshEvent, DshSession, RuntimeEventData, UnknownRecord } from "./runtime-types.mjs";
import { isUnknownRecord, sessionEvents } from "./runtime-types.mjs";

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_EVENTS = 80;
const DEFAULT_MAX_ENTRY_CHARS = 4_000;
const REQUIREMENT_PATTERNS = [/requirement/iu, /acceptance/iu, /需求/u, /要求/u, /目标/u, /验收/u];
const DIFF_OUTPUT_PATTERNS = [/diff --git/iu, /^---\s+a\/[^\n]+\n\+\+\+\s+b\//imu];
const DIFF_COMMAND_PATTERNS = [/^\s*git(?:\.exe)?\s+diff(?:\s|$)/iu];
const TEST_COMMAND_PATTERNS = [
  /^\s*(?:&\s*)?(?:"[^"\r\n]*[\\/]node(?:\.exe)?"|[A-Za-z]:\\[^\s"\r\n]*[\\/]node(?:\.exe)?|\/[^\s"\r\n]*\/node|node(?:\.exe)?)\s+--test(?:\s|$)/iu,
  /^\s*(?:npm|pnpm|yarn)(?:\.cmd)?(?:\s+--(?:prefix|dir)\s+(?:"[^"]+"|\S+))?\s+(?:run\s+)?test(?:[:.][\w.-]+)?(?:\s|$)/iu,
  /^\s*(?:(?:npx|pnpm\s+exec|yarn\s+exec)(?:\.cmd)?|npm(?:\.cmd)?\s+exec(?:\s+--)?)\s+(?:--yes\s+)?(?:pytest|vitest|jest|mocha)(?:\.cmd)?(?:\s|$)/iu,
  /^\s*(?:pytest|vitest|jest|mocha)(?:\.cmd)?(?:\s|$)/iu,
  /^\s*(?:go|cargo|dotnet)\s+test(?:\s|$)/iu,
  /^\s*(?:(?:\.\/)?(?:[\w.-]+\/)*mvnw(?:\.cmd)?|mvn(?:\.cmd)?)\s+(?:[^\r\n]*\s)?(?:test|verify)(?:\s|$)/iu,
  /^\s*(?:\.\/)?gradlew(?:\.bat)?\s+(?:[^\r\n]*\s)?test(?:\s|$)/iu,
];
const TEST_SUCCESS_PATTERNS = [
  /exit code:\s*0/iu,
  /(?:^|\n)[^\n]*(?:pass|passed)\s*[:=]?\s*[1-9]\d*/iu,
  /(?:^|\n)[^\n]*[1-9]\d*\s+passed\b/iu,
  /(?:^|\n)[^\n]*fail(?:ed)?\s*[:=]?\s*0\b/iu,
  /\btests?\s+\d+[^\n]*(?:pass|passed)\s+[1-9]\d*[^\n]*fail(?:ed)?\s+0\b/iu,
];
const TEST_FAILURE_PATTERNS = [
  /exit code:\s*[1-9]\d*/iu,
  /(?:^|\n)[^\n]*fail(?:ed)?\s*[:=]?\s*[1-9]\d*/iu,
  /\b(?:tests?|test suite) failed\b/iu,
];
const CHECK_COMMAND_PATTERNS = [
  /^\s*git(?:\.exe)?\s+diff\s+--check(?:\s|$)/iu,
  /^\s*(?:(?:npx|pnpm\s+exec|yarn\s+exec)(?:\.cmd)?|npm(?:\.cmd)?\s+exec(?:\s+--)?)\s+(?:--yes\s+)?(?:eslint|stylelint)(?:\.cmd)?(?:\s|$)/iu,
  /^\s*(?:(?:npx|pnpm\s+exec|yarn\s+exec)(?:\.cmd)?|npm(?:\.cmd)?\s+exec(?:\s+--)?)\s+(?:--yes\s+)?(?:tsc|vue-tsc)(?:\.cmd)?\b[^\r\n]*\s--noEmit(?:\s|$)/iu,
  /^\s*(?:npx(?:\.cmd)?|pnpm(?:\.cmd)?\s+exec|yarn(?:\.cmd)?\s+exec|npm(?:\.cmd)?\s+exec(?:\s+--)?)?\s*prettier(?:\.cmd)?\s+--check(?:\s|$)/iu,
  /^\s*node(?:\.exe)?\s+--check(?:\s|$)/iu,
];
const CHECK_MUTATION_PATTERNS = [/(?:^|\s)--fix(?:\s|$)/iu, /(?:^|\s)(?:--output-file|-o)(?:\s|=)/u];
const WRITE_TOOL_NAMES = new Set<string>(["edit", "write", "apply_patch"]);
const SHELL_TOOL_NAMES = new Set<string>(["bash", "pwsh", "shell", "powershell"]);
const SHELL_CONTROL_CHARACTERS = ";&|<>\r\n()";
const READ_ONLY_SHELL_COMMAND_PATTERNS = [
  /^\s*git(?:\.exe)?\s+(?:status|log|show|rev-parse|ls-files|branch)(?:\s|$)/iu,
  /^\s*(?:Get-[A-Za-z]+|Select-String|Test-Path)(?:\s|$)/iu,
  /^\s*(?:rg|grep|find|ls|pwd|cat|head|tail|wc|where|which|lsof|ps|netstat|ss)(?:\.exe)?(?:\s|$)/iu,
  /^\s*(?:npx(?:\.cmd)?|pnpm(?:\.cmd)?\s+exec|yarn(?:\.cmd)?\s+exec|npm(?:\.cmd)?\s+exec(?:\s+--)?)?\s*prettier(?:\.cmd)?\s+--check(?:\s|$)/iu,
  /^\s*node(?:\.exe)?\s+--check(?:\s|$)/iu,
];
const WRITE_COMMAND_PATTERNS = [
  /(?:^|\s)(?:git\s+apply|apply_patch|sed\s+-i|perl\s+-pi)(?:\s|$)/iu,
  /(?:^|\s)(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)(?:\s|$)/iu,
  /(?:^|\s)(?:rm|mv|cp|mkdir|touch)(?:\s|$)/u,
];

function hasShellControl(command: string): boolean {
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === "\"" && (character === "`" || (character === "$" && command[index + 1] === "("))) return true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === "`" || SHELL_CONTROL_CHARACTERS.includes(character ?? "")
      || (character === "$" && command[index + 1] === "(")) return true;
  }
  return false;
}

function simpleAndChain(command: string): readonly string[] | undefined {
  const segments: string[] = [];
  let quote: "'" | "\"" | undefined;
  let start = 0;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === "\"" && (character === "`" || (character === "$" && command[index + 1] === "("))) return undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      const segment = command.slice(start, index).trim();
      if (!segment) return undefined;
      segments.push(segment);
      start = index + 2;
      index += 1;
      continue;
    }
    if (character === "`" || SHELL_CONTROL_CHARACTERS.replaceAll("&", "").includes(character ?? "")
      || character === "&" || (character === "$" && command[index + 1] === "(")) return undefined;
  }
  if (quote) return undefined;
  const finalSegment = command.slice(start).trim();
  if (!finalSegment) return undefined;
  segments.push(finalSegment);
  return Object.freeze(segments);
}

function parsedRecord(value: unknown): UnknownRecord | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return isUnknownRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasDecisionValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (!isUnknownRecord(value)) return value !== undefined && value !== null;
  return ["answer", "value", "selected", "custom"].some((key) => hasDecisionValue(value[key]));
}

function completeUserDecision(arguments_: unknown, output: string): string | undefined {
  const call = parsedRecord(arguments_);
  const result = parsedRecord(output);
  const rawQuestions = call?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0
    || !rawQuestions.every(isUnknownRecord) || !result) return undefined;
  const questions = rawQuestions;
  const questionIds = questions.map((question) => (
    typeof question.id === "string" ? question.id.trim() : ""
  ));
  if (questionIds.some((id) => !id) || new Set(questionIds).size !== questions.length
    || questions.some((question) => typeof question.question !== "string" || !question.question.trim())) return undefined;

  const rawAnswers = result.answers;
  if (!Array.isArray(rawAnswers) && !isUnknownRecord(rawAnswers)) return undefined;
  const answerIds = Array.isArray(rawAnswers)
    ? rawAnswers.map((answer) => (isUnknownRecord(answer) && typeof answer.id === "string" ? answer.id.trim() : ""))
    : Object.keys(rawAnswers);
  if (answerIds.some((id) => !id) || answerIds.length !== questionIds.length
    || new Set(answerIds).size !== answerIds.length
    || answerIds.some((id) => !questionIds.includes(id))) return undefined;

  const answerFor = (id: string): unknown => Array.isArray(rawAnswers)
    ? rawAnswers.find((answer) => isUnknownRecord(answer) && answer.id === id)
    : rawAnswers[id];
  if (questionIds.some((id) => !hasDecisionValue(answerFor(id)))) return undefined;
  return JSON.stringify({ questions, answers: rawAnswers });
}

export interface RoleContextEntry {
  readonly index: number;
  readonly source: string;
  readonly kinds: readonly string[];
  readonly label: string;
  readonly text: string;
  readonly identity?: string;
}

export interface RoleContextCoverage {
  readonly requirements: boolean;
  readonly requirementDecisionCount: number;
  readonly activeRequirementCount: number;
  readonly supersededRequirementCount: number;
  readonly requirementProvenance: boolean;
  readonly acceptanceCount: number;
  readonly diffCount: number;
  readonly testCount: number;
  readonly failedTestCount: number;
  readonly checkCount: number;
  readonly failedCheckCount: number;
  readonly writeCount: number;
  readonly toolEvidenceCount: number;
  readonly latestWriteIndex: number;
  readonly latestDiffIndex: number;
  readonly latestTestIndex: number;
  readonly latestFailedTestIndex: number;
  readonly latestCheckIndex: number;
  readonly latestFailedCheckIndex: number;
  readonly currentEvidence: boolean;
}

export interface RoleContextDiagnostics {
  readonly rawEventCount: number;
  readonly evidenceEventCount: number;
  readonly selectedEvidenceCount: number;
  readonly omittedEvidenceCount: number;
  readonly nativeToolCallCount: number;
  readonly linkedToolResultCount: number;
  readonly malformedToolResultCount: number;
  readonly unlinkedToolResultCount: number;
  readonly unparsedToolArgumentsCount: number;
  readonly unclassifiedShellResultCount: number;
  readonly diffWithoutPatchCount: number;
  readonly testWithoutVerdictCount: number;
  readonly hostEvidenceAvailable: boolean;
}

export interface RoleContextPacket {
  readonly schemaVersion: 2;
  readonly role: string;
  readonly currentTask: string;
  readonly requirements: readonly RequirementDecision[];
  readonly entries: readonly RoleContextEntry[];
  readonly coverage: RoleContextCoverage;
  readonly diagnostics: RoleContextDiagnostics;
  readonly truncated: boolean;
  readonly digest: string;
  readonly evidenceDigest: string;
  readonly evidenceCount: number;
  readonly toolEvidenceCount: number;
  readonly sufficient: boolean;
}

export interface RoleContextOptions {
  maxChars?: number;
  maxEvents?: number;
  requirements?: readonly RequirementDecision[];
}

interface NativeToolCall {
  readonly index: number;
  readonly seq: number;
  readonly name: string;
  readonly arguments?: unknown;
}

interface NativeToolResult {
  readonly callId: string;
  readonly successful: boolean;
}

function textBlocks(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => textBlocks(item, depth + 1));
  if (!isUnknownRecord(value)) return [];
  if (value.type === "text" && typeof value.text === "string") return [value.text];
  const keys = ["content", "message", "output", "result", "data", "text", "value", "command", "args", "input"];
  return keys.flatMap((key) => key in value ? textBlocks(value[key], depth + 1) : []);
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function directUserMessage(event: DshEvent): UnknownRecord | undefined {
  const message = isUnknownRecord(event.data?.message) ? event.data.message : event.data;
  const source = isUnknownRecord(message?.source) ? message.source : undefined;
  if (typeof message?.role === "string" && message.role !== "user") return undefined;
  return source?.kind === "user" ? message : undefined;
}

function isDirectUserEvent(event: DshEvent): boolean {
  return directUserMessage(event) !== undefined;
}

function toolResultBlocks(value: unknown, depth = 0): UnknownRecord[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => toolResultBlocks(item, depth + 1));
  if (!isUnknownRecord(value)) return [];
  const own = value.type === "tool-result" ? [value] : [];
  return own.concat(Object.values(value).flatMap((item) => toolResultBlocks(item, depth + 1)));
}

function nativeToolResult(data: RuntimeEventData): NativeToolResult | undefined {
  const blocks = toolResultBlocks(data);
  if (blocks.length !== 1) return undefined;
  const block = blocks[0];
  const message = isUnknownRecord(data.message) ? data.message : undefined;
  const source = isUnknownRecord(message?.source) ? message.source : undefined;
  if (source?.kind !== "tool"
    || typeof source.callId !== "string"
    || !source.callId
    || block?.toolCallId !== source.callId
    || typeof block.isError !== "boolean"
    || !Array.isArray(block.content)) return undefined;
  return Object.freeze({
    callId: source.callId,
    successful: block.isError === false && !data.error,
  });
}

interface MutableDiagnostics {
  rawEventCount: number;
  evidenceEventCount: number;
  selectedEvidenceCount: number;
  omittedEvidenceCount: number;
  nativeToolCallCount: number;
  linkedToolResultCount: number;
  malformedToolResultCount: number;
  unlinkedToolResultCount: number;
  unparsedToolArgumentsCount: number;
  unclassifiedShellResultCount: number;
  diffWithoutPatchCount: number;
  testWithoutVerdictCount: number;
}

function commandFromArguments(value: unknown): Readonly<{ command: string; parsed: boolean }> {
  let arguments_ = value;
  if (typeof arguments_ === "string") {
    const trimmed = arguments_.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return Object.freeze({ command: arguments_, parsed: true });
    }
    try {
      arguments_ = JSON.parse(trimmed) as unknown;
    } catch {
      return Object.freeze({ command: "", parsed: false });
    }
  }
  if (!isUnknownRecord(arguments_)) return Object.freeze({ command: "", parsed: false });
  for (const field of ["command", "cmd", "script"]) {
    if (typeof arguments_[field] === "string") return Object.freeze({ command: arguments_[field], parsed: true });
  }
  return Object.freeze({ command: "", parsed: true });
}

function normalizedToolName(name: string): string {
  const segments = name.split(/[.:/]/u).filter(Boolean);
  return segments.at(-1) ?? name;
}

function resultReferencesCall(event: DshEvent, call: NativeToolCall): boolean {
  return Number.isSafeInteger(call?.seq)
    && Array.isArray(event?.sourceEventSeqs)
    && event.sourceEventSeqs.length === 1
    && event.sourceEventSeqs[0] === call.seq;
}

function nativeToolCalls(events: readonly DshEvent[]): Map<string, NativeToolCall> {
  const calls = new Map<string, NativeToolCall>();
  const duplicates = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== "tool/call") continue;
    const callId = event.data?.callId;
    const name = event.data?.name;
    if (typeof callId !== "string" || !callId || typeof name !== "string" || !name || !Number.isSafeInteger(event.seq)) continue;
    if (calls.has(callId)) { calls.delete(callId); duplicates.add(callId); continue; }
    if (duplicates.has(callId)) continue;
    calls.set(callId, Object.freeze({ index, seq: event.seq as number, name, arguments: event.data?.arguments }));
  }
  return calls;
}

function eventEvidence(
  event: DshEvent,
  index: number,
  calls: ReadonlyMap<string, NativeToolCall>,
  diagnostics: MutableDiagnostics,
): Omit<RoleContextEntry, "kinds"> & { kinds: string[] } | undefined {
  if (event?.type === "user/message") {
    if (!isDirectUserEvent(event)) return undefined;
    const text = textBlocks(event.data).join("\n").trim();
    if (!text) return undefined;
    if (classifyResponsibilityInterruptionText(text) === "continue") {
      return { index, source: "user", kinds: ["continuation"], label: "direct-user continuation", text };
    }
    return { index, source: "user", kinds: ["requirement", "acceptance"], label: "user-owned requirement and acceptance", text };
  }
  if (["assistant/message", "agent/message", "message/assistant"].includes(event?.type)) {
    const text = textBlocks(event.data).join("\n").trim();
    if (!text) return undefined;
    const kinds = ["assistant-claim"];
    if (matchesAny(text, REQUIREMENT_PATTERNS)) kinds.push("requirement");
    return { index, source: "assistant", kinds, label: "controller claim", text };
  }
  if (event?.type === "odai/responsibility-returned"
    && event.data?.returned === true
    && typeof event.data?.responsibility === "string"
    && typeof event.data?.summary === "string") {
    const responsibility = event.data.responsibility;
    const evidenceRefs = Array.isArray(event.data.evidenceRefs)
      ? event.data.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
      : [];
    const kinds = [`${responsibility}-handback`];
    if (responsibility === "planner") kinds.push("planning");
    if (responsibility === "researcher") kinds.push("research");
    if (responsibility === "reviewer") kinds.push("review-finding");
    const scopeId = typeof event.data.scopeId === "string" ? event.data.scopeId : "unknown";
    return {
      index,
      source: "responsibility-handback",
      kinds,
      label: `${responsibility} responsibility handback ${scopeId}`,
      identity: `responsibility-scope:${scopeId}`,
      text: [event.data.summary, evidenceRefs.length > 0 ? `Evidence: ${evidenceRefs.join("; ")}` : ""].filter(Boolean).join("\n\n"),
    };
  }
  if (event?.type === "tool/result") {
    const result = nativeToolResult(event.data);
    if (!result) {
      diagnostics.malformedToolResultCount += 1;
      return undefined;
    }
    const call = calls.get(result.callId);
    if (!call || call.index >= index || !resultReferencesCall(event, call)) {
      diagnostics.unlinkedToolResultCount += 1;
      return undefined;
    }
    diagnostics.linkedToolResultCount += 1;
    const decoded = commandFromArguments(call.arguments);
    if (!decoded.parsed) diagnostics.unparsedToolArgumentsCount += 1;
    const command = decoded.command;
    const toolName = normalizedToolName(call.name);
    if (result.successful && toolName === "ask_user_question") {
      const decision = completeUserDecision(call.arguments, textBlocks(event.data).join("\n").trim());
      if (decision) {
        const identity = `tool-call:${result.callId}`;
        return {
          index,
          source: "user-decision",
          kinds: ["tool", "requirement", "acceptance", "user-decision"],
          label: `authenticated user decision (${identity})`,
          identity,
          text: decision,
        };
      }
    }
    const simpleCommand = command !== "" && !hasShellControl(command);
    const andChain = command === "" ? undefined : simpleAndChain(command);
    const compoundReadOnly = Boolean(andChain && andChain.length > 1 && andChain.every((segment) => (
      !matchesAny(segment, CHECK_MUTATION_PATTERNS)
      && (matchesAny(segment, READ_ONLY_SHELL_COMMAND_PATTERNS)
        || matchesAny(segment, CHECK_COMMAND_PATTERNS)
        || matchesAny(segment, DIFF_COMMAND_PATTERNS)
        || matchesAny(segment, TEST_COMMAND_PATTERNS))
    )));
    const checkCommand = simpleCommand
      && matchesAny(command, CHECK_COMMAND_PATTERNS)
      && !matchesAny(command, CHECK_MUTATION_PATTERNS);
    const diffCommand = simpleCommand && !checkCommand && matchesAny(command, DIFF_COMMAND_PATTERNS);
    const testCommand = simpleCommand && matchesAny(command, TEST_COMMAND_PATTERNS);
    const explicitWrite = WRITE_TOOL_NAMES.has(toolName) || matchesAny(command, WRITE_COMMAND_PATTERNS);
    const unknownShellMutation = SHELL_TOOL_NAMES.has(toolName)
      && !diffCommand && !testCommand && !checkCommand && !compoundReadOnly
      && (hasShellControl(command) || !matchesAny(command, READ_ONLY_SHELL_COMMAND_PATTERNS));
    if (SHELL_TOOL_NAMES.has(toolName) && !diffCommand && !testCommand && !checkCommand && !compoundReadOnly && !explicitWrite
      && !matchesAny(command, READ_ONLY_SHELL_COMMAND_PATTERNS)) diagnostics.unclassifiedShellResultCount += 1;
    const writeCommand = explicitWrite || unknownShellMutation;
    if (!result.successful && !testCommand && !checkCommand && !writeCommand) return undefined;
    const output = textBlocks(event.data).join("\n").trim();
    const kinds: string[] = result.successful ? ["tool"] : [];
    if (result.successful && diffCommand) {
      if (matchesAny(output, DIFF_OUTPUT_PATTERNS)) kinds.push("diff");
      else diagnostics.diffWithoutPatchCount += 1;
    }
    if (writeCommand) kinds.push("write");
    if (testCommand) {
      const hasFailure = matchesAny(output, TEST_FAILURE_PATTERNS);
      if (result.successful && !matchesAny(output, TEST_SUCCESS_PATTERNS) && !hasFailure) {
        diagnostics.testWithoutVerdictCount += 1;
      }
      kinds.push(result.successful && !hasFailure ? "test" : "test-failed");
    }
    if (checkCommand) {
      const checkPassed = result.successful && !matchesAny(output, TEST_FAILURE_PATTERNS);
      kinds.push(checkPassed ? "check" : "check-failed");
    }
    const identity = `tool-call:${result.callId}`;
    const text = [command ? `command: ${command}` : "", output || "(no textual result)"].filter(Boolean).join("\n\n");
    return { index, source: "tool", kinds, label: `tool ${call.name} (${identity})`, identity, text };
  }
  if (event?.type === "odai/tool-observed" && event.data?.isError === false) {
    const identity = typeof event.data.callId === "string" ? `tool-call:${event.data.callId}` : undefined;
    const tool = typeof event.data.tool === "string" ? event.data.tool : "unknown";
    const normalized = normalizedToolName(tool);
    return {
      index, source: "tool", kinds: ["tool", ...(WRITE_TOOL_NAMES.has(normalized) ? ["write"] : [])],
      label: `observed tool ${tool}${identity ? ` (${identity})` : ""}`,
      ...(identity ? { identity } : {}), text: JSON.stringify(event.data),
    };
  }
  return undefined;
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, limit - 24))}\n...[packet truncated]`, truncated: true };
}

function digestPacket(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function coverageFor(
  currentTask: string,
  entries: readonly RoleContextEntry[],
  requirements: readonly RequirementDecision[],
): Readonly<RoleContextCoverage> {
  const matching = (kind: string): RoleContextEntry[] => entries.filter((entry) => entry.kinds.includes(kind));
  const latestIndex = (kind: string): number => matching(kind).reduce((latest, entry) => Math.max(latest, entry.index), -1);
  const acceptanceCount = matching("acceptance").length;
  const activeRequirementCount = requirements.filter((requirement) => requirement.status === "active").length;
  const supersededRequirementCount = requirements.filter((requirement) => requirement.status === "superseded").length;
  const requirementProvenance = requirements.length > 0 && requirements.every((requirement) => (
    typeof requirement.sourceMessageId === "string" && Number.isSafeInteger(requirement.sourceOrder)
  ));
  const diffEntries = matching("diff");
  const testEntries = matching("test");
  const failedTestEntries = matching("test-failed");
  const checkEntries = matching("check");
  const failedCheckEntries = matching("check-failed");
  const verificationEntries = [...testEntries, ...checkEntries];
  const latestWriteIndex = latestIndex("write");
  const latestDiffIndex = latestIndex("diff");
  const latestTestIndex = latestIndex("test");
  const latestFailedTestIndex = latestIndex("test-failed");
  const latestCheckIndex = latestIndex("check");
  const latestFailedCheckIndex = latestIndex("check-failed");
  const latestVerificationIndex = Math.max(latestTestIndex, latestCheckIndex);
  const latestFailedVerificationIndex = Math.max(latestFailedTestIndex, latestFailedCheckIndex);
  const currentEvidence = acceptanceCount > 0
    && latestDiffIndex >= 0 && latestVerificationIndex >= 0
    && latestDiffIndex > latestWriteIndex && latestVerificationIndex > latestDiffIndex
    && latestVerificationIndex > latestFailedVerificationIndex
    && diffEntries.some((diff) => verificationEntries.some((verification) => diff.identity !== verification.identity));
  return Object.freeze({
    requirements: Boolean(currentTask) || matching("requirement").length > 0,
    requirementDecisionCount: requirements.length,
    activeRequirementCount,
    supersededRequirementCount,
    requirementProvenance,
    acceptanceCount, diffCount: diffEntries.length, testCount: testEntries.length,
    failedTestCount: failedTestEntries.length, checkCount: checkEntries.length,
    failedCheckCount: failedCheckEntries.length, writeCount: matching("write").length,
    toolEvidenceCount: matching("tool").length, latestWriteIndex, latestDiffIndex,
    latestTestIndex, latestFailedTestIndex, latestCheckIndex, latestFailedCheckIndex, currentEvidence,
  });
}

export interface RoleContextAgent {
  readonly session?: Pick<DshSession, "snapshotEvents">;
}

export function buildRoleContextPacket(
  agent: RoleContextAgent,
  role: string,
  taskText: unknown,
  options: RoleContextOptions = {},
): Readonly<RoleContextPacket> {
  const maxChars = Number.isSafeInteger(options.maxChars) && (options.maxChars ?? 0) > 0 ? options.maxChars as number : DEFAULT_MAX_CHARS;
  const maxEvents = Number.isSafeInteger(options.maxEvents) && (options.maxEvents ?? 0) > 0 ? options.maxEvents as number : DEFAULT_MAX_EVENTS;
  const suppliedRequirements = Object.freeze((options.requirements ?? []).map((requirement) => Object.freeze({ ...requirement })));
  const requirementChars = JSON.stringify(suppliedRequirements).length;
  const requirementsFit = requirementChars <= Math.floor(maxChars / 3);
  const requirements = requirementsFit ? suppliedRequirements : Object.freeze([] as RequirementDecision[]);
  const includedRequirementChars = requirementsFit ? requirementChars : 0;
  const taskBudget = Math.max(32, Math.floor((maxChars - includedRequirementChars) / 3));
  const task = truncateText(String(taskText ?? "").trim(), taskBudget);
  const events = sessionEvents(agent?.session);
  const calls = nativeToolCalls(events);
  const mutableDiagnostics: MutableDiagnostics = {
    rawEventCount: events.length,
    evidenceEventCount: 0,
    selectedEvidenceCount: 0,
    omittedEvidenceCount: 0,
    nativeToolCallCount: calls.size,
    linkedToolResultCount: 0,
    malformedToolResultCount: 0,
    unlinkedToolResultCount: 0,
    unparsedToolArgumentsCount: 0,
    unclassifiedShellResultCount: 0,
    diffWithoutPatchCount: 0,
    testWithoutVerdictCount: 0,
  };
  const allEvidence: RoleContextEntry[] = [];
  const preTruncatedIndices = new Set<number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const entry = eventEvidence(event, index, calls, mutableDiagnostics);
    if (!entry) continue;
    const bounded = truncateText(entry.text, DEFAULT_MAX_ENTRY_CHARS);
    if (bounded.truncated) preTruncatedIndices.add(entry.index);
    allEvidence.push(Object.freeze({ ...entry, kinds: Object.freeze([...new Set(entry.kinds)]), text: bounded.text }));
  }
  mutableDiagnostics.evidenceEventCount = allEvidence.length;

  const recent = allEvidence.slice(-maxEvents);
  const anchors = ["requirement", "acceptance", "planning"].flatMap((kind) => {
    const entry = allEvidence.findLast((candidate) => candidate.kinds.includes(kind));
    return entry ? [entry] : [];
  });
  const candidateByIndex = new Map<number, RoleContextEntry>();
  for (const entry of [...recent, ...anchors]) candidateByIndex.set(entry.index, entry);
  const candidates = [...candidateByIndex.values()].sort((left, right) => left.index - right.index);
  mutableDiagnostics.selectedEvidenceCount = candidates.length;
  mutableDiagnostics.omittedEvidenceCount = Math.max(0, allEvidence.length - candidates.length);

  const priorityKinds = ["requirement", "acceptance", "planning", "write", "diff", "test-failed", "check-failed", "test", "check"];
  const prioritized: RoleContextEntry[] = [];
  const prioritizedIndices = new Set<number>();
  for (const kind of priorityKinds) {
    const entry = candidates.findLast((candidate) => candidate.kinds.includes(kind));
    if (entry && !prioritizedIndices.has(entry.index)) {
      prioritized.push(entry);
      prioritizedIndices.add(entry.index);
    }
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = candidates[index];
    if (entry && !prioritizedIndices.has(entry.index)) {
      prioritized.push(entry);
      prioritizedIndices.add(entry.index);
    }
  }

  const rendered: RoleContextEntry[] = [];
  let evidenceChars = 0;
  let textTruncated = !requirementsFit || task.truncated || prioritized.some((entry) => preTruncatedIndices.has(entry.index));
  const availableChars = Math.max(0, maxChars - task.text.length - includedRequirementChars);
  const maxEntryChars = Math.max(96, Math.min(DEFAULT_MAX_ENTRY_CHARS, Math.floor(availableChars / 6)));
  for (const entry of prioritized) {
    const remaining = maxChars - task.text.length - includedRequirementChars - evidenceChars;
    if (remaining < 96) { textTruncated = true; break; }
    const bounded = truncateText(entry.text, Math.min(remaining, maxEntryChars));
    rendered.push(Object.freeze({ ...entry, text: bounded.text }));
    evidenceChars += bounded.text.length;
    textTruncated ||= bounded.truncated;
  }
  rendered.sort((left, right) => left.index - right.index);

  const entries = Object.freeze(rendered);
  const coverage = coverageFor(task.text, entries, requirements);
  const diagnostics: Readonly<RoleContextDiagnostics> = Object.freeze({
    ...mutableDiagnostics,
    hostEvidenceAvailable: mutableDiagnostics.linkedToolResultCount > 0,
  });
  const truncated = textTruncated || mutableDiagnostics.omittedEvidenceCount > 0 || rendered.length < candidates.length;
  const evidenceCoverage = coverageFor(task.text, candidates, requirements);
  const evidenceMarkers = priorityKinds.map((kind) => {
    const entry = candidates.findLast((candidate) => candidate.kinds.includes(kind));
    return entry ? { kind, index: entry.index, identity: entry.identity } : { kind, index: -1 };
  });
  const evidenceDigest = digestPacket({
    requirements,
    coverage: {
      requirements: evidenceCoverage.requirements,
      requirementDecisionCount: evidenceCoverage.requirementDecisionCount,
      activeRequirementCount: evidenceCoverage.activeRequirementCount,
      supersededRequirementCount: evidenceCoverage.supersededRequirementCount,
      requirementProvenance: evidenceCoverage.requirementProvenance,
      acceptanceCount: evidenceCoverage.acceptanceCount,
      diffCount: evidenceCoverage.diffCount,
      testCount: evidenceCoverage.testCount,
      failedTestCount: evidenceCoverage.failedTestCount,
      checkCount: evidenceCoverage.checkCount,
      failedCheckCount: evidenceCoverage.failedCheckCount,
      writeCount: evidenceCoverage.writeCount,
      latestWriteIndex: evidenceCoverage.latestWriteIndex,
      latestDiffIndex: evidenceCoverage.latestDiffIndex,
      latestTestIndex: evidenceCoverage.latestTestIndex,
      latestFailedTestIndex: evidenceCoverage.latestFailedTestIndex,
      latestCheckIndex: evidenceCoverage.latestCheckIndex,
      latestFailedCheckIndex: evidenceCoverage.latestFailedCheckIndex,
      currentEvidence: evidenceCoverage.currentEvidence,
    },
    markers: evidenceMarkers,
    diagnostics: {
      malformedToolResultCount: diagnostics.malformedToolResultCount,
      unlinkedToolResultCount: diagnostics.unlinkedToolResultCount,
      unparsedToolArgumentsCount: diagnostics.unparsedToolArgumentsCount,
      unclassifiedShellResultCount: diagnostics.unclassifiedShellResultCount,
      diffWithoutPatchCount: diagnostics.diffWithoutPatchCount,
      testWithoutVerdictCount: diagnostics.testWithoutVerdictCount,
      hostEvidenceAvailable: diagnostics.hostEvidenceAvailable,
    },
  });
  const packetBody = Object.freeze({
    schemaVersion: 2 as const, role, currentTask: task.text, requirements, entries, coverage, diagnostics, truncated, evidenceDigest,
  });
  const digest = digestPacket(packetBody);
  const reviewerSufficient = coverage.requirements && coverage.acceptanceCount > 0
    && coverage.diffCount > 0 && coverage.testCount + coverage.checkCount > 0
    && coverage.toolEvidenceCount > 0 && coverage.currentEvidence;
  return Object.freeze({
    ...packetBody, digest, evidenceCount: entries.length, toolEvidenceCount: coverage.toolEvidenceCount,
    sufficient: role === "reviewer" ? reviewerSufficient : Boolean(task.text),
  });
}

export function renderRoleContextPacket(packet: RoleContextPacket): string {
  const evidence = packet.entries.length
    ? packet.entries.map((entry, index) => [
        `### E${index + 1}: ${entry.label}`,
        `kinds: ${entry.kinds.join(", ")}`,
        entry.text,
      ].join("\n")).join("\n\n")
    : "(no prior evidence entries)";
  const requirements = packet.requirements.length > 0
    ? JSON.stringify(packet.requirements, undefined, 2)
    : "(no source-verified requirement ledger; do not make coverage findings)";
  return [
    "# Odai bounded role context packet",
    `role: ${packet.role}`,
    `digest: sha256:${packet.digest}`,
    `evidenceDigest: sha256:${packet.evidenceDigest}`,
    `truncated: ${packet.truncated}`,
    `coverage: ${JSON.stringify(packet.coverage)}`,
    `diagnostics: ${JSON.stringify(packet.diagnostics)}`,
    "", "## Frozen requirement decisions", requirements,
    "", "## Current task", packet.currentTask || "(empty)", "", "## Evidence", evidence, "",
    "Treat assistant text as claims. Only active source-verified requirement decisions may support coverage findings. Tool entries are evidence only for the exact command/result they contain.",
  ].join("\n");
}
