# AISkills

本 Repo 主要是用于一些基本的AI编程相关的辅助，提升趣味性及优化流程

## 如何使用

### 自动安装

直接使用（copilot无法自动安装，cluade也推荐手动安装）：

```bash
npx skills add https://github.com/orziz/AISkills
```

本仓库面向 `skills add` 的安装入口为：

- `skills/<skill-name>/SKILL.md`

当前已提供：

- `skills/sslb/SKILL.md`

### 手动安装

#### claude（推荐手动安装方式）

手动安装时，放进同名文件夹下即可，如 `.claude/commands/sslb.md`。

如果使用 `npx skills add`，则读取仓库内的标准 skill 目录：`skills/sslb/SKILL.md`。

##### commands

由 claude 的指令触发，输入框输入 `/指令名` 即可，如 `/sslb`。

（如路径正确却没有对应指令，可以重启一下claude终端或编辑器重试）

#### copilot

将 `.github/skills` 下面的内容，酌情复制到 `.github/copilot-instructions.md` 里即可
> 因为copilot会自行读 `.github/copilot-instructions.md` 所以无需其他操作

#### trae

放进同名文件夹下即可，`rules` 和 `skills` 二选一

###### rules

这里每次对话都会读，自行决定是否放在这

###### skills

这里是指令触发，推荐放这吧，如 `使用三审六部来审查XXX`

## 其他

如果大家有什么好玩的，也欢迎 star 和 PR

### 灵感来源

确实有看到一些其他 repo 产生的想法，觉得好玩，就搞了个编程相关的自用。

灵感来源（不一一列举）：

* [https://github.com/cft0808/edict](https://github.com/cft0808/edict)

* [https://github.com/wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)
