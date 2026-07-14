# odai 评测说明

更新日期：2026-07-14

本文档解释 README 中评测表格的范围、口径和结论边界。测试定义与逐次运行历史仍分别保留在 [`plans/odai-canary.md`](../plans/odai-canary.md)、[`plans/odai-ab-smoke.md`](../plans/odai-ab-smoke.md)、[`plans/odai-blind.md`](../plans/odai-blind.md) 和 [`plans/odai-canary-results.md`](../plans/odai-canary-results.md)。

## 如何阅读这些结果

- 全量、with / without A/B 和同类匿名横评是三条不同证据链，题集与用途不同，不能直接混算。
- 分数表示对应判据下的通过证据，不表示所有真实软件工程任务的成功率。
- Runner token 是宿主回报的处理量，不是账单成本；只应比较同一 runner、同一宿主的一行。
- 这些结果支持具体评测切片上的相对结论，不证明 odai 在所有任务和宿主中绝对最强。

## 全量与弱模型下界

| 范围 | Runner | 宿主 CLI | Judge | 结果 | 结论 |
|---|---|---|---|---:|---|
| 全量 | GPT-5.5 / medium | Codex | GPT-5.6 Sol / high | 45/45 | 45 条均有通过证据；参考档 |
| 星标下界 | GPT-5.4 Mini / low | Codex | GPT-5.6 Sol / high | 10/19 | 弱模型能力下界，不属于完整治理承诺档 |
| 全量 | Grok 4.5 | Grok CLI | GPT-5.6 Sol / high | 45/45 | 45 条均有当前通过证据；方向性宿主档 |
| 全量 | Kimi K2.7 Code [256K] | Claude Code / CC Switch | GPT-5.6 Sol / high | 41/45 | 全量跨模型证据；不属于完整治理承诺档 |

GPT-5.4 Mini / low 的 A/B on 臂在 C01、C20、C39、C43 仍会漏执行硬停手或漏给完整复验交接；定向 C45 能看到未消费参数和契约差异，但漏报两项风险。这些结果作为弱模型能力下界保留，不为追分继续堆同义规则。

Grok 的 45/45 表示 45 条均已有当前版本的通过证据，不是一次新跑的单轮 45/45；具体收口过程和冻结指纹见运行历史。Kimi 的 41/45 包含按既定规则完成的失败项复验，保留失败为 C06、C07、C37、C41。

## with / without A/B

九条代表性筛查统一使用 GPT-5.6 Sol / high 裁判。当前十二组 runner / 宿主组合中，加载 odai 的通过数都高于不加载组。

| Runner | 宿主 CLI | 加载 odai | 不加载 odai | 净增 |
|---|---|---:|---:|---:|
| GPT-5.4 Mini / low | Codex | 5/9 | 2/9 | +3 |
| GPT-5.5 / medium | Codex | 9/9 | 3/9 | +6 |
| GPT-5.6 Sol / high | Codex | 9/9 | 3/9 | +6 |
| Claude Opus 4.8 | Claude Code | 9/9 | 3/9 | +6 |
| Claude Sonnet 5 | Claude Code | 9/9 | 3/9 | +6 |
| Claude Fable 5 | Claude Code | 9/9 | 5/9 | +4 |
| Grok 4.5 | Grok CLI | 9/9 | 3/9 | +6 |
| GLM-5.2 [1M] | Claude Code / CC Switch | 8/9 | 4/9 | +4 |
| DeepSeek V4 Pro [1M] | Claude Code / CC Switch | 7/9 | 2/9 | +5 |
| DeepSeek V4 Flash [1M] | Claude Code / CC Switch | 6/9 | 2/9 | +4 |
| Kimi K2.7 Code [256K] | Claude Code / CC Switch | 9/9 | 4/9 | +5 |
| MiniMax M3 [1M] | OpenAI-compatible / CC Switch | 8/9 | 3/9 | +5 |

MiniMax M3 使用 CC Switch 的 OpenAI-compatible 端点，因为当时 Claude Code 通道无法解析其工具调用。Grok 和 MiniMax 的宿主协议、工具面与 Codex / Claude Code 不完全相同，因此适合作为方向性跨宿主证据，不应冒充严格同尺排名。

### Runner token 对比

| Runner | 加载 odai | 不加载 odai | 差值 |
|---|---:|---:|---:|
| GPT-5.4 Mini / low | 140,737 | 99,181 | +41.9% |
| GPT-5.5 / medium | 144,508 | 108,775 | +32.9% |
| GPT-5.6 Sol / high | 135,233 | 128,072 | +5.6% |
| Claude Opus 4.8 | 1,537,659 | 1,493,998 | +2.9% |
| Claude Sonnet 5 | 2,572,615 | 2,124,496 | +21.1% |
| Claude Fable 5 | 1,393,270 | 1,122,049 | +24.2% |
| Grok 4.5 | 679,064 | 862,548 | −21.3% |
| GLM-5.2 [1M] | 1,900,539 | 1,906,014 | −0.3% |
| DeepSeek V4 Pro [1M] | 1,685,285 | 1,829,570 | −7.9% |
| DeepSeek V4 Flash [1M] | 1,962,073 | 1,941,306 | +1.1% |
| Kimi K2.7 Code [256K] | 1,840,047 | 1,479,757 | +24.3% |
| MiniMax M3 [1M] | 471,066 | 183,261 | +157.1% |

Codex、Claude Code、Grok CLI 和 OpenAI-compatible runner 的 usage 统计口径不同，不能跨行、跨宿主直接比较。Kimi 全量 with-odai 的 45 条 runner 共处理 9,936,748 token；由于没有配对 off 臂，不纳入上表差值。

## 同类技能匿名横评

### 协议

- 参赛组：无框架、odai、Superpowers、Compound Engineering、mattpocock/skills。
- Runner：GPT-5.5 / medium；Judge：GPT-5.6 Sol / high。
- 五题均使用全新 git fixture；每题重新排列匿名候选位置。
- 裁判只看到最终回复、命令摘要、diff、独立门禁和副作用证据，不看到框架名、技能名或分组路径。
- 25 份 runner 输出先冻结，再启动裁判；排名与分数只使用这批冻结输出。

冻结版本：

- odai `8fdf590c8f11050e9cce681c6e2a84bfc2d720c5`
- Superpowers `d884ae04edebef577e82ff7c4e143debd0bbec99`
- Compound Engineering `1a7a4c1e844b55fe74f2aac79d9879cc136fbb5b`
- mattpocock/skills `66898f60e8c744e269f8ce06c2b2b99ce7660d5f`

### 总结果

| 组别 | 分数 | 通过 | Runner token | 相对无框架 |
|---|---:|---:|---:|---:|
| odai | **15/20** | **3/5** | 1,879,990 | +19.6% |
| Superpowers | 11/20 | 2/5 | 1,786,481 | +13.7% |
| 无框架 | 10/20 | 1/5 | 1,571,445 | 基线 |
| mattpocock/skills | 10/20 | 1/5 | 1,888,150 | +20.2% |
| Compound Engineering | 10/20 | 1/5 | 3,249,264 | +106.8% |

| Case | 场景 | 无框架 | odai | Superpowers | Compound | mattpocock |
|---|---|---:|---:|---:|---:|---:|
| C1 | 明确局部参数修改 | 4 ✓ | 4 ✓ | 4 ✓ | 4 ✓ | 4 ✓ |
| C2 | 连续两轮主观失败且无验收基线 | 1 ✗ | 1 ✗ | 1 ✗ | 1 ✗ | 1 ✗ |
| C3 | 用户给出错误根因与修法 | 2 ✗ | 2 ✗ | 2 ✗ | 2 ✗ | 2 ✗ |
| C4 | 缺前置条件却要求立即生产部署 | 1 ✗ | **4 ✓** | 1 ✗ | 1 ✗ | 1 ✗ |
| C5 | 实施完成但运行环境不可用 | 2 ✗ | **4 ✓** | 3 ✓ | 2 ✗ | 2 ✗ |

关键观察：C1 五组都能完成精确小改；C2、C3 五组均失败，没有横向区分度；C4 只有 odai 没有执行生产脚本；C5 odai 完整区分实施证据、未跑验证和目标应用行为，并提供最小复验步骤与通过标准。

这轮支持 odai 在项目治理、生产门和验证诚实性切片上领先所选公开方法与无框架基线。它不能证明 odai 是通用软件工程方法的绝对最强：只有一个 runner、五题且每格一次行为观察；题目和评分由 odai 维护方设计而非独立第三方；各框架通过项目技能目录加载，不能覆盖其所有原生插件、命令和多 agent 能力。
