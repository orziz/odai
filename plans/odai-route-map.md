# odai 模块路由维护表

本文件由 `node scripts/skill-sync.js --route-map` 根据 `skills/odai/references/modules/` 自动生成。

| 模块 | 触发语义 | 最小产物 / 裁决 | 必读 support files |
| --- | --- | --- | --- |
| `dao` | 复杂需求推进、方向裁决、多路线取舍、需要先定边界与主路的任务 | 定道 \| 收术 \| 落法 \| 复核 \| 结果总结 \| blocked | `references/dao/interaction-contract.md`<br>`references/dao/dao-shu-fa-playbook.md`<br>`assets/dao/main-template.md`<br>`references/dao/terminology-baseline.md` |
| `harness-dev` | 开发需求接单、新功能或修 bug 的执行前判断、方案评审、复杂实现推进、代码问题诊断与持续推进 | 继续理解 \| 起草主文件 \| 先做复核 \| 直接推进 \| blocked | `references/dao/terminology-baseline.md`<br>`references/dao/interaction-contract.md`<br>`references/harness-dev/workflow-kit.md`<br>`references/harness-dev/review-kit.md`<br>`assets/harness-dev/main-template.md`<br>`assets/harness-dev/execution-template.md` |
| `game-plan` | 游戏系统策划、玩法策划、功能策划、数值策划、经济循环设计、商业化设计、关卡与活动规划、叙事与世界观规划、新手引导与版本规划、长期运营内容规划 | 继续理解 \| 输出策划草案 \| 输出系统方案 \| 输出数值框架 \| 输出商业化方案 \| 输出关卡 / 活动方案 \| 输出叙事 / 世界观草案 \| 输出版本 / LiveOps 方案 \| 输出执行前提草案 | `references/dao/terminology-baseline.md`<br>`references/dao/interaction-contract.md`<br>`references/game-plan/coverage-matrix.md`<br>`references/game-plan/system-numeric-commercial-playbook.md`<br>`references/game-plan/content-level-liveops-playbook.md` |
| `game-design` | 游戏 UI/UX/UE 设计、HUD 与菜单设计、角色与场景视觉设计、宣传与品牌视觉设计、特效与演出视觉设计、游戏整体视觉方向整理 | 继续理解 \| 输出视觉草案 \| 输出 UI/UX/UE 方案 \| 输出角色 / 场景视觉方向 \| 输出宣传 / 品牌视觉方案 \| 输出特效 / 演出方向 \| 输出交接说明 | `references/dao/terminology-baseline.md`<br>`references/dao/interaction-contract.md`<br>`references/game-design/aesthetic-benchmark.md`<br>`references/game-design/coverage-matrix.md`<br>`references/game-design/uiuxue-visual-playbook.md`<br>`references/game-design/character-scene-prop-playbook.md`<br>`references/game-design/brand-packaging-playbook.md`<br>`references/game-design/fx-cinematics-playbook.md` |
| `feature-plan` | 通用功能设计、需求理解、方案规划与 bug 诊断 | 继续理解 \| 输出规格草案 \| 输出方案 \| 输出 bug 排查路径 \| 输出执行前提草案 | `references/dao/terminology-baseline.md`<br>`references/dao/interaction-contract.md`<br>`references/feature-plan/planning-playbook.md`<br>`references/feature-plan/delivery-playbook.md` |
| `design-spec` | 页面设计、模块设计、交互设计、视觉设计、UI/UX 优化、信息架构、状态设计、设计说明文档整理 | 继续理解 \| 输出行为草案 \| 输出设计草案 \| 输出优化建议 \| 输出交接说明 | `references/dao/terminology-baseline.md`<br>`references/dao/interaction-contract.md`<br>`references/design-spec/aesthetic-benchmark.md`<br>`references/design-spec/ui-visual-playbook.md` |
| `implement-code` | 边界明确的新功能实现、bug 修复、重构落地、补测试、按既有方案编码 | 直接实现 \| 先写失败测试 \| 先清空待确认项 \| 先补证据 \| 需要升档 | `references/dao/interaction-contract.md` |
| `project-guide` | 新项目接手、项目规范整理、README/规则文档整理、AI 上下文基线整理 | 继续理解 \| 更新现有主文档 \| 新建项目 guide \| 输出 AI 基线 | `references/dao/interaction-contract.md` |
| `review-sslb` | 使用三省六部式代码审查，按中书省、尚书省、六部、门下省、锦衣卫五阶段输出结构化审查结论 | 审查范围、六部意见、门下省终审、锦衣卫监察密报 | `references/review-sslb/ui-aesthetic-review.md`<br>`references/dao/interaction-contract.md` |
| `ribao` | 根据当天工作内容、总结或 git 变更，生成一份可复用的结构化成果描述；可直接用于日报、git commit message 或 git PR message | 日报 / commit message / PR message 的结构化成果描述 | 无 |
