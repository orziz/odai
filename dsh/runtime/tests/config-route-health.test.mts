import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createCompactionConfigTool,
  invalidatePersistedCompactionTarget,
  readCompactionModelStore,
} from "../build/compaction-config.mjs";
import {
  createRoutingConfigTool,
  invalidatePersistedRoleRoute,
  readRoutingStore,
} from "../build/routing-config.mjs";
import type { ToolExecution } from "../build/runtime-types.mjs";

const execution: ToolExecution = {
  name: "test-config-tool",
  agent: { session: { header: {}, snapshotEvents: () => [], append() {} } },
};

function rejectingResolver(code: string, message = code): () => Promise<never> {
  return async () => {
    const error: NodeJS.ErrnoException = new Error(message);
    error.code = code;
    throw error;
  };
}

function isRouteError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code
    && "routeFailureKind" in error
    && error.routeFailureKind === "deterministic";
}

test("responsibility mappings are probed before persistence and invalidated with a backup only on exact match", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-routing-health-"));
  try {
    const path = resolve(root, "routing.json");
    const rejected = createRoutingConfigTool(path, { resolveCallConfig: rejectingResolver("UNKNOWN_MODEL") });
    await assert.rejects(
      async () => rejected.execute({ action: "set", responsibility: "planner", provider: "openai", model: "missing" }, execution),
      (error: unknown) => isRouteError(error, "UNKNOWN_MODEL"),
    );
    assert.equal(existsSync(path), false);

    const route = { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh" };
    const tool = createRoutingConfigTool(path, { resolveCallConfig: async (config) => ({ config }) });
    await tool.execute({ action: "set", responsibility: "planner", ...route }, execution);
    await tool.execute({ action: "set-dispatch", responsibility: "planner", dispatch: "child" }, execution);
    assert.deepEqual(readRoutingStore(path).roles.planner, route);
    assert.equal(readRoutingStore(path).schemaVersion, 2);
    assert.equal(readRoutingStore(path).dispatch.planner, "child");
    assert.equal(invalidatePersistedRoleRoute(path, "planner", { ...route, model: "other" }).invalidated, false);
    const invalidated = invalidatePersistedRoleRoute(path, "planner", route);
    assert.equal(invalidated.invalidated, true);
    assert.equal(existsSync(invalidated.backupPath), true);
    assert.equal(readRoutingStore(path).roles.planner, undefined);
    assert.equal(readRoutingStore(path).dispatch.planner, "child");
    assert.equal(readdirSync(root).some((name) => name.startsWith("routing.json.invalidated-")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema 1 routing stores remain readable and upgrade without losing model mappings", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-routing-schema-"));
  try {
    const path = resolve(root, "routing.json");
    const planner = { provider: "openai", model: "legacy-planner" };
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, roles: { planner } })}\n`, "utf8");
    assert.deepEqual(readRoutingStore(path), { schemaVersion: 1, roles: { planner }, dispatch: {} });
    const tool = createRoutingConfigTool(path);
    await tool.execute({ action: "set-dispatch", responsibility: "planner", dispatch: "child" }, execution);
    assert.deepEqual(readRoutingStore(path), {
      schemaVersion: 2,
      roles: { planner },
      dispatch: { planner: "child" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retired executor mappings preserve active routes and disappear on the next write", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-routing-retired-role-"));
  try {
    const path = resolve(root, "routing.json");
    const planner = { provider: "openai", model: "planner" };
    const reviewer = { provider: "openai", model: "reviewer" };
    const executor = { provider: "openai", model: "retired-executor" };
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 2,
      roles: { planner, executor, reviewer },
      dispatch: { planner: "child", executor: "child" },
    })}\n`, "utf8");
    assert.deepEqual(readRoutingStore(path), {
      schemaVersion: 2,
      roles: { planner, reviewer },
      dispatch: { planner: "child" },
    });

    const tool = createRoutingConfigTool(path);
    await tool.execute({ action: "set-dispatch", responsibility: "reviewer", dispatch: "child" }, execution);
    assert.deepEqual(readRoutingStore(path), {
      schemaVersion: 2,
      roles: { planner, reviewer },
      dispatch: { planner: "child", reviewer: "child" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction targets are probed before persistence and exact invalidation restores inheritance", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "odai-compaction-health-"));
  try {
    const path = resolve(root, "compaction.json");
    const rejected = createCompactionConfigTool(path, { resolveCallConfig: rejectingResolver("NO_ADAPTER") });
    await assert.rejects(
      async () => rejected.execute({ action: "set", provider: "missing", model: "summary" }, execution),
      (error: unknown) => isRouteError(error, "NO_ADAPTER"),
    );
    assert.equal(existsSync(path), false);

    const target = { provider: "openai", model: "gpt-5.6-luna" };
    const tool = createCompactionConfigTool(path, { resolveCallConfig: async (config) => ({ config }) });
    await tool.execute({ action: "set", ...target }, execution);
    assert.deepEqual(readCompactionModelStore(path).target, target);
    assert.equal(invalidatePersistedCompactionTarget(path, { ...target, model: "other" }).invalidated, false);
    const invalidated = invalidatePersistedCompactionTarget(path, target);
    assert.equal(invalidated.invalidated, true);
    assert.equal(existsSync(invalidated.backupPath), true);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readCompactionModelStore(path), { schemaVersion: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
