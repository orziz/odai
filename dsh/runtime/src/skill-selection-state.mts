import type { DshAgent } from "./runtime-types.mjs";
import { isUnknownRecord, sessionEvents } from "./runtime-types.mjs";

const SHARED_SELECTION_STATE = Symbol.for("odai.dsh.skill-selection-state.v1");
type SelectionGeneration = number | "unknown";

interface SelectionState<T> {
  generation: SelectionGeneration;
  promise: Promise<T>;
  selection?: T;
}

interface SharedSelectionStore {
  selections: WeakMap<object, SelectionState<unknown>>;
}

interface SymbolIndexedGlobal {
  [key: symbol]: unknown;
}

function isSharedStore(value: unknown): value is SharedSelectionStore {
  return isUnknownRecord(value) && value.selections instanceof WeakMap;
}

function sharedStore(): SharedSelectionStore {
  const root = globalThis as typeof globalThis & SymbolIndexedGlobal;
  const existing = root[SHARED_SELECTION_STATE];
  if (isSharedStore(existing)) return existing;
  const created = Object.freeze({
    selections: new WeakMap<object, SelectionState<unknown>>(),
  });
  Object.defineProperty(root, SHARED_SELECTION_STATE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: created,
  });
  return created;
}

export function currentAgentTurn(agent: DshAgent | null | undefined): number | undefined {
  const phaseTurn = agent?.phase?.turn;
  if (Number.isSafeInteger(phaseTurn) && (phaseTurn ?? -1) >= 0) return phaseTurn;
  const events = sessionEvents(agent?.session);
  if (events.length === 0) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const turn = event?.data?.turn;
    if (event?.type === "turn/start" && Number.isSafeInteger(turn)) return turn;
  }
  return undefined;
}

export async function selectSharedSkillForTurn<T>(
  agent: DshAgent,
  select: () => T | Promise<T>,
): Promise<T> {
  if (!agent || typeof agent !== "object") throw new TypeError("an agent is required for Odai skill selection");
  if (typeof select !== "function") throw new TypeError("Odai skill selector must be a function");
  const turn = currentAgentTurn(agent);
  const generation: SelectionGeneration = turn === undefined ? "unknown" : turn;
  const store = sharedStore();
  const existing = store.selections.get(agent) as SelectionState<T> | undefined;
  if (existing?.generation === generation) return existing.promise;

  const state: SelectionState<T> = {
    generation,
    promise: Promise.resolve().then(select).then((selection) => {
      state.selection = selection;
      return selection;
    }).catch((error: unknown) => {
      if (store.selections.get(agent) === state) store.selections.delete(agent);
      throw error;
    }),
  };
  store.selections.set(agent, state);
  return state.promise;
}

export function sharedSkillSelection<T>(
  agent: DshAgent,
  turn = currentAgentTurn(agent),
): T | undefined {
  const state = sharedStore().selections.get(agent) as SelectionState<T> | undefined;
  const generation: SelectionGeneration = turn === undefined ? "unknown" : turn;
  if (state?.generation !== generation) return undefined;
  return state.selection;
}
