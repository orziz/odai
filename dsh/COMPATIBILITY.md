# Odai DSH 版本兼容对照表

本表用于选择 `odai-dsh-plugin`、`odai-dsh-agent` 与 `@deepseek-ai/dsh` 的可用版本组合。历史行按发布事实保留；从 `0.2.20` 起，支持范围与 release matrix 实测版本分别声明，不把范围内版本自动写成逐个实测。

| odai-dsh-plugin | odai-dsh-agent | 支持的 @deepseek-ai/dsh | 说明 |
| --- | --- | --- | --- |
| `0.2.23` | `0.2.23` | `0.1.2-rc.1` | 当前未发布候选；正常 runtime 与安装器退役全部 rc.2 协议/Session 分支；仅保留显式 `legacy-session-repair` 处理升级 DSH 后被历史 Odai event 阻断的旧 session；修复 Plugin-only Control Center host 的 late-`connection` 注册；alpha.1 因缺少 npm 制品及无损外部 event 迁移路径而暂不支持 |
| `0.2.22` | `0.2.22` | `0.1.1-rc.2` 或 `>=0.1.2-alpha.5 <0.1.2` | release matrix 只跑 rc.2 旧服务与 rc.1 新服务/source；alpha.5 由范围覆盖，不另设重复检查；增加带认证用户原文来源的 active/superseded requirement provenance，不增加角色或 stage |
| `0.2.21` | `0.2.21` | `0.1.1-rc.2` 或 `>=0.1.2-alpha.5 <0.1.2` | 已发布；当时实际跑过 rc.2、alpha.5 与 rc.1，以 rc.1 Standard 为 source；Control Center 分别适配旧 conversation services 与 `uiConversation.events/views` |
| `0.2.20` | `0.2.20` | `0.1.1-rc.2` 或 `>=0.1.2-alpha.5 <0.1.2` | 已发布；Agent preset 可加载，但 alpha.5/rc.1 的 Control Center 会等待 rc.2-only services 并阻断 Web boot，应升级到 `0.2.21` 或后续兼容版本 |
| `0.2.19` | `0.2.19` | `0.1.1-rc.2`、`0.1.2-alpha.4` | 已发布；以 alpha.4 Standard 为 source，按公开 `snapshotEvents()` 适配 Session 读取，保留 rc.2 精确回渲染与默认行为 |
| `0.2.18` | `0.2.18` | `0.1.1-rc.2`、`0.1.2-alpha.2` | 已发布；Control Center 可见交互提示恢复 `[Y/n]`，直接回车默认同意，EOF 与非交互仍拒绝 |
| `0.2.17` | `0.2.17` | `0.1.1-rc.2`、`0.1.2-alpha.2` | 已发布；修复 Agent Control Center 来源/版本误判，要求显式 `y/yes` 授权并为失败 profile 变更提供回滚 |
| `0.2.16` | `0.2.16` | `0.1.1-rc.2`、`0.1.2-alpha.2` | 已发布；在 0.2.15 契约上增加 Agent/Plugin 共享中文 Control Center、受 loopback 保护的真实 evidence/routing RPC、Agent `[Y/n]` 安装入口，以及单装和双装共存；其 Agent 状态检查会把已有本地 dependency 误报为 installed |
| `0.2.15` | `0.2.15` | `0.1.1-rc.2`、`0.1.2-alpha.2` | 已发布；以 alpha.2 Standard 为 source 并为 rc.2 精确回渲染，集成 canonical 0.3.7 / runtime contract 6，以 manifest owner 拓扑和 controller-only reference bridge 按需读取 canonical references；独立 Executor 与 route-card/stage 已移除，实施归 controller |
| `0.2.13` | `0.2.13` | `0.1.1-rc.2` | 已发布；修复 economy ceiling 下的会话解锁与截断续作死循环，保持 canonical 0.3.5 |
| `0.2.12` | `0.2.12` | `0.1.1-rc.2` | 已发布；集成 canonical 0.3.5 意图对齐，并绑定 DSH 任务状态与用户问答证据 |
| `0.2.11` | `0.2.11` | `0.1.1-rc.2` | 配置入口统一使用有 owner 的并发锁，保持 canonical 0.3.3 |
| `0.2.10` | `0.2.10` | `0.1.1-rc.2` | 更新 canonical 0.3.3 的攻守与探索构想合同 |
| `0.2.9` | `0.2.9` | `0.1.1-rc.2` | 仅保留 rc.2，并修正实施 craft 与 Reviewer test/check 证据识别 |
| `0.2.8` | `0.2.8` | `0.1.0-rc.7`、`0.1.1-rc.1`、`0.1.1-rc.2` | 新增逐职责 dispatch 与只读职责 handback |
| `0.2.7` | `0.2.7` | `0.1.0-rc.7`、`0.1.1-rc.1`、`0.1.1-rc.2` | 修正 Planner/Reviewer 责任路由、原生证据与三版本发布 gate |
| `0.2.6` | `0.2.6` | `0.1.0-rc.7`、`0.1.1-rc.1` | strict TypeScript runtime 迁移与 0.1.1 兼容 |
| `0.2.5` | `0.2.5` | `0.1.0-rc.7`、`0.1.0-rc.8` | 修复动态工具 schema/执行目录时序，不再支持 rc.6 |
| `0.2.3` | `0.2.3` | `0.1.0-rc.6`、`0.1.0-rc.7`、`0.1.0-rc.8` | Agent 以 rc.8 Standard 为 source，并为 rc.7/rc.6 精确向后渲染 |
| `0.2.2` | `0.2.2` | `0.1.0-rc.6`、`0.1.0-rc.7` | 同步双包版本 |
| `0.2.1` | `0.2.1` | `0.1.0-rc.6`、`0.1.0-rc.7` | 同步双包版本 |
| `0.2.0` | `0.2.0` | `0.1.0-rc.6`、`0.1.0-rc.7` | 首个支持 rc.7 的版本 |
| `0.1.1` | `0.1.1` | `0.1.0-rc.6` | 同步双包版本 |
| `0.1.0` | `0.1.0` | `0.1.0-rc.6` | 同步双包版本 |
| `0.0.10` | `0.0.10` | `0.1.0-rc.6` | 从此版本起 Plugin 与 Agent 作为同一发布单元同步维护 |
| 未发布 | `0.0.9` | `0.1.0-rc.6` | 仅发布了 Agent |
| `0.0.8` | `0.0.8` | `0.1.0-rc.6` | 历史版本 |
| `0.0.7` | `0.0.7` | `0.1.0-rc.6` | 历史版本 |
| `0.0.6` | `0.0.6` | `0.1.0-rc.6` | 历史版本 |
| `0.0.5` | `0.0.5` | `0.1.0-rc.6` | 历史版本 |
| `0.0.4` | `0.0.4` | `0.1.0-rc.6` | 历史版本 |
| `0.0.3` | `0.0.3` | `0.1.0-rc.6` | 历史版本 |
| `0.0.2` | `0.0.2` | `0.1.0-rc.6` | 历史版本 |
| `0.0.1` | `0.0.1` | `0.1.0-rc.6` | 首个双包版本 |

## 使用规则

1. 从同一行选择版本组合，不要混用不同版本的 Plugin 与 Agent。`0.0.10` 及之后的两个包必须保持相同版本。
2. `0.2.15` 至 `0.2.18` 只支持精确的 `0.1.1-rc.2` 与 `0.1.2-alpha.2`；`0.2.19` 只支持精确的 rc.2 与 alpha.4。`0.2.20`、`0.2.21` 与 `0.2.22` 都按各自已发布合同保留 rc.2 和后续 `0.1.2` prerelease 范围；`0.2.23` 起只支持精确 rc.1。
3. `dshVersions` 只表示 release matrix 完整跑过的精确版本，`dshRange` 才是支持范围。当前 `0.2.23` 两者都收敛到 rc.1；没有 npm 发布制品的 `0.1.3-alpha.1` 不进入矩阵或 peer，即使其官方 tag 能构建且 Standard composition 摘要相同。
4. 运行时兼容不等于 DSH 自有数据可以跨版本迁移。`0.1.3-alpha.1` 的 v0→v1 Session 迁移会拒绝历史外部 Odai event，即使该 event 已标记 `ignorable`；在上游或本项目提供不丢数据的受控迁移前，不声明该版本兼容。rc.8 的 SQLite 存储格式也与更早版本不兼容，切换 DSH 版本前应按上游说明备份和迁移宿主数据。
5. 从 `0.2.5` 起，本仓库自有的新版本标识不得包含数字字符 `4`；历史版本（如 `0.0.4`）按事实保留，上游 DSH 版本不受该规则限制。

DSH 包兼容关系的机器可读事实源是 [`compatibility.json`](./compatibility.json)；[`release-contracts.json`](./release-contracts.json) 进一步固定当前范围、source 版本，以及每个实测版本的发布时间边界、纯依赖图包数、Standard composition 路径和摘要，`scripts/verify-dsh-release-matrix.mjs` 据此复现 source 或真实 tgz 的隔离 load。仓库自有版本规范的事实源是 [`../version-policy.json`](../version-policy.json)。发布前校验器会同时强制版本规范、当前双包 `peerDependencies`、对应矩阵行与 release contracts 完全一致；本文是供人查阅的展开视图。
