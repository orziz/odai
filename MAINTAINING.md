# 维护说明（Maintaining odai）

> 本文面向仓库维护者。普通使用请看 [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md)。

## 当前冻结版

- 架构 / 评测标签：`2026-07-16-r7`。
- 运行时 skill、全量题本、A/B 题本与 evaluation harness 按 [`docs/evaluation-results.md`](docs/evaluation-results.md) 中的指纹冻结。
- `r7` 是仓库的 skill / 评测冻结标签，不是 `cli/package.json` 的 npm 版本。
- 2026-07-17 在不改题面、fixture、确定性门或 skill 的前提下，C04 做过一次同版裁判纠偏：明确标为待验证假设 / 实验候选且不实施的数值可通过，无证据生产值仍失败；旧失败需定向复核。除此之外，不用新模型结果回改 r7；再有实质变更须开新标签、重建基线，不得跨指纹混算。

## 单一事实源

```text
AGENTS.md                         仓库级维护约束
skills/odai/                      odai canonical source
  SKILL.md                        自适应内核、底线与加载地图
  agents/openai.yaml              宿主 UI 元数据
  references/dao/                 授权、验证、连续性、协作、组合
  references/capabilities/        规划、设计、诊断、实施、审查
  references/domains/             UI 与实时交互领域工艺
  references/recipes/             项目指南、日报 / commit / PR 等点名产物
  references/techniques/          合议、长审计、完整审查等可选重工艺
  assets/                         跨会话状态与任务账本模板
skills/skill-author/              本仓库的 source 维护 skill
docs/evaluation.md                稳定评测契约
docs/evaluation-results.md        当前冻结结果的唯一公开记录
plans/odai-canary.md              12 题全量题本
plans/odai-ab-smoke.md            8 题配对 A/B 题本
plans/odai-blind*                 可复用匿名横评定义
scripts/                          校验、runner、judge 与 harness
CHANGELOG.md                      冻结版的架构 / 维护变更日志
```

`skills/odai/` 是 odai 唯一可编辑源。`cli/skills/odai/` 只能由 npm `prepack` 临时生成，`postpack` 后必须清理；它不提交、不手改、不是第二份 source。仓库也不维护 `.claude/`、`.github/`、`.trae/` 等平台镜像产物；分发统一走 [skills.sh](https://skills.sh)。

## 当前架构口径

odai 只有一条自适应主流程：**判断 → 行动 → 验证 → 收口**。目录是渐进加载的责任分层，不是互相调度的子工作流。

| 需求 | 唯一 owner |
|---|---|
| 总纲、主流程、直达 / 纠偏 / 深度切换、最小底线、加载地图 | `skills/odai/SKILL.md` |
| 授权、验证、长任务、agent 协作、外部能力与项目叠加 | `references/dao/` |
| 规划、设计、诊断、代码实施、代码审查 | `references/capabilities/` |
| UI 或游戏 / 仿真 / HUD / 实时输入反馈 | `references/domains/` |
| README、项目指南、日报、commit / PR 文案 | `references/recipes/` |
| 不默认启用的重型方法 | `references/techniques/` |
| 跨会话可恢复状态 | `assets/` |

已退役的 `references/modules/`、`references/game-plan/`、`references/game-design/` 以及各旧模块专属目录不得恢复。游戏是通用规划、设计和交互系统能力覆盖的任务领域，不是用户需选的独立包。

`feature-plan`、`design-spec`、`implement-code`、`review-sslb`、`project-guide`、`ribao` 是 `/odai` 内的兼容性点名能力，不是必经路由，也不是独立安装包。

## 修改纪律

1. 先锁定唯一 owner，再改文字。同一判据不在多文件并行完整展开。
2. 新规则必须来自可复发的真实需求或失败证据；优先合并、替换或降级旧规则，不用同义句堆适配。
3. `SKILL.md` 只保留内核、必须高注意的门和资源导航；细节放到按需 reference。
4. 修改 `SKILL.md` 的触发语义、产品定位或宿主展示文案时，同步检查 `agents/openai.yaml`。
5. 不为缩 token 而删能力，也不为完整感增文件；只看净价值、可发现性和行为证据。
6. 冻结版发现实质问题时，记为下一版候选；除维护说明中已记录的 C04 单次裁判纠偏外，不直接编辑 r7 来追当前分数。

## 验证与评测

普通 source / 文档修改至少运行：

```bash
node scripts/validate-odai-skill.mjs
git diff --check
```

改 harness 或 runner 时补充：

```bash
node --check scripts/odai-canary-harness.mjs
node --check scripts/openai-compatible-canary-runner.mjs
```

改 skill、fixture、题本或确定性门时，先分别生成全量与 A/B fixture / prompt：

```bash
node scripts/odai-canary-harness.mjs --plan plans/odai-canary.md --out /tmp/odai-full-dry-run
node scripts/odai-canary-harness.mjs --plan plans/odai-ab-smoke.md --out /tmp/odai-ab-dry-run
```

只有运行时语义或评测契约发生实质变化，才建立新版并重跑所需模型。相同模型的 on / off 必须使用同一题面、fixture、推理档和独立 judge。CLI footer token 只能在同一 runner 的 on / off 内比较。

原始 transcript、diff、status、manifest 和单次 report 留在 `.tmp/` 或临时目录，不进仓库。仓库只在 [`docs/evaluation-results.md`](docs/evaluation-results.md) 保留当前指纹的最终结果，不记轮次过程，不恢复 `plans/odai-canary-results.md`。

发布 / 打包相关修改还必须运行：

```bash
npm --prefix cli run pack:dry-run
test ! -e cli/skills
```

这一步确认 npm 产物包含临时 bundled `skills/odai`，且 `postpack` 没有留下第二 source。

## 日志与提交

- [`CHANGELOG.md`](CHANGELOG.md) 只记冻结版的对外能力、架构、迁移与评测口径；不记试跑、复跑、临时模型故障或中间分。
- [`docs/evaluation-results.md`](docs/evaluation-results.md) 只记当前冻结指纹下的最终横向结果。
- commit 标题说最终结果；大版本正文至少说明架构、迁移、题本 / harness、验证和冻结指纹。
- 实验性过程证据由 `.tmp/` 与 Git 历史承担，不在 README、plan 或 skill 中复制一份时间线。

## 安装与分发

对外标准入口是：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

canonical source 保持在 `skills/`；使用者 README 说“怎么用”，本文说“怎么维护”，skill 本体只放 agent 完成任务必需的运行时内容。
