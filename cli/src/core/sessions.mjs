import {
  compactLatestWorkspaceTranscript,
  readLatestWorkspaceTranscript,
} from "./transcript-store.mjs";
import { redactString } from "../runtime/redaction.mjs";

const defaultRepoRoot = process.cwd();

export async function runSessions({ repoRoot: root = defaultRepoRoot, argv = [] } = {}) {
  const args = parseSessionsArgs(argv);
  try {
    if (args.compact) {
      return await compactLatestWorkspaceTranscript({
        workspaceRoot: root,
        tail: args.tail,
      });
    }
    return await readLatestWorkspaceTranscript({
      workspaceRoot: root,
      tail: args.tail,
      includeContext: args.context,
    });
  } catch (error) {
    return {
      status: "blocked",
      error: publicError(error),
      note: "No session transcript is available yet.",
    };
  }
}

function parseSessionsArgs(argv) {
  const args = {
    tail: 20,
    context: false,
    compact: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (option.name === "--tail") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.tail = Math.max(0, Number(value || 20));
    } else if (item === "--context") {
      args.context = true;
    } else if (item === "--compact") {
      args.compact = true;
    }
  }
  return args;
}

function optionToken(item = "") {
  const value = String(item);
  const separator = value.indexOf("=");
  if (separator <= 0) {
    return {
      name: value,
      value: undefined,
      hasInlineValue: false,
    };
  }
  return {
    name: value.slice(0, separator),
    value: value.slice(separator + 1),
    hasInlineValue: true,
  };
}

function publicError(error) {
  const result = {
    name: error?.name || "Error",
    message: redactString(error?.message || String(error)),
  };
  const cause = publicErrorCause(error?.cause);
  if (cause) {
    result.cause = cause;
  }
  return result;
}

function publicErrorCause(cause) {
  if (!cause || typeof cause !== "object") {
    return undefined;
  }
  const result = {};
  if (cause.name) {
    result.name = redactString(cause.name);
  }
  if (cause.code) {
    result.code = redactString(cause.code);
  }
  if (cause.message) {
    result.message = redactString(cause.message);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
