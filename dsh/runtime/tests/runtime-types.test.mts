import assert from "node:assert/strict";
import test from "node:test";

import { sessionEvents } from "../src/runtime-types.mjs";
import type { DshEvent } from "../src/runtime-types.mjs";

const legacyEvent: DshEvent = { type: "legacy", seq: 0, data: {} };
const nativeEvent: DshEvent = { type: "native", seq: 0, data: {} };

test("sessionEvents reads the rc.2 events array", () => {
  assert.deepEqual(sessionEvents({ events: [legacyEvent] }), [legacyEvent]);
});

test("sessionEvents prefers the alpha.4 immutable snapshot API", () => {
  let calls = 0;
  const events = sessionEvents({
    events: [legacyEvent],
    snapshotEvents: () => {
      calls += 1;
      return Object.freeze([nativeEvent]);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(events, [nativeEvent]);
});

test("sessionEvents returns an empty immutable-compatible view when unavailable", () => {
  assert.deepEqual(sessionEvents(undefined), []);
  assert.deepEqual(sessionEvents({}), []);
});
