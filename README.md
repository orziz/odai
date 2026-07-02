<!-- Language toggle -->
**English** · [中文](README.zh-CN.md)

# odai

`odai` is a single governance entry point for AI agent work. It does not try to teach the model generic reasoning, searching, reading, coding, or summarizing again; it defines the parts an agent should not decide alone: real intent, boundaries, authorization, acceptance, handoffs, evidence, and stopping conditions.

Inside, `道` ("the Way") acts as the orchestrator. It aligns the goal and risk, chooses the module chain when needed, lets simple tasks move quickly, and asks only when a missing decision would change the path, scope, authorization, acceptance, risk, or stop line.

- **Just want to get stuff done?** One entry point: `odai`.
- **Maintaining this repo?** There's a separate `skill-author` tool. See [MAINTAINING.md](MAINTAINING.md).

> The `main` branch ships this unified entry point. If you prefer the older "one skill per ability" layout, install the `old` branch (see [Install](#install)).

## 30-second start

1. Drop `odai` into your environment:

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

(Want the whole repo, the slim version, or the old layout? See [Install](#install).)

2. Hand your task straight to `odai`. In your first message, try to include three things: **the goal** (what you want), **the materials** (what you've got), and **the constraints** (what's off-limits, what's required). Not sure which module fits? Don't worry — `道` figures that out first.

3. Already know the route you want? Just name it:

- "Use `odai` for this — decide which module fits, ask me if you're unsure."
- "Use `odai` with `道` — pin down the boundaries and the main path first."
- "Use `odai` to take this all the way to a wrap-up — `道` routes it and won't stop half-done."
- "Use `odai` with `review-sslb` to review this PR."
- "Use `odai` with `ribao` to tidy up today's output."

## What is this, really

Think of `odai` as a governance layer over strong models and agents:

- **One door in.** User tasks enter through `odai`; direct, lightweight tasks stay light, and ambiguous or cross-domain work goes through `道`.
- **Hard lines where autonomy is risky.** The skill guards intent alignment, scope, authorization, acceptance, truthfulness, handoffs, and evidence.
- **Focused modules behind it.** Planning, design, review, coding, game design, game visuals, summaries, and project guidance are loaded only when the task actually needs them.
- **Agents stay subordinate.** Sub-agents can generate candidates, evidence, reviews, or frozen-scope work; the main flow verifies and adopts only what can be checked.

A few things worth knowing up front:

- For actual work, there's just one entry point: `odai`. Maintaining the repo uses a separate tool, `skill-author`.
- Distribution goes through the [skills.sh](https://skills.sh) standard (`npx skills add`). The canonical source lives under `skills/` — there are no per-platform mirror copies anymore.
- The old "many skills side by side" layout moved to the `old` branch; install it separately if you still need it.

## Who it's for

If any of these sound like you, this repo will feel at home:

- You want one entry point that keeps agent work aligned without turning every task into a rigid process.
- You want the AI to move autonomously on facts it can verify, but ask before it crosses scope, authorization, acceptance, or risk boundaries.
- You like having `道` lock in direction, boundaries, the main path, and the first step when the task is ambiguous or high-impact.
- You want review, diagnosis, TDD, UI quality, game planning, and agent delegation rules available without loading them on every request.
- You regularly tidy up READMEs, project rules, AI hand-off notes, or daily reports / commits / PR descriptions.
- You want to wire the entry point into any agent with a single skills.sh command instead of copying files by hand.

## Install

### The easy way

Just the unified entry point (most people want this):

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

Good when you want the entry point wired in fast, don't want to copy files around, and plan to trigger the inner modules through `odai`.

Other ways, pick as needed:

```bash
# Install the other skills in the repo too
npx skills add https://github.com/orziz/odai

# Slimmer, lower-token version (mini branch)
npx skills add https://github.com/orziz/odai#mini

# The old "many skills side by side" layout (old branch)
npx skills add https://github.com/orziz/odai#old
```

When to reach for the `old` branch: you're still on the old entry point, you need the standalone install for `harness-dev` / `harness-dao` and friends, or you're doing a side-by-side migration off the old structure.

## Architecture at a glance

```text
                         your task
                             │
                             ▼
       ┌─────────────────────────────────────────┐
       │  odai · SKILL.md  — entry routing         │
       │  direct-hit · lightweight gate · …        │
       └──────────────┬────────────────────────────┘
         direct-hit    │   ambiguous · cross-domain · dev
       ┌───────────────┘                 │
       │                                 ▼
       │                  ┌───────────────────────────┐
       │                  │  道 (dao) — orchestrator    │
       │                  │  道→术→法  (why→how→do)     │
       │                  │  sets direction & track,    │
       │                  │  supervises                 │
       │                  └──────────────┬──────────────┘
       │   defines the producer track,   │
       │   carries forward (no bounce) ──┤
       ▼                                 ▼
   ┌────────────────────────────────────────────────────────┐
   │  specialist modules (producers)                          │
   │   feature-plan · design-spec · implement-code            │
   │   game-plan · game-design · review-sslb                  │
   │   project-guide · ribao                                  │
   └────────────────────────────────────────────────────────┘

   support files (道 loads on demand):
     interaction-contract (hard law) · dao-shu-fa-playbook
     review-kit · diagnose-kit · agent-governance · result-reporting
     consensus-mode · external-skills
```

`道术法` (dao-shu-fa) are **phases of the work** — why → how → do —
that every task flows through; they are not labels stamped on modules.
A task enters once through `odai`; simple ones hit a module directly,
the rest go to `道`, which sets the track and carries them to a wrap-up.

## Getting more out of `odai`

`odai` doesn't run every module in sequence. It first checks whether the task can stay direct or lightweight; if not, `道` works out which layer is missing, which module to call, and what shape the output should take.

The one workflow inside:

- **`道`** — the default orchestrator and the only general workflow. Best for "lock in direction, boundaries, the main path, and the first step." It also picks the module chain and keeps the task moving until there is a result, verified gap, or real blocker.

You can also skip `道` for a single clear segment and name a module directly:

- `game-plan` — game systems, mechanics, numbers, economy, monetization, levels and content
- `game-design` — full game visuals: UI/UX/UE, characters and scenes, branding, FX and cinematics
- `feature-plan` — writing specs, weighing options, diagnosing bugs
- `design-spec` — pages, interactions, states, visuals, experience notes
- `implement-code` — writing code, fixing bugs, adding tests, refactors once the scope is clear
- `project-guide` — READMEs, project rules, AI hand-off baselines
- `review-sslb` — "three departments, six ministries" style code review (the old multi-style reviews all merged into this one)
- `ribao` — daily reports, commit messages, PR messages

A few handy triggers:

- "Use `odai` for this request: decide the module and output shape, ask me when unsure."
- "Use `odai`, start with `道` to pin down boundaries, the main path, and key risks, then push on."
- "Use `odai` on this implementation problem — `道` carries it all the way to a wrap-up."
- "Use `odai` with `project-guide` to set the AI hand-off baseline for this repo."

## How it talks to you

The modules that ask for missing details follow one interaction contract (`skills/odai/references/dao/interaction-contract.md`):

- It first tries to read, check, or run low-risk verification itself.
- It asks only for decisions that affect goal, boundary, authorization, acceptance, risk, stop line, or unacceptable outcomes.
- It keeps unverified claims separate from confirmed facts, and it does not report files, agents, commands, or validation it did not actually use.
- Once you answer, it continues with the current step by default — no need to add a "go on."

## Showcase

![Showcase 1](./assets/image_0.png)
![Showcase 2](./assets/image_1.png)

## Credits

Some of the naming, structure, and format ideas borrowed from these projects — thanks to all of them:

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)

Stars are welcome, and so are PRs — come help add better skills and workflows.
