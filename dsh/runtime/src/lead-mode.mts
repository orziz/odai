import { resolveResponsibilityGap } from "./responsibility-gap.mjs";
import type { DshEvent } from "./runtime-types.mjs";

import { recognizeLeadSwitch as recognizeMappedLeadSwitch } from "#odai-recognize-routing";
export function recognizeLeadSwitch(...args: Parameters<typeof recognizeMappedLeadSwitch>) {
  const direct = recognizeMappedLeadSwitch(args[0], {});
  if (direct?.issue && direct.issue !== "mapping-mismatch") return { enabled: true, roles: ["planner", "reviewer"] };
  return recognizeMappedLeadSwitch(...args);
}
export const leadState = (events: readonly DshEvent[]) => events.findLast(event => event.type === "odai/lead-mode")?.data;
export function leadTaskId(events: readonly DshEvent[], messageId: string | undefined, continuing: boolean): string | undefined {
  return continuing ? (events.findLast(event => event.type === "odai/lead-task")?.data.taskMessageId as string | undefined) ?? messageId : messageId;
}
// DSH's public tool contract exposes no reliable per-call mutation classification.
// Known inspection, safety, and clarification tools are non-writes; arbitrary commands and unknown tools are conservative writes.
const LEAD_NON_WRITE_TOOLS = new Set([
  "read", "glob", "grep", "web_search", "web_fetch", "read_image", "job_output", "job_list",
  "list_agents", "working_directory", "ask_user_question", "get_goal", "skill",
  "odai_context_capability", "odai_human_care", "odai_human_safety",
  "odai_responsibility_gap", "odai_responsibility_return", "odai_review_evidence", "odai_reference",
]);
export function isLeadWriteTool(name: string): boolean {
  return !LEAD_NON_WRITE_TOOLS.has(name);
}
export function leadGap(role: "planner" | "reviewer", taskMessageId: string, turn: number | undefined, step: number, round = 0) {
  const proposal = resolveResponsibilityGap({ responsibility: role, gap: role === "planner" ? "主导模式：第一次写入前规划" : "主导模式：验收本任务的写入", evidenceRefs: [`user-message:${taskMessageId}`], expectedChange: "回交判断；失败时如实说明，不重试或替换模型" });
  return { ...proposal, stateDigest: `user-named:lead-mode:${taskMessageId}:${role}:${round}`, source: "lead-mode", userNamed: true, timing: role === "planner" ? "start" : "completion", taskMessageId, turn, step: step - 1, round };
}
export { parseLeadVerdict } from "#odai-recognize-routing";
