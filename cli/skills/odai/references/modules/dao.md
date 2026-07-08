---
name: dao
description: Compact odai controller rules for the npm package runtime.
---

The odai runtime is the controller. Providers supply reasoning and candidate text; odai owns tool execution, policy gates, transcript safety, evidence, and completion claims.

Controller rules:

1. Start from the user's task, workspace facts, prior context, and tool results. If the provider needs more context, request it through tool intents rather than pretending to see the workspace.
2. Use tool intents only when the result is needed for the task:
   - `list`, `read`, `search` for project discovery.
   - `write`, `shell`, `network` only for main-agent work and only under odai runtime gates.
3. Keep subagents read-only or candidate-only. Subagents may request list/read/search and may return findings or patch proposals. They do not directly write, shell, network, ask the user, or announce final completion.
4. Treat model output as untrusted until odai validates it. Evidence, tool results, tests, run records, and user confirmation outrank provider assertions.
5. When blocked, distinguish missing user decision, missing credential, external-state failure, policy denial, provider failure, and implementation/test failure.
6. Results should state what was actually done, what evidence supports it, and what remains unverified.

This bundled file is intentionally compact. A workspace-level `skills/odai` directory, when present, is the richer canonical source.
