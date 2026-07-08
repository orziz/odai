# 长审查收敛回路（连续 clean round / 全仓复查 / 安全 audit / 长修复验证）

## 何时读取

- `review-sslb` 的可选重型子流程：任务要求“连续 N 轮 clean”“全仓 / 全目录复查”“安全 audit”“长修复后反复验证到无缺陷”时读取；普通单轮 diff 审查不读，默认仍走 `review-sslb` 单流程。
- 由当前主审 agent（`review-sslb` 主流程）按命中读取并主控；写不出命中条件即未命中。
- 本文件叠加在 `references/dao/decision-challenge.md` 与 `references/dao/agent-governance.md`「子 agent 通用边界」「执行下放」之上，只补长回路特有的**缺陷分级收敛门**与 **subagent exit 权威**；确认与实施准入仍以交互契约为准。

## 缺陷分级与收敛门

按缺陷等级收敛，不把维护观察和真实缺陷混在一起。

- **BLOCKER**（= `review-sslb` 🔴 严重 + 以下 exit 专属条件全中）：当前 checkout 可复现、存在明确触发路径，且会造成用户可见功能错误、安全边界绕过、数据损坏、secret / 原始证据泄露，或运行时不可恢复失败。四要素缺一不判 BLOCKER，按证据降为 🟡 建议或留中待问。
- **维护观察**（🟡 建议 / WATCH / 文档·测试维护项）：写入本任务主文件（`道` 编排下的 `plans/<日期>-<任务名>.md` 或指定主文件）的「维护观察」节；**不重置 clean round，也不得当作阶段 exit 证据**。不为项目硬编死某个固定 sink 文件，落本任务既有主文件即可。
- 证据不足判不准时 fail-closed 倒向留中待问；不硬判 BLOCKER，也不塞进维护观察掩盖真缺陷。

## clean round 计数

- 任务要求连续 N 轮 clean 时，**任何代码或文档修改、任何真实 BLOCKER、任何失败的验证**都把计数归零。
- 重新计数只基于**当前 checkout**：不复用旧线程，也不复用修复前的 clean 结论。
- 每轮外显一行：`clean round x/N｜本轮：CLEAN / 发现 BLOCKER（归零）｜固定范围：<本轮扫描范围>`。
- 只有连续 N 轮全 CLEAN（无任何 BLOCKER、无任何改动、无失败验证）才算收敛；维护观察存在不阻止收敛，但必须在主文件留痕，不被静默吞掉。

## subagent 在回路里的边界

叠加在 `references/dao/agent-governance.md`「子 agent 通用边界」「执行下放」之上，本节补长回路专属约束：

- 本回路要求 `review-sslb` 自身是主审 agent（能启动并管理扫描 subagent）；它若反过来是被 `道` 下放的子 agent，则受 `references/dao/agent-governance.md` 递归保护，不得展开多 subagent 扫描——此时不下放，由上游主流程直接主控。
- 只有当前主审 agent 可启动和管理 subagent；subagent 只做**只读扫描**，并报告 `CLEAN` / `BLOCKER` / `NON-BLOCKING` / `WATCH` 及复现路径。
- subagent **不得**：修改文件、启动新的 subagent（递归保护）、继续派生复查轮次、宣布 clean round 完成或宣布收敛。这些权威只属主审 agent。
- 每轮 subagent 数量与扫描范围由主审 agent **固定**；发现 BLOCKER 由主审 agent 修复并重启计数，不由 subagent 自行推进。
- 派给 subagent 的任务说明**必须含递归保护**：只读、不改文件、不启动 subagent、不重试轮次，只报告发现与复现路径。
- subagent 工具不可用、配额失败或中断：记为**验证未完成**（按契约工具失败口径），不得靠扩增 subagent 数量替代一次完整验证。

## 修复 BLOCKER

落地与回归测试纪律按 `references/modules/implement-code.md`，本节只补回路口径：

- 有稳定自动化测试接缝时，先补一条能**触发该缺陷的回归测试**，再跑定向测试；涉及共享边界时继续跑相关包 / workspace 级验证（按宿主语言的工作区口径）。若接缝确实不存在或环境无法构造，不强造仪式化测试；记录原因，改用能对准原缺陷场景的最强可用证据，并保持未覆盖风险可见。
- 不得把“subagent 认为已修”当证据；修复后由主审 agent 实际复核（读 / 跑）确认，再把 clean round 归零重数。
