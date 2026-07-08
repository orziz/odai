import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INIT_FILES = [
  {
    relativePath: path.join(".odai", "policy.json"),
    content: {
      shell: {
        allowExecution: false,
        allowedCommands: [],
        sandbox: {
          mode: "none",
        },
      },
      network: {
        allowRequests: false,
        allowedHosts: [],
        timeoutMs: 10000,
      },
    },
  },
  {
    relativePath: path.join(".odai", "providers.json"),
    content: {
      providers: [],
    },
  },
  {
    relativePath: path.join(".odai", "policy.example.json"),
    content: {
      usage:
        "Copy one example object to .odai/policy.json only after confirming the sandbox and command allowlist are appropriate for this workspace.",
      checks: {
        preflight: "odai sandbox",
        smoke: "odai doctor --sandbox --smoke --allow-shell --save",
      },
      examples: {
        docker: {
          shell: {
            allowExecution: true,
            allowedCommands: ["node"],
            sandbox: {
              mode: "docker",
              image: "node:22-alpine",
              network: "none",
              readOnlyRoot: true,
              workdir: "/workspace",
            },
          },
          network: {
            allowRequests: false,
            allowedHosts: [],
            timeoutMs: 10000,
          },
        },
        devcontainer: {
          shell: {
            allowExecution: true,
            allowedCommands: ["node"],
            sandbox: {
              mode: "devcontainer",
              command: "devcontainer",
              workspaceFolder: "",
            },
          },
          network: {
            allowRequests: false,
            allowedHosts: [],
            timeoutMs: 10000,
          },
        },
        macosSandboxExec: {
          shell: {
            allowExecution: true,
            allowedCommands: ["node"],
            sandbox: {
              mode: "macos-sandbox-exec",
            },
          },
          network: {
            allowRequests: false,
            allowedHosts: [],
            timeoutMs: 10000,
          },
        },
      },
    },
  },
  {
    relativePath: path.join(".odai", "providers.example.json"),
    content: {
      usage:
        "Built-in providers are configured with environment variables. odai models actively probes provider model-list endpoints; use --model or /model for manual routing. model/models here are hints for completion, not proof of remote availability. Add custom providers here only for OpenAI-compatible gateways, local Ollama, or CLIs that return odai JSON tool intents.",
      builtInProviders: [
        {
          name: "openai-api",
          type: "built-in",
          env: ["OPENAI_API_KEY", "ODAI_OPENAI_MODEL"],
          check: "odai doctor --provider openai-api --use-api-key --save",
          checkWithModel: "odai doctor --provider openai-api --use-api-key --model <model> --save",
          interactiveModel: "/model openai-api:<model>",
        },
        {
          name: "anthropic-api",
          type: "built-in",
          env: ["ANTHROPIC_API_KEY", "ODAI_ANTHROPIC_MODEL"],
          check: "odai doctor --provider anthropic-api --use-api-key --save",
          checkWithModel: "odai doctor --provider anthropic-api --use-api-key --model <model> --save",
          interactiveModel: "/model anthropic-api:<model>",
        },
        {
          name: "gemini-api",
          type: "built-in",
          env: ["GEMINI_API_KEY", "ODAI_GEMINI_MODEL"],
          check: "odai doctor --provider gemini-api --use-api-key --save",
          checkWithModel: "odai doctor --provider gemini-api --use-api-key --model <model> --save",
          interactiveModel: "/model gemini-api:<model>",
        },
        {
          name: "deepseek-api",
          type: "built-in",
          env: ["DEEPSEEK_API_KEY", "ODAI_DEEPSEEK_MODEL"],
          baseUrl: "https://api.deepseek.com",
          auth: "Run `odai auth provider deepseek-api --api-key-stdin` to store a local key.",
          models: ["deepseek-v4-flash", "deepseek-v4-pro"],
          check: "odai doctor --provider deepseek-api --use-api-key --save",
          checkWithModel: "odai doctor --provider deepseek-api --use-api-key --model <model> --save",
          interactiveModel: "/model deepseek-api:<model>",
        },
        {
          name: "claude-agent-sdk",
          type: "built-in",
          package: "@anthropic-ai/claude-agent-sdk",
          optionalEnv: ["CLAUDE_CODE_EXECUTABLE", "ODAI_CLAUDE_MODEL"],
          check: "odai doctor --provider claude-agent-sdk --use-provider-command --save",
          checkWithModel: "odai doctor --provider claude-agent-sdk --use-provider-command --model <model> --save",
          interactiveModel: "/model claude-agent-sdk:<model>",
        },
        {
          name: "claude-cli",
          type: "built-in",
          command: "claude",
          optionalEnv: ["ODAI_CLAUDE_COMMAND", "ODAI_CLAUDE_MODEL"],
          check: "odai doctor --provider claude-cli --use-provider-command --save",
          checkWithModel: "odai doctor --provider claude-cli --use-provider-command --model <model> --save",
          interactiveModel: "/model claude-cli:<model>",
        },
        {
          name: "codex-cli",
          type: "built-in",
          command: "codex",
          optionalEnv: ["ODAI_CODEX_COMMAND", "ODAI_CODEX_MODEL"],
          check: "odai doctor --provider codex-cli --use-provider-command --save",
          checkWithModel: "odai doctor --provider codex-cli --use-provider-command --model <model> --save",
          interactiveModel: "/model codex-cli:<model>",
        },
        {
          name: "grok-cli",
          type: "built-in",
          command: "grok",
          optionalEnv: ["ODAI_GROK_COMMAND", "ODAI_GROK_MODEL"],
          check: "odai doctor --provider grok-cli --use-provider-command --save",
          checkWithModel: "odai doctor --provider grok-cli --use-provider-command --model <model> --save",
          interactiveModel: "/model grok-cli:<model>",
        },
      ],
      providers: [
        {
          type: "openai-compatible",
          name: "my-openai-compatible",
          baseUrl: "https://api.example.com/v1",
          auth: "Run `odai auth provider my-openai-compatible --api-key-stdin` to store a local key and backfill apiKeyEnv.",
          model: "model-name",
          models: ["model-name", "another-model-name"],
          modelOverride: "You may omit model here and pass --model <model> or use /model my-openai-compatible:<model> for a session.",
          checkWithModel: "odai doctor --provider my-openai-compatible --use-api-key --model <model> --save",
          capabilities: ["reasoning", "code"],
        },
        {
          type: "command-json",
          name: "my-cli-provider",
          command: "my-model-cli",
          args: ["--json"],
          modelArgs: ["--model", "{model}"],
          models: ["model-name"],
          capabilities: ["reasoning", "code"],
        },
        {
          type: "ollama",
          name: "local-ollama",
          baseUrl: "http://localhost:11434",
          model: "qwen2.5-coder:latest",
          models: ["qwen2.5-coder:latest"],
          capabilities: ["reasoning", "code"],
        },
      ],
    },
  },
  {
    relativePath: path.join(".odai", "agents.json"),
    content: {
      agents: {},
    },
  },
  {
    relativePath: path.join(".odai", "agents.example.json"),
    content: {
      usage:
        "Copy selected profiles into .odai/agents.json to tune subagent routing. Subagents cannot directly write files; candidate patches still require main-flow adoption.",
      agents: {
        deep_reviewer: {
          purpose: "long_context_code_review",
          tools: "read_only",
          providerRequirements: ["code", "long_context"],
          allowedOutputs: ["findings", "risks", "missing_cases", "questions"],
        },
        cheap_challenger: {
          purpose: "low_cost_independent_challenge",
          tools: "none",
          providerRequirements: ["reasoning"],
          allowedOutputs: ["counterexamples", "alternative_paths", "assumptions"],
        },
        patch_candidate: {
          purpose: "candidate_patch_only",
          tools: "virtual_patch_only",
          providerRequirements: ["code"],
          allowedOutputs: ["unified_diff", "rationale", "test_plan"],
        },
        bulk_reader: {
          purpose: "large_context_summary",
          tools: "read_only",
          providerRequirements: ["long_context"],
          allowedOutputs: ["evidence_summary", "file_map"],
        },
      },
    },
  },
];

export async function initWorkspace({ workspaceRoot, force = false } = {}) {
  if (!workspaceRoot) {
    throw new Error("initWorkspace requires workspaceRoot.");
  }

  await mkdir(path.join(workspaceRoot, ".odai"), { recursive: true });
  const result = {
    status: "ready",
    directory: path.join(workspaceRoot, ".odai"),
    created: [],
    skipped: [],
    overwritten: [],
    note: force
      ? "Initialized odai workspace config and overwrote existing scaffold files."
      : "Initialized odai workspace config. Existing scaffold files were left unchanged.",
  };

  for (const file of INIT_FILES) {
    const filePath = path.join(workspaceRoot, file.relativePath);
    const exists = await pathExists(filePath);
    if (exists && !force) {
      result.skipped.push(file.relativePath);
      continue;
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(file.content, null, 2)}\n`, "utf8");
    if (exists) {
      result.overwritten.push(file.relativePath);
    } else {
      result.created.push(file.relativePath);
    }
  }

  return result;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
