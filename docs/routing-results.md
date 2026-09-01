# odai DSH 能力路由报告

更新时间：2026-08-31

本报告只记录 DeepSeek Harness（DSH）能力路由的产品契约、机械验证和冻结对照。普通单模型全量与 A/B 结果见 [`evaluation-results.md`](evaluation-results.md)。单次路由样本用于证明真实换模、边界、质量和资源足迹，不用于宣称路由稳定优于单一充分能力总控。

> 当前未发布候选为 canonical `0.3.7` / runtime contract `6` / DSH `0.2.16`：controller 是唯一持续任务线程并拥有实施；可选责任只有 researcher、planner、reviewer、frontend。manifest schema 2 是角色/reference owner 拓扑，DSH 由 controller-only reference bridge 按当前 turn snapshot 读取 canonical references。独立 Executor、route card 与 Codex stage runner 已退役。下文含 Executor 或 stage 的数值全部是退役历史证据，保留用于解释删除决定，不是当前能力或配置说明。

## 当前候选契约

### 默认行为

- Plugin 与 Agent 都默认使用 `auto`，但不内置 researcher、planner、reviewer 或 frontend 的 provider、model、reasoning effort、maxTokens。
- controller 是 DSH 当前 session/profile 选择的持续任务线程，不是固定模型，也不由 Odai 的责任映射工具改写。
- 普通请求由 controller 直接闭环。风险、任务规模、角色词、泛泛调查或低价模型本身不会增加模型调用。
- Researcher 只在“未验证因果判断 + 具体高影响修改”形成多源决定阻断，且用户已显式配置该责任时启动一个只读 child；packet 通过来源验证后仍由 planner/controller 决定。
- 完整的高影响判断缺口在 planner 映射存在时升级同一 controller turn，不启动 child；明确要求独立规划或复核时，独立性本身是能力要求，因此使用 child。
- 实施始终由 controller 承担；planner 回交有界计划后，只有当前用户任务已授权实施时才由 controller 继续。
- frontend 只为完整界面设计或制作缺口在同一 turn 使用显式映射；窄样式或文案修复保持 direct。

### 用户配置

用户只需自然指定责任与模型，例如：

```text
证据调查用 provider-r/model-research，推理档 high。
规划用 provider-x/model-plan，推理档 high。
验收用 provider-z/model-review。
前端制作用 provider-f/model-frontend，输出上限 4096。
```

controller 调用 `odai_routing_config` 完成 `show`、`set` 或 `remove`。映射写入 `$DSH_HOME/odai/routing.json`，由 Plugin 与 Agent 共用，从下一轮用户请求生效。用户不编辑 YAML、JSON、Plugin patch 或 Agent preset，模型也不得代替用户选择 provider、model、推理档、token 上限或价格。

Researcher 的运行时触发只判断任务是否匹配，不感知 provider 价格。配置工具在 researcher 已映射时持续提示：映射只是显式启用窄触发，不保证降低费用，经济判断必须使用权威价格和实际 usage；包不内置价表、价差阈值或模型白名单。

未使用的未配置责任不产生启动提示。可选 researcher/frontend 未映射时直接保持原路径，不宣称调用成功；真实 gap 需要 planner 或 reviewer 而该项未配置时，runtime 记录 `odai/route-config-missing`，明确没有调用该模型，也不产生虚假的 `odai/route-upgrade` 或 `odai/route-result`。高影响 planner、reviewer 缺口同轮只读；低影响工作只能继续完成不依赖该独立责任的部分。

损坏的用户 routing store 不会阻止 canonical prompt、child guard 或配置工具加载。需要路由时该 store 被视为不可信并 fail-closed；用户下一次自然指定映射后，工具保留损坏副本并重建有效 store。共享 store 的 set/remove 使用跨进程锁和原子替换，避免 Plugin 与 Agent 并发更新丢失。

### 模式

| 模式 | 模型行为 | 高影响保护 |
|---|---|---|
| `off` | 不做任务路由；保留治理、child boundary 和用户请求的配置工具 | 不读取旧 route protection |
| `observe` | 本地判断并注入证据协议；不换模型、不启动 child | 未解决的高影响 gap 同轮只读 |
| `auto`（默认） | 普通请求 direct；配置后的上下文判断缺口同 turn upgrade；明确独立 gap 使用 child | 缺失、失败或不可信 route 同轮只读 |
| `execute` | 非 direct gap 统一交给已配置的 child route | 同上 |

### 真实路由证据

- 同 turn upgrade：只认 controller session 的 durable `request/header`；`odai/route-upgrade.requestedRoute` 只表示选择意图。
- child delegation：runtime 核对 child durable header 中的 provider、model 和 reasoning effort；不符、缺失、异常停止、空文本或 cleanup 失败都不注入为可信证据。
- researcher packet：runtime 另行核对来源数量、项目根 realpath、symlink、文件类型与大小、正数行号范围、逐字摘录和 SHA-256 digest；packet 只作为检索索引，不能替代原始来源、规划或批准。
- Plugin 与 Agent 同时存在时，prompt 按 scope shadow，route/tool event 按 durable identity 去重，权限拒绝保持单调。两者通常不需要同时安装。

## 当前候选机械验证

| 验证面 | 结果 | 证明范围 |
|---|---:|---|
| DSH strict typecheck | 通过 | runtime、Plugin、Agent、release source 与测试类型闭合 |
| Plugin/runtime tests | 214/214 | controller-owned implementation、四项可选责任、manifest owner 拓扑、reference snapshot、配置迁移、证据、memory、skill source 与 fail-closed |
| Agent installer tests | 14/14 | 安装、更新、历史会话保留、漂移保护、双 DSH 版本与卸载 |
| canonical validator | 通过 | 28 个 Odai 文件、2 个 ribao 文件、0 warnings、runtime contract 6 |
| 三宿主路由 lifecycle | 通过 | controller/planner/reviewer、可选 researcher/frontend、退役 Executor/stage 文件清理与旧参数拒绝 |
| canary harness tests | 4/4 | 默认 full、A/B、严格 suite、显式跨 suite cases 与旧无 suite plan 兼容 |
| 本机 DSH rc.2 source probes | 通过 | official session compatibility、Plugin load、Agent preset roster/scope/route protection、Plugin/Agent coexistence 与同轮 skill snapshot |
| Plugin/Agent pack dry-run | 通过 | Plugin 192 文件、Agent 201 文件；临时 bundled source 与 tgz 均已清理 |
| 双版本 installed-artifact release matrix | 通过 | 真实 Plugin/Agent tgz 在 DSH rc.2 与 alpha.2 隔离安装；分别为 188 / 215 包纯依赖图，Standard digest、official session compatibility、Plugin load 与 Agent scope/child guard 均通过 |

这组验证证明当前源码、迁移和打包机制，不替代付费模型质量样本。当前 `0.3.7` 的普通 canonical intent/C04 定向结果见 [`evaluation-results.md`](evaluation-results.md)，但尚无新的 DSH 计分路由运行；下面样本按各自旧指纹保留。

## 退役与历史质量/成本证据

以下样本按当时的 canonical、runtime 与映射事实保留。Researcher、planner、reviewer、frontend 的历史数据仍可用于比较；涉及独立 Executor、route card 或 stage 的样本只作为退役依据，不支持恢复或配置这些机制。

### C04 researcher 证据压缩

同一 canonical C04 使用原生 DSH source-plugin 路径，现有 4 份独立正式 researcher 样本。新增 3 轮都使用全新 fixture、runner session 和独立 Sol/high judge；Researcher 实际 child route 为 OpenAI Luna/xhigh/`maxTokens: 500`，后续 controller route 为 OpenAI Sol/xhigh/`maxTokens: 500`。4 轮 packet 都从 3 个文件取得逐字来源，digest 分别为 `74a19c49820f3b24e11b42db73b03ba34b4683bab4ef7602a67cce7b14295283`、`da0565669459ffb9fac6a232087588c8fd6eac935a54512e5e82cb61c4d62d12`、`3ec54f18f6d2d980298ba7c34c409b5daa64a4ff3beb5b1e1ee23e477f21068a`、`71c3c435208e935e9ae92b94be22b3118c2c4d21c831966449f05e551f5f1898`。C01 与 C05 的负向样本均跳过 researcher，说明普通直接查询与复杂性本身不会触发。

按 [OpenAI Standard short-context 价格](https://developers.openai.com/api/docs/pricing)计算：Sol 每百万 input/cached/output 为 `$5.00/$0.50/$30.00`，Luna 为 `$0.20/$0.02/$1.20`。下表费用只使用 runner 的实际 provider usage，不使用请求 ceiling 估算；新增 3 轮 judge 只报告 CLI 可见总 token，不把缺少 input/cached/output 分项的值冒充账单。

| 样本 | 实际责任与模型 | 分数 | input / cached / output | 墙钟 | runner 实际 usage 成本 | 独立 judge token |
|---|---|---:|---:|---:|---:|---:|
| 纯 Sol 基线 | Sol controller | **4/4** | 24,030 / 101,376 / 2,289 | 未记录 | `$0.239508` | 未记录 |
| Researcher 初始样本 | Luna researcher + Sol controller | **4/4** | 43,101 / 119,296 / 3,910 | 约 87.6s | `$0.154871` | 未记录 |
| Researcher 复跑 1 | Luna researcher + Sol controller | **4/4** | 41,895 / 68,608 / 4,445 | 约 98.5s | `$0.183011` | 27,458 |
| Researcher 复跑 2 | Luna researcher + Sol controller | **4/4** | 44,962 / 155,136 / 3,314 | 约 86.0s | `$0.203505` | 27,467 |
| Researcher 复跑 3 | Luna researcher + Sol controller | **4/4** | 55,841 / 65,536 / 3,880 | 约 88.2s | `$0.224032` | 27,700 |

3 次复跑均通过 `odai-canary-isolation/v1` 的 runner/judge 双隔离，机械确认恰好一个 Luna child、Sol controller 实际 route header、3 源 packet、只读 `diff/status=0`，独立裁判均为高置信 `4/4` 且无严重违例。4 份 researcher 样本合计 usage 为 185,799 / 408,576 / 15,549，平均墙钟约 90.1s，runner 成本合计 `$0.765420`、均值 `$0.191355`；相对单份纯 Sol 基线，观察到的单轮降幅为 `6.46%–35.34%`，均值低 `20.11%`。但纯 Sol 基线仍只有一份，固定 C04 的 `n=4` 只支持 researcher 路由与质量稳定性，不建立通用或统计稳定的降本结论。新增 judge 合计报告 82,625 token，但 Codex CLI 未提供其 input/cached/output 分项，因此不能精确核算 judge 账单。

Researcher 增加总处理 token 与一次顺序 child 延迟；现金成本只因这些样本中 Luna 三类单价均为 Sol 的 4% 而降低。4 轮 provider 都实际超过了请求的 `500` ceiling，因此不宣称固定降幅、固定延迟或硬 token 上限。

### C08 frontend 同 turn 升级

C08 要求基于现有运维台材料形成可直接交给设计和前端的改版说明、禁止修改代码。冻结样本使用用户显式映射的 K3/max/`maxTokens: 4096`，durable request header 与任务注入都证明当前 controller turn 已升级到 frontend，没有启动 child；最终只新增一份交接文档。

| 实际责任与模型 | 分数 | runner token | input / cached / output | 墙钟 | 成本 |
|---|---:|---:|---:|---:|---:|
| K3/max frontend，同 turn | **4/4** | 98,619 | 10,952 / 83,968 / 3,699 | 约 133.9s | 未取得该 provider 权威单价 |

该样本形成于 canonical `0.2.0` 的 frontend 冻结版；后续 `0.2.1` 变化未触达 C08 的 frontend 触发或预算合同，当时单测继续逐项验证 frontend route、`4096` 覆盖、缺配置直退和全局 ceiling 隔离，因此保留这份历史行为样本。更早一轮因 canary 未观察到路由事件而标为基础设施无效，不计质量结果。单一样本只证明显式 frontend 映射和预算在原生 DSH 中可达且交付达到 `4/4`，不证明 K3 是默认、frontend 普遍优于当前 controller，或应继续按数据库、安全等领域枚举责任。

### 简单任务负向纪律

C01 使用 Luna/max controller，并显式配置 Sol/high planner、Luna executor 与 Terra/high reviewer。题面没有独立缺口，结果只运行 controller，4/4，未启动其他责任。

| Case | 分数 | 实际模型 | runner token | 非缓存输入 + 输出 | 墙钟 | 估算成本 |
|---|---:|---|---:|---:|---:|---:|
| C01 | **4/4** | Luna/max 100%；Sol/Terra 0 | 72,662 | 11,222 | 52.8s | $0.0044 |

结论：可靠直答和单一权威来源查询不应为展示路由而升档。

### 原始 C04 八臂冻结对照

八臂保持 canonical C04、fixture、独立 Sol/high judge 和单样本口径，不做 best-of。D/H 的 child durable header 与 `odai/route-result.actualRoute` 均验证为 OpenAI Sol/high；Agent 臂只安装 session-scoped Agent，不加载全局 Plugin。

| 臂 | Treatment | 实际路由 | 分数 | critical | runner token | 墙钟 | 估算成本 | diff |
|---|---|---|---:|---|---:|---:|---:|---:|
| A | DSH Luna/max，odai off | 单 Luna | 0/4 | 是 | 117,245 | 101.9s | $0.0069 | 1 |
| B | Plugin，Luna/max，routing off | 单 Luna | **4/4** | 否 | 137,066 | 143.0s | $0.0135 | 0 |
| C | Plugin，Sol/high，routing off | 单 Sol | **4/4** | 否 | **89,622** | **68.5s** | $0.1604 | 0 |
| D | Plugin，Luna/max，execute | Luna -> Sol child -> Luna | **4/4** | 否 | 153,607 | 137.7s | $0.1156 | 0 |
| E | Plugin，Luna/max，旧 observe | planner 命中，不 spawn | 2/4 | 否 | 189,186 | 189.8s | $0.0201 | 0 |
| F | Codex Sol/high + odai | 单 Sol | **4/4** | 否 | 118,219 | 83.9s | $0.2061 | 0 |
| G | Agent-only，Luna/max，旧 observe | planner 命中，不 spawn | 1/4 | 是 | 155,646 | 94.5s | $0.0125 | 1 |
| H | Agent-only，Luna/max，execute | Luna -> Sol child -> Luna | **4/4** | 否 | 211,252 | 160.0s | $0.2211 | 0 |

D、E、G、H 都从原始自然语言命中 `PLANNER_UNVERIFIED_HIGH_IMPACT_CHANGE`。D/H 证明 Plugin 与 Agent 的 execute 换模链路真实成立；B/C 说明 governance 或单一强 controller 也可能足够，不能从一题一份样本推出 execute 稳定更优。旧 observe 的 E/G 暴露了保护缺口，现已由逐 turn read-only guard 修复。

### C04 execute 与同 turn auto

| Treatment | 实际模型链路 | 分数 | critical | runner token | 墙钟 | 估算成本 | diff |
|---|---|---:|---|---:|---:|---:|---:|
| 冻结 C：Plugin single Sol | Sol | **4/4** | 否 | 89,622 | 68.5s | $0.1604 | 0 |
| 冻结 D：Plugin execute | Luna -> Sol child -> Luna | **4/4** | 否 | 153,607 | 137.7s | $0.1156 | 0 |
| 冻结 H：Agent execute | Luna -> Sol child -> Luna | **4/4** | 否 | 211,252 | 160.0s | $0.2211 | 0 |
| H-rerun：Agent execute | Luna -> Sol child -> Luna | **4/4** | 否 | 229,946 | 128.8s | $0.2756 | 0 |
| **Agent auto** | **同一 controller turn 直接 Sol** | **4/4** | **否** | **90,193** | **65.6s** | **$0.2072** | **0** |

相对冻结 H，auto token 减少 57.3%、墙钟减少 59.0%、估算成本减少 6.3%；相对 H-rerun 分别减少 60.8%、49.1% 和 24.8%。auto 与单 Sol C 的 token 只差 0.6%，说明父 controller 读题、child 重读、父再读回交的双 session 处理量已经结构性移除。

现金成本仍受 uncached input、cached input 和 output 分布显著影响：冻结 D 曾因 cache 命中低于单 Sol 与 auto，不能承诺固定降幅。能承诺的是同 turn upgrade 不再支付第二个 session 的重读与回交处理量。该 Sol/high 是明确测试映射，不是当前包的内置默认。

### observe fail-closed 修复

| Treatment | 实际路由 | 分数 | critical | runner token | 墙钟 | 估算成本 | diff |
|---|---|---:|---|---:|---:|---:|---:|
| 修复后 Plugin observe | 单 Luna；planner gap + 本地证据协议 + 只读保护 | **4/4** | 否 | 130,243 | 108.8s | $0.0142 | 0 |

该历史样本证明当时的 observe 可以在不增加 Sol 调用的情况下安全闭环这份 C04，但不提供独立 planner 证据，也不证明 observe 稳定 4/4。当前候选对 planner 与 reviewer 的缺失或失败路线继续 fail-closed。

### 独立 Executor 有界迁移对照（退役依据）

| 场景 | 实际责任与模型 | 结果 | runner token | 墙钟 | 估算成本 |
|---|---|---|---:|---:|---:|
| 12 文件冻结迁移 | Sol/high controller -> Luna/max executor | 只改 12 个目标值；项目测试通过 | 218,731 | 222.9s | $0.213 |
| 同一迁移单模型对照 | Sol/high controller | 同等改动与验证结果 | 137,261 | 63.6s | $0.201 |

独立 Executor 分流真实发生且没有降低质量，但相对单 Sol 多用 59.4% runner token、墙钟约 3.5 倍、估算成本高 6.0%。这组证据没有证明分离实施的净收益，是当前 `0.3.7` 候选删除 Executor、route card 与 stage 机制的直接依据；当前实现不再提供恢复开关。

## 历史架构摘要

### 强制高级模型前置（已退役）

历史压力对照让 Luna/max 进入、Sol/high 每题前置判断、Luna/high 承担少量执行、Terra/high 按需验收。19 题全部先调用 Sol，只有 C10、C15、C16 再启动 executor，reviewer 未启动。

| 路线 | 分数 | 总处理 token | 非缓存输入 + 输出 | 墙钟 | 估算成本 |
|---|---:|---:|---:|---:|---:|
| 强制前置路由 | **144/144** | 7,201,838 | 1,074,222 | 39.6m | $5.512 |
| 单 Sol | **144/144** | 3,698,792 | 554,088 | 31.1m | $6.005 |

强制前置多用 94.7% 总处理 token、非缓存输入加输出多用 93.9%、墙钟增加 27.3%，现金成本只降低 8.2%。它测到的是低价 controller 与强制高级模型组合的压力上界，不是当前按需路由，已退役。

### 前代 stage 高风险退款任务

| 路线 | 验收 | runner token | 墙钟 | 估算成本 |
|---|---:|---:|---:|---:|
| 单 Sol/high controller | **4/4** | 326,960 | 240.7s | $0.788 |
| Sol/high 定路 -> Luna/max 有界实施 | **4/4** | 325,249 | 390.5s | $0.212 |

前代 stage 相对单 Sol token -0.5%、墙钟 +62.2%、估算成本 -73.1%。它证明有界新上下文可能降低现金成本，也证明延迟未必改善；样本形成于后续同 turn auto、结构化回交和当前 DSH runtime 之前，只保留为历史定向证据。

## 结论与限制

1. 单一充分 controller 是普通任务默认，也是唯一实施与最终交付 owner；路由只补真实且已配置的 researcher、planner、reviewer 或 frontend 缺口。
2. 独立 Executor 在同质量对照中增加 token、延迟和估算成本，未证明净收益；它与 route card、stage runner 已退役。
3. Researcher 在固定 C04 的 4 份独立历史样本中均保持 4/4，并在这些 runner 上低于单份 Sol 基线成本；基线仍为 `n=1`，不建立通用调查流水线或稳定降本结论。
4. 同 turn auto 的历史 C04 样本保持 4/4，但不证明所有任务都更便宜或更稳定；execute 模式的 child 换模同样没有普遍质量或资源净收益结论。
5. observe 的价值是诊断、证据协议和 fail-closed，不是独立判断的替代品；frontend 只在明确专业缺口和显式映射下升级。
6. 当前候选不选择任何责任模型。历史 Sol/Luna/Terra 都是冻结实验映射，不应被读成包默认。
7. Researcher 触发不感知价格；配置只是用户显式选择，不是降本证明，缺权威价格与实际 usage 时不得作节省承诺。
8. `0.3.7` 尚无新计分样本；质量与成本结论只覆盖表中旧指纹，provider cache、上下文档位和输出长度会显著改变单次结果。
