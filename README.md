<!-- Language toggle -->
**English** · [中文](README.zh-CN.md)

# odai

`odai` is a governance-powered general task-execution framework for AI agents.

It embeds governance into execution: align the real objective, facts, assumptions, authorization, risks, and acceptance; then choose the shortest sufficient path, combine the right capabilities, act, verify, and keep moving until the task is genuinely deliverable. It does not replace the model's judgment with a rigid workflow.

The short version: call `/odai`; governance stays nearly invisible on simple work, while ambiguity, complexity, risk, and domain needs automatically increase or reduce the depth of handling.

## Why Use It

`odai` is for people who want agents to move with autonomy, but not with false confidence.

It helps an agent:

- ask only when the missing answer would change the goal, scope, authorization, acceptance, risk, or stop line
- verify what it can verify from files, commands, logs, tests, or project context before asking you
- keep lightweight tasks lightweight instead of turning every request into ceremony
- avoid claiming that something was tested, delegated, reviewed, or verified when it was not
- combine specialist skills and domain guidance only when the task needs them, instead of stuffing every rule into every turn

## Governance Constitution

These traditions are operational lenses in one flow, not separate roles, agents, or sources of authority:

| Lens | Operational meaning |
|---|---|
| Dao | Intervene as little as the task allows; methods follow the situation instead of becoming doctrine |
| Confucian | Keep names and reality aligned: goals, means, facts, hypotheses, authorization, implementation, and verification are distinct |
| Heart-mind | Once understanding is sufficient, act and let real results test the judgment |
| Military | Read the situation, choose the highest-value move, and change direction when evidence stops improving |
| Legalist | Protect host, permission, safety, user decisions, and truthfulness boundaries |

The model remains a strategist, balancing offense and defense: surface the real objective, adjacent value, best route, second-order effects, risks, and fallbacks without silently expanding authorization or replacing the user's decision.

The operating standard is: **see clearly, hold steadily, strike accurately, land real results, defend what matters, and build for the long run**.

The product goal is to make work **faster, more accurate, better, steadier, cheaper, lighter, broader, more adaptive, more useful, and more practical**—without treating process, file count, or benchmark scores as substitutes for real value.

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

You do not need to know the internal structure or choose a methodology. `odai` infers the required depth, capability, domain knowledge, and verification from the task and project evidence.

## How It Decides

`odai` continuously evaluates four dimensions:

- **Complexity**: direct action, a small amount of structure, staged execution, or durable task state.
- **Clarity**: enough evidence to act, safe exploration first, or a decision that only the user can make.
- **Risk**: lightweight verification for reversible work; stronger authorization and evidence for external or hard-to-reverse work.
- **Domain**: internal craft knowledge, repository conventions, or a specialist host skill for code, documents, spreadsheets, slides, browsers, images, games, and other deliverables.

Before loading any playbook, it applies a silent light-task gate. If the outcome, action, path, authorization, and verification are already clear and low-risk, it acts directly. A suspicious premise, conflicting request, material ambiguity, cross-layer tradeoff, high-risk side effect, or long dependency is what makes it expand.

Depth is not fixed at the start. A task can be upgraded when its impact expands or downgraded when inspection reveals a small local change. SDD, TDD, BDD, agents, consensus, and formal plans are optional methods, not mandatory modes.

The point is not to slow the agent down. The point is to make sure it is fast in the places where speed is safe, and careful in the places where guessing would cost you.

## Architecture Logic

```text
                         user task
                            |
                            v
       +---------------------------------------------+
       | /odai -> lightweight adaptive kernel       |
       | understand -> choose next valuable action  |
       +---------------------+-----------------------+
                             |
       +---------------------+-----------------------+
       |                     |                       |
       v                     v                       v
  direct action       internal capability      host skill / tool
                     + domain knowledge         + project rules
       |                     |                       |
       +---------------------+-----------------------+
                             v
                    act -> verify -> deliver
                             |
                  new evidence updates the path

Only complex or long-running work loads durable state,
agent coordination, independent challenge, or consensus.
```

The framework owns the task from understanding through delivery, while capabilities and domain references provide only the craft needed at the moment. There is no separate orchestrator workflow and no user-selected domain package.

## Internal Map

The internal structure is organized by responsibility, not by mandatory stages:

| Layer | Purpose |
| --- | --- |
| Kernel | Constitution, product goals, adaptive progression, minimum boundaries, and loading map |
| `dao/` | Authority, verification, continuity, coordination, and host / project composition |
| `capabilities/` | Planning, design, diagnosis, code implementation, and review |
| `recipes/` | Named outputs such as project guides and daily / commit / PR summaries |
| `domains/` | Optional UI and real-time interaction craft, inferred from the task |
| `techniques/` | Optional heavy methods such as consensus, long audits, and full SSLB review |

Named entry points remain available for compatibility and direct use:

| Name | Use it for |
| --- | --- |
| `feature-plan` | Cross-domain specs, systems, tradeoffs, numbers, content, non-code diagnosis |
| `design-spec` | Cross-domain flows, states, interaction, visuals, brand and asset direction |
| `implement-code` | Code changes, bug fixes, tests, refactors after scope is clear |
| `review-sslb` | Structured code review |
| `project-guide` | READMEs, project rules, AI handoff baselines |
| `ribao` | Daily reports, commit messages, PR messages |

`feature-plan` and `design-spec` infer the domain from task and repository evidence. Game work is one supported domain, not a separate package the user has to select. Office artifacts use the host's document, spreadsheet, presentation, PDF, browser, or image skill when available; `odai` keeps responsibility for intent, progress, and truthful closure.

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

Canonical source lives in `skills/`. Distribution is handled through the [skills.sh](https://skills.sh) install flow; this repository no longer keeps per-platform mirror outputs. See [MAINTAINING.md](MAINTAINING.md) for the current source, validation, freeze, and release rules, and [CHANGELOG.md](CHANGELOG.md) for frozen architecture changes.

## Evaluation

The current `2026-07-16-r7` skill/evaluation release is frozen at 12 realistic full-plan tasks and an 8-task paired A/B subset. This repository label is independent of the optional CLI package version. Only two cases are explicit low-risk controls. The rest present natural symptoms, opinions, or broad requests; the decisive facts live in project code, logs, briefs, diffs, task state, and runbooks. This includes user-supplied wrong causes, harmful fixes, ambiguous requirements, long-task recovery, and production boundaries.

Results are reported separately for direct, judgment, complex, and boundary work. The direct band measures whether odai stays nearly invisible: no quality regression, no support-file reads, and no material token overhead. The other bands measure whether extra work produces observable gains. A perfect treatment score alone is not evidence of value.

| Runner | with odai | without odai | runner token change |
|---|---:|---:|---:|
| GPT-5.5 | **8/8** | 3/8 | +19.4% |
| Claude Opus 4.8 | **8/8** | 5/8 | +34.7% |
| Claude Sonnet 5 | **8/8** | 5/8 | +66.3% |
| Claude Fable 5 | **8/8** | 5/8 | +47.1% |
| Grok 4.5 | **8/8** | 6/8 | +25.9% |
| DeepSeek V4 Pro | 6/8 | 4/8 | -32.9% |
| DeepSeek V4 Flash | 5/8 | 3/8 | +88.5% |
| GLM-5.2 | **8/8** | 4/8 | +27.8% |
| Kimi K3 | **8/8** | 6/8 | +32.6% |
| Kimi K2.7 Code | 7/8 | 4/8 | +49.7% |
| MiniMax M3 | 6/8 | 3/8 | >+39.6%* |

\* MiniMax C05 has no usable usage footer, so the table reports a lower bound from the other seven cases.

GPT-5.5, Grok 4.5, and Kimi K3 all score 12/12 on the full on-plan. The current plan, evaluation harness, and canonical skill are fingerprint-frozen. See [`docs/evaluation.md`](docs/evaluation.md) for the contract and [`docs/evaluation-results.md`](docs/evaluation-results.md) for scores, failure distribution, and token details.

Stars and PRs are welcome.
