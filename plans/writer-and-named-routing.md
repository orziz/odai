# 写作职责与点名必达

状态（2026-10-27）：阶段 1–6 全部实施并通过总控验收（见文末各审查与验收记录及“收尾状态”）。全部改动未提交、未发布。

## 要解决的问题

用户想在 DSH 里一处用齐三家订阅：GPT 当总控干活；本机 Claude 负责规划、定方向和验收；本机 Gemini（Antigravity）负责写文案和前端。现有路由有两个缺口：

1. **creative 把“定方向、把关”和“写稿”放在同一个映射里。** 用户要把它们交给两个模型：Claude 定方向、把关，Gemini 写。一个映射只能指向一个模型，指给 Claude 就成了 Claude 自己写，指给 Gemini 就没人把关。
2. **点名不保证生效。** 运行时遇到“规划”“审查”一类字面词只记一条 skip（`router.mts` 的 `PLANNER_GAP_NOT_PROVEN` / `REVIEWER_GAP_NOT_PROVEN`），派不派由总控自己判断；编排规则里 planner 也没有“用户明确要求时使用”。用户说“先让 Claude 规划，做完让 Claude 验收”，现在不能保证真的会派。

## 用户决定（2026-10-27）

- 做两件事：新增 writer 职责；用户点名某项已配置职责时必须派出。
- 不做“每个任务固定先规划、后验收”的项目开关。原因：违背编排“不按角色预拆任务”的原则，而且每次小改都要调用成本最高的 Claude。
- 生图不做成职责，不在本计划范围内。需要时由总控在 bash 里运行项目自己的生图脚本。

## 已核实的事实

- **版本**：官方 registry 已发布双包 `0.2.56`，Plugin 发布于 `2026-10-22T10:02:40.507Z`，Agent 发布于 `2026-10-22T10:03:45.504Z`。但 CHANGELOG 仍写着“Unreleased — DSH 0.2.56”，MAINTAINING 也仍称最新已发布为 `0.2.55`。`renwei` 条目是 10-25 提交的，晚于这次发布。新候选用 `0.2.57`。
- 编排 `0.2.2` 已随 `0.2.53`/`0.2.55`/`0.2.56` 发布。新增角色文件会改变 `requiredFiles`，编排要升到 `0.2.3`。治理 `0.7.1` 与 runtime contract `9` 不应因此改变；若实施中发现读取契约确实变了，停下回报。
- **路由时机**：只在每轮第 1 步或存在未消费的职责缺口时做路由决定（`lifecycle-runtime.mts` 中 `if (step !== 1 && !responsibilityGap) return downstream;`）。字面触发因此只在第 1 步发生。
- **待办缺口**：
  - `index.mts` 的 `pendingResponsibilityGap` 取本轮未消费的 `odai/responsibility-gap`。
  - 新的直接用户任务会使它失效（`SUPERSEDED_BY_DIRECT_USER_TASK`）；reviewer 遇到“继续”类消息时保留（`classifyPendingReviewerText`）。
  - reviewer 证据包不足时延后，证据变化后再判一次。
- **结束回复检测与注入的先例**：`lifecycle-runtime.mts` 在 same-turn 职责发出结束回复（不带工具调用的 assistant 消息）时，会经 `owner.inject` 注入说明，这一轮随后在总控路由上继续（`responsibility-return-missing`）。
- **creative 的字面触发**：在 `router.mts` 的 `hasCreativeRequest`。按短句判断，短句里有工程或数据词就否决。
- **本机 CLI 职责**：只读，只能作为 child 派发；Claude 适配器只有 `Read,Glob,Grep`。
- **当次加 creative 的改动清单**：提交 `00f64f5`。writer 逐处对照，判断哪里需要对应项。
- **用户当前映射**（本计划不改）：
  - creative → 本机 claude，opus / max
  - frontend → 本机 antigravity，gemini-3.8-flash / high
  - researcher、planner、reviewer → openai 渠道

## 先行：版本与发布记录

- **CHANGELOG**：
  - 把“Unreleased — DSH 0.2.56 / canonical 0.7.1”改为已发布的“DSH 0.2.56 / canonical 0.7.1”，按既有格式补上述 registry 发布事实。
  - 新建“Unreleased — DSH 0.2.57 / canonical 0.7.1”。`renwei` 条目移入其中，因为它晚于 0.2.56 发布才提交。
  - 本计划的改动写进 0.2.57 条目，并写明编排升为 `0.2.3`。
- **MAINTAINING.md**：同步“当前状态”：最新已发布 `0.2.56`，候选 `0.2.57`，编排 `0.2.3`。
- **版本号**：双包及所有版本载体升到 `0.2.57`，编排 manifest 升到 `0.2.3`，都通过仓库的版本策略校验。
- **核对已发布内容**：发布事实以官方 registry（`--registry https://registry.npmjs.org`）为准。下载 `odai-dsh-agent@0.2.56` 制品，核对其中的编排文件与当前 HEAD 的 `skills/odai-orchestration/` 是否一致，结果写进回报。不一致不阻断，但要说明。

## 阶段 1：writer 职责

**结果**：新增可选职责 `writer`，用户可见名称为“写作”。它只承接方向已定的写作制作：起草、改写，以及翻译和本地化，只读回交成稿。未配置 writer 时，creative 的现有行为完全不变。

**canonical（跨宿主，不写宿主机制与模型）**：

- 新增 `skills/odai-orchestration/assets/routing-roles/writer.md`，正文按下文原样使用，不改写措辞：

  > ## 写作专业责任
  >
  > 只承接方向已定的写作制作，不限领域：按给定说明起草、改写、扩写或压缩面向用户或读者的文字，或把已定稿内容翻译、本地化成目标语言。不是第二个总控，也不替代创意判断；受众、目的、语气、篇幅、必须保留和禁用项缺到会改变成稿时，回交准确缺口，不自行定方向、改设定或扩大范围。
  >
  > 动笔前读清给定说明、项目已有设定与术语、文风样本和既有译名；写作方法遵循随合同提供的 治理 craft reference。成稿写给具体读者，用他们会用的词；具体胜过空泛，可以加入贴合语境、不与已有内容冲突的细节，不堆砌修饰、套话和模板句式。翻译忠实原意、语气和信息量，按目标语言读者的习惯表达，不逐字硬译；术语、专名、占位符和格式标记保持一致，长度受限的文字按限制写。
  >
  > 要候选时，候选要实质有别并各写明取向；只要一稿时直接给成稿。
  >
  > 只读：交回成稿或候选，附必要的简短说明（依据的说明条目、刻意的取舍、未能满足的限制、待确认的设定或术语），不编辑文件，不把成稿写成已采纳或已落盘；改写已有文字时给出原文位置与替换文本，由总控核对后落盘。不扩大到相邻内容的重写，顺带发现的问题单列为建议。模型、预算及执行权限由宿主选择，不写入本通用责任合同。

- `references/orchestration.md` 的“选择职责”列表在 creative 后加一条，原样使用：

  > - **writer**：方向已定、需要起草、改写或翻译面向用户或读者的文字，且交给专门的写作能力能改善结果时使用，不限领域。方向、构思与品味把关仍归 creative；未配置 writer 时由 creative 照旧承接写作。说明不足以写出可用成稿时先回交缺口。只读，回交成稿或候选，由总控核对后落盘。

- `manifest.json`：roleFiles 加 `writer`，rolePresets 为 `{ "references": ["craft"] }`，requiredFiles 加该文件，version 升 `0.2.3`。`compose-contracts.mjs` 及其 `.d.mts` 的角色名单和必需 reference 同步（writer → craft）。`SKILL.md` 的职责列表加 writer；`assets/routing-roles/controller.md` 的可选职责占位加 `__ODAI_WRITER_ROLE__`。
- 宿主适配脚本（`build-routing.mjs`、`install-routing.mjs`、`verify-routing.mjs`、`run-role.mjs`）按“可选职责、默认不生成”处理 writer，与 creative 相同：
  - 参数：`--writer-model`、`--writer-effort`；Claude 宿主另有 `--writer-cli`。
  - 映射名：`odai_writer` / `odai-writer`。
  - 只读角色集合包含 writer。
  - build 的角色说明：“只在方向已定、需要起草、改写或翻译面向用户或读者的文字时提供成稿或候选。”
  - activation 键：`writer_activation`，取值与 creative 同类。
- 旧编排包兼容：没有 writer 文件的已安装编排 `0.2.2` 被 DSH 以 `auto`/`user` 来源选中时，处理方式与当初 creative 加入时一致：校验按完整职责名单进行，缺 writer 判为不兼容，经现有选择机制可见回退到内置版本。不在校验里按版本号特判放行。

**DSH 侧（`dsh/runtime/src/`、`dsh/client/src/`）**：

- 职责名单和枚举都加入 writer：
  - `CONFIGURABLE_ROLES`、`OdaiRouteRole` 等路由角色类型
  - `index.mts` 的职责名单、`odai_responsibility_gap` 的枚举
  - `runtime-support.mts` 的本机 CLI 职责名单
  - `DSH_NATIVE_DELEGATION_GUIDANCE` 的职责列表
  - `ROUTING_CONFIG_CUE`（加“写作”和 `writer`）
  - 配置工具的描述与提示
- 调度与配置：writer 只支持 child，规则与 creative 一致：
  - `effectiveRoleDispatch` 固定返回 child。
  - 显式配置 `same-turn` 报错。
  - API 和本机 CLI 两种路由都可配置。
  - 手工标签 `odai-writer:` 在 API 路由下可用；本机 CLI 路由下拒绝，并提示改用 `odai_responsibility_gap`。
- `role-overlays.mts` 加 writer 段，原样使用：

  ```text
  ## DSH writer execution boundary

  This responsibility supports read-only child dispatch only. Inspect the bounded task and evidence packet, then return finished drafts, distinct candidates when requested, or replacement text keyed to original locations, with brief notes on the brief items followed, deliberate tradeoffs, unmet constraints, and terms that need confirmation. Do not edit files, execute commands, delegate further, decide direction that the packet leaves open, or make the controller's final delivery. The controller verifies the handback and applies accepted text. A configured API or local-cli route supplies the model; only runtime route evidence proves that mapping ran.
  ```

- Control Center：职责列表加“写作”，调度控件同 creative（只有 child，same-turn 禁用）；映射表单可选 API 渠道或本机 CLI。

**字面触发拆分（`router.mts`）**：

宁可漏判，不可误判。工程或数据词的短句否决对 writer 同样生效。**未配置 writer 时，所有现有 creative 测试结果不变。** 已配置 writer 时按以下规则：

- 方向类对象：先要满足 creative 原有的“动作 + 对象相邻”规则（`hasCreativeRequest`）。满足后一律归 creative，不管动词是写作类还是审查类；不满足就不触发，光出现方向类名词不算请求。对象包括视觉方向、美术方向、画风、世界观、人设、角色设定、玩法、关卡设计、数值平衡、创意、点子、脑洞、品牌名、产品名、名字、名称，以及对应英文。
- 文字类对象看动词：
  - 制作动词归 writer：写（“写进/写到/写入/写在”除外）、起草、拟、改写、重写、润色、改改、改一改、扩写、优化、翻译、本地化；英文 write、rewrite、polish、draft、translate、localize、improve。
  - 构思和审查动词归 creative：想想、构思、发散、脑暴、头脑风暴、起名、取名、审查、审、把关、评估；英文 review、brainstorm、come up with、suggest、name。
- 抱怨文字后跟一句光秃的修改请求（例如“这段话 AI 味太重，帮我改改”）归 writer。

必测例子（已配置 writer 时）：

| 归属 | 例子 |
|---|---|
| writer | 帮我润色这段对白；给新地图写三版商店页宣传语；把这段文案翻译成英文；rewrite the store page copy；这段话 AI 味太重，帮我改改；优化一下这段介绍 |
| creative | 审一下第二章的台词有没有 AI 味；这个玩法的数值平衡你评估一下；给这个功能起个名字；写一下世界观设定 |
| 不触发 | 阶段 2 记录的 9 条工程误判，例如“写一下玩法的单元测试”“把剧情写进存档”“文案写到配置里”；以及“翻译这段报错”“把这个变量的名字改一下” |

**测试**：

- 配置：
  - writer 的设置、删除、显示；API 和本机 CLI 都可用。
  - 显式 same-turn 报错。
  - 无本机 CLI 映射时仍写 schema 2。
- 派发：
  - writer 经本机 CLI（伪造可执行文件）和 API 各一条 child 派发用例。
  - 回执记录实际模型。
- 字面触发：上表全部入测。未配置 writer 时，原 creative 正反例全部保持。
- 合同组合：writer 合同带 craft reference。
- 宿主适配：在 `scripts/test-odai-routing.mjs` 加 writer 的构建、安装、卸载；Claude 宿主的 `--writer-cli`。
- Control Center 客户端：职责标签、child 限定、表单。

**文档**：

- `dsh/README.md`、`README.md`、`README.zh-CN.md`、两个包的 README、`references/install.md`：职责名单加 writer，写明与 creative 的分工。
- CHANGELOG 0.2.57。
- 不改 creative 合同正文。

**阶段 1 停止点**：全部验证命令通过后停下，按“回报要求”回报，不开始阶段 2。

## 阶段 2：点名必达（仅 DSH 运行时 + 一句编排规则）

**结果**：用户在消息里明确点名某项已配置职责，或点名其映射的模型时，运行时保证按点名的时机派出该职责。派不出时，总控必须在最终答复里说明原因。不点名时，行为与现在完全一样。

**识别**：

- 什么时候识别：每条新的直接用户消息只识别一次，包括新一轮的第一步，以及进行中插入、已被接纳的消息。子会话、`routing.mode` 为 `off` 时不识别。
- 怎样才算点名：需要有委派说法，二选一：
  - 委派动词（让、交给、请、叫、找、用…来/去）+ 对象（职责名，或已映射的模型、CLI 名）+ 职责动作；
  - “<事项> 让/交给 <名字> <动作>”句式，例如“文案让 Gemini 写”“规划交给 Claude”。
- 由动作和对象决定候选职责：
  - 规划、计划、出方案、定方案、拆任务 → planner
  - 调查、调研、查资料、核实来源 → researcher
  - 定方向、构思、起名、出点子；以及同一短句有创作对象（文案、台词、画面、美术、视觉、宣传、商店页等）时的审、把关、评估、看看 → creative
  - 写、起草、改写、润色、翻译、本地化，且宾语是面向读者的文字 → writer；writer 未配置时为 creative
  - 没有创作对象时的审查、验收、复核、检查、review → reviewer
  - 界面设计、前端实现、做 UI → frontend
- 点了模型名时：
  - 在候选职责里选映射与该名字相符的那个。例如 writer 映射 Gemini、creative 映射 Claude 时，“让 Claude 写文案”取 creative，“让 Gemini 写文案”取 writer。
  - 没有相符的：不派，也不用别的职责或模型替代，改为提醒总控告诉用户“该职责现在映射的是哪个模型”。
  - 名字别名：
    - Claude、克劳德、opus、sonnet → 本机 claude 或 anthropic 模型
    - Gemini、反重力、agy、antigravity → 本机 antigravity 或 gemini 模型
    - GPT、Codex → openai 渠道或本机 codex
    - Grok → 本机 grok
- 不算点名，必须不触发：
  - 引号里的文字。
  - 疑问和回顾：“你规划了吗”“上次 Claude 审过了”“Claude 的规划写得不错”。
  - 否定：“不用让 Claude 审了”。这种说法同时取消同一任务里尚未执行的同职责点名。
  - 配置语句：“规划用本机 claude opus，推理档 max”“以后文案都让 Gemini 写”。这类交给现有配置工具，复用 `ROUTING_CONFIG_CUE` 一类判断。
  - 作修饰语的短语：“给 odai 加一个让 Claude 规划的开关”“写一下让 Claude 审查代码的测试”。
  - 只有职责词、没有委派对象：“先规划一下再做”。这种情况总控可以自己规划。

**时机**：

- **默认时机**：reviewer 在完成时派，其他职责在开始时派。
- **说法改时机**：
  - 同一短句里有“做完、写完、改完、完成后、之后、最后、交付前”（英文 after、once done、finally、before delivering）时，该点名改为完成时派。
  - 有“先”时，改为开始时派。
- **开始时派的点名**：
  - 按在原话中出现的顺序，在总控动手前依次派出，每步一个。
  - 后派职责的任务包要带上本任务前面职责的回交，例如 creative 定的方向要交给 writer。
- **完成时派的点名**：
  - 接入点用 DSH 的 `agent/turn-stopping` 事件。宿主 API 说明是：一轮即将结束（模型没有待执行的工具调用，也没有新的 steering）时，宿主会等这个事件的所有监听者执行完；监听者调用 `agent.steer(...)`，主循环就会再跑一步，否则这一轮结束。DSH 自带的 `dsh-workspace-changes` 也监听这个事件。
  - 做法：总控智能体（不含子会话）的 `agent/turn-stopping` 触发时，若仍有未执行、也还没催过的完成时点名，就用 `agent.steer(说明消息)` 催一次，并把这些点名标记为“已催”。
  - 不要用 `inject`，也不要在 `assistant/message` 事件里注入。上一轮的宿主探针已证实，那样做不会让这一轮继续。
  - 催过之后，下一步起按出现顺序依次派出。
  - reviewer 沿用现有证据包判断和回退处理，不另开一套。
  - 全部回交后，总控继续收尾。
  - 总控也可以在结束前自己用 `odai_responsibility_gap` 提前满足这些点名；已满足的不重复派。
- **实现约束**：把点名记成带用户来源标记的职责缺口，复用现有的待办、派发、回执、取代和延后逻辑，不新建第二套调度。

**结束条件**：

- 每个点名在同一任务里最多派一次，有已核实的路由回执即算满足。同一职责在不同时机各被点名一次时，算两个点名，例如开始时 creative 定方向、完成时 creative 审稿。
- 职责未配置、点的名字与映射不符、调用失败或模型未核实时：不重试，不换模型，不改配置。运行时提醒总控在最终答复里说明哪一项没做成、原因是什么。未配置时沿用现有的缺配置提示。
- 新的直接用户任务会取代尚未执行的点名；“继续”类消息保留点名，沿用 `classifyPendingReviewerText`。
- 每个完成时点名最多催一次。已经催过、却仍然没有执行的点名（例如派发失败）不再催，改为“未完成”，并提示总控在答复里说明。`signal` 已中止时不催。这样不会形成循环。
- 用户插话、取消或出错时，按现有 scope 停止规则处理。

**提示总控**：识别到点名的那一步，向总控注入一条简短说明，内容包括：哪些职责被点名、各在什么时机派、由运行时负责派发、总控不要自己再派同一项、最终答复要逐项说明结果（哪个模型做了什么，没做成的原因）。

**编排规则（canonical，跨宿主）**：`references/orchestration.md` 的“选择职责”首段，在“任务复杂、高后果或已有配置均不自动触发。”之后加一句，原样使用：

> 用户明确点名某项已配置职责或其映射的模型时照办，并按用户说的时机调用；未配置、所点模型与映射不符或调用失败时如实说明，不改用其他职责或模型，也不擅自改配置。

README 中“职责词不是口令”一句改为说明两点：不用说职责词，任务照样能完成；明确点名让某个职责或已映射的模型来做时，会照办。

**必测例子**（配置：planner、reviewer、creative → 本机 claude；writer、frontend → 本机 antigravity）：

| 用户原话 | 期望 |
|---|---|
| 先让 Claude 规划一下再动手 | planner，开始时 |
| 做完让 Claude 验收 | reviewer，完成时 |
| 先让 Claude 规划，做完再让 Claude 验收 | planner 开始时；reviewer 完成时 |
| 文案让 Gemini 写 | writer，开始时 |
| 让 Claude 定方向，Gemini 写文案，写完让 Claude 审 | creative 开始时 → writer 开始时（任务包带 creative 回交）→ creative 完成时 |
| 让 Claude 写这段文案 | creative，开始时 |
| 用 Gemini 做这个页面的界面 | frontend，开始时 |
| have Claude plan this first, then let Claude review when done | planner 开始时；reviewer 完成时 |
| （planner 改为 openai 渠道）让 Claude 规划 | 不派；提醒映射不符 |
| （writer 未配置）文案让 Gemini 写 | 不派；提醒未配置或不符 |
| 上表“不算点名”的全部例子 | 不触发 |

另外要测行为：

- 开始时的点名在总控第一次实施前派出。
- 完成时的点名在第一次结束回复后，经 `agent/turn-stopping` 催一次再派出；同一个点名不会被催第二次。
- 宿主探针（DSH `0.2.1-rc.2`，临时 `DSH_HOME`）：在 `agent/turn-stopping` 里 `agent.steer` 后，同一轮出现第二个 step；不 steer 时这一轮照常结束。
- 失败或未核实时不重试，并提示总控说明。
- 新任务取代点名；“继续”保留点名；否定说法取消点名。
- 子会话和 `routing.mode` 为 `off` 时不识别。
- 已经被总控用缺口工具满足的点名不重复派。

**文档**：`dsh/README.md` 写明点名的说法、时机规则和不算点名的情形；README 两份各加一句；CHANGELOG 0.2.57。

## 阶段 3：职责会话续接与恢复修正（阶段 2 验收后实施）

用户 2026-10-27 授权总控按自己的判断推进（“你按照你的想法做吧”）。同日用户补充设计原则：

> 每一个都是插槽，可选的，毕竟还有别人用，不一定会有 claude 订阅（是配置的）

因此本阶段和阶段 4 都不绑定任何模型或 CLI：

- 能力按插槽（职责映射）开启，由各后端各自声明是否支持。
- 默认行为不变。
- 没配置的插槽不产生任何效果。

**结果**：

1. **会话续接**：任一职责插槽都可以开启“会话续接”。开启后，同一个 DSH 会话里映射到同一路由（同一后端与模型）的各职责共用一个续接会话，后面的调用都续接它。这样同一个模型验收时，记得自己当初的规划、方向和判断。默认保持现状，即每次调用新开；用户明确要求才开启。
2. **恢复修正**：修复现有的 same-turn 职责恢复，改用 `agent/turn-stopping` + `agent.steer`，使 `dsh/README.md` 中“恢复后自动继续”的描述成立。

**会话续接**：

- **配置**：
  - 职责映射新增可选字段 `session`，取值 `fresh`（默认，即现状）或 `continue`。API 渠道和本机 CLI 两种映射都可以设。
  - 某个后端不支持续接时，设为 `continue` 报错，并说明该后端暂不支持；不悄悄退回 `fresh`。
  - 自然语言示例：“规划用本机 claude opus，推理档 max，会话续接”“审查用 openai gpt-6.1-sol，会话续接”。Control Center 映射表单加对应开关。
  - 存储 schema 需要变时，遵守现有的升级规则和仓库版本策略（版本标识不得含数字 4）。
- **后端适配**：每个后端各自声明是否支持续接，以及会话标识从哪里来、续接时用什么参数。先核实，再实现：
  - **本机 claude**：首次用 `--session-id <新 UUID>`，之后用 `--resume <UUID>`，去掉 `--no-session-persistence`。本机 2.1.307 已确认有这些参数。
  - **本机 codex**：首次照常 `codex exec`，会话 ID 从现有的模型证据（会话记录）里取；之后用 `codex exec resume <ID> -`。要核实 `exec resume` 是否接受现有的只读沙箱、模型和 JSON 参数；不接受就声明为不支持。
  - **本机 antigravity**：之后用 `--conversation <ID>`。要核实首次调用的 stream-json 输出里能否取到会话 ID，以及续接时计划模式（只读）是否保持；取不到或不保持就声明为不支持。
  - **本机 grok**：CLI 有 `--resume <ID>`，但用户没有订阅，无法实测。按文档实现时标明“未实测”；拿不准就声明为不支持。
  - **API 渠道（DSH 子代理）**：DSH 的 `dsh-subagent` 管理模块有恢复会话、向已有子代理继续发消息的能力。要核实能否把新任务发给同一个职责子代理，并且只读边界、路由回执和模型核验都保持；能就实现，不能就声明为不支持。
  - 每个后端最终是否支持、依据是什么，写进文档和回报。
- **会话归属**：
  - 键为（DSH 会话、路由标识），路由标识是后端 + cli 或 provider + model。
  - 键与会话标识的对应关系记在该 DSH 会话的证据事件里，随会话走、可审计，不另建全局存储。
- **并发**：同一个键的调用串行排队，不同时续接同一个会话。
- **续接失败**：会话不存在、损坏或被后端拒绝时，新开一个会话，并在回执和总控提示里写明“续接失败，已新开”，不静默处理。
- **不变的部分**：
  - 只读边界、任务包内容（仍完整发送，不做增量优化）、模型核验方式都不变。
- **回执**：记录本次是新建、续接，还是续接失败后新开。
- **文档**：
  - 写明本机 CLI 的会话文件由各 CLI 自己存放和管理，odai 不读取（模型证据所需的除外）、不删除。
  - 写明续接会让上下文逐次变长，由各后端自行压缩。
- **测试**：每个声明支持的后端，都用伪造的可执行文件或宿主替身覆盖以下情况：
  - 首次调用的参数和续接调用的参数；同一个键用同一个会话；不同 DSH 会话用不同会话。
  - 同一个键的调用串行执行。
  - 续接失败后新开会话并有提示。
  - 默认 `fresh` 时行为与现状完全一致。
  - 配置校验，以及不支持的后端被拒绝。
- **真机核验（总控负责）**：对用户本机已登录的 claude、codex、antigravity，各用最便宜的模型连续调用两次。第一次让它记住一个数字，第二次续接后问它这个数字，确认它记得。

**恢复修正**：

- 把 `responsibility-return-missing` 分支的恢复说明，从“在 `assistant/message` 里调用 `owner.inject`”改为“在 `agent/turn-stopping` 里调用 `agent.steer`”。触发条件不变，事件记录保留，状态值按实际行为命名。
- 同一次 `turn-stopping` 里，如果阶段 2 的完成时点名也要催，两件事不得重复催同一事项。
- 宿主探针覆盖：恢复说明发出后，同一轮会继续运行。

## 阶段 3 验收记录（总控，2026-10-27）

GPT 回报阶段 3 完成，计划验证命令只完整跑了一次：Runtime 402/402、Plugin 411/411、Agent 24/24、宿主路由 15/15 suites，打包预览 Plugin 222 个文件、Agent 241 个文件（用隔离缓存），其余均通过。

**各后端结论**：

| 后端 | 结论 | 依据 |
|---|---|---|
| claude | 支持 | 首次 `--session-id`，之后 `--resume` |
| antigravity | 支持 | 首次从输出取 `conversation_id`，之后加 `--conversation <ID>` |
| codex | 不支持 | `exec resume` 的帮助里没有只读沙箱参数 |
| grok | 不支持 | 证据不足 |
| API 子代理 | 不支持 | DSH 有续发能力，但尚未证明跨职责复用时能保住边界和逐次模型核验 |

- **会话键**：DSH 会话 + 路由标识。对应关系写入 `odai/route-session` 证据事件。
- **其他行为**：同一个键串行；续接出错时新开一次并提示；取消和超时不重开。
- **存储**：显式保存 `session` 时，路由存储用 schema 5，跳过 4。
- **恢复修正**：改为 `recovery-pending` → `agent/turn-stopping` 中 `agent.steer` → `recovery-steered`，每个 scope 只恢复一次。宿主探针证明同一轮会继续。

总控核对过 `local-cli.mjs` 的参数，与下面真机核验用的完全一致；默认 `fresh` 时 claude 仍带 `--no-session-persistence`。

**真机核验（总控，本机）**：

- claude（haiku）：第一次 `--session-id` 记住 73129，第二次 `--resume` 答出 73129，会话 ID 一致，实际模型 `claude-haiku-5-5`。
- antigravity 1.4.7（gemini-3.8-flash-low）：第一次取得 `conversation_id`，第二次 `--conversation` 答出 73129，`conversation_id` 一致。

阶段 3 验收通过。

**相邻发现：agy 的只读并不靠计划模式。**

1. agy 1.4.7 同时收到 `--mode plan` 和 `--disable-slash-commands` 时，会警告“--mode plan has no effect while slash command expansion is disabled”，计划模式失效。
2. 总控用适配器的原样参数，在临时目录里让它写文件和执行 `touch`，结果没有产生任何文件。拦住它的是默认权限模式 `request-review`：无界面运行时无法弹窗请求批准，`write_file` 被自动拒绝，输出里有 `denied_actions`。
3. 也就是说，只读边界取决于用户的 agy 设置里有没有给写类工具加允许规则。现有文档写的是“使用计划模式”，与实际不符。
4. agy 没有工具白名单之类的参数，只有 `--mode`、终端沙箱 `--sandbox` 和 `--dangerously-skip-permissions`。
5. 不过它的 stream-json 会逐步给出 `step_update`，包含 `step_type: "tool"`、`tool_name`、`state`（`ACTIVE`、`DONE`、`ERROR`），结果里也有 `denied_actions`，可以据此事后检查。

修正放进阶段 4 的同一次运行，见下文“附带：agy 只读加固”。

## 阶段 4：主导模式（已细化，实施中）

**结果**：主导模式不绑定模型。“谁主导”就是规划、审查两个插槽里配置的模型，可以是任何渠道或 CLI。开启后，凡是要改东西的任务：

- 动手前，由规划插槽先出规划；
- 改完后，由审查插槽验收；
- 有问题就让总控修，修完再审。

只读的问答和调查不触发。

- **开启和关闭**：
  - 只作用于当前 DSH 会话，状态记在该会话的证据事件里，重开会话后仍然有效。
  - 开启说法例如“开启主导模式”“这个会话开主导模式”“这个会话由 Claude 主导”（英文 enable lead mode）。
  - 关闭说法例如“关闭主导模式”“退出主导模式”“恢复正常模式”（英文 disable lead mode）。
  - 不用单独的“恢复正常”，以免与“服务恢复正常了吗”这类话混淆。
  - 点了模型名时，按阶段 2 修正后的匹配规则（别名 + 已配置插槽的动态名字）与规划、审查插槽比对：两个都对不上就不开启并提示；只对上一个，就只用那一个，并说明。
  - “你来主导”不算开启，因为“你”是总控本身。
  - 引号里的话、疑问句和配置语句不算开关，沿用阶段 2 的短句规则。
  - 开启和关闭时，向总控注入一条说明，让它告诉用户：已开启或关闭；用哪个插槽、哪个模型规划和审查；怎样关闭。
- **规划（按需触发）**：
  - 模式开启后，每个新的直接用户任务里，总控第一次调用写类工具前，由工具守卫拦住，先派规划插槽。复用阶段 2 的开始时守卫和缺口队列，来源标记为 `lead-mode`。
  - 写类工具按 DSH 现有的写入或权限分类判断。分不清的（例如任意 bash 命令）按写类处理。
  - 只读工具（读文件、搜索、列目录等）不触发。
  - 同一任务只规划一次。
- **审查（按需触发）**：
  - 本任务实际发生了写类动作，以现有写入或 diff 证据为准，在 `agent/turn-stopping` 时派审查插槽。复用阶段 2 的完成时催办，来源 `lead-mode`。
  - 没有写类动作就不审。
- **审查—修正循环**：
  - 主导模式下派出的审查，在合同 overlay 里额外要求回交末尾给出一行可机读的结论：`VERDICT: pass` 或 `VERDICT: changes-requested`。
  - 结论为 `changes-requested` 时，运行时在下一次 `turn-stopping` 用 `agent.steer` 把审查意见交给总控修正。修完后到下一次 `turn-stopping` 再派审查。
  - 最多再审 2 轮。仍未通过，就提示总控在最终答复里如实列出未解决的问题。
  - 结论缺失或无法解析，视同 `changes-requested`，但不再追加轮次，直接提示总控说明。
- **插槽缺失时**：只配了其中一个插槽，就只做那一半；两个都没配，开启时告诉用户缺哪两个插槽、怎样配置，不开启。
- **调用失败时**：规划或审查调用失败（例如该模型额度用完）时任务不中断。提示一次后总控继续，最终答复说明哪一步没有做。不重试，不换模型。
- **与点名的关系**：
  - 用户在主导模式下另外点名的职责，按阶段 2 照办。
  - 与主导模式自动生成的是同一职责、同一时机的，只派一次。
- **不受影响的情况**：
  - 没开启主导模式的会话，行为与现在完全一致。
  - 子会话和 routing `off` 不生效。
- **测试**：
  - 开关识别的正反例（含上述不算开关的情况）；状态持久化；点名不符时的提示。
  - 只读问答不触发；第一次写类工具前派规划。
  - 有写入才审查；`pass` 时结束。
  - `changes-requested` 时修正再审，最多 2 轮；结论缺失时的处理。
  - 失败不中断；与点名合并不重复；子会话和 `off`。

**附带：agy 只读加固**（相邻发现，用户已授权总控按判断处理）：

- **执行后检查**：每次 antigravity 调用结束后，检查 stream-json 中 `step_type: "tool"` 且 `state: "DONE"` 的步骤。若出现只读白名单以外的工具（白名单至少包括 view_file、grep_search、list_dir、find_by_name，以 agy 实际工具名为准），判定越界并按失败处理：
  - 不输出正文；
  - 回执记 `boundary-violation` 及工具名；
  - 提示总控告诉用户：agy 的权限设置允许了写类工具，请检查 agy 设置里的 `permissions.allow`。
- **测试样例**：用总控提供的真实样例结构做 fixture，其中被拒的 `write_file` 步骤为 `state: "ERROR"`，结果带 `denied_actions`。
- **文档改正**：写明 agy 1.4.7 下计划模式因 `--disable-slash-commands` 而失效；只读靠无界面运行时对需授权工具的自动拒绝，以及上述执行后检查；用户不应给 odai 使用的 agy 配置写类工具的允许规则。保留 `--mode plan` 参数不变。

**不做的方案**：让外部 CLI（例如订阅版 Claude Code）直接当 DSH 主循环的模型。原因有三：

- 要用插件替换 DSH 主循环的模型，并把 DSH 的每次工具调用经 MCP 一来一回转给外部进程，未知太多：插件能否替换主循环、长时间等待与取消、重启后恢复。
- 外部 CLI 每一步都要消耗该订阅的额度，额度一用完整个会话就停。
- 主导模式只在决策节点调用规划、审查插槽，就能得到同样的分工。

另外，DSH 本身就能通过 API 渠道使用任何受支持的模型（包括 Anthropic）当主循环模型，这不需要 odai 做任何事。以后确有需要时再评估。

## 阶段 4 审查记录（总控，2026-10-27）

GPT 回报阶段 4 完成：Runtime 436/436、Plugin 445/445、Agent 24/24，打包预览 226 和 245 个文件。

- **验证偏离**：第一轮验证因自己引入的三处类型错误失败，修正后补跑了失败项；最后几处小补充之后只跑了受影响的定向测试（180/180），没有再跑全量。GPT 已如实说明。
- **开关识别**：例表经核对符合计划。

总控用真实的 agy 1.4.7（gemini-3.8-flash-low）补测后，发现 agy 加固有两个必须修正的问题，另有一处解析太严：

1. **白名单用错了名字，会把正常读文件判成越界。**
   - `init.tools` 里列的是 `view_file`、`list_dir`、`grep_search`、`find_by_name`、`write_to_file` 等。但 stream-json 的 `step_update.tool_name`，以及模型实际可调用的工具名，是另一套。
   - 让 agy 列出它能调用的工具，回答是：`run_command, read_file, edit_file, write_file, manage_task, schedule, invoke_subagent, manage_subagents, send_message, define_subagent, search_web, ask_question`。
   - 实测读文件任务中，步骤为 `DONE read_file`、`ERROR read_file`、`ERROR run_command`，结果 `denied_actions: [{"action":"command"}]`。写文件被拒时步骤为 `ERROR write_file`，`denied_actions: [{"action":"write_file"}]`。
   - 按现有白名单，正常的 `DONE read_file` 会被判越界，agy 职责的结果将全部作废。
   - 修法：白名单按实际步骤名设为 `read_file`、`search_web`、`ask_question`、`manage_task`（agy 自己的任务清单，不写被委托项目），并保留旧版本的 `view_file`、`grep_search`、`list_dir`、`find_by_name` 以兼容旧版。fixture 改用上面的真实步骤序列：`DONE read_file` 不越界；`ERROR` 和被拒步骤不越界；`DONE` 的 `write_file`、`edit_file`、`run_command` 及未知工具越界。
2. **现有的 agy 只读提示写的是模型看不到的工具名。**
   - `AGY_READ_BOUNDARY` 让模型“只用 view_file、grep_search、list_dir、find_by_name”，而 1.4.7 的模型告诉总控，这几个工具“当前环境中未提供”。
   - 实测中，模型因此转去用 `run_command` 列目录，被拒后整次调用的 `response` 为空。也就是说，任何一次被拒的动作都会让这次调用作废。
   - 修法：改写提示，不再写死具体工具名。要点是：
     - 只用只读工具读取任务包里给出路径的文件（例如 `read_file`，旧版本叫 `view_file`）；
     - 不要列目录、搜索文件、执行命令、写入或编辑文件，这些都会被拒绝，并使本次调用作废；
     - 需要但没给出的文件，在回交里写明需要哪些，不要自行尝试。
   - 文档如实记录：agy 1.4.7 无界面运行时，被拒的动作会导致输出为空，属于已知限制。
3. **VERDICT 解析太严。** 现在要求最后一行一字不差，加粗、反引号、句号或全角冒号都会被判为 `invalid`，修正循环随之中止。修法：
   - 取最后一个非空行，去掉首尾的 Markdown 强调和引号，以及末尾的句号；
   - 关键字不区分大小写，冒号接受半角和全角；
   - 全文出现相互冲突的多个 VERDICT 才判 `invalid`。

**修正验收（总控，2026-10-27）**：三项修正已完成，并在最终改动之后完整跑了一次验证：

- Runtime 459/459、Plugin 468/468、Agent 24/24、宿主路由 15/15 suites、版本策略 3/3；
- 打包预览 226 和 245 个文件；
- 其余各项均通过。

总控用改写后的 agy 提示，把先前输出为空的任务（读 README.md 和 src/fairs.js，写一句宣传语）在 agy 1.4.7 + gemini-3.8-flash-low 上重跑两次。两次都只出现 `DONE read_file` ×2，没有被拒动作，都交回了宣传语。修正前，同一任务的输出为空。

阶段 4 验收通过。

**已知限制，记录在案，本次不改**：主导模式把任意 bash 和未知工具都算作写类。只用 bash 查看信息的任务，结束时也会生成审查缺口。由于没有 diff 证据，现有机制会转为总控本地核对，不会真的调用审查模型。以后可改为以实际工作区改动作为审查的触发依据。

## 阶段 5：Claude Code 与 Codex 宿主（上）：插槽对齐与会话续接（阶段 4 验收后细化再实施）

用户 2026-10-27：“当然，不单单是 dsh 版，claude code 和 codex 也可以哦”。各项能力在宿主版（`build-routing.mjs` / `install-routing.mjs` / `run-role.mjs` 生成和安装的 Claude Code、Codex 路由）也要提供，同样遵守“可选插槽、默认不变、按后端声明支持”的原则。Copilot 宿主本次只保留阶段 1 已加的 writer，不扩展。

**已核实的事实**：

- writer 插槽已在阶段 1 加入宿主适配（`--writer-model`、`--writer-effort`，Claude 宿主另有 `--writer-cli`）。
- Claude Code 会在 Bash 环境里提供 `CLAUDE_CODE_SESSION_ID`（本机核实），角色执行器可以按它认定同一个宿主会话。
- odai 现有的 Hooks 集成已为 Claude Code 和 Codex 生成可拦截的 `PreToolUse` 与 `Stop` 钩子：结束前拦截输出 `{"decision":"block","reason":…}`，工具前拦截用退出码 2；并遵守 `stop_hook_active`，防止死循环。
- 现有架构规则写明：“路由只注册宿主角色，不安装任务 runner 或隐藏的每轮 Hook”；项目护栏 Hooks 与路由是两套机制。

**结果**：

1. **Codex 宿主也能把非 controller 职责映射到本机 CLI。** 做法与 Claude Code 宿主已有的 `--<role>-cli` 相同。这样 Codex 当总控时，规划或审查可以交给本机的 claude、antigravity 等。
2. **宿主版会话续接。**
   - **本机 CLI 职责**：`run-role.mjs` 支持映射里的 `session: continue`，复用阶段 3 的共用适配器。键为宿主会话：Claude Code 用 `CLAUDE_CODE_SESSION_ID`；Codex 的对应来源要先核实，拿不到就声明不支持，或要求总控显式传 `--session-key`。
   - **原生子代理职责**：Claude Code 若支持向已派出的子代理继续发消息，就在生成的总控说明里写明“开启续接时继续同一个子代理，不新派”；要先在本机 CLI 版本上核实。Codex 原生角色能否续接也要核实，不能就声明不支持。
3. **点名识别移到共用脚本。** 识别规则从 DSH 运行时移到编排技能的共用脚本（与 `local-cli.mjs` 同类），DSH 通过随包 imports 引用，宿主 Hook（阶段 6）也用它，保证三处规则一致。

### 阶段 5 细化（总控，2026-10-27，阶段 4 验收后）

**补充核实的事实**：

- 本机 codex-cli 0.163.0 的原生程序里有 `CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_TOOL_CALL_ID` 这几个环境变量名，推测 Codex 会注入给它执行的命令，但还没实测。
- 同一程序里有 `sandbox_workspace_write` 和 `network_access` 配置项。Codex 的工作区沙箱默认是否允许联网，以及能否写工作区以外的目录（claude、agy 会写自己的状态和会话目录，例如 `~/.claude`、`~/.gemini`），都要先核实。

**实施要求**：

1. **共用识别脚本**：
   - 把 `recognizeNamedRequests` 和主导模式开关识别移到 `skills/odai-orchestration/scripts/` 下的共用脚本（`.mjs` + `.d.mts`）。
   - DSH 按现有方式（同 `compose-contracts.mjs`、`local-cli.mjs`）经随包 imports 引用，两个包都随包携带。
   - 行为必须完全不变，现有相关测试原样通过。
   - manifest 的 requiredFiles 同步。新增 required file 会改变编排内容，版本与 `0.2.3` 的关系按仓库规则处理：`0.2.3` 尚未发布，继续归入该候选。
2. **Codex 宿主映射本机 CLI**：
   - `build-routing.mjs` 和 `install-routing.mjs` 在 `--host codex` 下，同样接受非 controller 职责的 `--<role>-cli <claude|antigravity|grok>`，生成方式与 Claude 宿主已有的一致：执行器、共用模块副本、角色合同、路由清单、总控调用说明。
   - 先核实 Codex 总控在其沙箱里能否调用这些需要联网、需要写自身目录的 CLI。能用正常方式运行就直接接入。
   - 如果必须越出沙箱，不得由安装器悄悄放宽沙箱或开联网。改为在生成的说明和文档里写明三点：需要用户批准哪条命令越出沙箱，或用户自己在 Codex 配置里允许什么；放宽带来的影响；怎样撤回。
   - 核实不了的部分，列出需要总控实测的命令。
3. **宿主版会话续接**：
   - `run-role.mjs` 支持映射中的 `session: continue`，复用阶段 3 的共用适配器（claude、antigravity 支持；codex、grok 不支持）。
   - 键为（宿主会话、路由标识）。宿主会话按以下顺序取：
     1. Claude Code 用 `CLAUDE_CODE_SESSION_ID`（已核实存在）；
     2. Codex 用 `CODEX_THREAD_ID`（待实测）；
     3. 都没有时，要求总控显式传 `--session-key`；
     4. 仍然没有，就对 `continue` 明确报错。
   - 键与后端会话 ID 的对应关系，存放在安装目录下执行器自己的状态文件里，与 `role-evidence/` 同级。同一个键串行，用文件锁。续接失败时新开一次并在证据里注明。卸载时保留这些运行产物，与证据目录的处理一致。
   - 原生子代理：Claude Code 宿主生成的总控说明写明，该职责开启续接时，用 SendMessage 继续上次派出的同一个 `odai-<role>` 子代理，不新派。Codex 原生角色的续接，证据不足就声明不支持。
4. **默认不变**：不加 `--<role>-cli` 和 `session` 时，三个宿主的生成产物与现状逐字节一致，用现有测试或快照证明。
5. **测试**：
   - Codex 宿主带 `--reviewer-cli claude` 的构建、安装、卸载。
   - 执行器在两个宿主环境变量下的续接键：同一会话复用，不同会话隔离。
   - 显式 `--session-key`；缺键时报错；串行；续接失败后新开。
   - 共用识别脚本迁移后，DSH 的行为不变。
6. **真机核验（总控负责）**：GPT 在回报里列出命令，由总控执行。至少包括：
   - Codex 总控（`codex exec`，工作区沙箱）调用执行器跑一次 claude 职责；
   - Codex 下 `CODEX_THREAD_ID` 是否可见；
   - Claude Code 下执行器续接两次，第二次记得第一次的内容。

### 阶段 5 审查记录（总控，2026-10-27）

GPT 回报阶段 5 完成，完整验证只跑了一次：Runtime 459/459、Plugin 468/468、Agent 24/24、宿主路由 16/16 suites、版本策略 3/3，打包预览 228 和 245 个文件。

- **接受的偏离**：“默认产物逐字节一致”没有做到，因为编排包摘要和复制出去的执行器字节必然随本次修改变化。这一条的本意是默认行为不变，已由测试证明：省略 `session` 时仍为 fresh、带 `--no-session-persistence`，不生成 SendMessage 说明。所以接受这项偏离。

**真机核验（总控，本机，codex-cli 0.163.0、Claude Code 2.1.307、agy 1.4.7）**：

1. **Codex 宿主**：用 `build-routing --host codex --reviewer-cli claude --reviewer-session continue` 生成后，执行 `codex exec --sandbox workspace-write` 让总控运行执行器。
   - `CODEX_THREAD_ID` 会注入命令环境（实测值 `01a17cc5-…`）。
   - 执行器失败：`EPERM: operation not permitted, mkdir '…/.codex/role-evidence'`。Codex 沙箱即使在 workspace-write 下也不允许写 `.codex/`。
   - 绕过执行器，让 Codex 在同一沙箱里直接运行 `claude -p`：退出码 1，`duration_api_ms: 0`、`output_tokens: 0`，请求没有发出。
   - 结论：默认沙箱里，本机 CLI 职责必然失败。
2. **Claude Code 宿主**：用 `--reviewer-cli antigravity --reviewer-session continue` 生成后，由 `claude -p` 总控连续两次运行执行器。第一次交回“已记住。”，第二次交回 73129，两次的后端 `session_id` 相同，模型核实通过。
3. **原生子代理续接**：在 `claude -p` 中先派一个通用子代理记住数字，完成后用 SendMessage 续发。会话记录显示工具返回 `{"success":true,"message":"Resuming agent …"}`，子代理答出 73129。已完成的子代理同样可以续接。

**要求修正**：

1. **Codex 宿主的执行器状态目录挪出 `.codex/`**：
   - 证据和会话状态改放在工作区内、`.codex/` 之外，即项目根目录 `.odai/` 下的子目录，例如 `.odai/role-evidence/`、`.odai/role-sessions/`。用户级安装同样以当前项目为准。
   - Claude 宿主的位置保持不变。
   - 文档建议用户把这些目录加入 `.gitignore`，安装器不自动修改 `.gitignore`。
2. **Codex 宿主的说明按实测结果改写**：
   - 总控说明和 `install.md` 写明：默认 workspace-write 沙箱里，本机 CLI 职责实测会失败（无法联网，claude 返回零 token、退出码 1）。
   - 运行执行器时，按 Codex 自身的机制申请越出沙箱，并说明理由：需要联网，并写入本机 CLI 自己的目录。申请方式以 Codex 的帮助和已安装资料为准。
   - 用户拒绝或当前审批策略不允许时，如实报告该职责不可用，不改用别的模型。
   - 仍然不由安装器放宽沙箱或开启联网。
3. **证据用词统一**：
   - 执行器证据里的 `observed.session.mode`（`fresh`、`resumed`），改用与 DSH 回执一致的词：`created`、`resumed`、`resume-failed-created`。
   - 未开启续接时不写这一项，或明确写 `disabled`，不要用与配置值同名、含义不同的 `fresh`。
4. **SendMessage 说明更新**：说明里注明可以按子代理的名字或 agentId 续发，已完成的子代理也可以续发（本机 2.1.307 实测）。删除安装文档中“能否续发已完成子代理待核验”的保留说法。

**修正验收（总控，2026-10-27）**：四项修正已完成，完整验证在最终改动后跑了一次，全部通过：

- Runtime 459/459、Plugin 468/468、Agent 24/24、宿主路由 16/16 suites、版本策略 3/3；
- 打包预览 228 和 247 个文件。

总控真机复测（Codex 宿主，claude haiku 审查，开启续接）：

- **默认沙箱**：执行器把证据和续接状态写入项目 `.odai/role-evidence/`、`.odai/role-sessions/`，`.codex/` 下没有运行产物，也不再报 EPERM。claude 仍因不能联网失败（零 token，退出码 1），失败证据已记录，与说明一致。
- **模拟越出沙箱**：在本机终端去掉 `CLAUDE_CODE_SESSION_ID`，设 `CODEX_THREAD_ID`，直接运行执行器两次。第一次交回“记住了：73129”，第二次交回 73129；证据依次为 `created`、`resumed`，`session_id` 相同，模型核实为 `claude-haiku-5-5`。
- **未测**：交互式 Codex 中“申请越出沙箱 → 用户批准”这一环，需要用户本人在交互界面操作。

阶段 5 验收通过。

**遗留小问题，并入阶段 6a**：执行器固定先读 `CLAUDE_CODE_SESSION_ID`、再读 `CODEX_THREAD_ID`。如果在 Claude Code 里启动 Codex，会继承前者，Codex 宿主就会用错会话键。应按清单的宿主优先读对应的变量，另一个作为后备。

## 阶段 6：Claude Code 与 Codex 宿主（下）：可选路由 Hook（阶段 5 验收后细化再实施）

**结果**：在 Claude Code 和 Codex 宿主上提供点名必达和主导模式，靠用户明确开启的路由 Hook 实现。

- **开启方式**：
  - 安装器新增开关，例如 `--named-dispatch`、`--lead-mode`。开启时才生成和安装路由 Hook，使用独立的托管清单，可更新、检查漂移、卸载；不开启时与现状完全一致。
  - 路由 Hook 与项目护栏 Hooks 分开，互不依赖。
  - 现有架构规则“路由只注册宿主角色，不安装任务 runner 或隐藏的每轮 Hook”改为：默认不装；用户明确开启时，安装声明式的路由 Hook，写明它做什么、怎样卸载。这项规则改动在 CHANGELOG 写明理由（用户要求宿主版具备同样能力）。
- **点名必达**：
  - **识别**：用阶段 5 的共用识别脚本，从宿主提供的对话记录里读最新的用户消息。Claude Code 的钩子输入里有对话记录路径；Codex 的要核实。
  - **开始时的点名**：用 `PreToolUse` 在第一次写类工具调用前拦截，说明“用户点名先让某职责做什么、怎样调用”，直到有该职责的调用证据为止。
  - **做完时的点名**：用 `Stop` 拦截，每个点名最多拦一次，并遵守 `stop_hook_active`。
  - **调用证据**：本机 CLI 职责看执行器写的证据文件，原生子代理看对话记录里的调用；各宿主的取证方式要核实。
- **主导模式**：
  - 开关状态按宿主会话保存在安装目录下的状态文件里。
  - 开始时派规划、做完时派审查、审查有问题时再修再审（最多 2 轮），都用上面的 Hook 机制实现。
  - 插槽缺失和调用失败的处理与阶段 4 一致。

### 阶段 6 细化（总控，2026-10-27，阶段 5 验收后）：拆成 6a（点名必达）和 6b（主导模式）

**补充核实的事实**：codex-cli 0.163.0 的原生程序里有 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStop` 等事件名，以及 `hook_event_name`、`prompt`、`transcript_path`、`stop_hook_active`、`last_assistant_message` 等字段名，与 Claude Code 的钩子同形。odai 现有的护栏 Hooks 已为两个宿主生成过可拦截的 `PreToolUse` 与 `Stop`：Claude Code 写在设置里，Codex 以插件形式提供 `hooks/hooks.json`，用户须安装并信任。

**6a：点名必达的路由 Hook（本次实施）**：

- **开关**：
  - `build-routing.mjs` 和 `install-routing.mjs` 新增 `--named-dispatch`，只对 `--host claude` 和 `--host codex` 有效。
  - 不加这个开关时，生成产物与现状一致。
  - 路由 Hook 与项目护栏 Hooks 分开，各有自己的托管清单，可以共存。
- **装在哪里**：
  - **Claude 宿主**：经现有的设置合并机制，把 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 写进设置的 hooks。更新、漂移检查和卸载只动自己加的条目。
  - **Codex 宿主**：按 Codex 的 Hook 加载方式提供。先核实 Codex 是否有项目级 Hook 配置；没有就沿用护栏 Hooks 的插件形式，生成插件目录，并写明用户要安装、信任它的步骤。安装器不代替用户执行信任。
  - 两个宿主的 Hook 都以执行器同目录的脚本运行（例如 `odai-route-hook.mjs`），识别规则复用阶段 5 的共用识别脚本，随包复制。
- **行为（与 DSH 版一致）**：
  - **识别**：`UserPromptSubmit` 时用共用识别脚本识别点名，插槽映射取自路由清单。
  - **记录**：按宿主会话（钩子输入里的 `session_id`）记录本任务的点名，状态目录放在 `.claude/` 下，Codex 宿主放项目 `.odai/` 下。
  - **提示总控**：向总控输出一段说明，包括被点名的职责、时机，以及怎样调用（原生子代理的名字，或执行器命令）。
  - **开始时的点名**：用 `PreToolUse` 拦住写类工具。调用该职责本身的工具调用（派 `odai-<role>` 子代理，或运行 `odai-run-role.mjs --role <role>`）放行。用 `PostToolUse` 确认调用成功后，才算满足。
  - **做完时的点名**：用 `Stop` 拦截，每个点名最多拦一次，并遵守 `stop_hook_active`。
  - **未配置或名字不符**：只提示，不拦截。
  - **新任务**：新的用户消息取代尚未执行的点名，“继续”类消息保留。
- **写类工具判断**：
  - Claude：`Edit`、`Write`、`MultiEdit`、`NotebookEdit`、`Bash` 算写类，`Read`、`Glob`、`Grep` 等算只读。
  - Codex：以其工具名为准（例如 shell、apply_patch 类），先核实。
  - 分不清的按写类处理。
- **会话键优先级修正**（阶段 5 遗留）：执行器按清单的宿主优先读对应变量，另一个作为后备。
- **文档与规则**：
  - README、MAINTAINING 和 `install.md` 中“路由只注册宿主角色，不安装任务 runner 或隐藏的每轮 Hook”，改为“默认不装；用户明确开启 `--named-dispatch` 时安装声明式的路由 Hook”，并写明它做什么、怎样卸载。
  - CHANGELOG 写明这项规则变更的理由：用户要求宿主版具备同样的能力。
- **测试**：
  - 用伪造的钩子输入覆盖：识别后输出说明、拦截写类、放行职责调用、`PostToolUse` 后放行、`Stop` 拦一次、`stop_hook_active`、新任务取代、未配置和名字不符只提示。
  - 安装、更新、卸载只动自己的条目，与护栏 Hooks 共存。
  - 默认不加开关时产物不变。
- **真机核验（总控负责）**：GPT 列出命令，由总控在临时项目里用 `claude -p` 实测点名必达。Codex 侧能用 `codex exec` 测的也一并列出。

**6a 审查记录（总控，2026-10-27）**：

GPT 回报 6a 完成，完整验证只跑了一次，全部通过：Runtime 459/459、Plugin 468/468、Agent 24/24、宿主路由 16/16 suites、版本策略 3/3、护栏 Hooks 测试、打包预览 229 和 248 个文件。“默认产物不能宣称逐字节不变”与阶段 5 是同一类情况，接受。

**真机核验**（Claude Code 2.1.307）：在临时项目里用 `install-routing --host claude --named-dispatch` 安装（controller、planner、reviewer 均为 haiku），用 `claude -p --setting-sources project,local --include-hook-events` 下达“先让 Claude 规划，在当前目录创建 hello.txt，内容为 hello；做完让 Claude 验收”。

- **正常的部分**：
  - `UserPromptSubmit` 注入了 planner（动手前）和 reviewer（完成时）的说明，总控第一步就派了 `odai-planner`。
  - `Stop` 第一次以 `decision: block` 催 reviewer，第二次（`stop_hook_active`）放行，没有死循环。
- **问题 1：子代理在后台运行**：
  - 本机 Claude Code 的 Agent 工具返回的是“Async agent launched successfully”。`PostToolUse:Agent` 在启动时就触发了，这时规划还没回交。
  - 总控随即结束本轮，`Stop` 在这个时刻消耗了 reviewer 唯一的一次催办。这时还什么都没做，催得太早，之后也不会再催。
- **问题 2：后台结果送回时被当成新任务**：
  - 后台子代理完成后，宿主以一条用户角色的消息送回结果，内容以 `<task-notification>` 开头（含 `<task-id>`、`<tool-use-id>`），会话记录中的来源是 `{kind: "task-notification", producer: "session-task"}`。
  - 这触发了 `UserPromptSubmit`，Hook 把它当作新的用户任务，取代了尚未执行的点名。状态文件里的 `requests` 变成空数组，reviewer 最终一直没被调用。
- **测试本身的问题，与 Hook 无关**：本次 `claude -p` 没有给写入权限，所以 `hello.txt` 没有写成。复测要加 `--permission-mode acceptEdits`。

**6a 修正要求**：

1. **区分宿主通知和用户新任务**：
   - `UserPromptSubmit` 收到宿主通知类内容时，按“继续”处理：不识别点名，不取代待办。这类内容包括以 `<task-notification>` 开头的消息，以及其他宿主注入的系统消息（依据本机 Claude Code 资料和上面的实测格式）。
   - Codex 有对应机制时同样处理，先核实。
2. **后台启动不算完成**：
   - 职责子代理以后台方式启动时，只记为“进行中”，并记下工具调用 ID。
   - 收到对应工具调用 ID 的完成通知、且状态为完成时，才算满足；失败或取消按失败处理，提示总控说明。
   - Codex 的 `spawn_agent` 按已实现的“等待 completed”处理。
3. **有点名进行中时，`Stop` 不消耗完成时的催办**：
   - 本任务还有开始时的点名未满足，或有职责正在后台进行时，`Stop` 直接放行，不计入“已催”。后台完成后宿主会再唤醒总控。
   - 只有前序点名都已满足或明确失败后，`Stop` 才对完成时的点名催一次。
4. **Codex 插件的本地登记格式**：
   - 可以只用隔离的临时 `CODEX_HOME`（不得触碰 `~/.codex`），运行 `codex plugin marketplace add <生成目录>` 和 `codex plugin add <插件>@<来源名>`，确定生成目录需要的 marketplace 清单格式。
   - 这两条命令不调用模型，属于允许的核实。
   - 据此让安装器生成可以直接登记的本地来源目录。文档给出用户要执行的两条命令，以及在交互式 Codex 中信任 Hook 的步骤。安装器不代替用户执行这些命令。
5. **测试**：
   - 用实测格式的通知消息作为 fixture，覆盖：后台启动后 `Stop` 放行且不计催办；完成通知使点名满足；完成通知不取代待办；全部前序满足后 `Stop` 才催完成时的点名。
   - 补充本机 Claude Code 同步回交的情形。

**6a 第一次修正后的复测（总控，2026-10-27）**：

GPT 完成五项修正，验证全部通过。Codex 本地来源已在临时 `CODEX_HOME` 中登记成功，插件为 `odai-named-dispatch@odai-local-routing`。

用 `--permission-mode acceptEdits` 复测 Claude：

- **端到端结果正确**：先派 `odai-planner`（后台），完成通知送回后才写 `hello.txt`（内容为 hello），然后同步调用 `odai-reviewer` 验收，最终答复逐项说明。
- **仍有问题**：planner 还在后台时，`Stop` 已经催了 reviewer，说明后台启动没有被识别出来。

原因：Hook 用会话记录里的文本前缀 “Async agent launched successfully.” 来识别，但 `PostToolUse` 实际收到的 `tool_response` 是结构化对象。如果总控在规划回来之前就写文件，写入前的拦截也会因此失效。

**实测的钩子输入**（Claude Code 2.1.307，用转存钩子抓取）：

- **后台启动**：`PostToolUse` 输入里，`tool_input.run_in_background` 为 `true`，`tool_response` 为：

  ```json
  {"isAsync": true, "status": "async_launched", "agentId": "ae03…", "resolvedModel": "claude-haiku-5-5", "outputFile": "…/tasks/ae03….output", "canReadOutputFile": true, "canContinueAgent": true}
  ```

- **同步完成**：`tool_response` 为：

  ```json
  {"status": "completed", "agentId": "a666…", "agentType": "general-purpose", "content": [{"type": "text", "text": "好"}], "resolvedModel": "claude-haiku-5-5", "totalDurationMs": …, "totalTokens": …, "usage": {…}}
  ```

- **`PostToolUse` 的顶层字段**：`session_id`、`transcript_path`、`cwd`、`scratchpad_dir`、`prompt_id`、`permission_mode`、`effort`、`hook_event_name`、`tool_name`、`tool_input`、`tool_response`、`tool_use_id`、`duration_ms`。
- **完成通知**：`UserPromptSubmit` 的 `prompt` 为：

  ```text
  <task-notification>
  <task-id>{agentId}</task-id>
  <tool-use-id>{与 PostToolUse 的 tool_use_id 相同}</tool-use-id>
  <output-file>…</output-file>
  <status>completed</status>
  <summary>…
  ```

  钩子输入里没有 `origin` 字段，会话记录里才有。

**6a 第二次修正要求**：

1. **后台启动**：以 `tool_response.isAsync === true` 或 `tool_response.status === "async_launched"` 判定，记下 `tool_use_id` 和 `agentId`。原有的文本前缀规则保留作后备。
2. **同步完成**：`tool_response.status === "completed"` 才算满足；其他状态不算。
3. **完成通知**：优先按 `<tool-use-id>` 匹配，其次按 `<task-id>` 等于 `agentId` 匹配。`<status>` 为 `completed` 才算满足，失败、取消和缺失按现有规则处理。
4. **实际模型**：把 `tool_response.resolvedModel` 记入状态。提示总控在最终答复里按它说明各职责实际用的模型，不要采用子代理的自报（复测中 planner 自称 Sonnet 5.5，`resolvedModel` 实为 `claude-haiku-5-5`）。与映射明显不符时提示；不拦截，也不重试。
5. **测试**：用上面三种实测形态做 fixture，覆盖：后台启动期间 `Stop` 放行且不计入已催、写入前拦截生效；通知到达后满足；同步完成直接满足；`resolvedModel` 的记录与提示。

**6a 第二次修正验收（总控，2026-10-27）**：五项修正完成，完整验证只跑了一次，全部通过（Runtime 459/459、Plugin 468/468、Agent 24/24、宿主路由 16 suites、护栏 Hooks、打包预览 229 和 248 个文件）。

总控在 Claude Code 2.1.307 上复测了两次，haiku 当总控、planner 和 reviewer：

- **同步路径**：规划 → 写 `hello.txt` → 验收。两次 `PostToolUse:Agent` 都记录了 `resolvedModel: claude-haiku-5-5`，最终答复按宿主记录说明了实际模型，`Stop` 放行，状态里两个点名都是 `satisfied`。
- **后台路径**：消息里要求规划用后台运行，并让总控先试着直接建文件。
  - planner 以 `bg: true` 启动；总控随即调用 Bash 写文件，被 `PreToolUse` 拦下，理由是规划回交前不得动手。
  - 规划进行中的 `Stop` 放行，没有消耗验收的催办。
  - 完成通知到达后，planner 算作满足；接着写文件、同步调用 reviewer 验收，最终答复按宿主记录说明了实际模型，两个点名都是 `satisfied`。

**Codex 侧**：插件已在临时 `CODEX_HOME` 中登记成功。在交互界面里信任 Hook 之后的端到端运行，需要用户本人在交互式 Codex 中完成，记为未验证。

**6a 验收通过。**

**6b：主导模式的路由 Hook（已细化，实施中）**：

- **开关**：
  - `build-routing.mjs` 和 `install-routing.mjs` 新增 `--lead-mode`，只对 claude 和 codex 有效，可以与 `--named-dispatch` 同时使用。
  - 两者共用同一套 Hook 脚本、状态文件和托管清单，不装第二套。
  - 不加这个开关时，生成产物和行为都不变。
- **共用**：
  - 开关识别继续用共用识别脚本里的 `recognizeLeadSwitch`。
  - VERDICT 解析（阶段 4 放宽后的规则）移到同一个共用脚本，DSH 改为引用它，行为不变。
- **开启和关闭**：
  - `UserPromptSubmit` 识别开关，状态按宿主会话保存，规则与阶段 4 相同：点名要和插槽匹配；只配了一个插槽就只做一半；都没配就提示、不开启。
  - 开关变化时注入说明：已开启或关闭、由哪个插槽和模型规划与审查、怎样关闭。
  - 宿主通知类消息不算开关，也不算新任务。
- **按需规划**：
  - 主导模式开启后，每个新任务中第一次写类工具调用，都要先满足规划插槽。
  - 写类判断和 6a 相同；规划的调用、进行中和满足的判断也复用 6a。
  - 后台规划进行中时，`Stop` 放行，不消耗催办。
  - 只读问答不触发。
- **按需审查与循环**：
  - 本任务有成功的写类动作时，`Stop` 时要求调用审查插槽。注入的说明要求总控在派审查时写明：最后单独一行写 `VERDICT: pass` 或 `VERDICT: changes-requested`。
  - 从审查回交中解析结论：原生子代理取 `PostToolUse` 的 `tool_response.content` 文本，或后台完成后的输出；执行器取它的标准输出或输出文件。
  - 结论为 `changes-requested` 时，下一次 `Stop` 要求总控按审查意见修正，修正中有新的写入后，再要求审查一次。
  - 最多再审 2 轮。结论无效时不追加轮次，提示总控在最终答复里说明。
  - 每一步都受“每项最多催一次”和 `stop_hook_active` 的约束。
- **与点名的关系**：同一职责、同一时机的点名和主导模式只派一次。
- **失败**：调用失败或模型不符时不拦截、不重试，提示总控如实说明。
- **测试**：
  - 用 6a 的实测输入形态做 fixture，覆盖：开关正反例；按需规划（含后台）；只读不触发；有写入才审查；pass 时结束；changes-requested 时修正、再审，最多 2 轮；结论无效；与点名合并；默认不开时不变。
  - DSH 改用共用 VERDICT 解析后，原有测试通过。
- **真机核验（总控负责）**：在 Claude Code 上复测开启主导模式后的一个小任务。

**6b 审查记录（总控，2026-10-27）**：

GPT 回报 6b 完成，完整验证只跑了一次，全部通过（Runtime 459/459、Plugin 468/468、Agent 24/24、宿主路由 16 suites、护栏 Hooks、打包预览 229 和 248 个文件）。VERDICT 解析已迁入共用脚本，DSH 原有的 24 条解析测试未改动，全部通过。

**真机核验**（Claude Code 2.1.307，haiku）：安装时只带 `--lead-mode`，然后下达“开启主导模式。在当前目录创建 hello.txt，内容为 hello。最终说明规划和审查的宿主实际模型。”这次刻意没有替总控写 VERDICT 要求。

- **正常的部分**：
  - `UserPromptSubmit` 注入了开启说明。
  - 总控第一次 Write 和随后的 Bash 都被 `PreToolUse` 拦下，要求先规划；派出 `odai-planner` 后才放行，写入成功。
  - reviewer 被调用；两个职责都记录了 `resolvedModel: claude-haiku-5-5`。
  - `Stop` 放行，没有死循环。
- **问题**：总控在 `Stop` 之前就主动派了 `odai-reviewer`。开启说明只有“已开启、哪个插槽和模型、怎样关闭”，没有讲每个任务的流程和 VERDICT 格式，所以总控派审查时没有要求结论行，回交被判为 `invalid`，修正循环形同虚设；结束时也没有提示总控说明结论无效。
- **另记**：最终答复声称审查的模型“宿主没有给出 resolvedModel”，其实 Hook 已经注入。这是 haiku 当总控时没有遵循提示，属于模型能力问题，不是 Hook 的缺陷。

**6b 修正要求**：

1. **每个任务开始时讲清流程**：主导模式开启期间，每个新的用户任务（不含宿主通知）都在 `UserPromptSubmit` 注入一段简短的流程说明：
   - 第一次改动前先派规划插槽；
   - 有改动时做完派审查插槽；
   - 派审查时，要求对方最后单独一行写 `VERDICT: pass` 或 `VERDICT: changes-requested`；
   - 最终答复按宿主记录说明实际模型。

   开关变化时的说明也包含这一段。只配了一个插槽时，只讲那一半。`PreToolUse` 拦截规划和 `Stop` 要求审查时，理由里也带上 VERDICT 格式要求。
2. **结论无效时提示一次**：审查回交的结论为 `invalid` 且尚未提示过时，`Stop` 拦一次，理由写明“审查回交没有可识别的 VERDICT 行，请在最终答复里如实说明审查结论未按格式给出”。不追加审查轮次，并受 `stop_hook_active` 约束。
3. **测试**：覆盖每个新任务都注入流程说明，宿主通知不注入；主动提前审查时沿用已有的流程说明；结论无效时拦一次、只拦一次。

**6b 修正验收（总控，2026-10-27）**：三项修正完成，完整验证只跑了一次，全部通过（Runtime 459/459、Plugin 468/468、Agent 24/24、宿主路由 16/16 suites、版本策略 3/3、护栏 Hooks，打包预览 229 和 248 个文件）。

**真机复测**（Claude Code 2.1.307，haiku）：用同一句话下达任务，仍然不替总控写 VERDICT 要求。

- 第一次写类动作被 `PreToolUse` 拦下，理由里带有 VERDICT 格式要求。
- planner 在后台运行期间，`Stop` 放行，不消耗催办；完成通知到达后满足。
- 写入 `hello.txt` 后，`Stop` 以 block 要求审查，总控派 `odai-reviewer` 时主动写明了 VERDICT 要求。
- reviewer 在后台完成后，解析出 `VERDICT: pass`，状态为 `round 0`、`satisfied`。
- 最终答复按宿主记录，说明两个职责的实际模型都是 `claude-haiku-5-5`。

**6b 验收通过，计划全部阶段完成。**

## 收尾状态（总控，2026-10-27）

- **版本**：
  - 全部改动在工作区，未提交、未发布。
  - 候选版本为双包 `0.2.57`、编排 `0.2.3`；治理 `0.7.1` 与 runtime contract `9` 不变。
- **未经真机验证的部分**：
  - DSH 版点名必达、会话续接、主导模式，只经过宿主探针（伪造模型流）和单元测试，没有在用户真实的 DSH profile 里用真实模型跑过。要跑，需先把 `0.2.57` 装进 profile：发布后更新，或经用户授权做本地安装。
  - Codex 宿主在交互界面里信任 Hook 之后的端到端运行，需要用户本人操作。
- **已知限制**：
  - 主导模式把任意 bash 和未知工具都算作写类，没有改成按实际 diff 判断。
  - agy 1.4.7 在无界面模式下，被拒的动作会让输出为空（已通过改写提示减少触发）。
  - Agent 测试中有两条 YAML `!!js` 标签警告，测试通过。
- **建议的用户配置**（在 DSH 里用自然语言设置，示例模型只是一种配置）：
  - 规划、审查、创意 → 本机 claude opus，开启会话续接；
  - 写作 → 本机 antigravity gemini-3.8-flash，推理档 high，开启会话续接；
  - 前端保持现状；
  - 需要时在会话里说“开启主导模式”。

**暂不做（以后再评估）**：给宿主版加可写的“执行”插槽，即 Claude Code 当总控、把实施连同写权限交给 GPT。现有职责全部只读，这一项要改变“实施归总控”的核心约束，单独设计。

## 后续检查：点名的模型名匹配要通用

阶段 2 计划里的名字别名表只列了 Claude、Gemini、GPT、Codex、Grok。审查阶段 2 时要确认：除别名表外，点到的名字只要出现在某个插槽的 provider、model 或 cli 标识里（不区分大小写），也算匹配，例如 “Kimi” 匹配 `kimi-coding`，“DeepSeek” 匹配 `deepseek-v4-pro`。没做到就在阶段 3 一起补上。

## 验证命令

- `node scripts/validate-odai-skill.mjs`
- `npm run check:dsh`
- `node --test dsh/runtime/tests/*.test.mjs`
- `node scripts/test-odai-routing.mjs`
- `npm --prefix dsh/plugin test`、`npm --prefix dsh/agent test`
- `npm run test:version-policy`
- `npm --prefix dsh/plugin run pack:dry-run`、`npm --prefix dsh/agent run pack:dry-run`。跑完确认没有遗留生成目录。
- `git diff --check`

## 边界

- **能改什么**：只改 odai 仓库受版本控制的文件。`cli/` 冻结，不改、不测、不打包。
- **不做的动作**：
  - 不 `npm publish`，不 `git commit`。
  - 不改 `~/.dsh` 下的任何东西，包括 `odai/routing.json` 和各 profile，也不装进真实 profile。
  - DSH 源码与 `node_modules/@deepseek-ai/*` 只读。
- **测试方式**：不调用真实 CLI，一律用伪造可执行文件。
- **不扩范围**：
  - 不改 creative 合同正文。
  - 不改与本计划无关的触发规则。
  - 发现相邻问题列进回报，不顺手修。
- **偏离计划**：实现上要偏离计划（例如复用现有机制做不到某条时机规则）时，在回报里写明原因和替代做法，不悄悄改验收。

## 阶段 1 审查记录（总控，2026-10-27）

GPT 回报的验证全部通过：Runtime 333/333、Plugin 342/342、Agent 24/24、宿主适配 15/15 suites、版本策略 3/3、打包预览两项。已发布 `0.2.56` 制品中的 24 个编排文件与修改前 HEAD 逐字节一致。合同、编排条目、overlay 三段原样文本经核对一致。

审查发现三项问题，要求修正：

1. **配置 writer 后，creative 字面触发过宽。** `writingResponsibility` 只要短句里出现方向类名词就返回 creative，不要求任何动作。用编译后的 `decideRoute` 实测（creative、writer 均已配置），下列句子全部被派给 creative；未配置 writer 时全部不触发：
   - 这个玩法挺好的
   - 你的名字叫什么
   - 这个点子不错，先记下
   - I have some ideas about the refactor
   - check the balance first
   - 改一下项目名称
   - 这个创意来自用户反馈
   - 我们用这个名字当包名吧
   - the gameplay loop feels slow, profile it
   - 用户说玩法太难了

   起因是计划原文“方向类对象一律归 creative，不看动词”有歧义，已改正。修法：方向类判断改为 `direction.test(clause) && hasCreativeRequest(clause)`。总控在编译产物副本上验证过：计划正反例全部保持，上面 10 条全部不再触发。这 10 条要加进反例测试。
2. **旧编排包按版本号特判放行，派发 writer 时会抛错。** `compose-contracts.mjs` 对“版本 0.2.2 且缺 writer”的清单放行，`skill-bundle.mts` 也跳过缺失的职责。之后若 writer 已配置而选中的是旧包，`lifecycle-runtime.mts` 中的 `dshRoleContract("writer", undefined)` 会在 pre-step 里抛出，且没有捕获，不会可见回退。这偏离了计划要求的 creative 先例（完整名单校验，旧包判为不兼容，回退内置版本）。修法：删掉这两处特判；把测试改为断言缺 writer 的旧清单校验失败，且技能选择可见地回退到内置版本。
3. **writer 的缺口提案路径少了信号。** 其余职责都会记录 `evidence-grounded-responsibility-gap` 与 `state:<digest>`，writer 这条也要补上。

另外顺带补一处：CHANGELOG 的 0.2.56 条目按以往格式，写上“下载制品的编排文件与对应提交逐字节一致”这一核对结果。

## 阶段 2 第一次运行记录（总控，2026-10-27）

- **三项修正已完成**：受影响测试 37/37 通过。总控复测：6 条 writer 正例、4 条 creative 正例照常触发，15 条反例（含审查新增的 10 条）全部不触发。旧包按版本号特判的代码已删除。GPT 另外核实：当前 `resolveSkillSelection` 只从外部发现治理包，忽略相邻的编排目录，所以“选中旧编排包”在现有发现机制下实际碰不到。
- **阶段 2 按停止条件停下**：
  - 宿主探针显示，在 `assistant/message` 事件里调用 `owner.inject` 后，本轮直接以 `completed` 结束，没有出现第二个 step。
  - 总控随后查了 DSH 源码（只读），原因如下：`inject` 只把消息放进下一步，不会叫醒智能体。一轮即将结束时，主循环会先等 `agent/turn-stopping` 的监听者执行完；只有其中调用了 `steer`，这一轮才会继续。
  - 计划已改用 `agent/turn-stopping` + `agent.steer`。
- **相邻发现（不在本计划范围，不修，只报告）**：现有的 same-turn 职责“结束回复缺回交 → 注入恢复说明”也是在 `assistant/message` 里调用 `owner.inject`（`lifecycle-runtime.mts` 的 `responsibility-return-missing` 分支）。按上面的分析，这一轮不会接着运行；而 `dsh/README.md` 写的是“automatically continues on the restored controller route”。要不要修，由用户决定。

## 阶段 2 审查记录（总控，2026-10-27）

GPT 回报阶段 2 完成，验证全部通过：Runtime 377/377、Plugin 386/386、Agent 24/24、宿主路由 15/15 suites，打包预览两项通过。宿主探针在 DSH `0.2.1-rc.2` 上证实，`agent/turn-stopping` 中调用 `agent.steer` 后，同一轮出现第二个 step。计划例表逐条符合预期。

与计划不同、经审查接受的两处：

- **开始时的点名多等一步**：等 DSH 正式接纳用户消息后才记录点名，期间用工具守卫（`ODAI_NAMED_START_PENDING`）阻止总控抢先动手。
- **完成时的点名逐项催**：每次 stopping 只催排在最前的一项，每项仍最多催一次。

总控用编译后的 `recognizeNamedRequests` 实测日常说法，发现识别有四个问题，要求修正：

1. **整条消息一票否决，造成漏判。** 消息里任何位置出现“以后、默认、配置、映射、推理档、订阅、开关、测试、单元测试”等词，所有点名都作废。下列 5 条都返回空：
   - 做完让 Claude 验收，记得跑测试
   - 先让 Claude 规划一下配置文件的迁移
   - 先让 Claude 规划，做完跑一下单元测试，再让 Claude 验收
   - 做完让 Claude 验收，默认分支是 main
   - 先让 Claude 规划一下这个开关怎么实现

   修法：去掉整条消息级别的否决，改为按短句判断。
   - **配置语句**：只否决本身是配置语句的那个短句，复用 `ROUTING_CONFIG_CUE` 一类判断，以及“以后、今后…都”这类长期偏好。
   - **修饰用法**：委派短语前面还有别的动词短语（如“给 odai 加一个”“写一下”），而整个委派短语是在修饰后面的名词时，不算点名。
   - **能算点名的位置**：委派说法要出现在短句开头。前面只允许出现时机词（先、再、然后、最后、做完、写完、改完、完成后、之后）、礼貌词（麻烦、请你、你），或者一个简短的话题词（如“文案让 Gemini 写”里的“文案”）。
2. **没有委派对象的请求被当成点名，造成误判。** 下列 3 条都被识别成了点名：
   - 请审查一下这段代码 → reviewer
   - 请规划一下路线 → planner，而且开始时守卫会拦住总控
   - 请调查一下这个报错的原因 → researcher

   起因是“规划、审查、调查、创意、写作、前端”在“请、让、用、叫、找”后面被当成了职责名，其实它们在这里是动作。修法：这些中文职责词只有在以下情况才算委派对象：
   - 跟在“交给”后面，如“交给审查”；
   - 带“职责”后缀，如“审查职责”；
   - 写的是英文职责名（planner、reviewer 等）。

   其他情况一律当作动作，交给总控自己处理。
3. **创意语境串到验收上。** “让 Claude 定方向，GPT 实现，做完让 Claude 验收代码”被识别为 `creative@completion`，应为 `reviewer@completion`。修法：前文的创意语境只把“审、把关、评估、看看”这类品味审查归给 creative；“验收、复核、检查”仍归 reviewer，除非同一短句里有创作对象。
4. **模型名只认固定别名。** “做完让 Kimi 验收”识别不出来，不符合“插槽可配置”的原则（见计划中“后续检查”一节和 AGENTS.md“职责与模型插槽”）。修法：除别名表外，再从已配置插槽的 provider、cli 标识，以及 model 标识开头的字母段（如 `deepseek-v4-pro` 的 `deepseek`、`gpt-6-astra` 的 `gpt`、`kimi-coding` 的 `kimi`），动态生成可识别的名字，不区分大小写。不配置就不识别，也不能把普通英文词当成名字。

修正后，上面 13 条和计划原有的正反例都要入测，并且全部符合预期。

**修正验收（总控，2026-10-27）**：四项修正已完成。

- 总控用编译产物复测：
  - 前述 5 条漏判全部能识别。
  - 3 条误判全部不再触发。
  - 创意语境串味的那条改为 `creative@start` → `reviewer@completion`。
  - 动态名字：审查插槽配 `kimi-coding` 时，“做完让 Kimi 验收”识别为 reviewer；规划插槽配 `deepseek` 时，“先让 DeepSeek 规划一下”识别为 planner。名字与插槽不符时给出 `mapping-mismatch`。“coding”“pro”这类模型标识里的普通词不被当成名字。
- 验证结果：
  - Runtime 396/396、Plugin 405/405、Agent 24/24、宿主路由 15/15 suites、版本策略 3/3、`validate-odai-skill`、`check:dsh`、`git diff --check` 均通过。
  - 两项打包预览在 GPT 的沙箱里因 npm 缓存写入权限失败。总控在本机用隔离缓存（`npm_config_cache` 指向临时目录）补跑通过：Plugin 218 个文件，Agent 237 个文件，无遗留生成目录。
- 计划中“后续检查：点名的模型名匹配要通用”一项已在本次完成。
- 阶段 2 验收通过。

其他未决项，记录在案，本次不处理：

- GPT 额外跑的 Agent `verify:dsh` 第一次输出成功后返回 1，复跑返回 0，原因未定位。这一项不在计划的验证命令里。
- 相邻的 same-turn 恢复问题留到阶段 3 修复。

## 回报要求

用中文。内容包括：

- 改了哪些文件；
- 每条验证命令的结果和通过数；
- 与计划不一致之处及原因；
- 已发布 0.2.56 编排文件的核对结果；
- 未决问题。
