import { hasFlag, optionToken } from "./cli-args.mjs";
import { publicError, publicTaskText } from "./public-summaries.mjs";
import { writeWorkspaceRunRecord } from "./run-store.mjs";
import { rollbackWorkspaceRun } from "./rollback.mjs";

const defaultRepoRoot = process.cwd();

export async function rollbackLatestRun({ repoRoot: root = defaultRepoRoot, argv = [] } = {}) {
  const args = parseRollbackArgs(argv);
  const result = await rollbackWorkspaceRun({
    workspaceRoot: root,
    selector: args.selector,
    confirm: args.confirm,
    deleteNewFiles: args.deleteNewFiles,
    paths: args.paths,
    checkpointIds: args.checkpointIds,
  });
  if (args.confirm) {
    result.auditRecordPath = await writeWorkspaceRunRecord({
      workspaceRoot: root,
      record: buildRollbackAuditRecord({ result, args }),
    });
  }
  return publicRollbackResult(result);
}


function buildRollbackAuditRecord({ result = {}, args = {} } = {}) {
  return {
    mode: "rollback",
    status: result.status,
    sourceRecordPath: result.recordPath,
    task: publicTaskText(result.task),
    confirmRequired: result.confirmRequired,
    restored: result.restored,
    items: publicRollbackItems(result.items),
    evidence: result.reverseRecord?.evidence,
    resume: {
      argv: buildRollbackResumeArgv(args),
    },
  };
}


function publicRollbackResult(result = {}) {
  return {
    status: result.status,
    recordPath: result.recordPath,
    task: publicTaskText(result.task),
    confirmRequired: result.confirmRequired,
    restored: result.restored,
    items: publicRollbackItems(result.items),
    auditRecordPath: result.auditRecordPath,
    note: result.note,
  };
}


function publicRollbackItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: item.id,
    path: item.path,
    existed: item.existed,
    action: item.action,
    ok: item.ok,
    reason: item.reason,
  }));
}


function parseRollbackArgs(argv = []) {
  const args = {
    selector: "latest",
    confirm: false,
    deleteNewFiles: false,
    paths: [],
    checkpointIds: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const option = optionToken(item);
    if (item === "--confirm") {
      args.confirm = true;
    } else if (item === "--delete-new-files") {
      args.deleteNewFiles = true;
    } else if (option.name === "--path") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.paths.push(value);
    } else if (option.name === "--checkpoint") {
      const value = option.hasInlineValue ? option.value : argv[++i];
      args.checkpointIds.push(value);
    } else if (!item.startsWith("-") && args.selector === "latest") {
      args.selector = item;
    }
  }
  return args;
}


function buildRollbackResumeArgv(args) {
  return [
    "rollback",
    args.selector,
    ...args.paths.flatMap((filePath) => ["--path", filePath]),
    ...args.checkpointIds.flatMap((checkpointId) => ["--checkpoint", checkpointId]),
    ...(args.deleteNewFiles ? ["--delete-new-files"] : []),
  ];
}

