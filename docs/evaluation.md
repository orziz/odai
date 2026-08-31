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

同模型 on / off 使用相同题面、fixture、推理档和评分契约。runner token 只在同一模型、宿主和 usage 口径内比较；cached input 是 input 子集，不重复相加。完整 `full` 运行若在相同契约下覆盖 `ab`，可抽取同一轮完整证据，不重复运行 runner，也不得跨轮拼接输出、diff、status、评分或 token。

Codex 路由观测使用 `--codex-routing-telemetry`。安装映射不等于真实调用；配置、请求和角色自报都不能替代实际 thread、provider/model、reasoning effort、usage 与 route receipt。当前实现只有 controller 持续拥有任务和实施；researcher、planner、reviewer、frontend 仅在独立工作能改变结果时启动。C20 与历史路由样本单列在 [`routing-results.md`](routing-results.md)，不混入普通模型 A/B 成绩。

## 记录与变更

每份原始报告记录 runner/judge、推理档、skill/plan/harness 指纹、suite、token、支撑读取、diff、status、确定性检查与逐题理由。仓库只在 [`evaluation-results.md`](evaluation-results.md) 保留采用的汇总；试跑和中间输出留在仓库外临时目录与 Git 历史。

题本、fixture 与 judge 口径先冻结，再运行候选。结构性语义变化重跑受影响 suite；边界清楚的局部变化可建立显式影响关系并逐题替换完整证据。旧指纹结果可作为历史证据，但不会自动成为当前 canonical 的通过证明。
