# AISkills

一个偏中文语境、偏实战使用的 AI 编程技能与工作流仓库。

它主要做四类事：

- 把常用 prompt 沉淀成可复用、可安装的 skill
- 把需求收敛、review、执行裁决做成更完整的 workflow
- 统一 Claude / Copilot / Trae 的手动安装与维护方式
- 在保证可用性的前提下，保留一点风格化和表达感

---

## 这是什么

这个仓库的核心思路很简单：

- `skills/` 目录下维护标准源文件，优先把“真相源”收在这里
- 多端手动安装版本从标准源同步生成，尽量避免各端长期分叉
- 能做成完整 workflow 的，不只停留在单段 prompt
- 结构尽量清楚，安装尽量直接，日常维护尽量低成本

如果你把它当成“一个给自己和项目长期复用的 skill 工具箱”，理解会比较顺。

---

## Skills 一览

### 面向大多数使用者

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `harness-sslb` | 把需求收敛、结构化复核、执行裁决与续跑收口串成自动推进的完整工作流 harness | 模糊需求、方案评审、复杂任务推进、问题诊断与持续收口 | `skills/harness-sslb/SKILL.md` |
| `feature-plan` | 在功能设计与问题诊断阶段分析需求并形成可执行方案，分别输出面向用户与面向 AI 的行动文档 | 功能设计、需求澄清、方案规划与 bug 诊断 | `skills/feature-plan/SKILL.md` |
| `ribao` | 根据当天工作内容、总结或 git 变更，生成一份可复用的结构化成果描述；可直接用于日报、git commit message 或 git PR message | 写日报、commit message、PR message | `skills/ribao/SKILL.md` |

### 审查类 skill

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `review-sslb` | 使用三省六部式代码审查，按中书省、尚书省、六部、门下省、锦衣卫五阶段输出结构化审查结论 | 需要更正式、更有层次地做代码 review | `skills/review-sslb/SKILL.md` |
| `review-hgsc` | 后宫分位式代码审查，用角色分工输出审查意见 | 想让代码 review 更有风格，但仍保持专业判断 | `skills/review-hgsc/SKILL.md` |
| `review-gal` | gal 路线分支式代码审查，用路线分歧与 true end 输出结构化结论 | 需要比较实现路线、收束方案分歧时的 review | `skills/review-gal/SKILL.md` |
| `review-band` | 少女乐队分工式代码审查，用成员分轨点评输出结构化结论 | 想做更有角色感、但仍专业可执行的 PR review | `skills/review-band/SKILL.md` |
| `review-anime` | anime 多角色连续对话式代码审查，用强角色互动输出带自然技术锚点的审查意见 | 想要更放飞、更有演出感，但又不想看模板化结论的 code review | `skills/review-anime/SKILL.md` |

补充说明：

- `harness-sslb` 是独立 skill，可单独安装使用；内部借用 `feature-plan` 与 `review-sslb` 的方法论，但不要求同时安装它们。
- 审查类 skill 的区别主要在输出风格、结构与角色感，不在“能不能做 review”本身。

### 仓库维护工具

如果你只是使用这些 skill，这一组通常可以先忽略。

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `skill-author` | 把用户已经想好的 skill 收敛成仓库内标准源文件，并按需补齐骨架 | 新增 skill、改写现有 skill、沉淀 prompt 或 workflow 为标准 skill 源文件 | `skills/skill-author/SKILL.md` |
| `skill-sync` | 基于标准源 skill 生成各端安装版本，并对 README 做最小范围回写 | skill 定稿后的多端同步、README 回写与安装版本更新 | `skills/skill-sync/SKILL.md` |

推荐顺序：

1. 用 `skill-author` 新增或改写 `skills/<skill-name>/SKILL.md`
2. 需要时补 `references/`、`assets/`、`scripts/`
3. 确认源文件稳定后，再用 `skill-sync` 同步 Claude / GitHub / Trae 安装版本，并回写 `README.md`

标准安装入口：

- `skills/<skill-name>/SKILL.md`

---

## 从哪开始

如果你不知道先用哪个 skill，可以直接按下面选：

- 不知道该先规划、review 还是直接推进：`harness-sslb`
- 只想把需求、方案或 bug 先收敛成文档：`feature-plan`
- 想正式做一次结构化 code review：`review-sslb`
- 想把当天工作整理成日报、commit message 或 PR message：`ribao`

如果你完全不想自己判断阶段，默认先用 `harness-sslb` 就行。

---

## 推荐使用路径

普通使用者更常见的路径通常是：

1. 任务还模糊时，用 `harness-sslb` 接住整段任务
2. 若当前只需要规划收敛，可直接用 `feature-plan`
3. 若已经进入正式审查阶段，可切到 `review-sslb` 或其他 review 系列 skill
4. 若只是整理工作内容、commit message 或 PR message，可用 `ribao`

如果你只是想使用这些 skill，到这里基本就够了。

---

## 如何安装

### 1. 自动安装（推荐）

如果你使用支持 `skills add` 的方式，默认更推荐直接这样装：

```bash
npx skills add https://github.com/orziz/AISkills
```

仓库中的标准 skill 安装入口为：

- `skills/<skill-name>/SKILL.md`

适合场景：

- 想快速把整套标准源接进当前环境
- 不想手动复制多个 skill 文件
- 日常主要按仓库中的标准源使用，不需要自己维护一套手动安装副本

### 2. 手动安装

手动安装更适合这些情况：

- 你只想装少数几个 skill
- 你想精确控制装到哪个入口、哪个目录
- 你正在开发、调试或对比手动安装版本

#### Claude

将对应 skill 放入 `.claude/commands/` 目录即可，例如：

- `.claude/commands/review-sslb.md`

若该 skill 还带有同名资源目录，也需要一并复制，例如：

- `.claude/commands/harness-sslb/`

之后在输入框中使用对应命令触发，例如：

- `/review-sslb`

补充说明：

- 如果使用 `npx skills add`，Claude 读取的是标准源 skill：`skills/review-sslb/SKILL.md`
- 如果路径正确但命令没有出现，可以尝试重启 Claude 终端或编辑器

#### Copilot

将对应 skill 的整个目录放入项目的 `.github/skills/` 下，例如：

- `.github/skills/harness-sslb/SKILL.md`

补充说明：

- Copilot 的手动安装版本按“一个 skill 一个目录”组织
- 若 skill 带有 `references/`、`assets/`、`scripts/` 等附属目录，必须连同整个目录一起复制
- 只有保留目录结构，`SKILL.md` 中的相对路径才能继续可用

> `copilot-instructions.md` 更适合项目级全局说明，不适合作为多文件 skill 的承载位置。

#### Trae

放入同名目录即可，`rules` 和 `skills` 二选一。

若该 skill 还带有同名资源目录，也需要一并复制，例如：

- `.trae/skills/harness-sslb/`
- `.trae/rules/harness-sslb/`

`rules`：

- 每次对话都会读取
- 适合希望全局持续生效的内容

`skills`：

- 通过指令或自然语言触发
- 更适合像“使用三省六部来审查 XXX”这类场景

---

## `harness-sslb` 怎么用更顺

`harness-sslb` 更适合“接住一整段任务并持续推进”，而不是只做一次性问答。

推荐在首轮输入里尽量带上这三类信息：

- 目标：你到底想做成什么
- 材料：需求、报错、截图、文件、分支、PR、已有草案
- 约束：时间、范围、不能动的部分、是否允许直接改

推荐触发方式：

- “用 `harness-sslb` 接这个需求：先帮我收敛范围，形成可执行草案；如果路线清楚就直接推进，最后告诉我当前状态和下一步。”
- “用 `harness-sslb` 接这个报错：先判断是信息不足还是可以直接诊断；如果能落地修复就继续做，不要只停在分析。”
- “用 `harness-sslb` 继续上次那个任务：先恢复上下文和当前裁决，再按已有路线往下推进并收口。”
- “用 `harness-sslb` 接这个 PR / 分支：先做结构化复核，定案后把该改的地方直接改掉，最后给我明确结论。”

什么时候直接用别的 skill 会更合适：

- 你只想要一份完整规划文档、用户文档或 AI 执行单时，直接用 `feature-plan`
- 你只想做一次正式、严格、偏 review 结论的审查时，直接用 `review-sslb`
- 如果你在维护这个仓库里的 skill，再看上面的“仓库维护工具”

---

## 目录说明

```text
skills/                标准源 skill
.claude/commands/      Claude 手动安装版本
.github/skills/        GitHub / Copilot 适配版本
.trae/skills/          Trae skill 版本
.trae/rules/           Trae rule 版本
assets/                README 配图
```

---

## 效果展示

![效果图0](./assets/image_0.png)
![效果图2](./assets/image_1.png)

---

## 适合谁用

如果你刚好有下面这些需求，这个仓库会比较顺手：

- 想把常用 prompt 固化成可复用 skill
- 想让代码审查输出更结构化一些
- 想把“需求收敛 -> review -> 推进”做成可以直接接手的工作流
- 想把 skill 源文件与多端安装版本分开维护
- 想同时兼顾 Claude、Copilot、Trae 等不同入口

---

## 参考与致谢

部分命名方式、组织思路和玩法形式参考过下面这些项目，在此一并致谢：

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)

欢迎 star，也欢迎提 PR 一起补充更好用的 skill 和 workflow。
