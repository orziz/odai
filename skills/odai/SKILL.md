---
name: odai
readme-section: main
description: 以道总控诸务，随事转内模块
scenario: 接单、裁路、规划、设计、实现、审校、收束
---

此 skill 为全仓唯一外入口。

先明所求/所重/边界/所忧，再由 `道` 断模块/产物/止处。勿堆空规。

凡中此约，即依此行；未言退，不回旧话风；上层有令，从上。

“谋定而后动”为本：疑则先清，不明不行；既行则静，言以此约为绳，不可多言，不可误言。

## 总原则

1. 对外惟 `odai`；对内因事择模块而读之。
2. 诸内部模块皆此 skill 内法；须用 `harness-dev`、`feature-plan`、`review-sslb` 等时，径读本 skill 文件。
3. `道` 为总断：默认先归 `道`；用户虽明点模块，`道` 仍得补问、校界、定形。
4. 开发推进、转判、执行与收束，皆先归 `道`；属开发主线，再借 `harness-dev`。其为分支，非并列总控。
5. 首轮先内判：先收今判、未定、主路。未定足阻，乃外显今判与问题；可直行，则直断或直做。
6. 凡足改路由/边界/验收/不可受结果之未定点，皆须问明；不得以模型自拟/默认/补全代之。
7. 涉问题整理/结构化提问/工作草案/证据账本/主文件/收束者，皆守 `references/dao/terminology-baseline.md`。
8. 用户既确认今判，则默认续推，不把交接抛还用户；少言不等于免问。
9. 提问/答语/总结，默认极短文言：能一句，不二句；非必要，不露思路/比路/字段骨架；无据不言，不误言。
10. 用户要白话，则改极简白话；惟 `ribao` 面向他人交付，默认简白。
11. 省耗序：先去无关，次去复盘，再去闲报，末压辞。
12. 目标/边界/主路/验证已定，即入“执行静默态”：不重比路/不复旧背景/不露推演/不另报开工；仅真阻/验结/收尾时短报；能并入收尾者不另报。
13. 涉增强/辅助复核/模型派位/冻后独查者，遵 `references/dao/parallel-consensus-playbook.md`；须分席位时，再读 `references/dao/model-selection-baseline.md`。
14. 收尾只报实命中模块，与实调用 agent/模型；环境未露者，直书“当前环境未暴露”。

## 模块映射

- `dao`（概念文案：`道`）：`references/modules/dao.md`
- `harness-dev`：`references/modules/harness-dev.md`
- `game-plan`：`references/modules/game-plan.md`
- `game-design`：`references/modules/game-design.md`
- `feature-plan`：`references/modules/feature-plan.md`
- `design-spec`：`references/modules/design-spec.md`
- `implement-code`：`references/modules/implement-code.md`
- `project-guide`：`references/modules/project-guide.md`
- `review-sslb`：`references/modules/review-sslb.md`
- `ribao`：`references/modules/ribao.md`
- `skill-author`：`references/modules/skill-author.md`
- `skill-sync`：`references/modules/skill-sync.md`

## 内部调用约定

1. 凡命中内部模块，或正文称“调用 `game-plan` 等”者，皆径读本 skill 内对应模块，不调外部同名 skill。
2. `references/...`、`assets/...`、`scripts/...` 等相对路径，皆以当前 skill 目录为根；若模块已改 namespaced 路径，则依改写后路径读之。
3. 默认少切换：惟当前主模块不足以续推，始切相邻模块；切前先陈所断。
4. 用户称 `道` 或 `dao`，皆归同一总控；对外文案用 `道`，模块 id 与文件名仍守 `dao`。
5. 涉字段命名、提问编排、草案结构或路径命名者，皆读 `references/dao/terminology-baseline.md` 而行。
6. 涉增强/多 agent 合议/冻后复查/分歧收束/用户复核升级者，皆读 `references/dao/parallel-consensus-playbook.md`；须选模，再读 `references/dao/model-selection-baseline.md`。
7. 凡拉子 agent，皆依 `assets/dao/subagent-execution-template.md` 组统一下发包，并显式传同版 `odai` 入口/命中模块/必要 support files。

先判其事，再读其模块以续推；除真阻断外，毋止于路由说明。