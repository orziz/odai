import { publicUsage } from "../../runtime/redaction.mjs";
import {
  defaultInteractiveWrite,
  finalProviderOutput,
  oneLine,
} from "./session-format-core.mjs";
import {
  estimateMeterTotalTokens,
  estimateThinkingTokensFromElapsedMs,
  estimateTokensFromTextByChars,
  firstNumber,
  formatUsageTokens,
} from "./session-tokens.mjs";

export function createStatusLineWriter({ write = () => {}, writeStatus } = {}) {
  if (writeStatus) {
    return {
      write(message, options = {}) {
        writeStatus(message, options);
      },
      clear() {
        writeStatus("", { clear: true });
      },
      finish() {
        writeStatus("", { done: true });
      },
    };
  }

  const inline = write === defaultInteractiveWrite && Boolean(process.stdout?.isTTY);
  if (!inline) {
    return {
      write(message) {
        write(message);
      },
      clear() {},
      finish() {},
    };
  }

  let active = false;
  let lastLength = 0;
  const clear = () => {
    if (!active) return;
    process.stdout.write(`\r${" ".repeat(lastLength)}\r`);
    active = false;
    lastLength = 0;
  };
  return {
    write(message, { done = false } = {}) {
      const line = fitStatusLine(message);
      const padding = Math.max(0, lastLength - line.length);
      process.stdout.write(`\r${line}${" ".repeat(padding)}`);
      active = true;
      lastLength = line.length;
      if (done) {
        process.stdout.write("\n");
        active = false;
        lastLength = 0;
      }
    },
    clear,
    finish() {
      if (!active) return;
      process.stdout.write("\n");
      active = false;
      lastLength = 0;
    },
  };
}



export function fitStatusLine(message = "") {
  const value = oneLine(String(message || ""));
  const columns = Number(process.stdout?.columns || 0);
  if (!Number.isFinite(columns) || columns <= 20 || value.length < columns) return value;
  return `${value.slice(0, Math.max(0, columns - 4))}...`;
}



export function createProgressMeter({ statusLine, onMeterEvent } = {}) {
  let state;
  let timer;
  const clear = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const emit = (done = false) => {
    if (!state) return;
    state.lastWriteMs = Date.now();
    state.lastOutputTokenEmit = estimateTokensFromTextByChars(state.outputChars || 0);
    statusLine?.write?.(formatMeterLine(state, { done }), { done });
    onMeterEvent?.(meterEvent(state, { done }));
  };
  const start = (event = {}) => {
    clear();
    state = {
      provider: event.provider || "provider",
      model: event.model,
      turn: event.turn,
      startedMs: Date.now(),
      lastWriteMs: 0,
      outputChars: 0,
      lastOutputTokenEmit: 0,
      estimatedInputTokens: firstNumber(event.estimatedInputTokens, event.inputTokens),
      usage: {},
    };
    emit(false);
    timer = setInterval(() => emit(false), 1000);
    timer.unref?.();
  };
  return {
    onEvent(event = {}) {
      if (event.type === "agent-turn-start") {
        start(event);
        return;
      }
      if (!state && (event.type === "provider-text" || event.type === "provider-usage")) {
        start(event);
      }
      if (!state) return;
      if (event.type === "provider-text") {
        state.outputChars += String(event.text || "").length;
        const now = Date.now();
        if (shouldEmitOutputProgress(state, now)) {
          emit(false);
        }
      }
      if (event.type === "provider-usage") {
        state.usage = publicUsage(event.usage || event.usageMetadata);
        emit(false);
      }
    },
    stop() {
      clear();
    },
    clearLine() {
      statusLine?.clear?.();
    },
    finish(result = {}) {
      if (!state) return;
      const output = finalProviderOutput(result);
      const usage = publicUsage(output?.usage || output?.usageMetadata) || {};
      if (Object.keys(usage).length > 0) {
        state.usage = usage;
      }
      if (state.outputChars === 0 && typeof output?.text === "string") {
        state.outputChars = output.text.length;
      }
      emit(true);
      state = undefined;
    },
  };
}



export function meterEvent(state = {}, { done = false } = {}) {
  const elapsedMs = Math.max(0, Date.now() - (state.startedMs || Date.now()));
  const outputChars = state.outputChars || 0;
  const estimatedOutputTokens = estimateTokensFromTextByChars(outputChars);
  const estimatedInputTokens = firstNumber(state.estimatedInputTokens);
  const estimatedThinkingTokens = estimateThinkingTokensFromElapsedMs(elapsedMs);
  return {
    type: "provider-meter",
    provider: state.provider,
    model: state.model,
    turn: state.turn,
    phase: done ? "done" : "running",
    elapsedMs,
    outputChars,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedActiveTokens: estimatedThinkingTokens,
    estimatedThinkingTokens,
    estimatedTotalTokens: estimateMeterTotalTokens({
      estimatedInputTokens,
      estimatedThinkingTokens,
      estimatedOutputTokens,
    }),
    usage: publicUsage(state.usage) || {},
  };
}



export function formatMeterLine(state = {}, { done = false } = {}) {
  const elapsed = ((Date.now() - (state.startedMs || Date.now())) / 1000).toFixed(1);
  const label = [
    "meter:",
    state.provider || "provider",
    state.turn ? `turn ${state.turn}` : "",
    done ? "done" : "running",
    `elapsed ${elapsed}s`,
  ].filter(Boolean);
  const usage = formatUsageTokens(state.usage);
  if (usage) {
    label.push(`tokens: ${usage}`);
  } else {
    const estimatedInput = firstNumber(state.estimatedInputTokens);
    const estimatedOutput = estimateTokensFromTextByChars(state.outputChars || 0);
    const estimatedThinking = estimateThinkingTokensFromElapsedMs(Date.now() - (state.startedMs || Date.now()));
    const estimatedTotal = estimateMeterTotalTokens({
      estimatedInputTokens: estimatedInput,
      estimatedThinkingTokens: estimatedThinking,
      estimatedOutputTokens: estimatedOutput,
    });
    const tokenParts = [];
    if (estimatedInput !== undefined) tokenParts.push(`input ~${estimatedInput} tok est`);
    tokenParts.push(`thinking/activity ~${estimatedThinking} tok est`);
    tokenParts.push(`output ~${estimatedOutput} tok est`);
    tokenParts.push(`total ~${estimatedTotal} tok est`);
    label.push(`tokens: ${tokenParts.join(" ")}`);
    label.push(`(${state.outputChars || 0} visible chars)`);
  }
  return label.join(" ");
}



export function shouldEmitOutputProgress(state = {}, now = Date.now()) {
  if (now - (state.lastWriteMs || 0) >= 1000) return true;
  const estimatedOutputTokens = estimateTokensFromTextByChars(state.outputChars || 0);
  const lastOutputTokenEmit = state.lastOutputTokenEmit || 0;
  if (estimatedOutputTokens <= 0) return false;
  if (lastOutputTokenEmit === 0 || estimatedOutputTokens - lastOutputTokenEmit >= 8) {
    state.lastOutputTokenEmit = estimatedOutputTokens;
    return true;
  }
  return false;
}


