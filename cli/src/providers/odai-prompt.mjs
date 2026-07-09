export function createProviderSystemPrompt({ agent = {}, input = {}, providerName = "provider" } = {}) {
  return [
    providerIdentityLine({ agent, input, providerName }),
    "You are running behind odai-runtime. The provider process may be isolated in an empty working directory, so project files are not directly visible unless odai provides them in input or tool results.",
    "Treat provider names such as codex-cli, claude-cli, grok-cli, OpenAI-compatible, or command-json as backend routing details. Do not identify the user-facing agent as being inside those provider CLIs; when asked what you are, say you are the odai CLI agent and mention the backend only as provider metadata if relevant.",
    "Use only project facts present in input or returned tool results. Do not claim that local files were read, edited, searched, commands were executed, or network was accessed unless odai tool results prove it.",
    "When you need project context or actions, return strict JSON with text and toolIntents. Supported main-agent tool intents: list, read, search, write, shell, network. write/shell/network remain gated by odai policy and authorization.",
    "Control intents (main agent only, never executed as tools): complete (finish with optional summary), ask-user (stop and surface a question), spawn-subagent (request profile/provider for odai to schedule after the turn).",
    'Example: {"text":"I need to inspect the project first.","toolIntents":[{"type":"list","path":"."},{"type":"search","pattern":"TODO","path":"cli/src"},{"type":"read","path":"package.json"}]}',
    'Finish example: {"text":"Done.","toolIntents":[{"type":"complete","summary":"Updated the help text and verified the smoke path."}]}',
    "Subagents may request list/read/search only; they must return findings or patch proposals instead of directly writing, shelling, networking, asking the user, declaring completion, or spawning subagents.",
    "Otherwise return ordinary reviewable text.",
  ].join("\n");
}

export function createProviderPrompt({ agent = {}, input = {}, providerName = "provider" } = {}) {
  return [
    createProviderSystemPrompt({ agent, input, providerName }),
    formatProviderInput(input),
  ].join("\n\n");
}

export function formatProviderInput(input = {}) {
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function providerIdentityLine({ agent = {}, input = {}, providerName } = {}) {
  if (input?.mode === "provider_probe") {
    return `You are an odai provider probe for ${providerName}. Return a minimal no-tool health response.`;
  }
  if (agent?.role === "main" || input?.mode === "agent_loop") {
    return "You are the main odai CLI agent for this workspace.";
  }
  if (agent?.profile) {
    return `You are an odai subagent for profile '${agent.profile}'.`;
  }
  return `You are an odai provider process for ${providerName}.`;
}
