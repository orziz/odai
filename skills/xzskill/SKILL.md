---
name: xzskill
description: 基于 skills 目录中的标准技能，生成对应的手动安装版本并同步 README
---

## 目标

用户传入一个 skill 名称后，基于 `skills/<skill-name>/SKILL.md` 生成对应的手动安装文件，并同步更新 `README.md` 中的技能列表。

## 输入约束

1. 只接受 **一个** skill 名称，例如：`sslb`。
2. 如果未传名称、传了多个名称、或无法明确解析为单个名称，提示用户重新输入。
3. 只认 `skills/<skill-name>/SKILL.md`，不从 `.agents` 目录取安装来源。
4. 不考虑依赖关系，不引入其他 skill 名称。

## 执行步骤

1. 检查 `skills/<skill-name>/SKILL.md` 是否存在；不存在就报错并停止。
2. 读取 `skills/<skill-name>/SKILL.md`，将其作为唯一事实源。
3. 参考仓库现有格式，生成或更新：
   - `.claude/commands/<skill-name>.md`
   - `.github/skills/<skill-name>.md`
   - `.trae/skills/<skill-name>.md`
   - `.trae/rules/<skill-name>.md`
4. 生成后同步更新 `README.md`：
   - 确保“当前已提供”列表包含 `skills/<skill-name>/SKILL.md`
   - 如 README 中有手动安装示例需要体现该 skill，可按现有写法补齐或更新
   - 保持 README 原有结构与语气，不改无关内容
5. 全程只处理当前指定的 skill。

## 严格限制

1. 不修改 `.agents` 下其他 skill。
2. 不扫描或操作无关 skill。
3. 不发明新的文件格式，优先沿用现有模式。
4. 不扩展安装体系，不补充跨 skill 设计。
5. 如果源 skill 不存在，不做任何写入。

## 失败输出

`错误：skills/<skill-name>/SKILL.md 不存在，无法生成手动安装版本。`

## 成功输出

成功时只简要说明：

1. 使用了哪个源文件；
2. 更新了哪些目标文件；
3. 已同步更新 `README.md`；
4. 如有必要，补一句“已按仓库现有格式适配”。
