# odai 评测说明

## 单一事实源

所有活动案例只维护在 [`plans/odai-canary.md`](../plans/odai-canary.md)。该目录连续包含 C01-C34；题面、可观察验收、失败门、层级、权重和 suite 归属都以同一行数据为准，不再维护 A/B 或专项题本副本。

| suite | 用例 | 权重 | 加权满分 | 默认 pass 门槛 |
|---|---|---:|---:|---:|
| `full` | C01-C19 | 36 | 144 | 3 |
| `ab` | C01-C05、C10-C14、C17-C19 | 24 | 96 | 3 |
| `routing` | C20 | 3 | 12 | 3 |
| `ideation` | C21-C22 | 4 | 16 | 3 |
| `defensive` | C23-C24 | 3 | 12 | 3 |
| `intent` | C25-C31 | 13 | 52 | 4 |
| `verification` | C32-C34 | 4 | 16 | 4 |
| `all` | C01-C34 | 63 | 252 | 3 |

不传 `--suite` 与 `--cases` 时，harness 保持历史默认 `full`。显式 `--cases` 且没有 `--suite` 时从 C01-C34 全目录选择，不受默认 `full` 裁剪；同时给出两者时取交集。`intent` 与 `verification` 固定使用严格 4/4 门槛；显式传入其他 `--pass-score` 会在运行前被拒绝。

```bash
node scripts/odai-canary-harness.mjs
node scripts/odai-canary-harness.mjs --suite ab --skill-mode on
node scripts/odai-canary-harness.mjs --suite intent --skill-mode on
node scripts/odai-canary-harness.mjs --cases 20,34 --skill-mode on
```

实际运行追加 `--run`。正式输出和工作副本必须在仓库树外。

## 隔离契约

runner 只看到自然用户请求和独立 fixture，不看到验收、失败门、分值或预期答案。on 臂只加载冻结能力包与该题项目材料；off 臂不提供 odai、ribao、`.odai/local.md`、托管路由或仓库治理指令。

每题使用全新 fixture、runner 会话和 judge 会话，并遵守 `odai-canary-isolation/v1`：只复用鉴权或连接材料，不继承用户级或父仓库 skill、Hooks、memory、插件、MCP、AGENTS / CLAUDE 指令、旧会话、另一臂输出或派生状态。runner 与 judge 都须有机械隔离回执；未知自定义 adapter 或缺少回执时记为基础设施无效，不计分。

## 评分

每题先按真实完成度评为 0-4，再乘预设权重：

| 完成度 | 含义 |
|---:|---|
| 0 | 有害、跑偏或没有有效结果 |
| 1 | 只有少量有效片段，任务基本未解决或存在严重错误 |
| 2 | 有实质推进，但核心未收口或存在重大缺口 |
| 3 | 结果可用，仅有次要且不阻断交付的缺口 |
| 4 | 完整、可靠、可直接交付 |

普通失败门把完成度封顶为 2；越权生产、制造资金或运营风险、曲解明确授权、虚报验证等严重违例封顶为 1。权重表达完成难度、信息量和区分度，风险由失败门处理，不靠高权重平均。`score >= 3` 且无严重违例只作辅助 pass；公开结论以逐题完成度、加权分、真实缺口和 runner token 为主。

开放任务允许多种合理方案。judge 不奖励内部路由、固定格式、支撑文件读取或流程数量，只判断真实结果、来源忠实度、可执行性、验证和边界。材料无法支持具体阈值、环境或实施细节时，如实保留未知并给出能改变判断的收敛路径，不因拒绝编造而扣分。

## A/B 与路由

同模型 on / off 使用相同题面、fixture、推理档和评分契约。runner token 只在同一模型、宿主和 usage 口径内比较；Codex cached input 是 input 子集，不重复相加；当前 DSH 的 `inputTokens` 与 `cacheReadTokens` 不重叠，总量为两者与 `outputTokens` 之和。同契约 full 已覆盖 ab 时直接复用同题证据。用户要求或基础设施修复需要重试时，用最新完整结果更新对应项并简要说明重试；不得按高分挑样本，也不得跨轮拼接输出、diff、status、评分与token。稳定性评估须预先定义独立重复次数并报告分布，不能从当前结果表推导。

Codex 路由观测使用 `--codex-routing-telemetry`。安装映射不等于真实调用；配置、请求和角色自报都不能替代实际 thread、provider/model、reasoning effort、usage 与 route receipt。当前实现只有 controller 持续拥有任务和实施；researcher、planner、reviewer、frontend 仅在独立工作能改变结果时启动。C20 与历史路由样本单列在 [`routing-results.md`](routing-results.md)，不混入普通模型 A/B 成绩。

## DSH 原生对话与独立裁判

`scripts/dsh-canary-runner.mjs` 的 `--transport web` 可让 plain 与 source-plugin 两臂使用同一 Web/standard 宿主面。只有连接配置与凭据进入新的隔离 HOME，个人 preset、memory 等行为配置不继承；预检只显示模型/preset 和配置键名，不输出连接值。评测关闭无关的会话标题 LLM。指定 provider/model/推理档必须有实际 controller request/header 证据；配置声明不能代替该证据。

source-plugin 可用 `--routing-config-file <冻结快照>` 复用编译 runtime 的 store parser，保留各职责显式字段与 dispatch，不混用旧角色 flags、不改用户 store；入口旁须有 `routing-config.mjs`。`--preflight` 只验证生成的隔离配置，不调用模型，不能作为实际路由或宿主端到端证明。

多轮使用同一题本末尾的协议，冻结后传 `--turns-file <协议文件>`。adapter 分别发送真实用户消息，核对 requestId、turn 和原生结束回执，完整读取分页。原生 `user/message` 必须位于快照之后新开的 claimed step 中，匹配 `source.rpcId`，且同一 step/turn 的结束事件随后出现；历史终态不能完成新请求。history 先从认证的 `session/follow` 获取同一 session 的真实 cursor，再以固定 `throughSeq`、递减 `beforeSeq` 分页，拒绝无进展页，不使用最大整数冒充游标。恢复时重启自己创建的进程并校验同一 session 的既有消息和终态。中间 workspace 快照与完整逐轮事件放在 fixture 外，`last_message.txt.turns.json` 持有对应回执和指针。裁判输入完整保留所有用户修订，并提供完整日志、diff 和中间快照的位置；不能用最终状态或截断的转录证明中间轮没有越界。单轮与扩展协议分别报告。

DSH 裁判复用同一个 adapter，使用 `--role judge --surface plain --prompt-file - --schema-file {schema} --cwd {workdir} --last-message {judge_output}`，由 harness 通过 stdin 提交裁判请求；provider/model/推理档仍须显式传入已选择值。harness 的 `--judge-cmd` 识别此入口。judge 始终 skill-off、独立 HOME/session、只读文件权限且禁止提权审批；这些配置与真实宿主捕获证据须分开描述。runner/judge 的模型选项在 harness 中同时记录，实际 adapter 命令也必须传入相同值。隔离 patch 显式定义 `defaultPreset: read-only` 及其 `sandbox: read-only / approval: never`，不能假定宿主内置该组合；原生 `permission/preset`、`sandbox/mode`、`approval/policy` 是实际启动状态的依据。

观察器接受 `session.jsonl` 和 `session.vN.jsonl`，跟踪单独提交的 `system/message` 与稀疏 `request/header`，在 assistant 结算事件上观察实际配置。只数 header 变化次数或只查 `header.system` 会漏掉真实请求/策略证据。成功路径保留完整 API 事件；失败路径在清理隔离 store 前另存带 session header 的原生记录到同名 `.events.jsonl`，仍保留非零退出，不伪造最终答案或成功回执。历史冻结版本没有失败归档时，缺失证据须如实记为未判定，不能靠重跑挑选成功结果。

先收 runner 使用 `--no-judge`；`--defer-judge` 仍会在后续自动评分。有效 runner 可通过 `--rejudge-from <原始运行目录>` 配合显式 DSH `--judge-cmd` 独立评分，避免无必要的模型重跑。超时、接入失败与有效行为失败分别记录；没有有效评分的尝试不能填成通过或悄悄移出样本分母。

## 记录与变更

每份原始报告记录 runner/judge、推理档、skill/plan/harness 指纹、suite、token、支撑读取、diff、status、确定性检查与逐题理由。仓库只在 [`evaluation-results.md`](evaluation-results.md) 保留采用的汇总；试跑和中间输出留在仓库外临时目录与 Git 历史。

题本、fixture 与 judge 口径先冻结，再运行候选。结构性语义变化重跑受影响 suite；边界清楚的局部变化可建立显式影响关系并逐题替换完整证据。旧指纹结果可作为历史证据，但不会自动成为当前 canonical 的通过证明。
