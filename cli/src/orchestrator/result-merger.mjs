import { publicModelList } from "../runtime/redaction.mjs";
import { publicOutputKeys } from "../runtime/subagent-output-policy.mjs";

export function mergeSubagentResult(result) {
  return {
    adopted: false,
    requiresMainReview: true,
    result,
  };
}

export function summarizeMerge(result) {
  return {
    adopted: false,
    requiresMainReview: true,
    provider: result?.agent?.provider,
    profile: result?.agent?.profile,
    model: result?.output?.model,
    outputKeys: publicOutputKeys(result?.output || {}),
    outputPolicy: result?.outputPolicy,
    providerSession: result?.output?.providerSession,
    unverified: publicModelList(result?.output?.unverified),
  };
}

export async function adoptPatchProposal({ result, dispatcher, actor = { kind: "main", id: "main" } }) {
  const proposal = result?.output?.patchProposal;
  const edits = proposal?.patch?.edits || [];
  if (!proposal || !Array.isArray(edits) || edits.length === 0) {
    return {
      adopted: false,
      reason: "No patch edits to adopt.",
      results: [],
    };
  }

  const results = [];
  for (const edit of edits) {
    results.push(
      await dispatcher.dispatch({
        actor,
        type: "write",
        path: edit.path,
        content: edit.content,
      }),
    );
  }

  return {
    adopted: results.every((item) => item.ok),
    results,
  };
}
