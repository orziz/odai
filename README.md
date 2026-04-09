# AISkills

一个偏中文语境、偏实战使用的 AI 编程工作流与技能仓库。

主要做四类事：

- 把常用提示词沉淀成可复用的 skill 与 workflow
- 把需求收敛、review、执行裁决这类流程做成更完整的工作流
- 让 Claude / Copilot / Trae 的安装方式更统一
- 在保证可用性的前提下，保留一点风格化和表达感

---

## 项目简介

本仓库聚焦于可复用、可安装、可持续维护的 AI skill 与 workflow。

主要关注：

- 代码审查
- 需求收敛与执行工作流
- 工作内容整理
- skill 安装与多端同步

设计思路：

- `skills/` 目录下放标准 skill 源文件，优先维护源头
- 多端手动安装版本从标准源同步生成，尽量避免各端长期分叉
- 能做成完整 workflow 的，尽量不只停留在单段 prompt
- 尽量保持结构清晰、安装直接、复制成本低，同时保证真的可用

---

## Skills 一览

提供以下 skills 与 workflow：

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `xzskill` | 基于标准 `skills` 目录生成手动安装版本并同步 README | 维护或新增 skill 时做多端同步（现由本地 Node 脚本执行） | `skills/xzskill/SKILL.md` |
| `ribao` | 根据当天工作内容、总结或 git 变更，生成一份可复用的结构化成果描述；可直接用于日报、git commit message 或 git PR message | 写日报、commit message、PR message | `skills/ribao/SKILL.md` |
| `feature-plan` | 在功能设计与问题诊断阶段分析需求并形成可执行方案，分别输出面向用户与面向 AI 的行动文档 | 功能设计、需求澄清、方案规划与 bug 诊断 | `skills/feature-plan/SKILL.md` |
| `review-sslb` | 使用三省六部式代码审查，按中书省、尚书省、六部、门下省、锦衣卫五阶段输出结构化审查结论 | 需要更正式、更有层次地做代码 review | `skills/review-sslb/SKILL.md` |
| `review-hgsc` | 后宫分位式代码审查，用角色分工输出审查意见 | 想让代码 review 更有风格，但仍保持专业判断 | `skills/review-hgsc/SKILL.md` |
| `review-gal` | gal 路线分支式代码审查，用路线分歧与 true end 输出结构化结论 | 需要比较实现路线、收束方案分歧时的 review | `skills/review-gal/SKILL.md` |
| `review-band` | 少女乐队分工式代码审查，用成员分轨点评输出结构化结论 | 想做更有角色感、但仍专业可执行的 PR review | `skills/review-band/SKILL.md` |
| `review-anime` | anime 多角色连续对话式代码审查，用强角色互动输出带自然技术锚点的审查意见 | 想要更放飞、更有演出感，但又不想看模板化结论的 code review | `skills/review-anime/SKILL.md` |
| `harness-sslb` | 把需求收敛、结构化复核、执行裁决与续跑收口串成自动推进的完整工作流 harness | 模糊需求、方案评审、复杂任务推进、问题诊断与持续收口 | `skills/harness-sslb/SKILL.md` |

- `harness-sslb` 是独立 skill，可单独安装使用；内部借用 `feature-plan` 与 `review-sslb` 的方法论，但不要求同时安装它们。

标准安装入口：

- `skills/<skill-name>/SKILL.md`

---

## 如何使用

### 1. 自动安装（推荐！）

如果你使用支持 `skills add` 的方式，可以直接执行：

```bash
npx skills add https://github.com/orziz/AISkills
```

仓库中的标准 skill 安装入口为：

- `skills/<skill-name>/SKILL.md`

### 2. 手动安装

#### Claude

更推荐手动安装。

将对应 skill 放入 `.claude/commands/` 目录即可，例如：

- `.claude/commands/review-sslb.md`

若该 skill 还带有同名资源目录，也需要一并复制，例如：

- `.claude/commands/harness-sslb/`

之后在输入框中使用对应命令触发，例如：

- `/review-sslb`

补充说明：

- 如果使用 `npx skills add`，Claude 读取的是标准 skill 源：`skills/review-sslb/SKILL.md`
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

##### `rules`

- 每次对话都会读取
- 适合希望全局持续生效的内容

##### `skills`

- 通过指令或自然语言触发
- 更适合像“使用三省六部来审查 XXX”这类场景

---

## 目录说明

```text
skills/                标准 skill 源文件
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

如果你刚好有下面这些需求，这个仓库应该会比较顺手：

- 想把常用 prompt 固化成可复用 skill
- 想让代码审查输出更结构化一些
- 想把“需求收敛 -> review -> 推进”做成可以直接接手的工作流
- 想在“能用”和“有点意思”之间找个平衡
- 想同时兼顾 Claude、Copilot、Trae 等不同入口

---

## 其他

欢迎 star，也欢迎提 PR 一起补充更好用的 skill 和 workflow。

### 参考与致谢

部分命名方式、组织思路和玩法形式参考过下面这些项目，在此一并致谢：

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)
