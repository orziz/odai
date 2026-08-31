# odai dsh plugin

`odai-dsh-plugin` is the profile-wide Odai bundle for DeepSeek Harness (`dsh`). Install it when every agent preset in one DSH profile should receive Odai governance and routing. It does not install or select the separate Odai Agent preset, and it leaves the provider-neutral `odai-cli` runtime unchanged.

The bundle contributes:

- canonical `skills/odai/SKILL.md` governance as a system-prompt section;
- deterministic routing that keeps ordinary work on the current controller, upgrades configured contextual decision gaps in place, and delegates only genuine independent gaps;
- monotonic write boundaries for child agents and unresolved high-impact controller turns;
- durable route decisions, upgrades, child outcomes, protections, policy denials, and compact tool outcomes stored outside DSH's core session-event vocabulary;
- actual controller/child provider-model evidence, fail-closed high-impact failures, and direct fallback only where it is safe;
- configurable compaction calls: summaries inherit the conversation provider/model by default, a user may persist a separate explicit target and optional reasoning effort, omitted reasoning keeps same-route inheritance and cross-model isolation, and retention stays at the provider default unless explicitly configured;
- a default soft-concise controller output policy, an explicit normal-mode escape, and an optional user-selected economy ceiling without changing child-agent, compaction, checkpoint, or other internal context budgets;
- local, scoped long-term semantic memory with automatic high-confidence candidate discovery, inert pending candidates, bounded relevant recall, provenance, conflict/supersession handling, and physical forget/clear controls without hidden model calls;
- separate non-crisis care and crisis-safety contracts plus an explicit, user-controlled cross-session continuity record that never profiles current mood or reaches child agents;
- adaptive agent-scoped prompt/tool exposure with a compact capability gateway, preserving uncommon-intent recovery while removing low-frequency control schemas from ordinary requests;
- task-state responsibility gaps, inline same-model planner reuse, controller-owned implementation after planner handback, complete current reviewer evidence with controller-local incomplete-packet fallback, formal model-route preflight, and buffered compaction fallback without partial-output contamination.

## Install

Install the package into only the profile that should receive Odai. DSH's plugin manager requires `pnpm` on `PATH`:

```sh
dsh plugin --profile web add odai-dsh-plugin
```

The package declares `dsh.bundle`, so DSH adds it to that profile's bundle stack. It already contains the canonical Odai skill and runtime; a separate skill install is optional and remains inactive until the user explicitly changes the source mode. Do not install the Agent package separately for ordinary Plugin use. Start a new DSH process after installation. Agent-only users should install `odai-dsh-agent` instead; that package is self-contained and does not activate this bundle.

Odai audit evidence is stored under `$DSH_HOME/odai/session-evidence/`, not as private event types in DSH's core session log. This keeps every session written by the current Plugin readable when the Plugin is removed or upgraded.

## Long-term semantic memory

The Plugin and Agent share `$DSH_HOME/odai/memory/store.json`; neither package installer owns or removes it. Default `auto` mode runs once at controller step 1 and makes no provider, model, embedding, subagent, or compaction call. It reads only the direct-human message authenticated by the latest open-turn session event, automatically activates mechanically explicit standing preferences, settled decisions, and constraints, and rejects questions, quoted/code examples, reported speech, hypotheses, temporary instructions, recognized secrets/contact identifiers, and sensitive personal categories. Less explicit controller-discovered candidates require an exact current-message excerpt and remain pending until independent repetition or explicit confirmation.

Project scope uses a canonical-path hash and never exposes a raw path in the store key; global scope requires explicit global/all-project wording. Only active records are recalled, with deterministic relevance and size limits, as untrusted plugin context below the current human request and project authority. Pending conflicts suppress a stale active record rather than silently resolving it. `odai_memory` supports bounded inspect/search plus grounded consider, confirm, correct, physical forget, and exact-phrase bulk clear. Every action is controller-only. An invalid or symlinked store disables capture and recall; inspect reports the invalid state, and only an exact global-clear authorization can physically reset invalid content. Natural-language mode changes persist `auto` or `off` for the next turn; deployment config may also set `memory.mode`, `memory.storePath`, and a retrieval count from 1 to 12. Deployment `memory.mode: off` is a hard disable and cannot be overridden by a persisted user setting.

The sensitive-data matcher is a fail-closed admission layer for recognized forms, not a general data-loss-prevention product. Store reads use no-follow semantics where the platform exposes them, writes are atomic, and directory identities are checked around operations. These checks protect normal operation and reject static path substitution; they are not a security boundary against malicious code already running under the same OS account, which can also replace the installed runtime or inspect DSH session data. Do not place credentials or private personal data in chat expecting memory filtering to sanitize the underlying DSH session history.

## Care, crisis safety, and continuity

`references/care.md` owns non-crisis fatigue, anxiety, self-doubt, rumination, shame, fear of mistakes, negativity, reduced agency, and the user-controlled 阿岱/欧黛 response styles. It lowers burden without diagnosis, scoring, persistence, or model routing. `references/human-safety.md` owns sustained or worsening low mood, hopelessness, burden, self-harm, suicide, and immediate danger. Any credible self-harm or suicide inclination is not dismissed for lacking a plan: present-safety confirmation and support connection begin first, while plan, means, action, and immediacy determine emergency escalation. The same controller remains the user-channel owner and avoids methods, concealment guidance, hidden classifiers, and risk scores.

Cross-session continuity is not generic semantic memory. The controller-only `odai_human_safety_continuity` tool manages `$DSH_HOME/odai/human-safety-continuity.json` only from an authenticated explicit direct-user request. It stores at most four kinds of user-authored entry: care preferences, signals the user wants noticed, support the user says helps, and user-authored safety-plan steps. Add/replace text must be exact current-message text; credentials and contact details are rejected. The record can be shown, exported, corrected, removed entry by entry, or physically cleared; entries persist until one of those deletion controls is used. It is injected only when the current controller conversation independently makes care, crisis support, or record management relevant, never as current-risk evidence and never into child prompts. Package lifecycle commands do not own or delete it.

Older releases wrote `odai/*` audit records into DSH's core log without its official `ignorable: true` envelope marker. Stop every DSH process before updating or removing an older Plugin, then run the explicit compatibility repair:

```sh
npx odai-dsh-plugin repair-sessions --yes
```

The repair adds only that marker to the eight audit event types written by historical Odai releases; it does not remove messages or audit payloads. An unknown unmarked `odai/*` type is refused rather than guessed to be ignorable. `DSH_HOME` is honored; use `--dsh-home /path/to/dsh-home` for another home and `--json` for a machine-readable report. It handles both `session.jsonl` and DSH's concatenated-frame `session.jsonl.zstd` format, verifies every rewritten artifact, replaces it atomically, and retains a content-addressed backup beside each changed log. `--yes` is not the only guard: the command also inspects local process command lines and refuses when that check fails or any DSH process is active. If an artifact changes during preparation or contains malformed committed data, that artifact is not rewritten and the command reports a failure. Do not restart DSH until the whole migration exits because historical runtimes do not participate in a migration lock.

## Skill sources

Existing installations stay pinned to `bundled`, the complete skill copy shipped with this Plugin. A user can naturally ask Odai to show, set, or reset its skill source; the controller uses `odai_skill_source_config` and persists the explicit choice in `$DSH_HOME/odai/source.json`. Users do not edit Plugin files or configuration stores. The available modes are:

- `bundled`: always use the version shipped with the installed Plugin release.
- `auto`: check the current project's `.dsh/skills/odai` and `.agents/skills/odai`, then DSH custom skill roots, `$DSH_HOME/skills/odai`, and `$DSH_AGENTS_HOME/skills/odai` (default `~/.agents/skills/odai`), with bundled fallback. A valid compatible project/custom bundle may intentionally pin another version. A user-level bundle must be newer than bundled.
- `user`: ignore project roots and require a compatible custom or user-level bundle. If none is usable, Odai keeps bundled governance visible with an explicit fallback diagnostic so the user can recover through the same tool.

Every independently installed Odai skill must be a complete directory bundle with `SKILL.md`, `manifest.json`, and every file named by the manifest. The runtime requires a supported `runtimeContract`, uses SemVer 2.0.0 for `skillVersion`, hashes every declared file, rejects same-version/different-content conflicts, and continues past invalid candidates. A selected bundle supplies both the canonical prompt and researcher/planner/reviewer/frontend role contracts as one immutable per-turn snapshot. Project choices are scoped by the session cwd, Plugin and Agent share one selection when deliberately combined, and a setting or skill update is reconsidered on the next user turn. Explicit deployment `skillPath` or `ODAI_SKILL_PATH` remains highest priority and requires a DSH restart.

## Controlled skill evolution

Odai can preserve explicit user governance refinements outside the npm package in `$DSH_HOME/odai/skill-evolution`. This is separate from the `bundled`/`auto`/`user` source setting: package install, update, repair, and removal never rewrite or delete the evolution store, and Agent and Plugin use the same default store. A deployment that explicitly configures `governance.evolutionRoot` must use the same path for both surfaces to retain that sharing.

`odai_skill_evolution` accepts exact textual replacements only in existing `SKILL.md`, `assets/task-state.md`, `assets/routing-roles/*.md`, and `references/*.md` files. It rejects manifest edits, undeclared files, scripts, runtime JavaScript, symlinks, devices, path escapes, stale file hashes, and untracked changes. Each generation stores immutable base and result bundles plus content-addressed provenance; changing its bundle, metadata, or lineage makes validation fail closed.

Every write is two-party authorized from the DSH session log. The first `propose` call only normalizes and hashes the objective, current bundle digest, paths, file hashes, and replacements; it does not create the store and returns `PROPOSE ODAI EVOLUTION <proposal-digest>`. Retrying the identical proposal writes a candidate only when the current open turn's latest direct-human `user/message` consists of exactly one text block whose raw text equals that phrase. No trimming, multi-block concatenation, old-turn replay, model argument, synthetic message, or model-supplied evidence is accepted. New generation provenance and pointer history derive their audit evidence from that authenticated event's turn, sequence, message ID, action, and phrase.

`propose` and `rebase` create inactive candidates. `validate` replays their patches and returns an activation phrase bound to that exact generation. Any `SKILL.md` or `references/dao.md` change, or any replacement that does not preserve its old text, is classified `breaking` and requires `ACTIVATE BREAKING ODAI EVOLUTION <generation-id>` instead of the standard `ACTIVATE ODAI EVOLUTION <generation-id>`. This conservative file-level rule includes frontmatter, preamble, every core section, and added conflicting instructions without coupling evolution to the canonical release validator's current wording.

Activation never changes the current turn's prompt or role contracts; the next user turn receives one evolved snapshot. After a package update, an older active generation remains available but is visibly marked `rebaseRequired`; a conflict preserves base/ours/theirs evidence without moving the active pointer. Rebase requires `REBASE ODAI EVOLUTION <generation-id>`. Rollback requires `ROLLBACK ODAI EVOLUTION <current-id> TO <target-id|BUNDLED>`, and deactivation requires `DEACTIVATE ODAI EVOLUTION <current-id>`, so stale source generations and cross-action phrases fail. `rollback` can select only a previously active validated generation. Child agents cannot use the tool. Direct evolution intent exposes the tool immediately; uncommon wording can request it through the compact capability gateway on the next step. No write is possible without the matching current-turn human phrase.

A running DSH process keeps the bundled bytes loaded at startup, so update Plugin files only while DSH is stopped and restart to expose the new upstream. Explicit `skillPath`/`ODAI_SKILL_PATH` disables the evolution overlay. Set `ODAI_DISABLE_EVOLUTION=1` before starting DSH for an emergency read-only bypass without deleting the store.

## Controller output policy

Plugin and Agent share three controller output modes. The package default is **soft concise**; users can ask naturally to inspect or change the mode, and `odai_output_config` persists an explicit override in `$DSH_HOME/odai/output.json`:

| Mode | Policy | Behavior |
|---|---|---|
| normal | `concise: false`, no `maxTokens` | restore the host's normal presentation and controller budget |
| soft concise (default) | `concise: true`, no `maxTokens` | shorten only the final user-facing presentation while retaining required results, evidence, risks, blockers, and verification |
| economy (optional) | `concise: true`, positive `maxTokens` | add a provider output-ceiling request; use `500` when the user names economy without another value, or the user's supplied positive value |

For example, users can say `use normal output`, `use soft concise output`, `enable economy mode`, or `set economy mode to 1200 tokens`. Removing the persisted override restores soft concise. Existing pre-mode stores that combined `concise: false` with a ceiling remain readable for compatibility, but new named-mode changes cannot create that legacy combination. A changed mode is snapshotted for one agent turn and applies from the next user turn.

An economy `maxTokens` value applies to controller conversation-model requests and only tightens an existing lower host request value. It is not a locally enforceable hard billing boundary: a provider may count hidden reasoning inside it, exceed or ignore it, or stop before a usable final response. Strict compliance must be established from per-request usage rather than the outgoing request header. The canary runner reports `provider_output_ceiling` evidence and can fail a provider certification run with `--require-output-ceiling-compliance`. Odai enables economy only when the user requests it and never invents a non-default custom value. Child-agent role limits and DSH compaction remain independent; compaction keeps its own completeness instruction and budget, and a token-capped incomplete checkpoint fails closed instead of replacing session history.

`这个会话放开上限` is handled as an authenticated session-scoped directive before generation: it removes only Odai's controller ceiling for the current and later turns in that session without changing `$DSH_HOME/odai/output.json` or exposing the persistent configuration tool; `这个会话恢复输出上限` returns to the shared policy. A verified ordinary-controller `max-tokens` stop also allows the immediately following pure `继续` to bypass the Odai ceiling for one recovery turn. Neither path removes a lower host request limit, changes a responsibility override, or treats a revised/new task as continuation.

## Compaction model

Compaction summaries inherit the conversation's current provider/model by default. A user may explicitly choose a separate target and optional reasoning effort in natural language, for example, `压缩模型用 provider-x/model-summary，推理档 high`; the controller calls `odai_compaction_config`, which persists those explicit values in `$DSH_HOME/odai/compaction.json`. The same tool shows the effective target or removes it to restore inheritance. Plugin and Agent share this store, and Odai never invents a provider, model, or reasoning effort.

A configured target affects only future compaction-summary requests. Controller and responsibility routes, normal conversation, the independent summary output budget, and cache retention remain unchanged. An explicitly configured `reasoningEffort` overrides reasoning only for those summaries. When omitted, same-route summaries may inherit the controller reasoning effort; a cross-model target removes only an effort matching the durable controller route, while a distinct preselected effort remains authoritative because the request envelope exposes no stronger provenance. Each configured target receives one provider-neutral integrity suffix that keeps current facts above superseded/rejected history, preserves continuation-critical opaque values exactly, and self-checks contradictions; duplicate Agent/Plugin runtime instances add it only once. An invalid store is reported by the tool while runtime requests inherit safely until `set` or `remove` repairs it. The configured stream is buffered until a valid terminal result; partial failed chunks are discarded before one retry with the untouched inherited request. A deterministic invalid persisted target is backed up and exact-match removed, transient failures preserve it, and DSH history remains unchanged until a complete summary lands.

## Routing modes

- `off`: disable task routing while retaining canonical governance, the child boundary, and user-requested responsibility configuration.
- `observe`: calculate and record the route without changing model or starting a child. The controller receives a local responsibility protocol requiring decisive evidence, unresolved assumptions, concrete evidence-gathering steps, and explicit decision criteria. A high-impact gap additionally makes the controller read-only for that turn.
- `auto` (default): ordinary work stays on the configured controller. Responsibility names are optional lexical signals, never passwords; a structured, evidence-referenced task-state gap can route at any step. Submitting the tool records a proposal rather than claiming a route started; terminal decisions consume it, while an incomplete reviewer proposal remains pending until decisive evidence changes. Researcher, planner, reviewer, and frontend each accept an explicit `same-turn` or `child` dispatch override; implementation remains with the controller. Without an override, legacy auto defaults remain: bounded multi-source research and independent reviewer acceptance use children, while planner, frontend, and incomplete reviewer checks stay in the controller turn. An identical planner/controller mapping is inline and adds no second model call. After planner handback, the controller resumes implementation only when the current user task authorizes it; plan-only, new-task, expanded-scope, or unknown authorization remains non-implementing. Frontend mapping failure is disclosed before generation and falls back locally without a routed receipt. Reviewer starts an independent child only from a current hash-addressed packet with direct-user acceptance evidence, identifiable diff newer than the last write, and a latest successful test that follows that diff. The collector decodes both rc.7 object arguments and rc.1/rc.2 JSON-string arguments, ignores raw stream chunks when bounding evidence, accepts same-session evidence from external working directories, and reports safe exclusion diagnostics; `evidenceRefs` remain audit references and cannot manufacture tool evidence.
- `execute`: preserve the legacy experimental delegation defaults for comparison or installations that explicitly require separation. Unless a per-role dispatch override says otherwise, planner gaps and reviewer gaps with a complete hash-addressed evidence packet call the configured DSH subagent provider (`spawn` by default), verify the child route, inject its result, and dispose the run. An incomplete reviewer packet starts no child, records `evidence-packet-missing`, remains pending without repeated notices for unchanged evidence, and is reassessed after decisive evidence changes.

The package ships no researcher, planner, reviewer, or frontend model mapping. Each responsibility is optional and configured independently only by an explicit user choice. There is no startup warning for an unused responsibility. When a real gap needs an unconfigured responsibility, Odai states which one is missing, confirms that no such model was called, and asks the user to name the provider, model, and optional reasoning effort naturally. For example:

```text
证据调查用 provider-r/model-research，推理档 high。
把规划模型设为 provider-x/model-plan，推理档设为 high。
验收模型改成 provider-z/model-review，推理档 max。
前端制作用 provider-f/model-frontend，输出上限 4096。
规划职责改成 child，前端职责保持 same-turn。
研究和验收职责改成 same-turn。
```

The controller translates that request into the `odai_routing_config` tool call. The same tool uses `set-dispatch`/`reset-dispatch` for explicit per-role dispatch overrides. Researcher activation is task-gated but not price-aware: configuring it enables the narrow trigger and does not guarantee lower cost. The tool repeats that warning whenever a researcher mapping is shown, and Odai must compare authoritative provider prices with measured usage rather than inventing either. Users do not edit YAML or JSON, run an installation command, or add routing words to later task prompts. The tool stores the explicit choices in `$DSH_HOME/odai/routing.json`, outside managed package files, and Plugin and Agent installations read the same store. A legacy Executor mapping is ignored without invalidating current responsibilities and is removed on the next configuration write. A changed mapping applies from the next user turn. Whenever routing or explicit mapping management needs it, runtime resolves one merged effective snapshot: persisted mappings override deployment mappings, source provenance is explicit, and stale conversation summaries cannot override it. The full snapshot enters the model prompt only for mapping-management intent. The same tool shows that effective snapshot plus the latest current-session route receipt, or removes one persisted mapping when the user asks naturally. If reasoning effort is omitted, the target provider/model uses its own default; Odai does not silently carry a source controller's effort across providers or models. Every set and selected runtime route is checked through DSH's non-generating call resolver before provider I/O. Unknown provider/model/reasoning combinations are backed up and exact-match removed only when persisted; credentials, quota, rate limits, server errors, timeouts, and transport failures preserve the mapping and use at most one current-call controller fallback.

A user may also supply a positive child `maxTokens` limit; in-place controller upgrades retain the controller's normal output budget except for an explicit frontend responsibility limit. Configuration is never proof of use. Same-turn researcher, planner, reviewer, and frontend upgrades write `requested` first, then derive `applied`, `mismatch`, or `unverified` from DSH's effective `request/header`; a mismatch makes the controller read-only before tools can execute. Read-only researcher, planner, and reviewer scopes must use `odai_responsibility_return` and return only to the controller. A terminal read-only response without handback is marked unverified and automatically continued on the restored controller route. For child delegation, the runtime verifies provider, model, reasoning effort, and any explicit token limit before injecting output. A declared Odai responsibility child cannot finish successfully without an `applied` receipt. A failed high-impact child route makes the controller read-only instead of silently implementing without independent evidence; low-impact child failures may return to the controller without claiming delegated evidence.

A generic subagent is not a responsibility route and does not inherit a responsibility mapping. When a real responsibility gap emerges after initial routing and manual delegation is necessary, its label must start with `odai-<responsibility>` followed by a space or colon; missing or invalid mappings fail before the child request. Risk or task size alone never triggers another model. Role language inside quotes, inline/fenced code, or Markdown blockquotes is treated as material being discussed rather than an explicit routing request. A contextual upgrade requires an unverified causal claim used to justify a concrete high-impact change with a specific parameter, urgency, or irreversible action. Reviewer routes require an explicit independent acceptance gap. Implementation is not a separate responsibility route.

## Coexistence

The Plugin and Agent packages are independently installable and self-contained. Plugin is profile-wide; Agent is one dedicated preset. Installing both is normally redundant and is not the default recommendation. Use both only when the deliberate design is profile-wide Plugin behavior plus an Agent-scoped preset in the same profile. In that case, a process-shared per-agent/per-turn skill snapshot keeps the prompt and role contracts identical across both runtimes, shared session-evidence identities deduplicate each tool observation and turn/step route, DSH shadows the canonical prompt section by scope, and tool denials remain monotonic. Removing either package does not remove the compatibility-safe evidence store or make the DSH session log depend on that package.

## Development

`dsh/runtime/` is the only editable DSH runtime source. `npm pack` temporarily copies that runtime and the canonical skill into this package, then removes both generated directories:

```sh
npm --prefix dsh/plugin test
npm --prefix dsh/plugin run verify:dsh
npm --prefix dsh/plugin run pack:dry-run
```

The verification first reproduces rc.6's exact `SessionFormatUnsupportedError` for legacy Agent and Plugin logs, repairs them, and proves DSH's real JSONL/Zstandard backend plus `PersistenceCoordinator` accepts both while verified original backups remain available. The load probe then uses a temporary `DSH_HOME`, does not call a model, validates source-tool registration and persistence in DSH, checks persisted responsibility configuration, and verifies both the child boundary and protected-controller write denial through DSH's real tool runtime. An explicitly authorized live routing smoke can use isolated copies of the current DSH settings and credential references:

```sh
npm --prefix dsh/plugin run smoke:live -- --yes

# Use only a provider/model that the operator explicitly selects and can access.
npm --prefix dsh/plugin run smoke:live -- --yes --mode auto \
  --planner-provider provider-id --planner-model model-id

# Frontend auto mode also verifies the explicit role budget against a lower controller ceiling.
npm --prefix dsh/plugin run smoke:live -- --yes --mode auto \
  --controller-max-tokens controller-limit \
  --frontend-provider provider-id --frontend-model model-id \
  --frontend-reasoning effort --frontend-max-tokens frontend-limit \
  --task "substantial interface task"
```

The default smoke inherits `agent-default-model`, omits the routing block, and uses a natural high-impact decision gap. It requires one controller, zero children, a missing-planner event, read-only fail-closed protection, no false upgrade/result event, and the original controller `request/header`. Explicit planner `auto` and `execute` require `--planner-provider` plus `--planner-model`; frontend `auto` requires `--frontend-provider` plus `--frontend-model`. The script has no built-in model name, reasoning effort, or token value. Planner `auto` requires a same-turn upgrade, `execute` requires one verified child, frontend `auto` additionally requires zero children plus matching request-header and budget-override evidence, and `observe`/`off` require zero children with their mode-appropriate events.

An explicitly authorized cache probe compares the current relay's compaction request with and without the same routed reasoning setting. It inherits the controller route from DSH settings, uses an isolated temporary home, and removes copied credentials and sessions on exit. A diagnostic run may vary only the compaction output budget to determine whether the relay partitions its prompt cache by that field:

```sh
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --compaction-max-tokens 8192
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --compaction-cache-retention long

# Compare two ordinary controller requests without an intervening compaction.
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --ordinary-only --cache-retention short
npm --prefix dsh/plugin run smoke:compaction-cache -- --yes --runtime --ordinary-only --cache-retention long
```

The probe reports both compaction and exactly matched cache reads. `--ordinary-only` instead reports a clean warm/matched pair so an intervening compaction cannot refresh or contaminate a normal-dialogue cache comparison. Because it runs before the fixture session has a durable first request header, candidate mode supplies the same synthetic routed header used by the unit contract and then exercises the real relay request; production compaction reads an existing durable header. Runtime retention defaults to `provider-default`. In one isolated OpenAI `gpt-5.6-sol/xhigh` standalone compaction per arm, each shadowing about 149K measured tokens, provider-default and forced `long` both reused about 99.4% of provider input and produced equivalent immediate post-summary cache coverage. This supports the least-intervention default for that observed route; it does not establish delayed or provider-neutral retention behavior. Deployment config `compaction.cacheRetention` or `ODAI_COMPACTION_CACHE_RETENTION` can explicitly select `short`, `long`, or `none`; `provider-default` means Odai adds no retention, any explicit incoming retention remains authoritative, and configured retention still applies when host routing has already supplied reasoning. This retention policy does not add cross-model reasoning or retention.

A provider cache is still best-effort: even identical calls can miss because of upstream writes, expiry, or routing. Changing compaction to a low controller ceiling is not a valid cache fix because it risks an incomplete checkpoint; the first controller request after a landed summary must also build the new summary prefix because it no longer matches the replaced history.

The `0.2.15` candidate accepts exactly `@deepseek-ai/dsh@0.1.1-rc.2` and `0.1.2-alpha.2`; every other rc, alpha, or `0.1.2` release remains unsupported until its own isolated real-load contract is added.
