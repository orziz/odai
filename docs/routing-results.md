# Odai DSH 路由验证

当前已发布双包为 DSH `0.2.31`；源码候选为未发布 `0.2.32`，canonical `0.3.15` / runtime contract `6`，支持精确 DSH `0.1.5-rc.1`。使用与配置合同以 [`dsh/README.md`](../dsh/README.md) 为准，当前任务评分见 [`evaluation-results.md`](evaluation-results.md)。本页只保留当前有用的证据及限制；旧版本实验过程由 Git 历史承载。

## 当前定向评估

2026-09-17 使用 `openai/gpt-6-astra/xhigh` 总控，对比：A 干净 DSH/off；B source-plugin/on、managed routing off；C 在B基础上启用用户原样职责配置。只改变声明的治理/路由条件，不修改用户配置或安装中的 DSH。

| 职责 | 用户配置 |
|---|---|
| researcher | `openai/gpt-5.6-luna/max` |
| planner | `openai/gpt-6-astra/xhigh`，child |
| reviewer | `openai/gpt-5.6-terra/xhigh`，child；快照未显式设置maxTokens，实际回执为128000 |
| frontend | `kimi-coding/k3/max`，child |

C01、C04、C08的C臂各得4/4，原生记录均只有总控会话，没有借角色调用凑流程。这证明这三次任务可以保持直接完成，不证明配置职责的净收益。

C20按用户要求重试后仍超过900秒。最新完整原生记录包含总控与两个 `openai/gpt-5.6-terra/xhigh` reviewer子会话，路由回执核实maxTokens 128000；一次完成回交、一次fallback。完成回交仍因关键API、worker、database、回退或相关diff缺失/截断而未独立放行。总控有本地测试通过的证据，并保留生产门禁；这仍不等于任务完成。当前材料已替换对应旧结果，不再维护平行失败目录。

这一观测确认了真实调用与材料交接瓶颈，**没有证明协作净收益**。A-C20有三个原生会话，B-C20只有一个；managed routing off也可以出现原生委派，不能把A/B称为纯单代理对照。调用次数、缓存与时序不同，不从一次token差异推导费用或稳定性结论。

## 证据包限制

`dsh/runtime/src/routing-context.mts` 是行为事实源：默认包预算12000字符、单项上限4000，还受剩余预算分配（`availableChars / 6`）和证据选择顺序影响。引用路径不等于文件内容已经进入包；“全文read过”也不保证child收到了全文。

复核缺少关键内容时，应抓取有界的原始片段，明确对应文件和范围；不要反复提交同一大段输出，或仅在任务正文中宣称已经验证。不得因包截断而放宽来源、只读或生产门禁。当前C20材料交接仍是未解决的性能/完整性限制，源码测试或路由回执不替代真实任务闭环。

## 局部动作保护边界

当前风险保护与能力选择分开：高影响前提先要求证据，不自动制造planner；真实职责缺口按用户映射处理。同步tool guard尚不能把预检查的路径绑定到后续实际写入，因此不能声称已有安全的文件级局部放行。

宿主本身已有目标绑定原语：DSH `dsh-tool-fs/lib/index.js` 将同一 `FsTarget` 和execution actor送入 `fs/write-intent` / `fs/edit-intent`，再使用该target调用实际 `ctx.fs` 写入；`dsh-fs/lib/types/index.d.ts` 定义single-slot waterfall。新的保护集成仍需验证监听顺序、组合、目标身份和撤销；shell及自定义工具副作用不会自动受这些钩子覆盖。本轮没有新增路径例外或降低已有保护。

## 当前可用性

控制中心源码已修复原生调用卡片布局，并将缺少turn的事件标为“未标注轮次的会话事件”。隔离浏览器在1180×852与390×852验证了响应式布局及无横向溢出。回执只证明调用或模型身份，不证明任务完成；运行中的已安装GUI未更新，候选未发布。

## 历史测评数据

保留截至2026-09-04的有效测评数据供比较；旧版配置说明及执行计划已移出当前说明。这些映射、预算、价格和实现只描述当时的冻结实验，不是当前默认配置或当前版本验收。金额为当时价格假设下的估算，缓存与上下文档位会影响结果。

### Researcher与frontend

C04 researcher的四份独立样本均使用Luna/xhigh/500与Sol/xhigh/500，均取得三源packet；C01/C05负向样本未触发researcher。新增三轮runner/judge均通过隔离校验。

| C04样本 | 分数 | input / cached / output | 墙钟 | runner成本 | judge token |
|---|---:|---:|---:|---:|---:|
| 纯Sol基线 | 4/4 | 24,030 / 101,376 / 2,289 | 未记录 | $0.239508 | 未记录 |
| Luna researcher + Sol，初始 | 4/4 | 43,101 / 119,296 / 3,910 | 87.6s | $0.154871 | 未记录 |
| 同路由复跑1 | 4/4 | 41,895 / 68,608 / 4,445 | 98.5s | $0.183011 | 27,458 |
| 同路由复跑2 | 4/4 | 44,962 / 155,136 / 3,314 | 86.0s | $0.203505 | 27,467 |
| 同路由复跑3 | 4/4 | 55,841 / 65,536 / 3,880 | 88.2s | $0.224032 | 27,700 |

当时每百万input/cached/output采用Sol $5/$0.50/$30、Luna $0.20/$0.02/$1.20。researcher四轮成本合计$0.765420、均值$0.191355，墙钟均值90.1s；相对单份Sol基线均值低20.11%，但基线n=1，不构成通用或统计稳定降本结论。provider均超过请求500 ceiling，不代表硬上限。

| 样本 | 实际模型 | 分数 | runner token | input / cached / output | 墙钟 | 成本 |
|---|---|---:|---:|---:|---:|---:|
| C08 frontend，同turn | K3/max/4096 | 4/4 | 98,619 | 10,952 / 83,968 / 3,699 | 133.9s | 无权威单价 |
| C01简单查询 | Luna/max，未调用其他职责 | 4/4 | 72,662 | 非缓存输入+输出11,222 | 52.8s | $0.0044 |

C08形成于canonical 0.2.0，后续0.2.1未触及该题合同；只新增交接文档，真实header证明同turn升级，不是child，也不证明frontend普遍优于总控。

### C04冻结对照

八臂使用同一C04与独立Sol/high judge，各一份、不best-of。字母只标识这组历史实验，与上文当前A/B/C无关。

| 臂/路线 | 实际模型链路 | 分数 | critical | runner token | 墙钟 | 估算成本 | diff |
|---|---|---:|---|---:|---:|---:|---:|
| A DSH/off | Luna/max | 0/4 | 是 | 117,245 | 101.9s | $0.0069 | 1 |
| B Plugin/routing off | Luna/max | 4/4 | 否 | 137,066 | 143.0s | $0.0135 | 0 |
| C Plugin/routing off | Sol/high | 4/4 | 否 | 89,622 | 68.5s | $0.1604 | 0 |
| D Plugin/execute | Luna → Sol child → Luna | 4/4 | 否 | 153,607 | 137.7s | $0.1156 | 0 |
| E Plugin/旧observe | Luna，planner命中但未spawn | 2/4 | 否 | 189,186 | 189.8s | $0.0201 | 0 |
| F Codex+Odai | Sol/high | 4/4 | 否 | 118,219 | 83.9s | $0.2061 | 0 |
| G Agent/旧observe | Luna，planner命中但未spawn | 1/4 | 是 | 155,646 | 94.5s | $0.0125 | 1 |
| H Agent/execute | Luna → Sol child → Luna | 4/4 | 否 | 211,252 | 160.0s | $0.2211 | 0 |
| H复跑 | Luna → Sol child → Luna | 4/4 | 否 | 229,946 | 128.8s | $0.2756 | 0 |
| Agent/auto | 同一controller turn直接Sol | 4/4 | 否 | 90,193 | 65.6s | $0.2072 | 0 |
| 修复后Plugin/observe | Luna，本地证据协议+只读保护 | 4/4 | 否 | 130,243 | 108.8s | $0.0142 | 0 |

D/H具有child durable header与actualRoute；B/C表明治理或单一强总控也可能足够。旧E/G暴露的保护缺口后续得到修复。auto减少了这组样本的重复上下文处理，但不证明所有任务更省、更快或更稳。

### 退役方案的对照依据

| 场景 | 路线 | 结果 | runner token | 墙钟 | 估算成本 |
|---|---|---|---:|---:|---:|
| 12文件迁移 | Sol/high → Luna/max executor | 目标改动及测试通过 | 218,731 | 222.9s | $0.213 |
| 同题 | 单Sol/high | 同等改动及验证 | 137,261 | 63.6s | $0.201 |
| 19题强制前置 | Luna + 每题Sol前置 + 按需执行/审查 | 144/144 | 7,201,838 | 39.6m | $5.512 |
| 同题 | 单Sol | 144/144 | 3,698,792 | 31.1m | $6.005 |
| 前代stage退款 | 单Sol/high | 4/4 | 326,960 | 240.7s | $0.788 |
| 同题 | Sol/high定路 → Luna/max实施 | 4/4 | 325,249 | 390.5s | $0.212 |

强制前置/单Sol的非缓存输入+输出分别为1,074,222与554,088。独立Executor迁移增加59.4% token、约3.5倍墙钟、6.0%估算成本，是退役依据；stage退款成本较低但延迟增加62.2%。这些数据不支持恢复已退役的Executor、route card或stage机制。
