# Odai DSH 版本兼容对照表

本表用于选择 `odai-dsh-plugin`、`odai-dsh-agent` 与 `@deepseek-ai/dsh` 的可用版本组合。表中的 DSH 版本是逐项验证并明确声明的精确版本，不表示更早或更新的 DSH 版本也兼容。

| odai-dsh-plugin | odai-dsh-agent | 支持的 @deepseek-ai/dsh | 说明 |
| --- | --- | --- | --- |
| `0.2.17` | `0.2.17` | `0.1.1-rc.2`、`0.1.2-alpha.2` | 当前未发布候选；修复 Agent Control Center 来源/版本误判，改为显式 `y/yes` 授权并为失败 profile 变更提供回滚 |
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
2. “支持的 DSH”是精确白名单。`0.2.15`、`0.2.16` 与 `0.2.17` 仅支持 `0.1.1-rc.2` 与 `0.1.2-alpha.2`，不自动承诺兼容其他 rc、alpha 或 `0.1.2` 版本。
3. 后续版本可以只对应一个 DSH 版本；届时该行只会列出一个精确版本，不再默认保留旧版兼容。
4. 运行时兼容不等于 DSH 自有数据可以跨版本迁移。特别是 rc.8 的 SQLite 存储格式与旧版本不兼容，切换 DSH 版本前应按上游说明备份和迁移宿主数据。
5. 从 `0.2.5` 起，本仓库自有的新版本标识不得包含数字字符 `4`；历史版本（如 `0.0.4`）按事实保留，上游 DSH 版本不受该规则限制。

DSH 包兼容关系的机器可读事实源是 [`compatibility.json`](./compatibility.json)；[`release-contracts.json`](./release-contracts.json) 进一步固定每个受支持 DSH release 的发布时间边界、纯依赖图包数、Standard composition 路径和摘要，`scripts/verify-dsh-release-matrix.mjs` 据此复现 source 或真实 tgz 的隔离 load。仓库自有版本规范的事实源是 [`../version-policy.json`](../version-policy.json)。发布前校验器会同时强制版本规范、当前双包 `peerDependencies`、对应矩阵行与 release contracts 完全一致；本文是供人查阅的展开视图。
