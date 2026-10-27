










// Deliberately bounded grammar: an imperative delegation, never a bare role word.
export function recognizeNamedRequests(text        , routes                                             )                 {
  const clean = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu, " ").replace(/^\s*>.*$/gmu, " ");
  const dynamicNames = Object.values(routes).flatMap(route => route ? [
    route.backend === "local-cli" ? route.cli : route.provider,
    /^[a-z]+/iu.exec(route.model)?.[0],
  ].filter((name)                 => !!name && /^[a-z][a-z0-9_-]*$/iu.test(name)) : []);
  const escape = (name        )         => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const aliases = "Claude|克劳德|opus|sonnet|Gemini|反重力|agy|antigravity|GPT|Codex|Grok|planner|reviewer|researcher|creative|writer|frontend|规划职责|审查职责|研究职责|创意职责|写作职责|前端职责";
  const names = [...new Set([...aliases.split("|"), ...dynamicNames])].sort((a, b) => b.length - a.length).map(escape).join("|");
  const directive = new RegExp(`(?:让|交给|请|叫|找|用|have\\s+|let\\s+|ask\\s+|use\\s+)\\s*(${names})(?![a-z0-9_-])|交给\\s*(规划|调查|审查|创意|写作|前端)(?!职责)`, "iu");
  const bare = new RegExp(`^\\s*(${names})(?![a-z0-9_-])\\s*(?:来|去)?\\s*(?:写|起草|改写|润色|翻译|定方向|审|规划|plan|write|review)`, "iu");
  const result                 = [];
  let creativeContext = false;
  let delegated = false;
  for (const clause of clean.split(/[，,；;。\n]|\bthen\b/iu)) {
    if (/(?:以后|今后|from now on).*?(?:都|always)|^\s*(?:configure|配置|设置|映射)\b|(?:规划|审查|写作|前端|创意|调查)\s*用本机|推理档/iu.test(clause)) continue;
    const match = directive.exec(clause) ?? (delegated ? bare.exec(clause) : null);
    if (!match || /(?:了吗|过了|不错|怎么样|是否|要不要|能不能|吗|？|\?|last time|already)/iu.test(clause)) continue;
    const prefix = clause.slice(0, match.index).trim();
    // A bounded topic is allowed; an enclosing action ("写一下让…的测试") is not.
    if (!/^(?:(?:先|再|然后|最后|做完|写完|改完|完成后|之后|交付前|麻烦|请你|你|不用|不要|别|无需|不必)\s*)*(?:文案|台词|对白|宣传语|商店页|规划|代码|界面)?\s*$/u.test(prefix)) continue;
    delegated = true;
    const name = match[1] ?? match[2] ;
    const creativeObject = /文案|台词|对白|画面|美术|视觉|宣传|商店页|稿|copy|dialogue|prose/iu.test(clause);
    let candidates                   = [];
    if (/规划|计划|出方案|定方案|拆任务|\bplan\b/iu.test(clause)) candidates = ["planner"];
    else if (/调查|调研|查资料|核实来源|\bresearch\b/iu.test(clause)) candidates = ["researcher"];
    else if (/定方向|构思|起名|出点子/iu.test(clause)) { candidates = ["creative"]; creativeContext = true; }
    else if (/界面|前端实现|做\s*UI|frontend/iu.test(clause)) candidates = ["frontend"];
    else if (/(?:写(?!完|进|到|入|在)|起草|改写|润色|翻译|本地化|\bwrite\b)/iu.test(clause) && creativeObject) candidates = routes.writer ? ["writer", "creative"] : ["creative"];
    else if (/审|验收|复核|检查|把关|评估|看看|\breview\b/iu.test(clause)) candidates = creativeObject || (creativeContext && !/验收|复核|检查/iu.test(clause)) ? ["creative"] : ["reviewer"];
    if (!candidates.length && match[2]) candidates = [{ 规划: "planner", 调查: "researcher", 审查: "reviewer", 创意: "creative", 写作: "writer", 前端: "frontend" }[name]                  ];
    if (!candidates.length) continue;
    const explicitRole                                 = { planner: "planner", reviewer: "reviewer", researcher: "researcher", creative: "creative", writer: "writer", frontend: "frontend", 规划职责: "planner", 审查职责: "reviewer", 研究职责: "researcher", 创意职责: "creative", 写作职责: "writer", 前端职责: "frontend", 规划: "planner", 调查: "researcher", 审查: "reviewer", 创意: "creative", 写作: "writer", 前端: "frontend" };
    const role = explicitRole[name.toLowerCase()];
    const matches = (route                        )          => {
      if (!route) return false;
      const value = `${route.backend === "local-cli" ? route.cli : route.provider} ${route.model}`;
      if (/^(Claude|克劳德|opus|sonnet)$/iu.test(name)) return /claude|anthropic|opus|sonnet/iu.test(value);
      if (/^(Gemini|反重力|agy|antigravity)$/iu.test(name)) return /antigravity|gemini/iu.test(value);
      if (/^(GPT|Codex)$/iu.test(name)) return /openai|codex|gpt/iu.test(value);
      if (/^Grok$/iu.test(name)) return route.backend === "local-cli" && route.cli === "grok";
      return [route.backend === "local-cli" ? route.cli : route.provider, /^[a-z]+/iu.exec(route.model)?.[0]].some(value => value?.toLowerCase() === name.toLowerCase());
    };
    const responsibility = role ?? candidates.find(candidate => matches(routes[candidate])) ?? candidates[0] ;
    const timing = /先(?:让|请|用|交给|叫|找|规划|审|验收|调研|调查|写|做|定)|\bfirst\b/iu.test(clause) ? "start" : /做完|写完|改完|完成后|之后|最后|交付前|\bafter\b|once done|when done|finally|before delivering/iu.test(clause) ? "completion" : responsibility === "reviewer" ? "completion" : "start";
    const delegationPrefix = clause.slice(0, match.index + match[0].indexOf(name));
    const canceled = /(?:不用|不要|别|无需|不必)\s*(?:再)?\s*(?:让|交给|请|叫|找|用)?\s*$|(?:do not|don't)\s+(?:let|have|ask|use)\s*$/iu.test(delegationPrefix);
    const issue = !routes[responsibility] ? "unconfigured" : !role && !matches(routes[responsibility]) ? "mapping-mismatch" : undefined;
    if (!result.some(item => item.responsibility === responsibility && item.timing === timing && item.canceled === canceled)) result.push({ responsibility, timing, excerpt: clause.trim(), name, ...(canceled ? { canceled: true } : {}), ...(issue ? { issue } : {}) });
  }
  return result;
}


export function recognizeLeadSwitch(text        , routes        )                                                                    {
  const clean = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/gu, " ").replace(/^\s*>.*$/gmu, " ");
  let result;
  for (const raw of clean.split(/[，,；;。\n]/u)) {
    const clause = raw.trim();
    if (/吗|？|\?|是否|能不能|配置|设置|以后|默认|开关|测试/iu.test(clause)) continue;
    if (/^(?:关闭主导模式|退出主导模式|恢复正常模式|disable lead mode)[！!]?$/iu.test(clause)) result = { enabled: false, roles: [] };
    else {
      const direct = /^(?:(?:这个|当前)会话\s*)?(?:开启|打开|启用|开)主导模式[！!]?$/u.test(clause) || /^enable lead mode[！!]?$/iu.test(clause);
      const named = /^(?:这个|当前)会话由\s*(\S+)\s*主导[！!]?$/u.exec(clause);
      if (!direct && !named) continue;
      let roles = Object.keys(routes).filter(role => routes[role                ]);
      if (named) roles = roles.filter(role => !recognizeNamedRequests(`让 ${named[1]} ${role === "planner" ? "规划" : "验收"}`, routes).every(request => request.issue || request.responsibility !== role));
      result = { enabled: roles.length > 0, roles, ...(roles.length ? {} : { issue: named ? "mapping-mismatch" : "缺少 planner、reviewer 插槽；请用 odai_routing_config 配置" }) };
    }
  }
  return result;
}

export function parseLeadVerdict(text) {
  const normalize = (line) => line.trim().replace(/^[*_`"'“”‘’「」『』]+|[*_`"'“”‘’「」『』。.]+$/gu, "").trim();
  const lines = text.split(/\r?\n/u).filter(line => line.trim());
  const verdicts = [...text.matchAll(/\bVERDICT\s*[:：]\s*[*_`"'“‘「『]*(pass|changes-requested)\b/giu)].map(match => match[1].toLowerCase());
  if (new Set(verdicts).size > 1) return "invalid";
  return /^VERDICT\s*[:：]\s*(pass|changes-requested)$/iu.exec(normalize(lines.at(-1) ?? ""))?.[1]?.toLowerCase() ?? "invalid";
}
