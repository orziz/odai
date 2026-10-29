import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeTool } from './openai-compatible-canary-runner.mjs';

test('write_file confines new files through symlink ancestors and refuses replacement', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'odai-write-boundary-')));
  try {
    const root = join(scratch, 'fixture');
    const outside = join(scratch, 'outside');
    mkdirSync(root); mkdirSync(join(outside, 'nested'), { recursive: true });
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['link/new.txt', 'link/nested/new.txt']) {
      assert.throws(() => executeTool(root, 'write_file', { path, content: 'escaped' }), /outside|parent directory/);
    }
    assert.equal(existsSync(join(outside, 'new.txt')), false);
    assert.equal(existsSync(join(outside, 'nested/new.txt')), false);
    executeTool(root, 'write_file', { path: 'safe.txt', content: 'original' });
    assert.equal(readFileSync(join(root, 'safe.txt'), 'utf8'), 'original');
    assert.throws(() => executeTool(root, 'write_file', { path: 'safe.txt', content: 'overwrite' }), /overwrite/);
    assert.equal(readFileSync(join(root, 'safe.txt'), 'utf8'), 'original');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
