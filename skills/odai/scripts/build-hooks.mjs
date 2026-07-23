#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSource = path.join(skillRoot, "scripts", "odai-hook.mjs");
const policySource = path.join(skillRoot, "assets", "hooks-policy.example.json");
const supportedHosts = ["codex", "claude", "copilot", "gemini", "grok", "kimi"];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!args.out) fail("缺少 --out <directory>");
if (!args.host) fail("缺少 --host <codex|claude|copilot|gemini|grok|kimi|all>");

const hosts = args.host === "all" ? supportedHosts : [args.host];
for (const host of hosts) {
  if (!supportedHosts.includes(host)) fail(`不支持的 host：${host}`);
}

const outputRoot = path.resolve(args.out);
mkdirSync(outputRoot, { recursive: true });
for (const host of hosts) {
  const target = path.join(outputRoot, host);
  assertEmpty(target);
  mkdirSync(target, { recursive: true });
  buildAdapter(host, target);
  console.log(`${host}: ${target}`);
}

function buildAdapter(host, target) {
  const metadata = {
    version: 1,
    host,
    policyPath: "<project>/.odai/hooks.json",
    defaultBehavior: "No policy file means no-op.",
    generatedFrom: "skills/odai/scripts/build-hooks.mjs",
    capabilities: host === "grok" ? ["pre-tool"] : ["pre-tool", "stop-check"],
  };

  if (host === "copilot") {
    copy(target, ".odai/hooks/odai-hook.mjs", runtimeSource);
    copy(target, ".odai/hooks.example.json", policySource);
    writeJson(target, ".github/hooks/odai.json", copilotHooks());
    metadata.format = "project-overlay";
    metadata.install = "Merge this directory into the repository root, review .github/hooks/odai.json, then create .odai/hooks.json from the example.";
  } else {
    copy(target, "scripts/odai-hook.mjs", runtimeSource);
    copy(target, "examples/hooks.json", policySource);

    if (host === "codex") {
      writeJson(target, ".codex-plugin/plugin.json", codexPluginManifest());
      writeJson(target, "hooks/hooks.json", groupedHooks("${PLUGIN_ROOT}", host, "PreToolUse", "Stop"));
      metadata.format = "codex-plugin";
      metadata.install = "Install or link this directory as a Codex plugin, review and trust its hooks, then create <project>/.odai/hooks.json.";
    } else if (host === "claude") {
      writeJson(target, ".claude-plugin/plugin.json", pluginManifest("Claude Code"));
      writeJson(target, "hooks/hooks.json", groupedHooks("${CLAUDE_PLUGIN_ROOT}", host, "PreToolUse", "Stop"));
      metadata.format = "claude-plugin";
      metadata.install = "Install this directory as a Claude Code plugin, then create <project>/.odai/hooks.json.";
    } else if (host === "grok") {
      writeJson(target, ".claude-plugin/plugin.json", pluginManifest("Grok Build"));
      writeJson(target, "hooks/hooks.json", groupedHooks("${GROK_PLUGIN_ROOT}", host, "PreToolUse", null));
      metadata.format = "grok-plugin-using-claude-compatible-manifest";
      metadata.install = "Install this directory with Grok Build's plugin manager, trust the hook, then create <project>/.odai/hooks.json.";
      metadata.note = "Grok Build exposes PreToolUse as the blocking boundary; this adapter intentionally has no Stop verifier.";
    } else if (host === "gemini") {
      writeJson(target, "gemini-extension.json", {
        name: "odai-hooks",
        version: "0.1.0",
        description: "Optional deterministic boundaries for odai.",
      });
      writeJson(target, "hooks/hooks.json", groupedHooks("${extensionPath}", host, "BeforeTool", "AfterAgent"));
      metadata.format = "gemini-extension";
      metadata.install = "Link or install this directory as a Gemini CLI extension, then create <project>/.odai/hooks.json.";
    } else if (host === "kimi") {
      writeJson(target, "kimi.plugin.json", kimiManifest());
      metadata.format = "kimi-plugin";
      metadata.install = "Run /plugins install <this-directory> in Kimi Code CLI, enable it, then create <project>/.odai/hooks.json.";
    }
  }

  writeJson(target, "ADAPTER.json", metadata);
}

function groupedHooks(rootVariable, host, preEvent, stopEvent) {
  const commandRoot = `${rootVariable}/scripts/odai-hook.mjs`;
  const preHandler = {
    type: "command",
    command: `node "${commandRoot}" pre-tool --host ${host}`,
    timeout: 5,
  };
  const stopHandler = {
    type: "command",
    command: `node "${commandRoot}" stop --host ${host}`,
    timeout: 600,
  };
  if (host === "gemini") {
    preHandler.name = "odai-write-boundary";
    stopHandler.name = "odai-acceptance-check";
  }
  const hooks = {
    [preEvent]: [
      {
        matcher: writeMatcher(host),
        hooks: [preHandler],
      },
    ],
  };
  if (stopEvent) {
    hooks[stopEvent] = [
      {
        matcher: "*",
        hooks: [stopHandler],
      },
    ];
  }
  const result = { hooks };
  if (host !== "gemini") {
    result.description = "Optional odai boundaries. Inactive unless the project defines .odai/hooks.json.";
  }
  return result;
}

function copilotHooks() {
  const command = "node .odai/hooks/odai-hook.mjs";
  return {
    version: 1,
    hooks: {
      preToolUse: [
        {
          type: "command",
          matcher: writeMatcher("copilot"),
          command: `${command} pre-tool --host copilot`,
          cwd: ".",
          timeoutSec: 5,
        },
      ],
      agentStop: [
        {
          type: "command",
          command: `${command} stop --host copilot`,
          cwd: ".",
          timeoutSec: 600,
        },
      ],
    },
  };
}

function kimiManifest() {
  return {
    name: "odai-hooks",
    version: "0.1.0",
    description: "Optional deterministic boundaries for odai.",
    interface: {
      displayName: "odai Hooks",
      shortDescription: "Protect explicit read-only paths and run declared acceptance checks.",
    },
    hooks: [
      {
        event: "PreToolUse",
        matcher: writeMatcher("kimi"),
        command: "node ./scripts/odai-hook.mjs pre-tool --host kimi",
        timeout: 5,
      },
      {
        event: "Stop",
        command: "node ./scripts/odai-hook.mjs stop --host kimi",
        timeout: 600,
      },
    ],
  };
}

function pluginManifest(hostName) {
  return {
    name: "odai-hooks",
    version: "0.1.0",
    description: `Optional deterministic odai boundaries for ${hostName}.`,
  };
}

function codexPluginManifest() {
  return {
    id: "odai-hooks",
    name: "odai-hooks",
    version: "0.1.0",
    description: "Optional deterministic boundaries for odai.",
    author: {
      name: "orzi",
      url: "https://github.com/orziz",
    },
    homepage: "https://github.com/orziz/odai",
    repository: "https://github.com/orziz/odai",
    license: "MIT",
    keywords: ["odai", "hooks", "guardrails"],
    interface: {
      displayName: "odai Hooks",
      shortDescription: "Protect explicit read-only paths and run declared checks.",
      longDescription: "Optional deterministic hook guardrails for projects that use odai.",
      developerName: "orzi",
      category: "Developer Tools",
      capabilities: ["PreToolUse guard", "Stop acceptance check"],
      websiteURL: "https://github.com/orziz/odai",
      brandColor: "#1F6FEB",
      defaultPrompt: "Use odai with the project's explicit hook boundaries.",
    },
  };
}

function writeMatcher(host) {
  if (host === "copilot") return "create|edit|str_replace_editor|apply_patch";
  if (host === "gemini") return "write_file|replace|apply_patch|edit|create";
  return "Edit|Write|apply_patch|create|edit|write_file|str_replace_editor";
}

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copy(root, relativePath, source) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function assertEmpty(target) {
  if (!existsSync(target)) return;
  if (readdirSync(target).length > 0) fail(`输出目录非空，拒绝覆盖：${target}`);
}

function parseArgs(argv) {
  const result = { host: "", out: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--host") result.host = argv[++index] || "";
    else if (value === "--out") result.out = argv[++index] || "";
    else fail(`未知参数：${value}`);
  }
  return result;
}

function printHelp() {
  console.log(`Build optional odai hook adapters.

Usage:
  node skills/odai/scripts/build-hooks.mjs --host <host|all> --out <directory>

Hosts:
  ${supportedHosts.join(", ")}

The builder never installs hooks or edits a target project. Each generated
adapter is inactive until that project defines .odai/hooks.json.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
