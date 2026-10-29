import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliModels, discoverCliModels } from '../build/local-cli-catalog.mjs';

test('CLI catalogs preserve backend IDs and ignore diagnostics', () => {
  assert.deepEqual(parseCliModels('antigravity', 'model-high\tModel (High)\nwarning: not signed in\nmodel-high\tModel (High)\n'), [{id:'model-high',name:'Model (High)'}]);
  assert.deepEqual(parseCliModels('grok', 'You are not authenticated.\nAvailable models:\n  * example-1 (default)\n  - example-2\n'), [{id:'example-1',name:'example-1'},{id:'example-2',name:'example-2'}]);
  assert.deepEqual(parseCliModels('claude', "  --model <model> Model alias (e.g.\n    'alpha', 'beta') or full name.\n  --other 'unrelated'\n"), [{id:'alpha',name:'alpha（CLI 别名）'},{id:'beta',name:'beta（CLI 别名）'}]);
  assert.deepEqual(parseCliModels('grok', 'unknown output'), []);
});

test('unknown CLI cannot become an executable or shell command', async () => {
  await assert.rejects(discoverCliModels('echo injected'), /不支持/);
});
