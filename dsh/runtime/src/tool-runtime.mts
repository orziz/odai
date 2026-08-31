import { extractLatestUserText } from "./router.mjs";
import { activeRouteProtection, createChildToolGuard, createRouteProtectionGuard, isSubagent, summarizeToolResult } from "./governance.mjs";
import { createRoutingConfigTool, effectiveRoutingSnapshot } from "./routing-config.mjs";
import { createOutputConfigTool } from "./output-config.mjs";
import type { OutputPolicy } from "./output-config.mjs";
import { createCanonicalReferenceTool } from "./canonical-reference.mjs";
import { createCompactionConfigTool } from "./compaction-config.mjs";
import { ODAI_CORE_TOOL_NAMES, activeOdaiToolNames, inactiveOdaiToolNames } from "./context-activation.mjs";
import type { ContextActivation } from "./context-activation.mjs";
import { createContextCapabilityTool } from "./context-capability.mjs";
import { createHumanCareTool } from "./human-care.mjs";
import { createHumanSafetyTool } from "./human-safety.mjs";
import { createHumanSafetyContinuityTool } from "./human-safety-continuity.mjs";
import { bindResponsibilityGapToTask, createResponsibilityGapTool } from "./responsibility-gap.mjs";
import type { ResponsibilityGapProposal } from "./responsibility-gap.mjs";
import { createResponsibilityReturnTool } from "./responsibility-return.mjs";
import type { ResponsibilityReturnResult } from "./responsibility-return.mjs";
import type { ResponsibilityScope } from "./responsibility-scope.mjs";
import { createSkillSourceConfigTool } from "./skill-source-config.mjs";
import { createSkillEvolutionTool, applySkillEvolutionSelection } from "./skill-evolution.mjs";
import { createSemanticMemoryTool, latestDirectUserMessage } from "./semantic-memory.mjs";
import { readSkillBundleFile } from "./skill-bundle.mjs";
import type { SkillBundle } from "./skill-bundle.mjs";
import { currentAgentTurn, sharedSkillSelection } from "./skill-selection-state.mjs";
import { currentAgentStep, isSubagentSession, latestRouteReceipt } from "./runtime-support.mjs";
import type { SkillSelection } from "./runtime-support.mjs";
import type { DshAgent, DshEvent, DshRuntimeContext, ModelRoute, RuntimeConfig, RuntimeEventData, RuntimeLogger, ToolExecution, ToolResult, UnknownRecord } from "./runtime-types.mjs";

interface RouteProtection extends UnknownRecord { scopeId?: string }
interface ExposureOptions { turn?: number; step?: number; responsibilityReturn?: boolean }
interface PromptInstaller { install(deps: { pendingResponsibilityGap: ToolRuntimeDependencies["pendingResponsibilityGap"]; syncToolExposure: (agent: DshAgent, activation: ContextActivation, options: { turn?: number; step: number; responsibilityReturn: boolean }) => readonly string[] }): void }
interface ToolRuntimeDependencies {
  appendEvent(agent: DshAgent, type: string, data: object): void;
  baseSelection: SkillSelection;
  bundled: SkillBundle;
  config: RuntimeConfig;
  ctx: DshRuntimeContext;
  evidence: { events(agent: DshAgent): DshEvent[] };
  evolutionDisabled: boolean;
  explicitSkillPath: boolean;
  hasSessionEvent(agent: DshAgent, type: string, predicate: (data: RuntimeEventData) => boolean): boolean;
  humanSafetyContinuityStorePath: string;
  logger: RuntimeLogger;
  pendingResponsibilityGap(agent: DshAgent, turn: number | undefined, step: number): ResponsibilityGapProposal | undefined;
  promptRuntime: PromptInstaller;
  responsibilityScopes: WeakMap<DshAgent, ResponsibilityScope>;
  routeProtections: WeakMap<DshAgent, RouteProtection>;
  selectOutputForAgent(): { policy: OutputPolicy };
  stopResponsibilityScope(agent: DshAgent, reason: string, position?: RuntimeEventData): ResponsibilityScope | undefined;
}

export function installToolRuntime(deps: ToolRuntimeDependencies): void {
  const { appendEvent, baseSelection, bundled, config, ctx, evidence, evolutionDisabled, explicitSkillPath, hasSessionEvent, humanSafetyContinuityStorePath, logger, pendingResponsibilityGap, promptRuntime, responsibilityScopes, routeProtections, selectOutputForAgent, stopResponsibilityScope } = deps;
  const onDenied = (execution: ToolExecution & { agent: DshAgent }, reason: string) => {
    appendEvent(execution.agent, "odai/governance-denied", {
      callId: String(execution.callId),
      tool: execution.name,
      reason,
    });
  };
  const childGuard = createChildToolGuard({
    additionalDeniedTools: config.governance.additionalDeniedTools,
    onDenied,
  });
  const routeProtectionGuard = createRouteProtectionGuard({
    additionalDeniedTools: config.governance.additionalDeniedTools,
    onDenied,
    protectionFor(agent: DshAgent) {
      if (config.routing.mode === "off") return undefined;
      return routeProtections.get(agent) ?? activeRouteProtection(agent, evidence.events(agent));
    },
  });
  const gapForCurrentTask = (
    agent: DshAgent,
    proposal: Readonly<ResponsibilityGapProposal>,
  ): Readonly<ResponsibilityGapProposal> => {
    const message = latestDirectUserMessage(agent);
    return message && typeof message.id === "string" && message.id
      ? bindResponsibilityGapToTask(proposal, message.id)
      : proposal;
  };
  const bundleFor = (agent: DshAgent): SkillBundle => sharedSkillSelection<SkillSelection>(agent)?.bundle ?? bundled;
  ctx.tools.register(createContextCapabilityTool({
    isChild: isSubagent,
    onRequested(agent: DshAgent, capability: string) {
      const turn = currentAgentTurn(agent);
      const step = currentAgentStep(agent);
      appendEvent(agent, "odai/context-capability-requested", {
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        capability,
      });
    },
  }));
  ctx.tools.register(createCanonicalReferenceTool({
    bundleFor,
    isUnavailable(agent) {
      return isSubagent(agent) || responsibilityScopes.has(agent);
    },
  }));
  ctx.tools.register(createRoutingConfigTool(config.routing.configPath, {
    configuredRoles: config.routing.roles,
    configuredDispatch: config.routing.dispatch,
    resolveCallConfig(route: ModelRoute, signal?: AbortSignal) {
      return ctx.llm.resolveCallConfig(route, signal);
    },
    latestRouteFor(agent: DshAgent) {
      return latestRouteReceipt(evidence.events(agent));
    },
    outputPolicyFor() {
      return selectOutputForAgent().policy;
    },
    onConfigured(agent, data) {
      appendEvent(agent, "odai/routing-configured", data);
    },
  }));
  ctx.tools.register(createHumanCareTool({
    isChild: isSubagent,
    contractFor(agent: DshAgent) {
      const bundle = bundleFor(agent);
      return readSkillBundleFile(bundle, bundle.manifest.referenceFiles.care).toString("utf8");
    },
  }));
  ctx.tools.register(createHumanSafetyTool({
    isChild: isSubagent,
    contractFor(agent: DshAgent) {
      const bundle = bundleFor(agent);
      return readSkillBundleFile(bundle, bundle.manifest.referenceFiles["human-safety"]).toString("utf8");
    },
  }));
  ctx.tools.register(createResponsibilityGapTool({
    isChild: isSubagent,
    bindToTask: gapForCurrentTask,
    onProposed(agent: DshAgent, proposal: RuntimeEventData) {
      const turn = currentAgentTurn(agent);
      const step = currentAgentStep(agent);
      appendEvent(agent, "odai/responsibility-gap", {
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        ...proposal,
      });
    },
  }));
  ctx.tools.register(createResponsibilityReturnTool({
    activeScopeFor(agent) {
      return responsibilityScopes.get(agent);
    },
    onReturned(agent, result: ResponsibilityReturnResult) {
      const turn = currentAgentTurn(agent);
      const step = currentAgentStep(agent);
      const stopped = stopResponsibilityScope(agent, "responsibility-returned", {
        ...(step === undefined ? {} : { step }),
        scopeId: result.scopeId,
      });
      if (!stopped) throw new Error(`responsibility scope ${result.scopeId} is no longer active`);
      appendEvent(agent, "odai/responsibility-returned", {
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        ...result,
      });
    },
  }));
  ctx.tools.register(createSkillSourceConfigTool(
    config.governance.skillConfigPath,
    config.governance.skillSource,
    {
      explicitPath: explicitSkillPath,
      onConfigured(agent, data) {
        appendEvent(agent, "odai/skill-source-configured", data);
      },
    },
  ));
  ctx.tools.register(createSkillEvolutionTool(config.governance.evolutionRoot, {
    disabled: evolutionDisabled,
    currentSelectionFor(agent: DshAgent) {
      return sharedSkillSelection(agent)
        ?? applySkillEvolutionSelection(baseSelection, config.governance.evolutionRoot, { disabled: evolutionDisabled });
    },
    onChanged(agent, data) {
      appendEvent(agent, `odai/evolution-${data.action}`, data);
    },
  }));
  ctx.tools.register(createOutputConfigTool(config.output.configPath, {
    isChild: isSubagent,
    responsibilityRoutesFor() {
      try {
        return effectiveRoutingSnapshot(config.routing.configPath, config.routing.roles, config.routing.dispatch).roles;
      } catch {
        return undefined;
      }
    },
    onConfigured(agent, data) {
      appendEvent(agent, "odai/output-configured", data);
    },
  }));
  ctx.tools.register(createCompactionConfigTool(config.compaction.configPath, {
    isChild: isSubagent,
    resolveCallConfig(route: ModelRoute, signal?: AbortSignal) {
      return ctx.llm.resolveCallConfig(route, signal);
    },
    onConfigured(agent, data) {
      appendEvent(agent, "odai/compaction-configured", data);
    },
  }));
  ctx.tools.register(createSemanticMemoryTool(config.memory.storePath, {
    configuredMode: config.memory.mode,
    onChanged(agent, data) {
      appendEvent(agent, "odai/memory-changed", data);
    },
  }));
  ctx.tools.register(createHumanSafetyContinuityTool({
    storePath: humanSafetyContinuityStorePath,
    directUserTextFor(agent: DshAgent) {
      const message = latestDirectUserMessage(agent);
      return message ? extractLatestUserText([message]) : "";
    },
    onChanged(agent, data) {
      appendEvent(agent, "odai/human-safety-continuity-changed", data);
    },
  }));
  ctx.tools.guard?.((execution: ToolExecution) => childGuard(execution) ?? routeProtectionGuard(execution));

  const toolExposureStates = new WeakMap<DshAgent, { readonly key: string; readonly dispose?: () => void }>();
  const syncToolExposure = (
    agent: DshAgent,
    activation: ContextActivation,
    options: ExposureOptions = {},
  ): readonly string[] => {
    const child = isSubagentSession(agent);
    const activeNames = activeOdaiToolNames(activation, {
      child,
      responsibilityReturn: options.responsibilityReturn === true,
    });
    const deniedNames = [
      ...inactiveOdaiToolNames(activeNames),
      ...ODAI_CORE_TOOL_NAMES.filter((name) => !activeNames.includes(name)),
    ];
    const key = deniedNames.join("\u0000");
    const previous = toolExposureStates.get(agent);
    if (previous?.key === key || previous?.key === "unsupported" || previous?.key === "fallback") return activeNames;
    previous?.dispose?.();
    const agentTools = agent.ctx?.tools;
    const restrict = agentTools?.restrict;
    if (typeof restrict !== "function") {
      toolExposureStates.set(agent, Object.freeze({ key: "unsupported", dispose: undefined }));
      return activeNames;
    }
    try {
      const restriction = deniedNames.length > 0
        ? restrict.call(agentTools, { deny: deniedNames })
        : undefined;
      const dispose = typeof restriction === "function" ? restriction : undefined;
      toolExposureStates.set(agent, Object.freeze({ key, dispose }));
      appendEvent(agent, "odai/tool-exposure-selected", {
        ...(options.turn === undefined ? {} : { turn: options.turn }),
        ...(options.step === undefined ? {} : { step: options.step }),
        mode: "adaptive",
        activeTools: activeNames,
      });
    } catch (error) {
      logger.warn(`Odai adaptive execution restriction is unavailable; prompt schemas remain limited while the executable catalog stays complete: ${error instanceof Error ? error.message : String(error)}`);
      toolExposureStates.set(agent, Object.freeze({ key: "fallback", dispose: undefined }));
    }
    return activeNames;
  };

  promptRuntime.install({ pendingResponsibilityGap, syncToolExposure });

  ctx.on("tools/result", (execution: ToolExecution, result: ToolResult) => {
    if (!execution.agent) return;
    const summary = summarizeToolResult(execution, result);
    if (hasSessionEvent(execution.agent, "odai/tool-observed", (data) => data?.callId === summary.callId)) return;
    appendEvent(execution.agent, "odai/tool-observed", summary);
  });


}
