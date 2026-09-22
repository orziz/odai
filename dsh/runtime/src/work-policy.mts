import type { PromptAssembly } from "./runtime-types.mjs";

const GOAL_START = "Use goal tools for one long-running completion objective in the current session. create_goal may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work.";
const GOAL_RESUME = "After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it.";
const GOAL_POLICY = "Use persistent goal tools only when the human explicitly requests autonomous continuation across goal rounds. A multi-step task, implementation request, or instruction to keep working does not by itself request a persistent goal; carry out the authorized work directly.";

/** Adapt the pinned host's optional work tools as one policy, not competing defaults.
 * Parameter schemas, actual goal authority, and todo concurrency limits stay host-owned.
 */
export function applyWorkPolicy(assembly: PromptAssembly): PromptAssembly {
  return {
    ...assembly,
    sections: assembly.sections.map((section) => {
      if (section.name === "tool:goal") return {
        ...section,
        text: section.text.replace(GOAL_START, GOAL_POLICY).replace(GOAL_RESUME,
          "After session resume or fork, an active goal is disarmed. Rearm it only when the human explicitly asks to resume that autonomous goal; otherwise continue authorized work without rearming it."),
      };
      if (section.name === "tool:ralph") return {
        ...section,
        text: section.text.replace(
          "Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.",
          "Carry out ordinary work directly. Use delegation only for a bounded independent contribution."),
      };
      return section;
    }),
    // Early assembly hooks can precede the host's tool schema snapshot.
    tools: Array.isArray(assembly.tools) ? assembly.tools.map((tool) => {
      if (tool.name === "create_goal") return {
        ...tool,
        description: "Create one persisted same-session goal only when the direct human explicitly requests autonomous continuation across goal rounds. Do not infer this from task complexity or ordinary implementation authorization. Execution rejects non-human and subagent authority.",
      };
      if (typeof tool.description !== "string") return tool;
      if (tool.name === "ralph") return {
        ...tool,
        description: tool.description.replace(" Ordinary long-running same-session work belongs to goal tools.", ""),
      };
      if (tool.name === "todo_write") return {
        ...tool,
        description: tool.description.replace(
          "Use it to plan multi-step work and show progress: add one todo per concrete step before you start. ",
          "Use it only when a task list helps coordinate or recover the work; multi-step work alone does not require a list. ")
          .replace("; while work remains, at least one task should be `in_progress`.", ".")
          .replace("; while work remains, exactly one active task should be `in_progress`.", ".")
          .replace("Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete.",
            "Update the list on meaningful progress or handoff; completed items may be reported together. Status must reflect actual work, including when nothing is actively running."),
      };
      return tool;
    }) : assembly.tools,
  };
}
