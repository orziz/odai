import assert from "node:assert/strict";
import test from "node:test";
import { sessionEvents } from "../build/runtime-types.mjs";
const nativeEvent = { type: "native", seq: 0, data: {} };
test("sessionEvents reads the rc.1 immutable Session snapshot API", () => {
  let calls = 0;
  const events = sessionEvents({
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
