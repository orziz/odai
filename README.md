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
- reuse existing host or project memory, persisting only durable information with provenance, scope, and invalidation conditions

## The Dao of odai

**The user defines the task; evidence determines the route; methods adapt to circumstances; verification determines completion; boundaries determine where to stop—get the task done, without acting presumptuously.**

This is not a collage of philosophical schools. It is one decision rule:

- **Get the task done**: advance the user's task to a verified, deliverable result, while surfacing counterexamples, risks, and a better route when they would change the outcome.
- **Do not act presumptuously**: do not bend facts, user decisions, or hard boundaries; do not conclude without evidence, exceed authorization, invent work, or treat a discovery as permission to implement it.

The model remains a strategist rather than a passive executor, but initiative is judged by net value. Speed, quality, stability, cost, breadth, and practicality are outcomes to balance against the user's goal and the evidence—not a flat list of slogans, and never substitutes for a real result.

### Operating Standard

**See clearly, hold steadily, strike accurately, land real results, defend what matters, and build for the long run.**

Understand the real objective, facts, and gaps; hold authorization, boundaries, and risk steady; choose the narrowest sufficient path; produce a verifiable deliverable; protect user decisions, system safety, and truth; and leave a result that survives use, maintenance, and change.

### Product Goal

Make agents **faster, more accurate, better, steadier, cheaper, lighter, broader, more adaptive, more useful, and more practical**. These are not independent process targets. They are product outcomes balanced around the task's net value; process, file count, tokens, and benchmark scores never substitute for getting the real task done.

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

- **Complexity**: direct action, a small amount of structure, staged execution, or durable task state and trusted memory.
- **Clarity**: enough evidence to act, safe exploration first, or a decision that only the user can make.
- **Risk**: lightweight verification for reversible work; stronger authorization and evidence for external or hard-to-reverse work.
- **Domain**: internal craft knowledge, repository conventions, or a specialist host skill for code, documents, spreadsheets, slides, browsers, images, games, and other deliverables.

Before loading any playbook, it applies a silent light-task gate. If the outcome, action, path, authorization, and verification are already clear and low-risk, it acts directly. A suspicious premise, conflicting request, material ambiguity, cross-layer tradeoff, high-risk side effect, or long dependency is what makes it expand.

Depth is not fixed at the start. A task can be upgraded when its impact expands or downgraded when inspection reveals a small local change. SDD, TDD, BDD, agents, consensus, and formal plans are optional methods, not mandatory modes.

Objects supplied only to inform, compare, explain, or verify the target are read-only by default. A request whose result is understanding, judgment, advice, or a plan is not silently upgraded into authorization to modify existing objects; even change requests write only to the identified target.

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
trusted memory, agent coordination, independent challenge, or consensus;
existing memory stays authoritative instead of being mirrored.
```

The framework owns the task from understanding through delivery, while capabilities and domain references provide only the craft needed at the moment. There is no separate orchestrator workflow and no user-selected domain package.

## Internal Map

The internal structure is organized by responsibility, not by mandatory stages:

| Layer | Purpose |
| --- | --- |
| Kernel | Core principle, adaptive progression, minimum boundaries, and loading map |
| `dao/` | Authority, verification, continuity, and truthful use of host skills, project rules, and agents |
| `capabilities/` | Planning, design, delivery, review, and evidence-grounded documentation |
| `domains/` | Optional UI and real-time interaction craft, inferred from the task |
| `techniques/` | Optional heavy methods for consensus and formal or convergent review |

The internal capabilities are deliberately plain and task-oriented:

| Name | Use it for |
| --- | --- |
| `planning` | Cross-domain specs, systems, tradeoffs, numbers, and content |
| `design` | Cross-domain flows, states, interaction, visuals, brand and asset direction |
| `delivery` | Evidence-led diagnosis, code changes, tests, and implementation |
| `review` | Findings-first review of code, diffs, repositories, UI, or design |
| `documentation` | Evidence-grounded synthesis of facts, progress, changes, decisions, and project knowledge for a real audience |

Planning and design infer the domain from task and repository evidence. Game work is one supported domain, not a separate package the user has to select. Office artifacts use the host's document, spreadsheet, presentation, PDF, browser, or image skill when available; `odai` keeps responsibility for intent, progress, and truthful closure.

Documentation loads only when the task calls for it. A request to write or organize content does not by itself authorize filling, submitting, publishing, or sending through an external system; when the target and action are clear from the request, context, or established convention, odai continues within that boundary. Project guides update the existing documentation owner instead of creating a parallel source of truth.

When complex or long-running work needs handoff, coordination, or recovery, odai writes decisions, plans, state, and acceptance evidence back to the existing documentation or task owner. It also updates authoritative documentation made stale by implementation. When code, tests, or the requested artifact already carry the complete result, complexity alone does not justify another document.

## Good Prompts

Use the level of detail you actually have:

```text
/odai handle this. Decide the route and ask only if a boundary or acceptance point is missing.
```

```text
/odai review the current diff. Report findings first and do not modify files.
```

```text
/odai refresh this repository README. Remove outdated screenshots and keep the install path clear.
```

```text
/odai this task is user-facing. Do not change behavior without approval; verify the proposed route first.
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

## Optional Hook Guardrails

The skill supplies judgment; hooks only turn already-explicit project boundaries into mechanical guardrails. They are not installed or enabled by default and do not change odai's main flow. Once a project defines `.odai/hooks.json`, they can protect explicit read-only paths and run explicitly declared acceptance commands that match the current change. With no policy file, they are silent no-ops.

The repository keeps one dependency-free runtime and generates native host adapters on demand instead of maintaining six platform mirrors:

```bash
node skills/odai/scripts/build-hooks.mjs --host all --out /tmp/odai-hooks
```

Replace `all` with `codex`, `claude`, `copilot`, `gemini`, `grok`, or `kimi` when only one adapter is needed. Each output contains an `ADAPTER.json` describing its install form. Start from [`skills/odai/assets/hooks-policy.example.json`](skills/odai/assets/hooks-policy.example.json), adapt it to project evidence, and place the result at `<project>/.odai/hooks.json`.

| Host | Pre-write read-only protection | Declared acceptance before closure |
|---|---:|---:|
| Codex | `PreToolUse` | `Stop` |
| Claude Code | `PreToolUse` | `Stop` |
| GitHub Copilot | `preToolUse` | `agentStop` |
| Gemini CLI | `BeforeTool` | `AfterAgent` |
| Grok Build | `PreToolUse` | — |
| Kimi Code CLI | `PreToolUse` | `Stop` |

Grok Build currently exposes `PreToolUse` as the blocking boundary, so its adapter does not pretend that Stop validation is enforceable. The runtime checks structured write tools and project-declared commands only. It does not parse arbitrary shell writes or infer user intent, target files, or test strategy. Hooks are a lightweight fuse alongside host permissions, sandboxing, and human confirmation—not a complete security boundary. Review the generated adapter and `.odai/hooks.json` before enabling them.

## Evaluation

The current results (2026-07-22) contain 12 realistic full-plan tasks and an 8-task paired A/B subset. Only two cases are explicit low-risk controls. The rest present natural symptoms, opinions, or broad requests; the decisive facts live in project code, logs, briefs, diffs, task state, and runbooks. This includes user-supplied wrong causes, harmful fixes, ambiguous requirements, long-task recovery, and production boundaries.

Each result first receives a 0-4 completion score, then the predefined case weight is applied. The full plan is worth 88 points and the A/B subset 56. Direct, judgment, complex, and boundary work are reported separately, while severe scope, production-risk, and false-verification violations have hard score caps. A perfect treatment score alone is not evidence of value; it must be read against the same model's control result and cost.

| Runner | full on | A/B on | A/B off | gain | A/B runner tokens on / off |
|---|---:|---:|---:|---:|---:|
| GPT-5.6-sol / high | **88/88** | **56/56** | 41/56 | **+15** | 184,940 / 164,275 (+12.6%) |
| Claude Opus 4.8 | 83/88 | **53/56** | 42/56 | **+11** | 1,201,072 / 968,460 (+24.0%) |
| Grok 4.5 | **88/88** | **56/56** | 37/56 | **+19** | 821,671 / 631,716 (+30.1%) |
| Gemini 3.6 Flash (High) | 74/88 | 46/56 | 31/56 | **+15** | 805,255 / 1,407,955 (-42.8%) |
| Qwen 3.8 Max Preview | 85/88 | **55/56** | 46/56 | **+9** | 2,004,644 / 1,773,309 (+13.0%) |
| Kimi K3 | 77/88 | 49/56 | **50/56** | -1 | 1,211,628 / 1,113,107 (+8.9%) |
| GLM-5.2 | 70/88 | 44/56 | 36/56 | **+8** | 2,224,745 / 1,846,753 (+20.5%) |
| DeepSeek V4 Pro | 71/88 | 41/56 | 29/56 | **+12** | 2,718,299 / 2,185,050 (+24.4%) |
| MiMo 2.5 Pro | 68/88 | 42/56 | 33/56 | **+9** | 2,024,644 / 1,334,236 (+51.7%) |

Across nine models, GPT-5.6, Opus, Grok, Qwen, and K3 pass all eight A/B tasks with odai; Gemini, GLM, and DeepSeek V4 Pro pass six, while MiMo passes five. Every model except K3 gains weighted quality, led by Grok at +19. Gemini rises from 31/56 to 46/56 while runner tokens fall by 42.8%; this comes from materially fewer planning and command rounds in the Antigravity trajectories and does not imply that other models or later runs will always save tokens. The strongest repeated benefit remains wrong-premise and production-risk judgment, without implying that every model follows the same rule reliably. GPT-5.6-sol / high and Grok score 88/88 on the full plan; Opus, Qwen, and K3 pass all twelve tasks, while Gemini, GLM, DeepSeek V4 Pro, and MiMo pass ten, nine, ten, and eight respectively.

See [`docs/evaluation.md`](docs/evaluation.md) for the contract and [`docs/evaluation-results.md`](docs/evaluation-results.md) for the latest retained case scores, gaps, support reads, and token details.

Stars and PRs are welcome.
