import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

interface ClientTesting {
  projectTrace(events: unknown[]): {
    items: Array<{ state: string; role: string }>;
    currentRoles: Record<string, { state: string } | undefined>;
  };
  shouldOwnSurface(): boolean;
}

interface ClientRegistration {
  id: string;
  factory(require_: (name: string) => unknown): { __testing: ClientTesting };
}

async function loadClient(packageId: "odai-dsh-agent" | "odai-dsh-plugin", entries: string[]): Promise<ClientTesting> {
  const template = await readFile(resolve(import.meta.dirname, "../../client/build/client.js"), "utf8");
  const source = template.replaceAll("__ODAI_CLIENT_PACKAGE__", packageId);
  let registration: ClientRegistration | undefined;
  const context: Record<string, unknown> = {
    __DSH_BOOT__: { entries: entries.map((id) => ({ id })) },
    window: { __ModuleLoader__: { load(value: ClientRegistration) { registration = value; } } },
  };
  vm.runInNewContext(source, context, { filename: `${packageId}/client.js` });
  assert.ok(registration);
  assert.equal(registration.id, packageId);
  return registration.factory((name) => {
    if (name === "react") return {
      createElement() {}, useEffect() {}, useMemo(value: () => unknown) { return value(); }, useRef() { return { current: null }; }, useState(value: unknown) { return [typeof value === "function" ? (value as () => unknown)() : value, () => {}]; }, Fragment: Symbol("Fragment"),
    };
    if (name === "react-dom") return { createPortal(value: unknown) { return value; } };
    throw new Error(`unexpected client require ${name}`);
  }).__testing;
}

test("shared client projection separates proposal, same-turn, child, and handback evidence", async () => {
  const client = await loadClient("odai-dsh-agent", ["odai-dsh-agent"]);
  const trace = client.projectTrace([
    { seq: 1, type: "odai/responsibility-gap", data: { turn: 1, step: 1, responsibility: "planner" } },
    { seq: 2, type: "odai/route-upgrade", data: { turn: 1, step: 2, targetRole: "planner" } },
    { seq: 3, type: "odai/route-result", data: { turn: 1, step: 3, role: "reviewer", action: "delegate", status: "completed" } },
    { seq: 4, type: "odai/responsibility-returned", data: { turn: 1, step: 4, responsibility: "planner" } },
  ]);
  assert.deepEqual(Array.from(trace.items, (item) => item.state), ["proposal", "same-turn", "child", "handback"]);
  assert.equal(trace.currentRoles.planner?.state, "handback");
  assert.equal(trace.currentRoles.reviewer?.state, "child");
});

test("each package owns the surface when installed alone", async () => {
  assert.equal((await loadClient("odai-dsh-agent", ["odai-dsh-agent"])).shouldOwnSurface(), true);
  assert.equal((await loadClient("odai-dsh-plugin", ["odai-dsh-plugin"])).shouldOwnSurface(), true);
});

test("coexistence gives exactly one surface to Plugin regardless of boot order", async () => {
  for (const entries of [
    ["odai-dsh-agent", "odai-dsh-plugin"],
    ["odai-dsh-plugin", "odai-dsh-agent"],
  ]) {
    const ownership = await Promise.all([
      loadClient("odai-dsh-agent", entries).then((client) => client.shouldOwnSurface()),
      loadClient("odai-dsh-plugin", entries).then((client) => client.shouldOwnSurface()),
    ]);
    assert.deepEqual(ownership, [false, true]);
    assert.equal(ownership.filter(Boolean).length, 1);
  }
});
