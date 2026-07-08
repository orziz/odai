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

The interactive CLI stores UI/routing preferences in `.odai/preferences.json`: language, default provider, model, reasoning depth, context window, and `/auth` confirmations. Credentials themselves are still stored separately by your shell, `.odai/secrets.env`, or the provider CLI. Use `/auth claude-cli` to persist permission to call the local logged-in Claude CLI without reading Claude tokens; use `/auth clear` to disable persisted API-key and provider-command confirmations.

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

## Safety

Real API-key and subscription-CLI providers remain fail-closed. Pass `--use-api-key`, `--use-provider-command`, or a provider-scoped flag such as `--use-provider-command=claude-cli` explicitly for commands that may call external providers.
