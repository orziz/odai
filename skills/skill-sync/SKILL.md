---
name: skill-sync
description: 基于标准源 skill 生成各端安装版本，并对 README 做最小范围回写
scenario: skill 定稿后的多端同步、README 回写与安装版本更新
---

`skill-sync` 现在通过仓库内脚本 `scripts/skill-sync.js` 执行。

## 目标

用户传入一个或多个 skill 名称后，基于 `工程根目录/skills/<skill-name>/` 生成对应的手动安装文件，并对 `README.md` 做最小范围同步。

这里的职责是“同步分发”，不是“起草源文件”。

- 源文件与 support files 由 `skill-author` 或用户直接维护
- `skill-sync` 只负责把标准源同步到 Claude / GitHub / Trae，并回写 README

## 输入约束

1. 接受 **一个或多个** skill 名称，例如：`review-sslb harness-sslb`。
2. 如果未传名称，或任一名称无法明确解析为 skill 名称，提示用户重新输入。
3. 只认 `工程根目录/skills/<skill-name>/` 目录，不从 `.agents` 目录取安装来源。
4. 不考虑依赖关系，不引入其他 skill 名称。
5. 若传入多个名称，先完成全部校验，再逐个处理，避免只同步一半。

## 执行方式

1. Claude 命令层只做薄封装。
2. 实际生成逻辑统一由 `工程根目录/scripts/skill-sync.js` 完成。
3. 脚本是唯一执行真相；不要再让模型按规则手工生成目标文件。

## 脚本职责

1. 检查 `工程根目录/skills/<skill-name>/SKILL.md` 是否存在；不存在就报错并停止。
2. 读取 `工程根目录/skills/<skill-name>/SKILL.md`，将其作为主正文来源。
3. 若同目录下存在 `references/`、`assets/` 或 `scripts/`，则将这些目录视为当前 skill 的附属资源，一并同步到各手动安装目标目录。
4. `.claude/commands/<skill-name>.md` 中已有的 wrapper 信息（如 `allowed-tools`、`argument-hint`、`用户输入` 后的补充说明）视为 Claude 侧真相，生成时需要保留。
5. 不读取其他 skill 目录，不扫描仓库中无关目录，不参考其他 skill 作为模板。
6. 生成目标文件时，默认采用“固定模板 + 正文直拷”策略：**不要改写源文件正文，不要重组，不要风格化重写。**
7. 若正文中引用了 `references/`、`assets/`、`scripts/` 下的相对路径，生成手动安装文件时应将这些路径改写为目标目录下可用的相对路径。
8. 先解析源文件 frontmatter：
   - 读取 `name`
   - 读取 `description`
9. 再取源文件 frontmatter 之后的正文，作为唯一正文载荷；正文段落顺序、标题层级、代码块、措辞保持原样。
10. 直接基于源文件内容生成或覆盖以下目标文件：
   - `.claude/commands/<skill-name>.md`
   - `.github/skills/<skill-name>/SKILL.md`
   - `.trae/skills/<skill-name>.md`
   - `.trae/rules/<skill-name>.md`
11. 若存在附属资源目录，则在以下位置同步同名目录：
   - `.claude/commands/<skill-name>/`
   - `.github/skills/<skill-name>/`
   - `.trae/skills/<skill-name>/`
   - `.trae/rules/<skill-name>/`
12. 各目标文件的生成规则固定如下，不做临场判断：
   - `.claude/commands/<skill-name>.md`：保留 `name`、`description`，并尽量保留该文件中已有的 `allowed-tools`、`argument-hint` 与 `用户输入` 后补充说明；frontmatter 后固定追加空行、`用户输入：`、`$ARGUMENTS`、空行，再拼接保留段和源文件正文
   - `.github/skills/<skill-name>/SKILL.md`：保留 `name`、`description` frontmatter 后，直接拼接源文件正文；附属资源与 `SKILL.md` 放在同一 skill 目录下，正文内资源相对路径保持源文件写法
   - `.trae/skills/<skill-name>.md`：保留 `name`、`description` frontmatter 后，直接拼接源文件正文；不额外改写
   - `.trae/rules/<skill-name>.md`：保留 `name`、`description` frontmatter 后，直接拼接源文件正文；不额外改写
13. 更新 `README.md` 时，只处理“当前已提供”列表：
   - 若列表中不存在 `工程根目录/skills/<skill-name>/SKILL.md`，则追加一行
   - 若已存在，则不重复添加
   - 不修改 README 其他段落，不重写全文
14. 全程只处理当前指定的 skill，完成后停止。

## 严格限制

1. 不修改 `.agents` 下任何内容。
2. 不扫描或操作无关 skill。
3. 不发明新的文件格式，不扩展安装体系。
4. 不为“参考现有格式”而搜索全仓文件。
5. 如果源 skill 不存在，不做任何写入。
6. 除 `工程根目录/skills/<skill-name>/`、当前 `.claude/commands/<skill-name>.md` 与 `README.md` 外，不读取其他 skill 目录。
7. 不为了“更像目标平台”而重写源 skill 正文；正文一律按源文件直拷，除固定头部、Claude 侧保留段与资源相对路径改写外不改。
8. 不调整正文章节顺序，不合并段落，不擅自增删规则。
9. 不自行推断平台差异，不自行设计额外字段；凡源文件未写明、规则未写死的内容，一律不补。
10. 若生成规则已固定，就按固定模板执行；不要反复比较“是否还能更像目标平台”。
11. 写入目标文件时，凡规则中出现的 `$ARGUMENTS`，都按普通文本占位符处理，禁止展开、禁止替换、禁止引用当前传入参数。

## 失败输出

- 若任一源文件不存在：`错误：工程根目录/skills/<skill-name>/SKILL.md 不存在，无法生成手动安装版本。`
## 成功输出

成功时只简要说明：

1. 处理了哪些源文件；
2. 各自更新了哪些目标文件；
3. README 是已追加、已更新还是已存在；
4. 已按最小必要范围完成同步。
