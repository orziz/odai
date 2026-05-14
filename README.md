# odai

一个把规划、通用设计、审查、实现、总结、游戏策划、游戏视觉设计与仓库维护收束成单一入口 skill 的仓库。

这个仓库对外只有一个安装入口：`odai`。该走哪个模块、做到什么产物形态，都先由 `道` 按用户语义/目标/约束/想法判断；拿不准就先结构化问清。

当前 main 分支承载的是统一入口 `odai`。如果你还需要分离出来的旧多 skill 结构，请改装 `old` 分支。

## 快速导航

- [30 秒上手](#30-秒上手)
- [当前结构](#当前结构)
- [适合谁用](#适合谁用)
- [这是什么](#这是什么)
- [如何安装](#如何安装)
- [`odai` 怎么用更顺](#odai-怎么用更顺)
- [默认交互方式](#默认交互方式)
- [Skills 一览](#skills-一览)
- [面向维护者](#面向维护者)

## 30 秒上手

1. 先把统一入口 skill 接进当前环境：

```bash
npx skills add https://github.com/orziz/odai
```

如果你要继续使用分离出来的旧多 skill 结构，可以改装 `old` 分支：

```bash
npx skills add https://github.com/orziz/odai#old
```

2. 直接用 `odai` 接任务；首轮输入尽量带上 `目标`、`材料`、`约束`。如果你还说不清具体要走哪个模块，也没关系，`道` 会先判断。
3. 如果你已经知道自己想走哪种内部模块，也可以在指令里直说：

- “用 `odai` 接这个需求，先判断该走哪个模块，如果拿不准就结构化问我。”
- “用 `odai` 走 `道` 看这个需求，先定边界和主路。”
- “用 `odai` 接这个需求，按 `harness-dev` 路线推进到结果总结。”
- “用 `odai` 按 `review-sslb` 风格审这个 PR。”
- “用 `odai` 用 `ribao` 模块整理今天的产出。”

## 当前结构

- 对外安装和触发都只认 `odai`。
- `道` 是默认总控，负责判断当前该走哪个模块，以及该输出短判断、草案、设计、审查、执行单还是直接推进。
- 源文件结构以 `skills/odai/` 为唯一 source-of-truth，模块正文与 support files 都收进这个目录下。
- 仓库结构、source-of-truth 与同步流程属于维护者说明，统一放在 README 和维护模块里，不再混写进 `odai` 入口技能正文。
- 同步脚本只分发当前统一入口 skill，并保持 Claude / GitHub / Trae 产物一致；Codex 暂无专用出包，故源正文保持宿主无关。
- 旧的多 skill 布局已分离到 `old` 分支，供仍需旧结构的安装场景继续使用。

## 适合谁用

如果你刚好有下面这些需求，这个仓库会比较顺手：

- 想把常用 prompt 和 workflow 收成一个统一入口，而不是记一串技能名
- 想让 AI 在规划、设计、审查、实现之间自动选主路继续推进
- 想先由一个总控判断方向、边界、主路和先手，再切到下游模块
- 想保留不同审查风格和不同 workflow，但不想继续维护多个并列安装入口
- 想整理项目 README、规则、AI 接手基线或日报 / commit / PR 描述
- 想同时兼顾 Claude、Copilot、Trae、Codex 等不同入口，并保持安装结构一致

## 这是什么

这个仓库现在的核心思路是：

- 对外只有 `skills/odai/SKILL.md` 这一个标准入口
- 内部模块正文放在 `skills/odai/references/modules/`
- 模块级规则、模板和脚本按模块名收在 `references/<module-name>/`、`assets/<module-name>/`、`scripts/<module-name>/`
- `道` 是默认总控；`harness-dev` 是偏开发推进的总控 workflow
- 多端手动安装版本仍由统一脚本同步生成，尽量避免各端长期分叉

如果你把它理解成“一个先由道决定路由和产物，再按需调用内部模块的 skill 工具箱”，会更贴近现在的结构。

## 如何安装

### 1. 自动安装（推荐）

```bash
npx skills add https://github.com/orziz/odai
```

适合场景：

- 想快速把统一入口接进当前环境
- 不想手动复制多个 skill 文件
- 日常直接通过 `odai` 触发内部模块，不自己维护一套手动安装副本

如果你要安装分离出来的旧多 skill 版本，请使用 `old` 分支：

```bash
npx skills add https://github.com/orziz/odai#old
```

适合场景：

- 你还在沿用旧的多 skill 入口
- 你需要继续使用 `harness-dev`、`harness-dao` 等旧分支里的独立安装方式
- 你在做旧结构迁移或对照

### 2. 手动安装

#### Claude

- `.claude/commands/odai.md`
- `.claude/commands/odai/`

之后在输入框中使用：

- `/odai`

#### Copilot

- `.github/skills/odai/SKILL.md`

补充说明：

- Copilot 的手动安装版本按“一个 skill 一个目录”组织
- `odai` 带有 `references/`、`assets/`、`scripts/` 等附属目录，必须连同整个目录一起复制
- 只有保留目录结构，`SKILL.md` 中的相对路径才能继续可用

> `copilot-instructions.md` 更适合项目级全局说明，不适合作为多文件 skill 的承载位置。

#### Trae

- `.trae/skills/odai.md`
- `.trae/skills/odai/`
- `.trae/rules/odai.md`
- `.trae/rules/odai/`

`rules`：

- 每次对话都会读取
- 适合希望统一入口长期持续生效的内容

`skills`：

- 通过指令或自然语言触发
- 更适合按任务临时点名内部模块的场景

#### Codex

- 当前仓库暂无 Codex 专用出包目录
- 但 `skills/odai/` 下的标准源正文已按宿主无关口径编写；若后续接入 Codex，应直接复用该正文规则，不得把 VS Code 工具名写死成唯一口径

## `odai` 怎么用更顺

`odai` 不机械串模块；先由 `道` 判你当前缺哪层/该调何模块/该产何形态，再读对应内部模块续推。

它内部保留两条主 workflow：

- `道`：默认总控，更适合“先定方向、边界、主路与先手”，也负责判断模块选择和产物形态
- `harness-dev`：偏开发推进，更适合“接住一整段开发任务并持续推进”

除此之外，你也可以直接点名单阶段模块或工具模块：

- `game-plan`：游戏系统、玩法、数值、经济、商业、关卡与内容规划
- `game-design`：完整游戏视觉设计，覆盖 UI/UX/UE、角色场景、宣传品牌与特效演出
- `feature-plan`：规格、方案、bug 诊断
- `design-spec`：页面、交互、状态、视觉、体验说明
- `implement-code`：代码实现、修 bug、补测试、重构落地
- `project-guide`：README、规则、AI 接手基线
- `review-sslb`：三省六部式代码审查
- `ribao`：日报、commit message、PR message
- `skill-author` / `skill-sync`：维护这个仓库本身

推荐触发方式：

- “用 `odai` 接这个需求：先判断该走哪个模块和产物形态，拿不准就结构化问我。”
- “用 `odai` 接这个需求：先用 `道` 定边界、主路和关键风险，再继续推进。”
- “用 `odai` 按 `harness-dev` 路线处理这个实现问题，推进到结果总结。”
- “用 `odai` 按 `review-sslb` 风格审这个分支。”
- “用 `odai` 用 `project-guide` 模块整理这个仓库的 AI 接手基线。”

## 默认交互方式

本仓库里会主动向用户补关键信息的内部模块，默认都遵守同一条交互约定：

- 结构化提问只在当前宿主原生提问工具可用且当前模式允许时调用；否则直接文字成组提问
- 提问时若当前环境支持结构化提问且获准调用，优先使用其原生结构化组件，例如选项、单选、多选，或“选项 + 自由补充”
- 收到你的回答后，默认直接继续当前阶段，不额外等一句“继续”
- 若当前宿主连提问工具都不支持，或当前模式不允许调用，直接改用文字成组提问

## Skills 一览

如果你只是来使用这个仓库，不必先把整张表看完；记住 `odai` 这一个入口通常就够了。

### 面向大多数使用者

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `odai` | 总控接单、澄清、规划、设计、实现、审查与收束，按任务路由内部模块并交付 | 接单、裁路、规划、设计、实现、审校、收束 | `skills/odai/SKILL.md` |

### 内置模块

这些名字仍然可以在提示词里点名，但模块选择和产物形态仍优先由 `道` 根据语义做裁决。

| 模块 | 作用 | 对应文件 |
| --- | --- | --- |
| `dao`（文案写作 `道`） | 默认总控 workflow，负责方向、边界、主路、先手与复核 | `skills/odai/references/modules/dao.md` |
| `harness-dev` | 开发类总控 workflow，按 SDD/BDD/TDD 判主驱并持续推进 | `skills/odai/references/modules/harness-dev.md` |
| `game-plan` | 全域游戏策划主模块，负责系统/玩法/数值/经济/商业/关卡/内容规划 | `skills/odai/references/modules/game-plan.md` |
| `game-design` | 完整游戏视觉设计主模块，负责 UI/UX/UE、角色场景、宣传品牌与特效 | `skills/odai/references/modules/game-design.md` |
| `feature-plan` | 规格规划、方案取舍、bug 诊断 | `skills/odai/references/modules/feature-plan.md` |
| `design-spec` | 页面、交互、状态、视觉与体验说明 | `skills/odai/references/modules/design-spec.md` |
| `implement-code` | 代码实现、修 bug、补测试、重构落地 | `skills/odai/references/modules/implement-code.md` |
| `project-guide` | README、规则、AI 接手基线与项目级说明 | `skills/odai/references/modules/project-guide.md` |
| `review-sslb` | 三省六部式代码审查 | `skills/odai/references/modules/review-sslb.md` |
| `ribao` | 日报、commit message、PR message 整理 | `skills/odai/references/modules/ribao.md` |
| `skill-author` | 统一入口内部模块 source-of-truth 维护 | `skills/odai/references/modules/skill-author.md` |
| `skill-sync` | 统一入口 skill 的多端同步与 README 回写 | `skills/odai/references/modules/skill-sync.md` |

## 面向维护者

如果你只是使用 `odai`，这一节通常可以先跳过。

### 命名约定

仓库按“对象 / 层级 + 工作类型”来给内部模块命名：

- `dao`：默认总控路线
- `game-*`：游戏策划与游戏视觉设计
- `feature-*`：需求规划、方案规划、问题诊断
- `design-*`：设计说明、交互、页面、流程、状态
- `implement-*`：代码实现、测试补齐、落地总结
- `project-*`：项目级说明、规则、基线、README 整理
- `review-*`：代码审查
- `skill-*`：仓库维护与同步工具链
- `harness-*`：偏开发推进的 workflow

补充约定：

- 模块 id 默认使用小写 kebab-case 英文，便于跨工具、跨平台和路径复用
- 默认总控模块的概念文案统一写 `道`；模块 id、frontmatter `name` 与文件名保持 `dao`；提示词里 `道` 和 `dao` 都算命中同一模块
- 面向人读的说明、分类和文案，优先用中文表达职责与场景
- 不再新增第二个对外 skill；新增能力默认收进 `odai` 的内部模块资源

### 维护流程

这一节承接维护者信息；`skills/odai/SKILL.md` 只保留运行时路由与调用约定，不再重复仓库结构约束。

内部模块正文优先只写本域职责/交付骨架/边界/support 触发；入口、README、并行手册、术语基线与同步模块已定的全局口径，优先引用，不再回抄。

推荐顺序：

1. 用 `skill-author` 模块新增或改写 `skills/odai/references/modules/<module-name>.md`
2. 需要时补 `skills/odai/references/<module-name>/`、`skills/odai/assets/<module-name>/`、`skills/odai/scripts/<module-name>/`
3. 确认 unified source 稳定后，再用 `skill-sync` 或 `node scripts/skill-sync.js` 同步 Claude/GitHub/Trae 安装版本，并回写 `README.md`；Codex 目前直接复用 source 口径；脚本会先校验 odai 术语基线、并行 support files、README 关键分节与禁用旧口径

标准安装入口：

- `skills/odai/SKILL.md`

## 目录说明

```text
skills/odai/           统一入口 source skill
	references/modules/  内部模块正文
	references/*/        模块级规则、说明等 support files
	assets/*/            模块级模板等资源
	scripts/*/           模块级脚本资源（按需）
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
