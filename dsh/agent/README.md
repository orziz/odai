# odai dsh agent

`odai-dsh-agent` installs a selectable, session-scoped Odai Agent preset for DeepSeek Harness (`dsh`). It is independent from the profile-wide `odai-dsh-plugin`: the preset install does not activate global governance. In an interactive terminal, the command separately offers to add the same package's Control Center to the Web profile and performs that profile change only after confirmation.

The installed preset is self-contained:

```text
$DSH_HOME/.agent-presets/odai/
  agent.cordis.yml
  preset.yml
  runtime/*.mjs
  skills/odai/**
  .odai-agent.json
```

The source composition preserves every capability row and setting from the `standard` agent surface in `@deepseek-ai/dsh@0.1.2-rc.1`, then adds the scoped Odai runtime in default `auto` mode. The installer accepts that exact DSH release and publishes the LF-normalized managed preset without a legacy renderer. Release verification resolves each release's own Standard package path and compares the rendered composition against that exact source; a missing, added, reordered, or changed Standard row fails the probe. Host-owned persistence, sandbox, approval, registries, and base controller selection remain in the selected DSH profile. Ordinary requests stay on that controller. Responsibility words are optional signals rather than commands: evidence-grounded task-state gaps route at any step, the gap tool records rather than claims a route start, terminal decisions consume the proposal, an incomplete reviewer proposal waits for changed native evidence, and an identical planner/controller model remains inline without another model call. After planner handback, the controller resumes implementation only when the current user task authorizes it; plan-only, new-task, expanded-scope, and unknown authorization remain non-implementing. Reviewer children require a current hash-addressed evidence packet whose diff is newer than the last write and whose latest successful test follows that diff. An incomplete packet keeps the current controller route, reports why native evidence was excluded, suppresses unchanged repeat notices, and reassesses the pending proposal after decisive evidence changes without claiming independent acceptance or terminating the authorized task. Every route is resolved before provider I/O; deterministic invalid persisted mappings are backed up and exact-match removed, while recoverable provider failures preserve them. Frontend route failure becomes an explicit local controller fallback without a routed receipt. `execute` remains an explicit comparison mode and `observe` changes no model or child while retaining fail-closed high-impact protection. Configured compaction streams are buffered so partial failed output cannot contaminate the inherited-route retry or replace original history.

In DSH `0.1.2-rc.1`, the inherited Standard tools expose native bidirectional `send_message` only between adjacent continuable parent/child Agents. The DSH service owns durable child identity, cold resume, admission, and explicit invalid/unavailable-target failures; Odai does not replace an invalid id or treat delivery as responsibility acceptance.

The preset includes the same local long-term semantic memory runtime as the Plugin. Default `auto` mode performs no hidden model call: it automatically captures only high-confidence durable statements from the direct-human message authenticated by the latest open-turn session event, keeps ambiguous or conflicting candidates inert, and recalls only bounded active global/project records as untrusted historical context. Matching direct intent, or the compact capability gateway on a later step, exposes the controller-only `odai_memory` tool for inspection, search, confirmation, correction, physical forgetting, exact-phrase clearing, and `auto`/`off` mode changes. Recognized secrets, contact identifiers, health/crisis content, temporary instructions, hypotheses, quotes, and code are rejected; the current user and project authority always override memory. State lives at `$DSH_HOME/odai/memory/store.json`, outside `.agent-presets`, so install, update, and uninstall preserve it. An invalid or symlinked store fails closed. The matcher is not a replacement for protecting the underlying DSH session history from sensitive input.

Non-crisis care and crisis safety are separate. `references/care.md` owns fatigue, anxiety, self-doubt, rumination, shame, fear of mistakes, negativity, reduced agency, and user-controlled 阿岱/欧黛 styles without diagnosis, scoring, persistence, or model routing. `references/human-safety.md` owns sustained or worsening low mood, hopelessness, burden, self-harm, suicide, and immediate danger; any credible current inclination triggers timely care and a direct safety check even without a plan, while plan, means, and action determine urgency.

Human-safety continuity is an independent explicit-consent store at `$DSH_HOME/odai/human-safety-continuity.json`, not a hidden health profile and not semantic memory. `odai_human_safety_continuity` accepts only the authenticated current direct user's request to save, inspect, export, correct, remove, or physically clear user-authored care preferences, signals they want noticed, support they say helps, and safety-plan steps. Added or replacement text must occur exactly in that message; credentials and contact details are rejected, and entries persist until the user removes or physically clears them. New controller sessions receive the minimal historical record only when the current conversation independently makes care, crisis support, or record management relevant, never as proof of current risk, diagnosis, or a score; children cannot inspect it or receive its prompt data.

Ordinary requests retain the complete canonical governance plus compact responsibility and capability-discovery tools. Low-frequency control and care schemas are exposed per agent only for matching direct intent; uncommon wording can request the specialized capability on the next step, and unsupported hosts fall back to the complete tool catalog instead of dropping behavior.

## Install

With DSH already installed, run the single Agent package command below. The package already contains the canonical skill and shared runtime; it does not require the Plugin or a separate skill installation:

```sh
npx odai-dsh-agent install
```

The installer checks `dsh -V`; the current `0.2.25` candidate accepts exactly `0.1.2-rc.1` and rejects retired rc.2 and unverified later releases. `0.1.3-alpha.1` remains outside the peer contract because no npm release artifact exists for matrix verification and its v0-to-v1 Session migration refuses historical external Odai events. The installer records the detected version in the managed manifest and publishes the rc.1 source composition. In an interactive terminal it classifies the Control Center profile as absent, current, registry-upgrade, local-link, partial-drift, newer, or unknown-source. Every add, upgrade, replacement, or repair is shown at `[Y/n]`; Enter, `y`, or `yes` confirms, while EOF, `n`, `no`, and other text leave the profile unchanged. Non-interactive and `--json` installs never infer consent: automation can use `--with-control-center` or `--without-control-center` explicitly, with `--profile <name>` selecting a profile other than `web`.

`DSH_HOME` is honored. An explicit location can be supplied without changing the environment:

```sh
npx odai-dsh-agent install --dsh-home /path/to/dsh-home
```

Open a new DSH session and select `Odai` from the Agent preset picker. Existing sessions retain the preset they were composed with.

The installer copies through a mode-tightened staging directory and atomically publishes the preset. Lifecycle operations reject symlinked managed parents or source roots, serialize per preset with an owner-token operation lock, and revalidate the exact manifest revision after atomically moving an update or uninstall target to a unique quarantine path. Unverified quarantine content is retained and reported, never recursively deleted. Updates verify every previously managed file first, refuse to overwrite local edits, and always change the composition generation key so new sessions in a running DSH process do not reuse stale runtime code. Normal install, update, and uninstall do not scan, merge, rewrite, or block on historical session logs. If a session created by an older Odai release stops opening after DSH is upgraded from rc.2 to rc.1, stop every DSH process and run the separate one-time `npx odai-dsh-plugin legacy-session-repair --yes` utility. It marks only the known historical Odai audit events ignorable, verifies atomic replacements, retains content-addressed backups, and fails closed on unknown events, failed process inspection, or an active DSH process.

DSH classifies this as a `trust: user` preset. User presets have the same privileges as shell access, so install only reviewed package versions; the installer repeats this trust notice in both plain and JSON output.

## Control Center

The optional profile entry ships inside `odai-dsh-agent`; it is not a third package. It adds one Chinese Control Center launcher to DSH Web with a real current-turn responsibility graph, session evidence timeline, structured event inspector, and routing controls for the four optional responsibilities. The controller remains host-managed and read-only. Routing writes use the same validated, locked, atomic routing action as the conversation tool and apply on the next user turn. Configured models alone are never displayed as execution evidence.

The main `install` prompt is the recommended entry. These lifecycle commands remain available for inspection, recovery, and automation:

```sh
npx odai-dsh-agent control-center install [--profile web]
npx odai-dsh-agent control-center status [--profile web]
npx odai-dsh-agent control-center uninstall [--profile web]
```

A Control Center profile change requires one normal DSH Web process restart. Removing it does not remove the Agent preset, routing configuration, or session evidence. Status is current only when the dependency is the installer package's exact registry version, the resolved package reports that same version, the bundle entry occurs exactly once, and the shipped host/runtime/client artifacts exist. A stale `file:` or `link:` dependency is reported with its concrete source and can be replaced only after explicit consent. Profile operations serialize through an owner-token lock. If a DSH package-manager command fails without changing profile bytes, the installer reports the unchanged state; if bytes changed, it does not run a destructive inverse command or overwrite a possible concurrent successor. It preserves the current state and retains before/after recovery evidence under `$DSH_HOME/odai/control-center-backups/` for explicit repair.

## Responsibility models

The Agent ships no researcher, planner, reviewer, or frontend model mapping. It stays quiet when an unconfigured responsibility is not needed. If a real task gap needs one, Odai says which responsibility is missing, confirms that no route ran, and asks for the provider, model, and optional reasoning effort in natural language. For example:

```text
证据调查用 provider-r/model-research，推理档 high。
规划用 provider-x/model-plan，推理档 high。
验收改用 provider-z/model-review，推理档 max。
前端制作用 provider-f/model-frontend，输出上限 4096。
规划职责改成 child，前端职责保持 same-turn。
研究和验收职责改成 same-turn。
```

The controller calls `odai_routing_config` to persist that explicit choice. Researcher, planner, reviewer, and frontend each accept an explicit `same-turn` or `child` dispatch override; implementation remains with the controller. The tool uses separate `set-dispatch`/`reset-dispatch` actions, so changing a dispatch override does not remove its model mapping. Researcher activation is task-gated but not price-aware: its mapping enables the narrow trigger and does not guarantee lower cost. The tool repeats that warning whenever a researcher mapping is shown; Odai must use authoritative provider prices and measured usage instead of inventing either. The user does not edit Agent files, YAML, or JSON and does not add trigger terms to later tasks. Mappings live in `$DSH_HOME/odai/routing.json`, outside the managed preset, so installer updates do not report them as drift. A legacy Executor mapping is ignored without invalidating current responsibilities and is removed on the next configuration write. Audit evidence likewise lives under `$DSH_HOME/odai/session-evidence/` instead of using private DSH session-event types, so changing or removing the preset cannot make a session unreadable. Changes apply from the next user turn. Whenever routing or explicit mapping management needs it, runtime resolves a fresh merged effective-mapping snapshot, with persisted mappings preferred over deployment mappings; the full snapshot enters the model prompt only for mapping-management intent and remains authoritative over stale compaction text. The tool also exposes the latest current-session actual route receipt; configured targets alone never prove that a responsibility ran. If reasoning effort is omitted, the target provider/model uses its own default rather than inheriting the source controller's setting. Plugin and Agent read the same stores when both are deliberately present.

Researcher and frontend are optional evidence/production upgrades whose missing mappings keep the original route without claiming success. A researcher child is limited to a bounded multi-source repository question; technical facts available through controller tools are investigated directly instead of manufacturing a role call. Planner and reviewer are independent optional responsibilities; if a needed one has no mapping, high-impact work fails closed and remains read-only, while lower-impact work continues only where it does not depend on the missing responsibility. Same-turn routes and child outputs require actual request-header evidence. Same-turn researcher, planner, and reviewer are read-only and must return through `odai_responsibility_return` to the controller, which resumes any authorized implementation. Missing handback restores and continues the controller instead of treating the read-only text as final delivery. Deterministic invalid persisted mappings are backed up and exact-match removed; credentials, quota, rate-limit, server, timeout, and transport failures preserve configuration and fall back only for the current call. A generic subagent is not a responsibility route. A manual responsibility child must use an `odai-<responsibility>` label and cannot finish successfully without a matching actual-route receipt. Odai never chooses a model or price on the user's behalf.

## Controller output policy

The Agent defaults to **soft concise** output and shares three controller output modes with the Plugin. A user can naturally ask to inspect or change the mode; `odai_output_config` persists an explicit override in `$DSH_HOME/odai/output.json`:

| Mode | Policy | Behavior |
|---|---|---|
| normal | `concise: false`, no `maxTokens` | use the host's normal presentation and controller budget |
| soft concise (default) | `concise: true`, no `maxTokens` | shorten only the final user-facing presentation without relaxing required results, evidence, risks, blockers, or verification |
| economy (optional) | `concise: true`, positive `maxTokens` | add a provider output-ceiling request; default to `500` when the user names economy without another value, or use the user's supplied positive value |

Natural requests include `use normal output`, `use soft concise output`, `enable economy mode`, and `set economy mode to 1200 tokens`. Removing the persisted override restores soft concise. Existing pre-mode stores that combined `concise: false` with a ceiling remain readable for compatibility, but new named-mode changes cannot create that legacy combination. The selected mode is stable within one turn and changes from the next user turn.

An economy ceiling only tightens an existing lower host request value and is not a locally enforceable hard billing boundary. A provider may count hidden reasoning inside it, exceed or ignore it, or end before useful final text, especially at a high reasoning effort; strict compliance must be checked from per-request usage. Odai enables economy only when requested and never invents a non-default custom value. The mode does not alter child-agent role budgets, compaction, checkpoints, or other internal context; an incomplete token-capped compaction fails closed instead of replacing history.

An authenticated `这个会话放开上限` directive removes only Odai's controller ceiling before the current request and for the rest of that session, without changing the shared output store or exposing the persistent configuration tool; `这个会话恢复输出上限` restores shared-policy inheritance. After a verified ordinary-controller `max-tokens` stop, the immediately following pure `继续` receives one ceiling-free recovery turn. Existing lower host limits, responsibility overrides, other sessions, and revised or new tasks remain unchanged.

A same-provider/model compaction inherits controller reasoning while keeping its independent summary budget. Odai leaves prompt-cache retention unset by default; `ODAI_COMPACTION_CACHE_RETENTION` can explicitly select `short`, `long`, or `none`. `provider-default` means Odai adds no retention, while any explicit incoming retention remains authoritative; configured retention still applies when host routing has already supplied reasoning. Custom preset compositions can set the same value through runtime `compaction.cacheRetention`. The first controller request after a landed summary still rebuilds the changed summary prefix.

## Compaction model

The default compaction-summary model is `inherit`, which preserves the conversation's current provider/model behavior. A user can explicitly set a separate target and optional reasoning effort in natural language, such as `压缩模型用 provider-x/model-summary，推理档 high`; `odai_compaction_config` persists those explicit values in `$DSH_HOME/odai/compaction.json`. Removing the target restores inheritance. Agent and Plugin share the store when both are deliberately present.

The target applies only to future `compaction` summary requests. It does not change the controller, researcher, planner, reviewer, frontend, ordinary conversation, summary output budget, or cache-retention policy. An explicitly configured `reasoningEffort` overrides reasoning only for those summaries. When omitted, existing behavior remains: same-route summaries can inherit controller reasoning, while a cross-model target removes only reasoning proven by equality with the durable controller route and preserves a distinct preselected effort. Each configured target receives one provider-neutral integrity suffix that keeps current facts above superseded/rejected history, preserves continuation-critical opaque values exactly, and self-checks contradictions; duplicate Agent/Plugin runtime instances add it only once. Odai never chooses the provider, model, or reasoning effort on the user's behalf. An invalid store is reported by the tool while runtime requests inherit safely until `set` or `remove` repairs it. The configured stream is buffered until a valid terminal result. Partial failed chunks are discarded before one retry with the untouched inherited request; deterministic invalid persisted targets are backed up and exact-match removed, transient failures preserve them, and DSH retains original history until a complete summary lands.

## Skill sources

The Agent keeps the managed preset's complete skill copy as its `bundled` default, so existing installations do not change behavior. When the user explicitly asks to show, set, or reset the Odai skill source, the controller uses `odai_skill_source_config` and stores the choice in `$DSH_HOME/odai/source.json`, outside the managed preset:

- `bundled`: use the skill shipped with this Agent release.
- `auto`: allow a compatible current-project `.dsh/skills/odai` or `.agents/skills/odai` bundle, then DSH custom roots and newer user installs under `$DSH_HOME/skills/odai` or `$DSH_AGENTS_HOME/skills/odai` (default `~/.agents/skills/odai`), with bundled fallback.
- `user`: ignore project roots and require a compatible custom or user-level bundle. An unusable source produces an explicit bundled fallback diagnostic so it can be repaired through the same tool.

An independent install must be a complete directory bundle containing `SKILL.md`, `manifest.json`, and every manifest-declared file. The runtime checks SemVer 2.0.0 `skillVersion`, an exact supported `runtimeContract`, complete-file SHA-256 integrity, and same-version content conflicts. Prompt governance and routing role contracts are selected atomically for one agent turn; project sources are scoped by that session's cwd, and changes are reconsidered on the next user turn. Explicit deployment `skillPath` or `ODAI_SKILL_PATH` remains highest priority and requires a DSH restart.

## Controlled skill evolution

Explicit user governance refinements live in `$DSH_HOME/odai/skill-evolution`, outside `.agent-presets/odai`. Agent install, update, repair, and uninstall therefore leave them intact; the Plugin reads the same default store when both surfaces are deliberately installed. This overlay is independent of the selected `bundled`/`auto`/`user` source. A custom `governance.evolutionRoot` is a deployment override and must match across Agent and Plugin to remain shared.

`odai_skill_evolution` can propose exact replacements only in existing governance Markdown: `SKILL.md`, `assets/task-state.md`, `assets/routing-roles/*.md`, and `references/*.md`. Manifest changes, executable/runtime files, undeclared paths, symlinks, stale hashes, and untracked edits are rejected. Candidates store immutable base/result snapshots and content-addressed provenance. The first `propose` call writes nothing and returns `PROPOSE ODAI EVOLUTION <proposal-digest>`, bound to the complete proposed input. Retrying that exact proposal writes a candidate only when the current open turn's latest direct-human message contains exactly one text block equal to the phrase, byte for byte.

`propose` and `rebase` never activate. Validation returns a phrase bound to the exact generation. Any `SKILL.md` or `references/dao.md` change, including additive preamble or core-section text, is `breaking`; so is any replacement that does not preserve its old text. These require `ACTIVATE BREAKING ODAI EVOLUTION <generation-id>` instead of the standard activation phrase. Model text and arguments, synthetic messages, multi-block or whitespace-altered text, stale confirmations, and other action or generation phrases cannot authorize writes. Audit evidence is derived from the authenticated session event, not supplied by the model. The tool stays discoverable without an unconditional evolution system-prompt section.

An active generation survives package updates. When its base differs from the newly bundled upstream, Odai keeps the active result visible with `rebaseRequired`; clean rebases produce another inactive candidate, while conflicts preserve base/ours/theirs evidence and do not change the pointer. Rebase is generation-bound. Rollback and deactivation phrases also bind the current active generation, preventing stale pointer authorization. `rollback` is limited to a previously active validated generation. Child agents cannot use this tool. Stop DSH before updating the Agent and restart it so the process loads the new bundled bytes. Explicit `skillPath`/`ODAI_SKILL_PATH` bypasses evolution, and `ODAI_DISABLE_EVOLUTION=1` provides an emergency startup bypass without deleting state.

## Status and uninstall

```sh
npx odai-dsh-agent status
npx odai-dsh-agent status --json
npx odai-dsh-agent uninstall
```

`status` reports `absent`, `installed`, or `drifted`. Update and uninstall fail closed when managed files were changed or unmanaged files were added. Normal preset removal does not inspect or rewrite historical sessions and does not accept `--yes`; legacy session repair is a separate Plugin command. Uninstall also refuses while `agent-presets.default` still names `odai`; select another default first so the next session cannot fail on a missing preset. Stop DSH before install, update, or uninstall so preset files are not being loaded concurrently.

## Plugin versus Agent

Choose either package or install both when their scopes are useful:

- `odai-dsh-plugin`: profile-wide governance for every preset in that profile.
- `odai-dsh-agent`: selectable Odai governance for sessions using this preset.
- both: supported even when users arrive at the combination independently; Plugin provides the single Control Center surface while the Agent preset remains selectable.

When both are present, a process-shared per-agent/per-turn skill snapshot keeps prompt governance and role contracts identical, the compatibility-safe evidence store deduplicates tool and route records, host RPC registration is reference-counted, and denials remain monotonic. Removing either package leaves the other package and shared routing/evidence stores usable. Neither package installs or changes the provider-neutral `odai-cli`.

## Development

`dsh/runtime/` and `skills/odai/` remain the only editable sources. `npm pack` generates the preset's `runtime/` and `skills/` directories and removes them immediately afterward:

```sh
npm --prefix dsh/agent test
npm --prefix dsh/agent run verify:dsh
npm --prefix dsh/agent run pack:dry-run
```

The DSH verification uses a temporary home and one isolated Web process. It creates standard and Odai sessions, proves the canonical prompt appears only for Odai, dispatches `odai_routing_config` through the live Odai session and checks its persisted mapping, and proves the child write guard does not leak into the standard preset.
