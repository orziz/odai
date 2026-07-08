import path from "node:path";
import {
  publicInputLine,
  publicTaskArgv,
  publicUsage,
  redactCommand,
  redactString,
  redactUrl,
} from "../runtime/redaction.mjs";
import {
  formatContextWindowTokens,
  normalizeReasoningDepth,
  parseContextWindowTokens,
} from "../runtime/model-options.mjs";
import { detectLanguage, languageName, normalizeLanguage, t } from "../runtime/i18n.mjs";
import { publicTranscriptEntry } from "./transcript-store.mjs";

function defaultInteractiveWrite(message) {
  process.stdout.write(`${message}\n`);
}

export async function runInteractiveSession({
  ask,
  write = defaultInteractiveWrite,
  writeStatus,
  initialTaskArgv,
  handleTask,
  handleProviders,
  handleModels,
  selectModel,
  handleAgents,
  handleInit,
  handleDoctor,
  handleStatus,
  handleSetup,
  handleAudit,
  handleEvidence,
  handlePolicy,
  handleSessions,
  handleContinue,
  handleRollback,
  handleAuthorize,
  recordTranscript,
  transcriptPath,
  workspaceRoot = process.cwd(),
  resumeContext,
  readInputLoop = true,
  language = detectLanguage(),
  languageState,
  initialPreferences = {},
  savePreferences,
} = {}) {
  if (!ask) {
    throw new Error("Interactive session requires an ask function.");
  }
  if (!handleTask || !handleProviders || !handleContinue) {
    throw new Error("Interactive session requires task, provider, and continue handlers.");
  }
  const statusLine = createStatusLineWriter({ write, writeStatus });
  const record = (event) => recordTranscript?.(publicTranscriptEntry(event, { workspaceRoot }));
  let sessionLanguage = normalizeLanguage(language);
  const activeLanguage = () => languageState?.value || sessionLanguage;
  const setActiveLanguage = (nextLanguage) => {
    sessionLanguage = normalizeLanguage(nextLanguage, sessionLanguage);
    if (languageState) {
      languageState.value = sessionLanguage;
    }
  };

  write(t(activeLanguage(), "interactive.sessionTitle"));
  if (transcriptPath) {
    write(`transcript: ${formatDisplayPath(transcriptPath, workspaceRoot)}`);
  }
  if (resumeContext?.status === "ready") {
    write(`resumed: ${resumeContext.sourceSessionId || "unknown"} (${resumeContext.eventCount || 0} events)`);
    if (Array.isArray(resumeContext.lastTaskArgv) && resumeContext.lastTaskArgv.length > 0) {
      write(`last task: ${resumeContext.lastTaskArgv.join(" ")}`);
    }
  } else if (resumeContext?.status === "blocked") {
    write(`resume: ${resumeContext.note || "No previous session transcript is available."}`);
  }
  write(t(activeLanguage(), "interactive.typeTask"));
  await record({
    type: "session-start",
    initialTaskArgv: publicTaskArgv(initialTaskArgv),
    transcriptPath,
  });
  if (resumeContext) {
    await record({
      type: "session-resume",
      context: resumeContext,
    });
  }

  let defaultProvider = initialPreferences.provider || "auto";
  let defaultModel = initialPreferences.model;
  let defaultReasoning = initialPreferences.reasoning;
  let defaultContextWindowTokens = initialPreferences.contextWindowTokens;
  let sessionAuth = {
    useApiKey: Boolean(initialPreferences.auth?.useApiKey),
    useProviderCommand: Boolean(initialPreferences.auth?.useProviderCommand),
    providerCommands: normalizeProviderCommandList(initialPreferences.auth?.providerCommands),
  };
  let lastTaskArgv = Array.isArray(resumeContext?.lastTaskArgv) && resumeContext.lastTaskArgv.length > 0
    ? normalizeTaskArgv(resumeContext.lastTaskArgv, {
        defaultProvider,
        defaultModel,
        defaultReasoning,
        defaultContextWindowTokens,
        sessionAuth,
      })
    : undefined;
  let taskContext = resumeContext?.status === "ready" ? resumeContext : undefined;
  let sessionEnded = false;
  if (Array.isArray(initialTaskArgv) && initialTaskArgv.length > 0) {
    lastTaskArgv = normalizeTaskArgv(initialTaskArgv, {
      defaultProvider,
      defaultModel,
      defaultReasoning,
      defaultContextWindowTokens,
      sessionAuth,
    });
    const result = await runTaskWithInteractiveAuthorization({
      ask,
      write,
      statusLine,
      handleTask,
      handleAuthorize,
      recordTranscript: record,
      argv: lastTaskArgv,
      taskContext,
      workspaceRoot,
    });
    taskContext = buildNextTaskContext({ previousContext: taskContext, argv: lastTaskArgv, result, workspaceRoot });
  }

  if (readInputLoop === false) {
    await record({ type: "session-end", reason: "non-interactive-eof" });
    return;
  }

  for (;;) {
    const line = (await askNext(ask, "odai> "))?.trim();
    if (line === undefined) break;
    if (!line) continue;
    await record({ type: "input", line: publicInputLine(line) });

    if (line === "/exit" || line === "exit" || line === "quit") {
      write(t(activeLanguage(), "interactive.bye"));
      await record({ type: "session-end", reason: "user-exit" });
      sessionEnded = true;
      break;
    }

    if (line === "/help") {
      write(t(activeLanguage(), "interactive.help"));
      await record({ type: "command", command: "help" });
      continue;
    }

    if (line === "/language" || line.startsWith("/language ") || line === "/lang" || line.startsWith("/lang ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/(?:language|lang)\s*/, ""));
      const result = updateSessionLanguage({
        argv,
        current: activeLanguage(),
        setLanguage: setActiveLanguage,
      });
      if (result.status === "ready") {
        await savePreferences?.({ language: result.language });
      }
      write(formatInteractiveStatus(result));
      await record({ type: "command-result", command: "language", argv, result });
      continue;
    }

    if (line === "/policy") {
      if (!handlePolicy) {
        write("policy handler is not available");
        continue;
      }
      const result = await handlePolicy();
      write(formatJson(result));
      await record({ type: "command-result", command: "policy", result });
      continue;
    }

    if (line === "/authorize" || line.startsWith("/authorize ")) {
      if (!handleAuthorize) {
        write("authorization handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/authorize\s*/, ""));
      const result = await handleAuthorize(argv);
      write(formatAuthorizationResult(result));
      await record({ type: "command-result", command: "authorize", argv, result });
      continue;
    }

    if (line === "/auth" || line.startsWith("/auth ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/auth\s*/, ""));
      const result = updateSessionAuth({ argv, current: sessionAuth });
      if (result.status === "ready") {
        sessionAuth = {
          useApiKey: Boolean(result.session?.useApiKey),
          useProviderCommand: Boolean(result.session?.useProviderCommand),
          providerCommands: normalizeProviderCommandList(result.session?.providerCommands),
        };
        await savePreferences?.({ auth: sessionAuth });
      }
      write(formatSessionCommandResult(result, { command: "auth", argv }));
      await record({ type: "command-result", command: "auth", argv, result });
      continue;
    }

    if (line === "/providers" || line.startsWith("/providers ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/providers\s*/, ""));
      const result = await handleProviders(appendSessionAuthArgv(argv, sessionAuth));
      write(formatJson(result));
      await record({ type: "command-result", command: "providers", argv, result });
      continue;
    }

    if (line === "/models" || line.startsWith("/models ")) {
      if (!handleModels) {
        write("models handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/models\s*/, ""));
      const result = await handleModels(appendSessionAuthArgv(argv, sessionAuth));
      if (isModelSelectArgv(argv)) {
        const selection = await selectSessionModel({
          result,
          selectModel,
          write,
        });
        if (selection.status === "ready") {
          defaultProvider = selection.provider;
          defaultModel = selection.model;
        }
        write(formatSessionCommandResult(selection, { command: "model", argv }));
        await record({ type: "command-result", command: "model", argv, result: selection });
      } else {
        write(formatModelsResult(result, { json: argv.includes("--json") }));
      }
      await record({ type: "command-result", command: "models", argv, result });
      continue;
    }

    if (line === "/provider" || line.startsWith("/provider ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/provider\s*/, ""));
      const result = await updateDefaultProvider({
        argv,
        current: defaultProvider,
        handleProviders,
        commandName: "provider",
      });
      if (result.status === "ready" && result.provider) {
        defaultProvider = result.provider;
        await savePreferences?.({ provider: defaultProvider });
      }
      write(formatSessionCommandResult(result, { command: "provider", argv }));
      await record({ type: "command-result", command: "provider", argv, result });
      continue;
    }

    if (line === "/model" || line.startsWith("/model ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/model\s*/, ""));
      let result;
      if (argv[0] === "select") {
        const modelReport = handleModels
          ? await handleModels(appendSessionAuthArgv(["select", ...argv.slice(1)], sessionAuth))
          : undefined;
        result = await selectSessionModel({
          result: modelReport,
          selectModel,
          write,
        });
      } else {
        result = await updateDefaultModel({
          argv,
          currentProvider: defaultProvider,
          currentModel: defaultModel,
          handleProviders,
        });
      }
      if (result.status === "ready" && result.provider !== undefined) {
        defaultProvider = result.provider;
      }
      if (result.status === "ready") {
        defaultModel = result.model || undefined;
        await savePreferences?.({
          provider: defaultProvider,
          model: defaultModel,
        });
      }
      write(formatSessionCommandResult(result, { command: "model", argv }));
      await record({ type: "command-result", command: "model", argv, result });
      continue;
    }

    if (line === "/reasoning" || line.startsWith("/reasoning ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/reasoning\s*/, ""));
      const result = updateDefaultReasoning({ argv, current: defaultReasoning });
      if (result.status === "ready") {
        defaultReasoning = result.reasoning || undefined;
        await savePreferences?.({ reasoning: defaultReasoning });
      }
      write(formatSessionCommandResult(result, { command: "reasoning", argv }));
      await record({ type: "command-result", command: "reasoning", argv, result });
      continue;
    }

    if (line === "/context") {
      const result = handleSessions
        ? await handleSessions(["--compact"])
        : resumeContext || {
            status: "blocked",
            note: "This session was not started from a previous transcript.",
          };
      write(formatJson(result));
      await record({
        type: "command-result",
        command: "context",
        result,
      });
      continue;
    }

    if (line.startsWith("/context ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/context\s*/, ""));
      const result = updateDefaultContextWindow({ argv, current: defaultContextWindowTokens });
      if (result.status === "ready") {
        defaultContextWindowTokens = result.contextWindowTokens;
        await savePreferences?.({ contextWindowTokens: defaultContextWindowTokens });
      }
      write(formatSessionCommandResult(result, { command: "context", argv }));
      await record({ type: "command-result", command: "context", argv, result });
      continue;
    }

    if (line === "/settings") {
      const result = sessionSettings({
        defaultProvider,
        defaultModel,
        defaultReasoning,
        defaultContextWindowTokens,
        sessionAuth,
      });
      write(formatSessionCommandResult(result, { command: "settings" }));
      await record({ type: "command-result", command: "settings", result });
      continue;
    }

    if (line === "/agents" || line.startsWith("/agents ")) {
      if (!handleAgents) {
        write("agents handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/agents\s*/, ""));
      const result = await handleAgents(appendSessionAuthArgv(argv, sessionAuth));
      write(formatJson(result));
      await record({ type: "command-result", command: "agents", argv, result });
      continue;
    }

    if (line === "/init" || line.startsWith("/init ")) {
      if (!handleInit) {
        write("init handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/init\s*/, ""));
      const result = await handleInit(argv);
      write(formatJson(result));
      await record({ type: "command-result", command: "init", argv, result });
      continue;
    }

    if (line === "/doctor" || line.startsWith("/doctor ")) {
      if (!handleDoctor) {
        write("doctor handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/doctor\s*/, ""));
      const result = await handleDoctor(appendSessionAuthArgv(argv, sessionAuth));
      write(formatDoctorSummary(result, { workspaceRoot }));
      await record({ type: "command-result", command: "doctor", argv, result: summarizeTranscriptResult(result) });
      continue;
    }

    if (line === "/status" || line.startsWith("/status ")) {
      if (!handleStatus) {
        write("status handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/status\s*/, ""));
      const result = await handleStatus(appendSessionAuthArgv(argv, sessionAuth));
      write(formatDoctorSummary(result, { workspaceRoot }));
      await record({ type: "command-result", command: "status", argv, result: summarizeTranscriptResult(result) });
      continue;
    }

    if (line === "/setup" || line.startsWith("/setup ")) {
      if (!handleSetup) {
        write("setup handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/setup\s*/, ""));
      const result = await handleSetup(appendSessionAuthArgv(argv, sessionAuth));
      write(formatDoctorSummary(result, { workspaceRoot }));
      await record({ type: "command-result", command: "setup", argv, result: summarizeTranscriptResult(result) });
      continue;
    }

    if (line === "/audit" || line.startsWith("/audit ")) {
      if (!handleAudit) {
        write("audit handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/audit\s*/, ""));
      const result = await handleAudit(appendSessionAuthArgv(argv, sessionAuth));
      write(formatDoctorSummary(result, { workspaceRoot }));
      await record({ type: "command-result", command: "audit", argv, result: summarizeTranscriptResult(result) });
      continue;
    }

    if (line === "/evidence") {
      if (!handleEvidence) {
        write("evidence handler is not available");
        continue;
      }
      const result = await handleEvidence();
      write(formatDoctorSummary(result, { workspaceRoot }));
      await record({ type: "command-result", command: "evidence", result: summarizeTranscriptResult(result) });
      continue;
    }

    if (line === "/sessions" || line.startsWith("/sessions ")) {
      if (!handleSessions) {
        write("sessions handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/sessions\s*/, ""));
      const result = await handleSessions(argv);
      write(formatJson(result));
      await record({
        type: "command-result",
        command: "sessions",
        argv,
        result: summarizeTranscriptResult(result),
      });
      continue;
    }

    if (line === "/continue" || line.startsWith("/continue ")) {
      const argv = parseInteractiveArgs(line.replace(/^\/continue\s*/, ""));
      const result = await handleContinue(appendSessionAuthArgv(argv, sessionAuth));
      write(formatRunSummary(result, { workspaceRoot }));
      await record({
        type: "command-result",
        command: "continue",
        argv,
        result: summarizeTranscriptResult(result),
      });
      continue;
    }

    if (line === "/rollback" || line.startsWith("/rollback ")) {
      if (!handleRollback) {
        write("rollback handler is not available");
        continue;
      }
      const argv = parseInteractiveArgs(line.replace(/^\/rollback\s*/, ""));
      const result = await handleRollback(argv);
      write(formatRollbackSummary(result));
      await record({
        type: "command-result",
        command: "rollback",
        argv,
        result: summarizeTranscriptResult(result),
      });
      continue;
    }

    if (line === "/retry") {
      if (!lastTaskArgv) {
        write("No task to retry.");
        await record({
          type: "command-result",
          command: "retry",
          result: { status: "blocked", reason: "no-task" },
        });
        continue;
      }
      const retryArgv = appendSessionAuthArgv(lastTaskArgv, sessionAuth);
      lastTaskArgv = [...retryArgv];
      const result = await runTaskWithInteractiveAuthorization({
        ask,
        write,
        statusLine,
        handleTask,
        handleAuthorize,
        recordTranscript: record,
        argv: retryArgv,
        taskContext,
        workspaceRoot,
      });
      taskContext = buildNextTaskContext({ previousContext: taskContext, argv: lastTaskArgv, result, workspaceRoot });
      continue;
    }

    if (line.startsWith("/") && !line.startsWith("/run ")) {
      write(t(activeLanguage(), "interactive.unknownCommand"));
      await record({
        type: "command-result",
        command: "unknown",
        result: { status: "blocked", reason: "unknown-command" },
      });
      continue;
    }

    const taskLine = line.startsWith("/run ") ? line.slice(5) : line;
    const argv = normalizeTaskArgv(parseInteractiveArgs(taskLine), {
      defaultProvider,
      defaultModel,
      defaultReasoning,
      defaultContextWindowTokens,
      sessionAuth,
    });
    lastTaskArgv = [...argv];
    const result = await runTaskWithInteractiveAuthorization({
      ask,
      write,
      statusLine,
      handleTask,
      handleAuthorize,
      recordTranscript: record,
      argv,
      taskContext,
      workspaceRoot,
    });
    taskContext = buildNextTaskContext({ previousContext: taskContext, argv, result, workspaceRoot });
  }
  if (!sessionEnded) {
    await record({ type: "session-end", reason: "eof" });
  }
}

async function runTaskWithInteractiveAuthorization({
  ask,
  write,
  statusLine,
  handleTask,
  handleAuthorize,
  recordTranscript,
  argv,
  taskContext,
  workspaceRoot,
}) {
  await recordTranscript?.({ type: "task-submit", argv: publicTaskArgv(argv) });
  const meter = createProgressMeter({
    statusLine,
    onMeterEvent: (event) =>
      recordTranscript?.({ type: "progress", event: summarizeTranscriptEvent(event, { workspaceRoot }) }),
  });
  const runOptions = {
    context: taskContext,
    onEvent: (event) => {
      meter.onEvent(event);
      const formatted = formatProgressEvent(event, { workspaceRoot });
      if (formatted) {
        meter.clearLine();
        write(formatted);
      }
      recordTranscript?.({ type: "progress", event: summarizeTranscriptEvent(event, { workspaceRoot }) });
    },
  };
  let result;
  try {
    result = await handleTask([...argv], runOptions);
  } finally {
    meter.stop();
  }
  meter.finish(result);
  write(formatRunSummary(result, { workspaceRoot }));
  await recordTranscript?.({ type: "task-result", result: summarizeTranscriptResult(result, { workspaceRoot }) });

  const scopes = Array.isArray(result?.requiredAuthorizations) ? result.requiredAuthorizations : [];
  if (scopes.length === 0 || !handleAuthorize) {
    return result;
  }

  const approved = [];
  for (const scope of scopes) {
    const answer = await askNext(ask, `authorize ${scope}? [y/N] `);
    await recordTranscript?.({ type: "authorization-prompt", scope, answered: answer !== undefined });
    if (answer === undefined) {
      return result;
    }
    if (isApprovalAnswer(answer)) {
      const authorization = await handleAuthorize([scope]);
      write(formatAuthorizationResult(authorization));
      await recordTranscript?.({ type: "authorization-result", scope, approved: Boolean(authorization?.ok) });
      if (authorization?.ok) {
        approved.push(scope);
      }
    } else {
      write(`authorization denied: ${scope}`);
      await recordTranscript?.({ type: "authorization-result", scope, approved: false });
      return result;
    }
  }

  if (approved.length !== scopes.length) {
    return result;
  }

  let retry;
  try {
    retry = await handleTask([...argv], runOptions);
  } finally {
    meter.stop();
  }
  meter.finish(retry);
  write(formatRunSummary(retry, { workspaceRoot }));
  await recordTranscript?.({ type: "task-result", retry: true, result: summarizeTranscriptResult(retry, { workspaceRoot }) });
  return retry;
}

function buildNextTaskContext({ previousContext, argv = [], result, workspaceRoot = process.cwd() } = {}) {
  if (!result) return previousContext;
  return {
    status: "ready",
    kind: "interactive-task-context",
    sourceSessionId: previousContext?.sourceSessionId,
    sourceTranscriptPath: previousContext?.sourceTranscriptPath,
    eventCount: previousContext?.eventCount,
    providerSessions: Array.isArray(result.providerSessions) ? result.providerSessions : previousContext?.providerSessions,
    lastTaskArgv: publicTaskArgv(argv),
    lastResult: summarizeTranscriptResult(result, { workspaceRoot }),
    previous: previousContext
      ? {
          lastTaskArgv: previousContext.lastTaskArgv || [],
          lastResult: previousContext.lastResult,
        }
      : undefined,
    notRestored: previousContext?.notRestored || [
      "authorizations",
      "api-key-confirmation",
      "provider-command-confirmation",
      "shell-execution-confirmation",
      "network-execution-confirmation",
    ],
  };
}

function isApprovalAnswer(answer = "") {
  return ["y", "yes", "allow", "authorize", "approved"].includes(answer.trim().toLowerCase());
}

async function askNext(ask, prompt) {
  try {
    return await ask(prompt);
  } catch (error) {
    if (error?.code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(error?.message || "")) {
      return undefined;
    }
    throw error;
  }
}

export function normalizeTaskArgv(
  argv = [],
  { defaultProvider = "auto", defaultModel, defaultReasoning, defaultContextWindowTokens, sessionAuth } = {},
) {
  const normalized = [...argv];
  if (!normalized.includes("--save")) {
    normalized.push("--save");
  }
  if (!normalized.includes("--agent-loop")) {
    normalized.push("--agent-loop");
  }
  if (!hasOption(normalized, "--provider")) {
    normalized.push("--provider", defaultProvider || "auto");
  }
  if (defaultModel && !hasOption(normalized, "--model")) {
    normalized.push("--model", defaultModel);
  }
  if (defaultReasoning && !hasAnyOption(normalized, ["--reasoning", "--reasoning-depth", "--reasoning-effort"])) {
    normalized.push("--reasoning", defaultReasoning);
  }
  if (
    Number.isFinite(defaultContextWindowTokens)
    && !hasAnyOption(normalized, ["--context", "--context-size", "--context-window"])
  ) {
    normalized.push("--context", String(defaultContextWindowTokens));
  }
  return appendSessionAuthArgv(normalized, sessionAuth);
}

function hasOption(argv = [], name) {
  return argv.some((item) => item === name || String(item).startsWith(`${name}=`));
}

function hasAnyOption(argv = [], names = []) {
  return names.some((name) => hasOption(argv, name));
}

function appendSessionAuthArgv(argv = [], sessionAuth = {}) {
  const result = [...argv];
  if (sessionAuth?.useApiKey && !hasOption(result, "--use-api-key")) {
    result.push("--use-api-key");
  }
  if (sessionAuth?.useProviderCommand && !hasOption(result, "--use-provider-command")) {
    result.push("--use-provider-command");
  } else if (!sessionAuth?.useProviderCommand) {
    for (const providerName of normalizeProviderCommandList(sessionAuth?.providerCommands)) {
      const value = `--use-provider-command=${providerName}`;
      if (!result.includes(value)) {
        result.push(value);
      }
    }
  }
  return result;
}

function updateSessionLanguage({ argv = [], current = "en", setLanguage } = {}) {
  if (argv.length === 0) {
    const language = normalizeLanguage(current);
    return {
      status: "ready",
      language,
      note: t(language, "language.current", { language: languageName(language) }),
    };
  }
  if (argv.length !== 1) {
    return {
      status: "blocked",
      language: normalizeLanguage(current),
      reason: t(current, "language.blocked"),
    };
  }
  const raw = String(argv[0] || "").trim();
  const next = normalizeLanguage(raw, "");
  if (!next) {
    return {
      status: "blocked",
      language: normalizeLanguage(current),
      reason: t(current, "language.blocked"),
    };
  }
  setLanguage?.(next);
  return {
    status: "ready",
    language: next,
    note: t(next, "language.updated"),
  };
}

function formatInteractiveStatus(result = {}) {
  if (typeof result?.note === "string" && result.note) return result.note;
  if (typeof result?.reason === "string" && result.reason) return result.reason;
  if (typeof result?.error === "string" && result.error) return result.error;
  return formatJson(result);
}

function formatSessionCommandResult(result = {}, { command, argv = [] } = {}) {
  if (result?.status === "blocked" || result?.ok === false) {
    return formatInteractiveStatus(result);
  }
  if (argv.length === 0 && typeof result?.note === "string" && result.note.startsWith("Use /")) {
    return result.note;
  }
  if (command === "provider") {
    return `provider: ${result.provider || "auto"}`;
  }
  if (command === "model") {
    return `model: ${formatModelSelectionLabel(result)}`;
  }
  if (command === "reasoning") {
    return `reasoning: ${result.display || result.reasoning || "auto"}`;
  }
  if (command === "context") {
    return `context: ${result.display || formatContextWindowTokens(result.contextWindowTokens)}`;
  }
  if (command === "auth") {
    return `auth: ${formatSessionAuth(result.session)}`;
  }
  if (command === "settings") {
    return formatSessionSettings(result);
  }
  return formatInteractiveStatus(result);
}

function formatAuthorizationResult(result = {}) {
  if (result?.ok === true) {
    return `authorized: ${redactString(result.scope || "ok")}`;
  }
  return formatInteractiveStatus(result);
}

function formatModelSelectionLabel(result = {}) {
  if (result.selected) return result.selected;
  if (!result.model) return "auto";
  return result.model;
}

function formatSessionAuth(session = {}) {
  const enabled = [];
  if (session?.useApiKey) enabled.push("api-key");
  if (session?.useProviderCommand) enabled.push("provider-command");
  for (const providerName of normalizeProviderCommandList(session?.providerCommands)) {
    enabled.push(providerName);
  }
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

function formatSessionSettings(result = {}) {
  return [
    `provider: ${result.provider || "auto"}`,
    `model: ${result.model || "auto"}`,
    `reasoning: ${result.reasoning || "auto"}`,
    `context: ${result.context || "auto"}`,
    `auth: ${formatSessionAuth(result.auth)}`,
  ].join("\n");
}

function updateSessionAuth({ argv = [], current = {} } = {}) {
  if (argv.length === 0) {
    return {
      status: "ready",
      session: {
        useApiKey: Boolean(current.useApiKey),
        useProviderCommand: Boolean(current.useProviderCommand),
        providerCommands: normalizeProviderCommandList(current.providerCommands),
      },
      note:
        "Use /auth api-key, /auth claude-cli, /auth provider-command, /auth all, or /auth clear. Confirmations are saved in .odai/preferences.json.",
    };
  }

  const next = {
    useApiKey: Boolean(current.useApiKey),
    useProviderCommand: Boolean(current.useProviderCommand),
    providerCommands: normalizeProviderCommandList(current.providerCommands),
  };
  for (const raw of argv) {
    const value = String(raw).trim().toLowerCase();
    if (["api-key", "api", "--use-api-key"].includes(value)) {
      next.useApiKey = true;
    } else if (["provider-command", "command", "cli", "--use-provider-command"].includes(value)) {
      next.useProviderCommand = true;
      next.providerCommands = [];
    } else if (["claude-cli", "claude"].includes(value)) {
      next.providerCommands = addUniqueProviderCommand(next.providerCommands, "claude-cli");
    } else if (["claude-agent-sdk", "claude-sdk"].includes(value)) {
      next.providerCommands = addUniqueProviderCommand(next.providerCommands, "claude-agent-sdk");
    } else if (value === "all") {
      next.useApiKey = true;
      next.useProviderCommand = true;
      next.providerCommands = [];
    } else if (["clear", "none", "off", "reset"].includes(value)) {
      next.useApiKey = false;
      next.useProviderCommand = false;
      next.providerCommands = [];
    } else {
      return {
        status: "blocked",
        session: next,
        reason: "Usage: /auth [api-key|claude-cli|claude-agent-sdk|provider-command|all|clear]",
      };
    }
  }
  return {
    status: "ready",
    session: next,
    note: "Auth updated. It affects later tasks and provider diagnostics and is saved in .odai/preferences.json.",
  };
}

function normalizeProviderCommandList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(
    items
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )].sort();
}

function addUniqueProviderCommand(list = [], providerName) {
  return normalizeProviderCommandList([...normalizeProviderCommandList(list), providerName]);
}

async function updateDefaultProvider({ argv = [], current = "auto", handleProviders, commandName = "provider" } = {}) {
  const provider = argv[0];
  const targetLabel = commandName === "model" ? "model/provider" : "provider";
  const resultTarget = (value) => ({
    provider: value,
    ...(commandName === "model" ? { model: value } : {}),
  });
  if (!provider) {
    return {
      status: "ready",
      ...resultTarget(current),
      note: `Use /${commandName} <name|auto> to set the session default ${targetLabel}. High-risk confirmations are not made persistent.`,
    };
  }
  if (provider.startsWith("-")) {
    return {
      status: "blocked",
      ...resultTarget(current),
      reason: `Usage: /${commandName} <name|auto>`,
    };
  }
  if (provider === "auto") {
    return {
      status: "ready",
      ...resultTarget("auto"),
      note: `Session default ${targetLabel} set to auto.`,
    };
  }

  const availableProviders = await handleProviders?.([]);
  const names = Array.isArray(availableProviders?.providers)
    ? availableProviders.providers.map((entry) => entry.name).filter(Boolean)
    : [];
  if (names.length > 0 && !names.includes(provider)) {
    return {
      status: "blocked",
      ...resultTarget(current),
      requested: provider,
      reason: `${capitalize(targetLabel)} is not registered: ${provider}`,
      providers: names,
    };
  }

  return {
    status: "ready",
    ...resultTarget(provider),
    note: `Session default ${targetLabel} updated. API key, external command, shell, and network confirmations still must be passed per task.`,
  };
}

function capitalize(value = "") {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

async function updateDefaultModel({ argv = [], currentProvider = "auto", currentModel, handleProviders } = {}) {
  const requested = argv[0];
  if (!requested) {
    return {
      status: "ready",
      provider: currentProvider,
      model: currentModel,
      note:
        "Use /model <model|provider:model|auto> to set the session default model. Use /provider for provider-only routing.",
    };
  }
  if (requested.startsWith("-")) {
    return {
      status: "blocked",
      provider: currentProvider,
      model: currentModel,
      reason: "Usage: /model <model|provider:model|auto>",
    };
  }
  if (requested === "auto") {
    return {
      status: "ready",
      provider: currentProvider,
      model: undefined,
      note: "Session default model cleared; provider routing is unchanged.",
    };
  }

  const [providerCandidate, ...modelParts] = requested.split(":");
  if (modelParts.length > 0) {
    const model = modelParts.join(":").trim();
    if (!providerCandidate || !model) {
      return {
        status: "blocked",
        provider: currentProvider,
        model: currentModel,
        reason: "Usage: /model <model|provider:model|auto>",
      };
    }
    const providers = await providerNames(handleProviders);
    if (providers.length > 0 && providerCandidate !== "auto" && !providers.includes(providerCandidate)) {
      return {
        status: "blocked",
        provider: currentProvider,
        model: currentModel,
        requested: providerCandidate,
        reason: `Provider is not registered: ${providerCandidate}`,
        providers,
      };
    }
    return {
      status: "ready",
      provider: providerCandidate,
      model,
      selected: `${providerCandidate}:${model}`,
      note:
        "Session default provider and model updated. API key, external command, shell, and network confirmations still must be passed per task.",
    };
  }

  return {
    status: "ready",
    provider: currentProvider,
    model: requested,
    note:
      "Session default model updated. Provider routing is unchanged; API key, external command, shell, and network confirmations still must be passed per task.",
  };
}

function updateDefaultReasoning({ argv = [], current } = {}) {
  const requested = argv[0];
  if (!requested) {
    return {
      status: "ready",
      reasoning: current,
      note: "Use /reasoning <auto|none|minimal|low|medium|high> to set the session default reasoning depth.",
    };
  }
  if (requested.startsWith("-")) {
    return {
      status: "blocked",
      reasoning: current,
      reason: "Usage: /reasoning <auto|none|minimal|low|medium|high>",
    };
  }
  let reasoning;
  try {
    reasoning = normalizeReasoningDepth(requested);
  } catch (error) {
    return {
      status: "blocked",
      reasoning: current,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: "ready",
    reasoning: reasoning === "auto" ? undefined : reasoning,
    display: reasoning,
    note:
      reasoning === "auto"
        ? "Session reasoning depth cleared; provider/model defaults apply."
        : "Session default reasoning depth updated. Provider support is model-specific.",
  };
}

function updateDefaultContextWindow({ argv = [], current } = {}) {
  const requested = argv[0];
  if (!requested) {
    return {
      status: "ready",
      contextWindowTokens: current,
      display: formatContextWindowTokens(current),
      note: "Use /context <auto|200k|1m> to set the session default context window budget.",
    };
  }
  if (requested.startsWith("-")) {
    return {
      status: "blocked",
      contextWindowTokens: current,
      reason: "Usage: /context <auto|200k|1m>",
    };
  }
  let tokens;
  try {
    tokens = parseContextWindowTokens(requested);
  } catch (error) {
    return {
      status: "blocked",
      contextWindowTokens: current,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: "ready",
    contextWindowTokens: tokens,
    display: formatContextWindowTokens(tokens),
    note:
      tokens === undefined
        ? "Session context window cleared; provider/model defaults apply."
        : "Session default context window budget updated. Providers still enforce their own hard limits.",
  };
}

function sessionSettings({
  defaultProvider = "auto",
  defaultModel,
  defaultReasoning,
  defaultContextWindowTokens,
  sessionAuth = {},
} = {}) {
  return {
    status: "ready",
    provider: defaultProvider,
    model: defaultModel || "auto",
    reasoning: defaultReasoning || "auto",
    context: formatContextWindowTokens(defaultContextWindowTokens),
    contextWindowTokens: defaultContextWindowTokens,
    auth: {
      useApiKey: Boolean(sessionAuth.useApiKey),
      useProviderCommand: Boolean(sessionAuth.useProviderCommand),
    },
  };
}

function isModelSelectArgv(argv = []) {
  return argv.includes("select") || argv.includes("--select");
}

async function selectSessionModel({ result, selectModel, write } = {}) {
  const choices = Array.isArray(result?.models) ? result.models : [];
  if (choices.length === 0) {
    return {
      status: "blocked",
      reason:
        "No provider returned a model list. Use /auth api-key or /auth provider-command, then retry /models select.",
    };
  }
  if (!selectModel) {
    return {
      status: "blocked",
      reason: "Interactive model selection is not available in this input mode. Use /model <provider>:<model>.",
      models: choices.map((choice) => choice.label),
    };
  }
  const selected = await selectModel(choices, { prompt: "Select model" });
  if (!selected) {
    return {
      status: "blocked",
      reason: "Model selection cancelled.",
      models: choices.map((choice) => choice.label),
    };
  }
  if (selected.available === false && selected.blockedReason) {
    write?.(`selected model provider is not ready: ${selected.blockedReason}`);
  }
  return {
    status: "ready",
    provider: selected.provider,
    model: selected.model,
    selected: selected.label,
    available: Boolean(selected.available),
    blockedReason: selected.blockedReason || "",
    note:
      "Session default provider and model updated. API key, external command, shell, and network confirmations still must be passed per task.",
  };
}

function formatModelsResult(result = {}, { json = false } = {}) {
  if (json) {
    return formatJson(result);
  }
  const models = Array.isArray(result.models) ? result.models : [];
  const blocked = blockedModelDiscoveries(result.discovery);
  const lines = [
    `status: ${result.status || "unknown"}`,
    `models: ${models.filter((model) => model.available).length}/${models.length} available`,
  ];
  if (models.length === 0) {
    lines.push("No provider returned a model list.");
    const blockedReasons = new Set((result.discovery || []).map((entry) => entry.reason).filter(Boolean));
    if (blockedReasons.has("api_key_requires_explicit_use")) {
      lines.push("A provider has an API key outside .odai/secrets.env; use /auth api-key when you want to probe it.");
    } else if (blockedReasons.has("provider_command_requires_explicit_use")) {
      lines.push("A provider requires an external command; use /auth provider-command when you want to probe it.");
    } else {
      lines.push("Use /models --json for provider-specific discovery diagnostics.");
    }
  } else {
    const width = Math.min(48, Math.max(...models.map((model) => model.label.length), 12));
    for (const model of models) {
      const marker = model.current ? "*" : " ";
      const status = model.available ? "ready" : model.blockedReason || "blocked";
      lines.push(`${marker} ${model.label.padEnd(width)} ${status} ${model.source || ""}`.trimEnd());
    }
  }
  if (blocked.length > 0) {
    lines.push(`blocked providers: ${blocked.length}`);
    for (const entry of blocked.slice(0, 8)) {
      lines.push(`  ${entry.provider}: ${entry.reason || "blocked"}${entry.source ? ` (${entry.source})` : ""}`);
    }
    if (blocked.length > 8) {
      lines.push(`  ... ${blocked.length - 8} more`);
    }
  }
  lines.push("Use /models select to pick with arrow keys, or /model <provider>:<model>.");
  lines.push("Use /models --json for discovery diagnostics and provider details.");
  return lines.join("\n");
}

function blockedModelDiscoveries(discovery = []) {
  return Array.isArray(discovery)
    ? discovery.filter((entry) => entry && entry.status !== "ready")
    : [];
}

async function providerNames(handleProviders) {
  const availableProviders = await handleProviders?.([]);
  return Array.isArray(availableProviders?.providers)
    ? availableProviders.providers.map((entry) => entry.name).filter(Boolean)
    : [];
}

export function parseInteractiveArgs(input) {
  const args = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }
  return args;
}

function formatRunSummary(result = {}, { workspaceRoot = process.cwd() } = {}) {
  const savedPath = result.savedRecordPath
    ? `saved: ${formatDisplayPath(result.savedRecordPath, workspaceRoot)}`
    : result.recordPath
      ? `record: ${formatDisplayPath(result.recordPath, workspaceRoot)}`
      : "";
  return [
    `status: ${result.status || "unknown"}`,
    result.task ? `task: ${redactString(result.task)}` : "",
    result.agentLoop?.agent?.provider
      ? `provider: ${result.agentLoop.agent.provider}`
      : result.subagent?.provider
        ? `provider: ${result.subagent.provider}`
        : "",
    formatRunModel(result),
    formatRunModelOptions(result),
    formatRunUsage(result),
    formatRunOutput(result),
    ...formatToolActions(result, { workspaceRoot }),
    Array.isArray(result.subagentReviews) && result.subagentReviews.length > 0
      ? `subagents: ${result.subagentReviews.length}`
      : "",
    Array.isArray(result.requiredAuthorizations) && result.requiredAuthorizations.length > 0
      ? `authorization: ${result.requiredAuthorizations.map((scope) => `/authorize ${scope}`).join(", ")}`
      : "",
    savedPath,
    result.note ? `note: ${redactString(result.note)}` : "",
    result.error ? `error: ${formatErrorMessage(result.error)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatRunModel(result = {}) {
  const model = result.agentLoop?.finalOutput?.model
    || result.agentLoop?.turns?.findLast?.((turn) => turn?.output?.model)?.output?.model
    || result.subagent?.model
    || result.model;
  return model ? `model: ${redactString(String(model))}` : "";
}

function formatRunModelOptions(result = {}) {
  const options = result.modelOptions;
  if (!options || typeof options !== "object") return "";
  const parts = [];
  if (options.reasoning) parts.push(`reasoning ${redactString(String(options.reasoning))}`);
  if (Number.isFinite(options.contextWindowTokens)) {
    parts.push(`context ${formatContextWindowTokens(options.contextWindowTokens)}`);
  }
  return parts.length > 0 ? `model options: ${parts.join(", ")}` : "";
}

function formatRunOutput(result = {}) {
  const text = result.agentLoop?.finalOutput?.text
    || result.agentLoop?.turns?.findLast?.((turn) => typeof turn?.output?.text === "string")?.output?.text
    || result.subagent?.text
    || result.text;
  const display = truncateDisplayText(redactString(String(text || "").trimEnd()));
  return display ? `output:\n${display}` : "";
}

function formatRunUsage(result = {}) {
  const output = finalProviderOutput(result);
  const usage = publicUsage(output?.usage || output?.usageMetadata);
  const usageText = formatUsageTokens(usage);
  if (usageText) return `usage: ${usageText}`;
  const text = output?.text || result.text || "";
  const estimated = estimateTokensFromText(text);
  return estimated > 0 ? `usage: output ~${estimated} tok estimated` : "";
}

function finalProviderOutput(result = {}) {
  return result.agentLoop?.finalOutput
    || result.agentLoop?.turns?.findLast?.((turn) => turn?.output)?.output
    || result.subagent
    || result;
}

function truncateDisplayText(value = "", limit = 2000) {
  const text = String(value || "");
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
}

function formatErrorMessage(error) {
  if (typeof error === "string") return redactString(error);
  if (error && typeof error === "object") {
    return redactString(error.message || error.reason || JSON.stringify(error));
  }
  return redactString(String(error || ""));
}

function formatToolActions(result = {}, { workspaceRoot = process.cwd() } = {}) {
  const turns = result.agentLoop?.turns || [];
  const actions = [];
  for (const turn of turns) {
    for (const toolResult of turn.toolResults || []) {
      actions.push(formatToolAction(toolResult, { workspaceRoot }));
    }
  }
  return actions.filter(Boolean).slice(0, 8);
}

function formatToolAction(toolResult = {}, { workspaceRoot = process.cwd() } = {}) {
  if (toolResult.type === "list") {
    const displayPath = formatDisplayPath(toolResult.path, workspaceRoot);
    const count = Array.isArray(toolResult.entries) ? toolResult.entries.length : 0;
    return `tool: list ${displayPath || "."} ${count} entries${toolResult.truncated ? " truncated" : ""}`;
  }
  if (toolResult.type === "read") {
    const displayPath = formatDisplayPath(toolResult.path, workspaceRoot);
    return toolResult.ok === false
      ? `tool: read ${displayPath} failed ${redactString(toolResult.error || toolResult.reason || "")}`.trimEnd()
      : `tool: read ${displayPath}`;
  }
  if (toolResult.type === "search") {
    const displayPath = formatDisplayPath(toolResult.path, workspaceRoot);
    const count = Array.isArray(toolResult.matches) ? toolResult.matches.length : 0;
    return `tool: search ${displayPath || "."} ${count} matches${toolResult.truncated ? " truncated" : ""}`;
  }
  if (toolResult.type === "write") {
    return `tool: write ${formatDisplayPath(toolResult.path, workspaceRoot)}`;
  }
  if (toolResult.type === "shell") {
    const command = Array.isArray(toolResult.command)
      ? redactCommand(toolResult.command)?.join(" ")
      : redactString(toolResult.command || "");
    return `tool: shell ${command || ""}`.trimEnd();
  }
  if (toolResult.type === "network") {
    return `tool: network ${toolResult.method || "GET"} ${redactUrl(toolResult.url || "")} ${
      toolResult.status || ""
    }`.trimEnd();
  }
  if (toolResult.gate) {
    return `tool: blocked ${toolResult.gate} ${redactString(toolResult.reason || "")}`.trimEnd();
  }
  return "";
}

function formatProgressEvent(event = {}, { workspaceRoot = process.cwd() } = {}) {
  if (event.type === "agent-turn-start") {
    return `agent: turn ${event.turn} ${event.provider}`;
  }
  if (event.type === "provider-text") {
    return `assistant: ${oneLine(redactString(event.text || ""))}`;
  }
  if (event.type === "provider-usage") {
    return "";
  }
  if (event.type === "tool-result") {
    return formatToolAction(event.result, { workspaceRoot });
  }
  return "";
}

function createStatusLineWriter({ write = () => {}, writeStatus } = {}) {
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

function fitStatusLine(message = "") {
  const value = oneLine(String(message || ""));
  const columns = Number(process.stdout?.columns || 0);
  if (!Number.isFinite(columns) || columns <= 20 || value.length < columns) return value;
  return `${value.slice(0, Math.max(0, columns - 4))}...`;
}

function createProgressMeter({ statusLine, onMeterEvent } = {}) {
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

function meterEvent(state = {}, { done = false } = {}) {
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

function formatMeterLine(state = {}, { done = false } = {}) {
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

function shouldEmitOutputProgress(state = {}, now = Date.now()) {
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

function formatUsageTokens(usage = {}) {
  const input = firstNumber(usage.input_tokens, usage.prompt_tokens, usage.promptTokenCount);
  const output = firstNumber(usage.output_tokens, usage.completion_tokens, usage.candidatesTokenCount);
  const total = firstNumber(usage.total_tokens, usage.totalTokenCount);
  const parts = [];
  if (input !== undefined) parts.push(`input ${input} tok`);
  if (output !== undefined) parts.push(`output ${output} tok`);
  if (total !== undefined) parts.push(`total ${total} tok`);
  return parts.join(" ");
}

function firstNumber(...values) {
  return values.find((value) => Number.isFinite(value));
}

function estimateTokensFromText(value = "") {
  return estimateTokensFromTextByChars(String(value || "").length);
}

function estimateTokensFromTextByChars(chars = 0) {
  return Math.max(0, Math.ceil(Number(chars || 0) / 4));
}

function estimateThinkingTokensFromElapsedMs(elapsedMs = 0) {
  // External CLIs often do not stream hidden reasoning or usage; this is only a visible activity estimate.
  return Math.max(0, Math.ceil((Number(elapsedMs || 0) / 1000) * 8));
}

function estimateMeterTotalTokens({
  estimatedInputTokens,
  estimatedThinkingTokens = 0,
  estimatedOutputTokens = 0,
} = {}) {
  const input = Number.isFinite(estimatedInputTokens) ? estimatedInputTokens : 0;
  return input + Math.max(estimatedThinkingTokens || 0, estimatedOutputTokens || 0);
}

function formatDisplayPath(value, workspaceRoot = process.cwd()) {
  if (typeof value !== "string" || value === "") return "";
  const redacted = redactString(value);
  if (!path.isAbsolute(redacted)) return redacted;
  const root = path.resolve(workspaceRoot || process.cwd());
  const relative = path.relative(root, redacted);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return redactString(relative);
  }
  return redacted;
}

function summarizeTranscriptEvent(event = {}, { workspaceRoot = process.cwd() } = {}) {
  if (event.type === "provider-text") {
    return {
      type: event.type,
      provider: event.provider,
      model: event.model,
      text: oneLine(redactString(event.text || ""), 1000),
    };
  }
  if (event.type === "provider-usage") {
    return {
      type: event.type,
      provider: event.provider,
      model: event.model,
      usage: publicUsage(event.usage || event.usageMetadata),
    };
  }
  if (event.type === "provider-meter") {
    return {
      type: event.type,
      provider: event.provider,
      model: event.model,
      turn: event.turn,
      phase: event.phase,
      elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : undefined,
      outputChars: Number.isFinite(event.outputChars) ? event.outputChars : undefined,
      estimatedInputTokens: Number.isFinite(event.estimatedInputTokens) ? event.estimatedInputTokens : undefined,
      estimatedOutputTokens: Number.isFinite(event.estimatedOutputTokens) ? event.estimatedOutputTokens : undefined,
      estimatedActiveTokens: Number.isFinite(event.estimatedActiveTokens) ? event.estimatedActiveTokens : undefined,
      estimatedThinkingTokens: Number.isFinite(event.estimatedThinkingTokens)
        ? event.estimatedThinkingTokens
        : undefined,
      estimatedTotalTokens: Number.isFinite(event.estimatedTotalTokens) ? event.estimatedTotalTokens : undefined,
      usage: publicUsage(event.usage) || {},
    };
  }
  if (event.type === "tool-result") {
    return {
      type: event.type,
      result: summarizeToolResult(event.result, { workspaceRoot }),
    };
  }
  return {
    type: event.type,
    turn: event.turn,
    provider: event.provider,
  };
}

function summarizeTranscriptResult(result = {}, { workspaceRoot = process.cwd() } = {}) {
  return {
    status: result.status,
    kind: result.kind,
    task: typeof result.task === "string" ? redactString(result.task) : result.task,
    provider: result.agentLoop?.agent?.provider || result.subagent?.provider || result.provider?.name || result.provider,
    summary: result.summary && typeof result.summary === "object" ? result.summary : undefined,
    blockerCount: Array.isArray(result.blockers) ? result.blockers.length : undefined,
    savedRecordPath: result.savedRecordPath ? formatDisplayPath(result.savedRecordPath, workspaceRoot) : result.savedRecordPath,
    recordPath: result.recordPath ? formatDisplayPath(result.recordPath, workspaceRoot) : result.recordPath,
    providerSessions: Array.isArray(result.providerSessions) ? result.providerSessions : undefined,
    requiredAuthorizationCount: Array.isArray(result.requiredAuthorizations)
      ? result.requiredAuthorizations.length
      : undefined,
    toolActions: formatToolActions(result, { workspaceRoot }),
    subagentReviewCount: Array.isArray(result.subagentReviews) ? result.subagentReviews.length : undefined,
    note: result.note,
    error: result.error,
  };
}

function summarizeToolResult(result = {}, { workspaceRoot = process.cwd() } = {}) {
  return {
    ok: result.ok,
    type: result.type,
    path: result.path ? formatDisplayPath(result.path, workspaceRoot) : result.path,
    entryCount: Array.isArray(result.entries) ? result.entries.length : undefined,
    matchCount: Array.isArray(result.matches) ? result.matches.length : undefined,
    truncated: result.truncated,
    gate: result.gate,
    reason: result.reason,
    error: result.error,
    command: Array.isArray(result.command) ? result.command : undefined,
    url: result.url,
    method: result.method,
    status: result.status,
  };
}

function oneLine(text = "", limit = 240) {
  const value = String(text).replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function formatRollbackSummary(result = {}) {
  return [
    `status: ${result.status || "unknown"}`,
    result.task ? `task: ${redactString(result.task)}` : "",
    result.confirmRequired ? "mode: preview" : "mode: confirmed",
    Array.isArray(result.items) ? `items: ${result.items.length}` : "",
    result.note ? `note: ${redactString(result.note)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDoctorSummary(result = {}, { workspaceRoot = process.cwd() } = {}) {
  if (result.kind === "odai-status") {
    return [
      `status: ${result.status || "unknown"}`,
      `governance: ${result.summary?.governanceCovered || 0}/${result.summary?.governanceTotal || 0} covered`,
      `acceptance: ${result.summary?.acceptanceReady || 0}/${result.summary?.acceptanceTotal || 0} ready`,
      `milestones: ${result.summary?.milestonesReady || 0}/${result.summary?.milestonesTotal || 0} ready`,
      `e2e: ${result.summary?.e2eReady || 0}/${result.summary?.e2eTotal || 0} ready`,
      Array.isArray(result.blockers) && result.blockers.length > 0 ? `blockers: ${result.blockers.length}` : "",
      Array.isArray(result.next) && result.next.length > 0 ? `next: ${redactString(result.next[0])}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "completion-audit") {
    return [
      `status: ${result.status || "unknown"}`,
      `complete: ${result.complete ? "yes" : "no"}`,
      `requirements: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      result.summary?.blocked ? `blocked: ${result.summary.blocked}` : "",
      Array.isArray(result.next) && result.next.length > 0 ? `next: ${redactString(result.next[0])}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "setup-guide") {
    return [
      `status: ${result.status || "unknown"}`,
      `setup: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      `e2e: ${result.summary?.e2eReady || 0}/${result.summary?.e2eTotal || 0} ready`,
      `saved evidence: ${result.summary?.savedEvidenceReady || 0}/${result.summary?.savedEvidenceTotal || 0} ready`,
      result.summary?.blocked ? `blocked: ${result.summary.blocked}` : "",
      Array.isArray(result.next) && result.next.length > 0 ? `next: ${redactString(result.next[0])}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "external-evidence") {
    return [
      `status: ${result.status || "unknown"}`,
      `external evidence: ${result.summary?.ready || 0}/${(result.summary?.ready || 0) + (result.summary?.blocked || 0)} ready`,
      `api providers: ${result.summary?.apiProviders || 0}`,
      `subscription runtime providers: ${result.summary?.subscriptionRuntimeProviders || 0}`,
      `strong sandbox smokes: ${result.summary?.strongSandboxSmokes || 0}`,
      result.summary?.parseErrors ? `parse errors: ${result.summary.parseErrors}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "runtime-governance") {
    return [
      `status: ${result.status || "unknown"}`,
      `governance: ${result.summary?.covered || 0}/${result.summary?.total || 0} covered`,
      result.summary?.missingCanary ? `missing canary: ${result.summary.missingCanary}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "plan-acceptance") {
    return [
      `status: ${result.status || "unknown"}`,
      `acceptance: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      result.summary?.["needs-external-evidence"]
        ? `external evidence needed: ${result.summary["needs-external-evidence"]}`
        : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "sandbox-readiness") {
    return [
      `status: ${result.status || "unknown"}`,
      `sandbox: ${result.configured?.mode || "unknown"} (${result.configured?.status || "unknown"})`,
      `ready candidates: ${result.summary?.readyCandidates || 0}`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "sandbox-smoke") {
    return [
      `status: ${result.status || "unknown"}`,
      `sandbox smoke: ${result.status === "ready" ? "passed" : "not ready"}`,
      result.result?.sandbox?.mode ? `sandbox: ${result.result.sandbox.mode}` : "",
      result.escapeProbe ? `escape: ${result.escapeProbe.hostEscapeCreated ? "host file created" : "host file not created"}` : "",
      result.reason ? `reason: ${redactString(result.reason)}` : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "plan-milestones") {
    return [
      `status: ${result.status || "unknown"}`,
      `milestones: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      result.summary?.partial ? `partial: ${result.summary.partial}` : "",
      result.summary?.["needs-external-evidence"]
        ? `external evidence needed: ${result.summary["needs-external-evidence"]}`
        : "",
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "e2e-readiness") {
    return [
      `status: ${result.status || "unknown"}`,
      `e2e: ${result.summary?.ready || 0}/${result.summary?.total || 0} ready`,
      `real providers: ${result.summary?.availableRealProviders || 0}`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (Array.isArray(result.probes)) {
    return [
      `status: ${result.status || "unknown"}`,
      `probes: ${result.summary?.ready || 0} ready, ${result.summary?.blocked || 0} blocked, ${result.summary?.failed || 0} failed`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (Array.isArray(result.providers?.providers)) {
    const available = result.providers.providers.filter((provider) => provider.available).length;
    return [
      `status: ${result.status || "unknown"}`,
      `providers: ${available}/${result.providers.providers.length} available`,
      result.note ? `note: ${redactString(result.note)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `status: ${result.status || "unknown"}`,
    result.provider?.name ? `provider: ${result.provider.name}` : result.provider ? `provider: ${result.provider}` : "",
    result.probe?.model ? `model: ${result.probe.model}` : "",
    typeof result.probe?.toolIntentCount === "number" ? `toolIntents: ${result.probe.toolIntentCount}` : "",
    result.error?.message ? `error: ${redactString(result.error.message)}` : "",
    result.savedRecordPath ? `saved: ${formatDisplayPath(result.savedRecordPath, workspaceRoot)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}
