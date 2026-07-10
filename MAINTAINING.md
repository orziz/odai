# 维护说明（Maintaining odai）

> 这份文档面向**维护这个仓库的人**。只是想用 `odai` 的话，看 [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md) 就够了。

## 唯一真相在哪

source-of-truth 全部在 `skills/` 下，没有任何多端镜像产物：

```text
skills/odai/             统一入口 source skill
  SKILL.md               入口正文
  agents/openai.yaml     宿主 UI 元数据
  references/modules/    内部模块正文（dao、game-*、feature-plan 等）
  references/*/          模块级规则、说明等 support files
  assets/*/              模块级模板等资源
skills/skill-author/     仓库 source 作者维护 skill
plans/                   金丝雀测试口径与结果记录
scripts/                 仓库维护与评测 harness
assets/                  README 配图
```

分发统一走 [skills.sh](https://skills.sh) 标准（`npx skills add …`），canonical source 直接读 `skills/`，不生成 / 维护 `.claude/`、`.github/`、`.trae/` 等各端安装产物。`cli/skills/odai/` 是 npm 包的 bundled fallback snapshot，不是第二 source；只能由 `node cli/scripts/sync-skill-snapshot.mjs` 从 canonical source 生成，并用 `--check` 防止漂移。

## 命名约定

内部模块按「对象 / 层级 + 工作类型」命名：

- `dao`：默认调度路线
- `game-*`：游戏策划与游戏视觉设计
- `feature-*`：需求规划、方案规划、问题诊断
- `design-*`：设计说明、交互、页面、流程、状态
- `implement-*`：代码实现、补测试、落地总结
- `project-*`：项目级说明、规则、基线、README 整理
- `review-*`：代码审查
- `skill-*`：仓库维护工具，作为独立 skill 放在 `skills/<skill-name>/SKILL.md`

补充：

- 模块 id 默认用小写 kebab-case 英文，方便跨工具、跨平台和路径复用。
- 默认调度模块在文案里统一写 `道`；模块 id、frontmatter `name` 和文件名都保持 `dao`；提示词里写 `道` 或 `dao` 都算命中同一个模块。
- 给人看的说明、分类和文案，优先用中文写清楚职责和场景。
- 新增「用户任务」能力，默认收进 `odai` 的内部模块；新增「仓库维护」能力，默认做成独立的 `skill-*` 工具。

## 维护流程

内部模块正文只写自己这一域的职责、交付骨架、边界和 support file 的触发条件。入口、README、交互契约、术语基线这些全局规则已经定过的，模块正文优先引用，不要再拷一遍。全局判据默认采用指针式挂法：完整规则只铸在 canonical 文件，卫星模块只写触发场景和指向；确需重复判据时，改动必须 `rg` 全部副本并同步。

规则增长纪律的 owner 是 `skills/skill-author/SKILL.md` 的「规则增长纪律」；维护本仓库 source 时按该节执行，本文不另写扩展条件。

推荐顺序：

1. 用 `skill-author` 新增或改写 `skills/<skill-name>/SKILL.md`，或 `skills/odai/references/modules/<module-name>.md`。
2. 需要时补 `skills/odai/references/<module-name>/`、`skills/odai/assets/<module-name>/`、`skills/odai/scripts/<module-name>/`。
3. source 稳定后，分发交给 skills.sh（`npx skills add`）；canonical source 就是 `skills/` 本身，无需再生成任何安装产物。

改入口、路由门、交互契约、实施准入、验收口径、agent 治理或 canary 用例后：

1. 跑 `node scripts/validate-odai-skill.mjs` 检查 frontmatter、UI 元数据、资源引用和长规则预警。
2. 跑 `node cli/scripts/sync-skill-snapshot.mjs`，再跑 `node cli/scripts/sync-skill-snapshot.mjs --check` 确认 bundled snapshot 无漂移。
3. 至少跑 `node scripts/odai-canary-harness.mjs --smoke` 检查 fixture / prompt 生成。规则小改且环境可用时跑 `--smoke --run`，大改跑全量；用户默认模型与本机 CLI 不兼容时，用 `--model <本机缓存中的兼容模型>` 同时覆盖 runner / judge。把日期、commit / 工作区状态、fail 条目和一句现象回写 `plans/odai-canary.md`。

标准安装入口：

- `skills/odai/SKILL.md`
- `skills/skill-author/SKILL.md`

## Skills 一览

### 面向大多数使用者

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `odai` | 以道为总控，提供意图对齐、边界授权、验收真实性、跨阶段接力、agent 治理和领域 playbook 的统一入口 | 复杂任务接单、方向裁决、规格规划、游戏策划、游戏视觉设计、设计说明、代码实现、代码审查、agent 下放与成果整理 | `skills/odai/SKILL.md` |

### 仓库维护工具

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `skill-author` | 维护本仓库 skill source，把能力整理成可分发的标准 skill 或模块资源 | 新增 skill、改写 skill、沉淀 prompt 或 workflow、维护 odai 内部模块与 support files | `skills/skill-author/SKILL.md` |

### `odai` 内部模块

这些名字可以在提示词里直接点名。若已明确点名模块又给了任务对象（比如「按 `review-sslb` 审这个 diff」），`odai` 会直接落到对应模块；其他情况优先让 `道` 按语义挑模块、定产物。

| 模块 | 作用 | 对应文件 |
| --- | --- | --- |
| `dao`（文案里写作 `道`） | 默认调度 workflow（通用总控，不分领域），负责方向、边界、主路、第一步与复核 | `skills/odai/references/modules/dao.md` |
| `game-plan` | 全域游戏策划主模块：系统、玩法、数值、经济、商业、关卡与内容规划 | `skills/odai/references/modules/game-plan.md` |
| `game-design` | 完整游戏视觉设计主模块：UI/UX/UE、角色场景、宣传品牌与特效演出 | `skills/odai/references/modules/game-design.md` |
| `feature-plan` | 规格规划、方案取舍、bug 诊断 | `skills/odai/references/modules/feature-plan.md` |
| `design-spec` | 页面、交互、状态、视觉与体验说明 | `skills/odai/references/modules/design-spec.md` |
| `implement-code` | 代码实现、修 bug、补测试、重构落地 | `skills/odai/references/modules/implement-code.md` |
| `project-guide` | README、规则、AI 接手基线与项目级说明 | `skills/odai/references/modules/project-guide.md` |
| `review-sslb` | 三省六部式代码审查 | `skills/odai/references/modules/review-sslb.md` |
| `ribao` | 日报、commit message、PR message 整理 | `skills/odai/references/modules/ribao.md` |
