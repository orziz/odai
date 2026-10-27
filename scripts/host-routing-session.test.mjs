import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const scripts = path.resolve('skills/odai-orchestration/scripts');
const run = (file, args, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
for (const host of ['codex', 'claude']) test(`${host}: CLI installation, continuation identity, isolation, fallback and serial execution`, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'odai-host-session-')));
  try {
    const cli = host === 'codex' ? 'claude' : 'antigravity';
    const base = ['--host', host, '--scope', 'project', '--target', root, '--yes'];
    const mapping = ['--controller-model', 'test-controller', '--planner-model', 'test-planner', '--reviewer-model', 'haiku', '--reviewer-cli', cli, '--reviewer-session', 'continue'];
    const installer = path.join(scripts, 'install-routing.mjs');
    let result = await run(installer, [...base, ...mapping]);
    assert.equal(result.code, 0, result.stderr);
    const config = path.join(root, `.${host}`), runner = path.join(config, 'odai-run-role.mjs');
    assert.ok(existsSync(path.join(config, 'odai-local-cli.mjs')));
    assert.equal(existsSync(path.join(config, `agents/odai-reviewer.${host === 'codex' ? 'toml' : 'md'}`)), false);
    const fake = path.join(root, 'fake.mjs'), log = path.join(root, 'calls.jsonl'), busy = path.join(root, 'busy');
    writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
const args = process.argv.slice(2);
const resumed = args.includes('--resume') || args.includes('--conversation');
if (existsSync(process.env.BUSY)) process.exit(9);
writeFileSync(process.env.BUSY, 'busy');
appendFileSync(process.env.LOG, JSON.stringify(args)+'\\n');
await new Promise(resolve => setTimeout(resolve, 80));
unlinkSync(process.env.BUSY);
if (resumed && process.env.FAIL_RESUME) process.exit(7);
if (args.includes('--conversation') || !args.includes('--tools')) {
 console.log(JSON.stringify({event:'init', init:{model:'haiku'}, conversation_id:args.includes('--conversation') ? args[args.indexOf('--conversation')+1] : crypto.randomUUID()}));
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'verified body'}}));
} else console.log(JSON.stringify({type:'result', subtype:'success',is_error:false,result:'verified body',modelUsage:{'claude-haiku-5-5':{outputTokens:8}},session_id:args[args.indexOf(resumed?'--resume':'--session-id')+1]}));
`);
    chmodSync(fake, 0o700);
    const input = path.join(root, 'task.md'); writeFileSync(input, 'bounded task');
    const env = { ODAI_CLAUDE_COMMAND: fake, ODAI_AGY_COMMAND: fake, LOG: log, BUSY: busy };
    const keyEnv = host === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID';
    const command = ['--role', 'reviewer', '--input', input, '--cwd', root];
    const call = (key, extra = [], additions = {}) => run(runner, [...command, ...extra], { ...env, ...(key ? { [keyEnv]: key } : {}), ...additions });
    result = await call(); assert.notEqual(result.code, 0); assert.match(result.stderr, /--session-key/);
    result = await call('one', [], { [host === 'codex' ? 'CLAUDE_CODE_SESSION_ID' : 'CODEX_THREAD_ID']: 'inherited-other-host' }); assert.equal(result.code, 0, result.stderr);
     assert.equal(JSON.parse(readFileSync(result.stderr.match(/odai evidence: (.+)/)[1], 'utf8')).observed.session.mode, 'created');
    result = await call('one'); assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(result.stderr.match(/odai evidence: (.+)/)[1], 'utf8')).observed.session.mode, 'resumed');
     const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const resume = cli === 'claude' ? '--resume' : '--conversation';
    assert.ok(calls()[1].includes(resume));
    result = await call('two'); assert.equal(result.code, 0, result.stderr); assert.ok(!calls().at(-1).includes(resume));
    result = await call(null, ['--session-key', 'explicit']); assert.equal(result.code, 0, result.stderr);
    result = await call(null, ['--session-key', 'explicit']); assert.equal(result.code, 0, result.stderr); assert.ok(calls().at(-1).includes(resume));
    result = await call('one', [], { FAIL_RESUME: '1' }); assert.equal(result.code, 0, result.stderr); assert.match(result.stderr, /续接失败，已新开/);
    const evidence = JSON.parse(readFileSync(result.stderr.match(/odai evidence: (.+)/)[1], 'utf8'));
    assert.equal(evidence.observed.session.mode, 'resume-failed-created');
    const parallel = await Promise.all([call('one'), call('one')]);
    for (const outcome of parallel) assert.equal(outcome.code, 0, outcome.stderr);
    const manifestFile = path.join(config, 'odai-routing.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    delete manifest.mapping.reviewer.session;
    writeFileSync(manifestFile, JSON.stringify(manifest));
    result = await call(); assert.equal(result.code, 0, result.stderr);
    assert.ok(!calls().at(-1).includes(resume));
    if (cli === 'claude') assert.ok(calls().at(-1).includes('--no-session-persistence'));
    const stateBase = host === 'codex' ? path.join(root, '.odai') : config;
     if (host === 'codex') assert.equal(existsSync(path.join(config, 'role-evidence')), false);
     assert.equal(JSON.parse(readFileSync(result.stderr.match(/odai evidence: (.+)/)[1], 'utf8')).observed.session, undefined);
     const state = path.join(stateBase, 'role-sessions'); assert.equal(readdirSync(state).filter(x => x.endsWith('.lock')).length, 0);
    result = await run(installer, [...base, '--uninstall']); assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(state)); assert.ok(existsSync(path.join(stateBase, 'role-evidence')));
  } finally { // root is the exact isolated temporary project created by this test.
    rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported continuation is rejected and native Claude instructions are opt-in', async () => {
 const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'odai-host-config-')));
 try {
  const build = path.join(scripts, 'build-routing.mjs');
  const base = host => ['--host', host, '--out', root, '--controller-model', 'controller', '--planner-model', 'planner', '--reviewer-model', 'reviewer'];
  for (const extra of [[], ['--reviewer-cli', 'grok']]) {
   const result = await run(build, [...base('codex'), ...extra, '--reviewer-session', 'continue']);
   assert.notEqual(result.code, 0); assert.match(result.stderr, /不支持/);
  }
  let result = await run(build, base('claude')); assert.equal(result.code, 0, result.stderr);
  const file = path.join(root, 'claude/.claude/agents/odai-controller.md');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /用 SendMessage/);
  result = await run(build, [...base('claude'), '--reviewer-session', 'continue']); assert.equal(result.code, 0, result.stderr);
  assert.match(readFileSync(file, 'utf8'), /reviewer 开启会话续接时，用 SendMessage 继续上次派出的同一个 odai-reviewer 子代理.*agentId.*已完成.*不新派。/);
 } finally { rmSync(root, {recursive: true, force: true}); }
});
