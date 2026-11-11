import assert from 'node:assert/strict';
import test from 'node:test';
import { compactAtWindowRatio, resolveCompactionPressureMode, windowRatioThreshold, windowRatioRange } from '../build/compaction-policy.mjs';

test('pressure mode defaults to unchanged host behavior and rejects unknown modes', () => {
  assert.equal(resolveCompactionPressureMode(undefined), 'host');
  assert.equal(resolveCompactionPressureMode('window-ratio'), 'window-ratio');
  assert.throws(() => resolveCompactionPressureMode('off'));
  assert.equal(windowRatioThreshold(100000), 80000);
  for (const value of [0, -1, Infinity, NaN, 1.5]) assert.throws(() => windowRatioThreshold(value));
});

test('selection preserves system head, recent tail and complete tool exchange', () => {
  const options = { surface: [1, 8, 3, 9, 10], priced: [1, 8, 3, 9, 10].map(seq => ({seq, tokens: 10})), contextWindow: 100, systemHead: true, balancedBefore: seq => seq !== 9 };
  assert.deepEqual(windowRatioRange(options), {start: 8, end: 8});
  assert.deepEqual(windowRatioRange({...options, retainTokens: 0}), {start: 8, end: 9});
  assert.equal(windowRatioRange({...options, retainTokens: 40}), null);
  assert.throws(() => windowRatioRange({...options, retainTokens: 80}), /retained tail/);
  assert.equal(windowRatioRange({...options, balancedBefore: () => false}), null);
  assert.throws(() => windowRatioRange({...options, surface: [1, 3, 8, 9, 10]}), /stale/);
});

test('pressure triggers at 80 percent, remeasures, and preserves cancellation and switch failures', async () => {
  let totalTokens = 79, calls = 0;
  const controller = new AbortController();
  const options = {contextWindow: 100, signal: controller.signal, retries: 1, requireBelowThreshold: false,
    measure: () => ({totalTokens, range: {start: 1, end: 2}}),
    compact: async (_start, _end, signal) => {assert.equal(signal, controller.signal); calls++; totalTokens = 40;}};
  assert.equal(await compactAtWindowRatio(options), false);
  assert.equal(calls, 0);
  totalTokens = 80;
  assert.equal(await compactAtWindowRatio(options), true);
  assert.equal(calls, 1);
  const noRange = {...options, requireBelowThreshold: true, measure: () => ({totalTokens: 90, range: null})};
  await assert.rejects(compactAtWindowRatio(noRange), /No balanced/);
  assert.equal(await compactAtWindowRatio({...noRange, requireBelowThreshold: false}), false);
  await assert.rejects(compactAtWindowRatio({...options, measure: () => ({totalTokens: 90, range: {start: 1, end: 2}})}), /remains above/);
  controller.abort();
  await assert.rejects(compactAtWindowRatio(options), {name: 'AbortError'});
});

test('single useful node and empty surface cannot be compacted away', () => {
  for (const surface of [[], [7]]) assert.equal(windowRatioRange({surface, priced: surface.map(seq => ({seq, tokens: 100})), contextWindow: 100, systemHead: false, balancedBefore: () => true}), null);
});
