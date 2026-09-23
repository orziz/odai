---
name: odai-orchestration
description: Odai 的可选多能力编排。用户要求分工、独立规划或审查、并行制作，或为 Codex、Claude Code、Copilot 配置模型路由时使用；治理技能 odai 独立可用。
---

# Odai 编排

本技能以 `odai` 的治理为前提，负责何时分工、如何交接和怎样收回结果。先取得当前已加载的治理；没有提供时读取同级 `odai/SKILL.md` 或宿主实际安装的 `odai`，不要维护治理副本或用本技能替代授权。

## 使用

- 启用编排不等于每个任务都派角色。当前能力足够时直接完成；只有独立判断、专业能力、访问差异或真正并行能改善结果时才分工。
- 选择职责和准备交接时读取 `references/orchestration.md`。controller 持有整体结果，researcher、planner、reviewer、frontend 是可选职责预设，不是固定阶段、模型等级或权限来源。
- 宿主已有符合要求的原生能力时使用它；配套适配器只补模型映射、生成、安装和调用核验。按当前用户映射与真实工具权限执行。
- 治理、编排与宿主权限分别有效。DSH 已内置本技能时使用其现有能力；不额外运行其他宿主安装器。
- 用户要求为 Codex、Claude Code 或 Copilot 安装、更新、卸载或修复路由时读取 `references/install.md`；普通任务不需要它。
