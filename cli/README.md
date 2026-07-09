# odai

Provider-neutral odai CLI agent runtime.

## CLI

Run from a checked-out repository:

```sh
node ./bin/odai.mjs --help
```

After install or link, the package exposes the `odai` command:

```sh
npm install -g odai-cli
odai
odai "inspect this project"
odai run "one-shot task" --provider auto --model <model>
odai models
odai setup
```

In an interactive TTY, typing `/` opens the slash-command panel. Use Up/Down to choose a command, Tab to accept the highlighted completion, and Enter to send.

On interactive TTY startup, odai checks the npm registry for a newer package version and prints an update hint when one is available. It never auto-installs. Set `ODAI_DISABLE_UPDATE_CHECK=1` to disable this check.

## Language

The CLI shell supports English and Chinese UI text:

```sh
ODAI_LANG=zh odai
ODAI_LANG=en odai
```

Inside `odai>`, use `/language zh` or `/language en` to switch the current session. Model/provider output is not translated by odai.

## Preferences

The interactive CLI stores UI/routing preferences in `.odai/preferences.json`: language, default provider, model, reasoning depth, context window, and durable `/auth` confirmations. Credentials themselves are still stored separately by your shell, `.odai/secrets.env`, or the provider CLI. Use `/auth claude-cli` to persist permission to call the local logged-in Claude CLI without reading Claude tokens; use `/auth clear` to disable persisted API-key and provider-command confirmations.

Auth is graded:

- Durable (saved): `/auth api-key`, `/auth provider-command`, `/auth claude-cli`, `/auth all`
- Session-only (not saved): `/auth shell`, `/auth network`
- High-risk scopes still require `/authorize risk:*` and stay on the live session state

Main agent control intents (JSON `toolIntents`, not executable tools):

- `complete` — stop successfully with an optional summary
- `ask-user` — stop and surface a question (`stopReason: needs_user`)
- `spawn-subagent` — request a profile/provider; odai schedules it after the turn

Default agent-loop turn budget is 4; `--reasoning medium|high` raises it (10/16), and `--max-turns N` always wins. Skill references are selected from the task text so domain playbooks are not always injected.

Conversation context compression is conservative:

- Small contexts pass through unchanged
- Oversized contexts are compressed at `prepareProviderInput` (budget threshold)
- Interactive multi-turn memory is force-compressed after each task to stay bounded
- Pass `compressContext: true` on provider input to force compression

Main-agent `spawn-subagent` intents are recorded on the run result by default and are **not** auto-executed. Pass `--auto-spawn` to schedule them through the normal subagent path.

## Node API

```js
import { createRuntime, runTask, listModels, listProviders } from "odai-cli";

const runtime = createRuntime({ repoRoot: process.cwd() });
const models = await runtime.listModels({ argv: ["--use-api-key"] });
const result = await runTask({
  repoRoot: process.cwd(),
  argv: ["inspect package metadata", "--agent-loop", "--provider", "auto"],
});
```

The API keeps odai runtime, provider routing, policy gates, transcripts, and run records in the package; editor integrations should call this API instead of parsing CLI stdout.

When a workspace contains `skills/odai`, odai uses that workspace skill. Otherwise the npm package falls back to its bundled compact `skills/odai` snapshot.

### External skills

`odai` remains the system governance prompt. Additional craft skills can be discovered, listed, and enabled:

- Discovery roots (host-defined, not arbitrary home scanning):
  - `<workspace>/skills/*/SKILL.md`
  - `<workspace>/.agents/skills/*/SKILL.md`
  - monorepo parent `skills/` and `.agents/skills/` (walk up, stop before `$HOME`)
  - `~/.agents/skills/*/SKILL.md` (user scope)
  - optional `ODAI_SKILLS_PATH` (path-separator joined extra roots)
  - packaged `skills/odai` snapshot fallback
- **List all installs**: interactive `/skills`, or non-interactive `odai skills` / `odai skills --json`
  - Full inventory: every install path is shown (primary + shadow), not name-deduped
  - Tab after `/` shows `/skill-name` enable completions
- Enable for session: type `/skill-name` (use `/skill-name off` to disable)
- One-shot CLI: `odai run "task" --skill find-skills`
- Task text that mentions a discovered skill name also auto-attaches it as craft context

External skills append as secondary craft layers. They do not override odai confirmation, authorization, evidence, or completion rights. Runtime slash commands always win over skill names.

## Safety

Real API-key and subscription-CLI providers remain fail-closed. Pass `--use-api-key`, `--use-provider-command`, or a provider-scoped flag such as `--use-provider-command=claude-cli` explicitly for commands that may call external providers.
