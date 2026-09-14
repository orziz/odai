# Odai 全面清洗与架构规则升级

状态：实施、组合验证与独立定向复核完成。基线 `28fafcb`。本文件是本次跨轮工作唯一持久执行状态；过程日志不纳入发布材料。

## 目标与有效决定

用户要求：“我想做一次全面的清洗、重构和架构、规则升级、优化”。范围包括 canonical 本体、DSH runtime、Agent/Plugin、控制中心及现役维护和发布入口。

用户在 `routing-protection-policy` 选择“分开安全保护与能力选择（推荐）”，随后在 `scoped-protection-unknown-effects` 选择“采用可核实范围，未知副作用保守拦截（推荐）”。高后果提高证据与授权强度，只有实际能力缺口才路由职责；其余已授权工作继续，不能凭模型自报或不可靠路径检查释放机器保护。

保持讨论确认、用户模型与调度选择、未决取舍、来源核实、子代理只读、总控整合与最终交付。CLI 及对应计划冻结；安装 DSH 与用户数据只读；不发布或迁移。双包继续归入未发布候选 `0.2.31`；canonical `0.3.15`、runtime contract `6`、精确 peer `0.1.5-rc.1`。已发布 `0.2.30` 按历史保留。

## 覆盖与处置

| 范围 | 证据与处置 |
| --- | --- |
| canonical 本体与八个 reference owner | 复核入口及 dao/planning/craft/verification/support/leverage/care/human-safety 的职责边界；当前 canonical 已明确高后果不制造角色、讨论确认、制作与跨轮计划分离、整体整理覆盖和关怀隐私。本次修正 DSH 的实际偏差；不重写通用正文或另起 skill 版本。28 个 canonical 文件通过完整性、合同与制品逐字节检查。 |
| researcher 任务传递 | 原固定因果调查模板会改写普通多源问题；改为传递实际 gap、expectedChange、evidenceRefs 和用户原任务。child 与 same-turn 均验证任务保真、来源范围及精确引用要求。 |
| 风险与职责选择 | 高影响因果组合改为总控证据提醒；引用/低影响转换不自动制造 planner。真实 gap 仍按配置路由；缺失职责所依赖的高影响执行保持保护。旧隐式路由测试迁移时保留模型、失败、恢复与去重验收。 |
| 职责生命周期与权限 | 现有 responsibility-scope owner 统一启动、认领、停止与恢复；回执/输出临时状态留在生命周期 owner。只读职责权限独立于风险状态。活动 scope 通过同进程 lease 绑定真实 owner，另一实例可回交但不接管请求/错误处理；dispose 后可从 durable evidence 恢复。 |
| Agent/Plugin 共存与控制中心 | 独立源码复核发现并修复非 owner 误停活动 scope、错误处理遗留 pending receipt；真实跨实例工具回交与交换 hook 顺序经过验证。Control Center 共享 RPC 注册/引用计数、客户端投影、迟到回执和 route-vs-task 身份保持；未发现应改写的 UI 结构。 |
| 保护持久化 | 同一步职责保护释放后的风险保护曾被 type/turn/step 去重吞掉；新保护 ID 加入 scope/source/reason。旧非空 stored ID 和 schemaVersion 1 保留，不迁移历史。覆盖同保护去重、旧 sidecar 重载和新风险保护有效性。 |
| 安装/卸载/恢复 | 复核 Agent installer、control-center-installer、operation-lock、preset 与 Plugin 实际入口；保持完整性检查、冲突拒绝、精确版本、备份与用户数据保留。fixture 套件和真实 SDK 加载通过。修复 Agent load probe 从根目录误把 dsh/ 当可执行文件的问题。 |
| 配置、记忆、输入、压缩及关怀 | 保留现有 owner 与公开接口，不新增角色或持久状态 schema；全套 DSH 检查覆盖配置失效/恢复、输入归属、记忆边界、关怀独立连续性、输出/压缩与取消等消费者。 |
| 发布与维护 | 保留已有 registry/tarball 摘要幂等门；现有 DSH 版本验证器增加唯一 Unreleased、canonical 归属、兼容表首行与倒序检查。通用版本策略仍无第三方依赖，standalone canonical validator 可独立运行。更新维护命令和 live smoke 契约。 |

## 验证结论

- `npm run check:dsh`：runtime、Agent、Plugin 严格类型检查及渲染后的浏览器脚本检查通过。
- 当前组合的 runtime / Plugin / Agent 与 Web RPC：302 项测试通过；新增用例覆盖双 runtime 两步交换顺序、对侧工具 handback、取消/context-window/provider 错误、effect disposal 后恢复及保护 sidecar 重载。
- canonical validator：28 个 Odai 文件、2 个 ribao 文件，零 warning；合同、版本策略与发布入口合计 139 项测试通过。
- 真实 `dsh --version` 为 `0.1.5-rc.1`；Plugin load probe 与 Agent load/scope probe 在临时环境通过。Odai kernel 只注入对应 preset，子代理写入被拦截，动态工具曝光同步。
- 实际双包核验：Plugin 201 entries、Agent 224 entries；共享 164 个 runtime files / 41 个 modules、28 个 canonical files 逐字节一致，入口目标有效。
- 双包 `pack:dry-run` 通过；六个临时 runtime/skill/client 目录均已清理；`git diff --check` 通过。
- 独立定向复核确认跨实例 owner、request-error、handback、卸载恢复、保护事件身份和 stored ID 兼容问题闭合，无新的有据阻断项。独立复核没有重复运行测试。

## 保留的限制

- 当前 DSH 同步 guard 不能把插件侧 path/realpath 检查绑定到实际异步 ctx.fs 写入，且文件系统环境可不同；文件对象不交叠也不证明行为影响面独立。本次不提供未经证明的文件级局部写入放行，已有机器保护继续保守处理未知副作用。
- 旧非空 stored ID 保持原样；没有 ID 的记录仍按现行算法派生 ID。未验证旧版与新版 runtime 同进程混装；支持的双包版本按兼容表配对。
- 未运行付费 live-model smoke 或新模型能力/成本评测，不把合同、单测、SDK 加载和制品检查冒充这些成绩。
- 未改安装 DSH、用户 profile/session/data、冻结 CLI；未发布。

## 收口

本次授权范围内实现与验收已完成，最终 diff 已核对；本文件随实现与更新后的 CHANGELOG 同提交。上述宿主能力和真实模型评测限制不冒充已解决。原始日志位于会话临时目录的 odai-upgrade-* 与 odai-coexistence-*，不作为长期仓库产物。
