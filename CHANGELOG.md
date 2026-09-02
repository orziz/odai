# Changelog

本文只记当前唯一 Unreleased 候选与已冻结版本的对外能力、架构、迁移和评测口径。试跑、复跑、中间分和临时输出不进入本日志；原始证据由临时运行目录与 Git 历史承担。

## Unreleased — DSH 0.2.19 alpha.4 compatibility

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步进入未发布 `0.2.19` 候选，精确支持正式 `@deepseek-ai/dsh@0.1.1-rc.2` 与 prerelease `0.1.2-alpha.4`；`0.1.2-alpha.2` 只保留为已发布 `0.2.15` 至 `0.2.18` 的历史合同。canonical skill 保持 `0.3.7`、runtime contract 保持 `6`，冻结的 CLI 保持 `0.0.2`。
- Agent source composition 跟随 alpha.4 Standard，保留 continuable spawn/fork 的父子双向 `send_message` 宿主能力；安装到 rc.2 时继续精确移除 goal command、spawn 模型选择与 alpha.4 fork messaging 说明，并恢复 rc.2 Web fetch 设置。rc.2 保留 parent-to-child `send_message` 与独立 child `report`，不冒充 alpha.4 的双向相邻 Agent 通信。
- Runtime 的 session event 读取统一经过公开能力适配：alpha.4 使用 immutable `snapshotEvents()`，rc.2 继续使用 `events`。Odai 自有 durable evidence sidecar、legacy repair、职责选择、controller ownership、授权与验收合同保持不变；宿主原生通信和 Session API 不被冒充为这些治理语义。
- Semantic memory 拒绝会持久压制事实纠正、重大风险、证据、安全或授权检查的偏好；旧 store 中此类记录仍可查看和物理删除，但不再召回、注入或确认。bounded retrieval miss 不再冒充“没有相关记忆”，controller 在要求用户重复既有上下文前须先 inspect/search；“不运行完整测试套件”等仍允许针对性验证的范围偏好保持可用。
- Control Center 会话时间线按各组最新 evidence 从新到旧排列，数字轮次自然保持倒序；无 `turn` 的证据明确标为“轮次外事件”，若它最新则显示在顶部但保持折叠。默认选中并展开当前最新数字轮次，不再因末条轮次外 evidence 自动切换展开组；稳定轮次 key、事件窗口和 Inspector 保持原有边界。

## 2026-09-01 — DSH 0.2.18 Control Center default confirmation

- `odai-dsh-agent` 与 `odai-dsh-plugin` 已同步发布 `0.2.18`，精确支持 `@deepseek-ai/dsh@0.1.1-rc.2` 与 `0.1.2-alpha.2`；canonical skill 保持 `0.3.7`、runtime contract 保持 `6`，冻结的 CLI 保持 `0.0.2`。registry `gitHead` 均为 `f2cdb96ce1f2037edd3e97c59ef414ffe42d3bb8`。
- Agent Control Center 的可见交互提示恢复为 `[Y/n]`：直接回车、`y` 或 `yes` 同意当前已明确展示的安装、升级、替换或修复；`n`、`no` 与其他文本拒绝。EOF、非 TTY 和 JSON 仍不推断同意，自动化必须显式使用 `--with-control-center`。
- Control Center 长会话改用稳定工作区：当前轮次板、时间线与事件检查器不再共享整页滚动，时间线和检查器分别滚动；闭合轮次不挂载事件行，展开轮次默认仅挂载最近 100 条并可逐批读取更早证据。追加式证据指纹跳过无变化轮询的 React 更新，host 通过文件 revision 在未变化时只返回 `unchanged`，不再重复读取、解析和传输最多 2000 条 JSON；事件 raw 裁剪与脱敏延迟到选中项。时间线分区与检查器信息提高到 11–13px，JSON 提高到 12px / 18px 行高。
- 发布前 DSH strict build、Agent `22/22`、Plugin/runtime `217 pass / 3 skip`、版本策略、canonical validator 与双包 dry-pack 通过。两个真实 `0.2.18` tgz 在临时 rc.2 Web profile 中共存启动；Chromium 以 2000 条 evidence 在 1280×800 与 390×844 验证固定工作区无重叠，初始/展开事件 DOM 为 5/100，静态轮询 DOM mutation 为 0，稳定态 unchanged RPC 响应为 168 bytes。

## 2026-09-01 — DSH 0.2.17 Control Center installation recovery

- `odai-dsh-agent` 与 `odai-dsh-plugin` 已同步发布 `0.2.17`，继续精确支持 `@deepseek-ai/dsh@0.1.1-rc.2` 与 `0.1.2-alpha.2`；canonical skill 保持 `0.3.7`、runtime contract 保持 `6`。registry `gitHead` 均为 `ca336348fcb610e5fe4aaf6ec7d015ef41241b4c`；冻结的 CLI 保持 `0.0.2`。
- Agent Control Center 不再把任意 profile dependency 视为已安装：状态检查同时核对精确 registry 版本、bundle 唯一性、实际解析版本及 host/runtime/client 必需文件，并明确区分 absent、current、registry upgrade、本地 `file:`/`link:`、partial drift、较新版本和未知来源。已发布 `0.2.16.tgz` 经 registry 清单复核包含完整 Control Center runtime；本次修复针对旧本地源码 dependency 被误报 current 后加载已清理 artifact 的故障。
- 集成 `install` 只有显式输入 `y`/`yes` 才新增、升级、替换或修复 Web profile；空输入、`n`、其他文本、EOF、非 TTY 与 JSON 默认均不修改，自动化继续使用显式 `--with-control-center`。current 状态明确报告精确 registry 版本且不运行包管理器，较新版本禁止静默降级。
- profile 修改固定写入精确 registry 版本；失败时执行逆向包管理动作并恢复原 package/lock/workspace 元数据，回滚失败则在 `$DSH_HOME/odai/control-center-backups/` 保留审计副本。独立 Agent preset、既有 Plugin dependency/bundle 与其他 profile 内容不属于替换范围。
- DSH strict build、Agent `22/22`、Plugin/runtime `216 pass / 3 skip`、版本策略、canonical validator 与双包 dry-pack 通过；两个真实 `0.2.17` tgz 在临时 rc.2 Web profile 中共存启动，Agent preset、两个 client manifest、唯一 Control Center RPC 与 Standard/Odai canonical 隔离均通过；双包随后从同一 commit 发布。

## 2026-09-01 — DSH 0.2.16 Control Center

- `odai-dsh-agent` 与 `odai-dsh-plugin` 已同步发布 `0.2.16`，继续精确支持 `@deepseek-ai/dsh@0.1.1-rc.2` 与 `0.1.2-alpha.2`；canonical skill 保持 `0.3.7`、runtime contract 保持 `6`。registry `gitHead` 均为 `e8612e64b4570f923843eb56ade27823477f0313`；CLI 保持 `0.0.2` 并冻结。
- Agent 与 Plugin 由同一份 `dsh/client/src/index.mts` 严格类型源码生成中文 Odai Control Center，展示真实当前轮职责图、session evidence 时间线、结构化事件检查器与四职责路由；总控保持宿主管理且只读，配置不冒充执行证据。浏览器 `client.js` 仅为构建制品，不再作为手写 source。
- Plugin 安装后直接提供 Control Center；Agent 的交互式 `install` 在 preset 发布后以 `[Y/n]` 询问是否把同包 Control Center 加到指定 Web profile，回车默认安装、`n` 跳过，非交互与 JSON 模式必须显式传 `--with-control-center`。两包允许单装或同时安装；共存时 Plugin client 优先拥有唯一界面，host RPC 进程内去重，配置与 evidence 共享，移除任一包不删除另一包仍使用的持久状态。
- Control Center 的 routing 写入经 loopback RPC 复用已有 provider/model 校验、owned lock 与原子 routing action；evidence 从 `$DSH_HOME/odai/session-evidence/` 读取，未新增 DSH 私有 session event。用户界面职责名为调查、规划、审查、设计，内部稳定契约仍为 researcher、planner、reviewer、frontend。
- 发布前统一版本策略、兼容矩阵校验、canonical validator、DSH strict typecheck、完整 Plugin/runtime 与 Agent 测试、双包 dry-run 均通过；source release matrix 在 rc.2（188 包）与 alpha.2（215 包）纯依赖图上通过 session compatibility、Plugin/Agent load，以及两个真实 `0.2.16` tarball 的同 profile 共存，确认两个 client manifest、唯一可用 Control Center RPC 与 Standard/Odai 各自唯一 canonical section。

## 2026-08-31 — DSH 0.2.15 alpha.2 compatibility and controller-owned implementation

- `odai-dsh-agent` 与 `odai-dsh-plugin` 已同步发布 `0.2.15`，精确支持 `@deepseek-ai/dsh@0.1.1-rc.2` 与 `0.1.2-alpha.2`；canonical skill 升为 `0.3.7`、runtime contract 升为 `6`。registry `gitHead` 均为 `91806e02194507fc54f37d1f1c92d7dc65a61093`；该已发布制品不含后续 `0.2.16` Control Center。
- canonical 总体架构调整为 manifest schema 2 机器 owner 拓扑：五个角色与八份 reference 由唯一 map 驱动 validator 和 DSH bundle；kernel 只保留跨场景高注意门，planning 独占主任务状态与续作，support 不再复制状态或 reviewer 流程。DSH 新增 controller-only、只读 `odai_reference`，从当前 turn 已选 bundle 按 digest 读取 reference，不依赖项目 filesystem，也不向 responsibility scope 或 child 暴露。
- canonical 内核把版本、候选、阶段、完成、提交和发布统一视为须由权威事实与真实事件证明的状态；前一状态未结束时原位更新，不再因任务批次、命名或文档叙述制造后继状态。validator 与仓库版本规则机械保持该边界。
- release contract 为每版分别固定真实 registry 截止时间、纯 DSH 依赖图包数、Standard composition 路径与 SHA-256；Agent 以 alpha.2 Standard 为 source，保留其 goal command、spawn 子代理模型选择与 Web fetch 设置，安装到 rc.2 时只逆向移除该版不存在的行并恢复 rc.2 设置。
- 兼容探针按宿主公开合同选择旧 `resolveSessionPreset` 或新 projection，并为 alpha.2 执行 launch-token cookie 交换与生成式 Remote endpoint 映射；rc.2 继续走原无鉴权 `/api/<method>`，共享 helper 的两条路径均有单测。
- 独立 Executor、route card 与 Codex stage runner 退役；controller 继续持有实施、修正与最终交付，planner 只回交有界计划。旧 routing store 中的 Executor 映射在读取时忽略、下一次配置写入时清除，不使仍有效的 planner/reviewer 等映射失效。历史 Executor 对照显示同质量下 runner token `+59.4%`、墙钟约 `3.5x`、估算成本 `+6.0%`，未证明独立责任净收益。
- C01-C34 合并到 `plans/odai-canary.md` 单一事实源，以 `full`、`ab`、`routing`、`ideation`、`defensive`、`intent`、`verification`、`all` suite 选择；默认仍为 C01-C19，显式 `--cases` 可跨 suite，六份重复活动题本删除。
- 发布前 canonical validator、三宿主路由生命周期、版本策略与 DSH typecheck 通过；Plugin/runtime `214/214`、Agent `14/14`、harness suite/旧计划兼容测试、本机 rc.2 official session / Plugin / Agent source probes、双包 dry-run packaging，以及 rc.2（188 包）与 alpha.2（215 包）真实 tgz release matrix 均通过。
- 压缩复核恢复“低成本或可撤回不能替代对齐”，并要求方向性改进先完整呈现范围分歧、对齐真实结果、非目标与不可接受退化；最终 GPT-5.6 Sol/high intent C25-C31 为 `7/7`、`52/52`，同 fingerprint 的高风险 C04 为 `4/4`、`12/12`。其余 suite 未按该 fingerprint 重跑，不标完成。

## 2026-08-28 — DSH 0.2.13 session output recovery

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为并发布 `0.2.13`，继续仅精确支持 `@deepseek-ai/dsh@0.1.1-rc.2`；canonical skill 保持 `0.3.5`，runtime contract 保持 `3`，CLI 保持 `0.0.2`，registry `gitHead` 均为 `129b11ce05afa1cfd89bca29f4678db68c4bd49f`。
- DSH runtime 在模型生成前处理 authenticated session-scoped ceiling 指令：`这个会话放开上限` 只移除当前会话的 Odai Controller ceiling，`这个会话恢复输出上限` 恢复共享策略；不改持久化 output store，不暴露全局持久化配置工具，不移除更低的 host request ceiling，也不影响 child 或职责预算。
- 普通 Controller 回合仅在原始 `turn/end=max-tokens` 与当轮 `odai/output-budget-applied` 共同证明由 controller policy 截断时记录 interruption；紧邻的纯 `继续` 只获得一个 ceiling-free recovery turn。夹带新目标/范围、隔轮继续和 preexisting request ceiling 均不复用该恢复状态。

## 2026-08-28 — canonical 0.3.5 / DSH 0.2.12 intent alignment

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为并发布 `0.2.12`，继续仅精确支持 `@deepseek-ai/dsh@0.1.1-rc.2`；双包所含 canonical skill 升为 `0.3.5`，runtime contract 保持 `3`，CLI 保持 `0.0.2`，registry `gitHead` 均为 `dd5037c26e1fc175abb1ec874dfc87deac26e89b`。
- canonical 明确探索、决定与实施不自动切换；行动要求充分且唯一的意图证据。方向性改进若存在多个合理交付物，先说明分歧并共同定案；实施、提交或发布授权在目标唯一后才生效，不能让目标变唯一。用户纠正会使受影响的旧计划、验收、授权与完成证据失效。
- DSH responsibility gap 与 planner→executor handback 绑定最近的 authenticated direct user message；新任务或“继续，但修改目标/范围”的修订会清除旧 route card，只有未夹带修订的明确继续才保留旧执行上下文。Reviewer packet 保留完整 user question / answer，只接受 question / answer ID 唯一、无缺失且无额外答案的一一对应；incomplete packet 只报告一次并保持待静默重新评估，后续新任务消费旧 proposal，阻断重复 reviewer 循环。
- 意图专项使用严格 `pass-score=4`：C25-C31 最终 **7/7、52/52**。决定性 C31 在同时暴露 canonical、runtime、evaluation 与 submission/publishing 后，`0.3.3` 为 **3/4 fail**，`0.3.5` 为 **4/4 pass**；C26 明确窄改仍是一行 diff 与命中测试，未退化成普遍确认。相称验证 C32-C34 为 **3/3、16/16**：局部 CSS / 窄代码不跑无关 build 或全量，共享 token 则覆盖所有相关消费者，因此不为该问题再堆 canonical 同义规则。
- canonical validator 为 0 warnings，入口估算 2671 tokens；DSH strict typecheck、Plugin/Runtime `213/213`、Agent `14/14`、CLI phase-0、版本/静态合同/harness 测试、Plugin/Agent 实际 pack 与 CLI dry-run packaging 全部通过。由最终双包 tgz 安装的 rc.2 release matrix 验证 official session compatibility、Plugin / Agent load、188 包 pure graph 与 Standard / Odai coexistence；随后双包已从同一 commit 发布。

## 2026-08-28 — DSH 0.2.11 owned configuration locks

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.11`，继续仅精确支持 `@deepseek-ai/dsh@0.1.1-rc.2`；canonical skill 保持 `0.3.3`，runtime contract 保持 `3`。
- 防御力度专项以冻结的 `0.3.3` 运行：内部封闭类型窄改 C23 连续三次均为精确单行补丁且取得 4/4，外部公开输入边界 C24 保留精确 allowlist 并取得 4/4。现有 canonical 已能区分内部不变量与真实信任边界，因此不为总体观感新增治理条款。
- routing 与 skill-source 配置入口删除两套按 mtime 猜测 stale、释放时无条件删除的私有锁，统一复用 PID+UUID owner、活进程判断、claim 串行化和后继保护的 shared store lock；补充旧 mtime 但仍存活 writer 的入口回归，以及 skill bundle lexical / realpath escape 的保持测试。
- Skill bundle、持久状态、child 写入、配置修复与发布身份/gitHead 守卫均有独立失败后果并保持。双包发布事务虽会全量构建八次，但当前不能证明简单去重仍发布被测试和加载的同一 artifact，因此本版不改发布编排。

## 2026-08-27 — DSH 0.2.10 advisor and ideation contract

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.10`，继续仅精确支持 `@deepseek-ai/dsh@0.1.1-rc.2`；canonical skill 升为 `0.3.3`，runtime contract 保持 `3`。
- canonical 恢复总控“谋有攻守”语义，并新增探索构想合同：用户目标是发散或头脑风暴时，非重复候选本身就是交付，候选不先受决策级证据门阻断；事实、假设和建议仍须分开，未要求收敛时不强选唯一路线，讨论不产生写入或实施授权。
- 相邻发现默认只建议；只有它是当前结果成立的必要条件或另获授权才实施。既有契约约束本次改动不新增破坏，但不授权顺手修复与当前结果独立的既存违约。C21 题本只判断方向是否实质不同，不再要求命中预设创意类别。
- GPT-5.6 Sol / high 首轮定向样本为 20/24；收紧题本与必要条件授权边界后，最终同版 hash 的 C21、C01、C02、C17 分别取得 8/8、4/4、4/4、8/8，总计 24/24。
- DSH strict typecheck、Plugin/Runtime `208/208`、Agent `14/14`、canonical validator、版本与兼容矩阵、Plugin/Agent 真实 DSH load、双安装 coexistence 及双包 dry-run packaging 全部通过；生成目录和 tgz 均已清理。Plugin 与 Agent `0.2.10` 已从同一 commit `473dd291fa92cbbe7f99baf33b001d4d4613ef49` 发布，registry `gitHead` 核验一致。
- 发布后新增 C22 近似诱饵，验证请求虽含“多给几个思路”但要求当前决策时，模型会读取证据、比较相关候选并明确收敛；C22 为 8/8，同版 C21 补至三次独立执行且均为 8/8。

## 2026-08-25 — DSH 0.2.9 craft activation and reviewer checks

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.9`，当前候选仅精确支持 `@deepseek-ai/dsh@0.1.1-rc.2`，不再携带 rc.7/rc.1 的 Agent composition 适配与发布矩阵；`0.2.8` 及更早兼容记录按事实保留。canonical skill 保持 `0.3.2`，runtime contract 保持 `3`。
- 明确授权的实施回合现在按需组合 canonical `references/craft.md`，让已有“复用项目约定、最小完整修改”owner 在执行前生效；纯审查回合保持不加载，常见中文“把……改清楚/处理了”实施请求也进入同一授权分类。canonical 文案与 owner 未复制或改写。
- Reviewer 证据新增独立 `check` 类：原生成功 tool result 无需 stdout 再造 PASS 文本，引号内的 test-name 正则不会被误判为 shell pipe；`eslint`、`stylelint`、`tsc/vue-tsc --noEmit`、`prettier --check`、`node --check` 与 `git diff --check` 可提供只读 check，且不增加 `testCount`。失败 check、`--fix`、build、复合 shell、命令替换、后续写入与过期 diff 继续 fail-closed。
- Routed child 的 bounded packet 现在携带当前 responsibility gap，并把最新 Planner handback 保留为独立 planning context；该上下文不增加 user-owned `acceptanceCount`，避免 Reviewer 丢失已冻结 A1/A2 后退回重复规划。
- DSH strict typecheck、Plugin/Runtime `208/208`、Agent `14/14`、canonical validator、版本策略与双包 dry-run packaging 全部通过；researcher、planner、executor、reviewer、frontend 与 user gap 的责任矩阵均有机械覆盖，新增 check-only Reviewer child 集成回执通过。未执行 npm publish。

## 2026-08-22 — DSH 0.2.8 responsibility dispatch and handback

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.8`，继续精确支持 `@deepseek-ai/dsh@0.1.0-rc.7`、`0.1.1-rc.1` 与 `0.1.1-rc.2`；canonical skill 保持 `0.3.2`，runtime contract 保持 `3`。
- `researcher`、`planner`、`reviewer` 与 `frontend` 新增可持久化的逐职责 `same-turn` / `child` dispatch；`executor` 保持 controller-owned `same-turn` 写边界。路由存储升级为 schema 2，同时继续读取 schema 1，模型映射与 dispatch override 可独立设置和移除。
- 新增只读职责 handback：same-turn researcher/planner/reviewer 必须把有界结果交回 controller；planner 只有在 authorized frozen route card 下才能交给 executor。缺失 handback 的终止文本被标记为未验证草稿并自动续回 controller；连续 planner→executor scope 保留原 controller base route。
- 补齐 planner/frontend child、researcher/reviewer→controller、planner→executor、缺失 handback 恢复、schema 迁移与 executor child 拒绝测试；Agent Standard composition 测试按安装器既有 LF 规范化合同跨平台比较。
- 全仓 DSH typecheck、Plugin/Runtime `199 passed / 0 failed / 2 Windows symlink skipped`、Agent `20/20`、版本策略与 canonical validator 全部通过；Plugin 与 Agent 的隔离 DSH load probe 通过，Plugin、Agent 与 CLI dry-run 包结束后均无生成目录或 `.tgz` 残留。未执行 npm publish。

## 2026-08-21 — DSH 0.2.7 routing evidence and rc.2

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.7`，精确支持 `@deepseek-ai/dsh@0.1.0-rc.7`、`0.1.1-rc.1` 与 `0.1.1-rc.2`，不再接受 rc.8；canonical skill 保持 `0.3.2`，runtime contract 保持 `3`。本版本保留既有治理、记忆、会话兼容与工具暴露契约，并修正 Planner/Reviewer 责任 gap 与原生证据路由。
- Planner gap 指引新增独立部署协议、认证状态机、发布顺序与回滚兼容边界；它们只有在独立规划能改变实现或验收时才触发，仍不按复杂度、风险词或角色名称机械路由。
- Reviewer bounded packet 改按证据事件而非 raw stream chunk 限窗，兼容 rc.7 object arguments 与 rc.1/rc.2 JSON-string arguments、namespaced 工具名、同 session 外部工作目录、npm/Vitest/Maven/Gradle 测试入口及大 diff 的逐项截断。只有经认证的直接用户目标或与该用户消息绑定的 authorized route card 可提供 acceptance；assistant/plugin 文本不能自造验收，最终成功测试必须晚于 reviewed diff。`evidenceRefs` 只负责审计与去重，不能伪造 write/diff/test。packet 公开安全诊断，区分 host 证据缺失、未关联结果、参数解析失败、空 patch 和无结论测试。
- `odai_responsibility_gap` 现在明确返回“proposal 已记录、尚未路由或启动”。证据不足的 Reviewer proposal 不再立即消费：相同证据不重复提示，直接用户续作可跨 turn 保留，新的 acceptance/write/diff/test/failure 证据会触发一次自动复评，新任务则显式结清；只有完整且当前的 packet 才启动独立 child，controller 自查仍不算独立验收。
- 新增 `dsh/release-contracts.json` 与三版本 matrix runner，固定每个 DSH release 的发布时间边界、纯依赖图包数和 Standard composition 摘要，可复现 source 的 legacy/Plugin/Agent/coexistence load 与真实 tgz 的 installed-package load；版本校验器强制它与 compatibility matrix、双包 peer 完全一致；兼容实现或支持范围变化时显式运行完整 matrix，交互式双包发布入口不重复执行这组高成本隔离安装。
- 全仓 strict typecheck、Plugin/Runtime `193/193`、Agent `20/20`、版本策略与 canonical validator 全部通过；Plugin、Agent 与 CLI dry-run 包结束后均无生成目录残留。真实 Plugin/Agent tgz 清单覆盖全部 37 个 Runtime `.mjs` 与 30 个 canonical 文件；同一 tgz 分别安装到只含 DSH rc.7、`0.1.1-rc.1` 或 `0.1.1-rc.2` 的隔离依赖图后，公开 ESM 导入、CLI、Plugin legacy/load、Agent install/status/Standard/load 均通过。三版的源码态 Plugin、Agent 与 coexistence 也全部通过，且未执行 npm publish。

## 2026-08-21 — DSH 0.2.6 TypeScript runtime

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.6`，精确支持 `@deepseek-ai/dsh@0.1.0-rc.7` 与 `0.1.1-rc.1`，不再接受 rc.8；canonical skill 保持 `0.3.2`，runtime contract 保持 `3`，本版本不改变路由、治理、记忆、会话兼容或工具暴露行为。
- DSH Runtime、Plugin 与 Agent 的仓库自有实现、CLI、测试、验证/烟测脚本及 `npm-publish` 发布入口全部迁移为 strict TypeScript `.mts`；测试统一归入各包 `tests/`。统一启用 `noImplicitAny`、`noUnusedLocals`、`noUnusedParameters`、`useUnknownInCatchVariables` 与 `noEmitOnError`，以 Agent、Session、Event、Route、Tool、Prompt Assembly、安装器、CLI 和发布结果等结构合同替代宽泛 `any`，不保留 `allowJs`、`@ts-ignore` 或 `@ts-nocheck` 逃生口。
- NodeNext 构建在每次 emit 前清理 Runtime、Plugin、Agent 与发布工具输出目录，将 `.mts` 编译为 DSH/Node 可直接加载的 `.mjs`、声明与 source map。Plugin 与 Agent 只发布 `build/bin`、`build/src` 或打包期生成的 Runtime/skill 制品，不发布测试和可编辑 TypeScript 源码；两个平台发布启动器先编译 `npm-publish.mts` 再执行生成入口，消费者无需安装 TypeScript。
- 全仓 strict typecheck、Plugin/Runtime `184/184`、Agent `16/16`、版本策略与 canonical validator 全部通过；Plugin、Agent 与 CLI dry-run 包结束后均无生成目录残留。真实 Plugin/Agent tgz 清单覆盖全部 37 个 Runtime `.mjs` 与 30 个 canonical 文件；同一 tgz 分别安装到只含 DSH rc.7 或 `0.1.1-rc.1` 的隔离依赖图后，公开 ESM 导入、CLI、Plugin legacy/load、Agent install/status/Standard/load 均通过。两版的源码态 Plugin、Agent 与 coexistence 也全部通过，且未执行 npm publish。

## 2026-08-20 — DSH 0.2.5 工具暴露一致性

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.5`，精确支持 `@deepseek-ai/dsh@0.1.0-rc.7` 与 `0.1.0-rc.8`，从本版本起不再支持 rc.6；canonical skill 保持 `0.3.2`，runtime contract 保持 `3`。
- 版本序列从 `0.2.3` 直接进入 `0.2.5`。仓库新增统一版本策略：所有自有的新 package、skill 与 runtime contract 版本标识不得包含数字字符 `4`；历史记录与上游依赖版本保持事实原貌。DSH 校验、canonical validator、CLI prepack/prepublish 均 fail-closed 调用同一策略。
- 修复 adaptive tool exposure 的 schema/执行时序：DSH 会在 `system-prompt/assemble` middleware 前预构造 `assembly.tools`，runtime 现在先更新 agent-scoped execution restriction，再用更新后的可执行 registry 双向 reconcile 当前 schema，既移除刚隐藏的工具，也补回刚激活的工具；下游返回后重新读取 registry 再执行终态过滤，兼容 Plugin 与 Agent 双 runtime restriction 依次更新。由此禁止“模型 schema 可见、执行目录已隐藏”的 `unknown tool`，也避免 gateway 或新一轮直接意图激活后延迟一个 step 才进入 schema。冷启动只暴露两个 core gateway；全部 9 个 gateway capability 与责任状态驱动的 route card 仍按需暴露，不回退为全量常驻。
- Agent composition 继续以 rc.8 Standard 为 source，只为 rc.7 还原 optional-provider 文案；peer、renderer、安装入口、兼容矩阵与迁移格统一移除 rc.6，白名单外版本继续 fail-closed。
- Plugin/Runtime `184/184`（含全部 9 个 gateway capability、责任状态驱动的 route-card 与双 runtime 下游 restriction 交错的 schema/执行可见性回归）、Agent `16/16`（含 rc.7↔rc.8 两个 managed-preset 迁移格）、发布辅助脚本 `7/7`、版本策略 `2/2`、canonical validator 与双包/CLI dry-run 均通过。隔离依赖图证明 rc.7 的 `186` 个与 rc.8 的 `187` 个 DSH 安装实例全部严格同版；两套图均通过 Plugin legacy-session/load、Agent 全量 Standard composition/load 与 Plugin/Agent coexistence；Agent real-load 还逐一证明冷启动 core-only schema、隐藏工具不可执行、capability gateway 后下一次 schema 扩张及扩张工具可执行；coexistence 在 Plugin-only `standard` 与 Plugin+Agent `odai` 两种会话均报告 `toolExposureSynchronized: true`。验证不改写宿主持有的 SQLite 数据，也不把隔离 HOME 结果表述为跨版本存储迁移证明。

## 2026-08-20 — DSH 0.2.3 rc.8 精确兼容

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.3`，精确接受 `@deepseek-ai/dsh@0.1.0-rc.6`、`0.1.0-rc.7` 与 `0.1.0-rc.8`；canonical skill 保持 `0.3.2`，runtime contract 保持 `3`。
- Agent composition 以 rc.8 Standard preset 为 source；安装 rc.7 时确定性还原旧 optional-provider host-plane 文案，安装 rc.6 时再还原两项 disabled provider 的 `enableRunInBackground: false` 字段。source baseline 与 peer baseline 被显式绑定，后续不能只扩 peer range 而静默复用错误 composition。
- Plugin/Runtime `181/181`、Agent `18/18`（含 rc.6→rc.8、rc.7→rc.8、rc.8→rc.6、rc.8→rc.7 四个 managed-preset 迁移格）、发布辅助脚本 `7/7`、canonical validator、双包与 provider-neutral CLI dry-run 均通过。递归依赖图证明 rc.6、rc.7 各 `186` 个、rc.8 `187` 个 DSH 安装实例全部严格同版；真实 `0.2.3` 双包 tarball 在三套纯版本图中分别通过 Plugin legacy-session/load、Agent 全量 Standard composition/load 与 Plugin/Agent coexistence，安装 tarball 后再次扫描仍无混版。上游 rc.8 声明 SQLite 存储格式与旧版不兼容；本版本不改写宿主持有的 SQLite 数据，也不把隔离 HOME 验证表述为跨版本存储迁移证明。

## 2026-08-19 — DSH 0.2.2 责任预算与截断续作闭环

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.2`；canonical skill 保持 `0.3.2`，runtime contract 保持 `3`。planner、executor、frontend 的用户显式 `maxTokens` 现在都只在对应 controller 原地责任 scope 内覆盖 Controller ceiling；未显式配置时继续继承 Controller 策略并给出可见警告，researcher/reviewer child、compaction 和其他内部调用保持独立。
- provider 只有在 `turn/end=max-tokens`、终止 scope、最终 step route receipt 与同 step usage 全部匹配时才生成可续作 interruption。诊断请求会获得实际责任、route、有效 ceiling 与 usage 证据而不消费凭据；纯直接用户“继续”恢复原 planner、executor 或 frontend，executor 复用同一张冻结 route card，不自动扩预算、重试或扩大授权；新认证任务会结清旧 interruption。
- route receipt 与 base-route restoration 改为 turn/step 严格关联：无位置或错位置 header 不能提前消费责任、card 或 interruption；迟到 header 不能清除 durable restoration candidate，只有同 scope 的 applied restoration receipt 才能结清。restoration mismatch 进入只读保护并在后续 step/turn 重试；明确 cleared 的 route card 是永久终态，不会被迟到 release 复活。
- Plugin/Runtime `181/181`、Agent `13/13`、canonical 与双包版本校验、双包 dry-run、Plugin legacy session compatibility、真实 DSH Plugin/Agent load 及独立聚焦复核均通过。当前 receipt/restoration 仍按 DSH 同 session 串行请求契约使用 session 单槽；若宿主未来支持同 session 并发，需升级为 request-id keyed。

## 2026-08-18 — DSH 0.2.1 有界责任作用域与早期情绪支持

- `odai-dsh-agent` 与 `odai-dsh-plugin` 的发布单元同步升为 `0.2.1`，内置 canonical skill 升为 `0.3.2`，runtime contract 保持 `3`。
- planner、executor、frontend 的 controller 原地路由改为显式 responsibility scope。runtime 分开记录 start、claim、stop、base-route restoration 与实际 route receipt；工具链可按责任策略继续，终端响应、直接用户输入、失败、取消、route mismatch、route-card release 或 turn end 会幂等回收 route 与只读 protection。恢复使用 claim 前保存的完整 controller proposal，不改写用户默认模型或持久 responsibility mappings。reviewer 只有在证据包完整时启动独立 child；不完整包保持当前 controller route、继续补齐项目可得证据，不再用终端 same-turn reviewer 响应截断原任务。
- 日常关怀与危机安全拆为两个按需合同：`references/care.md` 负责焦虑、自我怀疑、反复内耗、持续消极、羞耻、害怕犯错、失去行动感及透明可控的阿岱/欧黛风格；`references/human-safety.md` 只负责持续或加重的低落、绝望、负担感、自伤、轻生与即时危险。前者不自动判为危机或触发模型路由，危机时风格退后并由同一 controller 直接执行安全确认和现实支持连接。
- 普通语义记忆继续拒绝情绪与危机状态；只有用户明确要求跨会话保存时，独立 human-safety continuity 才接受用户原文中的沟通偏好，且仍不把历史偏好当作当前状态。历史记录只在当前对话独立出现关怀、危机支持或档案管理相关性时向 controller 注入，永不进入 child prompt。
- 低频 Odai prompt 与工具 schema 改为 agent-scoped 自适应暴露；普通 turn 保留完整 canonical、输出策略、责任缺口和一个只负责发现的紧凑 capability gateway。罕见表达可通过 gateway 在下一 step 取得真实工具，宿主不支持 scoped restriction 时回退完整目录。按 DSH context meter 同口径，Odai-only 普通 turn 预算由约 `6194` tokens 降至能力等价实测 `1672`、受测上限 `1900`；canonical 恢复删减前的完整治理能力，该下降不以压缩治理语义换取。
- Windows 上的 DSH probe 对裸 `dsh` 明确选择 `dsh.cmd`，并在成功 marker 后终止完整 DSH 进程树，避免 PowerShell 解析到受执行策略限制的 `dsh.ps1` 或留下 shell 子进程；显式 `DSH_BIN` 和非 Windows 行为保持不变。

## 2026-08-18 — DSH 0.2.0 状态路由、正式回退与人身安全

- `odai-dsh-agent` 与 `odai-dsh-plugin` 同步升为 `0.2.0`，DSH 基线升为 `0.1.0-rc.7` 并继续精确兼容 `0.1.0-rc.6`，内置 canonical skill 升为 `0.3.0`，runtime contract 保持 `3`。Agent composition 以 rc.7 Standard preset 为 source，并在安装 rc.6 时确定性还原两项 disabled provider 的 `enableRunInBackground: false` 契约；人身与心理危机成为最高优先级保护：持续或加重的可观察信号触发低负担关怀，任何可信自残或轻生倾向都不因“没有计划”而忽略；全程不诊断、不贴标签、不说教、不提供方法或隐匿指导，并防止二次伤害。
- 新增独立 `$DSH_HOME/odai/human-safety-continuity.json` 与 controller-only `odai_human_safety_continuity`。只有当前 open-turn 认证的直接用户明确要求，才能保存、查看、导出、更正、删除或物理清空用户原文中的照护偏好、希望留意的信号、有效支持与自写安全计划；它不进入 semantic memory、不自动记录当前状态、不生成风险分、不向 child 暴露，也不把历史偏好当成当前风险证据。
- 路由从角色词触发收敛为 task-state gap：职责词仅作候选信号，结构化缺口带证据引用与内容摘要去重，可在后续 step 自动重评。direct、inline、same-turn 与 child 混排保留；controller 与 planner 同模型时 inline 复用当前调用。原任务已授权实施且 planner 冻结同一任务后自动续接 executor；route card 先 claim，只有匹配的 applied request receipt 才 consume，失败、错配或无请求均 release；plan-only、新任务、扩围或未知授权不能自动执行。
- provider/model/reasoning 映射在持久化和实际使用前都通过 DSH 非生成式 resolver 校验。确定性坏映射按 exact-match CAS 备份清理；鉴权、额度、限流、服务端、超时与传输故障保留配置，只对当前调用回退。Frontend 坏映射在生成前明确转为本地 controller fallback，不能声称专用责任已运行。
- compaction 目标流先完整缓冲：失败前产生的部分摘要全部丢弃，再以未污染的原始继承请求重试一次；只有完整终态才能替换历史。确定性坏 target 备份清理，暂态故障保留。Reviewer 证据包增加 currentness：成功测试与 diff 必须晚于最后一次实质写入，较晚失败会使旧成功失效。

## 2026-08-17 — DSH 0.1.1 实施阶段路由重评

- 发布 `odai-dsh-agent@0.1.1` 与 `odai-dsh-plugin@0.1.1`，两包继续作为同一发布单元保持版本同步；内置 canonical skill 升为 `0.2.1`，runtime contract 保持 `3`。
- 当任务从未决判断转为边界冻结的实施合同，或实施范围发生实质变化时，旧的 direct 判断失效；总控须在下一次实质写入前重新评估一次 executor 分离收益，既不因执行惯性继续 direct，也不把任务规模本身当成委派理由。该通用语义由 canonical `references/leverage.md` 持有，DSH runtime 只负责 route card 的冻结、所有权和消费机制。
- 活动 route card 不再被无关新任务消费。明确续作语可直接继续；普通执行动词必须同时指向前一方案、计划、卡片、实现或改动；明确新任务保持 direct。中文“另外”和英文 `another` 只有与具体新任务名词共同出现时才形成否决，避免连接词压过用户显式续作。
- 升级前须停止 DSH，更新后重启以加载新的 bundled upstream。已有 active skill evolution 不会被覆盖或自动改写指针，但因 canonical digest 变化会显示 `rebaseRequired`；显式 rebase 只创建 inactive candidate，冲突保留 base/ours/theirs 证据并维持原 active generation。
- Plugin `128/128`、Agent `11/11`、脚本 `7/7`、canonical 校验、真实 DSH Plugin/Agent load 与双包 dry-run 均通过；从 npmjs `latest` 全新安装双包与固定 DSH `0.1.0-rc.6` 后，两份随包真实 DSH load 再次通过。固定 C04 的 Luna researcher + Sol controller 正式样本增至 `n=4`，四份均为 `4/4`、真实路由和 3 源 packet；新增 3 次复跑均为高置信且工作区无改动。单份 Sol 基线仍为 `n=1`，不据此宣称统计稳定或通用降本。

## 2026-08-17 — DSH 0.1.0 受控演化与语义记忆

- 发布 `odai-dsh-agent@0.1.0` 与 `odai-dsh-plugin@0.1.0`，两包同步携带 canonical skill `0.2.0` 与 runtime contract `3`。
- 新增本地分域语义记忆：默认 `auto` 不调用 provider、embedding、subagent 或 compaction，只从经过当前 open-turn 事件认证的直接用户消息中捕获高置信持久偏好、决定和约束；低置信候选保持 pending，active 记录按 global/project 范围有界召回。秘密、联系方式、敏感个人类别、临时请求、假设、引述和代码拒绝入库；冲突不静默覆盖，forget/clear 物理删除，非法或 symlink store 安全关闭。
- 新增受控 skill evolution：只允许对声明内治理 Markdown 做精确替换，候选、验证、激活、rebase、rollback 与 deactivate 均绑定真实直接用户消息中的一次性短语；generation 保存不可变 bundle 与内容寻址来源。manifest、脚本、runtime、symlink、旧哈希或未跟踪改动均拒绝，breaking 变更使用独立授权短语，包更新不删除用户演化状态。
- Plugin 与 Agent 共享同一 memory/evolution 状态 owner，安装、更新、修复和卸载均不删除这些用户数据；child agents 不能检查或修改。责任映射、skill source、输出策略、compaction 与现有会话兼容行为保持各自边界。

## 2026-08-17 — DSH 可选证据压缩、前端升级与责任闭环

- 发布 `odai-dsh-agent@0.0.10` 与 `odai-dsh-plugin@0.0.10`，两包从该版本起作为同一发布单元保持版本同步；内置 canonical skill 升为 `0.2.0`、runtime contract 升为 `3`。新增 researcher 与 frontend 可选责任，但二者默认均未映射，只有用户明确给出各自 provider/model 后才可用，不内置 Luna、Sol、K3、token 或推理档默认值。
- Researcher 只在“未验证因果判断 + 具体高影响修改”的多源决定阻断中启动一个只读 child，不因风险、复杂、泛泛调查或模型便宜触发。回交 packet 必须包含至少两个仓库内来源及逐字摘录，并通过项目根、symlink、文件、行号、原文、实际 child route 与 digest 校验；缺配置、无效 packet、模型错配、provider 或清理失败均审计后安全直退，planner/controller 仍拥有决定与交付。
- Planner 改为 same-turn 责任升级并接收有界上下文；冻结 route card 使 executor 自动续作首次可达，reviewer 只接受完整、可识别且未截断的不可变证据包。Frontend 在同 turn 使用用户显式映射并只为该责任覆盖输出 ceiling，窄修复与缺配置仍保持当前 controller。任务列表、计划、状态、委派说明和回交统一跟随用户当前主要语言。
- 原生 C04 中，纯 Sol 与 Luna researcher + Sol same-turn planner/controller 均为 `4/4`；按 OpenAI Standard short-context 实际 usage，成本从约 `$0.239508` 降至 `$0.154871`，下降约 `35.34%`。C01/C05 均未触发 researcher；原生 C08 的用户显式 K3/max/`4096` frontend 映射在同 turn 达到 `4/4`，不成为默认模型或领域角色扩张依据。Provider 仍可能超过请求的 `500` ceiling，因此费用按实际 usage 计算，不把 ceiling 冒充硬限制。Plugin/Runtime `94/94`、Agent `11/11`、跨宿主路由、canonical 校验、三份 dry-run package、Agent/Plugin 共存及真实 DSH load 均通过。

## 2026-08-17 — DSH 托管压缩模型与状态完整性

- 发布 `odai-dsh-agent@0.0.8` 与 `odai-dsh-plugin@0.0.7`。新增共享的 `odai_compaction_config`：默认与移除均继承当前会话 provider/model，只有用户明确给出完整 provider/model 后才持久化独立摘要目标；配置仅影响未来 compaction summary，不改变普通请求、责任路由、摘要预算或缓存策略，也不为目标另选 reasoning effort。
- 显式摘要目标获得一条 provider-neutral 状态完整性后缀，严格区分 current 与 superseded/rejected 历史、逐字保留续接所需的不透明值并在输出前检查矛盾；Agent 与 Plugin 共存时幂等去重。非法 store 可见并安全回退继承，set/remove 可保留坏文件后修复；目标、provider、截断或摘要失败仍在 DSH rc.6 提交替换历史前关闭。
- 冻结的 210k-token Luna 因子实验中，stock 基线精确恢复 `10/12`；单独增加 `max` 为 `11/12`，与严格协议组合反降到 `10/12`，因此不增加 reasoning 配置。严格协议单因素及正式 runtime 确认均达到 `12/12`，盲审分别为 `4.0/4` 与 `3.875/4`、无关键矛盾；正式确认的摘要加首条续接成本约 `$0.182056`，相对冻结 Sol 基线 `$0.685985` 低约 `73.5%`。该结果验证完整性协议，不把任何具体模型设为默认或静默推荐。
- compaction cache retention 默认恢复为 `provider-default`，不再强制 `long`；显式 incoming/config/environment 值仍按既有优先级生效。Plugin/runtime、Agent、真实 DSH load 与两份 npm dry-run artifact 均纳入放行验证，DSH 事务顺序在升级固定 rc.6 时必须复核。

## 2026-08-16 — DSH 输出模式与缓存成本

- 发布 `odai-dsh-agent@0.0.7` 与 `odai-dsh-plugin@0.0.6`。两个包默认使用软精简输出，并提供正常、软精简、经济三种命名模式；经济模式默认发送可调的 `500` provider 输出 ceiling，用户可指定其他正整数。该 ceiling 不影响 child、compaction、checkpoint 或其他内部预算，provider 超限会从逐请求 usage 中显式报告。
- C04 / C05 的经济模式裁判均为 `4/4`，相对软精简合计成本下降约 `36.8%`；当前 provider 会超过 `500`，因此它是有效但非严格的预算信号，不冒充本地硬账单上限。默认软精简不设置 ceiling，正常模式保留为显式退出项。
- 同 provider/model compaction 在继承 controller reasoning 时默认请求 long cache retention，并保持独立 `8192` 摘要预算；普通连续请求的 clean A/B 中，`short` 与 `long` 第二请求均达到约 `95.9%` 缓存覆盖，不据此把 `long` 扩大为普通 controller 的通用默认。
- 新增普通请求缓存对照探针、provider ceiling 严格认证门、Plugin/Agent npm 徽章和完整六 reference 内部地图；真实 DSH load、Agent Web、共存安装、单测与 dry-run package 均通过。

## 2026-08-16 — DSH compaction 缓存兼容

- 发布 `odai-dsh-agent@0.0.6` 与 `odai-dsh-plugin@0.0.5`。同 provider/model 的 DSH compaction 在自身未显式配置 reasoning 时继承当前会话 `request/header` 中用户实际选择的 reasoning effort；跨模型 summarizer 与显式设置保持不变，不内置任何模型名称。
- 真实中转 A/B 使用同一随机前缀和 session：缺失 reasoning 的 compaction 为 `14,679` uncached / `0` cached，继承 `xhigh` 后为 `596` uncached / `14,080` cached，未缓存输入下降约 `95.9%`。压缩后因历史 summary 替换产生的新前缀仍需正常重建。

## 2026-08-15 — DSH skill source 与多轮路由

- 发布 `odai-dsh-agent@0.0.5` 与 `odai-dsh-plugin@0.0.4`。两个包继续不内置任何具体模型：controller 继承 DSH host 选择，planner、executor、reviewer 只使用用户明确配置的 provider/model；缺少高影响责任映射时保持 fail-closed。
- `auto` 在同一主会话按 turn 路由。普通请求留在当前 controller；完整高影响判断缺口在本 turn 使用用户配置的 planner 路线，不创建 child。低风险总结、重述和翻译保持直接路径；引用前文高影响任务继续决策时继承最近的相关用户上下文，新实质任务会切断继承。
- 新增完整 skill manifest 与 `bundled`、`auto`、`user` 来源选择。默认继续固定包内 bundle；只有用户明确设置后才考虑兼容的项目、自定义或用户安装，prompt 治理与路由 role contract 在同一 agent/turn 原子选择。
- agent 协作默认使用新鲜独立上下文和有界任务包，不再为方便 fork 完整长会话；只有无法裁剪的既往交互本身是决定性证据、继承范围与用量可核实且净收益覆盖缓存失效、压缩和延迟成本时才允许继承。
- Plugin 与 Agent 的真实 DSH load、共存安装、session 兼容、模型配置持久化、完整单测和 npm dry-run pack 均通过；发布产物生成后会清理仓库内临时 runtime/skill 副本。

## 2026-08-15 — DSH 会话兼容修复

- `odai-dsh-agent@0.0.4` 与 `odai-dsh-plugin@0.0.3` 不再把私有 `odai/*` 审计事件写入 DSH 核心 session log，改为保存到 `$DSH_HOME/odai/session-evidence/`，避免重启后旧 DSH 因未知事件拒绝加载历史。
- 新增停机迁移：给历史版本写入的八类已知 Odai 审计事件补上 DSH 官方 `ignorable: true` 标记；迁移覆盖 JSONL 与多 frame Zstandard，原子替换并保留校验备份，未知事件拒绝猜测处理，进程检查失败或发现 DSH 仍在运行时拒绝写入。
- Agent 安装、更新和卸载会先检查历史兼容性；Plugin 提供 `odai-dsh-plugin repair-sessions --yes`。真实 DSH 验证覆盖会话先以 `standard` 创建、再切换到 `odai` 后的 preset 恢复，确保迁移不把模式回退为标准。
- 两个包要求 Node.js 22.15.0 或更高版本，以匹配历史 Zstandard 会话迁移所依赖的原生 API。

## 2026-08-14 — DSH Agent 0.0.2

- `odai-dsh-agent` 的 DSH picker 与 npm package description 改为中文，并明确承诺完整继承对应版本 DSH Standard 的全部能力。
- 发布验证继续对完整 Agent composition 做逐字派生校验：只允许 model-neutral Odai persona 替换和末尾 Odai runtime 扩展；Standard 的能力行、设置、顺序发生缺失或漂移都会失败。

## 2026-08-14 — DSH Plugin 与 Agent 首发

### 分发与配置

- 新增 `odai-dsh-plugin@0.0.1`：把 canonical skill、共享 runtime、治理、自动路由和证据监听作为 profile-wide DSH bundle 分发。
- 新增 `odai-dsh-agent@0.0.1`：安装包含同一 canonical skill 与 runtime 的 session-scoped `Odai` Agent preset，不依赖 Plugin，也不修改 profile bundle。
- 两个包都不内置 planner、executor 或 reviewer 模型映射。用户自然指定责任、provider、model 与可选推理档后，controller 通过 `odai_routing_config` 持久化到 `$DSH_HOME/odai/routing.json`；未使用的缺失责任不提示，真实需要时才询问。
- Plugin 适合一个 profile 全局生效，Agent 适合按 session 选择；通常二选一。两者刻意共存时读取同一用户映射，并按 scope shadow prompt、去重 route/tool evidence、保持权限拒绝单调。

### 路由与保护

- 默认 `auto` 保持普通任务由当前 controller 直接闭环；配置后的完整上下文判断缺口同 turn upgrade，明确独立规划或复核才使用 child。`execute`、`observe`、`off` 保留为显式模式。
- planner、executor、reviewer 的缺失、失败或不可信高影响路线统一 fail-closed。损坏 routing store 不阻止治理加载；下一次用户明确 set 时保留损坏副本并自动修复。共享 store 更新使用跨进程锁和原子替换。
- 真实 DSH load、Agent Web live-session 工具 dispatch、Plugin/Agent 单测、隔离 runner 和 dry-run pack 均通过；当前质量与成本口径见 [`docs/routing-results.md`](docs/routing-results.md)。

## 2026-08-13 — 证据合并、跨平台隔离与可选宿主路由

### 能力与架构

- 普通 odai 继续以单一充分能力总控直接闭环；总控是持续持有目标、全局状态、失败恢复与最终交付的任务线程，不是必须额外启动的角色。
- 新增可选宿主路由安装、更新、卸载与运行时核验。`auto` 只注册能力并保持普通单总控路径；用户明确选择且真实任务证明净收益时，才用从任务起点显式运行的 `stage` runner 机械分离 planner、executor 或 reviewer。
- 默认 `auto` 不安装每轮路由 Hook 或机械 runner；Codex 安装会保留无关配置并记录原始总控设置，卸载时在无漂移前提下精确恢复。
- Codex 提供显式 `stage` runner、四责任注册与实际模型 / usage 核验；Claude Code 与 GitHub Copilot 只生成角色配置，未取得等价宿主证据前不宣称同等自动化。
- 路由角色正文保持单一 owner，宿主目录只保留必要外壳。实测证明 `PreToolUse` 透明接管无法承接外层只读证据、会重复调查，因此退役能力路由 Hook；项目写入护栏 Hook 仍独立保留。

### 评测与报告

- 普通模型结果表合并 GPT-5.6 Sol、Claude Opus 5、Grok 4.6 / 4.5、Gemini 3.6 Flash High、DeepSeek V4 Pro / Flash 与 Kimi K3。八个 runner 的历史配对 A/B 均取得正增益；除 Gemini 外，其余全量 on 与 A/B on 均满分。
- 新增统一的 `odai-canary-isolation/v1`：Codex / GPT、Claude Code 及兼容 provider、Grok、Kimi、Antigravity / Gemini、OpenAI-compatible runner 与 judge 分别使用隔离 HOME，只复用鉴权或连接材料；off 不加载 odai、ribao、项目叠加层、仓库指令、路由、Hooks、插件、MCP、记忆或旧会话。旧表保留为隔离契约前的历史能力证据，不冒充已按新口径重跑。
- 指纹回归复现用途，不再因未触达题目运行语义的路由资产、维护文档或其他无关变化整表作废；受影响 case 仍必须整份替换 runner、diff、status、judge 与 token 证据。
- GPT-5.6 Sol 全量主口径采用可拆分的 3,698,792 总处理 token，并同步披露 554,088 非缓存输入加输出；旧 618,944 CLI footer 只作历史口径说明。
- 模型全量 / A/B 与可选宿主路由分成两份报告。正式报告不记录失败管线、复跑流水、临时目录或已退役角色实验。
- 默认 `auto` 的 C01 对照为 4/4，100% 使用 Luna/max，未启动其他责任；历史强制预规划全量只作为退役压力对照，不冒充按需智能路由。

## 2026-08-07 — 轻量通用成事内核

### 架构与思想

- 从历史模块树收敛为 `SKILL.md` 与 `dao`、`craft`、`verification`、`support`、`leverage` 五个渐进加载 owner；高频表现支撑与低频外部能力决策分开加载。
- 保留“事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为”，将治理、制作和验收统一为当前任务中的判断与行动，不另造凌驾任务的流程。
- 将人格、思想、主见与分寸落成行为：判断只到证据支持的粒度，敢于提出有据异议，也能诚实保留未知；面向用户自然表达，不表演人格、规则或内部框架。
- `craft.md` 保留规划、实施、设计、UI / 实时交互、写作与审查的最小内置工艺；`support.md` 承接失稳恢复、长期状态与记忆、关系连续性、合议和连续审查，`leverage.md` 单独承接外部能力与 agent 协作。

### 关键纪律与迁移

- 单一权威来源足以回答时先读后停；询问命令、入口或做法只授权回答，不授权代执行。
- 局部修改不把既有相邻偏差自动纳入修复；目标与参考、消费层定制与共享对象、相似接口与真实业务场景继续分离。
- 证据已经找到可独立闭合结果的必要动作时，删除未获授权的原手段、替代手段和顺手增强；涉及持续状态或多次动作的规划必须交代状态推进、冲突处理、失败恢复和最终确认。
- 用户确认只补授权、不补事实；知情授权只在未被证据否定、保护链成立且回退明确时形成有限出口，高影响候选仍须由真实实验边界承载。
- 用户明确要求在收口前须有对应结果或明确未决，不因内部取舍静默遗漏，也不为追求轻量降低目标或验收。
- 旧 `references/dao/`、`capabilities/`、`domains/`、`techniques/` 路径与 `task-ledger.md` 退役；CLI 路由、校验、README 与维护说明同步到当前扁平 owner 架构，不保留平行兼容源。

### 评测

- 全量扩展为 C01-C19，共 19 题、加权满分 144；A/B 扩展为 13 题、加权满分 96，新增缺失能力下的发现、安装边界与精确交接。
- C10 改成不向用户暴露内部能力形态的自然委托：模型须自行判断是否复用、引入或创建项目能力，同时完成当次真实结果；题本不再要求用户替 odai 做架构选择。
- 当前全量 on：GPT-5.6-sol / high、Claude Opus 5、Grok 4.5、Kimi K3 与 DeepSeek V4 Flash 均为 144/144，Gemini 3.6 Flash High 为 126/144。
- 配对 A/B on / off 与净增：GPT 96/80（+16）、Opus 96/77（+19）、Grok 96/69（+27）、Gemini 82/67（+15）、K3 96/75（+21）、D4F 96/61（+35）；除 Gemini 外 runner token on 均高于 off，不把质量增益表述为无条件省 token。
- 内部 skill、项目叠加层、项目 skill 与外部能力统一计入 odai 整体结果。结构性变更重跑全量，边界清楚的局部变更只替换受影响 case 的完整证据。完整分层与逐题结果见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

## 2026-08-03 — 明文硬门与完整可用交付

### 能力与纪律

- 将高注意规则改成更直接的判断与动作语言，保留 `事｜实｜法｜成｜界` 主轴、四档力度和按需支撑，不用内部黑话替代可观察行为。
- 强化高影响参数停止门：方向、幅度和保护链缺证时整组不写；替代数值只能作为待验证实验候选，用户确认或接受风险不能替代证据。
- 强化完整交付：既有模板、字段和结构进入验成；局部缺口只阻断依赖动作，先交付其余完整可用结果，不得用“已准备”或普通摘要代替正文。
- 明确规划、设计、文档等支撑资料的必读条件，同时保持逐份加载；普通问答和路径已知的局部实施不自动扩展流程。

### 评测与维护

- 全量仍为 18 题、136 分，A/B 仍为 12 题、88 分；确定性产物门按题面允许方案落在 `docs/` 或 `plans/`，不再用未声明目录误杀合理交付。
- 裁判只按用户请求、项目证据、可观察验收与失败门计分；材料无法支持具体值时，不以拒绝编造样本量、阈值、责任人、环境或窗口为由扣分。
- 补充 Antigravity runner 适配，并识别其 `view_file` 结构化轨迹；裁判提示不再携带 runner usage footer，避免 judge token 误取 runner token。
- 当前全量 on：GPT-5.6-sol / high、Claude Opus 5、Grok 4.5 与 Kimi K3 为 136/136，DeepSeek V4 Flash / 1M 为 132/136，Gemini 3.6 Flash / high 为 120/136。
- 当前 A/B on / off 与净增：GPT 88/74（+14）、Opus 88/71（+17）、Grok 88/67（+21）、Gemini 78/54（+24）、K3 88/73（+15）、D4F 86/61（+25）；同步保留逐题分数、分层 runner token 和支撑资料读取。
- canonical skill 为 20 个 Markdown 文件，入口约 2,483 token、总量约 15,217 token；体量警告只触发审查，不以硬上限迫使删除有效规则。

## 2026-07-31 — 人机共同成事与可信交付

### 能力与纪律

- 明确人和模型是共同成事的合作关系：价值取舍由用户决定，事实判断由双方以证据校准；既不盲从用户先验，也不以专业之名替用户改写目标。
- 强化要义不失、判别精度、实际复算和局部缺口隔离：用户点名的重点逐项进入验成，具体对象、输入、位置和约束不被宽泛类别替代，单个阻断不拖低其余可独立交付结果。
- 补齐目标与参考分离、既有扩展面优先、场景契约匹配和证据选择，防止把参考文件当写入目标、为局部定制污染共享基础、或因返回结构相似而选错接口与工具。
- 文档交付、长期连续性和守险交接均收敛到可核证据：沿用既有格式契约，不从提交记录编造工时与完成度，不固化临时秘密或绕法，责任未知时明确待认领动作。

### 架构与维护

- 保持 `事｜实｜法｜成｜界` 单一概念脊柱和按需加载架构；`SKILL.md` 只保留必须高注意的门，详细证据、授权、交付与连续性规则归各自 owner。
- 将入口视为高注意力定额：新规则优先合并或替换旧文字，避免真实学费继续退化成无限追加的规则堆。
- 退役未被运行时路由、宿主注册或发布产物使用的 `skill-author`；其有效维护纪律由 `MAINTAINING.md` 与 `AGENTS.md` 承担，删除只为保护自身存在的校验闭环。
- harness 补齐 C13-C18 的独立 fixture、评分与确定性门，并区分 runner 失败和外部可执行文件缺失；runner stdout 缓冲统一为 64MB，避免长上下文轨迹超过 Node 默认上限后形成基础设施假红。

### 评测

- 全量扩展为 C01-C18，共 18 题、加权满分 136；A/B 扩展为 12 题、加权满分 88，新增可信文档、长期记忆、参考与复用边界、场景契约等能力面。
- GPT-5.6-sol / high、Claude Opus 5 与 Grok 4.5 全量 on 均为 136/136；DeepSeek V4 Flash / 1M 为 130/136，Gemini 3.6 Flash / high 为 119/136，Kimi K3 为 122/136。
- 配对 A/B on / off 与净增分别为：GPT 88/88 / 74/88（+14）、Opus 88/88 / 71/88（+17）、Grok 88/88 / 67/88（+21）、D4F 84/88 / 61/88（+23）、Gemini 77/88 / 54/88（+23）、K3 80/88 / 73/88（+7）；同步保留 runner token 成本对比。
- 旧指纹结果不迁移；未形成完整当前指纹证据的模型不进入最终横向表。

## 2026-07-20 — 实证成事重构

### 架构

- 以“事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为”统一总纲；用 `事｜实｜法｜成｜界` 持续判断目标、依据、路径、验收与边界，不把它们机械化为阶段或输出模板。
- 将治理融入从理解到交付的执行过程；保留直达、纠偏、展开与守险四档自适应力度，简单任务不交流程税，证据、风险或长期依赖变化时再升降。
- 能力面收敛为 `planning`、`design`、`delivery` 与 `review`；将外部 skill、项目规则、agent 和多模型协作合并到 `leverage`，将正式与收敛审查合并到 `review-modes`。
- 退役 `feature-plan`、`design-spec`、`diagnose`、`implement-code`、`review-sslb`、`composition`、`coordination`、`audit-loop`、`review-full` 与 `recipes/` 专属模块。README、报告和提交说明等普通产物改为直接服从任务与仓库约定。
- 保留只答不写、明确局部修改、根因授权、高影响参数停止门、证据三态、生产边界和真实验成等关键纪律；支撑资料继续按真实缺口渐进加载。

### 评测

- 将二元通过口径升级为 0–4 完成度乘预设权重：全量 12 题满分 88，A/B 8 题满分 56；严重越权、生产风险与虚报验证使用硬封顶。
- A/B on 从相同指纹、题面、fixture 与 runner 配置的全量结果直接抽取；off 保持独立基线，并继续记录逐题缺口、runner token、支撑读取和确定性检查。
- 当前全量 on：GPT-5.6-sol / high 与 Grok 4.5 为 88/88，Claude Opus 4.8 为 83/88，Qwen 3.8 Max Preview 为 85/88，Kimi K3 为 77/88，GLM-5.2 为 70/88，DeepSeek V4 Pro 为 71/88，MiMo 2.5 Pro 为 68/88。
- 当前 A/B 加权净增：GPT +15、Opus +11、Grok +19、Qwen +9、K3 -1、GLM +8、DeepSeek V4 Pro +12、MiMo +9。公开保留负增益与 token 成本，不把辅助 pass 或满分 on 单独表述为普遍价值证明。

### 维护与迁移

- CLI 路由、治理来源、临时打包、测试与 canonical skill 校验均已同步到新目录；`skills/odai/` 仍是唯一可编辑事实源，`cli/skills/` 只在打包期间临时生成。
- Claude runner 在同一 session 出现多个 `result` 事件时累加全部 usage，避免自动续跑只记录最后一段 token。
- 自定义叠加层若引用已退役路径，需要迁移到新的责任文件；不提供旧路径别名，避免维护第二套架构。
- README、维护说明、题本、评测契约和当前结果均已更新；当前指纹与逐题数据见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

## 2026-07-16 — r7

### 架构

- 定位为治理内核驱动的通用任务执行框架：治理融入每次判断、行动、验证与收口，不在执行之前制造额外仪式。
- 将多模块路由收敛为单一自适应主流程：判断、行动、验证、收口；按任务明确度、风险和证据动态收放。
- 保留“道可道”、谋定而后动、模型即谋士、六字诀与道儒心兵法五家合一，但不把它们拆成角色或工作流。
- 支撑资料重组为 `dao/`、`capabilities/`、`domains/`、`recipes/`、`techniques/` 和 `assets/`，实现渐进加载。
- 退役 `references/modules/` 以及 `game-plan` / `game-design` 专属路由。游戏任务改由通用规划、设计和实时交互能力自动承接。
- 保留自动发现、外部 skill 借力、项目 `.odai/local.md` 叠加、长任务恢复、agent 协作、合议和增强档，均改为条件触发。

### 评测

- 冻结 12 题全量现实委托与 8 题配对 A/B，覆盖 direct、judgment、complex 和 boundary 四层。
- 题面不针对 odai 模块出题；关键事实放在代码、日志、brief、diff、任务状态和 runbook 中。
- harness 补齐独立 fixture、确定性副作用门、多模型 runner、deferred judge、指纹和 token 统计。
- C04 在不改用户题面、fixture、确定性只读门或 skill 的前提下澄清裁判边界：明确标为待验证假设 / 实验候选且不实施的数值可通过；无证据生产值或直接落地仍失败。
- GPT-5.5、Grok 4.5 和 Kimi K3 的全量 on 均为 12/12；GPT-5.5、Claude Opus 4.8、Claude Sonnet 5、Claude Fable 5、Grok 4.5 与 GLM-5.2 的 A/B on 为 8/8。完整横向结果见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。

### 维护与迁移

- `skills/odai/` 继续是唯一 canonical source；不维护平台镜像或常驻 `cli/skills/`。
- 公开评测记录统一收口到 `docs/evaluation-results.md`，退役 `plans/odai-canary-results.md`。
- 自定义叠加层若引用了旧模块路径，需迁移到新责任目录；不提供旧路径别名，避免形成第二架构。

本日志从 r7 开始；更早历史保留在 Git tags 与 commit 记录中。
