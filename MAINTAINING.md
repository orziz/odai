# 维护说明（Maintaining odai）

> 本文面向仓库维护者。普通使用请看 [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md)。

## 当前状态

- 当前未发布候选为 DSH `0.2.36` / 治理 `0.7.0`（runtime contract `9`）/ 编排 `0.2.0`，仅面向 DSH `0.1.5-rc.2`。双包 `0.2.35` 已发布，不能复用其版本号。
- 当前定向评估及限制统一在 [`docs/evaluation-results.md`](docs/evaluation-results.md)，实际职责调用和宿主保护边界统一在 [`docs/routing-results.md`](docs/routing-results.md)。不复制旧版本分数作为当前结论，也不把有限样本当作全量验收。
- 结果文档保持当前状态，用户要求重试时以最新完整结果更新对应项，简要说明重试；淘汰的试跑、重复快照与已结束执行计划及时清理。已发布版本事实保留在 CHANGELOG 与兼容表，旧实现和旧文档由 Git 历史承担。
- 仓库的 skill / 评测冻结标签与 `cli/package.json` 的 npm 版本彼此独立。

## 单一事实源

```text
AGENTS.md                         仓库级维护约束
skills/odai/                      独立治理技能
  SKILL.md                        精神内核、当前判断、行动门、主线、加载地图与完成
  manifest.json                  治理版本、reference owner 和文件清单
  agents/openai.yaml              宿主 UI 元数据
  references/                    边界、计划、制作、验收、状态与记忆、能力选择、关怀与人身保护
  assets/task-state.md            可选跨轮状态
skills/odai-orchestration/        可选、单向依赖治理的编排技能
  SKILL.md                        编排入口
  manifest.json                  编排版本、治理契约、角色和引用依赖
  contracts/delegation.md         共用受托边界
  references/orchestration.md    职责选择、交接与降级
  references/install.md          通用宿主路由的安装、更新与卸载
  assets/                         职责预设和宿主模板
  scripts/                        可信组合器、路由生成、安装与调用核验
integrations/hooks/              可选 Hooks 运行时、生成器和策略示例
docs/rule-ledger.md               有来源的操作规则、owner 与保持状态
docs/evaluation.md                稳定评测契约
docs/evaluation-results.md        模型全量 / A/B 的公开记录
docs/routing-results.md           可选宿主能力路由的独立实验记录
plans/odai-canary.md              C01-C34 唯一活动题本与 suite 目录
plans/odai-blind*                 可复用匿名横评定义
scripts/                          校验、runner、judge、harness 与统一 artifact bundler
dsh/runtime/                      唯一可编辑的 DSH runtime source
dsh/plugin/                       profile-wide bundle，与 Agent 同版同步发布
dsh/agent/                        session-scoped Agent preset，与 Plugin 同版同步发布
dsh/client/src/                   双包共用的 Control Center 客户端源
cli/                              当前冻结的 provider-neutral runtime（不改、不测、不打包、不发布）
CHANGELOG.md                      当前唯一 Unreleased 候选与冻结版变更日志
```

`skills/odai/` 是 odai 唯一可编辑治理源，`dsh/runtime/src/` 是唯一可编辑 DSH runtime source。`cli/skills/odai/`、`dsh/plugin/{runtime,skills,client}`、`dsh/agent/preset/odai/{runtime,skills}` 与 `dsh/agent/client` 只能由 npm lifecycle 临时生成，`postpack` 后必须清理；它们不提交、不手改、不是第二份 source。统一生成 owner 是 `scripts/package-odai-artifact.mjs`。仓库也不维护 `.claude/`、`.github/`、`.grok/` 等平台镜像产物；可选 Hooks 由 canonical runtime 按需生成到仓库外，skill 分发统一走 [skills.sh](https://skills.sh)。

## 当前架构口径

odai 之道是：**事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。** 它不强制阶段，而是按当前表现分配自主权、制作方法、验证与机械支撑。八份 reference 是渐进加载的唯一 owner，不是互相调度的子工作流。

| 需求 | 唯一 owner |
|---|---|
| 精神内核、当前判断、行动门、主线与加载地图 | `skills/odai/SKILL.md` |
| 事的所有权、事实校准、授权、参考只读、冲突与高影响动作 | `references/dao.md` |
| 正式计划、可执行合同与跨轮续作 | `references/planning.md` |
| 已决定结果的实施与排障、设计、UI / 实时交互、文档与审查 | `references/craft.md` |
| 验收、证据强度与完成判断 | `references/verification.md` |
| 长期信息、项目叠加层与项目规则和技能的固化 | `references/memory.md` |
| 工具、资料与技能选择 | `skills/odai/references/leverage.md` |
| 职责选择、调度和交接 | `skills/odai-orchestration/references/orchestration.md` |
| 通用宿主路由的安装、更新与卸载 | `skills/odai-orchestration/references/install.md` |
| 有来源的操作规则登记与保持状态 | `docs/rule-ledger.md` |
| 非危机日常关怀 | `references/care.md` |
| 自伤、轻生与即时危险保护 | `references/human-safety.md` |
| 跨会话可恢复状态 | `skills/odai/assets/task-state.md` |
| 可选项目护栏 Hooks | `integrations/hooks/scripts/odai-hook.mjs` 是写入边界与显式验收的共享运行时；同目录 `build-hooks.mjs` 只生成薄适配，策略示例在 `integrations/hooks/assets/`，不承载第二套判断规则 |
| 可选宿主能力角色 | `skills/odai-orchestration/assets/routing-roles/` 是 controller、planner、reviewer 及可选 researcher/frontend 合同的唯一 owner；controller 始终负责实施整合、验证与最终交付，有界制作可依宿主权限委派。编排技能内的 `assets/{codex,claude,copilot}-agents/` 只保留宿主外壳；`scripts/build-routing.mjs` 生成显式注册；`scripts/install-routing.mjs` 安全安装、更新、卸载并清理旧 Executor/stage 文件；`scripts/run-role.mjs` 执行并记录实际 thread、模型与 usage；`scripts/verify-routing.mjs` 只读核验 Codex 原生角色 |
| DSH 机械治理与自动路由 | `dsh/runtime/src/` 是唯一实现 owner，职责合同通过可信组合器消费 `skills/odai-orchestration/`；DSH 只组合实际使用的 researcher/planner/reviewer/frontend 合同，总控直接加载治理入口。`dsh/plugin/` 提供 profile-wide bundle 外壳，`dsh/agent/` 提供 self-contained preset 与安全安装器，两者可独立安装，但作为同版发布单元同步发包 |

`skills/odai/manifest.json` 的 `referenceFiles` 声明治理 owner；`skills/odai-orchestration/manifest.json` 的 `roleFiles`、`rolePresets` 与 `referenceFiles` 声明角色及编排依赖；各自的 `requiredFiles` 是完整性清单。文件路径由 manifest 提供，不维护平行路径表。reference 名称及合同约束还由 `skills/odai-orchestration/scripts/compose-contracts.mjs` 与 `dsh/runtime/src/governance-bundle.mts` 显式校验；新增 reference 须同步这些声明，并按读取契约变更升级 skill / runtime contract。DSH 总控默认只常驻 kernel；controller 通过只读 `odai_reference` 从当前 turn 已选 bundle 按需取得 reference，责任 scope 和 child 不暴露该入口。runtime 将同一快照的 planning、verification、craft 正文分别随 planner、reviewer、frontend 合同传入，不让职责依赖不可用的工具或碰巧可见的路径。DSH 子代理只读产出待应用补丁，总控核对、应用与验证；现有专门职责和高影响执行门保持。

reference 只写入口之外的增量，不复述 `SKILL.md`；改写、压缩或重组治理正文时，逐条核对 [`docs/rule-ledger.md`](docs/rule-ledger.md) 的规则仍在所列 owner 中成立。新能力先判断能否由现有 owner 承接；只有存在独立加载价值且合并会显著增加无关上下文时才新增 reference。领域名称、历史文件名和一次失败本身都不构成新增模块的理由。

通用 planner/reviewer 合同不规定无人消费的模式首行或路由卡片；完整目标、用户原文、验收、停止与回交责任仍须保持。DSH 的实际工具协议、packet schema、scope 与模型回执属于 runtime。原生子代理与职责路由不前后叠加；同一缺口选一条满足上下文、权限和用户模型要求的路径，已有有效贡献按覆盖复用。

## 修改纪律

1. 先锁定唯一 owner，再改文字。同一判据不在多文件并行完整展开。
2. 新规则必须来自可复发的真实需求或失败证据；优先合并、替换或降级旧规则，不用同义句堆适配。
3. `SKILL.md` 只保留内核、必须高注意的门和资源导航；细节放到按需 reference。
4. 修改 `SKILL.md` 的触发语义、产品定位或宿主展示文案时，同步检查 `agents/openai.yaml`。
5. 不为缩 token 而删能力，也不为完整感增文件；只看净价值、可发现性和行为证据。
6. 已冻结结果发现实质问题时，先修真实问题，不回改题本迎合输出。模型评测按会改变实现或取舍的具体问题启动，选择最少案例；不因结构调整、压缩或发布自动要求全量、A/B、弱模型或多模型裁判。没有待裁决问题就不跑，失败或超时不自动追加任务。需要更新已采用结果时保留完整证据，不拼接输出或挑最好样本。
7. `SKILL.md` 是高注意力定额，不是可持续追加区；新规则进入入口时应优先合并或替换旧文字，只有行为证据证明净增量时才扩容。
8. 只有具备独立用户触发面、可单独分发且不能由现有 owner 承接的能力才新增公开 skill；仓库维护说明归本文与 `AGENTS.md`，不另造无人调用的维护 skill。
9. 只有重复使用且需要确定性执行的逻辑才新增 script；只有会被 agent 直接复用于交付的内容才新增 asset。新增前先确认现有 owner、真实复用证据与验证方式。
10. 工具、资料与技能选择归 `skills/odai/references/leverage.md`，职责选择与交接归 `skills/odai-orchestration/references/orchestration.md`，角色独有义务归编排技能的 `assets/routing-roles/`；通过既有组合器供宿主消费，不维护平行正文。只有影响加载、调度、生成或安装行为时才检查相应执行路径；单纯文案整理不要求重跑全部宿主或真实会话，生成成功也不冒充实际调用成功。

## 验证与评测

修改 skill 文件后运行基本完整性检查：

```bash
node scripts/validate-odai-skill.mjs
git diff --check
```

该检查只处理元数据、声明文件、资源引用与合同能否加载，不判断规则含义、写作质量或模型效果。Markdown 的语句、关键词、词序和篇幅不作为单元测试或 CI 门槛；规则变更由实际需求和全文审阅判断，不为局部措辞增加校验。DSH 调度、权限、安装、快照与生成器的可执行行为继续使用对应测试，按改动影响选择，不因改写文案重跑无关全量。

DSH source 使用根目录 `npm run check:dsh`：构建时严格检查生产 TypeScript，再用 Node 校验经过渲染的浏览器脚本。普通行为测试、辅助代码和宿主探针使用 `.mjs`，导入构建产物，以 `node --test` 或 `node` 执行；没有测试专属 tsconfig 或 `tsx` 加载器。测试前先构建一次，此后只运行受影响的文件。若将来需要验证编译期公共类型契约，再为该具体合同增加独立类型测试，不给普通 fixture 补类型框架。两个包的 `check` 均委托根入口。

改可选 Hooks runtime、策略示例或适配生成器时补充：

```bash
node scripts/test-odai-hooks.mjs
```

改可选能力路由配置或生成器时补充：

```bash
node scripts/test-odai-routing.mjs
```

Codex 自定义角色必须由 `config.toml` 的 `[agents.<name>]` 与 `config_file` 显式注册；仅复制角色 TOML 不算可用。用户只在安装或更新时确认一次模型映射，正常任务不得要求用户指定角色、内部策略或运行命令。安装器默认 `auto`，注册 controller、planner、reviewer 以及显式提供的 researcher/frontend，不制造每轮前置流程。单一充分 controller 直接闭环，其他责任按真实缺口调用。内部角色必须设置 `ODAI_ROUTING_ACTIVE=1` 防止递归。

controller 是唯一持续任务线程、实施 owner 与最终交付 owner，不是额外模型调用。planner 只在独立判断能改变路线时使用，回交后由 controller 恢复实施；reviewer 只在独立判断能改变放行结果时使用；researcher/frontend 同样须有具体缺口与收益依据。小任务直接闭环，高风险只提高证据、授权和验收强度，不自动制造角色。调用前判断预期贡献，调用后分别核对执行、独立性、指定能力与实际代价；缺少用量不宣称节省，也不抹掉已有交付证据。具体判据由 `skills/odai-orchestration/references/orchestration.md` 统一维护，DSH 的机械放行仍服从 runtime 自身合同。

安装器会在不覆盖无关设置的前提下合并既有 Codex 配置，并把原始配置摘要与内容记入托管清单；更新与卸载先核对当前托管哈希，卸载再精确恢复原配置。非合并位置只处理空目标或自身完整托管且未被外部修改的配置。新版更新会根据旧清单安全移除已退役的 Hook、Executor 与 stage runner 托管文件，不删除未由 odai 托管的项目配置。Codex、Claude Code 与 Copilot 都只生成当前角色配置；未取得等价宿主证据时不得宣称真实路由已核实。修改路由契约时按受影响的连接选择角色、生成器、安装器或宿主检查；只有真实调用行为的变化无法由现有证据判断时才运行对应宿主会话，不固定重跑三个宿主。

项目护栏 Hooks 只机械执行 `.odai/hooks.json` 已声明的只读路径和验收命令，不从自然语言推断写域或验收，也不替代宿主权限、沙箱与人工确认。它是 odai 唯一的每轮 Hook 机制，由 `test-odai-hooks.mjs` 覆盖六宿主薄适配。能力路由由 `test-odai-routing.mjs` 覆盖生成、安装、更新、卸载与旧文件清理，不注入对话 Hook。新增宿主适配必须先核实其真实事件和阻断语义，不做“配置长得像就算支持”的伪兼容。

改 harness 或 runner 时补充：

```bash
node --check scripts/odai-canary-harness.mjs
node --check scripts/canary-isolation.mjs
node --check scripts/antigravity-canary-runner.mjs
node --check scripts/claude-canary-runner.mjs
node --check scripts/grok-canary-runner.mjs
node --check scripts/kimi-canary-runner.mjs
node --check scripts/openai-compatible-canary-runner.mjs
```

正式评测的 runner 与 judge 必须通过 `odai-canary-isolation/v1`：每个会话使用 harness 临时 HOME，只复用平台鉴权或连接材料，不继承用户或父仓库的 skill、Hooks、memory、插件、MCP、AGENTS / CLAUDE 指令、旧会话和另一臂产物。`on` 只复制冻结的能力包及该题声明的项目材料；`off` 不复制 odai、ribao、`.odai/local.md` 或托管路由。官方 adapter 必须输出隔离回执；未知 `--runner-cmd` / `--judge-cmd` 没有实现同一契约时直接记基础设施无效，不能进入正式结果。新增平台时先实现并测试隔离，再接入评测。
该契约统一覆盖 Codex / GPT、Claude Code 及其兼容 provider、Grok、Kimi、Antigravity / Gemini 与 OpenAI-compatible runner，不因模型或平台不同退回用户环境；重判来源也必须逐题保存已验证的 runner 隔离证据，不能给旧输出补写一个新 manifest 冒充新口径。
正式 `--run` 的 `--out` 必须在仓库树之外；harness 会拒绝仓库内 `.tmp/` 等路径，防止 Grok、Kimi 或其他会向父目录发现项目指令的宿主重新加载本仓库的 AGENTS、skills、Hooks 与插件。

Codex 路由 telemetry 必须区分宿主契约、任务是否命中触发条件与实际 spawn / 降级行为。零 spawn 不是失败判据：宿主未暴露、宿主限制、任务未命中、正确降级和漏派必须分别取证；缺任一层时保持未判定。Hook 可以机械阻断路径与验收，但不能调用模型或证明独立复核发生，不用模型可自行伪造的标记冒充确定性路由。

题本和 harness 是按需实验工具，不是日常维护或发布门。先说明实验要裁决的问题，再显式选择 `--cases` 或 `--suite`；没有选择时不默认生成全量。定向运行只准备所选案例，不先执行整套 fixture 自检。已有失败、用户场景或源码证据足够支持决定时，不补模型评分。

需要维护评测设施时，按改动运行对应脚本测试；`npm run test:evaluation-tools` 才会显式运行整套离线 harness 自检和 adapter 测试，不调用模型。CI 的日常 push/PR 不执行这些实验设施检查；手动 workflow 可选择执行。评分、隔离、指纹与重裁合同统一见 [`docs/evaluation.md`](docs/evaluation.md)，不在此复制。

原始 transcript、diff、status、manifest 和单次 report 放在仓库外。历史结果保留原身份，不迁移为新版本质量或成本承诺；未知如实记录，不自动转成发布阻塞或重跑待办。只有对外宣称模型效果、成本或稳定性改善时，才需要支持该具体声明的可比证据。

版本调整前先核对两包 metadata、当前 Unreleased 和 registry 的实际发布记录；曾发布的标识不复用。`node scripts/verify-dsh-package-versions.mjs` 同时检查双包、peer、release matrix、Unreleased 与 canonical 版本归属、兼容表首行和倒序，但这只是本地一致性检查。以当前候选为例，发布事实另用 `npm view odai-dsh-plugin time --json` 与 `npm view odai-dsh-agent time --json` 核实；registry 查询失败不能当作未发布。实际发布入口继续按同一 tarball 摘要校验既有版本和发布后回执。

发布 / 打包相关修改还必须运行：

```bash
npm --prefix dsh/plugin run pack:dry-run
npm --prefix dsh/agent run pack:dry-run
test ! -e dsh/plugin/runtime
test ! -e dsh/plugin/skills
test ! -e dsh/plugin/client
test ! -e dsh/agent/preset/odai/runtime
test ! -e dsh/agent/preset/odai/skills
test ! -e dsh/agent/client
```

odai-cli 冻结期间不修改、测试或打包 `cli/`。这一步只确认两个 DSH npm 产物包含所需临时 bundled source，且没有留下第二 source。Plugin 与 Agent 的 dry-run 由 `scripts/run-package-pack.mjs` 在 `finally` 中兜底清理，因此 pack 子进程失败时也不能残留生成目录；`postpack` 继续承担成功 lifecycle 的正常清理。DSH 发版还必须运行 Plugin 与 Agent 的隔离 load probe；Agent 自行维护 preset；Standard 摘要只标识上游制品，升级 DSH 时核对该身份并验证 Odai 自有 preset 的加载、能力保持与 scoped tool/prompt 行为，不要求逐字复制 Standard。

## 日志与提交

- [`CHANGELOG.md`](CHANGELOG.md) 只保留一个当前 Unreleased owner，并记录它与冻结版的对外能力、架构、迁移和评测口径；未发布候选原位更新，不另建“前一未发布候选”。试跑、复跑、临时模型故障或中间分不进入日志。
- [`docs/evaluation-results.md`](docs/evaluation-results.md) 只记普通模型全量 / A/B 与定向质量结果；[`docs/routing-results.md`](docs/routing-results.md) 只记可选宿主能力路由的质量、实际角色、token、耗时和成本；两类证据不得混成同一成绩。只有能说明实际影响面的变化才标记相应证据失效。
- commit 标题说最终结果；大版本正文至少说明架构、迁移、题本 / harness、验证和冻结指纹。
- 实验性过程证据由 `.tmp/` 与 Git 历史承担，不在 README、plan 或 skill 中复制一份时间线。

## 安装与分发

对外入口按产品独立分发：

```bash
# host-neutral skill
npx skills add https://github.com/orziz/odai --skill odai

# profile-wide DSH bundle
dsh plugin --profile web add odai-dsh-plugin

# session-scoped DSH preset
npx odai-dsh-agent install
```

canonical source 保持在 `skills/` 与 `dsh/runtime/src/`；使用者 README 说“怎么用”，本文说“怎么维护”，skill 本体只放 agent 完成任务必需的运行时内容。
