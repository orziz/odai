# odai 多模型 Agent 编排 CLI 方案报告

状态:Phase 0 / MVP CLI 骨架已落地,默认入口已对齐常驻交互式 CLI;mock runtime、command-json subprocess provider、Codex CLI provider smoke、实时 provider meter、TTY slash-command 面板、项目 `list/search` 发现工具、credential 文件门、runtime canary、规则-代码耦合 registry、npm package 元数据与 JS API 入口、`odai setup` 首次配置/证据缺口引导、`odai status` 聚合状态、`odai audit` 完成判定审计、`odai evidence` 保存证据审计、验收矩阵 audit、sandbox preflight、强沙箱 smoke、E2E readiness audit 与 smoke 已通过。当前已保存真实 API provider、Codex subscription CLI 和 strong sandbox smoke 证据;Claude runtime provider 已降级为可选扩展,不再作为 completion blocker。
日期:2026-07-08。外部事实(Claude Agent SDK、订阅认证、沙箱能力、Copilot/其他订阅入口)在实施前必须按当期官方文档复核。

## 1. 背景与目标

odai 目前是纯提示词治理层(`skills/odai`),寄生在 Codex / Claude Code 等宿主里调用。行为体检的结论是:硬保证(拒绝规则、锁死快车道)相对稳定,软判断(证据门、停止条件、子 agent 边界)会塌。只要 odai 停留在提示词层,这些门就仍然是"劝",不是程序性强制。

用户目标不是做一个 Claude Code 换壳,也不只是做模型切换器,而是做类似 Copilot / Agent HQ 方向的统一入口:

- 可接不同模型来源:订阅型 CLI/SDK、API key、本地模型、网关。
- 主 agent 可按任务拉起不同模型的 subagent 做审查、挑战、候选实现、长上下文阅读或低成本批处理。
- 所有模型和 subagent 的工具动作都必须经过 odai 的统一硬门、证据账本、权限裁决和验收收口。

目标:把 odai 做成一个 **model-agnostic agent orchestrator CLI**。核心收益不是多一个外壳,而是把最易漂移的软判断从"模型行为"下沉为"runtime 保证",同时保留 `skills/odai` 作为治理语义唯一来源。

最终用户形态应接近 Claude Code / Codex CLI:运行 `odai` 进入一个常驻交互式 session,用户持续输入任务或追问,odai 在 session 内完成读文件、调 subagent、申请授权、执行工具、写 transcript 和接力恢复。`odai "<任务>"` 是主路径的快捷入口:先把这条任务作为 session 首条输入执行,随后停在 `odai>` 等待继续追问、授权、重试或切换 provider。`odai run "<任务>"`、`odai providers`、`odai doctor`、`odai setup` 等一次性命令只服务脚本、CI、canary、排障和首次配置,不得成为普通用户的主要工作流。

产品入口约束:

- 主入口:`odai` / `odai "<任务>"`,必须进入 odai 自己的常驻 CLI,并在同一 session 内保存 transcript、provider session hint、证据账本和授权状态。
- 一次性入口:`odai run "<任务>"`,只用于自动化和测试,输出机器可读结果,不代表默认体验。
- 诊断入口:`setup` / `status` / `doctor` / `audit` / `evidence`,只回答"现在为什么能/不能跑",不能替代 agent 工作流。
- 若 provider、凭证或强沙箱缺失,主入口仍应进入 CLI 并给出可执行的缺口说明;不得退化成只打印 JSON 报告后退出。

## 2. 方案选型

| 档位 | 形态 | 成本 | 结论 |
|---|---|---:|---|
| 0 | 现状:skill,寄生任意宿主 | 已有 | 保留,继续作为发行形态 |
| 1 | Claude Agent SDK 薄壳 CLI | 数天 | 可做 provider spike,不作为底座 |
| **2** | **odai 自有 runtime + 多 provider 编排** | 数周起 | **选定方向** |
| 3 | 完整 IDE/TUI/Web agent 平台 | 数月+ | 后置,不得压进 MVP |

选定理由:

1. Claude Agent SDK 适合快速拿到 Claude Code 的工具循环、权限、hooks、沙箱和 skills/plugin 能力,但它天然绑定 Claude Code 语义。若作为总 runtime,后续接 OpenAI、Gemini、Codex CLI、Ollama、OpenRouter 或 Copilot 类入口时会被迫模拟 Claude SDK。
2. odai 真正要稳定的是治理内核:工具前硬门、证据账本、停止条件、授权边界、subagent 采纳门、验收真实性。这些必须属于 odai 自己的 runtime,不能挂在某个 provider 内部。
3. provider 可以各用所长:Claude Agent SDK 可以作为高能力 provider;OpenAI/Gemini/Anthropic API key provider 可以走统一 tool loop;Codex CLI/其他订阅型 CLI 可以走 subprocess adapter;本地模型可以走无工具或受限工具模式。

技术栈:Node/TS 优先。仓库已有 `scripts/odai-canary-harness.mjs`,同栈便于复用 canary 和 fixture 工具。

## 3. 核心原则

### 3.1 odai 拥有最终工具权

任何 provider / model / subagent 都不能直接拥有最终文件写入、shell 执行、网络访问、发布、认证或收口权。模型只能提出 tool intent、patch proposal、审查结论或候选路线;最终动作统一进入 `odai-runtime`。

```text
model/subagent -> intent/proposal -> odai gates -> odai tools -> evidence ledger -> result
```

### 3.2 主流程与 subagent 分权

| 角色 | 拥有什么 | 不拥有什么 |
|---|---|---|
| main agent | 用户通道、目标/边界/验收裁决、最终收口、subagent 调度 | 不绕过 runtime 工具门 |
| subagent | 冻结输入内的阅读、分析、候选实现、审查、挑战 | 用户通道、最终裁决、直接落盘、宣布完成 |
| provider | 推理能力、模型特性、可选原生工具能力 | odai 治理权、验收权、越权工具权 |
| odai-runtime | 工具执行、沙箱、权限、证据账本、状态、审计 | 业务语义唯一来源 |

### 3.3 硬门位置上移

证据门、授权门、停止门、感知型验收止损、subagent 工具边界不得依赖某个 SDK 的 `canUseTool`。统一在 odai 自己的 tool dispatcher 前执行。Claude Agent SDK 的 `PreToolUse` / permissions / sandbox 只能作为 Claude provider 内部的第二层防线。

### 3.4 语义唯一来源

- `skills/odai/` 仍是治理语义和领域 playbook 的 canonical source。
- CLI / runtime 代码不得复制长规则文本;只能实现机械门和状态机。
- 若某条 skill 语义需要 runtime 同步实现,必须登记为"规则-代码耦合点",并有 canary 覆盖。
- provider 专属 prompt / plugin / system append 都必须从 `skills/odai/` 渲染或指针式加载,不得维护第二份规则。

## 4. 总体架构

```text
odai-cli
├── bin/odai
│   └── 参数解析、登录/凭证提示、provider 选择、会话入口
├── packages/
│   ├── odai-core
│   │   ├── skill loader / prompt pack renderer
│   │   ├── route contract / governance state
│   │   └── canary semantics
│   ├── odai-runtime
│   │   ├── tool dispatcher(list/read/search/write/shell/network)
│   │   ├── gates: evidence / authorization / stop / perception / subagent
│   │   ├── evidence ledger
│   │   ├── sandbox adapter
│   │   ├── session state / transcript
│   │   └── patch applier / command runner
│   ├── odai-orchestrator
│   │   ├── provider registry
│   │   ├── agent profile registry
│   │   ├── scheduler
│   │   ├── result merger
│   │   └── challenge / review / consensus workflow
│   └── providers
│       ├── claude-agent-sdk
│       ├── anthropic-api
│       ├── openai-api
│       ├── gemini-api
│       ├── codex-cli
│       ├── openrouter
│       └── ollama-local
└── skills/odai
    └── 仍为规则源,不复制
```

## 5. Provider 模型

### 5.1 Provider 分类

| 类型 | 例子 | 接入方式 | 风险 |
|---|---|---|---|
| API key provider | OpenAI, Anthropic API, Gemini, OpenRouter | HTTP API + odai 自有 tool loop | 成本、限流、tool use 差异 |
| 订阅型 SDK/CLI provider | Claude Agent SDK, Codex CLI(如可用) | subprocess / SDK adapter | 语义被厂商 runtime 影响 |
| 本地 provider | Ollama, llama.cpp | HTTP/local process | 能力不足、上下文和工具规划弱 |
| Copilot 类 provider | GitHub Copilot / Agent HQ | 仅在官方稳定外部入口存在时接入 | 不能假设可复用用户订阅或内部模型通道 |

原则:provider registry 只记录真实可用能力,不得凭训练记忆或市场印象声称"更便宜/更强/支持订阅"。涉及成本档时,必须有用户配置、provider 自报、官方文档或运行时回报作证。

### 5.2 Provider 能力标签

```yaml
providers:
  claude:
    type: claude-agent-sdk
    auth: subscription_or_api_key
    capabilities: [tool_loop, code_agent, long_context, sandbox_bridge]

  openai:
    type: openai-api
    auth: api_key
    capabilities: [reasoning, structured_output, code, tool_calling]

  gemini:
    type: gemini-api
    auth: api_key
    capabilities: [long_context, multimodal, tool_calling]

  local:
    type: ollama
    auth: none
    capabilities: [offline, low_cost]
```

能力标签只决定候选调度,不等于可靠性结论。每次 subagent 产出仍须由主流程复核。

## 6. Subagent 编排模型

### 6.1 Agent profile

agent profile 描述"要做什么"和"允许什么",不直接绑定模型。

```yaml
agents:
  reviewer:
    purpose: code_review
    tools: read_only
    allowed_outputs: [findings, risks, questions]
    provider_requirements: [code, long_context]

  challenger:
    purpose: independent_challenge
    tools: none
    allowed_outputs: [counterexamples, missing_cases, alternative_paths]
    provider_requirements: [reasoning]

  implementer_candidate:
    purpose: candidate_patch
    tools: virtual_patch_only
    allowed_outputs: [unified_diff, rationale, test_plan]
    provider_requirements: [code, tool_calling]

  bulk_reader:
    purpose: large_context_summary
    tools: read_only
    allowed_outputs: [evidence_summary, file_map]
    provider_requirements: [long_context]
```

### 6.2 工具权限

| 工具档 | 允许动作 | 典型用途 |
|---|---|---|
| none | 不读本地文件,只处理输入包 | 独立挑战、方案反证 |
| read_only | 通过 odai 受控读取材料 | 审查、归纳、长上下文扫读 |
| virtual_patch_only | 返回 patch proposal,不落盘 | 候选实现 |
| delegated_runtime | 稀有:冻结任务下放,仍经 odai 沙箱与 gates | 大批量机械任务 |

默认不开放 `delegated_runtime`。除非范围、行为、验收、非目标、停止条件已冻结,且主流程能复核结果,否则 subagent 不能执行真实写入。

### 6.3 Scheduler

scheduler 根据任务类型、风险、成本、上下文长度、provider 可用性选择 `agent profile + provider + model`。

调度规则:

1. 能由主流程低成本完成的,不派 subagent。
2. 高代价冻结、正式审查、真多路方案或用户显式要求合议时,优先派 challenger / reviewer。
3. 批量阅读或候选实现可派 subagent,但采纳必须由主流程复核。
4. 成本档不明且会影响选择时 fail fast:列可用 provider、未知项、退化路径,让用户选。
5. subagent 不得再派生 subagent。

## 7. Runtime 硬门

### 7.1 统一工具门

所有真实工具调用统一走:

```text
ToolIntent
  -> classify(list/read/search/write/shell/network/destructive/perception/subagent)
  -> evidence gate
  -> authorization gate
  -> stop gate
  -> sandbox/policy gate
  -> execute
  -> record evidence
```

### 7.2 第一批硬门

| 硬门 | 程序判定 | 拒绝后输出 |
|---|---|---|
| evidence gate | 写入目标未被读取/定位/纳入证据账本 | 拒绝理由 + 最小补证动作 |
| authorization gate | 生产/发布/外部系统/不可逆/费用/认证/破坏性动作未授权 | 需要的授权项和停止条件 |
| stop gate | 同一目标/验收连续失败超过阈值 | 止损说明 + 要求换方向/上游稳定验收 |
| perception gate | 感知型验收未稳却试图直接调参数/样式/文案 | 转设计/规格对齐 |
| subagent boundary gate | subagent 试图直接写入、问用户、宣布完成或扩范围 | 拒绝并回交主流程 |

### 7.3 Provider 内部门

Claude Agent SDK provider 可额外使用 `PreToolUse`、permission rules、sandbox 等能力;但这些只是 provider 内部防线。odai 的通用硬门必须在 provider 外层存在,确保其他 provider 也受同样规则约束。

## 8. 凭证、订阅与成本

### 8.1 支持目标

- API key:优先支持,因为接口清晰、跨 provider 可控。
- 订阅型 CLI/SDK:按 provider 能力接入,例如 Claude Agent SDK / `claude -p` / Codex CLI 等。
- Copilot 订阅:仅在 GitHub 官方提供稳定、合规的外部 agent/CLI/API 入口时接入;不得假设可以复用 Copilot 内部模型通道。

### 8.2 安全默认值

- 检测到 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等环境变量时,启动报告当前会使用的 provider 和计费路径。
- 对"用户以为走订阅、实际走 API key"的场景 fail closed:要求显式 `--use-api-key` 或配置确认。
- 不把 secret 注入模型上下文、日志、subagent 输入包或 canary transcript。

### 8.3 成本账本

每个 provider adapter 应尽量记录:

- provider / model / auth source
- token / request / elapsed time
- provider 自报费用或订阅额度事件(如可得)
- subagent 产出是否被采纳

无成本证据时只能标 `cost: unknown`,不得根据模型名自行断言便宜。

## 9. 沙箱与工具层

沙箱不绑定 Claude Agent SDK。odai-runtime 需要自己的 sandbox adapter:

| 层级 | MVP 选择 | 后续升级 |
|---|---|---|
| 文件写入 | 默认只允许工作目录 + 会话 tmp | per-task allow/deny policy |
| shell | 先用受控 command runner + cwd + env scrub | OS sandbox / devcontainer / VM |
| 网络 | 默认关闭或按 provider/tool 白名单 | TLS-aware proxy / enterprise proxy |
| patch | 默认由 odai apply patch | checkpoint / rewind |

Claude Agent SDK provider 可复用其 sandbox,但不能作为唯一沙箱。若某 provider 无沙箱能力,必须走 odai 自有受控工具层,或降级为 `none/read_only/virtual_patch_only`。

## 10. 实施范围

### Phase 0: 可行性 spike(先做)

1. Provider registry spike:至少接通 `claude-agent-sdk` 和一个 API key provider(优先 OpenAI 或 Anthropic API 二选一)。
2. Unified tool dispatcher spike:模拟 List/Search/Read/Write/Edit/Bash/Network intent,证明所有 provider 都会先经过 odai gates。
3. Subagent scheduler spike:main agent 拉起一个不同 provider 的 `reviewer` 或 `challenger`,产出结构化结果,主流程复核后收口。
4. Skill loader spike:从 `skills/odai/` 渲染 prompt pack;验证不复制规则文本,改源文件后新会话生效。
5. Canary spike:新增/跑通最小用例,证明 subagent 不能直接写文件、不能宣布完成、不能绕过主流程。

Phase 0 通过条件:能演示"两个 provider + 一个 subagent + 一个统一硬门 + 一条 canary"闭环。

### Phase 1: MVP CLI

1. `odai "<任务>"` 单命令入口。
2. provider 配置文件与环境变量检测。
3. 主流程单 agent + 可选一个 subagent。
4. 第一批硬门:evidence / authorization / stop / subagent boundary。
5. 证据账本与 transcript 落盘。
6. CLI 作为 canary harness runner 跑冒烟集。

### Phase 2: 编排增强

1. 多 subagent 并行审查 / 挑战。
2. `virtual_patch_only` 候选实现与主流程 patch 采纳。
3. 成本/能力路由。
4. session resume / continue。
5. devcontainer / stronger sandbox adapter。

### 非目标(当前不做)

- 完整 TUI/Web UI。
- 直接发布到 public registry。未作用域包名 `odai` 被 npm 判定与已有包过近,因此发布包名改为 `odai-cli`,但命令名仍保留 `odai`。
- Copilot 非官方入口逆向。
- 让 subagent 直接持有用户通道或最终写权限。
- 试图复刻 Claude Code / Codex CLI 全部能力。

## 11. 验收标准

| # | 场景 | 必须 | 不得 |
|---|---|---|---|
| 1 | 启动时存在多个凭证 | 显示 provider/auth source/可能计费路径,危险歧义 fail closed | 静默选 API key 或订阅 |
| 2 | 订阅型 CLI/SDK runtime provider 与 API key provider 都可用 | provider registry 能列出能力、成本未知项和可用状态 | 凭记忆断言成本/能力 |
| 3 | 任一 provider 请求 Write/Edit | 先经过 odai evidence gate | provider 直接落盘 |
| 4 | subagent 返回 patch | 只作为候选,由主流程复核后落盘 | subagent 直接写文件或宣布完成 |
| 5 | subagent 试图问用户/扩范围 | boundary gate 拦截并回交主流程 | 子 agent 自行继续猜 |
| 6 | 同一失败动作超过阈值 | stop gate 要求换方向或上游稳定验收 | 无限重试 |
| 7 | 改 `skills/odai` 文本 | 新会话 prompt pack 使用新文本;无第二份规则文本 | CLI 代码内藏复制条文 |
| 8 | canary 冒烟以 odai CLI 为 runner | 全部跑完并产出 transcript/provider/evidence 记录 | 结果无法与现有 harness 对比 |
| 9 | 交互式切主模型且同轮多 subagent 异构编排 | `/model` 可切换当前 session 主模型名并在后续任务注入 `--model`;`/model provider:model` 可同时指定主 provider 和模型;`auto` 路由会先应用模型覆盖再判断 provider 可用性;多 subagent evidence 记录不同 provider/model 集合与 `heterogeneousProviders` | 持久化高风险确认,或把不同 subagent provider/model 折叠成不可复核的一路输出 |

## 12. 风险与开放问题

1. **Provider 抽象过早复杂化**:Phase 0 只接两个 provider,不要先做完整插件系统。
2. **Claude Agent SDK 能力诱惑**:可用其 hooks/sandbox/plugin,但不能让 Claude provider 反向塑造 odai runtime。
3. **订阅入口不稳定**:Claude/Codex/Copilot 等订阅能力以官方当期入口为准;无入口就不支持,不逆向。
4. **硬门误伤率**:evidence gate 的"读过/定位过"先宽后紧,必须有拒绝理由和补证路径。
5. **subagent 输出质量不稳定**:必须要求结构化回交:已读材料、已跑动作、观察事实、推断、建议、未验证缺口。
6. **沙箱强度不足**:MVP 可先受控工具层,但对 shell/network/secret 的边界必须保守;高风险环境后置 devcontainer / VM。
7. **技能语义与代码耦合**:任何下沉成代码的规则都要登记耦合点并纳入 canary。

## 13. 参考

- Claude Agent SDK:https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK TypeScript:https://code.claude.com/docs/en/agent-sdk/typescript
- Claude SDK permissions:https://code.claude.com/docs/en/agent-sdk/permissions
- Claude SDK hooks:https://code.claude.com/docs/en/agent-sdk/hooks
- Claude SDK plugins/skills:https://code.claude.com/docs/en/agent-sdk/plugins
- Claude 认证:https://code.claude.com/docs/en/authentication
- Claude 沙箱:https://code.claude.com/docs/en/sandboxing
- Claude 沙箱环境:https://code.claude.com/docs/en/sandbox-environments
- Claude Agent SDK 订阅说明:https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Claude CLI reference:https://code.claude.com/docs/en/cli-reference
- Anthropic Messages streaming:https://platform.claude.com/docs/en/build-with-claude/streaming
- OpenAI streaming responses:https://platform.openai.com/docs/guides/streaming-responses
- Ollama API:https://github.com/ollama/ollama/blob/main/docs/api.md

## 14. 当前实现进度

已落 `cli/` Phase 0 骨架:

- `odai phase0`:演示 skill loader、provider registry、统一 tool dispatcher、evidence gate、subagent boundary gate、patch proposal。
- `odai providers`:探测 mock provider、OpenAI / Anthropic / Gemini API key provider、Ollama local provider、Claude / Codex / Grok CLI provider、Claude Agent SDK provider 的可用性;不泄露凭证值;每个真实 provider 输出脱敏后的白名单 `source` 元数据(env 变量名、命令名、包名、baseUrl、配置状态、显式确认 flag),用于解释 auth/source/可能计费路径;API provider 缺 key 时给 `api_key_missing`,检测到 API key 时默认 fail closed,必须显式 `--use-api-key` 且配置模型后才标为可用;订阅型外部 CLI / SDK 默认只显示安装状态,必须显式 `--use-provider-command` 才会执行;Claude / Codex / Grok CLI 可分别用 `ODAI_CLAUDE_COMMAND` / `ODAI_CODEX_COMMAND` / `ODAI_GROK_COMMAND` 指向不在 PATH 的本机可执行文件;Ollama 需配置 `ODAI_OLLAMA_MODEL` 或 `.odai/providers.json` 的 `type: "ollama"` 才标为可用;Claude Agent SDK 未安装包时标为 `sdk_package_not_installed`,已安装但未显式确认时标为 `provider_command_requires_explicit_use`。
- `odai auth`:管理本机 provider credential 引用,职责不同于交互式 `/auth` 的“本 session 显式允许使用”。`odai auth status` 显示 `.odai/providers.json` 中 openai-compatible provider 的 managed env 名、secret 是否存在、是否有 direct secret 遗留;同时显示订阅型 CLI provider(`claude-cli` / `codex-cli` / `grok-cli`)的 command 路径、是否来自 env 配置或自动发现、是否可执行、model env 状态和登录/doctor probe 提示,避免 Claude CLI 自动发现后用户不知道该运行哪个 binary 做 `/login`;`odai auth login claude-cli` 会在交互式 TTY 中把发现到的 Claude CLI 拉起到临时空 cwd,用户在 provider CLI 内输入 `/login` 后退出,再运行 doctor 保存证据;非 TTY 下 fail closed,`--dry-run` 只打印将执行的命令和后续 probe,不会启动外部 CLI;`odai auth migrate` 将误写在 `apiKeyEnv` / `apiKey` 中的直接 key 移入本机 `.odai/secrets.env`,并把 `providers.json` 回填为自动生成的 `ODAI_PROVIDER_<NAME>_API_KEY`;`odai auth provider <name> --api-key-stdin` 从 stdin 写入本机 `.odai/secrets.env` 并自动回填 `apiKeyEnv`;`--api-key-env <ENV>` 仅引用已有环境变量。`providers.json` 是用户可编辑的公开 provider 元数据,不应保存真实 key;`.odai/secrets.env` 是本机 secret store,默认 gitignore,运行 provider/model 探查时会自动合并进 workspace env;订阅 CLI 登录由 provider CLI 自己处理,odai 只提供安全登录交接、发现路径和 probe 指引。
- `odai models`:默认主动探查并只列出 provider 实际返回的可用模型标签(`provider:model`);支持 OpenAI `/v1/models`、OpenAI-compatible `/models` / `/v1/models` fallback、Anthropic `/v1/models`、Gemini model list、Ollama `/api/tags`、Grok CLI `grok models` 等明确 list 接口。支持 `--provider <name>`、`--use-api-key`、`--use-provider-command`、`--model <name>`、`--json`;默认输出面向人读,`--json` 输出完整 discovery/provider catalog,包含 provider 可用性、auth/source/capability、探查失败原因和下一步提示。由 `odai auth` 托管在 `.odai/secrets.env` 的 workspace provider key 可自动用于模型列表探查;普通 shell env API key 和订阅型外部 CLI 仍需显式 `/auth` 或 `--use-*`;没有可靠 list 接口的 provider 不臆测模型名。`.odai/providers.json` 的 `model` / `models` 只作为补全和手动路由提示,不作为“可用模型”证据。
- `odai doctor`:列出 provider/credential/package/command 状态;`odai doctor --provider <name>` 会运行最小 no-tool provider probe,`odai doctor --all` 会探测所有已明确可用 provider 并把不可用 provider 记为 blocked,顶层状态按 probe 汇总为 `ready` / `partial` / `failed`,用于后续真实 API key / SDK / CLI 端到端验收;`--model <name>` 可为本次 probe / readiness audit 提供任务级模型覆盖,让缺默认 model env 的 API / compatible provider 在显式授权后参与证据链;provider 失败会保留脱敏后的 `error.cause.name/code/message`,用于区分 DNS、TLS、socket reset 或上游账号策略;Claude CLI 返回未登录/`/login` 类错误时会输出 `next`,指向当前发现的 Claude binary 和保存 evidence 的 doctor 命令;`--governance` / `--setup` / `--status` / `--audit` / `--evidence` / `--acceptance` / `--milestones` / `--sandbox` / `--e2e` 可把对应只读审计接入同一 `--save` / `continue --run` 通道;`--stream` 会启用 provider 事件收集;高风险凭证和外部命令仍需显式 flag,否则结构化 blocked。
- `odai init`:初始化 `.odai/` 安全配置脚手架,默认创建 `policy.json`、`policy.example.json`、空 `providers.json`、`providers.example.json`、空 `agents.json` 和 `agents.example.json`;不会写入任何 API key,不会自动开启 shell/network,不会覆盖已有文件,除非显式传 `--force`。`providers.example.json` 列出内置 OpenAI / Anthropic / Gemini API provider、Claude Agent SDK / Claude CLI、Codex / Grok CLI 的 env、package/command、`doctor --provider ... --save` 验收命令和 `--model` / 交互式 `/model provider:model` 覆盖路径,避免把模型选择锁死在 env;Claude / Codex / Grok CLI 默认分别找 `claude` / `codex` / `grok`,也可用 `ODAI_CLAUDE_COMMAND` / `ODAI_CODEX_COMMAND` / `ODAI_GROK_COMMAND` 指向本机已登录但不在 PATH 的可执行文件;并保留 openai-compatible / command-json / ollama 自定义 provider 示例,其中 openai-compatible 覆盖第三方中转站 / 兼容网关并支持 `--model` 临时指定模型,command-json 可用 `modelArgs: ["--model", "{model}"]` 把模型覆盖传给第三方 CLI;`policy.example.json` 提供 Docker / devcontainer / macOS sandbox-exec 强沙箱 policy 模板,并写明 `odai sandbox` preflight 与 `odai doctor --sandbox --smoke --allow-shell --save` 保存 smoke 证据命令,用于用户确认环境后复制到 `policy.json` 再跑 sandbox smoke;`agents.example.json` 提供 long-context reviewer、bulk reader、cheap challenger 和 patch candidate 四类安全 subagent profile 模板,但不会让 subagent 获得直接写权限。交互式 session 内也支持 `/init [--force]`,方便首次进入 `odai>` 后直接补项目配置。
- `odai setup`:只读汇总首次使用和外部验收路径,包括 `.odai` 配置 scaffold 是否存在、当前 API provider + subscription runtime readiness、已保存真实 API+runtime provider probe 证据、已保存订阅 CLI provider probe 证据、强沙箱 readiness 和已保存非 `none` sandbox smoke 证据;输出 `commands` 显示 `odai` / `odai "<task>"` / `odai run "<task>"` / `odai resume` 的主入口区别,输出 `cliSetup` 指明开发态本地入口 `./cli/bin/odai.mjs`、package bin 名 `odai`、bin target 和可选 `npm --prefix cli link` 命令,避免首次使用时把未安装到 PATH 的 `odai` 当作已生效命令;输出 `providerSetup` 指明内置 provider 的 env、package/command 和保存 probe 证据的检查命令,并输出 `sandboxSetup` 指明 `.odai/policy.json`、`.odai/policy.example.json`、Docker / devcontainer / macOS sandbox-exec 候选要求、preflight 和保存 smoke 证据命令。setup 还输出有序 `completionPath`:workspace config -> API+subscription runtime prerequisites -> API+runtime provider evidence -> subscription CLI evidence -> strong sandbox prerequisites -> strong sandbox evidence,顶层 `next` 由该路径生成,避免把底层 readiness 诊断平铺成重复长列表;传 `--model <name>` 时,e2e / doctor evidence 命令会保留该模型覆盖,用于没有默认 model env 的 API / compatible provider。交互式 session 内支持 `/setup [--use-api-key] [--use-provider-command]`;`odai doctor --setup --save` 可把 setup guide 接入 `continue --run` 恢复通道,但 API key / provider command 确认不会自动恢复。该命令不会调用真实 provider、不会执行订阅 CLI、不会运行 sandbox smoke,transcript 只保存摘要和脱敏 next/note。
- npm package: `cli/package.json` 已从 phase0 private 包整理为早期可安装包 `odai-cli@0.0.1`,保留 `bin.odai -> ./bin/odai.mjs`,通过 `exports["."] -> ./src/api.mjs` 暴露 Node API,并提供 `createRuntime()`、`runTask()`、`listModels()`、`listProviders()` 等稳定入口供 VS Code 扩展 / CI / 其他宿主复用;`files` 白名单只发布 `bin`、`src`、包内 `skills/odai` fallback snapshot、README 和 LICENSE,避免测试、运行记录或本机 `.odai` 配置进入 npm tarball。`loadSkillPack()` 优先使用 workspace `skills/odai`,缺失时回退到 package 内紧凑 skill snapshot,保证 `npx odai-cli` 在普通项目中也能启动;`odai setup` 的 `cliSetup` 现在同时提示 package name、`npm --prefix cli link`、`npx odai-cli` 和 `npm install -g odai-cli`;真正发布到 registry 前仍需确认版本策略和发布账号。
- interactive input:真实 TTY 下默认使用轻量 slash-command 面板,输入 `/` 或命令前缀时在 prompt 上方显示候选命令、说明和快捷键,支持 Up/Down 选择、Tab 接受、Enter 发送、Ctrl+C 退出;非 TTY、脚本输入和测试仍走 readline fallback。补全数据由 `describeInteractiveCompletions()` 统一提供,CLI readline completer、TTY 面板和 package API 共用同一份命令/参数描述。
- i18n:新增 `cli/src/runtime/i18n.mjs`,当前支持英文和中文 CLI 壳层文案;`ODAI_LANG=zh|en` 可设置启动语言,交互式 session 内 `/language zh|en` 可切换当前会话语言,并同步影响 slash-command 面板、help、启动提示、setup note 和补全说明。该能力只翻译 odai 自己的 UI/帮助文本,不会篡改 provider/model 输出、模型 prompt 或 run evidence;Node API 通过 `odai` 主入口和 `odai/i18n` 暴露 `detectLanguage` / `normalizeLanguage` / `t` 等工具。
- update check:新增 `cli/src/runtime/update-check.mjs`,交互式 TTY 启动时会读取包名/当前版本,用短 timeout 查询 npm registry 的 `/<package>/latest`,如果发现新版本只打印更新提示,不会自动安装,离线/超时/registry 失败静默放行。非 TTY 和脚本 JSON 命令不检查,避免污染 stdout;可用 `ODAI_DISABLE_UPDATE_CHECK=1` 或 `ODAI_NO_UPDATE_CHECK=1` 关闭,`ODAI_UPDATE_REGISTRY_URL` / `ODAI_UPDATE_CHECK_TIMEOUT_MS` 可覆盖 registry 与 timeout;Node API 通过 `odai-cli/update-check` 暴露 semver 比较和检查函数。
- `.gitignore`:忽略本机 `.odai/agents.json`、`.odai/policy.json`、`.odai/providers.json`、`.odai/secrets.env`、`.odai/runs` 和 `.odai/sessions`;`!.odai/*.example.json` 允许安全示例 scaffold 被选择性提交,避免把 provider 命令、策略 allowlist、credential、run record 或 session transcript 当源码产物。
- `.odai/providers.json`:可注册额外 `openai-compatible` provider,用于 OpenAI-compatible API 网关、第三方中转站或本地兼容端点;可注册 `ollama` provider,用于本机 / 自托管 Ollama HTTP 入口;也可注册 `command-json` 外部模型 CLI provider,用于订阅型 / 本地 CLI 入口。API key 和外部命令 provider 都默认 fail closed。配置读取按 fail-closed 处理:JSON 语法错误、`providers` 非数组、未知 type、缺必填字段、非法 name、重复 name 会进入 `configErrors`,坏 entry 被跳过,有效 provider 和内置 provider 仍可列出。provider name 只允许字母、数字、`_`、`-`,避免 token-like 字符串被当成 provider 标识写入公开状态或外部证据。
- workspace provider namespace:内置 provider 名(`openai-api` / `claude-cli` / `mock-main` 等)不可被 `.odai/providers.json` 覆盖;撞名配置会进入 `configErrors` 并被跳过,避免 workspace 配置伪装成内置 API / subscription runtime provider 或污染保存的外部证据。
- `.odai/policy.json`:可配置 shell `allowExecution`、`allowedCommands` 和 `sandbox.mode`;也可配置 network `allowRequests`、`allowedHosts` 和 `timeoutMs`;即使项目策略允许,运行任务仍需显式 `--allow-shell` / `--allow-network` 才可能执行真实 shell / network 工具。配置读取按 fail-closed 处理:坏 JSON、非法 section、非布尔开关、非法 allowlist 或 unsupported sandbox 不会让常驻 CLI 崩溃,对应 section 降级为默认拒绝并进入 `configErrors`;`odai policy`、sandbox/e2e readiness 和 run record 都会保留这些配置错误诊断。
- `odai run "<任务>"`:mock 运行主流程,读取 `skills/odai` prompt pack,可调度 subagent 或通过 `--agent-loop` 进入主 agent tool-intent loop,支持 `--model <name>` 对本次主 provider call 做任务级模型覆盖,可用重复 `--subagent profile[:provider[:model]]` 追加 reviewer/challenger 等多路审查,支持同一次任务显式指定不同 provider/model 的异构多 subagent;`--subagent reviewer:auto` 会排除主 provider,并可用重复 `--exclude-provider <name>` 从 subagent auto 候选池里移除其他 provider,用于多订阅 / 多 CLI 同时可用时显式编排候选。运行产出 evidence ledger 和 run record,subagent batch 证据会记录实际 provider 集合和 `heterogeneousProviders`。
- `odai "<任务>"`:不带子命令时默认启动交互式 session,先自动执行初始任务,再停留在 `odai>` 接收追问 / 授权 / retry;无 TTY 时执行完正常退出;运行中会输出 agent turn / provider text / tool result 进度行,并每秒刷新 provider meter,显示 elapsed、provider 自报 usage 或 `input ~N tok est` / `thinking/activity ~N tok est` / `output ~N tok est` / `total ~N tok est` 估算;可见输出 token 估算会在流式输出到达或明显增长时即时刷新,让 Codex/Claude CLI 这类非流式外部命令在思考中也有可见计量;最终摘要会显示公开 tool action(`list` / `search` / `read` / `write` / `shell` / blocked gate)。终端显示层会把 workspace 内 transcript / run record / tool path 规范化为相对路径,并对 path / command / url / note / reason / error 做 token-like 脱敏;内部 run record 与 transcript 保存层仍保留运行所需的真实路径。常用 CLI 选项同时支持 `--flag value` 与 `--flag=value` 形态,覆盖 provider/file/target/content/prompt/tail/canary/rollback filter 等高频入口;高风险确认 flag 也支持 `--use-api-key=true` / `--use-provider-command=true` / `--allow-shell=true` / `--allow-network=true` 的本次执行形态,但不会写入可恢复 argv。
- provider prompt contract:所有 provider adapter 共享同一轻量 system prompt。交互主流程会明确声明为当前 workspace 的 main odai CLI agent,不是 subagent;只有 scheduler 派出的 profile agent 才声明为 subagent。订阅型外部 CLI / SDK / command-json provider 仍运行在临时空 cwd,这是安全隔离策略,所以 prompt 会明确说明项目文件不能直接从 provider 进程目录读取,必须通过 odai 的 `list` / `read` / `search` tool intent 获取项目上下文,再由 runtime 执行/拒绝并把公开 tool result 回传。subagent 只能请求 `list` / `read` / `search`,不得写文件、跑 shell、联网、问用户或宣布完成。
- `odai resume [--tail n] [任务]`:从最新 session transcript 构造恢复上下文后进入新交互式 session;只恢复上下文摘要和上一任务 argv,不会恢复授权、API key 确认、外部命令确认或 shell 执行确认;如果最新 session 只是空的 resume session,会继承其来源 session 的上一条有效任务,避免恢复链被截断。
- `odai`:无参进入最小交互式 session,支持普通任务输入、Tab 补全、`/providers [--use-api-key]`、`/models [select|--json|--provider <name>]`、`/provider <name|auto>`、`/model <model|provider:model|auto|select>`、`/language <zh|en>`、`/auth [api-key|provider-command|all|clear]`、`/agents`、`/init [--force]`、`/doctor [--provider <name>]`、`/status [--use-api-key] [--use-provider-command]`、`/audit [--use-api-key] [--use-provider-command]`、`/evidence`、`/sessions [--tail n] [--context|--compact]`、`/context`、`/continue [--run] [--use-api-key] [--use-provider-command] [--allow-shell] [--allow-network]`、`/authorize <scope>`、`/retry`、`/run <任务> [--subagent reviewer:auto --subagent challenger:<provider> --exclude-provider <name>]`、`/help`、`/exit`;普通任务默认 `--save --agent-loop --provider auto`,并在设置默认模型后追加 `--model <name>`,以支持接力、自动工具操作和真实 provider 可用时的显式模型选择。`/models select` / `/model select` 用上下键从模型标签列表中选择并设置当前 session 的默认 provider/model;`/provider` 只设置当前 REPL 的默认主 provider,`/model` 只设置默认主模型名或通过 `provider:model` 同时切 provider/model;`/language` 只切换当前 REPL 的 UI 语言,不写 workspace config,不改变模型 prompt 或 provider 输出;`/auth` 只把 API key / 外部 provider command 确认作为当前交互 session 的内存态,后续普通任务、`/run`、`/providers`、`/models`、`/doctor`、`/status`、`/setup`、`/audit` 和 `/continue` 会自动带对应 `--use-*` flag,但这些确认不会写入 resume argv、workspace config 或可恢复 transcript。没有显式 API key / 外部命令授权时,auto 会安全退回 mock provider。
- session transcript:交互式 session 会写入 `.odai/sessions/<session>.jsonl` 和 `.odai/sessions/latest.json`,记录 session start/end、任务提交、provider/tool 进度、provider-meter input/thinking/output/total 计量、授权提示和摘要结果;该目录已加入 `.gitignore`,不作为源码产物提交。写入 transcript 前会统一走公开摘要层:progress provider text / provider usage / provider meter / tool result、task result、session resume、authorization、command-result 都会清洗 run record 路径、transcript 路径、context artifact 路径、workspace 内 tool path、具体授权 scope、raw entries、policy allowlist 明细、配置错误路径和 providerSession token-like 值;`/context`、`/sessions`、`/policy`、`/providers`、`/agents`、`/init` 等交互命令只持久化状态、计数和脱敏 provider/profile 摘要,避免 session artifact 变成下一轮模型上下文的本机路径/权限来源。
- `odai sessions [--tail n] [--context]`:读取最新 session transcript 的尾部事件;带 `--context` 时返回可用于恢复的消毒上下文,该 context 不包含 source/current transcript path 或 run record path;交互式 session 内也可用 `/sessions [--tail n]` 查询。
- `odai sessions --compact [--tail n]`:把最新 session transcript 压成持久化 context artifact,写入 `.odai/sessions/<session>.context.json` 和 `.odai/sessions/latest.context.json`;快照只保留消毒后的 last task、recent tasks、provider、文件、tool result 计数、授权事件计数和 recent 摘要,不把原始用户输入、高风险确认 flag、具体授权 scope、transcript/run artifact 路径当作可恢复状态。交互式 `/context` 会调用同一 compact 路径查看当前 session 上下文。
- interactive task context:交互式 session 内每次任务完成后会形成轻量 `interactive-task-context`,只保留上一任务 argv、摘要结果、上一层摘要和不可恢复确认项;下一次普通任务、`/run` 或 `/retry` 会把该上下文放入 provider/subagent input 的 `conversationContext`,让常驻 CLI 的追问具备运行时接力,但仍不恢复授权、API key、外部命令或 shell 执行确认。
- provider session hints:provider adapter 可返回 `providerSession`,runtime 只保留白名单字段(`responseId` / `messageId` / `sessionId` / `conversationId` / `threadId` / `requestId` / `createdAt` / `turn` 等),字段值会定向脱敏 token-like 片段,并写入 usage、evidence、agent turn、run record、session transcript 和 compact context。下一轮 provider input 会按当前 provider 名选择最近的匹配 session hint,以 `resumeProviderSession` 下传给同一 provider;原始 `conversationContext` 中的 `providerSession(s)` 字段会被剥离,避免跨 provider 泄露 session id。provider input 还会剥离 transcript / run record 路径以及 authorization 摘要等 runtime-only 字段,并把 provider-visible 的 workspace 内 `files` / `target` / `toolIntents[].path` / 上下文字符串 / previous tool result path / subagent read tool result path 规范化为相对路径,避免外部 provider 获得本机 `.odai` artifact 路径、workspace 绝对路径或把不可恢复确认误当作当前权限。session hint 不恢复授权、凭证、外部命令、shell/network 确认,也不声称已恢复 provider 原生会话。
- `odai policy`:输出当前项目策略,默认 shell execution 关闭且 allowlist 为空;坏 JSON 或非法字段会输出默认拒绝策略和 `configErrors`,sandbox/e2e readiness 以及普通 run record 也会携带同一诊断,不会因为配置错误放开 shell/network 或只留下难以解释的 policy denial。
- `odai status`:聚合 runtime governance、acceptance、milestones、E2E readiness 和 `.odai/runs` saved external evidence,输出本地 ready/partial 状态、阻塞项、可运行的下一步命令和剩余外部证据缺口;`runnableCommands` 可列出当前机器上可执行的 provider / sandbox probe,`next` 只保留能解除当前 completion blocker 或 saved evidence requirement 的动作,并按 `odai ...` 命令语义合并 acceptance / milestone / external evidence 的重复动作,避免同一 `e2e`、`doctor --all`、已满足的 subscription CLI probe 或 sandbox smoke 提示重复刷屏。Claude CLI 登录 handoff 仍可用,但不会因为缺 Claude runtime 而阻塞 completion。交互式 `/status` 走同一逻辑并写入消毒后的 transcript 摘要,但不会调用真实 provider 或执行 sandbox。
- `odai audit`:面向“是否可以宣布完成”的只读完成审计,复用 `status`、`acceptance`、`milestones` 和 `external evidence` 报告,输出 `kind: "completion-audit"`、`complete`、runtime governance / plan acceptance / executable milestones / saved API+runtime provider evidence / saved subscription CLI provider evidence / saved strong sandbox evidence 六类 requirement;只有这些 requirement 全部 ready 才返回 `complete: true`。交互式 `/audit` 走同一逻辑,只把状态、kind、summary、blockerCount 和 next 摘要写入 transcript,不持久化 requirement 细节或本机路径。`odai doctor --audit --save` 可把完成审计写入 run record,`odai continue --run` 可重跑该审计,但不会自动恢复 API key 或外部 provider command 确认。
- `odai evidence`:直接审计 `.odai/runs` 中已保存的真实外部证据,列出真实 API provider + subscription CLI/SDK runtime probe 和非 `none` 强沙箱 smoke 是否已经满足验收升级条件;只读本地 run record,不会调用 provider、不会执行 sandbox,不会把 readiness-only、mock provider、blocked probe 或无强沙箱的 smoke 计入证据。交互式 `/evidence` 走同一逻辑,只把状态、kind、summary 和计数写入 transcript,不持久化 workspace/run record 本机路径或 provider source 细节。`odai doctor --evidence --save` 可保存该审计,`odai continue --run` 可重跑保存证据扫描。
- `odai governance`:输出 runtime rule-code coupling registry,登记当前下沉为机械硬门的 odai 语义、来源 skill 文件、实现文件和对应 runtime canary case;当前 18/18 coupling 均有 C01-C18 覆盖。`odai doctor --governance` 走同一报告,可用 `--save` 写入 doctor run record 并通过 `continue --run` 重新生成报告。
- `odai acceptance`:输出 plan 第 11 节验收矩阵的机器可读 audit,逐条列出必须项、不得项、当前证据和剩余缺口;A02 要求真实 API provider + subscription CLI/SDK runtime provider 保存证据,不再要求 Claude runtime。A02 会嵌入 `odai e2e` 的 `externalReadiness` 摘要,并扫描 `.odai/runs` 的已保存 `doctor --all --use-api-key --use-provider-command --save` 证据;只有保存过真实 API provider probe + subscription runtime probe 时才把 A02 升级为 ready,不会把 readiness-only 报告或 mock provider 冒充为真实 provider probe。A09 覆盖交互式 `/model` 注入 `--model`、任务级模型覆盖、`auto + --model` 先参与 provider 可用性判定、doctor/e2e 诊断链路模型覆盖、subagent `profile:provider:model` 和异构多 subagent evidence。`odai doctor --acceptance` 走同一报告,可用 `--save` 写入 doctor run record 并通过 `continue --run` 重新生成报告。
- `odai milestones`:输出 plan 第 10 节 Phase 0/1/2 可执行里程碑 audit,逐条列出要求、当前证据、剩余缺口和关联 `externalReadiness`;P0-1 要求真实 API provider + subscription CLI/SDK runtime provider 保存证据,不再要求 Claude runtime;P2-5 可由保存的强沙箱 smoke 证据升级 ready。报告会扫描 `.odai/runs` 的保存证据:真实 provider probe 可升级 P0-1,成功的 `doctor --sandbox --smoke --allow-shell --save` 且结果包含非 `none` sandbox mode 与 host escape probe 时可升级 P2-5;readiness-only 报告不会升级。`odai doctor --milestones` 走同一报告,可用 `--save` 写入 doctor run record 并通过 `continue --run` 重新生成报告。
- `odai sandbox`:输出 shell sandbox preflight,报告当前 `.odai/policy.json`、配置 sandbox 的规划结果、macOS `sandbox-exec`、Docker 和 devcontainer 候选的 fail-closed 原因;不会执行 Docker 容器或 devcontainer 命令,也不会把 preflight 冒充为强沙箱 E2E。`odai sandbox --smoke --allow-shell` 是显式强沙箱 smoke 入口,只有同时满足任务级 `--allow-shell`、项目 policy `shell.allowExecution`、allowlist 和 configured strong sandbox preflight 时,才经 odai dispatcher 执行 success probe 与 host escape probe 并写 evidence;host escape probe 必须证明宿主侧越界文件未创建,保存证据才可计入 strong sandbox smoke;不会自动恢复 `--allow-shell`。`odai doctor --sandbox` / `odai doctor --sandbox --smoke` 走同一报告,可用 `--save` 写入 doctor run record 并通过 `continue --run` 重新生成报告。
- `odai e2e`:汇总真实 API provider / subscription CLI/SDK runtime / 订阅型 CLI / 强沙箱四类端到端前提;只做 readiness audit,不调用真实模型、不执行 Docker/devcontainer/sandbox 命令,可用 `--use-api-key` / `--use-provider-command` 显式改变可用性判定,可用 `--model <name>` 满足本次 readiness/probe 对 model-required provider 的模型要求。`odai doctor --e2e` 走同一报告,可用 `--save` 写入 doctor run record 并通过 `continue --run` 重新生成报告。
- `odai run "<任务>" --target <path> --content <text> --adopt-patch`:演示 subagent 只给 patch proposal,主流程先读取目标形成证据,再经 dispatcher 采纳写入;采纳结果中的 `evidenceRead` 只保存公开摘要和字节数,不把目标文件旧内容写进 run record。
- `odai run "<任务>" --save`:把 run record 写入 `.odai/runs/`,该目录已加入 `.gitignore`。
- `odai continue`:读取 `.odai/runs/latest.json` 并输出恢复摘要;摘要会按 doctor `kind` 区分 provider probe / governance / acceptance / milestones / sandbox / e2e 恢复对象,列出 `notRestored` 的高风险确认项,并给出安全的 `rerun.flags` / `rerun.command` 提示,但不会把原始 prompt、secret、tool payload 或确认 flag 持久化为可恢复状态。
- `odai continue --run`:优先使用 run record 里的 `resume.argv` 恢复 provider/profile/files/target/agent-loop/subagents 等安全参数;`mode: doctor` 的 run record 会重新执行 provider probe;API key、外部命令 provider、shell 执行等高风险确认不自动恢复,需要用户重新传对应 flag。
- `odai rollback latest|<record.json>`:读取指定 run 的 write checkpoints,默认只预览可恢复项;可用 `--path <file>` 和 `--checkpoint <id>` 过滤目标;`--confirm` 才会把写入前已存在的文件内容写回;新建文件默认 skip,只有额外传 `--delete-new-files` 才会预览 / 删除。
- `odai canary-runner --last-message <path>`:兼容 canary harness 的 stdin/last-message 接口;默认执行 mock odai agent loop 并输出 runStatus/mode/provider/evidence 计数/recordPath。也支持显式 `--provider <name>`、`--file <path>`、`--max-turns <n>`、`--use-api-key`、`--use-provider-command`,用于在有凭证或本地 provider 配置时让 canary 走同一 odai runtime/provider/tool gate 路径。新增 `--runtime-case <id|name>` 接入 `plans/odai-cli-runtime-canary.md`,固定验证 subagent 写入拒绝、默认网络拒绝、新文件 checkpoint、`.env` 读取授权拒绝、`.env` 写入拒绝、敏感 tool intent 脱敏、重复失败 stop gate、感知型写入 perception gate、shell 默认只记录、subagent 用户通道/完成权拒绝、tool intent 批量上限、tool intent payload 上限、生产风险授权拒绝、模型输出摘要脱敏、provider 错误脱敏、providerSession 值脱敏、provider input 授权上下文清洗和任务文本持久化脱敏十八类 runtime gate。
- runtime gates:已覆盖 evidence / policy / authorization / stop / perception / subagent-boundary。模型可返回 `list` / `read` / `search` / `write` / `shell` / `network` tool intent;`list` / `search` / `read` 是项目发现/阅读工具,仍受路径边界、credential/private guard 和 subagent boundary 限制。`network` 只是受控 HTTP 工具,不是搜索引擎;runtime 默认不执行网络工具。main agent 的 network intent 必须同时满足任务显式 `--allow-network`、项目 `network.allowRequests`、`network.allowedHosts` 命中和 `risk:external` 授权,否则会被 gate 拒绝并写入 evidence;subagent 会先被 boundary gate 拒绝。provider 自身的模型 API 调用不属于这个工具通道。
- path boundary:list/read/search/write tool intent 必须同时满足词法路径位于 workspace 或 session tmp 内,且已存在目标或最近已存在父目录的 realpath 仍位于允许根内;相对 tool path 一律按 `ToolDispatcher.workspaceRoot` 解析,不按当前进程 cwd 解析,以保证外部 provider 看到相对路径后仍落回正确 workspace;workspace/session tmp 内指向外部目录或文件的 symlink 会被 policy gate 拒绝并写入 denial,不会落到执行阶段抛未结构化异常。
- credential/private runtime file guard:list/search/read/write tool intent 指向 `.env`、常见 credential/key/token 文件、`.ssh` / `.aws` 等敏感目录、`.odai/sessions`、`.odai/runs/*.json` 或 `.odai/runs/checkpoints/**` 时,main agent 会被自动标为 `risk:credential`;读操作需要显式授权,list/search/write 一律作为 model tool intent 被 policy gate 拒绝,避免枚举私有 runtime/credential 文件或让 checkpoint / run artifact 保存 secret 旧内容;subagent 即使在授权 session 内也不能读取或搜索这类文件。protected path 判定中的相对路径同样按 workspaceRoot 解析,不按进程 cwd 解析。provider input 中若 `target/content` 或 `toolIntents[].content` 指向 protected path,content 会在进入 provider 前替换为占位符,避免先把 secret payload 交给模型再由 dispatcher 拒绝。`.env.example` / `.env.sample` / `.env.template` / `.env.dist` 仍按普通样例文件处理。
- interactive session state:交互模式复用同一个 `SessionState` / `EvidenceLedger` / session tmp,授权、证据和失败计数可跨当前 REPL 多条指令保留;支持 `/rollback [latest] [--confirm]`;任务遇到 `requiredAuthorizations` 时会在交互层暂停询问,用户确认后写入 scope 并自动 retry 当前任务。
- evidence ledger:已记录 reads / located targets / writes / checkpoints / commands / subagents / denials,并附带轻量 events transcript 随 run record 落盘;agent loop 每轮另有 `agent-turn` event,记录模型输出摘要、tool intents 和公开 tool results。允许根内 read 遇到 ENOENT 时不会让运行崩溃,而是返回结构化 `file_not_found` tool result 并记录 `location` evidence;后续写同一路径仍需通过 evidence / policy / checkpoint gates。
- evidence sanitization:subagent evidence 只保存公开摘要,包括 provider/model、findings、observations、tool intent 结果、providerSession、patch proposal 的 summary / editCount / editPaths 和 `outputPolicy` 摘要;`outputPolicy` 会按 profile.allowedOutputs 标出 allowed / runtime / unexpected output keys,且 output key 名称也会脱敏,用于证明 subagent 额外字段只是未采纳输出而非权限扩张。不保存 provider `raw` 响应或 patch edit content,避免真实 provider 输出和候选实现内容被原样写入 evidence。命令 argv、任务文本、network URL、network 执行错误、denial reason / intent、providerSession 值、agent turn tool intent / result、agent/provider 普通文本摘要、doctor probe 文本、provider/subagent `unverified`、provider/scheduler error message、provider/agent/policy config error 的 file/field/message/purpose 和交互式 provider-text transcript 会统一脱敏常见 token、authorization、cookie、password、secret、session 等字段。provider 返回的 `usage` / `usageMetadata` 被视为外部输入,持久化前只保留数值和数值嵌套结构,丢弃字符串字段。
- prompt source audit:每次加载 `skills/odai` 时计算 `SKILL.md` 的 `entrySha256`,run record 的 `skill` 元数据写入 `entrySha256` 和 `supportFileCount`;用于证明新会话 prompt pack 来自当前 skill 源文件,而不是 CLI 代码里的第二份长规则文本。
- failure recording:provider / scheduler 失败会写入 `status: failed`、脱敏后的 `error` 和 evidence `error` event,CLI 输出结构化 JSON run record,不直接丢失上下文。
- result notes:run record 的 `note` 会按 usage ledger 中的 provider kind 区分 mock 与真实 / 外部 provider;显式 provider 跑通 agent loop 时不会误报 `no real model was called`,避免验收真实性被 mock 文案污染。
- authorization loop:本次 run 新增的 authorization denial 会汇总为 `requiredAuthorizations`;交互摘要显示 `/authorize risk:*` 最小解除命令,授权后可 `/retry` 重跑上一条任务。
- provider usage:OpenAI / Anthropic / Gemini / OpenAI-compatible provider 会透传 provider 自报 `usage` / `usageMetadata`;runtime 另有统一 `usage` ledger,记录 provider/model/auth/agent/profile/mode/elapsed/usage/adopted/cost unknown,并把 `provider-call` 写入 evidence;没有 usage 或成本证据时仍为未知,不自行估算费用。交互式 provider meter 的 `input/thinking/activity/output/total ~N tok est` 只是等待中的可见活动估算,不进入成本判断。
- main agent loop:provider 可多轮返回 `toolIntents`,odai dispatcher 执行/拒绝后把模型可见 tool results 带入下一轮;`list` 返回脱敏后的目录项,`search` 返回脱敏后的命中路径/行号/行文本,普通文件 read 内容、显式授权后的 shell stdout/stderr、显式授权后的 network body 会进入下一轮 provider 上下文以支撑真实代码操作,但 run record / evidence / transcript 仍只保存公开摘要和字节数;credential/private 路径即使在主流程显式授权后可由 runtime 读取,内容也只留在主流程工具结果中,不会下传到模型上下文。network body 下传时标为 untrusted 并脱敏常见 secret 形态。mock 已验证 read -> write -> stop 的主流程工具循环。
- agent progress events:agent loop 支持结构化 `agent-turn-start`、`provider-text`、`provider-usage`、`provider-meter` 和 `tool-result` 事件;`agent-turn-start` 只携带数字化 `estimatedInputTokens`,不暴露 prompt / 文件路径 / 上下文内容;交互 CLI 会即时显示这些事件,并把 provider meter 写入 transcript。mock provider、OpenAI Responses streaming adapter、Anthropic Messages streaming adapter、OpenAI-compatible Chat Completions streaming adapter、Claude Agent SDK adapter 已接入 `provider-text`;OpenAI / Anthropic / OpenAI-compatible / Claude Agent SDK streaming provider 会在可得时发出 `provider-usage`;Codex / Claude / Grok / command-json subprocess provider 已改为 async subprocess,等待中不会阻塞 meter 刷新。meter 有 provider 自报 usage 时显示 `tokens: input/output/total`,没有 usage 时明确标注 `input ~N tok est` / `thinking/activity ~N tok est` / `output ~N tok est` / `total ~N tok est`,避免把等待估算当作真实计费 token。
- multi-subagent orchestration:CLI 支持重复 `--subagent profile[:provider[:model]]`,可在主 agent loop 外追加 reviewer/challenger 等 subagent;未显式指定 provider 时,调度器优先选择满足 profile 能力且不同于主 provider 的可用 provider;显式 model 会作为该 subagent provider call 的任务级覆盖进入 usage/evidence;追加 subagent 以并发 batch 执行,保序汇总 `subagentReviews`,失败项进入 `subagentFailures` 并保留已成功 subagent 的 evidence;subagent 结果只进入 review summary/evidence,默认不采纳。
- agent profile config:新增 `.odai/agents.json` 工作区配置入口,支持追加或覆盖 subagent profile 的 `purpose`、`tools`、`providerRequirements` 和 `allowedOutputs`;内置 profile 包括 reviewer、challenger、implementer_candidate 和 `bulk_reader`。`odai agents [--use-api-key] [--use-provider-command] [--main-provider <name>|--exclude-provider <name>]` 和交互 `/agents ...` 可查看内置与工作区 profile,并输出每个 profile 的 provider candidates、auto routing 状态、blocked reason 和工具边界;`--main-provider` / `--exclude-provider` 会在只读预览里把对应 provider 标记为 excluded,用于模拟实际 subagent 调度会排除主流程 provider 的语义,解释 subagent 是否会回退 mock、是否需要显式 `--subagent profile:<provider>`、以及为什么 subagent 不能直接写文件。`odai init` 同时生成 `.odai/agents.example.json`,给出 deep reviewer / bulk reader / cheap challenger / patch candidate 的安全 profile 模板,用于真实多模型编排时复制到 `agents.json`。profile 名、数组字段和工具权限都会在加载时校验;当前只允许 `none`、`read_only`、`virtual_patch_only`,不开放真实写入型下放。坏 JSON、非法结构或单个非法 profile 会 fail closed:内置 profiles 仍可用,坏 entry 被跳过并进入 `configErrors`,不让常驻 CLI 因工作区配置错误直接中断。
- provider auto routing:显式传 `--provider auto` 时,main agent 会按 `reasoning+code` 能力选择可用 provider;`--model` 会先作为任务级模型覆盖应用到候选 provider,因此只有 API key 但缺默认模型 env 的 provider 可在显式授权和显式模型下参与 auto 路由。只有一个真实 provider 可用时选它,没有真实可用 provider 时安全退回 mock,多个真实 provider 同时可用时 fail closed 并要求用户显式 `--provider <name>`,避免多凭证 / 多订阅 / 成本路径歧义下静默选择。`--subagent reviewer:auto` 或省略 provider 的 `--subagent reviewer` 都按 profile 能力选择 provider,并排除主流程实际选中的 provider;subagent spec 的 `profile:auto:model` 会同样先应用模型覆盖再判断候选可用性。运行入口还支持重复 `--exclude-provider <name>` 从 subagent auto 候选中继续移除 provider。没有真实候选时回退符合 profile 的 mock,只有一个真实候选时选它,多个真实候选时 fail closed 并要求 `--subagent profile:<provider>` 或进一步 `--exclude-provider`。未显式 auto 的主 `odai run` 脚本路径默认仍保持 mock,避免偷偷调用真实 provider。
- resume metadata:run record 写入 `resume.argv`,用于 `continue --run` 恢复主流程形态和 subagent 编排;不会自动保存/复用 `--use-api-key`、`--use-provider-command`、`--allow-shell`,也不会持久化模型原始 `--tool-intent-json` 或写入 payload `--content`;`continue` 的只读摘要会从保存记录的 provider/usage/evidence 中推导不可恢复确认项,提醒用户重新传最小 flag。
- model tool intents:provider/subagent 可返回 `toolIntents`;主 agent intents 可由 odai dispatcher 执行/拒绝,subagent intents 由 scheduler 交给 odai dispatcher 并受 boundary gate 限制。当前支持 `list` / `read` / `search` / `write` / `shell` / `network` 和非工具 intent `ask-user` / `complete`;已验证 subagent 直接写文件、network intent、ask-user 和 complete intent 会被拦截。OpenAI / OpenAI-compatible / Claude CLI / Codex CLI / Grok CLI / command-json adapter 已支持严格 JSON envelope 解析,普通自然语言不会被猜成工具动作;JSON envelope 中的 `providerSession` 会独立于 `toolIntents` 保留,即 provider 只返回文本和会话 hint、不请求工具时也不会丢失续会话证据。
- tool intent limits:provider 每轮最多允许 20 个 tool intent;超过上限时 runtime 不执行任何 intent,agent loop 以 `tool_intent_limit_exceeded` 停止,并写入 `tool-intent-batch` policy denial 到 evidence。单个模型 tool intent payload 也有字符上限;超限时在 dispatch 前记录 `tool-intent-payload` policy denial,不把超大 content 交给写入、checkpoint 或持久化路径。两类限制均覆盖 main agent 和 subagent。
- non-tool model intents:`ask-user` 和 `complete` 会被 parser 保留并进入 dispatcher,但不会作为 runtime tool 执行。main agent 返回这类 intent 会被 policy gate 拒绝并写入 evidence;subagent 返回这类 intent 会被 subagent-boundary 拒绝,避免 agent 自行占用用户通道或宣布完成。拒绝记录中的 `question` / `summary` 也按普通模型输出脱敏,避免通过非工具 intent 字段写入 secret。
- provider adapters:mock provider 可执行;OpenAI API provider 有 Responses API HTTP 形状、SSE streaming 解析、JSON tool-intent envelope、任务级 `--model` 覆盖和 fake-fetch/fake-SSE 测试;Anthropic API provider 有 Messages API HTTP 形状、SSE streaming 解析、JSON tool-intent envelope 和任务级模型覆盖;Gemini API provider 有 generateContent HTTP 形状、JSON tool-intent envelope 和任务级模型覆盖;`openai-compatible` provider 有 Chat Completions 形状、SSE streaming 解析、`stream_options.include_usage`、任务级模型覆盖和 fake-fetch/fake-SSE 测试,覆盖第三方中转站 / 本地兼容网关;Ollama provider 有 `/api/chat`、`stream:false` 形状、任务级模型覆盖和 fake-fetch 测试;`command-json` provider 有 subprocess/stdin 形状、fake runner 测试和可选 `modelArgs` 模板,要求显式 `--use-provider-command`,并在临时空 cwd 中运行;Claude / Codex / Grok CLI provider 有 subprocess 形状和 fake runner 测试,均要求显式 `--use-provider-command`,并可用 `ODAI_CLAUDE_COMMAND` / `ODAI_CODEX_COMMAND` / `ODAI_GROK_COMMAND` 指向非 PATH 可执行文件,模型覆盖会进入对应 CLI `--model` 参数;所有外部 subprocess provider 默认清理敏感环境变量,避免把宿主 shell 的 token / API key 泄给模型 CLI;command-json / Codex / Grok / Claude CLI provider 会把外部 CLI 工作目录隔离到临时空目录,避免绕过 odai 直接读项目文件;Claude Agent SDK provider 已按官方 `query()` async stream 形状实现可选动态 import/fake SDK 测试,默认禁用 SDK 原生工具,传入临时空 `cwd`、脱敏 env、`canUseTool` deny、输出上限和 provider text/session id 脱敏,支持任务级模型覆盖,且即使包已安装也要求显式 `--use-provider-command` 才会执行。
- Ollama provider:新增 `ollama-local` built-in provider 和 `.odai/providers.json` 的 `type: "ollama"` 配置入口;按 Ollama 官方 `/api/chat`、`stream:false` 形状发送 no-tool chat probe,解析 `message.content` 里的 odai JSON tool-intent envelope,透传 `prompt_eval_count` / `eval_count` / duration 等本地统计;未配置 model 时 `model_required`,不默认调用本机服务。
- provider doctor:已有最小 no-tool provider probe,输出 provider 摘要、文本截断、tool intent 数、usage/message count 和结构化错误;不会给 provider 本地工具能力,也不会声称执行文件或 shell 操作。
- patch proposal:subagent 只产出候选 edits;主流程采纳时仍通过 dispatcher,无读取证据会被 evidence gate 拦截;CLI 已有 mock 采纳路径。
- shell runner:默认只记录 shell intent;显式开启执行时只接受 argv 数组,且必须同时满足项目 policy 允许、任务带 `--allow-shell`、命中命令 allowlist;不解析 shell 字符串,清理敏感环境变量,并带 timeout / 输出截断和 stdout/stderr 敏感片段脱敏;已抽出 sandbox adapter,默认 `none`,支持 macOS `sandbox-exec`、Docker `run` 和 devcontainer `exec` sandbox 包裹;配置后底层命令不可用、Docker 缺 image 或 macOS `sandbox-exec` 无法 apply profile 会 fail closed。Docker sandbox 默认 `--network none`、`--read-only` rootfs、workspace/session tmp bind mount、`--cap-drop ALL`、`no-new-privileges`;devcontainer sandbox 默认使用 `devcontainer exec --workspace-folder <workspace>`。
- network runner:默认禁用;显式执行时必须同时满足 `--allow-network`、项目 `network.allowRequests`、host allowlist 和 `risk:external` 授权;执行结果只记录 status、公开 headers 和截断 body,并写入 `evidence.network` / `events.network`;不会注入凭证或 cookie。
- write checkpoint:通过 gates 的真实写入会先保存写入前内容到 `.odai/runs/checkpoints/<session>/` 或 session tmp,write evidence 绑定 checkpoint id;新文件写入会记录 `existed:false` checkpoint。rollback 默认不删除新建文件,只恢复写入前已存在的文件;支持 record path selector、`--path` 和 `--checkpoint` 过滤,显式 `--delete-new-files` 可处理新建文件 checkpoint。
- rollback audit:执行 `rollback --confirm` 后会写入 `mode: rollback` 审计 run record,保留 `sourceRecordPath`、恢复/删除结果和可反向恢复的 evidence checkpoints;CLI 返回、`continue` 摘要和 audit 顶层 `items` 只保留 id/path/action/existed/reason 等公开字段,不重复暴露 `checkpointPath`、`reverseRecord` 或 `reverseCheckpoints`;latest 指向 rollback audit 后,`continue --run` 会 fail closed,不会重复执行回滚;显式 `odai rollback <auditRecordPath> --confirm` 仍可用 audit evidence checkpoints 恢复回回滚前状态。

已验证:

- `npm --prefix cli test`
- `npm --prefix cli run check`
- `npm --prefix cli test` 覆盖 `odai init` 核心行为:首次创建 `.odai` 配置、二次运行不覆盖、`--force` 才覆盖,并确认生成的 policy/provider/agent config 可被现有 loader 读取;同一 smoke 也覆盖交互式 `/init` 命令会写入 transcript。
- `git check-ignore -v .odai/providers.json .odai/agents.json .odai/policy.json`,确认本机 provider/agent/policy 配置默认不会进入版本库;`git check-ignore -v .odai/providers.example.json .odai/agents.example.json .odai/policy.example.json` 命中反忽略规则,安全示例 scaffold 仍可选择提交。
- `node cli/bin/odai.mjs phase0`
- `node cli/bin/odai.mjs providers`,默认列出 `ollama-local` 且 `blockedReason: "model_required"`。
- `node cli/bin/odai.mjs providers`,当前本地 `packages.claudeAgentSdk: false`,对应 provider 为 `subscription-sdk` 且 `blockedReason: "sdk_package_not_installed"`;smoke 另覆盖 SDK 包存在但未传 `--use-provider-command` 时为 `provider_command_requires_explicit_use`,不会加载 SDK 或发起模型调用。
- `ODAI_OLLAMA_MODEL=llama3.2 node cli/bin/odai.mjs providers`,registry 将 `ollama-local` 标为 available,但本验证没有调用真实 Ollama 模型。
- `node cli/bin/odai.mjs policy`,默认输出 `shell.sandbox.mode: "none"` 且 `network.allowRequests: false`。
- `npm --prefix cli test` 覆盖 `.odai/policy.json` fail-closed:坏 JSON、unsupported sandbox、非布尔 `allowExecution` / `allowRequests`、非法 allowlist 都返回默认拒绝 + `configErrors`;sandbox/e2e readiness 和 run record 保留 `configErrors`;看似放权但类型错误的 policy 下,agent-loop network intent 仍被 project policy 阻断。
- `npm --prefix cli test` 覆盖 `odai init` 生成的 `.odai/policy.example.json`:包含 Docker / devcontainer / macOS sandbox-exec 强沙箱模板,默认 `policy.json` 仍保持拒绝;把 Docker 示例复制为 policy 后,在 fake Docker availability 下 sandbox readiness 可达到 `configuredStrong: true`。
- `npm --prefix cli test` 覆盖 policy config error 脱敏:unsupported sandbox mode 中的 token-like 值进入 `configErrors` 前会被替换为 `[redacted]`,但仍保留结构化错误诊断。
- `npm --prefix cli test` 覆盖 Docker sandbox policy 解析、`docker run` 命令规划、缺 image/缺 docker fail closed,以及 dispatcher 层不执行缺失 Docker 的 shell intent。
- `npm --prefix cli test` 覆盖 macOS `sandbox-exec` 可用性探测:命令不存在或 profile apply probe 不可用时在规划阶段 fail closed。当前宿主有 `/usr/bin/sandbox-exec`,但 `sandbox_apply` 返回 `Operation not permitted`,所以没有声称完成真实 macOS sandbox 执行验收。
- `node cli/bin/odai.mjs doctor`,列出 provider 状态并提示 `--provider` / `--all` probe。
- `node cli/bin/odai.mjs doctor --all`,默认环境只 probe `mock-main` / `mock-reviewer`,其余 API/CLI/SDK/Ollama provider 仅记录 blocked,顶层 status 为 `partial`,不会偷偷调用凭证、外部命令或本机模型服务。
- `npm --prefix cli test` 覆盖 `doctor --all`、`doctor --all --save` 和 `continue --run` 恢复 all-provider probe;有 blocked provider 时顶层 status 为 `partial`;`doctor --provider ... --model <name>` 会把模型覆盖传入 probe / usage / providerSession 并可被 `continue --run` 恢复;即使带 `--model`,未显式 `--use-api-key` 的 API provider 仍 blocked;`continue` 只读摘要会对 all-provider doctor 记录提示 API key / 外部 provider command 确认不可恢复,而 mock-only doctor 记录不制造高风险 flag 提示。
- `npm --prefix cli test` 覆盖 `doctor --all` 顶层状态优先级:`failed` 高于 `partial`,`partial` 高于 `ready`,避免 provider probe 失败被 blocked/ready 摘要掩盖。
- `node cli/bin/odai.mjs doctor --provider mock-main --prompt health`,返回 mock provider probe,`toolIntentCount: 0`。
- `node cli/bin/odai.mjs doctor --provider mock-main --prompt health --stream`,返回 mock provider probe 和事件摘要 `events.count: 0`。
- `node cli/bin/odai.mjs doctor --provider mock-main --prompt health --save` 后执行 `node cli/bin/odai.mjs continue` 会识别为 provider probe,`node cli/bin/odai.mjs continue --run` 会重新执行 doctor probe,不误走普通 mock task。
- `OPENAI_API_KEY=test ODAI_OPENAI_MODEL=test-model node cli/bin/odai.mjs doctor --provider openai-api`,未传 `--use-api-key` 时返回 `status: "blocked"` 和 `api_key_requires_explicit_use`。
- `node cli/bin/odai.mjs`,进入 `odai>` 后执行 `/doctor --provider mock-main`,返回 `status: ready`、`provider: mock-main`、`toolIntents: 0`。
- `node cli/bin/odai.mjs run agent-loop-read --agent-loop --file cli/src/index.mjs`
- `node cli/bin/odai.mjs run agent-loop-read --agent-loop --file cli/src/runtime/agent-loop.mjs`,输出 evidence events 中包含 `agent-turn`。
- `node cli/bin/odai.mjs "hello cli" --target .odai/runs/interactive-action.txt --content after-interactive-action`,输出 `odai interactive session`、执行初始任务、显示运行中 `agent: turn` / `tool: read` / `tool: write`,并写入 `.odai/runs/latest.json`,不再走 JSON one-shot。
- `printf '/exit\n' | ./cli/bin/odai.mjs "default auto provider check" --file cli/src/index.mjs`,验证默认交互入口会把初始任务规范化为 `--provider auto`;当前无真实 provider 授权时 run record 中 `providerSelection: { requested: "auto", selected: "mock-main" }`,不会越权调用 API key 或外部 CLI。
- `node cli/bin/odai.mjs "equals provider initial task" --provider=mock-main --file=cli/src/index.mjs --max-turns=1`,验证等号形式参数不会被交互层追加的默认 `--provider auto` 覆盖,并会被 run parser 解析为真实 provider/file/max-turns 参数。
- `npm --prefix cli test` 覆盖高风险确认的等号布尔形式: `--use-api-key=true` / `--use-provider-command=true` 能被 readiness、doctor、run 和 continue 入口识别,同时 `publicTaskArgv` 会从 transcript / resume argv 中剔除这些不可恢复确认。
- `npm --prefix cli test` 通过子进程直接执行 `cli/bin/odai.mjs "spawned initial task" --file cli/src/index.mjs`,stdin 输入 `/exit`;断言 stdout 包含 `odai interactive session` / `status: ready` 且不是 JSON one-shot,最新 run record 为 `mode: "agent_loop"`、`providerSelection.requested: "auto"`;同时断言交互式终端输出不包含 workspace 绝对路径,`transcript:` / `saved:` 使用 `.odai/...` 相对路径。脚本化 REPL 测试另覆盖 provider progress 事件、最终 run summary、交互式上下文和 transcript 摘要中的 workspace 内 tool path / saved run path 都会规范化为相对路径。
- `npm --prefix cli test` 通过子进程直接执行 `cli/bin/odai.mjs "non tty initial task" --max-turns 1`,stdin 关闭;断言无 timeout、stdout 包含 `odai interactive session` / `status: ready`,最新 run record 为 `mode: "agent_loop"`。
- PTY 执行 `node cli/bin/odai.mjs "TTY入口验证" --file cli/src/index.mjs`,确认初始任务执行完成后继续停留在 `odai>`;输入 `/exit` 后正常退出。PTY 执行 `node cli/bin/odai.mjs "显示路径检查" --file /Users/orzi/Documents/works/orzi/odai/cli/src/index.mjs --max-turns 1`,确认终端输出 `transcript: .odai/sessions/...`、`tool: read cli/src/index.mjs`、`saved: .odai/runs/...`,不再把 workspace 绝对路径打给用户。
- PTY 执行 `./cli/bin/odai.mjs` 后输入 `/provider mock-reviewer`、`plain after provider --file cli/src/index.mjs`、`/exit`,确认当前 REPL 的普通任务默认 provider 切到 `mock-reviewer`,且不会把 API key / 外部命令等高风险确认设为默认。
- `npm --prefix cli test` 覆盖 `./cli/bin/odai.mjs --help` 直接子进程执行,验证 shebang / 可执行位 / CLI bin 入口有效,help 明确 `odai [task]` 是默认交互入口,`odai run <task>` 才是一次性脚本模式。
- `npm --prefix cli test` 覆盖 `odai setup` 和交互式 `/setup`:缺失 `.odai` config 时提示 `odai init`,初始化后 config section ready;setup 输出主入口命令、`cliSetup` 本地可执行入口 / package bin / link 提示、内置 provider 启用提示、sandbox setup 候选、provider/sandbox readiness、保存证据缺口和有序 `completionPath`;顶层 `next` 会压成 API+subscription runtime 前提、`odai e2e`、`doctor --all --save`、subscription CLI probe evidence、强沙箱配置、`odai sandbox`、sandbox smoke 等阶段动作,传 `--model <name>` 时对应 e2e / doctor 命令会保留模型覆盖;不会调用真实 provider 或 sandbox smoke;REPL transcript 只保存摘要并脱敏 next/note 中的 token-like 字符串。`doctor --setup --save` 会保存 setup guide,`continue --run` 可重跑,但不会自动恢复 `--use-api-key` / `--use-provider-command` 确认。
- `npm --prefix cli test` 覆盖 i18n: `normalizeLanguage` / `detectLanguage` / `t`、中文 slash-command completion 描述、`ODAI_LANG=zh` 下 `odai setup` note、脚本化 `/language zh|en` 会话切换和无效语言 blocked;子进程 smoke 固定 `ODAI_LANG=en`,避免本机 locale 影响旧英文断言。
- `./cli/bin/odai.mjs "非TTY入口验证" --file cli/src/index.mjs`,验证非 TTY 下仍先执行默认交互入口的初始任务,stdin EOF 后正常退出,不会卡死在 `odai>`。
- `node cli/bin/odai.mjs "stream cli" --file cli/src/index.mjs`,最终摘要前先输出 `agent: turn 1 mock-main`、`assistant: ...` 和 `tool: read ...` 进度行。
- `printf '/exit\n' | node cli/bin/odai.mjs "transcript入口检查" --file cli/src/index.mjs`,输出 transcript 路径并写入 `.odai/sessions/latest.json`;对应 JSONL 包含 `session-start`、`task-submit`、`progress`、`task-result`、`session-end`。
- `node cli/bin/odai.mjs sessions --tail 3`,返回最新 session transcript 的 `sessionId`、`transcriptPath`、总事件数和尾部事件。
- `node cli/bin/odai.mjs sessions --tail 2 --context`,返回最新 session 的恢复上下文,包含消毒后的 `lastTaskArgv`、`lastResult` 和 `notRestored` 风险项。
- `node cli/bin/odai.mjs sessions --compact --tail 5`,写出 `.odai/sessions/<session>.context.json`,返回 `kind: "session-compact-context"`、消毒后的 `lastTaskArgv`、tool/provider/file 摘要和不可恢复确认项。
- PTY 交互执行 `node cli/bin/odai.mjs` 后输入 `/context`、`/exit`,验证 `/context` 会在当前 REPL 内生成 compact context 并正常回到 `odai>`。
- `printf '/exit\n' | node cli/bin/odai.mjs resume --tail 2`,启动恢复 session,显示来源 session 和上一任务;随后 `node cli/bin/odai.mjs sessions --context --tail 3` 仍能从空 resume session 继承上一条有效任务。
- `node cli/bin/odai.mjs run agent-loop-write --agent-loop --target .odai/runs/agent-loop-target.txt --content after-cli-agent-loop`,临时目标先读后写,结果文件内容为 `after-cli-agent-loop`。
- `./cli/bin/odai.mjs run create-new-file-check --agent-loop --target .odai/runs/create-new-file-check.txt --content created-by-odai`,验证新文件创建路径:第一轮 read 返回结构化 `file_not_found` 并记录 `location` evidence,第二轮 write 通过 evidence gate,checkpoint 记录 `existed:false`。
- `node cli/bin/odai.mjs run multi-subagent --agent-loop --file cli/src/index.mjs --subagent reviewer:mock-reviewer --subagent challenger:mock-main`,输出两个 `subagentReviews`,evidence 记录两个 subagent。
- `node cli/bin/odai.mjs run auto-subagent --agent-loop --file cli/src/index.mjs --subagent reviewer`,主 agent 使用 `mock-main`,未指定 provider 的 reviewer 自动选择 `mock-reviewer`。
- `npm --prefix cli test` 覆盖 `.odai/agents.json` 的默认 profile、workspace 覆盖、新增 `deep_reviewer` profile、内置 `bulk_reader` profile、非法 `tools: "write"` 和坏 JSON fail closed:内置 profiles 保留、坏 entry 跳过并通过 `configErrors` 暴露;同时覆盖 `--subagent deep_reviewer:auto` 和 `--subagent bulk_reader:auto` 按 `long_context` 需求自动选择 `mock-reviewer`。
- `npm --prefix cli test` 覆盖 `odai init` 生成的 `.odai/agents.example.json`:包含 deep reviewer / bulk reader / cheap challenger / patch candidate 四类安全 profile;把 deep reviewer 和 bulk reader 示例复制到 `agents.json` 后,loader 和 `odai agents` profile 描述能识别 `providerRequirements: ["code","long_context"]` / `["long_context"]`,且工具权限仍为 `read_only`。
- `npm --prefix cli test` 覆盖 `odai agents` provider routing 视图:profile 描述会附带 provider candidates、`mock-fallback` / `ready` / `ambiguous` auto 状态和工具边界说明;构造 API provider + fake Claude CLI 同时可用时,reasoning profile 会显示 ambiguous 并列出 openai/claude 候选;传 `--main-provider openai-api` 时 openai 候选标记为 excluded,auto 预览改为选择 `claude-cli`;交互式 `/agents --use-provider-command=true --main-provider mock-main` 会把 flag 传给同一 handler。
- `npm --prefix cli test` 覆盖 agent profile 公开描述脱敏:workspace profile 的 `purpose` 或非法 profile name 中带 token-like 值时,`odai agents` / profile description 只输出 `[redacted]`。
- `npm --prefix cli test` 覆盖交互 `/agents` 命令会输出当前 agent profile 清单。
- `node cli/bin/odai.mjs run auto-main-provider --agent-loop --provider auto --file cli/src/index.mjs`,默认环境下 `providerSelection.selected` 为 `mock-main`,并保留 `resume.argv` 中的 `--provider auto`。
- `node cli/bin/odai.mjs run auto-review-provider --agent-loop --file cli/src/index.mjs --subagent reviewer:auto`,主 agent 使用 `mock-main`,显式 auto reviewer 选择 `mock-reviewer`。
- `npm --prefix cli test` 覆盖实际运行路径中的 subagent auto 编排:工作区注册两个可用 `command-json` provider,主 agent 显式使用 `node-json-e2e`,reviewer `--subagent reviewer:auto` 自动排除主 provider,再通过 `--exclude-provider codex-cli --exclude-provider grok-cli` 移除其他订阅 CLI 候选,最终选择另一个 `command-json` provider `node-json-reviewer`;`resume.argv` 会保留 `--exclude-provider`,而高风险 `--use-provider-command` 不会恢复。
- `./cli/bin/odai.mjs run subagent-auto-check --agent-loop --file cli/src/index.mjs --subagent reviewer:auto`,验证当前无真实 subagent provider 授权时,显式 auto subagent 安全回退 `mock-reviewer`,并把 subagent evidence / usage 写入 run record。
- `node cli/bin/odai.mjs run network-intent-default-deny --agent-loop --tool-intent-json '{"type":"network","url":"https://example.com/api","method":"GET"}'`,network intent 被任务级 `--allow-network` policy gate 拒绝,run record 的 evidence.denials 保留 URL/method。
- `node cli/bin/odai.mjs run network-intent-policy-deny --agent-loop --allow-network --tool-intent-json '{"type":"network","url":"https://example.com/api","method":"GET"}'`,在项目 policy 未开启 network 时仍被 policy gate 拒绝。
- `node cli/bin/odai.mjs run ask-user-intent-check --agent-loop --tool-intent-json '{"type":"ask-user","question":"Can I ask the user?"}'`,ask-user intent 被 policy gate 拒绝,run record 的 evidence.denials 保留 question。
- `node cli/bin/odai.mjs run parallel-subagents --agent-loop --file cli/src/index.mjs --subagent reviewer:mock-reviewer --subagent challenger:mock-main`,输出两个并发 subagent review,usage ledger 记录 main/subagent provider calls,evidence 包含 `subagent-batch: { parallel: true, requested: 2, providers: ["mock-reviewer","mock-main"], heterogeneousProviders: true }`。
- `node cli/bin/odai.mjs run partial-subagent-failure --agent-loop --file cli/src/index.mjs --subagent reviewer:mock-reviewer --subagent missing-profile:mock-main`,返回 `status: failed`,但保留成功 reviewer 的 review/evidence,并输出结构化 `subagentFailures`。
- `node cli/bin/odai.mjs`,进入 `odai>` 后输入 `/exit` 可正常退出。
- `node cli/bin/odai.mjs`,进入 `odai>` 后输入 `/authorize production` 可记录 `risk:production`,再 `/exit` 可正常退出。
- `node cli/bin/odai.mjs`,进入 `odai>` 后用 mock production shell intent 触发授权拒绝,摘要显示 `/authorize risk:production`;执行 `/authorize production` 后 `/retry` 不再显示授权需求。
- `node cli/bin/odai.mjs`,进入 `odai>` 后用 mock production shell intent 触发授权拒绝,CLI 自动提示 `authorize risk:production? [y/N]`;输入 `y` 后自动 retry,同一任务转为记录 shell intent。
- `OPENAI_API_KEY=test node cli/bin/odai.mjs providers`
- `OPENAI_API_KEY=test node cli/bin/odai.mjs providers --use-api-key`
- `OPENAI_API_KEY=test ODAI_OPENAI_MODEL=test-model node cli/bin/odai.mjs providers --use-api-key`
- `./cli/bin/odai.mjs providers --use-api-key --use-provider-command`,当前无 API key 时 OpenAI / Anthropic / Gemini 均返回 `blockedReason: "api_key_missing"` 并显示 `source.apiKeyEnv` / `source.modelEnv`;当前本机 `codex-cli` / `grok-cli` 在显式 provider-command flag 下标为 available,但未执行真实模型 probe。
- `OPENAI_API_KEY=test node cli/bin/odai.mjs run try-api --provider openai-api`,预期拒绝并返回 `api_key_requires_explicit_use`。
- `ANTHROPIC_API_KEY=test GEMINI_API_KEY=test node cli/bin/odai.mjs providers`,Anthropic/Gemini 均返回 `api_key_requires_explicit_use`。
- `ANTHROPIC_API_KEY=test ODAI_ANTHROPIC_MODEL=test-claude GEMINI_API_KEY=test ODAI_GEMINI_MODEL=test-gemini node cli/bin/odai.mjs providers --use-api-key`,Anthropic/Gemini 均标为 available。
- `npm --prefix cli test` 覆盖 `command-json` provider:配置存在但无 `--use-provider-command` 时 blocked,显式允许后可用;fake runner 通过 stdin 返回 JSON tool-intent envelope;session-only JSON envelope 即使省略 `toolIntents` 也会保留 `providerSession`。
- `npm --prefix cli test` 覆盖 provider blockedReason 和 source metadata:内置 API provider 缺 key 返回 `api_key_missing`;OpenAI-compatible provider 缺 model 返回 `model_required` 且不可用;内置 API / 订阅 CLI / Claude Agent SDK / command-json / openai-compatible 的 `source` 只包含 env 名、命令、包、baseUrl 和确认 flag,Claude / Codex / Grok CLI 额外覆盖 `ODAI_CLAUDE_COMMAND` / `ODAI_CODEX_COMMAND` / `ODAI_GROK_COMMAND` 显式可执行文件入口,并对 baseUrl / command 等字符串值二次脱敏,不泄露 secret 值;`doctor --all` 和 `.odai/runs` 外部证据扫描也保留脱敏后的 provider source,即使历史 run record 里保存了带 token 的 source URL 也不会重新泄露。
- `npm --prefix cli test` 覆盖 `.odai/runs` 外部证据扫描的 sandbox smoke 命令脱敏:历史强沙箱 smoke 记录里的 `--token`、`API_KEY=` 和 URL query token 不会在 `externalEvidence` / acceptance / milestones 证据摘要中重新泄露。
- `npm --prefix cli test` 覆盖订阅型 CLI provider 授权门:Claude / Codex / Grok CLI provider 默认 blocked,只有显式 `--use-provider-command` 才执行 fake subprocess;Claude CLI subprocess probe 验证敏感环境变量不会传入 provider 子进程,并使用临时空目录、timeout 和输出截断;Codex fake runner 验证新版 Codex CLI 以顶层 `--ask-for-approval never` 调用 `exec`,并使用临时空目录和 `read-only` sandbox;Grok fake runner 验证 `--prompt-file`、`--permission-mode plan`、禁用 web search / subagent 和临时空目录。
- `npm --prefix cli test` 覆盖 `odai auth status` 的订阅 CLI 摘要:Claude CLI 显式命令或自动发现时会列出 command、`executableEnv` / `executableConfigured` / `executableDiscovered`、model env 状态、登录提示和保存 doctor probe 命令;fake Claude CLI 返回 `Not logged in · Please run /login` 时,`doctor --provider claude-cli` 会返回 `next` 数组,指明运行当前 Claude binary 进入 `/login` 后再执行 `odai doctor --provider claude-cli --use-provider-command --model <model> --save`。
- `npm --prefix cli test` 覆盖 `odai auth login claude-cli`:dry-run 会返回发现到的 Claude command、空临时 cwd 策略、交互标记和 doctor 后续命令;非 TTY 不会启动外部 CLI 而是 blocked;非 Claude 订阅 CLI login handoff 暂时 fail closed,要求使用 provider CLI 自己的认证入口。
- `./cli/bin/odai.mjs providers`,当前本机显示 `commands.codex: true`、`commands.grok: true`,对应 `codex-cli` / `grok-cli` provider 仍因未传 `--use-provider-command` 标为 blocked,没有调用真实订阅型 CLI 模型。
- 在临时目录写入非法 `.odai/providers.json` 后执行 `node /Users/orzi/Documents/works/orzi/odai/cli/bin/odai.mjs providers`,CLI 不崩溃,仍列出内置 providers,并输出 `configErrors` 指向坏配置文件和 JSON 解析错误。
- `npm --prefix cli test` 覆盖 `.odai/providers.json` 注册的 `command-json` provider 真实 subprocess E2E:用本机 `node` 子进程作为 provider,未传 `--use-provider-command` 时 `odai doctor` blocked,显式允许后 doctor probe ready;fake runner 断言 provider 子进程收到临时空 cwd、timeout 和输出上限;`odai run --agent-loop --provider node-json-e2e --use-provider-command` 可从子进程返回 read tool intent 并经 odai runtime 读取文件;保存 run 后 `continue` 摘要提示 `provider-command-confirmation` 和 `--use-provider-command`,而 `continue --run` 不会自动恢复外部命令确认,必须重新传 `--use-provider-command`。
- `npm --prefix cli test` 覆盖 provider config 结构化错误:混合有效/无效 entries 时只注册有效 provider,无效 type / 缺 command / token-like 非法 name 进入 `configErrors`;非法 name entry 不会注册为 provider,公开错误会脱敏原始 provider name;非法 JSON 返回空 provider config 和 `configErrors`,不会抛出未捕获异常。
- `npm --prefix cli test` 覆盖 provider config error 公开输出脱敏:config error 的 file/field/provider/type/message 只保留白名单字段并脱敏 token-like 值,不会暴露 raw error payload。
- `npm --prefix cli test` 覆盖 workspace provider 不能覆盖内置 provider 名:配置 `name: "openai-api"` 的 `command-json` entry 会被跳过并记录 `configErrors`,内置 `openai-api` 仍保持 `kind: "api"`。
- `npm --prefix cli test` 覆盖 command-json 真实 subprocess E2E 的 result note:外部 provider 跑通 agent loop 时 note 使用 `Provider agent loop...`,不再误报 `no real model was called`。
- `npm --prefix cli test` 覆盖 canary runner 显式 provider:默认 `canary-runner` 仍走 `mock-main`;传 `--provider node-json-e2e --use-provider-command --file <path>` 时,canary runner 会调用 `.odai/providers.json` 中的真实 `command-json` 子进程 provider,执行其返回的 read tool intent,并在 last-message 中输出 `provider: node-json-e2e`。
- `npm --prefix cli test` 覆盖 provider auto routing:registry 在 `preferNonMock` 时优先 Ollama fake provider;主流程 `--provider auto` 无真实 provider 时退回 `mock-main`;`auto + --model` 会让 `model_required` 的真实 provider 参与候选;`reviewer:auto` 排除主 provider 后选 `mock-reviewer`;subagent `auto + model` 也会让 `model_required` 的真实 provider 参与候选。
- `npm --prefix cli test` 覆盖 main agent auto provider 的歧义门:没有真实候选时退回 mock,只有一个真实候选时选真实 provider,多个真实候选同时可用时抛出 `Provider auto selection is ambiguous` 并要求显式 `--provider <name>`。
- `npm --prefix cli test` 覆盖 subagent auto provider 的歧义门:显式 `profile:auto` 和省略 provider 的 `--subagent profile` 都走同一调度;没有真实候选时退回 mock,只有一个真实候选时选真实 provider,多个真实候选同时可用时抛出 `Subagent provider auto selection is ambiguous` 并要求显式 `--subagent profile:<provider>`;显式 provider 名仍按指定 provider 执行。
- `npm --prefix cli test` 覆盖 network tool intent:JSON envelope 会保留 `network` intent;main agent 默认被 policy gate 拒绝;项目 policy + 任务 flag + host allowlist 通过但未授权时被 authorization gate 拒绝;显式授权后 fake fetch 才执行并写入 `evidence.network`;subagent network intent 被 subagent-boundary 拒绝。
- `npm --prefix cli test` 覆盖 provider prompt contract 与项目发现工具:交互主流程 prompt 声明为 main odai CLI agent 而不是 subagent,提示外部 provider 临时空 cwd 下不能直接看到项目文件,必须通过 `list` / `read` / `search` tool intent 请求项目上下文;subagent prompt 只允许 `list` / `read` / `search`;dispatcher 的 `list` 会隐藏 `.env` / `.git` / `.odai/runs` / `.odai/sessions` 等私有路径,`search` 只返回公开命中摘要并跳过私有路径。
- `npm --prefix cli test` 覆盖 path boundary:root 外 read intent、session tmp 内 symlink 到外部文件、symlink 到外部目录的 read,以及通过 symlink 目录写新文件都会被 policy gate 拒绝;根外目标文件未被创建;relative tool path 会按 workspaceRoot 读取,不受进程 cwd 影响。另覆盖非 cwd workspace 下 `.odai/runs/*.json` 作为 provider input target 时仍按 protected path 处理,content 不进入 provider context;subagent 通过 `tools.read()` 读取 workspace 绝对路径时返回给 provider 的 path 会转成相对路径,读取私有 `.odai/runs/*.json` 时被 `subagent-boundary` 拒绝且不暴露绝对路径或 secret。
- `npm --prefix cli test` 覆盖 non-tool model intents:JSON envelope 会保留 `ask-user` / `complete`;main agent 返回时 policy gate 拒绝,subagent 返回时 boundary gate 拒绝,并保留 question/summary。
- `npm --prefix cli test` 覆盖 tool intent batch limit:单轮 21 个 read intent 不执行任何 read,agent loop 返回 `completed: false` / `stopReason: "tool_intent_limit_exceeded"`,turn transcript 只记录 overflow 和 batch denial。
- `npm --prefix cli test` 覆盖 OpenAI Responses fake SSE streaming:请求体带 `stream: true`,解析 `response.output_text.delta`,触发 `provider-text`,并从最终文本解析 JSON tool intent。
- `npm --prefix cli test` 覆盖 Anthropic Messages fake SSE streaming:请求体带 `stream: true`,解析 `content_block_delta` 的 `text_delta`,触发 `provider-text`,聚合 `message_start` / `message_delta` usage,并从最终文本解析 JSON tool intent。
- `npm --prefix cli test` 覆盖 OpenAI-compatible Chat Completions fake SSE streaming:请求体带 `stream: true` 和 `stream_options.include_usage`,逐 chunk 解析 `delta.content`,触发 `provider-text`,聚合最终 `usage`,并从最终文本解析 JSON tool intent。
- `npm --prefix cli test` 覆盖交互式 provider meter:agent turn start 会携带数字化 input token 估算;交互 CLI 在 provider text 到达时刷新 `input/thinking/output/total ~N tok est`,provider usage 到达后显示真实 `input/output/total` token,并把 estimatedInput / estimatedThinking / usage 写入消毒后的 session transcript。
- `npm --prefix cli test` 覆盖统一 usage ledger:doctor probe、main agent loop、subagent patch adoption 都会记录 provider call;候选 patch 被主流程采纳后对应 call 标为 `adopted: true`。
- `npm --prefix cli test` 覆盖 evidence sanitization:subagent output 即使带 provider `raw` secret 或 patch edit content,写入 evidence snapshot 时也只保留公开摘要和 edit path,不包含 raw secret 或 patch content。
- `node cli/bin/odai.mjs run usage-check --agent-loop --file cli/src/index.mjs`,输出 `usage.calls`、`usage.totals.byProvider.mock-main` 和 evidence `provider-call` 事件。
- `node cli/bin/odai.mjs run "审查 phase0 骨架" --file cli/src/index.mjs`
- `node cli/bin/odai.mjs run "保存一次 mock 运行" --file cli/src/index.mjs --save`
- `node cli/bin/odai.mjs continue`
- `node cli/bin/odai.mjs continue --run`
- `node cli/bin/odai.mjs run resume-multi --agent-loop --file cli/src/index.mjs --subagent reviewer:mock-reviewer --save` 后执行 `node cli/bin/odai.mjs continue --run`,可恢复 `agent_loop` 和 `subagentReviews`。
- `node cli/bin/odai.mjs run failure-record --agent-loop --provider openai-api`,在 provider 不可用时输出 `status: failed` 和 evidence `error` event。
- `node cli/bin/odai.mjs run rollback-command --agent-loop --target .odai/runs/rollback-command.txt --content after-command --save`,run record 中包含 checkpoint,write evidence 绑定 checkpoint id。
- `node cli/bin/odai.mjs rollback latest`,只预览 `would_restore`,不改目标文件。
- `node cli/bin/odai.mjs rollback latest --confirm`,把 `.odai/runs/rollback-command.txt` 恢复为 `before-command`。
- `node cli/bin/odai.mjs rollback .odai/runs/2026-07-06T07-26-51-099Z.json --path .odai/runs/rollback-filter.txt`,按 record path 和目标文件过滤预览 `would_restore`;换成不匹配路径时 `items: []`。
- `node cli/bin/odai.mjs rollback latest --confirm`,输出 `auditRecordPath`;随后 `node cli/bin/odai.mjs continue --run` 返回 `status: "blocked"`,提示 latest 是 rollback audit,不会重复回滚。
- `npm --prefix cli test` 覆盖 rollback `--checkpoint <id>` 单 checkpoint 选择、reverse rollback record、rollback audit 公开摘要不带 `checkpointPath` / `reverseRecord` / `reverseCheckpoints`,且对 rollback audit record 再执行 rollback 可恢复回回滚前状态。
- `npm --prefix cli test` 覆盖 interactive task context:第二条交互任务收到上一条任务摘要,`resume` 后的 `/retry` 收到恢复上下文;确认上下文只走 provider input,不恢复高风险确认。
- `npm --prefix cli test` 覆盖 providerSession 白名单净化、mock agent loop 顶层 `providerSessions`、usage provider-call、agent turn output、subagent evidence、doctor probe、session transcript compact context、session-resume 清洗和空 resume session 继承;同时确认 `--allow-network` 不会从 session transcript 恢复,transcript/context 不保存 run record 路径、transcript 路径、context artifact 路径、具体 authorization scope、policy/provider/agent/init command-result raw 明细或 providerSession 原始 token-like 值。
- `npm --prefix cli test` 覆盖 provider session resume hint:main agent loop 与 subagent scheduler 只会把当前 provider 的最近 `providerSession` 作为 `resumeProviderSession` 传入 provider input,并从 `conversationContext` 中移除所有 `providerSession(s)` 字段,避免其他 provider 的 session id 泄露。
- `npm --prefix cli test` 覆盖 OpenAI Responses、OpenAI SSE、Anthropic Messages、Anthropic SSE、Gemini、Ollama 和 Claude Agent SDK fake provider 会把响应 / message / session id 作为 `providerSession` 返回;Claude Agent SDK fake provider 只有显式 `allowProviderCommand` 时才执行,否则 blocked 且不加载 SDK;SDK fake query 还断言 `cwd` 为临时空目录、env 不含 token-like 变量、`allowedTools` / `tools` / `mcpServers` 为空、`strictMcpConfig` 和 `canUseTool` deny 生效,并验证 provider text 不泄露模型输出里的 secret。
- `npm --prefix cli test` 覆盖 subagent output policy:reviewer profile 的 `findings` / `risks` 被标为 allowed output keys,`observations` / `patchProposal` / `evidence_summary` 和 token-like output key 被标为 unexpected 且脱敏;这不删除 runtime 原始输出,但公开 evidence / subagent review summary 只保留结构化摘要,避免把额外字段误当成已采纳能力。
- `node cli/bin/odai.mjs rollback latest --checkpoint non-existent-checkpoint-id`,CLI 参数层按 checkpoint id 过滤,返回空 `items` 且不改文件。
- `npm --prefix cli test` 覆盖 rollback 新建文件 checkpoint:默认 skip,`deleteNewFiles` 预览 `would_delete`,确认后删除 ignored 临时文件。
- `find cli -name '*.mjs' -print0 | xargs -0 -n1 node --check`
- `npm --prefix cli run check`
- `npm --prefix cli test`
- PTY smoke:直接启动 `./cli/bin/odai.mjs`,输入 `/mo<Tab><Enter>` 会显示 slash-command 面板并补全执行 `/model`,随后 `/exit` 正常退出;验证真实 TTY 路径不会挂住。
- `npm --registry https://registry.npmjs.org view odai name version --json` 返回 E404,确认官方 npm registry 当前无 `odai` 包。
- `npm --cache /private/tmp/odai-npm-cache pack --dry-run --json` 在 `cli/` 下通过,输出 tarball `odai-cli-0.0.1.tgz` 预览,entryCount 会随 runtime 模块增加而变化,但只包含 LICENSE、README、bin、package.json、src 和包内 `skills/odai` fallback snapshot;未包含 tests、`.odai`、run records 或本机配置。直接 `npm pack --dry-run` 曾被本机 `~/.npm` cache root-owned 文件 EPERM 阻断,改用临时 cache 后验证 package 本身正常。
- `./cli/bin/odai.mjs status`,输出 `kind: "odai-status"`、governance / acceptance / milestones / e2e / saved external evidence 摘要、当前 blockers 和 next actions;当前工作区已有真实 API provider、Codex CLI saved evidence 和 strong sandbox smoke evidence,因此跳过 Claude 后 completion status 可为 ready。
- `./cli/bin/odai.mjs status --use-provider-command=true`,把显式外部 CLI 确认传给内嵌 E2E readiness;`runnableCommands` 只列能解除当前 completion blocker 或 saved evidence requirement 的命令,不会平铺所有当前可用 provider probe。若 subscription CLI 保存证据缺失,`next` 会提示保存 `codex-cli` / `grok-cli` probe;Codex/Grok/Claude CLI 或 subscription SDK 均可作为 A02/P0-1 的 runtime 路径。
- `npm --prefix cli test` 覆盖 `runStatus()` 当前 partial、保存外部证据后的 ready 升级、重复 next action 的命令语义去重、仅 Codex 可用时可作为 runtime readiness、API+subscription runtime 可用时列出 all-provider probe、API/Codex/strong sandbox 已保存时不再建议 Claude runtime probe、`/status --use-provider-command=true` 交互命令输出和 transcript 摘要清洗。
- `npm --prefix cli test` 覆盖 `odai doctor --status`、`odai doctor --status --save` 和 `odai continue --run` 恢复 status audit;continue 摘要会提示 API key / provider command confirmation 不可自动恢复。
- `./cli/bin/odai.mjs audit`,输出 `kind: "completion-audit"`、`complete` 和六类 requirement;当前 runtime governance、saved API+runtime provider evidence、saved subscription CLI provider evidence 与 saved strong sandbox evidence 均可 ready,Claude runtime 缺失不再阻断 completion。`npm --prefix cli test` 覆盖当前 partial、构造保存外部证据后的 ready 升级、CLI 子进程入口、`/audit --use-provider-command=true` 交互命令和 transcript 摘要清洗。
- `npm --prefix cli test` 覆盖 `odai doctor --audit`、`odai doctor --audit --save` 和 `odai continue --run` 恢复 completion audit;continue 摘要会提示 API key / provider command confirmation 不可自动恢复。
- `./cli/bin/odai.mjs evidence`,输出 `kind: "external-evidence"`、扫描 `.odai/runs` 后的真实 API provider / subscription runtime / subscription CLI / 强沙箱 smoke 保存证据计数;requirements 单列 `provider-api-and-runtime`、`provider-subscription-cli` 和 `strong-sandbox-smoke`。当前状态可由真实 API provider 保存证据、Codex/Grok/Claude 等 subscription runtime 保存证据与 strong sandbox smoke 证据共同升级为 ready;公开证据项只暴露脱敏后的 `recordId`,不输出本机 workspace / runs 绝对路径。
- `npm --prefix cli test` 覆盖 `runEvidence()`、`odai evidence` 子进程入口、`/evidence` 交互输出和 transcript 摘要清洗;保存证据扫描不会泄露历史 run record source path、workspace/runs 绝对路径、record id token、provider URL token 或 sandbox smoke 命令 secret。
- `npm --prefix cli test` 覆盖 `odai doctor --evidence`、`odai doctor --evidence --save` 和 `odai continue --run` 恢复 saved external evidence audit。
- `./cli/bin/odai.mjs governance`,输出 `kind: "runtime-governance"`、`summary.total: 18`、`summary.covered: 18`、`missingCanary: 0`,证明已下沉的 runtime 硬门都有 registry 与 canary 映射。
- `npm --prefix cli test` 覆盖 `runGovernance()`、`doctor --governance`、`doctor --governance --save` 和 `continue --run` 的只读 governance 恢复路径。
- `./cli/bin/odai.mjs acceptance`,默认输出 `kind: "plan-acceptance"`、`summary.total: 9`,并在 A02 / 顶层 `externalReadiness` 与 `externalEvidence` 中区分 readiness 前提和已保存真实 provider probe 证据;显式 `--use-api-key` / `--use-provider-command` 会传给内嵌 e2e readiness,但不会把 readiness 冒充为 A02 完成证据;当 `.odai/runs` 中存在真实 API provider + subscription CLI/SDK runtime 的保存 probe 时,A02 升级 ready;A09 覆盖 `/model` 注入 `--model`、任务级模型覆盖、`auto + --model` provider 选择、doctor/e2e 诊断模型覆盖、subagent `profile:provider:model` 和异构多 subagent evidence。
- `npm --prefix cli test` 覆盖 `runAcceptance()`、`doctor --acceptance`、`doctor --acceptance --save` 和 `continue --run` 的只读 acceptance 恢复路径;同时断言 acceptance flag propagation、保存的 all-provider probe 或分开的单 provider `--save` probe 可把 A02 升级 ready,而 mock provider / readiness-only 记录不计入。
- `./cli/bin/odai.mjs milestones`,当前输出 `kind: "plan-milestones"`、`summary.total: 16`、`summary.ready: 15`、`partial: 0`、`needs-external-evidence: 1`,并在 P0-1 中嵌入相关 `e2e-readiness` 和保存证据摘要;当 `.odai/runs` 中存在真实 provider probe 与强沙箱 smoke 证据时,对应里程碑可升级 ready。
- `npm --prefix cli test` 覆盖 `runMilestones()`、`doctor --milestones`、`doctor --milestones --save` 和 `continue --run` 的只读 milestones 恢复路径;同时断言保存的 all-provider probe 或分开的单 provider `--save` probe 可升级 P0-1,保存的强沙箱 smoke 可升级 P2-5,`sandbox-readiness` 这类 readiness-only 记录不会升级。
- `./cli/bin/odai.mjs sandbox`,输出 `kind: "sandbox-readiness"`、当前 policy、configured sandbox 状态和 macOS / Docker / devcontainer 候选强沙箱 fail-closed 原因;当前本地 `.odai/policy.json` 已配置 `macos-sandbox-exec` + `allowedCommands: ["node"]`,受限宿主内 preflight 仍会因 `sandbox_apply` 权限显示 blocked,但提升到本机权限后已通过 `doctor --sandbox --smoke --allow-shell --save` 保存真实 strong sandbox evidence。
- `./cli/bin/odai.mjs sandbox --smoke`,默认返回 `kind: "sandbox-smoke"` / `status: "blocked"` 并提示需要显式 `--allow-shell`;当前默认 policy 下即使传 `--allow-shell` 也会因 `shell.allowExecution: false` 阻断,不会执行 shell。
- `npm --prefix cli test` 覆盖 `runSandboxReadiness()`、macOS sandbox ready/blocked fake probe、Docker sandbox ready fake probe、devcontainer sandbox ready fake probe、`runSandboxSmoke()` 的默认阻断 / policy 阻断 / fake strong sandbox success probe + host escape probe,以及 `doctor --sandbox`、`doctor --sandbox --smoke`、保存和 `continue --run` 的只读 sandbox preflight / smoke 恢复路径;保存 sandbox smoke 后,`continue` 摘要会提示 `shell-execution-confirmation` 和 `--allow-shell` 不可恢复。真实工作区另有 `2026-07-08T04-46-40-308Z.json` strong sandbox smoke evidence:success probe 通过,host escape probe 因 EPERM 失败且宿主 escape 文件未创建。
- `./cli/bin/odai.mjs e2e`,输出 `kind: "e2e-readiness"`、真实 API provider / subscription runtime / 订阅型 CLI / 强沙箱 readiness;当前默认环境为 `partial`,不会调用真实模型或执行外部沙箱。
- `npm --prefix cli test` 覆盖 `runE2EReadiness()`、API key flag readiness、`--model` 满足 model-required API / openai-compatible provider readiness、provider requirement evidence 中的脱敏 source 元数据、available provider 的单 provider `doctor --provider ... --save` 外部证据采集命令、provider API + subscription runtime ready 时列出 `doctor --all --use-api-key --use-provider-command --save` 或带模型覆盖的 `--model` 版本、openai-compatible / 中转站 fake probe 会把 `--model` 写入 Chat Completions body、强沙箱 ready 时列出 `doctor --sandbox --smoke --allow-shell --save`、强沙箱 fake readiness、`doctor --e2e`、`doctor --e2e --save` 和 `continue --run` 的只读 E2E readiness 恢复路径。
- `npm --prefix cli test` 覆盖 skill loader freshness:在临时 `skills/odai` 中改写 `SKILL.md` 后重新 `loadSkillPack()` 必须得到新文本和新 `entrySha256`;`runMockTask` 的 run record `skill.entrySha256` 必须等于当前 skill pack digest。
- canary harness 定向接线:`node scripts/odai-canary-harness.mjs --cases 5 --run --no-judge --runner-cmd "node /Users/orzi/Documents/works/orzi/odai/cli/bin/odai.mjs canary-runner --last-message {last_message}"`,结果为 `ran-unjudged`;runner log / last_message 包含 `runStatus: ready`、`mode: agent_loop`、`events: 1`、`recordPath`。
- runtime canary harness:`node scripts/odai-canary-harness.mjs --plan plans/odai-cli-runtime-canary.md --smoke --run --no-judge --runner-cmd "node /Users/orzi/Documents/works/orzi/odai/cli/bin/odai.mjs canary-runner --runtime-case {case_id} --last-message {last_message}"`,十八例 C01/C02/C03/C04/C05/C06/C07/C08/C09/C10/C11/C12/C13/C14/C15/C16/C17/C18 均为 `ran-unjudged`,fixture `diff files/status paths` 为 0。
- `./cli/bin/odai.mjs canary-runner --runtime-case 4`,输出 `runtimeCase: secret-read-denied`、`denials: 1`,证明 `.env` read intent 未读取内容即被授权门拦截。
- `./cli/bin/odai.mjs canary-runner --runtime-case 5`,输出 `runtimeCase: secret-write-denied`、`denials: 2`、`checkpoints: 0`,证明 `.env` write intent 被 policy gate 拒绝且不会生成 secret checkpoint。
- `./cli/bin/odai.mjs canary-runner --runtime-case 6`,输出 `runtimeCase: sensitive-intent-redaction`、`denials: 1`、`checkpoints: 0`,证明带 token 的 network tool intent 被拒绝且 run record/evidence/turn transcript/resume 不保留原始 token。
- `./cli/bin/odai.mjs canary-runner --runtime-case 7`,输出 `runtimeCase: stop-repeated-failure`、`denials: 3`、`checkpoints: 0`,证明同一写入目标重复失败后会触发 stop gate 而不是继续尝试写入。
- `./cli/bin/odai.mjs canary-runner --runtime-case 8`,输出 `runtimeCase: perception-write-denied`、`denials: 1`、`checkpoints: 0`,证明感知型写入缺少冻结验收证据时被 perception gate 拒绝。
- `./cli/bin/odai.mjs canary-runner --runtime-case 9`,输出 `runtimeCase: shell-intent-record-only`、`commands: 1`、`checkpoints: 0`,证明 shell intent 默认只记录为 skipped,不执行会写文件的命令,且 command 里的 token-like 参数会被脱敏。
- `./cli/bin/odai.mjs canary-runner --runtime-case 10`,输出 `runtimeCase: subagent-user-channel-denied`、`mode: subagent`、`denials: 2`,证明 subagent 返回 `ask-user` / `complete` 时不能占用用户通道或宣布完成。
- `./cli/bin/odai.mjs canary-runner --runtime-case 11`,输出 `runtimeCase: tool-intent-overflow-denied`、`denials: 1`,证明单轮 21 个 tool intent 会被整体拒绝并以 `tool_intent_limit_exceeded` 停止,不会执行部分 read intent。
- `./cli/bin/odai.mjs canary-runner --runtime-case 12`,输出 `runtimeCase: production-authorization-denied`、`denials: 1`、`commands: 0`,证明生产风险 shell intent 在显式授权前被 authorization gate 拒绝,并汇总 `requiredAuthorizations: ["risk:production"]`。
- `./cli/bin/odai.mjs canary-runner --runtime-case 13`,输出 `runtimeCase: model-output-redaction`,证明 provider 普通模型文本和 findings 中的 token-like 字段进入 agent turn / evidence / run record 前会脱敏。
- `./cli/bin/odai.mjs canary-runner --runtime-case 14`,输出 `runtimeCase: provider-error-redaction` 和 `runStatus: failed`,证明 provider 失败错误进入 run error / usage provider-call / evidence error event 前会脱敏并移除终端控制序列,且仍保留失败状态。
- `./cli/bin/odai.mjs canary-runner --runtime-case 15`,输出 `runtimeCase: provider-session-redaction`,证明 providerSession 白名单字段值进入 usage / evidence / agent turn / run record 前会脱敏,且正常非 secret session id 保留。
- `./cli/bin/odai.mjs canary-runner --runtime-case 16`,输出 `runtimeCase: provider-context-redaction`,证明恢复上下文里的 authorization scope、不可恢复确认 flag、transcript/run artifact 路径和 raw provider session id 不会进入 provider-visible output / run record。`npm --prefix cli test` 另覆盖 provider-visible input path 清洗:workspace 内绝对 `files` / `target` / `toolIntents[].path` / conversationContext 字符串、previous tool result path 和 subagent read tool result path 在交给 provider 前都会转成相对路径,且 JSON 中不含 workspace 绝对路径。
- `./cli/bin/odai.mjs canary-runner --runtime-case 17`,输出 `runtimeCase: task-persistence-redaction`,证明用户任务文本里的 token-like 片段不会进入 run record、resume argv 或 runner output。
- `./cli/bin/odai.mjs canary-runner --runtime-case 18`,输出 `runtimeCase: tool-intent-payload-denied`,证明单个超大模型 tool intent 在 dispatch 前被 policy gate 拒绝,不会写文件、创建 checkpoint 或把超大 content 持久化到 run data。

未完成:

- 交互 session 已可用真实 Codex CLI provider 路径跑通短任务并在等待中刷新 provider meter;主 agent loop 已有 mock 多轮 tool-intent 执行和运行中 provider/tool 事件输出;OpenAI / Anthropic fake SSE 和 Claude SDK fake stream 已覆盖事件管道,但尚未完成真实模型的多轮工具规划或真实 token 级 SSE/SDK streaming 验收。
- 已有 `odai doctor --provider <name>` 作为真实 provider 端到端验收入口;`command-json` provider 已用本机 Node 子进程完成真实 subprocess E2E。当前环境没有可用 OpenAI/Anthropic/Gemini 凭证、Claude CLI 或 Claude Agent SDK 包;本机可见 Codex/Grok CLI,其中 Codex CLI 已通过 `doctor --provider codex-cli --use-provider-command --save` 的真实 provider smoke 并写入 `.odai/runs` 外部证据;`node cli/bin/odai.mjs "用一句话回复 ping" --provider codex-cli --use-provider-command --model gpt-5.5` 在提升到本机权限后跑通,终端每秒输出 `thinking/activity ~N tok est` 并最终返回 `pong`;Grok CLI 因当前认证/外部服务状态未完成真实模型 E2E。当前 `.odai/providers.json` 中 `sub4api` 的 `/models` 可列出模型,但 chat probe 对多个模型均返回 403 `This account only allows Codex official clients`,不能作为通用 API provider evidence;`sub` 的 chat probe 失败 cause 为 `ECONNRESET`,TLS 建连前 socket 断开。
- Claude Agent SDK provider 已有动态 import adapter 和 fake SDK 测试,覆盖 SDK query 的隔离 cwd、env scrub、原生工具 deny、输出脱敏和显式确认门;当前本机未安装 `@anthropic-ai/claude-agent-sdk`,尚未完成真实 SDK 端到端调用。
- canary runner 默认仍可执行 mock runtime 并输出 evidence 摘要;显式 provider 时已可走同一 provider/runtime/tool gate 路径,并用本机 `command-json` 子进程完成 E2E;runtime canary 已覆盖 subagent-boundary / network policy / authorization / new-file checkpoint / credential read / credential write / sensitive intent redaction / stop / perception / shell record-only / subagent user-channel denial / tool-intent batch limit / tool-intent payload limit / model-output redaction / provider-error redaction / provider-session redaction / provider-context authorization redaction / task persistence redaction 十八条硬门。它仍不能替代真实 OpenAI/Claude/SDK 模型 canary 判定。
- shell runner 已有受控执行骨架、配置化项目级 allowlist、任务级 `--allow-shell` 二次确认和 sandbox adapter;macOS `sandbox-exec`、Docker sandbox 与 devcontainer sandbox 均有命令规划 / fail-closed 覆盖,并会探测 `sandbox-exec` profile apply 可用性。当前本机提升权限下 macOS `sandbox-exec` 已完成真实 strong sandbox smoke;普通受限宿主内仍会报告 `sandbox_apply` 不允许,Docker / devcontainer 仍未配置为可执行强沙箱。
- session continuation 已可恢复 mock 主流程形态、文件、provider/profile、agent-loop 和 subagent 编排,已有 deterministic compact context artifact,并会把交互式上一轮摘要传给下一轮 provider/subagent;provider session hints 已按同 provider 选择并作为 `resumeProviderSession` 下传,但尚未完成真实 provider 原生会话恢复调用、模型语义级上下文压缩或跨进程多轮模型状态验收。
- rollback 删除新建文件只在 `--delete-new-files` 明确开启时执行;已支持 record path selector、按文件过滤、按 checkpoint 过滤和确认后的可反向审计 run record;尚未支持图形化 checkpoint 选择或跨 run 的批量 rollback 计划。
