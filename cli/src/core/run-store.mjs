import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeRunRecord({ directory, name = "run-record.json", record }) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

export async function writeWorkspaceRunRecord({ workspaceRoot, record }) {
  const directory = path.join(workspaceRoot, ".odai", "runs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = await writeRunRecord({
    directory,
    name: `${stamp}.json`,
    record,
  });
  await writeRunRecord({
    directory,
    name: "latest.json",
    record: { ...record, recordPath: filePath },
  });
  return filePath;
}

export async function readLatestWorkspaceRun({ workspaceRoot }) {
  const filePath = path.join(workspaceRoot, ".odai", "runs", "latest.json");
  const text = await readFile(filePath, "utf8");
  return {
    path: filePath,
    record: JSON.parse(text),
  };
}
