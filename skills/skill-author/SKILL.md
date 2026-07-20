---
name: skill-author
description: 维护本仓库的 skill source、渐进资源结构和相关仓库说明。在新增、修改、重构、迁移或退役 `skills/` 下的 skill，odai 内核 / reference / asset，以及同步 README、维护口径、验证和冻结日志时使用。
---

维护本仓库 skill 的 canonical source，不参与 odai 运行时调度。仓库结构、冻结契约、验证命令和日志口径以根目录 `MAINTAINING.md` 为准。

## 先定对象

写入前先锁定唯一 owner：

| 对象 | 位置 |
|---|---|
| 独立公开 skill | `skills/<skill-name>/SKILL.md` |
| odai 总纲、主流程、核心门、加载地图 | `skills/odai/SKILL.md` |
| 授权、验证、连续性、借力与协作 | `skills/odai/references/dao/` |
| 规划、设计、诊断与交付、代码审查 | `skills/odai/references/capabilities/` |
| UI 与实时交互领域工艺 | `skills/odai/references/domains/` |
| 条件触发的重型方法 | `skills/odai/references/techniques/` |
| agent 产物模板 | `skills/odai/assets/` |
| 宿主 UI 元数据 | `skills/<skill-name>/agents/openai.yaml` |
| 使用、维护、冻结变更 | `README*`、`MAINTAINING.md`、`CHANGELOG.md` |

`references/modules/`、`references/game-plan/`、`references/game-design/`、`references/recipes/` 和旧模块专属目录已退役，不得作为新落点或兼容别名恢复。能力文件统一为 `planning / design / delivery / review`；协作与能力组合归 `dao/leverage.md`，重型审查归 `techniques/review-modes.md`。游戏需求进入通用 capability 和 `domains/interactive-systems.md`，不再新建独立游戏路由。

## 判断新增、修改或退役

1. 用户已点名对象或路径时，先检查现有 source；高相似能力默认并入现有 owner，不新开平行版。
2. 新增公开触发能力、独立工具集或需自主安装的能力，才倾向新 skill。
3. 只是 odai 在某类任务中需要的工艺，放入现有责任目录，不把目录变成用户必选模块。
4. 只有重复使用且需确定性执行的逻辑才新增 script；只有会被 agent 直接复用于交付的内容才新增 asset。
5. 只在规则有可观察负担、重复或误导，且行为可由更上位原则稳定覆盖时退役；修改冻结行为契约须经用户明确决定。

## 编写原则

1. public `SKILL.md` frontmatter 只保留 `name` 和 `description`；`description` 同时说清做什么、何时触发。
2. `SKILL.md` 只写必须全程在场的流程、判据、底线和加载指针；详细工艺放 reference，避免重复。
3. reference 目录是责任分层，不是调度模块。写明何时需读，不为完整感默认全读。
4. 优先使用命令式、可观察的行为表述；不把口号、方法名或文件数当成能力。
5. 同一定义只有一个 owner。其他文件只保留当层动作和指向；确需复制时，同步检查所有副本。
6. 变更 `SKILL.md` 定位、触发或用户可见描述后，检查 `agents/openai.yaml` 是否仍一致。

## 规则增长纪律

1. 新增硬法、触发词或例外前，先定位唯一 owner，并说明它来自哪个真实需求或可复发失败。
2. 规则预算默认不扩张：优先合并、替换、删除或降级旧规则；不为模型波动追加同义句。
3. 减重是结果而非独立目标。不为过 token 线删除有证据的能力，也不为规避评测增加题本特化句。
4. 方法论如 SDD / TDD / BDD、agent、合议和正式计划保持条件使用，不因名字单独升级为一级路由。
5. 宿主和用户权限、真实性与高风险动作门不得被下位规则绕过；总纲也不无条件豁免，若失败证据显示其反复诱导错误行为，须在维护授权下重审。

## 文档与冻结同步

source 大改后立即审计：

- README 的定位、架构图、内部地图、安装和评测摘要是否仍准确。
- `MAINTAINING.md` 的 owner 路径、验证命令、冻结和日志口径是否仍准确。
- `CHANGELOG.md` 是否记录了对外能力、架构和迁移，且没有混入试跑过程。
- 冻结评测是否只在 `docs/evaluation-results.md` 保留当前指纹的最终结果。

文档纠错如果不改变 skill、题本、fixture、失败门、judge 或结果，不需重建评测基线；运行时或契约变更必须开新版。

## 验证与交付

1. 修改 odai source 后运行 `node scripts/validate-odai-skill.mjs`。
2. 修改题本 / fixture / harness 后，分别生成 full 与 A/B dry-run，并确认同 ID 对齐。
3. 修改发布 / 打包路径时运行 `npm --prefix cli run pack:dry-run`，并确认无 `cli/skills/` 残留。
4. 运行 `git diff --check`，检查本地 Markdown 链接与旧路径引用。
5. 结果先说改了什么、为什么，再报验证、冻结是否受影响和真实剩余问题。

分发统一走 skills.sh。不手工维护平台镜像、临时 package snapshot 或平行结果文件。
