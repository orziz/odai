# 仓库维护约束

## odai 必用

- 本仓库中的每次用户请求都必须使用 canonical `skills/odai/SKILL.md` 治理。若宿主明确声明当前 `odai-dsh-agent` 或 `odai-dsh-plugin` 已把完整 canonical governance 注入系统提示，并给出 skill version、runtime contract 与 bundle digest，则该注入本身视为已完整加载；声明有效且本会话未改动 canonical bundle 期间，不得再调用 skill 或 `read` 重复载入同一正文。仅当注入声明缺失或不可信、任务直接审查或修改 Odai、或 manifest 声明的 canonical 文件在注入后发生变化时，才须在行动前完整读取当前 `SKILL.md`，并以新内容继续治理。其他宿主若当前任务尚未完整读取其当下版本，任何调查、判断、修改或测试前先完整读取。
- 按 odai 的真实缺口决定是否读取支撑资料；使用 odai 不等于自动增加计划、路由、角色、文件、测试或流程，简单任务仍直接完成。
- 对 odai 自身及其配套机制的修改同样受 odai 治理：先判断是否必要、是否比现状更成事、是否有可验证净增益，再决定保留、修改或退役，不因已有实现、历史方案、题本得分或局部可实现性继续堆叠。
- 以减少 token、延迟或成本为目的的优化，必须先用行为契约、反例与测试证明既有能力和安全边界不退化，再评估节省是否成立；不能验证保持项、只测预算下降、依赖模型自报或以删除能力换取指标时，不得合入或发布。
- 评测维护、题本设计、裁判与报告整理仍按上述要求治理；真正受测的 runner 则严格服从冻结的评测臂，不继承本节。`on` 只加载该臂声明的冻结 skill 与项目材料；`off` 必须在干净隔离环境运行，不读取或注入 odai、`.odai/local.md`、odai 路由或 Hooks、要求使用 odai 的仓库指令、其他臂输出、既往 runner 转录或其派生状态。

## 官方 skills 单一事实源

- `skills/odai/` 与 `skills/ribao/` 是各自唯一可编辑的 canonical source；odai 是统一入口与最终交付 owner，ribao 是可独立加载的专业汇报能力。
- `cli/skills/` 不在仓库中常驻；它只由 npm `prepack` 临时生成，并在 `postpack` 清理。
- 即使用户或 IDE 指向打包期间临时出现的 `cli/skills/`，也要把对应修改落到仓库根 `skills/<name>/`。
- source 修改完成后，运行 `node scripts/validate-odai-skill.mjs` 验证 canonical skills。
- canonical references 按单一所有权维护：`references/planning.md` 只负责正式计划、可执行合同与跨轮续作，`references/craft.md` 只负责已决定结果的制作工艺，`references/leverage.md` 只负责能力与责任选择、调度和交接；角色合同只引用对应 owner，不复制另一层的清单或宿主机制。
- odai-cli 未冻结时，发布相关修改还需运行 `npm --prefix cli run pack:dry-run`，确认产物与当前声明的打包范围一致，且命令结束后没有遗留 `cli/skills/`；冻结期间遵循下节边界。

## odai-cli 冻结边界

- `cli/`、`plans/odai-cli-plan.md` 与 `plans/odai-cli-runtime-canary.md` 当前冻结，不属于 active canonical / DSH 维护与验收范围。除非用户明确重新开放，不修改、测试、打包、升版或发布 odai-cli，也不为兼容它改变 canonical 或 DSH 路线。
- 冻结期间，canonical / DSH 变更不运行 CLI tests 或 `npm --prefix cli run pack:dry-run`；只记录可能影响未来恢复的已知差异。`cli/skills/` 仍不得作为可编辑 source 或遗留在仓库中。

## 版本发布约束

- 从本约束生效后的首个候选版本起，本仓库自有的任何新版本标识都不得包含数字字符 `4`；npm package version、skill version 与 runtime contract version 均受约束，版本序列遇到含 `4` 的候选值时必须直接跳过。已发布历史版本及其兼容记录必须按事实保留，不因本约束改写；上游依赖版本不属于本仓库自有版本，不受此规则限制。
- 禁止只靠人工记忆执行本约束。所有发布入口与版本事实源必须调用仓库的统一版本策略校验；新增版本载体时必须同时纳入该校验，命中禁用字符即 fail-closed。
- 同一 npm 候选从未发生过 registry publish，且未废弃或经用户明确拆分时，后续改动继续归入该候选；不得仅因新一轮任务、canonical / runtime contract 变化或新增 changelog 内容另起包版本，也不得把当前候选写成历史。版本一旦曾发布，即使后来 unpublish 或 deprecate，该标识也视为已消耗，不得复用。改版本前先核对 package metadata、当前唯一 Unreleased owner 与真实 registry 发布事实。

## DSH 集成修改边界

- `odai-dsh-plugin` 与 `odai-dsh-agent` 的问题必须在本仓库内解决；修复实现、兼容层、配置、补丁、测试和文档只能落到本项目受版本控制的文件中。
- `skills/odai/` 只承载跨宿主都成立的治理语义和通用角色合同；DSH 的 hook、工具名、same-turn / child 调度、路由状态、证据事件、provider / model 字段与 token 优先级必须落在 `dsh/runtime/`，不得为方便复用写入 canonical skill、通用角色正文或 `.odai/local.md`。
- DSH 可在运行时组合 canonical 通用合同与 `dsh/runtime/` 私有补充合同。语义是否上移 canonical 由责任归属与证据决定，不设固定宿主数量门槛：只有该语义跨宿主成立、不含 DSH 机制，证据足以支持其通用净收益，且兼容影响与迁移已明确验证时才上移；单一宿主暴露问题既不自动证明通用，也不自动阻止通用治理修正。需要新增 required file 或改变读取契约时必须显式升级 skill version / runtime contract，不得顺带修改。
- `AGENTS.md` 只记录上述稳定落位规则；具体触发条件、事件字段、预算值和实现流程以 `dsh/runtime` 源码及同目录测试为事实源，避免文档副本漂移。
- `odai-dsh-agent` 与 `odai-dsh-plugin` 作为同一发布单元维护；从 `0.0.10` 起两个 `package.json` 的版本号必须完全一致，同一功能发布同时升版。测试与 prepack 必须运行仓库版本一致性检查，禁止单包漂移或用已发布旧版本承载新改动。
- DeepSeek Harness 的源码 checkout、全局或本地安装包、`node_modules/@deepseek-ai/dsh` 及其核心文件一律只读，只能用于定位行为、核对契约和运行兼容性验证；不得直接修改、打补丁或用本机改造后的 DSH 冒充本项目修复。
- 必须处理 `$DSH_HOME` 中既有用户数据时，只能通过本项目内受版本控制、可审计并带备份与验证的迁移入口执行；迁移须遵守用户授权和停机要求，不得手工篡改 DSH 会话、profile 或核心状态来绕过问题。
