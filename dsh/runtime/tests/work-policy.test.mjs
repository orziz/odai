import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkPolicy } from "../build/work-policy.mjs";
const goal =
  "Use goal tools for one long-running completion objective in the current session. create_goal may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work. Call get_goal before update_goal and copy its exact goal_id and revision. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds.";
const todoHead =
  "Send the ENTIRE list every call. Use it to plan multi-step work and show progress: add one todo per concrete step before you start. ";
const todoTail =
  "Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete. Statuses: pending, in_progress, completed.";
const ralph =
  "Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.";
test("optional work tools agree without weakening actual schemas, authority or todo concurrency", () => {
  for (const active of [
    "Mark active work `in_progress`; while work remains, at least one task should be `in_progress`. ",
    "Keep AT MOST ONE todo `in_progress` at a time; while work remains, exactly one active task should be `in_progress`. ",
  ]) {
    const parameters = { type: "object", properties: { objective: { type: "string" } } };
    const original = {
      sections: [
        { name: "tool:goal", text: goal },
        { name: "sandbox", text: "Require permission for protected writes." },
        { name: "tool:ralph", text: ralph },
      ],
      tools: [
        { name: "create_goal", description: "Infer a goal", parameters },
        { name: "todo_write", description: todoHead + active + todoTail },
        { name: "update_goal", description: "Direct-human authority is required for edit, pause and resume." },
        { name: "read", description: "Read a file." },
        {
          name: "ralph",
          description:
            "Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Ordinary long-running same-session work belongs to goal tools.",
        },
      ],
    };
    const result = applyWorkPolicy(original);
    assert.doesNotMatch(result.sections[0].text, /may infer|in any wording or language/);
    assert.match(result.sections[0].text, /human explicitly requests/);
    assert.match(result.sections[0].text, /copy its exact goal_id and revision/);
    assert.match(result.sections[0].text, /at least 3 consecutive goal rounds/);
    assert.match(result.tools[0].description, /human explicitly requests/);
    assert.equal(result.tools[0].parameters, parameters);
    assert.doesNotMatch(
      result.tools[1].description,
      /add one todo per concrete step|do not batch completions|while work remains/,
    );
    assert.match(result.tools[1].description, /ENTIRE list/);
    assert.match(result.tools[1].description, /completed items may be reported together/);
    if (active.includes("AT MOST ONE")) assert.match(result.tools[1].description, /AT MOST ONE/);
    assert.equal(result.tools[2], original.tools[2]);
    assert.equal(result.tools[3], original.tools[3]);
    assert.equal(result.sections[1], original.sections[1]);
    assert.match(result.tools[4].description, /explicitly asks for Ralph/);
    assert.doesNotMatch(result.tools[4].description, /belongs to goal tools/);
    assert.doesNotMatch(result.sections[2].text, /Use same-session goal tools/);
    assert.equal(original.sections[0].text, goal);
    assert.deepEqual(applyWorkPolicy(result), result);
  }
});
test("missing tools and descriptions remain valid", () => {
  assert.deepEqual(applyWorkPolicy({ sections: [], tools: [] }), { sections: [], tools: [] });
  const tool = { name: "todo_write" };
  assert.equal(applyWorkPolicy({ sections: [], tools: [tool] }).tools[0], tool);
});
