<!-- Language toggle -->
**English** · [中文](README.zh-CN.md)

# odai

`odai` is a bundle of AI skills hidden behind a single entry point. Instead of memorizing a dozen skill names, you just hand your task to `odai` and let it figure out the rest — planning, design, code review, writing code, summaries, game design, game visuals, all of it.

Inside, there's a dispatcher called `道` ("the Way"). It reads what you're actually trying to do, picks the right module, decides what to hand back (a quick judgment call, a draft, a design, a review verdict, an action list, or just doing the work), and asks first when something important is unclear.

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

Think of `odai` as a self-routing toolbox of skills:

- **One door in.** You don't pick the skill. `道` decides whether this round needs a one-line judgment, a draft, a design mockup, a review verdict, an action list, or just getting hands dirty.
- **A set of focused modules behind it.** Planning, design, review, coding, game design, game visuals, summaries — whatever the task needs.
- **`道` is the default dispatcher.** Whatever the domain, it picks the route and carries the task all the way to a wrap-up.

A few things worth knowing up front:

- For actual work, there's just one entry point: `odai`. Maintaining the repo uses a separate tool, `skill-author`.
- Distribution goes through the [skills.sh](https://skills.sh) standard (`npx skills add`). The canonical source lives under `skills/` — there are no per-platform mirror copies anymore.
- The old "many skills side by side" layout moved to the `old` branch; install it separately if you still need it.

## Who it's for

If any of these sound like you, this repo will feel at home:

- You want your go-to prompts and workflows behind one door, without memorizing a list of names.
- You want the AI to route itself between planning, design, review, and implementation.
- You like having a "dispatcher" lock in direction, boundaries, and the first step before any specific module runs.
- You want to keep several review styles and workflows around without maintaining a pile of parallel entry points.
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
     review-kit · diagnose-kit · consensus-mode · external-skills
```

`道术法` (dao-shu-fa) are **phases of the work** — why → how → do —
that every task flows through; they are not labels stamped on modules.
A task enters once through `odai`; simple ones hit a module directly,
the rest go to `道`, which sets the track and carries them to a wrap-up.

## Getting more out of `odai`

`odai` doesn't just run every module in sequence. `道` first works out which layer you're actually missing, which module to call, and what shape the output should take — then reads that module and keeps going.

The one workflow inside:

- **`道`** — the default dispatcher and the only general workflow. Best for "lock in direction, boundaries, the main path, and the first step." It also picks the module and decides the output shape, and carries any task — dev or not — through to a wrap-up.

You can also skip the dispatcher and name a module directly:

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

The modules that proactively ask you for missing details all follow one interaction contract (`skills/odai/references/dao/interaction-contract.md`):

- Before acting, it lays out: current understanding, what's already verified, what's still unconfirmed, and the questions only you can settle.
- It uses structured questions when it can; if the channel doesn't support them, it says so and switches to asking in grouped plain text.
- Once you answer, it just continues with the current step by default — no need to add a "go on."

## Showcase

![Showcase 1](./assets/image_0.png)
![Showcase 2](./assets/image_1.png)

## Credits

Some of the naming, structure, and format ideas borrowed from these projects — thanks to all of them:

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)

Stars are welcome, and so are PRs — come help add better skills and workflows.
