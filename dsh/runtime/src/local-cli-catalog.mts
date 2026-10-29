import { execFile, spawn } from 'node:child_process';

export interface CliModelChoice { id: string; name: string }

export function parseCliModels(cli: string, output: string): CliModelChoice[] {
  const choices: CliModelChoice[] = [];
  for (const line of output.split('\n')) {
    const match = cli === 'antigravity' ? /^([\w.:-]+)\t(.+)$/.exec(line)
      : cli === 'grok' ? /^\s+[*-]\s+([\w.:-]+)(?:\s+\(default\))?\s*$/.exec(line) : null;
    if (match) choices.push({ id: match[1]!, name: match[2] ?? match[1]! });
  }
  if (cli === 'claude') {
    const section = output.match(/--model <model>([\s\S]*?)(?=\n\s+--|\n\s+-[a-z],)/)?.[1] ?? '';
    for (const match of section.matchAll(/'([\w.-]+)'/g)) choices.push({ id: match[1]!, name: `${match[1]}（CLI 别名）` });
  }
  return [...new Map(choices.map(choice => [choice.id, choice])).values()];
}

export async function discoverCliModels(cli: string, signal?: AbortSignal): Promise<CliModelChoice[]> {
  if (cli === 'codex') return codexModels(signal);
  const command = { claude: 'claude', antigravity: 'agy', grok: 'grok' }[cli];
  if (!command) throw new TypeError('不支持的 CLI');
  return new Promise((resolve, reject) => {
    execFile(command, cli === 'claude' ? ['--help'] : ['models'], { timeout: 15000, maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
      if (error) { reject(new Error('CLI 模型查询失败，请检查安装、登录状态或手动输入')); return; }
      const choices = parseCliModels(cli, stdout);
      if (!choices.length) reject(new Error('CLI 未返回可识别的模型目录，请手动输入'));
      else resolve(choices);
    });
  });
}

function codexModels(signal?: AbortSignal): Promise<CliModelChoice[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', settled = false, bytes = 0;
    const choices: CliModelChoice[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); child.kill();
      error ? reject(error) : resolve(choices);
    };
    const abort = () => finish(new Error('模型查询已取消'));
    const timer = setTimeout(() => finish(new Error('Codex 模型查询超时，请手动输入')), 15000);
    signal?.addEventListener('abort', abort, { once: true });
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(new Error('无法启动 Codex 模型查询')));
    child.on('exit', () => finish(new Error('Codex 模型查询提前结束')));
    child.stdin.on('error', () => finish(new Error('Codex 模型查询连接中断')));
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { finish(new Error('Codex 模型目录过大')); return; }
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) { finish(new Error('Codex 拒绝模型目录查询')); return; }
          if (message.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method: 'model/list', params: {} });
          } else if (message.id === 2) {
            for (const model of message.result.data) if (!model.hidden && typeof model.model === 'string') choices.push({ id: model.model, name: model.displayName ?? model.model });
            if (message.result.nextCursor) send({ id: 2, method: 'model/list', params: { cursor: message.result.nextCursor } });
            else finish(choices.length ? undefined : new Error('Codex 未返回模型目录'));
          }
        } catch { finish(new Error('无法解析 Codex 模型目录')); }
      }
    });
    if (signal?.aborted) abort();
    else send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'odai-model-catalog', version: '0.3.1' } } });
  });
}
