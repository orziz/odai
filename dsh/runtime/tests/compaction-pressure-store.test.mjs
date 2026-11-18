import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compactionPressurePath, readCompactionPressure, writeCompactionPressure} from '../build/compaction-pressure-store.mjs';

test('pressure selection survives reload independently of summarizer target resets', () => {
  const root = mkdtempSync(join(tmpdir(), 'odai-pressure-store-'));
  try {
    const model = join(root, 'model.json');
    const path = compactionPressurePath(model);
    assert.deepEqual(readCompactionPressure(path), {mode: 'host', valid: true});
    writeFileSync(model, '{"target":{"provider":"example","model":"model"}}');
    writeCompactionPressure(path, 'window-ratio');
    assert.equal(readCompactionPressure(path).mode, 'window-ratio');
    assert.equal(JSON.parse(readFileSync(model, 'utf8')).target.model, 'model');
    rmSync(model);
    assert.equal(readCompactionPressure(path).mode, 'window-ratio');
    writeCompactionPressure(path, 'host');
    assert.deepEqual(readCompactionPressure(path), {mode: 'host', valid: true});
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('corrupt selection falls back visibly and explicit repair preserves original bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'odai-pressure-store-'));
  try {
    const path = join(root, 'pressure.json');
    writeFileSync(path, 'broken data');
    assert.equal(readCompactionPressure(path).valid, false);
    assert.equal(readCompactionPressure(path).mode, 'host');
    assert.throws(() => writeCompactionPressure(path, 'invalid'));
    assert.equal(readFileSync(path, 'utf8'), 'broken data');
    const result = writeCompactionPressure(path, 'host');
    assert.equal(result.valid, true);
    assert.equal(readFileSync(result.backupPath, 'utf8'), 'broken data');
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('compaction engine and custom governance configPath cooperate in either mount order while rejecting mismatched explicit configs', async () => {
  const { acquirePressureRuntime } = await import('../build/bootstrap.mjs');
  const root = mkdtempSync(join(tmpdir(), 'odai-pressure-bootstrap-'));
  try {
    const customConfig = { compaction: { configPath: join(root, 'custom', 'compaction.json') } };
    const otherConfig = { compaction: { configPath: join(root, 'other', 'compaction.json') } };
    const makeHost = () => {
      const effects = [];
      const rootCtx = {
        plugin(fn) {
          fn({
            on() {},
            effect() {},
            inject(_deps, cb) { cb({ get() { return undefined; } }); },
            get() { return undefined; },
          });
          return { async dispose() {} };
        },
      };
      return {
        ctx: { root: rootCtx, effect(fn) { effects.push(fn()); } },
        async dispose() { for (const cleanup of effects) await cleanup?.(); },
      };
    };

    const engineFirst = makeHost();
    const fromEngine = acquirePressureRuntime(engineFirst.ctx, undefined, { explicitConfig: false });
    const fromGovernance = acquirePressureRuntime(engineFirst.ctx, customConfig, { explicitConfig: true });
    assert.equal(fromEngine, fromGovernance);
    assert.equal(fromGovernance.path, compactionPressurePath(customConfig.compaction.configPath));
    assert.throws(
      () => acquirePressureRuntime(engineFirst.ctx, otherConfig, { explicitConfig: true }),
      /same compaction configuration path/u,
    );
    await engineFirst.dispose();

    const governanceFirst = makeHost();
    const firstGov = acquirePressureRuntime(governanceFirst.ctx, customConfig, { explicitConfig: true });
    const secondEng = acquirePressureRuntime(governanceFirst.ctx, undefined, { explicitConfig: false });
    assert.equal(firstGov, secondEng);
    assert.equal(secondEng.path, compactionPressurePath(customConfig.compaction.configPath));
    await governanceFirst.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
