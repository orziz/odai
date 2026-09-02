<!-- Language toggle -->
**English** · [中文](README.zh-CN.md)

# odai

<p align="center">
  <img src="assets/odai-readme-badge.png" alt="Dai, the odai mascot" width="720">
</p>

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
- respond early and humanely to persistent low mood or self-harm/suicide inclination without diagnosing, labeling, waiting for a plan, or causing secondary harm

## The Dao of odai

**The user defines the task; evidence determines the route; methods adapt to circumstances; verification determines completion; boundaries determine where to stop—get the task done, without acting presumptuously.**

This is not a collage of philosophical schools. It is one decision rule:

- **Get the task done**: advance the user's task to a verified, deliverable result, while surfacing counterexamples, risks, and a better route when they would change the outcome.
- **Do not act presumptuously**: do not bend facts, user decisions, or hard boundaries; do not conclude without evidence, exceed authorization, invent work, or treat a discovery as permission to implement it.

The person and the model work as partners toward a shared result, not through a one-way command chain. The person contributes intent, context, value judgments, and unacceptable outcomes; the model contributes judgment, evidence, creation, and execution, challenges doubtful premises, and proposes better routes. Both calibrate understanding and trust through real progress, candid uncertainty, and feedback. The person owns goal-level tradeoffs; the model chooses professional implementation details within the agreed boundary. Authorization is not blind obedience, and challenge is not a takeover.

odai is neither an echo of the user nor a reciter of rules. It takes the person's purpose as its direction and facts and boundaries as its constraints, forms its own judgment and recommendation, holds a justified disagreement when necessary, and changes its mind when the evidence changes. Truth outranks pleasing, effectiveness outranks ceremony, reliable results outrank superficial shortcuts, and long-term trust outranks one-turn performance.

The model's initiative is judged by net value. Speed, quality, stability, cost, breadth, and practicality are outcomes to balance against the user's goal and the evidence—not a flat list of slogans, and never substitutes for a real result.

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

### DeepSeek Harness packages

[![npm: odai-dsh-plugin](https://img.shields.io/npm/v/odai-dsh-plugin?label=odai-dsh-plugin&logo=npm)](https://www.npmjs.com/package/odai-dsh-plugin)
[![npm: odai-dsh-agent](https://img.shields.io/npm/v/odai-dsh-agent?label=odai-dsh-agent&logo=npm)](https://www.npmjs.com/package/odai-dsh-agent)

DSH users can install either integration independently:

```sh
# Apply Odai to every agent preset in one profile
dsh plugin --profile web add odai-dsh-plugin

# Install a selectable, session-scoped Odai Agent preset
npx odai-dsh-agent install
```

The Plugin command requires `pnpm` on `PATH`; the current `0.2.19` Plugin and Agent candidate supports exactly formal `dsh@0.1.1-rc.2` and prerelease `dsh@0.1.2-alpha.4`; published `0.2.18` retains the historical alpha.2 contract and the Control Center source/version repair, rollback, and default-yes confirmation behavior. Each package already includes the canonical Odai skill, shared DSH runtime, and the same Chinese Control Center; there is no third package. Plugin exposes Control Center automatically. Interactive Agent install describes the existing profile source/version and asks at `[Y/n]`; Enter, `y`, or `yes` confirms, while EOF, `n`, `no`, or other text leaves the Web profile unchanged. Non-interactive install changes the profile only with explicit `--with-control-center`. The Agent preserves every capability from the pinned DSH Standard preset and adds Odai as a scoped extension. Plugin and Agent may be installed independently or together: when both are present, Plugin owns the single Control Center surface while the runtimes share and deduplicate governance, routing, and evidence state. The existing provider-neutral `odai-cli` remains a separate product.

Both DSH packages default output to **soft concise**. Users can explicitly select normal output or the optional **economy mode**, which combines concise presentation with a user-adjustable provider output ceiling: it defaults to `500` when economy is requested without another value. The ceiling never changes child-agent, compaction, checkpoint, or internal context budgets and may be exceeded or ignored by the provider. See [`dsh/README.md`](dsh/README.md#install-and-use) for the complete three-mode contract.

A complete independently installed Odai skill can update faster than either DSH package without changing the default. The user must explicitly ask Odai to switch the skill source to `auto` or `user`; `auto` can select compatible project `.dsh`/`.agents` bundles and newer user installs, while `user` ignores project roots. An explicit deployment path remains highest priority. Plugin and Agent deliberately installed together share one per-agent/per-turn snapshot, so prompt governance and routing role contracts cannot select different bundles.

Neither DSH package chooses responsibility models or dispatch overrides. Tell Odai naturally, for example, `use provider/model for planning with high reasoning and dispatch planning as child`; the runtime persists only those explicit choices for both surfaces. Researcher, planner, reviewer, and frontend can each use `same-turn` or `child`; implementation remains controller-owned. Later requests stay ordinary: role words are not commands, task state selects direct, inline, same-turn, or child dispatch; read-only same-turn responsibilities return only to the controller, an identical planner/controller model is not called twice, and the controller continues an already-authorized implementation after planning. If a needed responsibility is still unconfigured, Odai names it and asks for the model instead of claiming that route ran. Persisted routes are formally resolved before provider I/O: deterministic invalid mappings are backed up and removed by exact match, while authentication, quota, rate-limit, or network failures affect only the current fallback.

DSH human-safety continuity is separate from generic semantic memory. Only an explicit direct-user request can save user-authored care preferences, signals to notice, effective support, or safety-plan steps in the independent local record; the user can inspect, export, correct, remove, or physically clear it, and entries persist until one of those deletion controls is used. New sessions treat it as historical care preference, never as present-risk evidence, diagnosis, or a hidden score, and child agents never receive it.

See [`dsh/README.md`](dsh/README.md) for package boundaries, source precedence, natural-language configuration, and the isolated real-install coexistence verification.

### Host Capability Routing

The user identifies who should own each responsibility once, or lets odai recommend a mapping from the host's real capability catalog. After confirmation and installation, the project persists that mapping. Every later conversation and action still starts with `/odai` or an ordinary task request; the user never repeats models, roles, planning modes, or routing commands and does not need to watch internal handoffs. When models change, update the mapping once in place.

The controller is the persistent task thread that owns the goal, global state, correction loop, and final delivery, not another role launched on every turn. Judgment and acceptance are optional internal responsibilities rather than a user workflow; implementation remains with the controller. One sufficient capability completes the task in one pass; when another mapped responsibility can materially change the result, the host obtains that bounded contribution and returns it to the current conversation. Reliable no-tool answers stay direct, and follow-ups inherit recent deliveries and unresolved items without making the user restate them.

This routing is constrained by the host; skill text alone cannot mechanically guarantee it. If the host cannot verify model switching or delegation, odai uses one sufficient controller and continues the safely achievable work without pretending that routing occurred. The router is not a prerequisite for ordinary use and is installed only when the user requests managed capability routing.

Managed capability routing and the project guardrail hooks described below are separate mechanisms. Routing registers host roles and does not install a task runner or hidden per-turn hook. Project guardrails only enforce project-declared read-only paths and acceptance commands and do not route models.

Users on a supported host who want managed role routing do not need to find paths, enter model IDs, or merge configuration by hand. After installing the skill, say:

```text
/odai install and verify capability routing for this project.
```

odai configures one controller plus planner and reviewer from the host's actual capability catalog, with optional researcher and frontend mappings, explains the persistent effect, asks for one confirmation, and installs them with conflict checks. The default `auto` policy only registers capabilities: one controller implements and closes the task, while optional responsibilities run only when independent work can change the result. It adds no hidden per-turn preflight or stage runner. Reliable direct answers and read-only lookups never invoke another role merely to demonstrate routing.

To remove it, ask odai to uninstall capability routing for the current project. The installer merges with existing host settings, records the original Codex controller configuration for exact restoration, deletes only unchanged files listed in its managed manifest, and preserves unrelated settings. Installation, update, or an actual uninstall requires a new session; project scope is the default. It can generate managed role configuration for Codex, Claude Code, and GitHub Copilot CLI. Codex additionally supports native role verification; the other two hosts must not claim equivalent runtime routing evidence until comparable verification exists.

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

The framework owns the task from understanding through delivery. Six flat references provide only the boundary, craft, executable planning and durable handoff, verification, support, or external capability guidance needed at the moment; there is no separate orchestrator workflow or user-selected domain package.

odai's complete capability is not just its entry text. It combines the core, built-in baseline craft, project context, and professional capabilities that are worth using. A clearly matching installed capability may be used directly; a general capability gap warrants an installation recommendation only when the net gain is real; stable, repeated, project-specific craft may be encoded as a project skill. Whatever route is used, odai still owns evidence integration, acceptance, and final delivery. Merely finding, recommending, creating, or invoking a capability is not completion.

## Internal Map

The internal structure is organized by responsibility, not by mandatory stages:

| Layer | Purpose |
| --- | --- |
| Kernel | Core principle, adaptive progression, minimum boundaries, and loading map |
| `human-safety.md` | Early recognition, humane crisis intervention, prevention of secondary harm, and explicitly authorized safety continuity |
| `dao.md` | Goal ownership, factual correction, authorization, read-only references, and high-impact boundaries |
| `craft.md` | Lightweight planning, implementation, design, UI and real-time interaction, writing, and review |
| `planning.md` | Executable engineering plans, requirement coverage, work-package dependencies, durable handoffs, and recovery order |
| `verification.md` | Acceptance, evidence strength, completion, and resuming existing work |
| `support.md` | Self-calibration, performance recovery, durable state and memory, relationship continuity, consensus, and repeated review |
| `leverage.md` | Capability escalation and delegation, external capability discovery, net-benefit decisions, installation, creation, composition, and agent collaboration |

Domain depth is inferred from the task instead of selected as a package. Game, UI, documentation, and software work use the built-in craft baseline, then borrow project material, host tools, or professional skills only for a named gap. An optional host responsibility such as `frontend` is a model-routing adapter for a verified production gap inside the current task, not a selectable domain package or a precedent for enumerating database, security, or other domain roles. Without an external skill or responsibility mapping, odai still completes what the current model can do reliably.

Content work preserves evidence, existing templates, stale responsibilities, and publication boundaries. Complex or long-running work writes decisions, state, and acceptance evidence back to one existing maintenance location only when that materially improves recovery. Code, tests, or the requested artifact remain sufficient when they already carry the complete result.

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
npx skills add https://github.com/orziz/odai --all

# Install the slimmer branch
npx skills add https://github.com/orziz/odai#mini

# Install the older "one skill per ability" layout
npx skills add https://github.com/orziz/odai#old
```

Use `old` only if you still depend on the previous standalone skill layout or are comparing a migration.

Canonical source lives in `skills/`. Distribution is handled through the [skills.sh](https://skills.sh) install flow; this repository no longer keeps per-platform mirror outputs. See [MAINTAINING.md](MAINTAINING.md) for the current source, validation, freeze, and release rules, and [CHANGELOG.md](CHANGELOG.md) for frozen architecture changes.

## Codex Pets

This repository includes two optional, complementary Codex v2 desktop pets rather than two simple recolors:

| Pet | Character | Personality | Role |
|---|---|---|---|
| [Dai (`dai`)](pets/dai/) | Black-and-teal operations officer | Calm, reliable, restrained | Moves the task forward, executes, verifies, and closes the work |
| [Odai (`odai`)](pets/odai/) | Silver-white and blue-violet mascot | Lively, friendly, curious | Keeps you company, reacts to progress, cheers you on, and celebrates completion |

Dai gets the work done; Odai makes the process feel accompanied. Each includes nine standard animations and 16 look directions. Installing the `odai` skill does not install either pet automatically.

See the separate character bibles for [Dai](docs/阿岱%20设定档案.md) and [Odai](docs/欧黛%20设定档案.md).

From a cloned or downloaded copy, choose a pet and copy its two runtime files into the matching Codex pet directory.

Windows PowerShell (`odai`; replace both occurrences with `dai` for the black version):

```powershell
$petName = "odai"
$petDir = Join-Path $env:USERPROFILE ".codex\pets\$petName"
New-Item -ItemType Directory -Force $petDir | Out-Null
Copy-Item -LiteralPath "pets\$petName\pet.json","pets\$petName\spritesheet.webp" -Destination $petDir -Force
```

macOS or Linux:

```bash
pet_name="odai" # use "dai" for the black version
mkdir -p "$HOME/.codex/pets/$pet_name"
cp "pets/$pet_name/pet.json" "pets/$pet_name/spritesheet.webp" "$HOME/.codex/pets/$pet_name/"
```

Then open **Codex Settings → Pets**, refresh the list, and select `dai` or `odai`. You can also open the pet picker with `/pet`. See the [dai package README](pets/dai/README.md) or [odai package README](pets/odai/README.md) for previews and format details.

## Optional Hook Guardrails

The skill supplies judgment; hooks only turn already-explicit project boundaries into mechanical guardrails. They are not installed or enabled by default and do not change odai's main flow. Once a project defines `.odai/hooks.json`, they can protect explicit read-only paths and run explicitly declared acceptance commands that match the current change. With no policy file, they are silent no-ops.

These are the only per-turn hooks managed by odai. The capability-routing installer does not install hooks and cannot substitute for project guardrails.

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

The current results cover 19 realistic full-plan tasks and a 13-task paired A/B subset. Only two cases are explicit low-risk controls. The rest present natural symptoms, opinions, or broad requests; the decisive facts live in project code, logs, briefs, diffs, task state, and runbooks. Fingerprints preserve exact reproducibility; unrelated routing assets or maintenance edits do not invalidate an entire result table when the prompt, fixture, model configuration, scoring semantics, and case-relevant skill behavior remain equivalent. Gemini 3.7 and DeepSeek V4 Pro (DSH) ran under the cross-platform `odai-canary-isolation/v1` contract; the other published rows predate that contract and are retained as historical capability evidence.

Each result first receives a 0-4 completion score, then the predefined case weight is applied. The full plan is worth 144 points and the A/B subset 96. Direct, judgment, complex, and boundary work are reported separately, while severe scope, production-risk, and false-verification violations have hard score caps. A perfect treatment score alone is not evidence of value; it must be read against the same model's control result and cost.

| Runner | full on | A/B on | A/B off | gain | A/B runner tokens on / off |
|---|---:|---:|---:|---:|---:|
| GPT-5.6-sol / high | **144/144** | **96/96** | 80/96 | **+16** | 396,899 / 317,761 (+24.9%) |
| Claude Opus 5 | **144/144** | **96/96** | 77/96 | **+19** | 2,273,558 / 1,937,782 (+17.3%) |
| Grok 4.6 / default high | **144/144** | **96/96** | 67/96 | **+29** | 2,236,506 / 1,285,461 (+74.0%) |
| Grok 4.5 | **144/144** | **96/96** | 69/96 | **+27** | 1,579,533 / 1,054,670 (+49.8%) |
| Gemini 3.7 Flash High | 134/144 | 88/96 | 72/96 | **+16** | 1,813,203 / 1,580,475 (+14.7%) |
| Gemini 3.6 Flash High | 126/144 | 82/96 | 67/96 | **+15** | 1,381,447 / 2,235,193 (-38.2%) |
| Kimi K3 | **144/144** | **96/96** | 75/96 | **+21** | 2,192,056 / 1,632,057 (+34.3%) |
| DeepSeek V4 Pro / max (DSH) | **144/144** | **96/96** | 63/96 | **+33** | 2,131,373 / 1,652,030 (+29.0%) |
| DeepSeek V4 Flash | **144/144** | **96/96** | 61/96 | **+35** | 5,341,138 / 3,975,731 (+34.3%) |

All nine runners produced a positive paired gain. Every runner except the two Gemini versions reached full on scores in both the full suite and A/B subset. Eight runners used more tokens with odai, while Gemini 3.6 used 38.2% fewer, so both quality gains and cost changes remain model-dependent—not unconditional improvement or token savings.

See [`docs/evaluation.md`](docs/evaluation.md) for the current contract, [`docs/evaluation-results.md`](docs/evaluation-results.md) for model full-suite/A-B scores and token details, and [`docs/routing-results.md`](docs/routing-results.md) for optional host-routing quality, role usage, latency, and cost experiments.

Stars and PRs are welcome.
