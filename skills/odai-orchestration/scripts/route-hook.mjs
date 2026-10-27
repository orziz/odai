#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeNamedRequests, recognizeLeadSwitch, parseLeadVerdict } from './recognize-routing.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'odai-named-dispatch.json'), 'utf8'));
const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;
for (const field of ['tool_input', 'tool_response']) {
  if (typeof input[field] === 'string') { try { input[field] = JSON.parse(input[field]); } catch { /* shell output may be plain text */ } }
}
// Subagent hooks must never consume the controller's pending requests.
if (!input.session_id || input.agent_id) process.exit(0);
const stateRoot = manifest.host === 'codex' ? path.join(input.cwd || process.cwd(), '.odai', 'named-dispatch') : path.join(root, 'named-dispatch');
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
const file = path.join(stateRoot, createHash('sha256').update(input.session_id).digest('hex') + '.json');
// Serialize host callbacks; fail visibly instead of racing the pending queue.
const lock = file + '.lock';
const deadline = Date.now() + 5000;
while (true) {
  try { mkdirSync(lock); break; }
  catch (error) {
    if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
let state;
try {
  state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { requests: [], started: Date.now() };
  if (event === 'UserPromptSubmit') {
    const text = String(input.prompt || '');
    const notification = hostNotification(text);
    if (notification) completeNotification(text);
    const requests = notification || manifest.namedDispatch === false ? [] : recognizeNamedRequests(text, manifest.mapping);
    if (!notification && !/^\s*(继续|接着|continue|go on)[。.!！\s]*$/iu.test(text) && !requests.some(r => r.canceled)) state = { requests: [], started: Date.now(), ...(state.lead ? { lead: state.lead } : {}) };
    if (!notification && manifest.leadMode) {
      const change = recognizeLeadSwitch(text, Object.fromEntries(['planner', 'reviewer'].map(role => [role, manifest.mapping[role]])));
      if (change) {
        state.lead = change;
        context(`主导模式${change.enabled ? '已开启' : '未开启或已关闭'}；规划与审查：${change.roles.map(role => `${role}=${manifest.mapping[role]?.model}`).join('，') || '无'}。${change.issue || ''} 缺少或未匹配的插槽不调用；配置请更新宿主路由映射。说“关闭主导模式”退出。`);
      }
    }
    for (const request of requests) {
      if (request.canceled) state.requests = state.requests.filter(r => r.responsibility !== request.responsibility || r.done);
      else state.requests.push({ ...request });
    }
    if (!notification && leadEnabled()) context(leadFlow());
    if (state.requests.length) context(state.requests.map(describe).join('\n'));
  } else if (event === 'PreToolUse') {
    if (leadEnabled() && !readOnly(input.tool_name) && !state.requests.some(r => !r.issue && invocation(r))) ensureLead('planner');
    const pending = state.requests.find(r => !r.done && !r.issue && r.timing === 'start');
    if (pending && !invocation(pending) && !(pending.agentId && input.tool_name === 'wait' && input.tool_input?.ids?.includes(pending.agentId)) && !readOnly(input.tool_name)) {
      console.error(describe(pending)); process.exitCode = 2;
    }
  } else if (event === 'PostToolUse') {
    if (leadEnabled()) {
      for (const role of state.lead.roles) {
        if (manifest.mapping[role] && invocation({ responsibility: role }) && (role === 'planner' || state.writes)) {
          const last = state.requests.findLast(r => r.leadReview);
          ensureLead(role, role === 'reviewer' && last?.verdict === 'changes-requested' && last.repairNudged && last.round < 2 && state.writes > last.reviewWrites ? last.round + 1 : 0);
        }
      }
    }
    for (const r of state.requests.filter(r => r.agentId && !r.done)) {
      const response = input.tool_response;
      const status = response?.status?.[r.agentId];
      if (input.tool_name === 'wait' && status && typeof status.completed === 'string') { r.done = true; r.result = 'satisfied'; r.handback = status.completed; }
    }
    const roleCall = state.requests.some(r => !r.issue && (invocation(r) || (input.tool_name === 'wait' && r.agentId && input.tool_response?.status?.[r.agentId])));
    const request = state.requests.find(r => !r.done && !r.issue && invocation(r));
    if (request) {
      const response = input.tool_response;
      const failed = (leadEnabled() && ['failed', 'killed', 'cancelled', 'canceled'].includes(response?.status)) || response?.is_error || response?.error || (Number.isInteger(response?.exit_code) && response.exit_code !== 0);
      if (failed) { request.done = true; request.result = 'failed'; context('点名调用失败，不重试、不替换模型；最终答复说明原因。'); }
      else if (manifest.mapping[request.responsibility].backend === 'local-cli') {
        // Accept only the evidence explicitly returned by this executor invocation.
        const match = /odai evidence: ([^\r\n]+)/u.exec(typeof response === 'string' ? response : JSON.stringify(response).replaceAll('\\n', '\n'));
        let evidence;
        try { if (match) evidence = JSON.parse(readFileSync(match[1].trim(), 'utf8')); } catch { /* missing evidence is not success */ }
        const observed = evidence?.observed;
        if (evidence?.role === request.responsibility && Date.parse(observed?.started_at) >= state.started && observed?.model_verified && observed?.model_verification === 'verified' && observed?.exit_code === 0 && !observed?.error) {
          request.done = true; request.result = 'satisfied';
          if (request.leadReview) request.handback = evidence.output && existsSync(evidence.output) ? readHandback(evidence.output) : responseText(response).replace(/(?:^|\n)odai evidence:[^\n]*/gu, '').trim();
        } else { request.done = true; request.result = 'unverified'; context('点名职责的执行器证据缺失或未核实；最终答复说明，不重试。'); }
      } else if (input.tool_name === 'spawn_agent') {
        if (response?.agent_id) request.agentId = response.agent_id;
      } else if (response) {
        const text = responseText(response);
        if (typeof response.resolvedModel === 'string') {
          request.resolvedModel = response.resolvedModel;
          context(modelReport(request));
        }
        // Claude may launch asynchronously even when run_in_background was omitted.
        if (response.isAsync === true || response.status === 'async_launched' || /^Async agent launched successfully\./u.test(text) || input.tool_input?.run_in_background || input.tool_input?.background) {
          request.inProgress = true;
          request.toolUseId = input.tool_use_id;
          request.outputFile = response.outputFile;
          request.agentId = response.agentId || /\bagentId:\s*([^\s(]+)/u.exec(text)?.[1];
        } else if (response.status === 'completed') {
          request.done = true; request.result = 'satisfied'; request.handback = text;
        }
      }
    }
    if (leadEnabled() && !roleCall && !readOnly(input.tool_name) && !input.tool_response?.is_error && !input.tool_response?.error && !(Number.isInteger(input.tool_response?.exit_code) && input.tool_response.exit_code !== 0)) state.writes = (state.writes || 0) + 1;
  } else if (event === 'Stop' && !input.stop_hook_active) {
    updateReviews();
    const invalid = state.requests.find(r => r.leadReview && r.verdict === 'invalid' && !r.invalidNudged);
    if (invalid) {
      invalid.invalidNudged = true;
      console.log(JSON.stringify({ decision: 'block', reason: '审查回交没有可识别的 VERDICT 行，请在最终答复里如实说明审查结论未按格式给出' }));
    }
    const repair = state.requests.find(r => r.leadReview && r.verdict === 'changes-requested' && !r.repairNudged && r.round < 2);
    if (repair) {
      repair.repairNudged = true;
      console.log(JSON.stringify({ decision: 'block', reason: `主导审查要求修正：${repair.handback}。按意见修正；有成功写入后再审查。` }));
    }
    if (leadEnabled() && state.writes && !repair) {
      const last = state.requests.findLast(r => r.leadReview);
      if (!last || (last.verdict === 'changes-requested' && last.repairNudged && last.round < 2 && state.writes > last.reviewWrites)) ensureLead('reviewer', last ? last.round + 1 : 0);
    }
    const waiting = state.requests.some(r => !r.done && !r.issue && (r.timing === 'start' || r.inProgress || r.agentId));
    const pending = waiting || repair ? [] : state.requests.filter(r => !r.done && !r.issue && !r.nudged && r.timing === 'completion');
    if (pending.length) {
      for (const request of pending) request.nudged = true;
      console.log(JSON.stringify({ decision: 'block', reason: pending.map(describe).join('\n') }));
    }
  }
  updateReviews();
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); renameSync(temp, file);
} finally {
  const { rmdirSync } = await import('node:fs'); rmdirSync(lock);
}
function responseText(response) {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) return response.map(responseText).join('\n');
  if (typeof response?.text === 'string') return response.text;
  if (typeof response?.stdout === 'string') return response.stdout;
  if (typeof response?.output === 'string') return response.output;
  if (response?.content) return responseText(response.content);
  return JSON.stringify(response);
}
function hostNotification(text) {
  // Host envelopes are continuation input, never a new direct user task.
  return /^\s*<(task-notification|system-reminder|subagent_notification)(?:\s|>)/u.test(text) || input.origin?.kind === 'task-notification';
}
function completeNotification(text) {
  const body = /^\s*(?:<system-reminder>\s*)?(<task-notification>[\s\S]*?<\/task-notification>)/u.exec(text)?.[1];
  if (!body) return;
  // Read only header fields, never status-like text embedded in an agent result.
  const header = body.split(/<(?:summary|result|usage|note)>/u)[0];
  const field = name => new RegExp(`<${name}>([^<]*)</${name}>`, 'u').exec(header)?.[1].trim();
  const toolUseId = field('tool-use-id');
  const status = field('status');
  const pending = state.requests.filter(r => r.inProgress && !r.done);
  const byTool = toolUseId ? pending.filter(r => r.toolUseId === toolUseId) : [];
  const taskId = field('task-id');
  const matches = byTool.length ? byTool : pending.filter(r => taskId && r.agentId === taskId);
  for (const request of matches) {
    if (status === 'completed') {
      request.done = true; request.result = 'satisfied';
      if (request.leadReview) {
        try { request.handback = readHandback(request.outputFile); } catch { request.handback = ''; }
      }
    }
    else if (['failed', 'killed', 'cancelled', 'canceled'].includes(status)) {
      request.done = true; request.result = 'failed';
      context(`点名 ${request.responsibility} 后台调用${status}；最终答复说明原因，不重试、不替换模型。`);
    }
  }
}
function modelReport(r) {
  const configured = manifest.mapping[r.responsibility]?.model;
  const expected = String(configured || '').toLowerCase();
  const actual = r.resolvedModel.toLowerCase();
  const mismatch = expected && !actual.includes(expected) && !expected.includes(actual);
  return `点名 ${r.responsibility} 的宿主 resolvedModel：${r.resolvedModel}。最终答复按此说明实际模型，不采用子代理自报。${mismatch ? `与配置模型 ${configured} 明显不符，请如实说明；不拦截、不重试。` : ''}`;
}
function describe(r) {
  const route = manifest.mapping[r.responsibility];
  if (r.issue) return `点名 ${r.responsibility} 未执行：${r.issue}；当前映射 ${JSON.stringify(route || null)}。如实说明，不替换模型或修改配置。`;
  const command = route.backend === 'local-cli' ? `node ${JSON.stringify(path.join(root, 'odai-run-role.mjs'))} --role ${r.responsibility} --input <任务包文件>` : `${manifest.host === 'codex' ? 'odai_' : 'odai-'}${r.responsibility}`;
  return `${r.source === 'lead-mode' ? '主导模式' : '用户点名'} ${r.responsibility}（${r.timing === 'start' ? '动手前' : '完成时'}）：${r.excerpt}。调用 ${command}，回交后继续；最终答复说明哪个模型做了什么或未完成原因。${(leadEnabled() && r.responsibility === 'planner' && state.lead.roles.includes('reviewer')) || r.leadReview || (leadEnabled() && state.lead.roles.includes('reviewer') && r.responsibility === 'reviewer' && r.timing === 'completion') ? '审查任务包必须要求：回交最后单独一行写 VERDICT: pass 或 VERDICT: changes-requested。' : ''}${r.resolvedModel ? modelReport(r) : ''}`;
}
function invocation(r) {
  const args = input.tool_input || {};
  const route = manifest.mapping[r.responsibility];
  if (route.backend === 'local-cli') {
    const command = args.command || args.cmd;
    // Require an actual standalone executor command, not an echo or quoted mention.
    return typeof command === 'string' && /^\s*node\s+/u.test(command) && new RegExp(`(?:[/'\"]|^)odai-run-role\\.mjs['\"]?\\s+--role\\s+${r.responsibility}(?:\\s|$)`, 'u').test(command) && !/[;&|`\n]|\$\(/u.test(command);
  }
  return /^(Agent|Task|spawn_agent)$/u.test(input.tool_name) && [args.subagent_type, args.agent_type].includes(`${manifest.host === 'codex' ? 'odai_' : 'odai-'}${r.responsibility}`);
}
function readOnly(name) { return /^(Read|Glob|Grep|read_file|list_dir|glob|grep|web_search|view_image)$/u.test(name || ''); }
function context(text) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })); }

function leadFlow() {
  const roles = state.lead.roles;
  return '主导模式流程：' + (roles.includes('planner') ? '第一次改动前先派规划插槽。' : '') + (roles.includes('reviewer') ? '有改动时做完派审查插槽；派审查时要求回交最后单独一行写 VERDICT: pass 或 VERDICT: changes-requested。' : '') + '最终答复按宿主记录说明实际模型。';
}
function leadEnabled() { return manifest.leadMode && state.lead?.enabled; }
function ensureLead(role, round = 0) {
  if (!state.lead.roles.includes(role) || !manifest.mapping[role]) return;
  const timing = role === 'planner' ? 'start' : 'completion';
  let request = state.requests.find(r => r.responsibility === role && r.timing === timing && !r.issue && (role === 'planner' || (r.round || 0) === round));
  if (!request) {
    request = { responsibility: role, timing, source: 'lead-mode', excerpt: role === 'planner' ? '第一次写入前规划' : '验收本任务写入' };
    state.requests.push(request);
  }
  if (role === 'reviewer') {
    request.leadReview = true; request.round = round; request.reviewWrites ??= state.writes || 0;
  }
  return request;
}
function updateReviews() {
  if (!leadEnabled()) return;
  for (const r of state.requests.filter(r => r.leadReview && r.done && !r.verdict)) {
    r.verdict = r.result === 'satisfied' && !modelMismatch(r) ? parseLeadVerdict(r.handback || '') : 'failed';
    if (r.verdict === 'invalid' || r.verdict === 'failed' || (r.verdict === 'changes-requested' && r.round >= 2)) context(`主导审查 ${r.verdict}；不再追加轮次，最终答复如实说明未解决的问题。`);
  }
}

function modelMismatch(r) {
  const expected = String(manifest.mapping[r.responsibility]?.model || '').toLowerCase();
  const actual = String(r.resolvedModel || '').toLowerCase();
  return expected && actual && !actual.includes(expected) && !expected.includes(actual);
}
function readHandback(file) {
  const text = readFileSync(file, 'utf8');
  // Claude background output may be a transcript rather than plain text.
  const messages = [];
  for (const line of text.split(/\r?\n/u)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && entry.message?.content) messages.push(responseText(entry.message.content));
    } catch { /* plain text handback */ }
  }
  return messages.length ? messages.join('\n') : text;
}
