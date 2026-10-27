import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const scripts = path.resolve('skills/odai-orchestration/scripts');
function run(script, args, input) { return spawnSync(process.execPath, [path.join(scripts, script), ...args], { encoding: 'utf8', input: input && JSON.stringify(input) }); }
for (const host of ['claude', 'codex']) test(`${host}: named lifecycle and ownership`, () => {
 const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'odai-named-test-'));
 const options = ['--host', host, '--scope', 'project', '--target', dir, '--controller-model', 'gpt-test', '--planner-model', host === 'claude' ? 'claude-test' : 'gpt-test', '--reviewer-model', host === 'claude' ? 'claude-test' : 'gpt-test', '--yes'];
 const config = path.join(dir, '.' + host);
 if (host === 'claude') { mkdirSync(config); writeFileSync(path.join(config, 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'guardrail' }] }] } })); }
 let result = run('install-routing.mjs', [...options, '--named-dispatch']); assert.equal(result.status, 0, result.stderr);
 const hook = (event, extra = {}) => spawnSync(process.execPath, [path.join(config, 'odai-route-hook.mjs')], { encoding: 'utf8', input: JSON.stringify({ session_id: 'one', agent_type: 'odai-controller', cwd: dir, hook_event_name: event, ...extra }) });
 const name = host === 'claude' ? 'Claude' : 'GPT';
 assert.match(hook('UserPromptSubmit', { prompt: `先让 ${name} 规划` }).stdout, /planner/);
 assert.equal(hook('PreToolUse', { tool_name: 'Read' }).status, 0);
 assert.equal(hook('PreToolUse', { tool_name: 'apply_patch' }).status, 2);
 const invoke = { tool_name: host === 'claude' ? 'Agent' : 'spawn_agent', tool_input: { [host === 'claude' ? 'subagent_type' : 'agent_type']: host === 'claude' ? 'odai-planner' : 'odai_planner' } };
 assert.equal(hook('PreToolUse', invoke).status, 0);
 assert.equal(hook('PostToolUse', { ...invoke, tool_response: host === 'codex' ? { agent_id: 'child' } : { status: 'completed', content: [{ type: 'text', text: 'plan' }] } }).status, 0);
 if (host === 'codex') {
    const marketplace = JSON.parse(readFileSync(path.join(config, '.agents/plugins/marketplace.json')));
    assert.deepEqual(marketplace, { name: 'odai-local-routing', plugins: [{ name: 'odai-named-dispatch', source: './named-dispatch-plugin' }] });
    hook('UserPromptSubmit', { prompt: '<subagent_notification>{"agent_id":"child","status":"completed"}</subagent_notification>' });
    assert.equal(hook('Stop').stdout, '');
   assert.equal(hook('PreToolUse', { tool_name: 'apply_patch' }).status, 2);
   hook('PostToolUse', { tool_name: 'wait', tool_input: { ids: ['child'] }, tool_response: { status: { child: { completed: 'plan' } } } });
 }
 assert.equal(hook('PreToolUse', { tool_name: 'apply_patch' }).status, 0);
 hook('UserPromptSubmit', { prompt: `做完让 ${name} 验收` });
 assert.equal(hook('Stop', { stop_hook_active: true }).stdout, '');
 assert.match(hook('Stop').stdout, /block/);
 assert.equal(hook('Stop').stdout, '');
 hook('UserPromptSubmit', { prompt: '继续' }); assert.equal(hook('Stop').stdout, '');
 hook('UserPromptSubmit', { prompt: '新任务' }); assert.equal(hook('Stop').stdout, '');
 hook('UserPromptSubmit', { prompt: '先让 Grok 规划' }); assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 0);
 result = run('install-routing.mjs', [...options, '--named-dispatch']); assert.equal(result.status, 0, result.stderr);
 if (host === 'claude') assert.equal(JSON.parse(readFileSync(path.join(config, 'settings.local.json'))).hooks.Stop.length, 2);
 const managedHook = path.join(config, 'odai-route-hook.mjs');
 const originalHook = readFileSync(managedHook);
 writeFileSync(managedHook, 'external edit');
 result = run('install-routing.mjs', [...options, '--named-dispatch']); assert.notEqual(result.status, 0); assert.match(result.stderr, /漂移/);
 writeFileSync(managedHook, originalHook);
 result = run('install-routing.mjs', options); assert.equal(result.status, 0, result.stderr);
 assert.equal(readdirSync(config).includes('odai-route-hook.mjs'), false);
 if (host === 'claude') assert.equal(JSON.parse(readFileSync(path.join(config, 'settings.local.json'))).hooks.Stop.length, 1);
 result = run('install-routing.mjs', ['--host', host, '--scope', 'project', '--target', dir, '--uninstall', '--yes']); assert.equal(result.status, 0, result.stderr);
 if (host === 'claude') assert.equal(JSON.parse(readFileSync(path.join(config, 'settings.local.json'))).hooks.Stop[0].hooks[0].command, 'guardrail');
});

test('Claude real async notifications preserve pending work and defer completion nudges', () => {
 const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'odai-async-hook-'));
 const options = ['--host', 'claude', '--scope', 'project', '--target', dir, '--controller-model', 'haiku', '--planner-model', 'haiku', '--reviewer-model', 'haiku', '--named-dispatch', '--yes'];
 assert.equal(run('install-routing.mjs', options).status, 0);
 const hook = (event, extra = {}) => spawnSync(process.execPath, [path.join(dir, '.claude/odai-route-hook.mjs')], { encoding: 'utf8', input: JSON.stringify({ session_id: 'async', cwd: dir, hook_event_name: event, ...extra }) });
 const state = () => JSON.parse(readFileSync(path.join(dir, '.claude/named-dispatch', readdirSync(path.join(dir, '.claude/named-dispatch')).find(f => f.endsWith('.json')))));
 const prompt = () => hook('UserPromptSubmit', { prompt: '先让 Claude 规划，做完让 Claude 验收' });
 const invoke = { tool_name: 'Agent', tool_use_id: 'toolu_plan', tool_input: { subagent_type: 'odai-planner' } };
 const launch = () => hook('PostToolUse', { ...invoke, tool_response: { isAsync: true, status: 'async_launched', agentId: 'agent-plan', resolvedModel: 'claude-haiku-5-5', outputFile: '/tmp/plan.output', canReadOutputFile: true, canContinueAgent: true } });
 const notify = (status, id = 'toolu_plan') => hook('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>agent-plan</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/plan.output</output-file>\n${status ? `<status>${status}</status>` : ''}\n<summary>Agent finished</summary>\n</task-notification>` });
 prompt(); assert.equal(hook('Stop').stdout, '');
 assert.match(launch().stdout, /claude-haiku-5-5/);
  assert.equal(state().requests[0].resolvedModel, 'claude-haiku-5-5');
  assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 2);
  assert.equal(state().requests[0].toolUseId, 'toolu_plan');
 assert.equal(hook('Stop').stdout, ''); assert.equal(state().requests[1].nudged, undefined);
 notify(''); notify('running');
 assert.equal(state().requests[0].done, undefined);
 hook('UserPromptSubmit', { prompt: '<system-reminder>Host context</system-reminder>' });
 assert.equal(state().requests.length, 2);
 notify('completed'); assert.equal(state().requests[0].result, 'satisfied');
 assert.equal(state().requests.length, 2); assert.match(hook('Stop').stdout, /block/); assert.equal(hook('Stop').stdout, '');
 for (const status of ['failed', 'killed', 'cancelled']) {
   prompt(); launch(); assert.match(notify(status).stdout, /不重试/);
   assert.equal(state().requests[0].result, 'failed'); assert.match(hook('Stop').stdout, /block/);
 }
 // Fall back to task-id when tool-use-id does not match.
 prompt(); launch(); notify('completed', 'unrelated');
 assert.equal(state().requests[0].result, 'satisfied');
 for (const status of ['running', 'unknown', undefined]) {
   prompt(); hook('PostToolUse', { ...invoke, tool_response: { status, content: [{ type: 'text', text: '好' }] } });
   assert.equal(state().requests[0].done, undefined);
   assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 2);
 }
 prompt(); const sync = hook('PostToolUse', { ...invoke, tool_response: { status: 'completed', agentId: 'a666', agentType: 'general-purpose', content: [{ type: 'text', text: '好' }], resolvedModel: 'claude-sonnet-5-5', totalDurationMs: 100, totalTokens: 10, usage: {} } });
 assert.equal(state().requests[0].resolvedModel, 'claude-sonnet-5-5');
 assert.match(sync.stdout, /明显不符/);
 assert.match(sync.stdout, /不采用子代理自报/);
 assert.equal(state().requests[0].result, 'satisfied');
 assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 0);
 assert.match(hook('Stop').stdout, /block/);
});

test('local executor invocation needs fresh verified evidence; default build has no Hook', () => {
 const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'odai-local-hook-'));
 const base = ['--host', 'codex', '--out', dir, '--controller-model', 'gpt-test', '--planner-model', 'haiku', '--planner-cli', 'claude', '--reviewer-model', 'gpt-test'];
 assert.equal(run('build-routing.mjs', base).status, 0);
 const config = path.join(dir, 'codex/.codex');
 assert.equal(readdirSync(config).includes('odai-route-hook.mjs'), false);
 assert.equal(run('build-routing.mjs', [...base, '--named-dispatch']).status, 0);
 const hook = (event, extra = {}) => spawnSync(process.execPath, [path.join(config, 'odai-route-hook.mjs')], { encoding: 'utf8', input: JSON.stringify({ session_id: 'local', cwd: dir, hook_event_name: event, ...extra }) });
 hook('UserPromptSubmit', { prompt: '先让 Claude 规划' });
 const invoke = { tool_name: 'exec_command', tool_input: { cmd: `node "${config}/odai-run-role.mjs" --role planner --input task.md` } };
 assert.equal(hook('PreToolUse', invoke).status, 0);
 assert.equal(hook('PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'echo odai-run-role.mjs --role planner' } }).status, 2);
 const evidence = path.join(dir, 'evidence.json');
 writeFileSync(evidence, JSON.stringify({ role: 'planner', observed: { started_at: new Date(Date.now()+1).toISOString(), model_verified: true, model_verification: 'verified', exit_code: 0 } }));
 hook('PostToolUse', { ...invoke, tool_response: { output: `odai evidence: ${evidence}\n` } });
 assert.equal(hook('PreToolUse', { tool_name: 'apply_patch' }).status, 0);
});
