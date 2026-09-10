import { classifySessionOutputCeilingDirective } from "./output-config.mjs";
import type { OutputPolicy } from "./output-config.mjs";
import { classifyResponsibilityInterruptionText } from "./router.mjs";
import type { DshEvent, RuntimeEventData } from "./runtime-types.mjs";

const SESSION_CEILING_EVENT = "odai/output-session-ceiling-configured";
const CONTROLLER_INTERRUPTED_EVENT = "odai/controller-output-interrupted";
const CONTROLLER_RECOVERY_EVENT = "odai/controller-output-recovery";

export interface SessionOutputSelection {
  readonly policy: OutputPolicy;
  readonly source: string;
  readonly status?: string;
  readonly reasonCode?: string;
  readonly sessionCeiling?: "uncapped" | "recovery";
}

interface PrepareSessionOutputOptions {
  readonly events: readonly DshEvent[];
  readonly text: string;
  readonly turn: number | undefined;
  readonly step: number | undefined;
  readonly userMessageId: string | undefined;
  append(type: string, data: object): void;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidSessionDirective(data: RuntimeEventData | undefined): data is RuntimeEventData {
  return data?.scope === "session"
    && data.authorizationSource === "authenticated-direct-user-message"
    && ["uncap", "inherit"].includes(String(data.action))
    && isNonNegativeSafeInteger(data.turn)
    && isPositiveSafeInteger(data.step)
    && typeof data.userMessageId === "string"
    && data.userMessageId.length > 0
    && data.userMessageId.length <= 200;
}

function isValidControllerInterruption(data: RuntimeEventData | undefined, turn: number): data is RuntimeEventData {
  return data?.scope === "turn"
    && data.turn === turn
    && isPositiveSafeInteger(data.step)
    && data.reason === "max-tokens"
    && data.budgetSource === "controller-policy"
    && isPositiveSafeInteger(data.configuredMaxTokens)
    && isPositiveSafeInteger(data.effectiveMaxTokens)
    && typeof data.outputTokens === "number"
    && Number.isSafeInteger(data.outputTokens)
    && data.outputTokens >= 0;
}

function isValidRecovery(data: RuntimeEventData | undefined, turn: number): data is RuntimeEventData {
  return data?.scope === "turn"
    && data.turn === turn
    && data.interruptedTurn === turn - 1
    && isPositiveSafeInteger(data.step)
    && isPositiveSafeInteger(data.interruptedStep)
    && data.reason === "pure-continuation-after-max-tokens"
    && data.authorizationSource === "authenticated-direct-user-message"
    && typeof data.userMessageId === "string"
    && data.userMessageId.length > 0
    && data.userMessageId.length <= 200;
}

function latestSessionDirective(events: readonly DshEvent[]): RuntimeEventData | undefined {
  return events.findLast((event) => (
    event.type === SESSION_CEILING_EVENT
    && isValidSessionDirective(event.data)
  ))?.data;
}

function recoveryForTurn(events: readonly DshEvent[], turn: number | undefined): RuntimeEventData | undefined {
  if (!Number.isSafeInteger(turn)) return undefined;
  return events.findLast((event) => (
    event.type === CONTROLLER_RECOVERY_EVENT
    && isValidRecovery(event.data, turn as number)
  ))?.data;
}

function interruptionForPreviousTurn(events: readonly DshEvent[], turn: number | undefined): RuntimeEventData | undefined {
  if (!Number.isSafeInteger(turn)) return undefined;
  const interruptedTurn = (turn as number) - 1;
  return events.findLast((event) => (
    event.type === CONTROLLER_INTERRUPTED_EVENT
    && isValidControllerInterruption(event.data, interruptedTurn)
  ))?.data;
}

export function prepareSessionOutputControl(options: PrepareSessionOutputOptions): void {
  const { events, text, turn, step, userMessageId, append } = options;
  if (typeof userMessageId !== "string"
    || userMessageId.length === 0
    || userMessageId.length > 200
    || !isNonNegativeSafeInteger(turn)
    || !isPositiveSafeInteger(step)) return;

  const directive = classifySessionOutputCeilingDirective(text);
  if (directive) {
    const duplicate = events.some((event) => (
      event.type === SESSION_CEILING_EVENT
      && isValidSessionDirective(event.data)
      && event.data.userMessageId === userMessageId
    ));
    if (!duplicate) {
      append(SESSION_CEILING_EVENT, {
        turn,
        step,
        action: directive,
        userMessageId,
        authorizationSource: "authenticated-direct-user-message",
        scope: "session",
      });
    }
    return;
  }

  if (latestSessionDirective(events)?.action === "uncap"
    || classifyResponsibilityInterruptionText(text) !== "continue"
    || recoveryForTurn(events, turn)) return;
  const interruption = interruptionForPreviousTurn(events, turn);
  if (!interruption) return;
  append(CONTROLLER_RECOVERY_EVENT, {
    turn,
    step,
    interruptedTurn: interruption.turn,
    interruptedStep: interruption.step,
    userMessageId,
    authorizationSource: "authenticated-direct-user-message",
    reason: "pure-continuation-after-max-tokens",
    scope: "turn",
  });
}

/** Calculate this request's override without creating durable authorization. */
export function previewSessionOutputControl(
  selection: SessionOutputSelection,
  options: Omit<PrepareSessionOutputOptions, "append">,
): Readonly<SessionOutputSelection> {
  const events = [...options.events];
  prepareSessionOutputControl({ ...options, events, append(type, data) {
    events.push({ type, data: data as RuntimeEventData });
  } });
  return applySessionOutputControl(selection, events, options.turn);
}

export function applySessionOutputControl(
  selection: SessionOutputSelection,
  events: readonly DshEvent[],
  turn: number | undefined,
): Readonly<SessionOutputSelection> {
  const directive = latestSessionDirective(events);
  const sessionCeiling = directive?.action === "uncap"
    ? "uncapped"
    : recoveryForTurn(events, turn)
      ? "recovery"
      : undefined;
  if (!sessionCeiling) return selection;
  const { maxTokens: _configuredCeiling, ...withoutCeiling } = selection.policy;
  return Object.freeze({
    ...selection,
    policy: Object.freeze(withoutCeiling),
    source: sessionCeiling === "uncapped" ? "session-override" : "interruption-recovery",
    sessionCeiling,
  });
}

export function renderSessionOutputControlPrompt(selection: SessionOutputSelection): string {
  if (selection.sessionCeiling === "uncapped") {
    return [
      "Session-scoped controller output ceiling is disabled by the authenticated user request.",
      "Keep the shared output configuration unchanged. Do not call odai_output_config unless the user separately requests a persistent change.",
    ].join("\n");
  }
  if (selection.sessionCeiling === "recovery") {
    return [
      "One-turn output recovery is active after a verified max-token interruption.",
      "Continue the interrupted answer directly and finish it in this turn. The shared output configuration remains unchanged.",
    ].join("\n");
  }
  return "";
}
