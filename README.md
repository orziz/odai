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

## Governance Constitution

These traditions are operational lenses in one flow, not separate roles, agents, or sources of authority:

| Lens | Operational meaning |
|---|---|
| Dao | Intervene as little as the task allows; do not act while the governing decision is unstable |
| Confucian | Keep names and reality aligned: a candidate is not authorization, implementation is not verification |
| Heart-mind | Once the governing decisions are stable, act and let real results test the judgment |
| Military | Read the evidence, environment, advantage, and stopping point before moving |
| Legalist | Keep definitions in their owner and obey host, permission, and tool boundaries |

The model remains a strategist: it should surface relevant adjacent value, second-order effects, risks, and fallback routes, but those suggestions never silently expand authorization or replace the user's decision. Guiguzi and Han Fei inform situational communication and name-reality / hard-gate methods inside this flow; they do not add roles or grant the skill power.

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

## Current Evaluation Results

As of 2026-07-14.

### Full Scope and Lower Bound

| Scope | Runner | Host CLI | Judge | Result |
|---|---|---|---|---:|
| Full | GPT-5.5 / medium | Codex | GPT-5.6 Sol / high | 45/45 |
| Starred lower bound | GPT-5.4 Mini / low | Codex | GPT-5.6 Sol / high | 10/19 |
| Full | Grok 4.5 | Grok CLI | GPT-5.6 Sol / high | 45/45 |
| Full | Kimi K2.7 Code [256K] | Claude Code / CC Switch | GPT-5.6 Sol / high | 41/45 |

### With / Without A/B

| Runner | Host CLI | With odai | Without odai |
|---|---|---:|---:|
| GPT-5.4 Mini / low | Codex | 5/9 | 2/9 |
| GPT-5.5 / medium | Codex | 9/9 | 3/9 |
| GPT-5.6 Sol / high | Codex | 9/9 | 3/9 |
| Claude Opus 4.8 | Claude Code | 9/9 | 3/9 |
| Claude Sonnet 5 | Claude Code | 9/9 | 3/9 |
| Claude Fable 5 | Claude Code | 9/9 | 5/9 |
| Grok 4.5 | Grok CLI | 9/9 | 3/9 |
| GLM-5.2 [1M] | Claude Code / CC Switch | 8/9 | 4/9 |
| DeepSeek V4 Pro [1M] | Claude Code / CC Switch | 7/9 | 2/9 |
| DeepSeek V4 Flash [1M] | Claude Code / CC Switch | 6/9 | 2/9 |
| Kimi K2.7 Code [256K] | Claude Code / CC Switch | 9/9 | 4/9 |
| MiniMax M3 [1M] | OpenAI-compatible / CC Switch | 8/9 | 3/9 |

### Anonymous Skill Comparison

| Group | Score | Passes |
|---|---:|---:|
| odai | **15/20** | **3/5** |
| Superpowers | 11/20 | 2/5 |
| Bare | 10/20 | 1/5 |
| mattpocock/skills | 10/20 | 1/5 |
| Compound Engineering | 10/20 | 1/5 |

The anonymous comparison supports a lead for odai on the tested project-governance, production-gate, and verification-honesty slice. It is not evidence of universal supremacy. See [`docs/evaluation.md`](docs/evaluation.md) for methodology, token counts, and per-case notes; per-run evidence remains in [`plans/odai-canary-results.md`](plans/odai-canary-results.md).

Stars and PRs are welcome.
