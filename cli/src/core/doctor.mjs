import { writeWorkspaceRunRecord } from "./run-store.mjs";
import {
  runAcceptance,
  runAudit,
  runE2EReadiness,
  runEvidence,
  runGovernance,
  runMilestones,
  runSetup,
  runStatus,
} from "./status-commands.mjs";
import { runSandboxReadiness, runSandboxSmoke } from "./sandbox-commands.mjs";
import {
  applyProviderCommandOption,
  enabledFlagValue,
  optionToken,
  providerCommandAuthArgv,
} from "./cli-args.mjs";
import {
  publicError,
  summarizeProgressEvents,
  summarizeProvider,
  summarizeProviderProbe,
} from "./public-summaries.mjs";
import { UsageLedger } from "../runtime/usage-ledger.mjs";
import { collectProviderSessions } from "../runtime/provider-session.mjs";
import { redactString, redactUrl } from "../runtime/redaction.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadProviderConfig,
  loadWorkspaceEnvironment,
} from "../config/provider-config.mjs";
import { withProviderModelOverride, withRegistryModelOverride } from "../orchestrator/provider-model.mjs";

export async function runDoctor({
  repoRoot: root = process.cwd(),
  argv = [],
  env = process.env,
  onEvent,
  fetchImpl,
} = {}) {
  const args = parseDoctorArgs(argv);
  args.onEvent = onEvent;
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: root, env });

  if (args.governance) {
    const result = runGovernance();
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.status) {
    const result = runStatus({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.setup) {
    const result = await runSetup({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.audit) {
    const result = runAudit({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.evidence) {
    const result = runEvidence({ repoRoot: root });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.acceptance) {
    const result = runAcceptance({ repoRoot: root, argv: buildE2EArgvFromDoctorArgs(args), env: workspaceEnv });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.milestones) {
    const result = runMilestones({
      repoRoot: root,
      argv: buildE2EArgvFromDoctorArgs(args),
      env: workspaceEnv,
    });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.sandbox) {
    const result = args.smoke
      ? await runSandboxSmoke({
          repoRoot: root,
          argv: [
            "--smoke",
            ...(args.allowShell ? ["--allow-shell"] : []),
          ],
        })
      : runSandboxReadiness({ repoRoot: root });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  if (args.e2e) {
    const result = runE2EReadiness({
      repoRoot: root,
      argv: buildE2EArgvFromDoctorArgs(args),
      env: workspaceEnv,
    });
    if (args.save) {
      result.savedRecordPath = await saveDoctorRecord({ root, result, args });
    }
    return result;
  }

  const providerConfig = loadProviderConfig({ workspaceRoot: root, env });
  const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: args.useApiKey,
    allowProviderCommand: args.useProviderCommand,
    allowedProviderCommands: args.providerCommandProviders,
    config: providerConfig,
    fetchImpl,
  });

  const providerReport = describeProviders(withRegistryModelOverride(registry, args.model), workspaceEnv);
  let result;
  if (args.all) {
    const probes = [];
    for (const provider of registry.list()) {
      probes.push(await probeDoctorProvider({ provider, args }));
    }
    const summary = summarizeDoctorProbes(probes);
    result = {
      status: doctorSummaryStatus(summary),
      providers: providerReport,
      probes,
      summary,
      note: "Only providers marked available were probed. Blocked providers were not called.",
    };
  } else if (!args.provider) {
    return {
      status: "ready",
      providers: providerReport,
      note: "Use `odai doctor --provider <name>` or `odai doctor --all` to run no-tool provider probes.",
    };
  } else {
    try {
      const provider = registry.get(args.provider);
      result = await probeDoctorProvider({ provider, args });
    } catch (error) {
      result = {
        status: "failed",
        provider: args.provider,
        error: publicError(error),
      };
    }
  }

  if (args.save) {
    result.savedRecordPath = await saveDoctorRecord({ root, result, args });
  }
  return result;
}

async function saveDoctorRecord({ root, result, args }) {
  return writeWorkspaceRunRecord({
    workspaceRoot: root,
    record: {
      ...result,
      mode: "doctor",
      resume: {
        argv: buildDoctorResumeArgv(args),
      },
    },
  });
}

async function probeDoctorProvider({ provider, args }) {
  const effectiveProvider = withProviderModelOverride(provider, args.model);
  if (effectiveProvider.available === false) {
    return {
      status: "blocked",
      provider: summarizeProvider(effectiveProvider),
      probe: undefined,
      error: {
        name: "ProviderUnavailable",
        message: effectiveProvider.blockedReason || `Provider is not available: ${effectiveProvider.name}`,
      },
    };
  }

  try {
    const probeEvents = [];
    const usageLedger = new UsageLedger();
    const probeOnEvent = args.stream
      ? (event) => {
          probeEvents.push(event);
          args.onEvent?.(event);
        }
      : undefined;
    const agent = {
      id: `doctor:${provider.name}:${Date.now()}`,
      role: "doctor",
      provider: effectiveProvider.name,
    };
    const { output } = await usageLedger.trackProviderCall({
      provider: effectiveProvider,
      agent,
      profile: "doctor",
      mode: "provider_probe",
      run: () =>
        effectiveProvider.run({
          agent,
          input: {
            task: args.prompt,
            mode: "provider_probe",
            constraints: [
              "Do not request local tools.",
              "Return a short health-check response.",
              "Do not claim that files, shell commands, or network tools were executed.",
            ],
          },
          tools: {},
          onEvent: probeOnEvent,
        }),
    });
    const usageSnapshot = usageLedger.snapshot();
    return {
      status: "ready",
      provider: summarizeProvider(effectiveProvider),
      probe: summarizeProviderProbe(output),
      events: args.stream ? summarizeProgressEvents(probeEvents) : undefined,
      providerSessions: collectProviderSessions(usageSnapshot.calls),
      usage: usageSnapshot,
    };
  } catch (error) {
    return {
      status: "failed",
      provider: summarizeProvider(effectiveProvider),
      error: publicError(error),
      next: doctorFailureNext({ provider: effectiveProvider, error, args }),
    };
  }
}

function doctorFailureNext({ provider, error, args } = {}) {
  const message = String(error?.message || "");
  if (provider?.name === "claude-cli" && /not logged in|\/login/i.test(message)) {
    const command = provider.source?.command || "claude";
    return [
      `Run ${redactString(redactUrl(command))} and enter /login.`,
      [
        "odai",
        "doctor",
        "--provider",
        "claude-cli",
        "--use-provider-command",
        ...(args?.model ? ["--model", args.model] : ["--model", "<model>"]),
        "--save",
      ].join(" "),
    ];
  }
  return [];
}

function summarizeDoctorProbes(probes = []) {
  return probes.reduce(
    (summary, probe) => {
      summary.total += 1;
      summary[probe.status] = (summary[probe.status] || 0) + 1;
      return summary;
    },
    { total: 0, ready: 0, blocked: 0, failed: 0 },
  );
}

export function doctorSummaryStatus(summary = {}) {
  if ((summary.failed || 0) > 0) return "failed";
  if ((summary.blocked || 0) > 0) return "partial";
  return "ready";
}

function parseDoctorArgs(argv) {
  const args = {
    provider: "",
    all: false,
    prompt: "odai provider health check. Reply with a short plain-text response only.",
    model: "",
    useApiKey: false,
    useProviderCommand: false,
    providerCommandProviders: [],
    save: false,
    stream: false,
    governance: false,
    status: false,
    setup: false,
    audit: false,
    evidence: false,
    acceptance: false,
    milestones: false,
    sandbox: false,
    e2e: false,
    smoke: false,
    allowShell: false,
    onEvent: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--all") {
      args.all = enabledFlagValue(option);
    } else if (option.name === "--provider") {
      args.provider = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--prompt") {
      args.prompt = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--model") {
      args.model = option.hasInlineValue ? option.value : argv[++i];
    } else if (option.name === "--use-api-key") {
      args.useApiKey = enabledFlagValue(option);
    } else if (option.name === "--use-provider-command") {
      applyProviderCommandOption(args, option);
    } else if (option.name === "--save") {
      args.save = enabledFlagValue(option);
    } else if (option.name === "--stream") {
      args.stream = enabledFlagValue(option);
    } else if (option.name === "--governance") {
      args.governance = enabledFlagValue(option);
    } else if (option.name === "--status") {
      args.status = enabledFlagValue(option);
    } else if (option.name === "--setup") {
      args.setup = enabledFlagValue(option);
    } else if (option.name === "--audit") {
      args.audit = enabledFlagValue(option);
    } else if (option.name === "--evidence") {
      args.evidence = enabledFlagValue(option);
    } else if (option.name === "--acceptance") {
      args.acceptance = enabledFlagValue(option);
    } else if (option.name === "--milestones") {
      args.milestones = enabledFlagValue(option);
    } else if (option.name === "--sandbox") {
      args.sandbox = enabledFlagValue(option);
    } else if (option.name === "--e2e") {
      args.e2e = enabledFlagValue(option);
    } else if (option.name === "--smoke") {
      args.smoke = enabledFlagValue(option);
    } else if (option.name === "--allow-shell") {
      args.allowShell = enabledFlagValue(option);
    }
  }

  return args;
}

function buildE2EArgvFromDoctorArgs(args) {
  return [
    ...(args.useApiKey ? ["--use-api-key"] : []),
    ...providerCommandAuthArgv(args),
    ...(args.model ? ["--model", args.model] : []),
  ];
}

function buildDoctorResumeArgv(args) {
  return [
    "doctor",
    ...(args.governance ? ["--governance"] : []),
    ...(args.status ? ["--status"] : []),
    ...(args.setup ? ["--setup"] : []),
    ...(args.audit ? ["--audit"] : []),
    ...(args.evidence ? ["--evidence"] : []),
    ...(args.acceptance ? ["--acceptance"] : []),
    ...(args.milestones ? ["--milestones"] : []),
    ...(args.sandbox ? ["--sandbox"] : []),
    ...(args.e2e ? ["--e2e"] : []),
    ...(args.smoke ? ["--smoke"] : []),
    ...(args.all ? ["--all"] : []),
    ...(args.provider ? ["--provider", args.provider] : []),
    ...(args.prompt ? ["--prompt", args.prompt] : []),
    ...(args.model ? ["--model", args.model] : []),
    ...(args.stream ? ["--stream"] : []),
  ];
}
