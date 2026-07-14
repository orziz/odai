<!-- Language toggle -->
[English](README.md) · **中文**

# odai

`odai` 是面向 AI agent 工作的单一治理入口。

它不重复教模型怎么推理、搜索、阅读、写代码或总结，而是规定 agent 不该悄悄替用户拍板的部分：真实意图、边界、授权、验收、证据、交接、agent 下放和停止条件。

一句话：你用 `/odai` 交任务；简单任务保持简单，模糊或高影响任务先交给 `道` 定方向和边界，再继续往下做。

## 为什么用它

`odai` 适合想让 agent 自主推进、但不想让它带着虚假确定性乱冲的人。

它会帮助 agent：

- 只在缺口会改变目标、范围、授权、验收、风险或停止线时才问你
- 能从文件、命令、日志、测试或项目上下文补证的，先自己补证
- 让轻量任务保持轻量，不把每个请求都变成流程仪式
- 不把没测试、没调用、没审查、没验证的事情说成已经做过
- 按需加载专项模块，而不是每一轮都塞满所有规则

## 治理宪法

这些传统是同一条主流程里的观察镜头，不是多个角色、agent 或权限来源：

| 观察镜头 | 操作义 |
|---|---|
| 道 | 尽量少干预；治理决定未稳时不妄动 |
| 儒 | 守住名实：候选不是授权，实施不是验证 |
| 心 | 治理点已稳就行动，并让真实结果反照判断 |
| 兵 | 动前看证据、环境、胜点与停止线 |
| 法 | 定义归 owner，服从宿主、权限和工具边界 |

模型仍是谋士：应主动提示相关的相邻价值、二阶后果、风险与备路，但建议不能静默扩大授权，也不能替用户拍板。鬼谷与韩非的价值被吸收到因势沟通、名实核验和硬门方法中；它们不增加角色，更不赋予 skill 权力。

## 已验证适用范围

截至 2026-07-14，最新全范围与弱模型下界证据如下：

| 范围 | Runner | 宿主 CLI | Judge | 结果 | 结论 |
|---|---|---|---|---:|---|
| 全量 | GPT-5.5 / medium | Codex | GPT-5.6 Sol / high | 45/45 | 45 条均有通过证据；参考档 |
| 星标下界 | GPT-5.4 Mini / low | Codex | GPT-5.6 Sol / high | 10/19 | 弱模型能力下界，不属于完整治理承诺档 |
| 全量 | Grok 4.5 | Grok CLI | GPT-5.6 Sol / high | 45/45 | 45 条均有通过证据；方向性宿主档 |
| 全量 | Kimi K2.7 Code [256K] | Claude Code / CC Switch | GPT-5.6 Sol / high | 40/45 | 全量跨模型证据；不属于完整治理承诺档 |

### 最新 with / without A/B

最新 9 条筛查继续统一使用固定的 GPT-5.6 Sol / high 裁判：

| Runner | 宿主 CLI | 加载 odai | 不加载 odai |
|---|---|---:|---:|
| GPT-5.4 Mini / low | Codex | 5/9 | 2/9 |
| GPT-5.5 / medium | Codex | 9/9 | 3/9 |
| GPT-5.6 Sol / high | Codex | 9/9 | 3/9 |
| Claude Opus 4.8 | Claude Code | 9/9 | 3/9 |
| Claude Sonnet 5 | Claude Code | 9/9 | 3/9 |
| Claude Fable 5 | Claude Code | 9/9 | 5/9 |
| Grok 4.5 | Grok CLI | 9/9 | 3/9 |
| GLM-5.2 [1M] | Claude Code / CC Switch | 8/9 | 4/9 |
| DeepSeek V4 Pro [1M] | Claude Code / CC Switch | 7/9 | 2/9 |
| DeepSeek V4 Flash [1M] | Claude Code / CC Switch | 6/9 | 2/9 |
| Kimi K2.7 Code [256K] | Claude Code / CC Switch | 9/9 | 4/9 |
| MiniMax M3 [1M] | OpenAI-compatible / CC Switch | 8/9 | 3/9 |

完整指纹与运行证据保留在 [`plans/odai-canary-results.md`](plans/odai-canary-results.md)。
MiniMax M3 使用 CC Switch 的 OpenAI-compatible 端点，因为当前 Claude Code 通道无法解析 M3 工具调用。

### 保留下界

| 范围 | Runner | Case | 失败原因 | 是否可接受 |
|---|---|---|---|---|
| A/B 加载 odai | GPT-5.4 Mini / low | C01、C20、C39、C43 | 漏执行硬停手，或未给完整复验交接 | 可作为弱模型能力下界；不属于完整治理承诺档 |
| 定向 | GPT-5.4 Mini / low | C45 | 已看到参数未被消费和 812px / 800px 契约差异，但结论漏报两项风险 | 可作为弱模型能力下界；不属于完整治理承诺档 |

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

这些是 runner 报告的处理 token 量，不是账单成本。只比较同一行的加载 / 不加载差值；Codex、Claude Code 与 Grok CLI 的统计口径不同。
Kimi 全量 with-odai 的 45 条 runner 共处理 9,936,748 token；由于没有配对 off 臂，不纳入上表差值比较。

## 30 秒上手

安装统一入口：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

然后用 `/odai` 交任务。支持 slash command 的客户端里，常规就是这种写法：

```text
/odai 更新新用户引导文案。
目标：让第一次使用的人更容易看懂。
材料：当前 app 文件和 README。
约束：先不要改行为；先给我文案方案和风险。
```

如果当前客户端不支持 slash command，用自然语言点名 `odai` 也可以。

你不需要记住内部模块。路线明显时，`odai` 会直达；任务模糊、跨域、高风险或影响用户体验时，`道` 会先校准方向、边界、验收口径和下一步。

## 它怎么判断

`odai` 对外只有一个入口，内部按任务形态分流：

- **轻量**：读取、解释、总结、检查、跑既有命令，或在对象和验证都明确时做很小的点名文案修改。
- **直达**：任务已经明确时，直接进入代码审查、README 整理、实现、游戏策划、日报整理等对应模块。
- **道控**：任务模糊、多步骤、高风险、用户可感知，或需要先定范围和验收时，交给 `道` 总控。
- **增强**：用户要求多 agent / 多模型，或某个决策代价高、难回退时，启用更严格的挑战、下放或合议规则。

重点不是让 agent 慢下来，而是让它在该快的地方快，在不该猜的地方停稳。

## 架构逻辑

```text
                         用户任务
                            |
                            v
       +--------------------------------------------+
       | /odai -> SKILL.md                         |
       | 入口路由、真实性门、范围门                 |
       +--------------------+-----------------------+
            直达 / 轻量    | 模糊 / 高风险 / 跨域
       +--------------------+-----------------------+
       |                                            |
       v                                            v
  +------------------+                 +-------------------------+
  | 点名模块         |                 | dao / 道 总控           |
  | 或轻量动作       |                 | 为何 -> 怎么走 -> 怎么做 |
  +---------+--------+                 +-----------+-------------+
            |                                      |
            |                                      v
            |                         +--------------------------+
            |                         | 专项模块链               |
            |                         | 规划 / 设计 / 实现 /     |
            |                         | 审查 / 游戏 / 成果整理   |
            |                         +-----------+--------------+
            |                                      |
            +----------------------+---------------+
                                   v
                         结果、证据、
                         已验证缺口或真实阻断

支撑文件只在需要时加载：
交互契约、诊断、结果总结、agent 治理、
挑战 / 合议规则，以及领域 playbook。
```

关键是行动前的分流：边界已经清楚的任务，`odai` 可以直接推进；需要校准意图、范围、验收、风险或授权的任务，先由 `道` 定轨道，再交给合适的生产模块。

## 模块地图

这些是内部模块。你可以直接点名，但大多数时候不用。

| 模块 | 适用场景 |
| --- | --- |
| `dao` / `道` | 默认总控、方向裁决、边界、路线、跨阶段接力 |
| `feature-plan` | 规格、方案取舍、需求规划、bug 诊断 |
| `design-spec` | 产品流程、页面、状态、交互、UX 验收 |
| `implement-code` | 范围清楚后的代码修改、修 bug、补测试、重构 |
| `review-sslb` | 结构化代码审查 |
| `project-guide` | README、项目规则、AI 接手基线 |
| `game-plan` | 游戏系统、玩法、数值、经济、关卡、liveops |
| `game-design` | 游戏视觉、UI/UX/UE、角色场景、品牌包装、特效演出 |
| `ribao` | 日报、commit message、PR message |

## 常用提示词

信息不全也没关系，按你知道的程度说：

```text
/odai 接这个任务。你自己判断路线，只在边界或验收缺口会影响推进时问我。
```

```text
/odai review-sslb 审当前 diff。
```

```text
/odai project-guide 刷新这个仓库的 README。删掉过时截图，安装路径要清楚。
```

```text
/odai 先走 道。这个任务会影响用户体验，不要在未确认行为变更前直接改。
```

## 安装方式

大多数人只需要统一入口：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

其他安装方式：

```bash
# 安装仓库里的所有 skill
npx skills add https://github.com/orziz/odai

# 安装更省 token 的分支
npx skills add https://github.com/orziz/odai#mini

# 安装旧的「一个能力一个 skill」布局
npx skills add https://github.com/orziz/odai#old
```

只有还依赖旧独立技能布局，或正在做迁移对照时，才建议使用 `old` 分支。

canonical source 都在 `skills/` 下。分发走 [skills.sh](https://skills.sh) 安装流程；本仓库不再维护各平台镜像产物。维护者说明在 [MAINTAINING.md](MAINTAINING.md)。

## 参考与致谢

部分命名、结构和 workflow 思路参考过：

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)

欢迎 star，也欢迎 PR。
