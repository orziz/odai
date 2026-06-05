# odai

`odai` 是一套 AI 技能（skill）合集，用一个入口帮你搞定规划、设计、代码审查、写代码、写总结、游戏策划和游戏视觉设计这些活儿。

你不用记一长串技能名。把需求丢给 `odai`，它内部有个叫 `道` 的"调度员"：先读懂你想干什么，再决定走哪个模块、产出什么东西；信息不够就先问清楚再动手。

- **用它干活**：只需要 `odai` 一个入口。
- **维护这个仓库**：另有两个独立工具——`skill-author`（写/改技能）和 `skill-sync`（多端同步）。

> 当前 `main` 分支装的是这套统一入口。想用更早的"一个能力一个技能"的旧结构，可以装 `old` 分支（见[如何安装](#如何安装)）。

## 快速导航

- [30 秒上手](#30-秒上手)
- [这是什么](#这是什么)
- [适合谁用](#适合谁用)
- [如何安装](#如何安装)
- [`odai` 怎么用更顺](#odai-怎么用更顺)
- [Skills 一览](#skills-一览)
- [面向维护者](#面向维护者)

## 30 秒上手

1. 把 `odai` 装进当前环境：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

（想装整个仓库、或换成精简版 / 旧结构，见[如何安装](#如何安装)。）

2. 直接把任务交给 `odai`。第一句尽量带上三样：**目标**（想要什么）、**材料**（手上有什么）、**约束**（不能碰什么、必须满足什么）。说不清该走哪个模块也没关系，`道` 会先帮你判断。
3. 如果心里已经有数，想走哪条路也可以直接点名，比如：

- "用 `odai` 接这个需求，先判断该走哪个模块，拿不准就问我。"
- "用 `odai` 走 `道`，先把边界和主路定下来。"
- "用 `odai` 按 `harness-dev` 一路推进到结果总结。"
- "用 `odai` 按 `review-sslb` 审这个 PR。"
- "用 `odai` 用 `ribao` 整理今天的产出。"

## 这是什么

可以把 `odai` 理解成一个"会自己分流的技能工具箱"：

- **对外只有一个入口。** 你不用挑技能，`道` 替你判断这次该走哪个模块、该给你一句短判断、一份草案、一张设计稿、一份审查结论、一张执行单，还是直接开干。
- **内部是一组分工明确的模块。** 规划、设计、审查、写代码、游戏策划、游戏视觉、写总结……需要哪个调哪个。
- **`道` 是默认的总调度。** 如果是偏开发推进的活，还有一条 `harness-dev` 路线专门接。

几条值得先知道的事实：

- 用户任务只认 `odai` 这一个安装入口；维护仓库用的是另外两个工具 `skill-author` / `skill-sync`。
- 多端（Claude / Copilot / Trae）的安装版本由同一个脚本同步生成，尽量不让各端长期跑偏。
- 旧的"多技能并列"结构已经搬到 `old` 分支，仍需要的话可以单独装。

## 适合谁用

符合下面任意一条，这个仓库就会比较顺手：

- 想把常用的 prompt 和 workflow 收成一个入口，懒得记一串技能名
- 想让 AI 在规划、设计、审查、实现之间自己选路往下走
- 喜欢先让一个"调度员"定好方向、边界和第一步，再交给具体模块去做
- 想保留多种审查风格和 workflow，但不想再维护一堆并排的安装入口
- 经常要整理 README、项目规则、AI 接手说明，或日报 / commit / PR 描述
- 同时在用 Claude、Copilot、Trae，希望几端的安装结构保持一致

## 如何安装

### 1. 自动安装（推荐）

只装统一入口（大多数人选这个）：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

适合：想快速把入口接进环境、不想手动复制一堆文件、平时直接用 `odai` 触发内部模块。

其他几种装法，按需选：

```bash
# 连同仓库里的其他技能一起装
npx skills add https://github.com/orziz/odai

# 更省 token 的精简版（mini 分支）
npx skills add https://github.com/orziz/odai#mini

# 旧的"多技能并列"结构（old 分支）
npx skills add https://github.com/orziz/odai#old
```

什么时候选 `old` 分支：你还在用旧入口、需要 `harness-dev` / `harness-dao` 等旧分支里的独立安装方式，或者正在做旧结构的迁移对照。

### 2. 手动安装

如果不走 `npx`，按平台把文件复制到对应位置即可。

#### Claude

- `.claude/commands/odai.md`
- `.claude/commands/odai/`
- 可选维护工具：`.claude/commands/skill-author.md`、`.claude/commands/skill-sync.md`

复制好后，在输入框里用：

- `/odai`
- `/skill-author`
- `/skill-sync`

#### Copilot

- `.github/skills/odai/SKILL.md`
- 可选维护工具：`.github/skills/skill-author/SKILL.md`、`.github/skills/skill-sync/SKILL.md`

几点说明：

- Copilot 版按"一个 skill 一个目录"组织。
- `odai` 带有 `references/`、`assets/`、`scripts/` 等附属目录，**必须连同整个目录一起复制**——`SKILL.md` 里的相对路径靠这个目录结构才能用。
- `skill-author` 与 `skill-sync` 是独立维护工具，目前都是单文件 skill。

> `copilot-instructions.md` 更适合放项目级全局说明，不适合承载这种多文件 skill。

#### Trae

- `.trae/skills/odai.md`
- `.trae/skills/odai/`
- `.trae/rules/odai.md`
- `.trae/rules/odai/`
- 可选维护工具：`.trae/skills/skill-author.md`、`.trae/skills/skill-sync.md`、`.trae/rules/skill-author.md`、`.trae/rules/skill-sync.md`

`rules` 和 `skills` 的区别：

- `rules`：每次对话都会读取，适合想让入口长期持续生效的内容。
- `skills`：靠指令或自然语言触发，适合按任务临时点名某个内部模块。

## `odai` 怎么用更顺

`odai` 不是把所有模块机械地串一遍，而是先由 `道` 判断你这次真正缺的是哪一层、该调哪个模块、该产出什么形态，再去读对应模块继续干。

内部有两条主线：

- **`道`**：默认调度。更适合"先定方向、边界、主路和第一步"，也负责挑模块、定产物形态。
- **`harness-dev`**：开发类的外层 workflow。更适合"接住开发需求、做诊断、判断怎么推进、然后一路往下做"。

也可以越过调度，直接点名单个模块：

- `game-plan`：游戏系统、玩法、数值、经济、商业、关卡与内容规划
- `game-design`：完整游戏视觉设计——UI/UX/UE、角色场景、宣传品牌、特效演出
- `feature-plan`：写规格、做方案取舍、诊断 bug
- `design-spec`：页面、交互、状态、视觉、体验说明
- `implement-code`：边界已经清楚后的写代码、修 bug、补测试、重构落地
- `project-guide`：README、项目规则、AI 接手基线
- `review-sslb`：三省六部式代码审查（旧的多种审查风格已经并到这一个入口）
- `ribao`：日报、commit message、PR message

维护这个仓库本身时，用另外两个独立工具：

- `skill-author`：写/改 `skills/` 下的 source skill 和 `odai` 的内部模块
- `skill-sync`：把 Claude / GitHub / Trae 的安装产物同步出来，并回写 README

几个好用的触发示例：

- "用 `odai` 接这个需求：先判断走哪个模块和产物形态，拿不准就问我。"
- "用 `odai` 先用 `道` 把边界、主路和关键风险定下来，再往下推。"
- "用 `odai` 按 `harness-dev` 处理这个实现问题，推进到结果总结。"
- "用 `odai` 用 `project-guide` 整理这个仓库的 AI 接手基线。"

## 默认交互方式

仓库里那些会主动向你补关键信息的模块，默认都遵守一条交互约定（`skills/odai/references/dao/interaction-contract.md`）：

- 动手前先列清楚：当前理解、已经验证的事实、还没确认的点、必须你拍板的问题。
- 能用结构化提问就用结构化提问；如果通道不支持，会说明限制后改成文字、成组地问。
- 收到你的回答后，默认直接接着干当前这一步，不会再等你补一句"继续"。

## Skills 一览

只是来用这个仓库的话，不必把下面整张表看完——记住 `odai` 这一个入口通常就够了。

### 面向大多数使用者

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `odai` | 以道为总控，把规划、游戏策划、游戏视觉设计、通用设计、审查、实现与总结收束成一个统一入口，并按需调用内部模块 | 复杂任务接单、方向裁决、规格规划、游戏策划、游戏视觉设计、设计说明、代码实现、代码审查与成果整理 | `skills/odai/SKILL.md` |

### 仓库维护工具

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `skill-author` | 维护本仓库 skill source，把能力整理成可同步的标准 skill 或模块资源 | 新增 skill、改写 skill、沉淀 prompt 或 workflow、维护 odai 内部模块与 support files | `skills/skill-author/SKILL.md` |
| `skill-sync` | 基于 skills/ 下的 source 生成各端安装版本，并对 README 做最小范围回写 | skill source 定稿后的多端同步、同步检查、README 回写、安装产物清理、source 统计与路由表生成 | `skills/skill-sync/SKILL.md` |

### 内置模块

这些名字仍然可以在提示词里直接点名。如果你已经明确点名了模块、也给了任务对象（比如"按 `review-sslb` 审这个 diff"或"用 `ribao` 整理 commit message"），`odai` 会直接落到对应模块，由模块自己的交互规则兜底；其他情况还是优先让 `道` 按语义来挑模块、定产物。

| 模块 | 作用 | 对应文件 |
| --- | --- | --- |
| `dao`（文案里写作 `道`） | 默认调度 workflow，负责方向、边界、主路、第一步与复核 | `skills/odai/references/modules/dao.md` |
| `harness-dev` | 开发类调度 workflow，负责按 SDD / BDD / TDD 判断主驱动并持续推进 | `skills/odai/references/modules/harness-dev.md` |
| `game-plan` | 全域游戏策划主模块：系统、玩法、数值、经济、商业、关卡与内容规划 | `skills/odai/references/modules/game-plan.md` |
| `game-design` | 完整游戏视觉设计主模块：UI/UX/UE、角色场景、宣传品牌与特效演出 | `skills/odai/references/modules/game-design.md` |
| `feature-plan` | 规格规划、方案取舍、bug 诊断 | `skills/odai/references/modules/feature-plan.md` |
| `design-spec` | 页面、交互、状态、视觉与体验说明 | `skills/odai/references/modules/design-spec.md` |
| `implement-code` | 代码实现、修 bug、补测试、重构落地 | `skills/odai/references/modules/implement-code.md` |
| `project-guide` | README、规则、AI 接手基线与项目级说明 | `skills/odai/references/modules/project-guide.md` |
| `review-sslb` | 三省六部式代码审查 | `skills/odai/references/modules/review-sslb.md` |
| `ribao` | 日报、commit message、PR message 整理 | `skills/odai/references/modules/ribao.md` |

## 面向维护者

只是使用 `odai` 的话，这一节可以先跳过。

### 命名约定

内部模块按"对象 / 层级 + 工作类型"来命名：

- `dao`：默认调度路线
- `game-*`：游戏策划与游戏视觉设计
- `feature-*`：需求规划、方案规划、问题诊断
- `design-*`：设计说明、交互、页面、流程、状态
- `implement-*`：代码实现、补测试、落地总结
- `project-*`：项目级说明、规则、基线、README 整理
- `review-*`：代码审查
- `harness-*`：偏开发推进的 workflow
- `skill-*`：仓库维护与同步工具，作为独立 skill 放在 `skills/<skill-name>/SKILL.md`

几条补充：

- 模块 id 默认用小写 kebab-case 英文，方便跨工具、跨平台和路径复用。
- 默认调度模块在文案里统一写 `道`；模块 id、frontmatter `name` 和文件名都保持 `dao`；提示词里写 `道` 或 `dao` 都算命中同一个模块。
- 给人看的说明、分类和文案，优先用中文写清楚职责和场景。
- 新增"用户任务"能力，默认收进 `odai` 的内部模块；新增"仓库维护"能力，默认做成独立的 `skill-*` 工具。

### 维护流程

内部模块正文只写自己这一域的职责、交付骨架、边界和 support file 的触发条件就够了。入口、README、交互契约、术语基线、`skill-sync` 这些地方已经定过的全局规则，模块正文优先引用，不要再拷一遍。

推荐顺序：

1. 用 `skill-author` 新增或改写 `skills/<skill-name>/SKILL.md`，或 `skills/odai/references/modules/<module-name>.md`。
2. 需要时补 `skills/odai/references/<module-name>/`、`skills/odai/assets/<module-name>/`、`skills/odai/scripts/<module-name>/`。
3. source 稳定后，先用 `node scripts/skill-sync.js --check` 检查 source、README 与安装产物是否一致，再用 `skill-sync` 或 `node scripts/skill-sync.js` 同步 Claude / GitHub / Trae 的安装版本并回写 `README.md`。脚本会先校验术语基线、并行 support files、README 关键分节、README 模块引用和禁用旧口径。
4. 需要更新维护材料时，用 `node scripts/skill-sync.js --stats` 看 source 体积统计，用 `node scripts/skill-sync.js --route-map` 重新生成 `plans/odai-route-map.md`。

标准安装入口：

- `skills/odai/SKILL.md`
- `skills/skill-author/SKILL.md`
- `skills/skill-sync/SKILL.md`

## 目录说明

```text
skills/odai/           统一入口 source skill
	references/modules/  内部模块正文
	references/*/        模块级规则、说明等 support files
	assets/*/            模块级模板等资源
	scripts/*/           模块级脚本资源（按需）
skills/skill-author/   仓库 source 作者维护 skill
skills/skill-sync/     仓库多端同步维护 skill
scripts/               仓库维护脚本
.claude/commands/      Claude 手动安装版本
.github/skills/        GitHub / Copilot 适配版本
.trae/skills/          Trae skill 版本
.trae/rules/           Trae rule 版本
assets/                README 配图
```

## 效果展示

![效果展示 1](./assets/image_0.png)
![效果展示 2](./assets/image_1.png)

## 参考与致谢

部分命名方式、组织思路和玩法形式参考过下面这些项目，在此一并致谢：

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)

欢迎 star，也欢迎提 PR 一起补充更好用的 skill 和 workflow。
