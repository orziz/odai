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
