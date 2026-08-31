import { classifyImplementationAuthorization, decideRoute, extractLatestUserText } from "./router.mjs";
import { ROUTING_CONFIG_PROMPT, effectiveRoutingSnapshot } from "./routing-config.mjs";
import {
  DEFAULT_OUTPUT_POLICY,
  classifySessionOutputCeilingDirective,
  effectiveOutputPolicy,
  renderOutputPolicyPrompt,
} from "./output-config.mjs";
import type { OutputPolicy } from "./output-config.mjs";
import { selectSharedOutputPolicyForTurn } from "./output-policy-state.mjs";
import {
  applySessionOutputControl,
  prepareSessionOutputControl,
  renderSessionOutputControlPrompt,
} from "./output-session.mjs";
import { COMPACTION_CONFIG_PROMPT } from "./compaction-config.mjs";
import { RESPONSIBILITY_GAP_PROMPT } from "./responsibility-gap.mjs";
import type { ResponsibilityGapProposal } from "./responsibility-gap.mjs";
import { classifyContextActivation } from "./context-activation.mjs";
import type { ContextActivation } from "./context-activation.mjs";
import { activateRequestedCapabilities, requestedContextCapabilities } from "./context-capability.mjs";
import { latestDanglingResponsibilityScope } from "./responsibility-scope.mjs";
import {
  HUMAN_SAFETY_CONTINUITY_PROMPT,
  renderHumanSafetyContinuitySection,
} from "./human-safety-continuity.mjs";
import { readHumanSafetyContinuityStore } from "./human-safety-continuity-store.mjs";
import { SKILL_SOURCE_CONFIG_PROMPT, effectiveSkillSource } from "./skill-source-config.mjs";
import { ODAI_RUNTIME_CONTRACT, loadSkillBundle } from "./skill-bundle.mjs";
import { resolveSkillSelection } from "./skill-selector.mjs";
import { currentAgentTurn, selectSharedSkillForTurn } from "./skill-selection-state.mjs";
import { applySkillEvolutionSelection, skillEvolutionDisabled } from "./skill-evolution.mjs";
import { MEMORY_PROMPT, latestDirectUserMessage } from "./semantic-memory.mjs";
import { effectiveMemorySettings } from "./semantic-memory-store.mjs";
import { resolveSkillPath } from "./runtime-config.mjs";
import {
  canonicalPrompt,
  currentAgentStep,
  isSubagentSession,
  reconcileAdaptiveToolSchemas,
  renderEffectiveRoutingContext,
} from "./runtime-support.mjs";
import type {
  RoutingSnapshotState,
  SkillSelection,
} from "./runtime-support.mjs";
import type {
  DshAgent,
  DshEvent,
  DshRuntimeContext,
  PromptAssembly,
  RuntimeConfig,
  RuntimeEventData,
  RuntimeLogger,
  SkillRegistry,
} from "./runtime-types.mjs";

interface PromptContext {
  agent?: DshAgent;
  scope?: unknown;
  signal?: AbortSignal;
}

interface OutputSelection {
  policy: OutputPolicy;
  source: string;
  status?: string;
  reasonCode?: string;
  sessionCeiling?: "uncapped" | "recovery";
}

interface MemorySettings {
  mode: "auto" | "off";
  source: string;
}

interface PromptDependencies {
  appendEvent(agent: DshAgent, type: string, data: object): void;
  config: RuntimeConfig;
  ctx: DshRuntimeContext;
  evidence: { events(agent: DshAgent): DshEvent[] };
  hasSessionEvent(
    agent: DshAgent,
    type: string,
    predicate: (data: RuntimeEventData) => boolean,
  ): boolean;
  humanSafetyContinuityStorePath: string;
  logger: RuntimeLogger;
}

function isSkillRegistry(value: unknown): value is SkillRegistry {
  return value !== null && typeof value === "object" && "get" in value && typeof value.get === "function";
}

interface PromptInstallDependencies {
  pendingResponsibilityGap(agent: DshAgent, turn: number | undefined, step: number): ResponsibilityGapProposal | undefined;
  syncToolExposure(
    agent: DshAgent,
    activation: ContextActivation,
    options: { turn?: number; step: number; responsibilityReturn: boolean },
  ): readonly string[];
}

export function createPromptRuntime(deps: PromptDependencies) {
  const {
    appendEvent,
    config,
    ctx,
    evidence,
    hasSessionEvent,
    humanSafetyContinuityStorePath,
    logger,
  } = deps;
  const skillPath = resolveSkillPath(config.skillPath);
  const explicitSkillPath = config.skillPath !== undefined
    || (typeof process.env.ODAI_SKILL_PATH === "string" && process.env.ODAI_SKILL_PATH.trim() !== "");
  const bundled = loadSkillBundle(skillPath, {
    source: explicitSkillPath ? "path" : "bundled",
    provider: explicitSkillPath ? "odai-explicit-path" : "odai-dsh-runtime",
  });
  if (bundled.manifest.runtimeContract !== ODAI_RUNTIME_CONTRACT) {
    throw new Error(`Odai canonical runtimeContract ${bundled.manifest.runtimeContract} is incompatible with this runtime`);
  }
  const baseSelection: Readonly<SkillSelection> = Object.freeze({
    mode: explicitSkillPath ? "path" : "bundled",
    status: "selected",
    reasonCode: explicitSkillPath ? "explicit-path" : "bundled-configured",
    bundle: bundled,
    rejections: Object.freeze([]),
  });
  const evolutionDisabled = explicitSkillPath || skillEvolutionDisabled();

  ctx.systemPrompt.section({
    name: "odai:canonical-governance",
    order: -20,
    text: canonicalPrompt(baseSelection),
  });
  ctx.systemPrompt.section({
    name: "odai:canonical-craft",
    order: -19.5,
    text: "",
  });
  ctx.systemPrompt.section({
    name: "odai:routing-configuration",
    order: -19,
    text: ROUTING_CONFIG_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:human-safety-continuity",
    order: -18.875,
    text: HUMAN_SAFETY_CONTINUITY_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:responsibility-gap",
    order: -18.75,
    text: RESPONSIBILITY_GAP_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:skill-source-configuration",
    order: -18,
    text: SKILL_SOURCE_CONFIG_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:controller-output-policy",
    order: -17,
    text: "",
  });
  ctx.systemPrompt.section({
    name: "odai:compaction-model-configuration",
    order: -16,
    text: COMPACTION_CONFIG_PROMPT,
  });
  ctx.systemPrompt.section({
    name: "odai:semantic-memory",
    order: -15,
    text: MEMORY_PROMPT,
  });

  const optionalSkillRegistry = (): SkillRegistry | undefined => {
    try {
      if (ctx.skills && typeof ctx.skills.get === "function") return ctx.skills;
    } catch {}
    try {
      const service = typeof ctx.get === "function" ? ctx.get("skills") : undefined;
      return isSkillRegistry(service) ? service : undefined;
    } catch {
      return undefined;
    }
  };
  const selectUpstreamForAgent = async (agent: DshAgent, context: PromptContext): Promise<SkillSelection> => {
    if (explicitSkillPath) return baseSelection;
    let mode;
    try {
      mode = effectiveSkillSource(config.governance.skillConfigPath, config.governance.skillSource);
    } catch (error) {
      return Object.freeze({
        ...baseSelection,
        mode: "bundled",
        status: "fallback",
        reasonCode: "source-config-invalid",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return await resolveSkillSelection({
      mode,
      bundled,
      cwd: agent.session?.header?.cwd,
      scope: context.scope,
      signal: context.signal,
      skills: optionalSkillRegistry(),
    });
  };
  const selectForAgent = async (agent: DshAgent, context: PromptContext): Promise<SkillSelection> => {
    const upstream = await selectUpstreamForAgent(agent, context);
    return applySkillEvolutionSelection(upstream, config.governance.evolutionRoot, { disabled: evolutionDisabled });
  };
  const selectOutputForAgent = (agent?: DshAgent, turn = agent ? currentAgentTurn(agent) : undefined): OutputSelection => {
    let selection: OutputSelection;
    try {
      selection = effectiveOutputPolicy(config.output.configPath);
    } catch (error) {
      logger.warn(`Odai output configuration is invalid; using the default policy: ${error instanceof Error ? error.message : String(error)}`);
      selection = Object.freeze({
        policy: DEFAULT_OUTPUT_POLICY,
        source: "default",
        status: "fallback",
        reasonCode: "output-config-invalid",
      });
    }
    return agent ? applySessionOutputControl(selection, evidence.events(agent), turn) : selection;
  };
  const memorySettingsSnapshots = new WeakMap<DshAgent, { turn?: number; settings: MemorySettings }>();
  const memorySettingsFor = (agent: DshAgent, turn = currentAgentTurn(agent)): MemorySettings => {
    const cached = memorySettingsSnapshots.get(agent);
    if (cached && cached.turn === turn) return cached.settings;
    let settings;
    try {
      settings = effectiveMemorySettings(config.memory.storePath, { mode: config.memory.mode }) as MemorySettings;
    } catch (error) {
      logger.warn(`Odai semantic memory is unavailable; capture and retrieval are disabled for this turn: ${error instanceof Error ? error.message : String(error)}`);
      settings = Object.freeze({ mode: "off", source: "invalid-store" });
    }
    memorySettingsSnapshots.set(agent, { turn, settings });
    return settings;
  };
  const contextActivationFor = (agent: DshAgent, text: string, turn = currentAgentTurn(agent)): ContextActivation => activateRequestedCapabilities(
    classifyContextActivation(text),
    requestedContextCapabilities(evidence.events(agent), turn),
  ) as ContextActivation;
  const routingSnapshots = new WeakMap<DshAgent, { turn?: number; state: RoutingSnapshotState }>();
  const routingSnapshotFor = (agent: DshAgent, turn = currentAgentTurn(agent)): RoutingSnapshotState => {
    const cached = routingSnapshots.get(agent);
    if (cached && cached.turn === turn) return cached.state;
    let state;
    try {
      state = Object.freeze({
        snapshot: effectiveRoutingSnapshot(config.routing.configPath, config.routing.roles, config.routing.dispatch),
      });
    } catch (error) {
      state = Object.freeze({
        error: "persisted Odai routing configuration failed validation",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    routingSnapshots.set(agent, { turn, state });
    return state;
  };
  const install = ({ pendingResponsibilityGap, syncToolExposure }: PromptInstallDependencies): void => {
  ctx.on("system-prompt/assemble", async (
    assembly: PromptAssembly,
    context: PromptContext,
    next: () => Promise<PromptAssembly>,
  ) => {
    const agent = context.agent;
    if (!agent) return next();
    const turn = currentAgentTurn(agent);
    const childSession = isSubagentSession(agent);
    const directMessage = latestDirectUserMessage(agent);
    const directText = directMessage ? extractLatestUserText([directMessage]) : "";
    const classifiedActivation = contextActivationFor(agent, directText, turn);
    const sessionOutputDirective = classifySessionOutputCeilingDirective(directText);
    const activation = sessionOutputDirective && classifiedActivation.outputConfig
      ? Object.freeze({ ...classifiedActivation, outputConfig: false })
      : classifiedActivation;
    const proposedStep = (currentAgentStep(agent) ?? 0) + 1;
    prepareSessionOutputControl({
      events: evidence.events(agent),
      text: directText,
      turn,
      step: proposedStep,
      userMessageId: typeof directMessage?.id === "string" ? directMessage.id : undefined,
      append(type, data) { appendEvent(agent, type, data); },
    });
    const exposureEvents = evidence.events(agent);
    const pendingGap = pendingResponsibilityGap(agent, turn, proposedStep);
    const routeCandidate = decideRoute({ text: directText, proposal: pendingGap });
    const danglingScope = latestDanglingResponsibilityScope(exposureEvents);
    const pendingReadOnlyRole = pendingGap?.responsibility
      ?? (routeCandidate.action === "upgrade" ? routeCandidate.targetRole : undefined);
    const responsibilityReturnNeeded = !childSession && (
      ["researcher", "planner", "reviewer"].includes(pendingReadOnlyRole ?? "")
      || ["researcher", "planner", "reviewer"].includes(danglingScope?.role ?? "")
    );
    // DSH builds assembly.tools before this middleware runs. Filter that snapshot and the execution registry together.
    const activeToolNames = syncToolExposure(agent, activation, {
      turn,
      step: proposedStep,
      responsibilityReturn: responsibilityReturnNeeded,
    });
    const executableSchemas = typeof ctx.tools.schemas === "function" ? ctx.tools.schemas(agent) : [];
    const visibleAssembly = reconcileAdaptiveToolSchemas(assembly, activeToolNames, executableSchemas);
    if (visibleAssembly !== assembly) assembly.tools = visibleAssembly.tools;

    const downstream = await next();
    const finalExecutableSchemas = typeof ctx.tools.schemas === "function" ? ctx.tools.schemas(agent) : [];
    const reconciledDownstream = reconcileAdaptiveToolSchemas(downstream, activeToolNames, finalExecutableSchemas);
    const selection: SkillSelection = await selectSharedSkillForTurn(agent, () => selectForAgent(agent, context));
    const outputSelection: OutputSelection = childSession
      ? Object.freeze({ policy: DEFAULT_OUTPUT_POLICY, source: "default" })
      : await selectSharedOutputPolicyForTurn(agent, turn, () => selectOutputForAgent(agent, turn));
    const selectionEvidence = {
      ...(turn === undefined ? {} : { turn }),
      requestedMode: selection.mode,
      status: selection.status,
      reasonCode: selection.reasonCode,
      effectiveSource: selection.bundle.source,
      skillVersion: selection.bundle.manifest.skillVersion,
      runtimeContract: selection.bundle.manifest.runtimeContract,
      digest: selection.bundle.digest,
      rejections: selection.rejections.map(({ source, reasonCode }) => ({ source, reasonCode })),
      ...(selection.evolution?.generationId ? {
        evolution: {
          status: selection.evolution.status,
          generationId: selection.evolution.generationId,
          ...(selection.evolution.baseDigest ? { baseDigest: selection.evolution.baseDigest } : {}),
          ...(selection.evolution.upstreamDigest ? { upstreamDigest: selection.evolution.upstreamDigest } : {}),
          ...(selection.evolution.rebaseRequired === undefined ? {} : { rebaseRequired: selection.evolution.rebaseRequired }),
        },
      } : {}),
    };
    if (!hasSessionEvent(agent, "odai/skill-selected", (data) => data?.turn === turn && data?.digest === selection.bundle.digest)) {
      appendEvent(agent, "odai/skill-selected", selectionEvidence);
    }
    if (selection.status === "fallback") {
      logger.warn(`Odai skill source ${selection.mode} fell back to bundled governance (${selection.reasonCode})`);
    }
    const outputPrompt = [
      renderOutputPolicyPrompt(outputSelection.policy),
      renderSessionOutputControlPrompt(outputSelection),
    ].filter(Boolean).join("\n\n");
    const canonicalCraft = selection.bundle.referenceContracts.craft;
    const craftPrompt = !childSession
      && classifyImplementationAuthorization(directText).status === "authorized"
      && typeof canonicalCraft === "string"
      ? `# Canonical craft reference\n\n${canonicalCraft.trim()}`
      : "";
    const routingPrompt = !activation.routingConfig
      ? ""
      : childSession
        ? ROUTING_CONFIG_PROMPT
        : `${ROUTING_CONFIG_PROMPT}\n\n${renderEffectiveRoutingContext(routingSnapshotFor(agent, turn))}`;
    let continuityRecordPrompt;
    if (!childSession && (activation.care || activation.safety || activation.continuity)) {
      try {
        continuityRecordPrompt = renderHumanSafetyContinuitySection(
          readHumanSafetyContinuityStore(humanSafetyContinuityStorePath),
        );
      } catch (error) {
        logger.warn(`Odai human-safety continuity is unavailable for this turn: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const continuityPrompt = [activation.continuity ? HUMAN_SAFETY_CONTINUITY_PROMPT : undefined, continuityRecordPrompt]
      .filter(Boolean)
      .join("\n\n");
    if (outputPrompt && !hasSessionEvent(agent, "odai/output-policy-selected", (data) => data?.turn === turn)) {
      appendEvent(agent, "odai/output-policy-selected", {
        ...(turn === undefined ? {} : { turn }),
        source: outputSelection.source,
        policy: outputSelection.policy,
        ...(outputSelection.sessionCeiling ? { sessionCeiling: outputSelection.sessionCeiling } : {}),
      });
    }
    return {
      ...reconciledDownstream,
      sections: reconciledDownstream.sections.map((section) => {
        if (section.name === "odai:canonical-governance") return { ...section, text: canonicalPrompt(selection) };
        if (section.name === "odai:canonical-craft") return { ...section, text: craftPrompt };
        if (section.name === "odai:routing-configuration") return { ...section, text: routingPrompt };
        if (section.name === "odai:human-safety-continuity") return { ...section, text: continuityPrompt };
        if (section.name === "odai:responsibility-gap") return { ...section, text: childSession ? "" : RESPONSIBILITY_GAP_PROMPT };
        if (section.name === "odai:skill-source-configuration") return { ...section, text: activation.skillSource ? SKILL_SOURCE_CONFIG_PROMPT : "" };
        if (section.name === "odai:controller-output-policy") return { ...section, text: outputPrompt };
        if (section.name === "odai:compaction-model-configuration") return { ...section, text: activation.compactionConfig ? COMPACTION_CONFIG_PROMPT : "" };
        if (section.name === "odai:semantic-memory") return { ...section, text: activation.memory ? MEMORY_PROMPT : "" };
        return section;
      }),
    };
  });

  };
  return {
    baseSelection,
    bundled,
    contextActivationFor,
    evolutionDisabled,
    explicitSkillPath,
    install,
    memorySettingsFor,
    routingSnapshotFor,
    selectForAgent,
    selectOutputForAgent,
    selectUpstreamForAgent,
    skillPath,
  };
}
