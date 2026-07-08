import {
  completeInteractiveLine,
  continueLatestRun,
  createInteractiveCompleter,
  describeInteractiveCompletions,
  doctorSummaryStatus,
  formatModelsList,
  rollbackLatestRun,
  runAcceptance,
  runAgents,
  runAudit,
  runCliSession,
  runDoctor,
  runE2EReadiness,
  runEvidence,
  runGovernance,
  runInit,
  runMilestones,
  runModels,
  runMockTask,
  runSandboxReadiness,
  runSandboxSmoke,
  runSessions,
  runSetup,
  runStatus,
} from "./index.mjs";
import {
  createProviderRegistryFromEnvironment,
  describeProviders,
  loadWorkspaceEnvironment,
  loadWorkspaceProviderConfig,
} from "./config/provider-config.mjs";
import { runInteractiveSession } from "./core/interactive-session.mjs";
import {
  detectLanguage,
  languageName,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  t,
} from "./runtime/i18n.mjs";
import {
  checkForPackageUpdate,
  compareSemver,
  fetchLatestPackageVersion,
  readRuntimePackageMetadata,
  shouldRunStartupUpdateCheck,
} from "./runtime/update-check.mjs";

export {
  completeInteractiveLine,
  continueLatestRun,
  createInteractiveCompleter,
  describeInteractiveCompletions,
  doctorSummaryStatus,
  formatModelsList,
  rollbackLatestRun,
  runAcceptance,
  runAgents,
  runAudit,
  runCliSession,
  runDoctor,
  runE2EReadiness,
  runEvidence,
  runGovernance,
  runInit,
  runInteractiveSession,
  runMilestones,
  runModels,
  runSandboxReadiness,
  runSandboxSmoke,
  runSessions,
  runSetup,
  runStatus,
  detectLanguage,
  languageName,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  t,
  checkForPackageUpdate,
  compareSemver,
  fetchLatestPackageVersion,
  readRuntimePackageMetadata,
  shouldRunStartupUpdateCheck,
};

export async function runTask(options = {}) {
  return runMockTask(options);
}

export async function listModels(options = {}) {
  return runModels(options);
}

export function listProviders({
  repoRoot = process.cwd(),
  argv = [],
  env = process.env,
} = {}) {
  const workspaceEnv = loadWorkspaceEnvironment({ workspaceRoot: repoRoot, env });
  const providerConfig = loadWorkspaceProviderConfig({ workspaceRoot: repoRoot });
  const registry = createProviderRegistryFromEnvironment(workspaceEnv, {
    allowApiKey: enabledFlag(argv, "--use-api-key"),
    allowProviderCommand: enabledFlag(argv, "--use-provider-command"),
    config: providerConfig,
  });
  return describeProviders(registry, workspaceEnv);
}

export function createRuntime({
  repoRoot = process.cwd(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  runCommand,
} = {}) {
  return {
    repoRoot,
    runTask: (options = {}) => runTask({ repoRoot, ...options }),
    runInteractive: (options = {}) => runCliSession({ repoRoot, ...options }),
    listProviders: (options = {}) => listProviders({ repoRoot, env, ...options }),
    listModels: (options = {}) => listModels({ repoRoot, env, fetchImpl, runCommand, ...options }),
    agents: (options = {}) => runAgents({ repoRoot, env, ...options }),
    setup: (options = {}) => runSetup({ repoRoot, env, ...options }),
    status: (options = {}) => runStatus({ repoRoot, env, ...options }),
    audit: (options = {}) => runAudit({ repoRoot, env, ...options }),
    evidence: (options = {}) => runEvidence({ repoRoot, ...options }),
    doctor: (options = {}) => runDoctor({ repoRoot, env, ...options }),
    sessions: (options = {}) => runSessions({ repoRoot, ...options }),
    continueLatest: (options = {}) => continueLatestRun({ repoRoot, ...options }),
    rollbackLatest: (options = {}) => rollbackLatestRun({ repoRoot, ...options }),
  };
}

function enabledFlag(argv = [], name) {
  for (const item of argv) {
    if (item === name) return true;
    if (String(item).startsWith(`${name}=`)) {
      return !["0", "false", "no", "off"].includes(String(item).slice(name.length + 1).toLowerCase());
    }
  }
  return false;
}
