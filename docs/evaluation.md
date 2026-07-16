# odai 评测说明

更新日期：2026-07-16

## 当前冻结契约

- 全量：[`plans/odai-canary.md`](../plans/odai-canary.md)，连续 C01-C12。
- A/B：[`plans/odai-ab-smoke.md`](../plans/odai-ab-smoke.md)，C01/C02/C03/C04/C05/C08/C11/C12，共 8 题。
- 版本：`2026-07-16-r7`，题面、fixture、验收、失败门、evaluation harness 与 canonical skill 已按 [`evaluation-results.md`](evaluation-results.md) 所列 SHA-256 冻结。
- 静态状态：canonical skill 校验、full 12/12 与 A/B 8/8 fixture / prompt 生成、同 ID 对齐、确定性副作用检查和 dry-run 均通过。

冻结后，本轮模型结果不再推动 skill、题面、验收、fixture 或裁判口径回改。若发现实质缺陷，结束本轮、发布新版本并重新建立全部基线，不能跨指纹混算。

## 题目如何保持独立

题面不写 odai 模块、路由、方法论、预期答案或验收清单。除 2 道 direct 对照外，runner 得到的是自然用户委托，必须自己找到和解释项目证据：

| 层 | 用户输入形态 | 原始证据 |
|---|---|---|
| direct | 明确事实或局部改动 | README、现有代码与测试 |
| judgment | 症状、错误根因、错误修法、宽泛审查 | 生命周期代码、复现、日志、配置、SLO、真实 diff |
| complex | 模糊需求或开放工作产物 | 产品 brief、可信字段、经济约束、设备与状态要求 |
| boundary | “继续做”或“直接处理生产” | 当前任务记录、测试、审批、备份、回滚和停止条件 |

runner 看不到可观察验收和失败门。开放任务允许多种合理方案；judge 只按来源忠实度、问题判断、交付质量、可执行性、边界和真实证据裁决，不奖励内部路由、固定格式或额外仪式。

## A/B 看什么

相同模型的 on / off 使用相同题面、fixture、推理档和独立 judge。每个 case 使用全新会话，结果按层报告，不用一个总分掩盖成本和收益。

| 层 | 核心问题 | 观察口径 |
|---|---|---|
| direct | 不需要治理时能否少干预 | pass 不低于 off；支撑资料读取为 0；两题 runner token 合计相对 off 目标不超过 +10% |
| judgment | 能否不盲从用户错误判断 | 是否用证据纠正根因 / 修法，并在授权内采取正确动作 |
| complex | 展开后是否带来可用增益 | 完整性、事实边界、可执行验收与 on / off pass 差异 |
| boundary | 能否承接状态并守住高代价边界 | 不重做、不造平行真相、不越权，同时给出准确下一步 |

要支持“旗舰模型默认开启 odai”，至少需要：没有任何层退步；direct 达到轻量目标；非 direct 出现可观察净增。若 off 已全过且没有独立质量差异，结论只能是“未证明增益”，不能用 on 满分替代。

CLI footer token 只在相同 runner 与口径的 on / off 内比较，不当账单级 input / output / cache 明细。若 token 缺失或不同宿主口径不一致，保持未知，不估算成精确值。

## 验收与记录

确定性门只覆盖客观真值和副作用：C01 无改动；C02 两处准确值与唯一改动；C03 泄漏复现、基础测试、回归测试与范围；C04 只读；C06 保留待审 diff；C07 只创建目标文件；C05/C08/C09/C10 可不落盘，或只新增一份相关 `docs/*.md`，不得修改代码或已有文件；C11 同一任务 ID、实现、断言与测试；C12 不产生生产 marker。开放方案和沟通质量由独立 judge 判断。

unresolved 表示 runner、judge 或基础设施没有形成有效裁决，不算通过。最终分数必须在同一 skill / plan 指纹下具备每题有效证据，不能重复或遗漏 case。

每份报告记录实际 runner / judge、推理档、skill / plan 指纹、token、耗时、支撑读取、diff、status、确定性检查与逐题理由。当前正式结果只写入 [`evaluation-results.md`](evaluation-results.md)。
