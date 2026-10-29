import test from 'node:test';
import assert from 'node:assert/strict';
import { runRoutedRole, isManagedRoleChild } from '../build/runtime-support.mjs';

const route = { provider: 'test', model: 'test-model' };
function options(signal = new AbortController().signal) {
  return { provider: 'spawn', decision: { role: 'planner' }, taskText: 'inspect', roleContract: 'read only', agent: { session: { header: { id: 'parent' } } }, signal, roleRoute: route };
}
for (const receipt of ['applied', 'mismatch', 'unverified']) {
  test(`activation authenticates retained child route: ${receipt}`, async () => {
    let cleanups = 0;
    const args = options();
    const outcome = await runRoutedRole({ ...args, subagents: { async startActivation(spec) {
      assert.equal(spec.delivery, 'caller');
      assert.equal(spec.provider, 'spawn');
      assert.equal(spec.signal, args.signal);
      assert.equal(spec.request.parent, args.agent);
      assert.equal(spec.request.maxDepth, 1);
      assert.equal(spec.request.signal, undefined);
      const session = { header: { id: 'child', parentSession: 'parent', origin: 'subagent' }, snapshotEvents: () => [
        { type: 'subagent/descriptor', data: { label: spec.label } },
        { type: 'request/header', data: { header: { config: receipt === 'mismatch' ? { ...route, model: 'wrong' } : route } } },
      ] };
      assert.equal(isManagedRoleChild({ session }), true);
      return { childId: receipt === 'unverified' ? 'different-child' : 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), async dispose() { cleanups++; } };
    } } });
    assert.equal(outcome.routeReceiptStatus, receipt);
    assert.equal(outcome.status, receipt === 'applied' ? 'completed' : 'fallback');
    assert.equal(cleanups, 1);
  });
}
for (const timing of ['during-publication', 'after-publication']) {
  test(`activation cancellation disposes once ${timing}`, async () => {
    const controller = new AbortController(); let cleanups = 0;
    const outcome = await runRoutedRole({ ...options(controller.signal), subagents: { async startActivation() {
      let finish;
      const result = new Promise(resolve => { finish = resolve; });
      if (timing === 'during-publication') controller.abort();
      else setImmediate(() => controller.abort());
      return { childId: 'child', result, async dispose() { cleanups++; finish({ stopReason: 'completed', output: [{ type: 'text', text: 'late' }] }); } };
    } } });
    assert.equal(cleanups, 1);
    assert.equal(outcome.stopReason, 'cancelled');
    assert.deepEqual(outcome.output, []);
  });
}

test('pre-cancelled activation never starts', async () => {
  const controller = new AbortController(); controller.abort();
  const outcome = await runRoutedRole({ ...options(controller.signal), subagents: { async startActivation() { assert.fail('must not start'); } } });
  assert.equal(outcome.stopReason, 'cancelled');
});

test('cancelled child cleanup failure returns infrastructure error without hanging', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let cleanups = 0;
  const outcome = await runRoutedRole({ ...options(controller.signal), subagents: { async startActivation() {
    setImmediate(() => controller.abort());
    return { result: new Promise(() => {}), async dispose() { cleanups++; throw new Error('cleanup fault'); } };
  } } });
  assert.equal(cleanups, 1);
  assert.equal(outcome.stopReason, 'infrastructure-error');
  assert.match(outcome.error, /cleanup fault/);
  assert.deepEqual(outcome.output, []);
});
