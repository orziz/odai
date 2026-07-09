import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildTranscriptCompactContext,
  buildTranscriptResumeContext,
} from "./transcript-context.mjs";
import {
  publicTranscriptEntry,
  safeName,
} from "./transcript-public.mjs";

export { buildTranscriptCompactContext, buildTranscriptResumeContext } from "./transcript-context.mjs";
export { publicTranscriptEntry } from "./transcript-public.mjs";

export async function createWorkspaceTranscript({ workspaceRoot, sessionId }) {
  const directory = path.join(workspaceRoot, ".odai", "sessions");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeName(sessionId)}.jsonl`);
  await writeFile(filePath, "", "utf8");
  await writeFile(
    path.join(directory, "latest.json"),
    `${JSON.stringify({ sessionId, transcriptPath: filePath }, null, 2)}\n`,
    "utf8",
  );

  let pending = Promise.resolve();
  const append = (event) => {
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      ...event,
    };
    pending = pending.then(() =>
      appendFile(filePath, `${JSON.stringify(publicTranscriptEntry(entry, { workspaceRoot }))}\n`, "utf8"),
    );
    return pending;
  };

  return {
    path: filePath,
    append,
    async flush() {
      await pending;
    },
  };
}


export async function readLatestWorkspaceTranscript({ workspaceRoot, tail = 20, includeContext = false }) {
  const { latest, entries } = await readLatestTranscriptEntries({ workspaceRoot });

  return {
    status: "ready",
    sessionId: latest.sessionId,
    transcriptPath: latest.transcriptPath,
    count: entries.length,
    entries: entries.slice(Math.max(0, entries.length - tail)),
    context: includeContext
      ? buildTranscriptResumeContext({
          sessionId: latest.sessionId,
          transcriptPath: latest.transcriptPath,
          entries,
          tail,
        })
      : undefined,
  };
}


export async function compactLatestWorkspaceTranscript({ workspaceRoot, tail = 50 } = {}) {
  const directory = path.join(workspaceRoot, ".odai", "sessions");
  const { latest, entries } = await readLatestTranscriptEntries({ workspaceRoot });
  const context = buildTranscriptCompactContext({
    sessionId: latest.sessionId,
    transcriptPath: latest.transcriptPath,
    entries,
    tail,
  });
  const contextPath = path.join(directory, `${safeName(latest.sessionId)}.context.json`);
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(directory, "latest.context.json"),
    `${JSON.stringify(
      {
        sessionId: latest.sessionId,
        transcriptPath: latest.transcriptPath,
        contextPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    status: "ready",
    sessionId: latest.sessionId,
    transcriptPath: latest.transcriptPath,
    contextPath,
    count: entries.length,
    context,
  };
}


export async function readLatestTranscriptEntries({ workspaceRoot }) {
  const directory = path.join(workspaceRoot, ".odai", "sessions");
  const latestPath = path.join(directory, "latest.json");
  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  const text = await readFile(latest.transcriptPath, "utf8");
  const entries = text
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { latest, entries };
}

