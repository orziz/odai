import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const scripts = path.resolve('skills/odai-orchestration/scripts');
function fixture(host = 'claude', flags = ['--lead-mode']) {
 const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'odai-lead-'));
 const result = spawnSync(process.execPath, [path.join(scripts, 'install-routing.mjs'), '--host', host, '--scope', 'project', '--target', dir, '--controller-model', 'haiku', '--planner-model', 'haiku', '--reviewer-model', 'haiku', ...flags, '--yes'], { encoding: 'utf8' });
 assert.equal(result.status, 0, result.stderr);
 const config = path.join(dir, '.' + host);
 const hook = (event, extra = {}) => { const r = spawnSync(process.execPath, [path.join(config, 'odai-route-hook.mjs')], { encoding: 'utf8', input: JSON.stringify({ session_id: 'one', cwd: dir, hook_event_name: event, ...extra }) }); assert.ok([0,2].includes(r.status), r.stderr); return r; };
 const stateRoot = host === 'claude' ? path.join(config, 'named-dispatch') : path.join(dir, '.odai/named-dispatch');
 const state = () => JSON.parse(readFileSync(path.join(stateRoot, readdirSync(stateRoot).find(f => f.endsWith('.json')))));
 const call = (role, text = '好') => hook('PostToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'odai-' + role }, tool_response: { status: 'completed', agentId: 'a666', agentType: 'general-purpose', content: [{ type: 'text', text }], resolvedModel: 'claude-haiku-5-5', totalDurationMs: 1, totalTokens: 10, usage: {} } });
 const write = () => hook('PostToolUse', { tool_name: 'Write', tool_response: { success: true } });
 return { dir, config, hook, state, call, write };
}
test('lead is opt in, switch grammar, readonly, persistence, planner and pass', () => {
 const { hook, state, call, write } = fixture();
 for (const prompt of ['开启主导模式吗', '“开启主导模式”', '你来主导', '配置主导模式', '写一下开启主导模式的测试']) { hook('UserPromptSubmit', { prompt }); assert.equal(state().lead, undefined); }
 hook('UserPromptSubmit', { prompt: '开启主导模式' });
 assert.equal(hook('PreToolUse', { tool_name: 'Read' }).status, 0); assert.equal(hook('Stop').stdout, ''); assert.equal(state().requests.length, 0);
 hook('UserPromptSubmit', { prompt: '创建文件' }); assert.equal(state().lead.enabled, true);
 assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 2);
 call('planner'); assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 0);
 hook('PostToolUse', { tool_name: 'Write', tool_response: { is_error: true } }); assert.equal(hook('Stop').stdout, '');
 write(); assert.equal(hook('Stop', { stop_hook_active: true }).stdout, ''); assert.match(hook('Stop').stdout, /VERDICT/); assert.equal(hook('Stop').stdout, '');
 call('reviewer', '**VERDICT： pass。**'); assert.equal(state().requests.at(-1).verdict, 'pass'); assert.equal(hook('Stop').stdout, '');
 hook('UserPromptSubmit', { prompt: '关闭主导模式' }); assert.equal(state().lead.enabled, false); assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 0);
});
test('real async launch and notification keep planner pending; review uses recorded output', () => {
 const { dir, hook, state, write } = fixture(); hook('UserPromptSubmit', { prompt: '开启主导模式' }); hook('PreToolUse', { tool_name: 'Write' });
 const launch = (role, outputFile) => hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'toolu_' + role, tool_input: { subagent_type: 'odai-' + role, run_in_background: true }, tool_response: { isAsync: true, status: 'async_launched', agentId: 'ae03' + role, resolvedModel: 'claude-haiku-5-5', outputFile, canReadOutputFile: true, canContinueAgent: true } });
 const notify = role => hook('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>ae03${role}</task-id>\n<tool-use-id>toolu_${role}</tool-use-id>\n<output-file>ignored</output-file>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>` });
 launch('planner'); assert.equal(hook('PreToolUse', { tool_name: 'Bash' }).status, 2); assert.equal(hook('Stop').stdout, '');
 notify('planner'); assert.equal(state().requests[0].result, 'satisfied'); write(); assert.match(hook('Stop').stdout, /block/);
 const output = path.join(dir, 'review.txt'); writeFileSync(output, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'VERDICT: pass' }] } })); launch('reviewer', output); assert.equal(hook('Stop').stdout, ''); notify('reviewer'); assert.equal(state().requests.at(-1).verdict, 'pass'); assert.equal(hook('Stop').stdout, '');
});
test('changes requested repairs once after each review, two additional rounds maximum', () => {
 const { hook, state, call, write } = fixture(); hook('UserPromptSubmit', { prompt: '开启主导模式' }); hook('PreToolUse', { tool_name: 'Write' }); call('planner'); write();
 for (let round = 0; round < 3; round++) {
  assert.match(hook('Stop').stdout, /VERDICT/); call('reviewer', 'fix issue\nVERDICT: changes-requested');
  assert.equal(state().requests.at(-1).round, round);
  if (round < 2) { assert.equal(hook('Stop', { stop_hook_active: true }).stdout, ''); assert.match(hook('Stop').stdout, /按意见修正/); assert.equal(hook('Stop').stdout, ''); write(); }
 }
 assert.equal(hook('Stop').stdout, ''); write(); assert.equal(hook('Stop').stdout, ''); assert.equal(state().requests.filter(r => r.leadReview).length, 3);
});
for (const text of ['missing', 'VERDICT: pass\nVERDICT: changes-requested']) test('invalid verdict stops without retry: ' + text, () => {
 const { hook, state, call, write } = fixture(); hook('UserPromptSubmit', { prompt: '开启主导模式' }); hook('PreToolUse', { tool_name: 'Write' }); call('planner'); write(); hook('Stop'); assert.match(call('reviewer', text).stdout, /不再追加轮次/); assert.equal(state().requests.at(-1).verdict, 'invalid'); write(); assert.equal(hook('Stop', { stop_hook_active: true }).stdout, ''); assert.ok(hook('Stop').stdout); assert.equal(hook('Stop').stdout, ''); assert.equal(state().requests.filter(r => r.leadReview).length, 1);
});
test('named merging and early review; failure releases planner', () => {
 const { hook, state, call, write } = fixture('claude', ['--lead-mode', '--named-dispatch']);
 hook('UserPromptSubmit', { prompt: '开启主导模式，先让 Claude 规划，做完让 Claude 验收' }); hook('PreToolUse', { tool_name: 'Write' }); call('planner'); write(); call('reviewer', 'VERDICT: pass'); assert.equal(hook('Stop').stdout, ''); assert.equal(state().requests.length, 2);
 hook('UserPromptSubmit', { prompt: '下一个任务' }); hook('PreToolUse', { tool_name: 'Write' }); hook('PostToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'odai-planner' }, tool_response: { error: 'quota' } }); assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 0);
});
test('Codex wait handback and missing slots use same hook state', () => {
 const { config, hook, state, write } = fixture('codex');
 const file = path.join(config, 'odai-named-dispatch.json'); const manifest = JSON.parse(readFileSync(file)); delete manifest.mapping.planner; writeFileSync(file, JSON.stringify(manifest));
 hook('UserPromptSubmit', { prompt: '开启主导模式' }); assert.deepEqual(state().lead.roles, ['reviewer']); assert.equal(hook('PreToolUse', { tool_name: 'apply_patch' }).status, 0); write(); hook('Stop');
 hook('PostToolUse', { tool_name: 'spawn_agent', tool_input: { agent_type: 'odai_reviewer' }, tool_response: { agent_id: 'child' } }); assert.equal(hook('Stop').stdout, '');
 hook('PostToolUse', { tool_name: 'wait', tool_response: { status: { child: { completed: 'VERDICT: pass' } } } }); assert.equal(state().requests.at(-1).verdict, 'pass');
 delete manifest.mapping.reviewer; writeFileSync(file, JSON.stringify(manifest)); hook('UserPromptSubmit', { prompt: '开启主导模式' }); assert.equal(state().lead.enabled, false);
});

test('executor review reads verified output file or standard output', () => {
 for (const useFile of [false, true]) {
  const { dir, config, hook, state, write } = fixture('codex');
  const manifestFile = path.join(config, 'odai-named-dispatch.json'); const manifest = JSON.parse(readFileSync(manifestFile)); manifest.mapping.reviewer = { backend: 'local-cli', cli: 'claude', model: 'haiku' }; delete manifest.mapping.planner; writeFileSync(manifestFile, JSON.stringify(manifest));
  hook('UserPromptSubmit', { prompt: '开启主导模式' }); write(); hook('Stop');
  const output = path.join(dir, 'review.txt'); writeFileSync(output, 'VERDICT: pass');
  const evidence = path.join(dir, 'evidence.json'); writeFileSync(evidence, JSON.stringify({ role: 'reviewer', output: useFile ? output : null, observed: { started_at: new Date(Date.now()+1).toISOString(), model_verified: true, model_verification: 'verified', exit_code: 0 } }));
  hook('PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: `node "${config}/odai-run-role.mjs" --role reviewer --input task.md` }, tool_response: { output: `VERDICT: pass\nodai evidence: ${evidence}\n` } });
  assert.equal(state().requests.at(-1).verdict, 'pass'); assert.equal(hook('Stop').stdout, '');
 }
});
for (const host of ['claude', 'codex']) test(host + ' combined hooks update, drift and uninstall preserve guardrails and state', () => {
 const { dir, config, hook, state } = fixture(host, ['--named-dispatch', '--lead-mode']);
 hook('UserPromptSubmit', { prompt: '开启主导模式' });
 const args = [path.join(scripts, 'install-routing.mjs'), '--host', host, '--scope', 'project', '--target', dir, '--controller-model', 'haiku', '--planner-model', 'haiku', '--reviewer-model', 'haiku', '--yes'];
 let result = spawnSync(process.execPath, [...args, '--lead-mode'], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
 if (host === 'claude') assert.equal(JSON.parse(readFileSync(path.join(config, 'settings.local.json'))).hooks.Stop.length, 1);
 const file = path.join(config, 'odai-route-hook.mjs'); const original = readFileSync(file); writeFileSync(file, 'drift'); result = spawnSync(process.execPath, [...args, '--lead-mode'], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /漂移/); writeFileSync(file, original);
 result = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(readdirSync(config).includes('odai-route-hook.mjs'), false); assert.equal(state().lead.enabled, true);
});

test('disabled mode, mismatched name, host notifications and child hooks have no lead effect', () => {
 const { hook, state } = fixture();
 hook('UserPromptSubmit', { prompt: '先让 Claude 规划' }); assert.equal(state().requests.length, 0); assert.equal(hook('PreToolUse', { tool_name: 'Write' }).status, 0);
 hook('UserPromptSubmit', { prompt: '这个会话由 Gemini 主导' }); assert.equal(state().lead.enabled, false);
 hook('UserPromptSubmit', { prompt: '<system-reminder>开启主导模式</system-reminder>' }); assert.equal(state().lead.enabled, false);
 hook('UserPromptSubmit', { agent_id: 'child', prompt: '开启主导模式' }); assert.equal(state().lead.enabled, false);
});
test('review failure and model mismatch do not retry or block', () => {
 for (const response of [{ status: 'failed' }, { status: 'completed', resolvedModel: 'unrelated-model', content: [{ type: 'text', text: 'VERDICT: changes-requested' }] }]) {
  const { hook, state, call, write } = fixture(); hook('UserPromptSubmit', { prompt: '开启主导模式' }); hook('PreToolUse', { tool_name: 'Write' }); call('planner'); write(); hook('Stop');
  hook('PostToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'odai-reviewer' }, tool_response: response }); assert.equal(state().requests.at(-1).verdict, 'failed'); assert.equal(hook('Stop').stdout, ''); write(); assert.equal(hook('Stop').stdout, '');
 }
});

test('each lead task explains flow before early review; notifications inject no flow', () => {
 const { hook, call, write, state } = fixture();
 for (const prompt of ['开启主导模式', '创建第二个文件', '继续']) {
  const output = hook('UserPromptSubmit', { prompt }).stdout;
  assert.match(output, /VERDICT: pass/);
 }
 for (const prompt of ['<task-notification></task-notification>', '<system-reminder>提醒</system-reminder>', '<subagent_notification>完成</subagent_notification>']) assert.equal(hook('UserPromptSubmit', { prompt }).stdout, '');
 assert.match(hook('PreToolUse', { tool_name: 'Write' }).stderr, /VERDICT: changes-requested/);
 call('planner'); write(); call('reviewer', '缺少结论');
 assert.equal(state().requests.at(-1).verdict, 'invalid');
 assert.ok(hook('Stop').stdout); assert.equal(hook('Stop').stdout, '');
});
for (const role of ['planner', 'reviewer']) test('review verdict guidance follows configured reviewer slot: ' + role, () => {
 const { config, hook } = fixture();
 const file = path.join(config, 'odai-named-dispatch.json'); const manifest = JSON.parse(readFileSync(file)); delete manifest.mapping[role === 'planner' ? 'reviewer' : 'planner']; writeFileSync(file, JSON.stringify(manifest));
 const output = hook('UserPromptSubmit', { prompt: '开启主导模式' }).stdout;
 const flow = output.split('主导模式流程：')[1];
 assert.ok(flow); assert.equal(flow.includes('第一次改动前'), role === 'planner'); assert.equal(flow.includes('VERDICT'), role === 'reviewer');
});
