import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

interface TestingTraceItem {
  key: string;
  state: string;
  role: string;
  turn?: number;
}

interface TestingTraceGroup {
  key: string;
  turn?: number;
  title: string;
  items: TestingTraceItem[];
}

interface TestingTrace {
  items: TestingTraceItem[];
  turns: TestingTraceGroup[];
  currentTurn?: TestingTraceGroup;
  currentRoles: Record<string, TestingTraceItem | undefined>;
}

interface ClientTesting {
  conversationTraceSource(conversation: unknown, sessionId?: string): { getSnapshot(): unknown; subscribe(listener: () => void): () => void };
  defaultTraceItem(trace: TestingTrace): TestingTraceItem | undefined;
  legacyTraceView(snapshot: unknown): { events?: unknown[] };
  projectTrace(events: unknown[]): TestingTrace;
  shouldOwnSurface(): boolean;
  traceFingerprint(events: unknown[]): string;
  windowTurnItems<T extends { key: string }>(items: T[], limit: number, selectedKey?: string): T[];
}

interface ClientExports {
  apply(ctx: unknown): void;
  inject: readonly string[];
  __testing: ClientTesting;
}

interface ClientRegistration {
  id: string;
  factory(require_: (name: string) => unknown): ClientExports;
}

async function loadClientModule(packageId: "odai-dsh-agent" | "odai-dsh-plugin", entries: string[]): Promise<ClientExports> {
  const template = await readFile(resolve(import.meta.dirname, "../../client/build/client.js"), "utf8");
  const source = template.replaceAll("__ODAI_CLIENT_PACKAGE__", packageId);
  let registration: ClientRegistration | undefined;
  const context: Record<string, unknown> = {
    __DSH_BOOT__: { entries: entries.map((id) => ({ id })) },
    document: { querySelector() { return {}; } },
    window: { __ModuleLoader__: { load(value: ClientRegistration) { registration = value; } } },
  };
  vm.runInNewContext(source, context, { filename: `${packageId}/client.js` });
  assert.ok(registration);
  assert.equal(registration.id, packageId);
  return registration.factory((name) => {
    if (name === "react") return {
      createElement() {}, useEffect() {}, useMemo(value: () => unknown) { return value(); }, useRef() { return { current: null }; }, useState(value: unknown) { return [typeof value === "function" ? (value as () => unknown)() : value, () => {}]; }, useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); }, Fragment: Symbol("Fragment"),
    };
    if (name === "react-dom") return { createPortal(value: unknown) { return value; } };
    throw new Error(`unexpected client require ${name}`);
  });
}

async function loadClient(packageId: "odai-dsh-agent" | "odai-dsh-plugin", entries: string[]): Promise<ClientTesting> {
  return (await loadClientModule(packageId, entries)).__testing;
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

test("timeline orders groups by recent evidence without defaulting to out-of-turn evidence", async () => {
  const client = await loadClient("odai-dsh-agent", ["odai-dsh-agent"]);
  const trace = client.projectTrace([
    { seq: 1, type: "odai/route-decided", data: { turn: 1, step: 1 } },
    { seq: 2, type: "odai/routing-configured", data: {} },
    { seq: 3, type: "odai/route-result", data: { turn: 2, step: 1, status: "completed" } },
    { seq: 4, type: "odai/routing-configured", data: {} },
  ]);
  assert.deepEqual(Array.from(trace.turns, (turn) => turn.key), ["session", "turn-2", "turn-1"]);
  assert.equal(trace.turns[0]?.title, "轮次外事件");
  assert.equal(trace.currentTurn?.key, "turn-2");
  assert.equal(client.defaultTraceItem(trace)?.key, "3:odai/route-result");

  const sessionOnly = client.projectTrace([
    { seq: 5, type: "odai/routing-configured", data: {} },
  ]);
  assert.equal(sessionOnly.currentTurn?.key, "session");
  assert.equal(client.defaultTraceItem(sessionOnly)?.key, "5:odai/routing-configured");
});

test("timeline helpers skip unchanged append-only evidence and bound mounted rows", async () => {
  const client = await loadClient("odai-dsh-agent", ["odai-dsh-agent"]);
  const events = [
    { seq: 1, time: 100, type: "odai/route-decided" },
    { seq: 2, time: 200, type: "odai/route-result" },
  ];
  assert.equal(client.traceFingerprint(events), client.traceFingerprint(events.map((event) => ({ ...event }))));
  assert.notEqual(client.traceFingerprint(events), client.traceFingerprint([...events, { seq: 3, time: 300, type: "odai/responsibility-returned" }]));

  const items = Array.from({ length: 250 }, (_, index) => ({ key: `event-${index}` }));
  assert.deepEqual(Array.from(client.windowTurnItems(items, 100), (item) => item.key), items.slice(150).map((item) => item.key));
  const selectedWindow = client.windowTurnItems(items, 100, "event-40");
  assert.equal(selectedWindow.length, 100);
  assert.ok(selectedWindow.some((item) => item.key === "event-40"));
});

test("trace data resolves through legacy snapshots or modern conversation bindings", async () => {
  const client = await loadClient("odai-dsh-agent", ["odai-dsh-agent"]);
  const legacy = { events: [{ seq: 1 }] };
  assert.equal(client.legacyTraceView({ views: new Map([["odaiControlCenter", legacy]]) }), legacy);
  assert.equal(client.legacyTraceView({}).events?.length, 0);

  const source = { getSnapshot: () => legacy, subscribe: () => () => {} };
  const conversation = {
    binding(sessionId: string) {
      assert.equal(sessionId, "session-modern");
      return {
        target(target: string) {
          assert.equal(target, "odaiControlCenter");
          return source;
        },
      };
    },
  };
  assert.equal(client.conversationTraceSource(conversation, "session-modern"), source);
  const fallback = client.conversationTraceSource(undefined).getSnapshot() as { events: unknown[] };
  assert.equal(fallback.events.length, 0);
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

interface SurfaceHarness {
  effects: Array<() => void>;
  live: Set<string>;
  listeners: Set<(name: string, value: unknown) => void>;
  reads: string[];
  registrations: Array<{ kind: string; value: Record<string, unknown> }>;
  services: Map<string, unknown>;
  makePair(label: string): { events: unknown; views: unknown };
  notify(name: string): void;
  dispose(): void;
}

function mountSurfaceHarness(
  client: ClientExports,
  prepare: (harness: Pick<SurfaceHarness, "makePair" | "services">) => void,
): SurfaceHarness {
  const effects: Array<() => void> = [];
  const live = new Set<string>();
  const listeners = new Set<(name: string, value: unknown) => void>();
  const reads: string[] = [];
  const registrations: Array<{ kind: string; value: Record<string, unknown> }> = [];
  const services = new Map<string, unknown>();
  let registrationLabel = "unknown";
  const makePair = (label: string) => {
    const registry = (kind: "event" | "view") => ({
      register(value: Record<string, unknown>) {
        registrationLabel = label;
        const key = `${label}:${kind}`;
        live.add(key);
        registrations.push({ kind, value });
        return () => { live.delete(key); };
      },
    });
    return { events: registry("event"), views: registry("view") };
  };
  prepare({ makePair, services });
  const target = {
    sessions: {},
    connection: {},
    get(name: string) {
      reads.push(name);
      return services.get(name);
    },
    on(name: string, listener: (service: string, value: unknown) => void) {
      assert.equal(name, "internal/service");
      listeners.add(listener);
      const dispose = () => { listeners.delete(listener); };
      effects.push(dispose);
      return dispose;
    },
    effect(setup: () => (() => void)) {
      const dispose = setup();
      effects.push(dispose);
      return dispose;
    },
    slots: {
      inject(name: string, activate: () => (() => void)) {
        registrations.push({ kind: "slot-inject", value: { name } });
        const dispose = activate();
        return () => { dispose(); };
      },
      register(value: Record<string, unknown>) {
        const key = `${registrationLabel}:slot`;
        live.add(key);
        registrations.push({ kind: "slot", value });
        return () => { live.delete(key); };
      },
    },
  };
  const facade = new Proxy(target, {
    get(object, property, receiver) {
      if (property === "inject") throw new Error("dynamic facade does not expose ctx.inject");
      return Reflect.get(object, property, receiver);
    },
  });
  client.apply(facade);
  return {
    effects,
    live,
    listeners,
    reads,
    registrations,
    services,
    makePair,
    notify(name: string) {
      for (const listener of [...listeners]) listener(name, services.get(name));
    },
    dispose() {
      while (effects.length > 0) effects.pop()?.();
    },
  };
}

test("Control Center activates through the dynamic facade on both registry families", async () => {
  for (const generation of ["legacy", "uiConversation"] as const) {
    const client = await loadClientModule("odai-dsh-agent", ["odai-dsh-agent"]);
    assert.deepEqual(Array.from(client.inject), ["slots", "sessions", "connection"]);
    const harness = mountSurfaceHarness(client, ({ makePair, services }) => {
      const pair = makePair(generation);
      if (generation === "uiConversation") services.set("uiConversation", pair);
      else {
        services.set("conversationEvents", pair.events);
        services.set("conversationViews", pair.views);
      }
    });

    assert.deepEqual(harness.reads, generation === "uiConversation"
      ? ["uiConversation"]
      : ["uiConversation", "conversationEvents", "conversationViews"]);
    assert.equal(harness.listeners.size, 1);
    assert.equal(harness.registrations.filter((entry) => entry.kind === "event")[0]?.value.kind, "odai-control-center:event");
    assert.equal(harness.registrations.filter((entry) => entry.kind === "view")[0]?.value.target, "odaiControlCenter");
    assert.equal(harness.registrations.filter((entry) => entry.kind === "slot")[0]?.value.id, "odai-control-center");
    assert.equal(harness.live.size, 3);
    harness.dispose();
    assert.equal(harness.live.size, 0);
    assert.equal(harness.listeners.size, 0);
  }
});

test("service changes preserve modern precedence and remount only the authoritative registries", async () => {
  let legacyFirst: { events: unknown; views: unknown } | undefined;
  const client = await loadClientModule("odai-dsh-agent", ["odai-dsh-agent"]);
  const harness = mountSurfaceHarness(client, ({ makePair, services }) => {
    legacyFirst = makePair("legacy-first");
    services.set("conversationEvents", legacyFirst.events);
    services.set("conversationViews", legacyFirst.views);
  });
  assert.deepEqual(Array.from(harness.live), ["legacy-first:view", "legacy-first:event", "legacy-first:slot"]);

  const modern = harness.makePair("modern");
  harness.services.set("uiConversation", modern);
  harness.notify("uiConversation");
  assert.deepEqual(Array.from(harness.live), ["modern:view", "modern:event", "modern:slot"]);

  const legacyRestart = harness.makePair("legacy-restart");
  harness.services.set("conversationEvents", legacyRestart.events);
  harness.services.set("conversationViews", legacyRestart.views);
  harness.notify("conversationEvents");
  harness.notify("conversationViews");
  assert.deepEqual(Array.from(harness.live), ["modern:view", "modern:event", "modern:slot"]);

  const modernRestart = harness.makePair("modern-restart");
  harness.services.set("uiConversation", modernRestart);
  harness.notify("uiConversation");
  assert.deepEqual(Array.from(harness.live), ["modern-restart:view", "modern-restart:event", "modern-restart:slot"]);
  const mountedSlots = () => harness.registrations.filter((entry) => entry.kind === "slot").length;
  const mountsBeforeDuplicate = mountedSlots();
  harness.notify("uiConversation");
  assert.equal(mountedSlots(), mountsBeforeDuplicate);

  const modernServiceRestart = { events: modernRestart.events, views: modernRestart.views };
  harness.services.set("uiConversation", modernServiceRestart);
  harness.notify("uiConversation");
  assert.equal(mountedSlots(), mountsBeforeDuplicate + 1);
  assert.deepEqual(Array.from(harness.live), ["modern-restart:view", "modern-restart:event", "modern-restart:slot"]);

  harness.services.delete("uiConversation");
  harness.notify("uiConversation");
  assert.deepEqual(Array.from(harness.live), ["legacy-restart:view", "legacy-restart:event", "legacy-restart:slot"]);

  harness.dispose();
  assert.equal(harness.live.size, 0);
});
