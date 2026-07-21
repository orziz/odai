# Changelog

本文只记已冻结版本的对外能力、架构、迁移和评测口径。试跑、复跑、中间分和临时输出不进入本日志；原始证据由临时运行目录与 Git 历史承担。

## 2026-07-20 — 实证成事重构

### 架构

- 以“事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为”统一总纲；用 `事｜实｜法｜成｜界` 持续判断目标、依据、路径、验收与边界，不把它们机械化为阶段或输出模板。
- 将治理融入从理解到交付的执行过程；保留直达、纠偏、展开与守险四档自适应力度，简单任务不交流程税，证据、风险或长期依赖变化时再升降。
- 能力面收敛为 `planning`、`design`、`delivery` 与 `review`；将外部 skill、项目规则、agent 和多模型协作合并到 `leverage`，将正式与收敛审查合并到 `review-modes`。
- 退役 `feature-plan`、`design-spec`、`diagnose`、`implement-code`、`review-sslb`、`composition`、`coordination`、`audit-loop`、`review-full` 与 `recipes/` 专属模块。README、报告和提交说明等普通产物改为直接服从任务与仓库约定。
- 保留只答不写、明确局部修改、根因授权、高影响参数停止门、证据三态、生产边界和真实验成等关键纪律；支撑资料继续按真实缺口渐进加载。

### 评测

- 将二元通过口径升级为 0–4 完成度乘预设权重：全量 12 题满分 88，A/B 8 题满分 56；严重越权、生产风险与虚报验证使用硬封顶。
- A/B on 从相同指纹、题面、fixture 与 runner 配置的全量结果直接抽取；off 保持独立基线，并继续记录逐题缺口、runner token、支撑读取和确定性检查。
- 当前全量 on：GPT-5.6-sol / high 与 Grok 4.5 为 88/88，Claude Opus 4.8 为 83/88，Qwen 3.8 Max Preview 为 85/88，Kimi K3 为 77/88，GLM-5.2 为 70/88，DeepSeek V4 Pro 为 71/88，MiMo 2.5 Pro 为 68/88。
- 当前 A/B 加权净增：GPT +15、Opus +11、Grok +19、Qwen +9、K3 -1、GLM +8、DeepSeek V4 Pro +12、MiMo +9。公开保留负增益与 token 成本，不把辅助 pass 或满分 on 单独表述为普遍价值证明。

### 维护与迁移

- CLI 路由、治理来源、临时打包、测试与 canonical skill 校验均已同步到新目录；`skills/odai/` 仍是唯一可编辑事实源，`cli/skills/` 只在打包期间临时生成。
- Claude runner 在同一 session 出现多个 `result` 事件时累加全部 usage，避免自动续跑只记录最后一段 token。
- 自定义叠加层若引用已退役路径，需要迁移到新的责任文件；不提供旧路径别名，避免维护第二套架构。
- README、维护说明、题本、评测契约和当前结果均已更新；当前指纹与逐题数据见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

## 2026-07-16 — r7

### 架构

- 定位为治理内核驱动的通用任务执行框架：治理融入每次判断、行动、验证与收口，不在执行之前制造额外仪式。
- 将多模块路由收敛为单一自适应主流程：判断、行动、验证、收口；按任务明确度、风险和证据动态收放。
- 保留“道可道”、谋定而后动、模型即谋士、六字诀与道儒心兵法五家合一，但不把它们拆成角色或工作流。
- 支撑资料重组为 `dao/`、`capabilities/`、`domains/`、`recipes/`、`techniques/` 和 `assets/`，实现渐进加载。
- 退役 `references/modules/` 以及 `game-plan` / `game-design` 专属路由。游戏任务改由通用规划、设计和实时交互能力自动承接。
- 保留自动发现、外部 skill 借力、项目 `.odai/local.md` 叠加、长任务恢复、agent 协作、合议和增强档，均改为条件触发。

### 评测

- 冻结 12 题全量现实委托与 8 题配对 A/B，覆盖 direct、judgment、complex 和 boundary 四层。
- 题面不针对 odai 模块出题；关键事实放在代码、日志、brief、diff、任务状态和 runbook 中。
- harness 补齐独立 fixture、确定性副作用门、多模型 runner、deferred judge、指纹和 token 统计。
- C04 在不改用户题面、fixture、确定性只读门或 skill 的前提下澄清裁判边界：明确标为待验证假设 / 实验候选且不实施的数值可通过；无证据生产值或直接落地仍失败。
- GPT-5.5、Grok 4.5 和 Kimi K3 的全量 on 均为 12/12；GPT-5.5、Claude Opus 4.8、Claude Sonnet 5、Claude Fable 5、Grok 4.5 与 GLM-5.2 的 A/B on 为 8/8。完整横向结果见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

### 维护与迁移

- `skills/odai/` 继续是唯一 canonical source；不维护平台镜像或常驻 `cli/skills/`。
- 公开评测记录统一收口到 `docs/evaluation-results.md`，退役 `plans/odai-canary-results.md`。
- 自定义叠加层若引用了旧模块路径，需迁移到新责任目录；不提供旧路径别名，避免形成第二架构。

本日志从 r7 开始；更早历史保留在 Git tags 与 commit 记录中。
