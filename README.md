<!-- Language toggle -->
**English** · [中文](README.zh-CN.md)

# odai

`odai` is a single governance entry point for AI agent work.

It does not try to reteach a model how to reason, search, read, code, or summarize. Instead, it defines the parts an agent should not quietly decide alone: real intent, boundaries, authorization, acceptance, evidence, handoffs, agent delegation, and stop conditions.

The short version: you call `/odai`; simple work stays simple, and ambiguous or high-impact work is routed through `道` ("the Way") before the agent acts.

## Why Use It

`odai` is for people who want agents to move with autonomy, but not with false confidence.

It helps an agent:

- ask only when the missing answer would change the goal, scope, authorization, acceptance, risk, or stop line
- verify what it can verify from files, commands, logs, tests, or project context before asking you
- keep lightweight tasks lightweight instead of turning every request into ceremony
- avoid claiming that something was tested, delegated, reviewed, or verified when it was not
- load specialist guidance only when the task needs it, instead of stuffing every rule into every turn

## Validated Operating Envelope

As of 2026-07-12, the frozen skill version has the following 40-case behavioral Canary results:

| Runner | Judge | Result | Interpretation |
|---|---|---:|---|
| GPT-5.5 / medium | GPT-5.6 Sol / high | 40/40, 0 unresolved | Validated configuration, including four English-only governance-transfer cases |
| GPT-5.4 Mini / low | GPT-5.5 / high | 25/40, 0 unresolved | Handles lightweight and explicit tasks, but is not a full-governance guarantee tier |

These are observed configurations, not model-brand rankings or guarantees for untested hosts. Weaker models can still miss stop gates, evidence rescans, acceptance fields, or agent-handoff constraints. Use a model and reasoning tier comparable to the validated configuration when full governance reliability matters.

## 30-Second Start

Install the unified entry point:

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

Then invoke it with `/odai`. That is the normal form in clients that expose skills as slash commands:

```text
/odai update the onboarding flow copy.
Goal: make it clearer for first-time users.
Materials: current app files and README.
Constraints: do not change behavior yet; give me the proposed copy and risks first.
```

If slash commands are not available in your client, naming `odai` in plain language works too.

You do not need to know the internal modules. If the route is obvious, `odai` goes straight there. If the task is vague, cross-domain, risky, or user-facing, `道` aligns the direction, boundary, acceptance standard, and next step first.

## How It Decides

`odai` has one public door and several internal routes:

- **Lightweight**: read, explain, summarize, inspect, run an existing command, or make a tiny named text edit when the object and verification are obvious.
- **Direct**: go straight to a named or clearly implied module, such as code review, README work, implementation, game planning, or daily-report cleanup.
- **Dao-led**: use `道` when the task is ambiguous, multi-step, risky, user-visible, or likely to need scope and acceptance alignment.
- **Enhanced**: use stricter challenge, agent governance, or consensus rules when the user asks for multi-agent / multi-model work, or when a decision is expensive to reverse.

The point is not to slow the agent down. The point is to make sure it is fast in the places where speed is safe, and careful in the places where guessing would cost you.

## Architecture Logic

```text
                         user task
                            |
                            v
       +--------------------------------------------+
       | /odai -> SKILL.md                         |
       | entry routing, truth gates, scope gates     |
       +--------------------+-----------------------+
            direct / light  | ambiguous / risky / cross-domain
       +--------------------+-----------------------+
       |                                            |
       v                                            v
  +------------------+                 +-------------------------+
  | named module     |                 | dao / 道 orchestrator   |
  | or light action  |                 | why -> how -> do        |
  +---------+--------+                 +-----------+-------------+
            |                                      |
            |                                      v
            |                         +--------------------------+
            |                         | specialist module chain  |
            |                         | plan / design / code /   |
            |                         | review / game / summary  |
            |                         +-----------+--------------+
            |                                      |
            +----------------------+---------------+
                                   v
                         result, evidence,
                         verified gap, or blocker

Support files are loaded only when needed:
interaction contract, diagnosis, result reporting,
agent governance, challenge / consensus rules,
and domain playbooks.
```

The important part is the split before action: if the task is already bounded, `odai` can move directly; if the task needs intent, scope, acceptance, risk, or authorization alignment, `道` sets the track first and then hands work to the right producer modules.

## Module Map

These are internal modules. You can name them directly, but you usually do not have to.

| Module | Use it for |
| --- | --- |
| `dao` / `道` | Default orchestration, direction, boundaries, route choice, cross-stage handoff |
| `feature-plan` | Specs, tradeoffs, feature planning, bug diagnosis |
| `design-spec` | Product flows, pages, states, interaction, UX acceptance |
| `implement-code` | Code changes, bug fixes, tests, refactors after scope is clear |
| `review-sslb` | Structured code review |
| `project-guide` | READMEs, project rules, AI handoff baselines |
| `game-plan` | Game systems, mechanics, numbers, economy, levels, liveops |
| `game-design` | Game visuals, UI/UX/UE, characters, scenes, branding, FX |
| `ribao` | Daily reports, commit messages, PR messages |

## Good Prompts

Use the level of detail you actually have:

```text
/odai handle this. Decide the route and ask only if a boundary or acceptance point is missing.
```

```text
/odai review-sslb review the current diff.
```

```text
/odai project-guide refresh this repository README. Remove outdated screenshots and keep the install path clear.
```

```text
/odai start with 道. The task is user-facing and I care about not changing behavior without approval.
```

## Install Options

Most users only need the unified entry point:

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

Other supported installs:

```bash
# Install every skill in this repository
npx skills add https://github.com/orziz/odai

# Install the slimmer branch
npx skills add https://github.com/orziz/odai#mini

# Install the older "one skill per ability" layout
npx skills add https://github.com/orziz/odai#old
```

Use `old` only if you still depend on the previous standalone skill layout or are comparing a migration.

Canonical source lives in `skills/`. Distribution is handled through the [skills.sh](https://skills.sh) install flow; this repository no longer keeps per-platform mirror outputs. Maintainer notes live in [MAINTAINING.md](MAINTAINING.md).

## Credits

Some naming, structure, and workflow ideas were inspired by:

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)

Stars and PRs are welcome.
