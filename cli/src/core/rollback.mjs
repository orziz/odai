import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readLatestWorkspaceRun } from "./run-store.mjs";

export async function rollbackWorkspaceRun({
  workspaceRoot,
  selector = "latest",
  confirm = false,
  deleteNewFiles = false,
  paths = [],
  checkpointIds = [],
} = {}) {
  const latest = selector === "latest"
    ? await readLatestWorkspaceRun({ workspaceRoot })
    : await readRunRecordPath({ workspaceRoot, selector });
  return rollbackRunRecord({
    workspaceRoot,
    recordPath: latest.record?.recordPath || latest.path,
    record: latest.record,
    confirm,
    deleteNewFiles,
    paths,
    checkpointIds,
  });
}

export async function rollbackRunRecord({
  workspaceRoot,
  recordPath,
  record,
  confirm = false,
  deleteNewFiles = false,
  paths = [],
  checkpointIds = [],
  reverseCheckpointDir,
} = {}) {
  const pathFilter = createPathFilter(paths);
  const checkpointFilter = createCheckpointFilter(checkpointIds);
  const checkpoints = (record?.evidence?.checkpoints || [])
    .filter((checkpoint) => pathFilter(checkpoint.path))
    .filter((checkpoint) => checkpointFilter(checkpoint.id));
  const items = [];
  const reverseCheckpoints = [];
  const reverseDir = reverseCheckpointDir || path.join(
    path.resolve(workspaceRoot),
    ".odai",
    "runs",
    "checkpoints",
    `rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  for (const checkpoint of [...checkpoints].reverse()) {
    const item = await prepareRollbackItem({
      workspaceRoot,
      checkpoint,
      confirm,
      deleteNewFiles,
      reverseCheckpointDir: reverseDir,
    });
    items.push(item);
    if (item.reverseCheckpoint) {
      reverseCheckpoints.push(item.reverseCheckpoint);
    }
  }

  return {
    status: "ready",
    recordPath,
    task: record?.task,
    confirmRequired: !confirm,
    restored: items.some((item) => item.action === "restored" || item.action === "deleted"),
    reverseCheckpoints,
    reverseRecord: reverseCheckpoints.length > 0
      ? {
          task: `Reverse rollback: ${record?.task || recordPath || "unknown"}`,
          evidence: {
            checkpoints: reverseCheckpoints,
          },
        }
      : undefined,
    items,
    note: confirm
      ? "Rollback applied for restorable checkpoints."
      : "Preview only. Re-run with `--confirm` to restore restorable checkpoints.",
  };
}

async function readRunRecordPath({ workspaceRoot, selector }) {
  const filePath = path.resolve(selector);
  if (!isInside(filePath, path.resolve(workspaceRoot))) {
    throw new Error(`Rollback record path is outside workspace: ${filePath}`);
  }
  const text = await readFile(filePath, "utf8");
  return {
    path: filePath,
    record: JSON.parse(text),
  };
}

function createPathFilter(paths = []) {
  const filters = paths.filter(Boolean).map((item) => path.resolve(item));
  if (filters.length === 0) {
    return () => true;
  }
  return (filePath) => filters.includes(path.resolve(filePath || ""));
}

function createCheckpointFilter(checkpointIds = []) {
  const filters = new Set(checkpointIds.filter(Boolean));
  if (filters.size === 0) {
    return () => true;
  }
  return (id) => filters.has(id);
}

async function prepareRollbackItem({ workspaceRoot, checkpoint, confirm, deleteNewFiles, reverseCheckpointDir }) {
  const targetPath = path.resolve(checkpoint.path || "");
  const checkpointPath = path.resolve(checkpoint.checkpointPath || "");
  const item = {
    id: checkpoint.id,
    path: targetPath,
    checkpointPath,
    existed: Boolean(checkpoint.existed),
    action: "restore",
    ok: false,
  };

  if (!isInside(targetPath, workspaceRoot)) {
    return {
      ...item,
      action: "skip",
      reason: "target_outside_workspace",
    };
  }

  const checkpointRoot = path.join(path.resolve(workspaceRoot), ".odai", "runs", "checkpoints");
  if (!isInside(checkpointPath, checkpointRoot)) {
    return {
      ...item,
      action: "skip",
      reason: "checkpoint_outside_store",
    };
  }

  let checkpointRecord;
  try {
    checkpointRecord = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    return {
      ...item,
      action: "skip",
      reason: `checkpoint_unreadable:${error?.code || error?.name || "error"}`,
    };
  }

  if (!checkpointRecord.existed) {
    if (!deleteNewFiles) {
      return {
        ...item,
        action: "skip",
        reason: "new_file_delete_not_supported_without_flag",
      };
    }
    if (!confirm) {
      return {
        ...item,
        ok: true,
        action: "would_delete",
      };
    }
    try {
      const reverseCheckpoint = await createReverseCheckpoint({
        targetPath,
        actor: { kind: "rollback", sourceCheckpointId: checkpoint.id },
        reverseCheckpointDir,
      });
      await unlink(targetPath);
      return {
        ...item,
        ok: true,
        action: "deleted",
        reverseCheckpoint,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          ...item,
          ok: true,
          action: "already_missing",
        };
      }
      throw error;
    }
  }

  if (!confirm) {
    return {
      ...item,
      ok: true,
      action: "would_restore",
    };
  }

  const reverseCheckpoint = await createReverseCheckpoint({
    targetPath,
    actor: { kind: "rollback", sourceCheckpointId: checkpoint.id },
    reverseCheckpointDir,
  });
  await writeFile(targetPath, checkpointRecord.content || "", "utf8");
  return {
    ...item,
    ok: true,
    action: "restored",
    reverseCheckpoint,
  };
}

async function createReverseCheckpoint({ targetPath, actor, reverseCheckpointDir }) {
  if (!reverseCheckpointDir) return undefined;
  let existed = true;
  let content = "";
  try {
    content = await readFile(targetPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      existed = false;
    } else {
      throw error;
    }
  }

  const id = `reverse-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const checkpoint = {
    id,
    path: targetPath,
    actor,
    existed,
    checkpointPath: path.join(reverseCheckpointDir, `${id}.json`),
  };
  await mkdir(reverseCheckpointDir, { recursive: true });
  await writeFile(
    checkpoint.checkpointPath,
    JSON.stringify({
      id: checkpoint.id,
      path: checkpoint.path,
      actor: checkpoint.actor,
      existed,
      content,
    }),
    "utf8",
  );
  return checkpoint;
}

function isInside(filePath, root) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
