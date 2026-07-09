import {
  formatContextWindowTokens,
} from "../runtime/model-options.mjs";
import { detectLanguage, normalizeLanguage, t } from "../runtime/i18n.mjs";
import { publicInputLine, publicTaskArgv } from "../runtime/redaction.mjs";
import { publicTranscriptEntry } from "./transcript-store.mjs";
import { parseInteractiveArgs } from "./interactive/args.mjs";
import {
  appendSessionAuthArgv,
  normalizeProviderCommandList,
  updateSessionAuth,
} from "./interactive/session-auth.mjs";
import {
  formatModelsResult,
  isModelSelectArgv,
  selectSessionModel,
  sessionSettings,
  updateDefaultContextWindow,
  updateDefaultModel,
  updateDefaultProvider,
  updateDefaultReasoning,
  updateSessionLanguage,
} from "./interactive/session-settings.mjs";
import {
  createStatusLineWriter,
  defaultInteractiveWrite,
  formatAuthorizationResult,
  formatDisplayPath,
  formatDoctorSummary,
  formatInteractiveStatus,
  formatJson,
  formatRollbackSummary,
  formatRunSummary,
  formatSessionCommandResult,
  summarizeTranscriptResult,
} from "./interactive/session-format.mjs";
import {
  askNext,
  buildNextTaskContext,
  normalizeTaskArgv,
  runTaskWithInteractiveAuthorization,
} from "./interactive/session-task.mjs";
import {
  findSkillByName,
  formatSkillsReport,
  listAllSkills,
  normalizeSkillName,
  RESERVED_SLASH_COMMANDS,
} from "./skill-discovery.mjs";

export { parseInteractiveArgs } from "./interactive/args.mjs";
export { normalizeTaskArgv } from "./interactive/session-task.mjs";
export {
  compressConversationContext,
} from "../runtime/context-compress.mjs";

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
    allowShell: false,
    allowNetwork: false,
  };
  // Extra craft skills enabled for this interactive session (odai system skill is always on).
  const sessionSkills = new Set(
    Array.isArray(initialPreferences.skills)
      ? initialPreferences.skills.map(normalizeSkillName).filter((name) => name && name !== "odai")
      : [],
  );
  let lastTaskArgv = Array.isArray(resumeContext?.lastTaskArgv) && resumeContext.lastTaskArgv.length > 0
    ? normalizeTaskArgv(resumeContext.lastTaskArgv, {
        defaultProvider,
        defaultModel,
        defaultReasoning,
        defaultContextWindowTokens,
        sessionAuth,
        skills: [...sessionSkills],
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
      skills: [...sessionSkills],
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

    if (line === "/skills" || line.startsWith("/skills ")) {
      // Full inventory: every discovered install path (not name-deduped).
      const discovered = listAllSkills({ workspaceRoot });
      const result = {
        status: "ready",
        kind: "skills",
        workspaceRoot,
        active: [...sessionSkills],
        skills: discovered.map((skill) => ({
          name: skill.name,
          scope: skill.scope,
          sourceKind: skill.sourceKind,
          sourceRoot: skill.sourceRoot,
          system: skill.system,
          primary: skill.primary,
          reservedClash: skill.reservedClash,
          active: skill.name === "odai" || sessionSkills.has(skill.name),
          description: skill.description,
          root: skill.root,
        })),
      };
      write(formatSkillsList(result));
      await record({ type: "command-result", command: "skills", result: publicSkillsSummary(result) });
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
      if (result.status === "ready" && result.session) {
        sessionAuth = {
          useApiKey: Boolean(result.session?.useApiKey),
          useProviderCommand: Boolean(result.session?.useProviderCommand),
          providerCommands: normalizeProviderCommandList(result.session?.providerCommands),
          allowShell: Boolean(result.session?.allowShell),
          allowNetwork: Boolean(result.session?.allowNetwork),
        };
        // Durable provider confirmations only; shell/network stay session-scoped.
        if (result.persist !== false) {
          await savePreferences?.({
            auth: {
              useApiKey: sessionAuth.useApiKey,
              useProviderCommand: sessionAuth.useProviderCommand,
              providerCommands: sessionAuth.providerCommands,
            },
          });
        }
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
      const retryArgv = normalizeTaskArgv(appendSessionAuthArgv(lastTaskArgv, sessionAuth), {
        defaultProvider,
        defaultModel,
        defaultReasoning,
        defaultContextWindowTokens,
        sessionAuth,
        skills: [...sessionSkills],
      });
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
      const skillResult = applySessionSkillCommand({
        line,
        workspaceRoot,
        sessionSkills,
        language: activeLanguage(),
      });
      if (skillResult) {
        if (skillResult.status === "ready" && skillResult.persistSkills) {
          await savePreferences?.({ skills: [...sessionSkills] });
        }
        write(skillResult.note || formatInteractiveStatus(skillResult));
        await record({
          type: "command-result",
          command: "skill",
          result: {
            status: skillResult.status,
            name: skillResult.name,
            active: [...sessionSkills],
            action: skillResult.action,
          },
        });
        continue;
      }
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
      skills: [...sessionSkills],
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

function applySessionSkillCommand({ line, workspaceRoot, sessionSkills, language = "en" }) {
  const tokens = parseInteractiveArgs(String(line || "").replace(/^\//, ""));
  const name = normalizeSkillName(tokens[0] || "");
  if (!name || RESERVED_SLASH_COMMANDS.has(name)) {
    return undefined;
  }
  const skill = findSkillByName(name, { workspaceRoot });
  if (!skill) {
    return undefined;
  }
  if (skill.system || name === "odai") {
    return {
      status: "ready",
      name,
      action: "system",
      note: "odai is the system governance skill and is always active.",
      persistSkills: false,
    };
  }
  const actionToken = normalizeSkillName(tokens[1] || "on");
  if (["off", "disable", "clear", "remove", "unset"].includes(actionToken)) {
    sessionSkills.delete(name);
    return {
      status: "ready",
      name,
      action: "disabled",
      note: `Skill disabled for this session: ${name}`,
      persistSkills: true,
    };
  }
  sessionSkills.add(name);
  return {
    status: "ready",
    name,
    action: "enabled",
    note: `Skill enabled for this session: ${name} (${skill.scope}/${skill.sourceKind})`,
    persistSkills: true,
  };
}

function formatSkillsList(result = {}) {
  return formatSkillsReport({
    skills: result.skills || [],
    active: result.active || [],
    workspaceRoot: result.workspaceRoot || process.cwd(),
  });
}

function publicSkillsSummary(result = {}) {
  return {
    status: result.status,
    kind: result.kind,
    active: result.active,
    count: Array.isArray(result.skills) ? result.skills.length : 0,
    names: Array.isArray(result.skills)
      ? [...new Set(result.skills.map((skill) => skill.name))]
      : [],
    roots: Array.isArray(result.skills) ? result.skills.map((skill) => skill.root) : [],
  };
}

