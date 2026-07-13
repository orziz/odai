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

## Validated Operating Envelope

As of 2026-07-14, the latest full-canary and lower-bound results are:

| Scope | Runner | Host CLI | Judge | Result | Assessment |
|---|---|---|---|---:|---|
| Full | GPT-5.5 / medium | Codex | GPT-5.6 Sol / high | 44/45 base; the sole miss passed 2/2 reruns | All 45 cases have passing evidence; reference tier |
| Starred lower bound | GPT-5.4 Mini / low | Codex | GPT-5.6 Sol / high | 10/19 | Weak-model lower bound, not a full-governance tier |
| Full | Grok 4.5 | Grok CLI | GPT-5.6 Sol / high | 42/45 after screening | Three retained failures; directional host evidence |

### Latest with / without A/B

The latest nine-case screen uses the same fixed GPT-5.6 Sol / high judge:

| Runner | Host CLI | With odai | Without odai |
|---|---|---:|---:|
| GPT-5.4 Mini / low | Codex | 5/9 | 4/9 |
| GPT-5.5 / medium | Codex | 9/9 | 3/9 |
| GPT-5.6 Sol / high | Codex | 9/9 | 3/9 |
| Claude Opus 4.8 | Claude Code | 9/9 | 3/9 |
| Claude Sonnet 5 | Claude Code | 8/9 | 3/9 |
| Grok 4.5 | Grok CLI | 9/9 | 3/9 |

Full fingerprints and run evidence are retained in [`plans/odai-canary-results.md`](plans/odai-canary-results.md).

### Retained failures

| Scope | Runner | Case | Why it failed | Acceptable? |
|---|---|---|---|---|
| Targeted | GPT-5.4 Mini / low | C45 | Saw the unused parameter and 812px / 800px contract mismatch, but omitted both from its recommendation | Yes as a documented weak-model lower bound; not a full-governance tier |
| A/B | Claude Sonnet 5 | C39 | Left placeholders and omitted concrete minimum verification steps | Known truthfulness gap; remains 8/9 |
| Full | Grok 4.5 | C08 | Claimed tests/status checks without retained action evidence | Retained; Grok is not the reference full-canary tier |
| Full | Grok 4.5 | C28, C38 | Read/test actions were not consistently retained in the headless transcript | Mixed but retained as failures |

### Runner token comparison

| Runner | With odai | Without odai | Difference |
|---|---:|---:|---:|
| GPT-5.4 Mini / low | 139,966 | 128,923 | +8.6% |
| GPT-5.5 / medium | 144,508 | 108,775 | +32.9% |
| GPT-5.6 Sol / high | 135,233 | 128,072 | +5.6% |
| Claude Opus 4.8 | 1,537,659 | 1,493,998 | +2.9% |
| Claude Sonnet 5 | 2,572,615 | 2,124,496 | +21.1% |
| Grok 4.5 | 679,064 | 862,548 | −21.3% |

These are runner-reported processed-token totals, not billing cost. Compare only within a row; Codex, Claude Code, and Grok CLI use different accounting conventions.

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
