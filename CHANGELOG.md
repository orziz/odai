# Changelog

本文只记已冻结版本的对外能力、架构、迁移和评测口径。试跑、复跑、中间分和临时输出不进入本日志；原始证据由临时运行目录与 Git 历史承担。

## 2026-07-16 — r7

### 架构

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
- GPT-5.5 和 Grok 4.5 的全量 on 为 12/12；GPT-5.5、Claude Opus 4.8、Claude Sonnet 5、Claude Fable 5、Grok 4.5 与 GLM-5.2 的 A/B on 为 8/8。完整横向结果见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

### 维护与迁移

- `skills/odai/` 继续是唯一 canonical source；不维护平台镜像或常驻 `cli/skills/`。
- 公开评测记录统一收口到 `docs/evaluation-results.md`，退役 `plans/odai-canary-results.md`。
- 自定义叠加层若引用了旧模块路径，需迁移到新责任目录；不提供旧路径别名，避免形成第二架构。

本日志从 r7 开始；更早历史保留在 Git tags 与 commit 记录中。
