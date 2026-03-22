# AISkills

一个偏中文语境、偏实战使用的 AI 编程辅助技能仓库。

主要用来做三类事：

- 让常用提示词/审查流更稳定
- 让 Claude / Copilot / Trae 的安装方式更统一
- 在保证可用性的前提下，顺手保留一点风格化和趣味性

---

## 项目简介

本仓库收集了一些适合日常开发使用的 skills，重点放在：

- 代码审查
- 工作内容整理
- skill 安装与同步

设计思路比较简单：

- `skills/` 目录下放标准 skill 源文件
- 按不同工具链生成或手动放置对应版本
- 尽量保持结构清晰、安装直接、复制成本低

---

## Skills 一览

本仓库当前提供以下 skills：

| Skill | 简介 | 适用场景 | 对应文件 |
| --- | --- | --- | --- |
| `sslb` | 三省六部式代码审查，分阶段输出结构化结论 | 需要更正式、更有层次地做代码 review | `skills/sslb/SKILL.md` |
| `hgsc` | 后宫分位式代码审查，用角色分工输出审查意见 | 想让代码 review 更有风格，但仍保持专业判断 | `skills/hgsc/SKILL.md` |
| `ribao` | 根据工作内容、总结或 git 变更生成成果描述 | 写日报、commit message、PR message | `skills/ribao/SKILL.md` |
| `xzskill` | 基于标准 `skills` 目录生成手动安装版本并同步 README | 维护或新增 skill 时做多端同步 | `skills/xzskill/SKILL.md` |

标准安装入口：

- `skills/<skill-name>/SKILL.md`

---

## 如何使用

### 1. 自动安装

如果你使用支持 `skills add` 的方式，可以直接执行：

```bash
npx skills add https://github.com/orziz/AISkills
```

仓库中的标准 skill 安装入口为：

- `skills/<skill-name>/SKILL.md`

> 是否自动安装看个人习惯。就我自己的使用体验来说，Claude 和 Copilot 很多时候手动接入反而更稳、更可控。

### 2. 手动安装

#### Claude

更推荐手动安装。

将对应 skill 放入 `.claude/commands/` 目录即可，例如：

- `.claude/commands/sslb.md`

之后在输入框中使用对应命令触发，例如：

- `/sslb`

补充说明：

- 如果使用 `npx skills add`，Claude 读取的是标准 skill 源：`skills/sslb/SKILL.md`
- 如果路径正确但命令没有出现，可以尝试重启 Claude 终端或编辑器

#### Copilot

将 `.github/skills` 中对应内容按需复制到：

- `.github/copilot-instructions.md`

> Copilot 会自行读取 `.github/copilot-instructions.md`，一般不需要额外配置。

#### Trae

放入同名目录即可，`rules` 和 `skills` 二选一。

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
- 想在“能用”和“有点意思”之间找个平衡
- 想同时兼顾 Claude、Copilot、Trae 等不同入口

---

## 其他

欢迎 star，也欢迎提 PR 一起补充更好玩的 skill。

### 灵感来源

确实参考过一些有意思的仓库和玩法，觉得挺好玩，就做了一个偏编程场景、自用为主的整理版本。

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)
