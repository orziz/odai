# odai dsh agent

`odai-dsh-agent` installs a selectable, session-scoped Odai Agent preset for DeepSeek Harness (`dsh`). It is independent from the profile-wide `odai-dsh-plugin`: the preset does not activate global governance.

DSH `0.1.7` registers agent presets only from profile bundle declarations; it no longer scans `$DSH_HOME/.agent-presets`. The package is therefore a DSH bundle. Installing it into a profile (default `web`) through DSH's plugin manager applies two patches:

```text
odai-dsh-agent/
  preset.cordis.patch.yml          declares the `odai` preset (`@deepseek-ai/dsh-agent-preset`)
  control-center.cordis.patch.yml  adds the Control Center
  preset/odai/odai-governance.mjs  scoped Odai runtime entry (exported as odai-dsh-agent/governance)
  preset/odai/runtime/*.mjs
  preset/odai/skills/{odai,odai-orchestration}/**
```

The preset id stays `odai`, so sessions saved with it keep resolving after an upgrade. In DSH's Plugins page the whole bundle and its Control Center row can be switched on and off; the preset declaration and the rows inside the preset are read-only there, because DSH does not let its plugin manager edit a preset's composition.

Odai owns its composition and capability set, with a scoped runtime in default `auto` mode. The `0.2.38` candidate admits DSH `>=0.1.7-rc.1`, including later prereleases; its npm peer is `*` to avoid a package-manager prerelease allow-list. Only `0.1.7-rc.1` is currently verified. A newer version alone is not a refusal, but the host still must provide the bundle registry, workflow engine and runtime services. It follows three Standard changes in that release: the workflow engine is `@deepseek-ai/dsh-workflow-ptc` (the worker-thread engine was removed), `ralph` is disabled by default, and the plugin-manager tool row is present but disabled. Standard is an upstream reference, not a required composition: release checks load Odai against the real host and verify scoped tool/prompt behavior rather than requiring text equality with Standard.

 Host-owned persistence, sandbox, approval, registries, and base controller selection remain in the selected DSH profile. Ordinary requests stay on that controller. Responsibility words are optional signals rather than commands: evidence-grounded task-state gaps route at any step, the gap tool records rather than claims a route start, terminal decisions consume the proposal, an incomplete reviewer proposal waits for changed native evidence, and an identical planner/controller model remains inline without another model call. After planner handback, the controller resumes implementation only when the current user task authorizes it; plan-only, new-task, expanded-scope, and unknown authorization remain non-implementing. Reviewer children require a current hash-addressed schema 3 evidence packet whose diff is newer than the last write and whose latest successful test or read-only check follows the last write; viewing a diff does not itself invalidate an earlier successful check. The packet binds to the authenticated direct-user task when available, excludes all prior-task session events, records its boundary in route evidence, and fails closed if an explicit task binding cannot be resolved uniquely. An incomplete packet keeps the current controller route, reports why native evidence was excluded, suppresses unchanged repeat notices, and reassesses the pending proposal after decisive evidence changes without claiming independent acceptance or terminating the authorized task. Every route is resolved before provider I/O; deterministic invalid persisted mappings are backed up and exact-match removed, while recoverable provider failures preserve them. Frontend route failure becomes an explicit local controller fallback without a routed receipt. `execute` remains an explicit comparison mode and `observe` changes no model or child while retaining fail-closed high-impact protection. Configured compaction streams are buffered so partial failed output cannot contaminate the inherited-route retry or replace original history.

DSH `0.1.5-rc.1` provides native bidirectional `send_message` between adjacent continuable parent/child Agents. Odai retains the controller's native collaboration tools; its read-only children expose only their allowed tools and return bounded results through the responsibility mechanism. DSH owns durable child identity, cold resume, admission, and explicit invalid/unavailable-target failures; Odai does not replace an invalid id or treat delivery as responsibility acceptance.

The preset includes the same local long-term semantic memory runtime as the Plugin. Default `auto` mode performs no hidden model call: it automatically captures only high-confidence durable statements from the direct-human message authenticated by the latest open-turn session event, keeps ambiguous or conflicting candidates inert, and recalls only bounded active global/project records as untrusted historical context. Matching direct intent, or the compact capability gateway on a later step, exposes the controller-only `odai_memory` tool for inspection, search, confirmation, correction, physical forgetting, exact-phrase clearing, and `auto`/`off` mode changes. Recognized secrets, contact identifiers, health/crisis content, temporary instructions, hypotheses, quotes, and code are rejected; the current user and project authority always override memory. State lives at `$DSH_HOME/odai/memory/store.json`, outside the package, so install, update, and uninstall preserve it. An invalid or symlinked store fails closed. The matcher is not a replacement for protecting the underlying DSH session history from sensitive input.

Non-crisis care and crisis safety are separate. `references/care.md` owns fatigue, anxiety, self-doubt, rumination, shame, fear of mistakes, negativity, reduced agency, and user-controlled 阿岱/欧黛 styles without diagnosis, scoring, persistence, or model routing. `references/human-safety.md` owns sustained or worsening low mood, hopelessness, burden, self-harm, suicide, and immediate danger; any credible current inclination triggers timely care and a direct safety check even without a plan, while plan, means, and action determine urgency.

Human-safety continuity is an independent explicit-consent store at `$DSH_HOME/odai/human-safety-continuity.json`, not a hidden health profile and not semantic memory. `odai_human_safety_continuity` accepts only the authenticated current direct user's request to save, inspect, export, correct, remove, or physically clear user-authored care preferences, signals they want noticed, support they say helps, and safety-plan steps. Added or replacement text must occur exactly in that message; credentials and contact details are rejected, and entries persist until the user removes or physically clears them. New controller sessions receive the minimal historical record only when the current conversation independently makes care, crisis support, or record management relevant, never as proof of current risk, diagnosis, or a score; children cannot inspect it or receive its prompt data.

Ordinary requests retain the complete canonical governance plus compact responsibility and capability-discovery tools. Low-frequency control and care schemas are exposed per agent only for matching direct intent; uncommon wording can request the specialized capability on the next step, and unsupported hosts fall back to the complete tool catalog instead of dropping behavior.

## Install

With DSH `0.1.7-rc.1` installed, run:

```sh
npx odai-dsh-agent install [--profile web] [--dsh-home /path/to/dsh-home]
```

The installer checks `dsh -V` (the `0.2.38` candidate accepts `>=0.1.7-rc.1`, including later prereleases, without an upper version cap; published `0.2.37` targets `0.1.5-rc.2` and keeps its copied-preset installer), then runs `dsh plugin --profile <profile> add odai-dsh-agent@<version> --save-exact`. DSH's plugin manager checks the package's DSH peer before downloading anything. The package already contains the canonical skills and runtime; it does not require the Plugin. Restart the DSH Web process after a profile change, open a new session, and select `odai 治理模式` in the preset picker. Existing sessions keep the composition they started with.

DSH `0.1.7` does not carry the earlier `agent-presets.default` setting forward. To make odai the default preset again, choose it as the default in DSH; the choice is saved in the profile's own `cordis.patch.yml`.

Uninstall reads the host's non-booting `--dump-config` output, including bundle, profile and home layers. It follows `modeSelectionEnabled`, `selectedDefault` and `default` precedence, refusing removal when Odai is the effective default or the relevant configuration cannot be determined without evaluating code.

The preset's `package.json` must contain the `#odai-contracts` import map and its orchestration entry must exist; missing or invalid metadata is `partial-drift` and requires repair. Status is `current` only when the profile dependency is this installer's exact registry version, the resolved package reports that version, the bundle entry occurs exactly once, and the preset patch, governance entry, runtime, skills, Control Center host and client exist. Other states are `absent`, `registry-upgrade`, `local-link`, `partial-drift`, `newer`, and `unknown-source`; install repairs or upgrades them and refuses a silent downgrade. Profile operations serialize through an owner-token lock. If a plugin-manager command fails without changing profile bytes, the installer reports the unchanged state; if bytes changed, it does not run a destructive inverse command. It preserves the current state and retains before/after recovery evidence under `$DSH_HOME/odai/control-center-backups/`.

DSH bundles run in-process with the host's privileges, so install only reviewed package versions. Normal install, update, and uninstall do not scan, rewrite, or migrate historical session logs.

## Control Center

The Control Center ships inside the same bundle. It adds one Chinese launcher to DSH Web with a current-turn responsibility graph, session evidence timeline, structured event inspector, and routing controls for the four optional responsibilities. The controller remains host-managed and read-only. Routing writes use the same validated, locked, atomic routing action as the conversation tool and apply on the next user turn. Configured models alone are never displayed as execution evidence. A native-collaboration summary shows observed `subagent`/`subagent_fork` tool receipts; these are not named-role model verification or child completion evidence.

The earlier `control-center install|status|uninstall` commands remain as aliases for `install|status|uninstall`. `--with-control-center` and `--without-control-center` are accepted and ignored; disable the Control Center row in the Plugins page instead.

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

The controller calls `odai_routing_config` to persist that explicit choice. Researcher, planner, reviewer, and frontend each accept an explicit `same-turn` or `child` dispatch override; the controller owns integration, validation, and final delivery. Children remain read-only; explicitly delegated patch preparation returns unapplied proposals, while research, planning, and review keep their narrower contracts. The tool uses separate `set-dispatch`/`reset-dispatch` actions, so changing a dispatch override does not remove its model mapping. Researcher activation is task-gated but not price-aware: its mapping enables the narrow trigger and does not guarantee lower cost. The tool repeats that warning whenever a researcher mapping is shown; Odai must use authoritative provider prices and measured usage instead of inventing either. The user does not edit Agent files, YAML, or JSON and does not add trigger terms to later tasks. Mappings live in `$DSH_HOME/odai/routing.json`, outside the package, so updates never replace them. A legacy Executor mapping is ignored without invalidating current responsibilities and is removed on the next configuration write. Audit evidence likewise lives under `$DSH_HOME/odai/session-evidence/` instead of using private DSH session-event types, so changing or removing the preset cannot make a session unreadable. Changes apply from the next user turn. Whenever routing or explicit mapping management needs it, runtime resolves a fresh merged effective-mapping snapshot, with persisted mappings preferred over deployment mappings; the full snapshot enters the model prompt only for mapping-management intent and remains authoritative over stale compaction text. The tool also exposes the latest current-session actual route receipt; configured targets alone never prove that a responsibility ran. If reasoning effort is omitted, the target provider/model uses its own default rather than inheriting the source controller's setting. Plugin and Agent read the same stores when both are deliberately present.

Researcher and frontend are optional evidence/production upgrades whose missing mappings keep the original route without claiming success. A researcher child is limited to a bounded multi-source repository question; technical facts available through controller tools are investigated directly instead of manufacturing a role call. Planner and reviewer are independent optional responsibilities; if a needed one has no mapping, high-impact work fails closed and remains read-only, while lower-impact work continues only where it does not depend on the missing responsibility. Same-turn routes and child outputs require actual request-header evidence. Same-turn researcher, planner, and reviewer are read-only and must return through `odai_responsibility_return` to the controller, which resumes any authorized implementation. Missing handback restores and continues the controller instead of treating the read-only text as final delivery. Deterministic invalid persisted mappings are backed up and exact-match removed; credentials, quota, rate-limit, server, timeout, and transport failures preserve configuration and fall back only for the current call. Matching responsibilities use `odai_responsibility_gap` to honor configured models, dispatch, and evidence gates. A generic subagent is not a responsibility route. Exceptional manual planner/frontend children use the native tool's `description` prefix `odai-planner:` or `odai-frontend:` and require a matching actual-route receipt; researcher/reviewer require managed evidence validation. Local child routing receipts reach the parent's Control Center under the corresponding role, without claiming task completion. Odai never chooses a model or price on the user's behalf.

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

The target applies only to future `compaction` summary requests. It does not change the controller, researcher, planner, reviewer, frontend, ordinary conversation, summary output budget, or cache-retention policy. An explicitly configured `reasoningEffort` overrides reasoning only for those summaries. When omitted, existing behavior remains: same-route summaries can inherit controller reasoning, while a cross-model target removes only reasoning proven by equality with the durable controller route and preserves a distinct preselected effort. Configured, inherited, and fallback requests receive one provider-neutral integrity suffix preserving the full objective, unfinished requirements, unknown action outcomes, current facts, and exact continuation-critical values; duplicate Agent/Plugin runtime instances add it only once. Odai never chooses the provider, model, or reasoning effort on the user's behalf. An invalid store is reported by the tool while runtime requests inherit safely until `set` or `remove` repairs it. The configured stream is buffered until a valid terminal result. Partial failed chunks are discarded before one retry with the untouched inherited request; deterministic invalid persisted targets are backed up and exact-match removed, transient failures preserve them, and DSH retains original history until a complete summary lands.

## Skill sources

The Agent keeps the bundle's complete skill copy as its `bundled` default, so existing installations do not change behavior. When the user explicitly asks to show, set, or reset the Odai skill source, the controller uses `odai_skill_source_config` and stores the choice in `$DSH_HOME/odai/source.json`, outside the package:

- `bundled`: use the skill shipped with this Agent release.
- `auto`: allow a compatible current-project `.dsh/skills/odai` or `.agents/skills/odai` bundle, then DSH custom roots and newer user installs under `$DSH_HOME/skills/odai` or `$DSH_AGENTS_HOME/skills/odai` (default `~/.agents/skills/odai`), with bundled fallback.
- `user`: ignore project roots and require a compatible custom or user-level bundle. An unusable source produces an explicit bundled fallback diagnostic so it can be repaired through the same tool.

`auto` grants compatible project/custom bundles authority to replace the complete governance body, including crisis-safety references. Compatibility and content hashes do not certify their semantics. This is distinct from `.odai/local.md`, which cannot replace governance. Choose `user` to skip project discovery roots while using trusted user/custom installations (including compatible older versions), or keep `bundled` to prevent external replacement.

An independent install must be a complete directory bundle containing `SKILL.md`, `manifest.json`, and every manifest-declared file. The runtime checks SemVer 2.0.0 `skillVersion`, an exact supported `runtimeContract`, complete-file SHA-256 integrity, and same-version content conflicts. Prompt governance and routing role contracts are selected atomically for one agent turn; project sources are scoped by that session's cwd, and changes are reconsidered on the next user turn. Explicit deployment `skillPath` or `ODAI_SKILL_PATH` remains highest priority and requires a DSH restart.

The `0.2.38` source candidate bundles governance `0.7.1` (schema `5`, runtime contract `9`) and `odai-orchestration` `0.2.0` (schema `1`). Published `0.2.37` bundles governance `0.7.0` with the same schemas, runtime contract, and orchestration version. Governance has no role or orchestration dependency. The bundle carries both skills and its own trusted compiler, combining separate source digests into one immutable turn snapshot; it never executes external scripts or discovers neighboring orchestration. Incompatible older sources fall back visibly without rewriting their files; an incompatible explicit `skillPath` fails fast.

## Retired skill evolution

Releases before `0.2.37` could refine both governance and orchestration Markdown in `$DSH_HOME/odai/skill-evolution`. Published `0.2.37` retired that overlay together with `odai_skill_evolution`, `ODAI_DISABLE_EVOLUTION`, and `governance.evolutionRoot`; the `0.2.38` candidate preserves that retirement. Previously active refinements stop taking effect after upgrading and restarting DSH. The runtime no longer reads the store, no package install, update, repair, or removal deletes it, and a leftover `evolutionRoot` is ignored.

To retain governance customizations, start with a complete schema `5` / contract `9` user-level bundle, review and apply the desired rules, assign a distinct valid SemVer `skillVersion`, then ask Odai to set the source to `user`. Modified content retaining this candidate's bundled version `0.7.1` falls back with `same-version-content-conflict`; changing only build metadata is insufficient. On the next turn verify the actual canonical source, version and governance digest, not just the saved setting. Explicit deployment paths take precedence.

External selection cannot restore orchestration refinements or generation activation, rebase and rollback. DSH retains its packaged orchestration; the old store has no automatic migration or export. Keep it unchanged and follow the [governance migration and recovery steps](https://github.com/orziz/odai/blob/main/dsh/README.md#migrating-retired-skill-evolution).

## Status, uninstall, and the old preset directory

```sh
npx odai-dsh-agent status [--json]
npx odai-dsh-agent uninstall
npx odai-dsh-agent cleanup-legacy
```

`status` reports the bundle state and, separately, whether a preset directory copied by an earlier release still exists at `$DSH_HOME/.agent-presets/odai`. DSH `0.1.7` no longer reads that directory; the installer leaves it untouched. `cleanup-legacy` moves it into `$DSH_HOME/odai/legacy-preset-backups/<timestamp>/` instead of deleting it, so local edits survive; it touches no sessions, memory, routing, or other Odai data.

`uninstall` removes the bundle through DSH's plugin manager. It refuses while the profile still selects `odai` as the default preset; choose another default first so new sessions cannot fail on a missing preset. Removing the bundle does not delete routing configuration, memory, or session evidence.

## Plugin versus Agent

Choose either package or install both when their scopes are useful:

- `odai-dsh-plugin`: profile-wide governance for every preset in that profile.
- `odai-dsh-agent`: selectable Odai governance for sessions using this preset.
- both: supported even when users arrive at the combination independently; Plugin provides the single Control Center surface while the Agent preset remains selectable.

When both are present, a process-shared per-agent/per-turn skill snapshot keeps prompt governance and role contracts identical, the compatibility-safe evidence store deduplicates tool and route records, host RPC registration is reference-counted, and denials remain monotonic. Removing either package leaves the other package and shared routing/evidence stores usable. Neither package installs or changes the provider-neutral `odai-cli`.

## Development

Shared runtime, canonical governance, and Control Center client sources live in `dsh/runtime/src/`, `skills/odai/`, and `dsh/client/src/`; Agent installer sources live in `dsh/agent/src/`. `npm pack` generates the preset's `runtime/` and `skills/` directories plus the package's `client/` directory, then removes those generated copies:

```sh
npm --prefix dsh/agent test
npm --prefix dsh/agent run verify:dsh
npm --prefix dsh/agent run pack:dry-run
```

The DSH verification uses a temporary home and one isolated Web process. It creates standard and Odai sessions, proves the canonical prompt appears only for Odai, dispatches `odai_routing_config` through the live Odai session and checks its persisted mapping, and proves the child write guard does not leak into the standard preset.
