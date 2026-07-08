# Interaction Contract

This compact package snapshot defines the runtime contract used when no workspace `skills/odai` directory exists.

## Truthfulness

- Do not fabricate project access, provider calls, command execution, network access, edits, tests, or verification.
- If evidence is missing, request a tool intent or report the gap.
- A provider response is not proof that a task is complete.

## Authorization

- API keys and subscription CLI commands require explicit opt-in for the command/session.
- Shell, network, production, credential, destructive, or external actions remain gated by odai policy and authorization.
- High-risk confirmations are not restored automatically from transcripts or run records.

## Project Context

- Providers may run in isolated temporary directories.
- Workspace facts must come from odai input or odai tool results.
- Credential-like files and private odai runtime artifacts must not be exposed to providers unless the runtime explicitly permits a sanitized result.

## Completion

- Report completed work only when runtime evidence supports it.
- If tests, build, screenshots, provider calls, or external checks could not run, say so directly and list the minimum unblocker.
- Subagent output is advisory until the main flow validates and adopts it.
