import { dispatchModelToolIntents } from "../runtime/model-tool-intents.mjs";
import { withProviderModelOverride } from "./provider-model.mjs";
import {
  normalizeProviderSession,
  prepareProviderInput,
  sanitizeProviderRuntimeValue,
} from "../runtime/provider-session.mjs";
import { providerToolResult } from "../runtime/redaction.mjs";
import { summarizeSubagentOutputPolicy } from "../runtime/subagent-output-policy.mjs";

export class Scheduler {
  constructor({ providers, agentProfiles, dispatcher, evidence, usageLedger }) {
    this.providers = providers;
    this.agentProfiles = agentProfiles;
    this.dispatcher = dispatcher;
    this.evidence = evidence;
    this.usageLedger = usageLedger;
  }

  async runSubagent({ profileName, providerName, input, excludeProviderNames = [], modelOverride }) {
    const profile = this.agentProfiles.get(profileName);
    if (!profile) {
      throw new Error(`Agent profile not found: ${profileName}`);
    }

    const provider = selectSubagentProvider({
      providers: this.providers,
      profile,
      providerName,
      excludeProviderNames,
      modelOverride,
    });

    if (!provider) {
      throw new Error(`No provider satisfies profile: ${profileName}`);
    }
    if (provider.available === false) {
      const reason = provider.blockedReason ? ` (${provider.blockedReason})` : "";
      throw new Error(`Provider is not available: ${provider.name}${reason}`);
    }

    const agent = {
      id: `${profile.name}:${provider.name}:${Date.now()}`,
      profile: profile.name,
      provider: provider.name,
      tools: profile.tools,
    };

    const providerInput = prepareProviderInput({
      input,
      provider,
      workspaceRoot: this.dispatcher?.workspaceRoot,
    });
    const runProvider = () =>
      provider.run({
        agent,
        profile,
        input: providerInput,
        tools: createSubagentTools({ profile, dispatcher: this.dispatcher, agent }),
      });
    const output = this.usageLedger
      ? (await this.usageLedger.trackProviderCall({
          provider,
          agent,
          profile,
          mode: "subagent",
          run: runProvider,
        })).output
      : await runProvider();
    if (output && typeof output === "object") {
      output.providerSession = normalizeProviderSession(output.providerSession, {
        provider: provider.name,
        providerKind: provider.kind,
        model: output.model,
      });
    }
    const toolIntentDispatch = await dispatchModelToolIntents({
      output,
      dispatcher: this.dispatcher,
      actor: { kind: "subagent", id: agent.id },
    });
    const toolIntentResults = toolIntentDispatch.results;
    if (toolIntentResults.length > 0) {
      output.toolIntentResults = toolIntentResults;
      if (toolIntentDispatch.overflow) {
        output.toolIntentOverflow = toolIntentDispatch.overflow;
      }
    }

    const event = {
      agent,
      output,
      outputPolicy: summarizeSubagentOutputPolicy({ output, profile }),
      adopted: false,
    };
    this.evidence.recordSubagent(event);
    return event;
  }
}

export function selectSubagentProvider({
  providers,
  profile,
  providerName,
  excludeProviderNames = [],
  modelOverride,
} = {}) {
  if (providerName && providerName !== "auto") {
    return withProviderModelOverride(providers.get(providerName), modelOverride);
  }

  if (providerName === "auto" || !providerName) {
    const excluded = new Set(excludeProviderNames);
    const candidates = providers
      .list()
      .filter((provider) =>
        (profile.providerRequirements || []).every((capability) => provider.capabilities.includes(capability)),
      )
      .filter((provider) => !excluded.has(provider.name));
    const available = candidates.map((provider) => withProviderModelOverride(provider, modelOverride))
      .filter((provider) => provider.available !== false);
    const nonMockAvailable = available.filter((provider) => provider.kind !== "mock");
    if (nonMockAvailable.length > 1) {
      throw new Error(
        `Subagent provider auto selection is ambiguous for profile '${profile.name}': ${nonMockAvailable.map((provider) => provider.name).join(", ")}. Use --subagent ${profile.name}:<provider> to choose explicitly.`,
      );
    }
    return nonMockAvailable[0] || available[0] || candidates[0];
  }

  return undefined;
}

function createSubagentTools({ profile, dispatcher, agent }) {
  if (profile.tools === "none") {
    return {};
  }

  if (profile.tools === "read_only") {
    return {
      read: async (filePath) => {
        const result = await dispatcher.dispatch({
          actor: { kind: "subagent", id: agent.id },
          type: "read",
          path: filePath,
        });
        return sanitizeProviderRuntimeValue(providerToolResult(result), {
          workspaceRoot: dispatcher?.workspaceRoot,
        });
      },
    };
  }

  if (profile.tools === "virtual_patch_only") {
    return {
      proposePatch: (patch) => ({
        ok: true,
        type: "patch-proposal",
        patch,
      }),
    };
  }

  return {};
}
