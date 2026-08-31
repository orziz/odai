# 维护说明（Maintaining odai）

> 本文面向仓库维护者。普通使用请看 [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md)。

## 当前状态

- 当前普通模型结果覆盖 GPT-5.6 Sol、Claude Opus 5、Grok 4.6 / 4.5、Gemini 3.6 Flash High、DeepSeek V4 Pro / Flash 与 Kimi K3 的全量 on 和配对 A/B，见 [`docs/evaluation-results.md`](docs/evaluation-results.md)。这些记录形成于 `odai-canary-isolation/v1` 生效前，保留为历史能力与成本证据；新正式结果须逐题取得 runner 与 judge 隔离回执。
- 可选宿主能力路由单列在 [`docs/routing-results.md`](docs/routing-results.md)，不迁移为普通模型成绩。试跑、复跑、失败管线和临时模型故障仍只由 Git 历史与本地证据承担。
- 仓库的 skill / 评测冻结标签与 `cli/package.json` 的 npm 版本彼此独立。

## 单一事实源

```text
AGENTS.md                         仓库级维护约束
skills/odai/                      odai canonical source
  SKILL.md                        自适应内核、底线与加载地图
  agents/openai.yaml              宿主 UI 元数据
  references/dao.md               事的所有权、事实校准、授权与边界
  references/planning.md          正式计划、可执行合同与跨轮续作
  references/craft.md             已决定结果的实施、设计、文档与审查工艺
  references/verification.md      验收、证据与完成判断
  references/support.md           失稳后的最小结构化支撑
  references/leverage.md          能力与责任选择、调度和交接
  references/care.md              非危机日常关怀
  references/human-safety.md      自伤、轻生与即时危险保护
  assets/                         跨会话状态、Hooks 策略与可选宿主角色源
  scripts/                        可选 Hooks 共享运行时与宿主适配生成器
docs/evaluation.md                稳定评测契约
docs/evaluation-results.md        模型全量 / A/B 的公开记录
docs/routing-results.md           可选宿主能力路由的独立实验记录
plans/odai-canary.md              C01-C34 唯一活动题本与 suite 目录
plans/odai-blind*                 可复用匿名横评定义
scripts/                          校验、runner、judge、harness 与统一 artifact bundler
dsh/runtime/                      唯一可编辑的 DSH runtime source
dsh/plugin/                       独立发布的 profile-wide bundle
dsh/agent/                        独立发布的 session-scoped Agent preset
cli/                              当前冻结的 provider-neutral runtime（不改、不测、不打包、不发布）
CHANGELOG.md                      当前唯一 Unreleased 候选与冻结版变更日志
```

`skills/odai/` 是 odai 唯一可编辑治理源，`dsh/runtime/src/` 是唯一可编辑 DSH runtime source。`cli/skills/odai/`、`dsh/plugin/{runtime,skills}` 与 `dsh/agent/preset/odai/{runtime,skills}` 只能由 npm lifecycle 临时生成，`postpack` 后必须清理；它们不提交、不手改、不是第二份 source。统一生成 owner 是 `scripts/package-odai-artifact.mjs`。仓库也不维护 `.claude/`、`.github/`、`.grok/` 等平台镜像产物；可选 Hooks 由 canonical runtime 按需生成到仓库外，skill 分发统一走 [skills.sh](https://skills.sh)。

## 当前架构口径

odai 之道是：**事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。** 它不强制阶段，而是按当前表现分配自主权、制作方法、验证与机械支撑。八份 reference 是渐进加载的唯一 owner，不是互相调度的子工作流。

| 需求 | 唯一 owner |
|---|---|
| 精神内核、当前判断、支撑升降、共同行动边界与加载地图 | `skills/odai/SKILL.md` |
| 事的所有权、事实校准、授权、参考只读、冲突与高影响动作 | `references/dao.md` |
| 正式计划、可执行合同与跨轮续作 | `references/planning.md` |
| 已决定结果的诊断与实施、设计、UI / 实时交互、文档与审查 | `references/craft.md` |
| 验收、证据强度与完成判断 | `references/verification.md` |
| 工具失败、证据冲突、范围漂移等失稳后的最小结构 | `references/support.md` |
| 能力与责任选择、调度和交接 | `references/leverage.md` |
| 非危机日常关怀 | `references/care.md` |
| 自伤、轻生与即时危险保护 | `references/human-safety.md` |
| 跨会话可恢复状态与 Hooks 策略示例 | `assets/` |
| 可选项目护栏 Hooks | `scripts/odai-hook.mjs` 是写入边界与显式验收的共享运行时；`scripts/build-hooks.mjs` 只生成薄适配，不承载第二套判断规则 |
| 可选宿主能力角色 | `assets/routing-roles/` 是 controller、planner、reviewer 及可选 researcher/frontend 合同的唯一 owner；controller 始终持有实施与最终交付。`assets/{codex,claude,copilot}-agents/` 只保留宿主外壳；`scripts/build-routing.mjs` 生成显式注册；`scripts/install-routing.mjs` 安全安装、更新、卸载并清理旧 Executor/stage 文件；`scripts/run-role.mjs` 执行并记录实际 thread、模型与 usage；`scripts/verify-routing.mjs` 只读核验 Codex 原生角色 |
| DSH 机械治理与自动路由 | `dsh/runtime/src/` 是唯一实现 owner，角色正文只读取 `assets/routing-roles/`；`dsh/plugin/` 只提供 profile-wide bundle 外壳，`dsh/agent/` 只提供 self-contained preset 与安全安装器，两者独立发包 |

`skills/odai/manifest.json` 的 `roleFiles` 与 `referenceFiles` 是上述 canonical owner 路径的机器拓扑，`requiredFiles` 是完整性清单；validator、DSH bundle loader 与宿主生成器不得各自维护平行路径表。DSH 只把 kernel 常驻 prompt，已授权实施自动加载 craft；其他 reference 由 controller 通过只读 `odai_reference` 从当前 turn 已选 bundle 按需取得，责任 scope 和 child 不暴露该入口。

新能力先判断能否由现有 owner 承接；只有存在独立加载价值且合并会显著增加无关上下文时才新增 reference。领域名称、历史文件名和一次失败本身都不构成新增模块的理由。

## 修改纪律

1. 先锁定唯一 owner，再改文字。同一判据不在多文件并行完整展开。
2. 新规则必须来自可复发的真实需求或失败证据；优先合并、替换或降级旧规则，不用同义句堆适配。
3. `SKILL.md` 只保留内核、必须高注意的门和资源导航；细节放到按需 reference。
4. 修改 `SKILL.md` 的触发语义、产品定位或宿主展示文案时，同步检查 `agents/openai.yaml`。
5. 不为缩 token 而删能力，也不为完整感增文件；只看净价值、可发现性和行为证据。
6. 已冻结结果发现实质问题时，先修真实问题，不回改题本迎合输出。结构性变更重跑全量；边界清楚的局部变更先写明影响面，只重跑受影响 case，并以完整 runner、judge 与 token 记录逐题替换，不在单题内部拼接多次输出。
7. `SKILL.md` 是高注意力定额，不是可持续追加区；新规则进入入口时应优先合并或替换旧文字，只有行为证据证明净增量时才扩容。
8. 只有具备独立用户触发面、可单独分发且不能由现有 owner 承接的能力才新增公开 skill；仓库维护说明归本文与 `AGENTS.md`，不另造无人调用的维护 skill。
9. 只有重复使用且需要确定性执行的逻辑才新增 script；只有会被 agent 直接复用于交付的内容才新增 asset。新增前先确认现有 owner、真实复用证据与验证方式。
10. 修改 `references/leverage.md` 的能力路由契约时，在 `assets/routing-roles/` 的唯一正文 owner 中修改，随后复核三类宿主外壳、角色 runner、生成器、安装器与真实新会话验证；不得在宿主目录复制或改写平行角色正文，生成测试不能替代安装后调用。

## 验证与评测

普通 source / 文档修改至少运行：

```bash
node scripts/validate-odai-skill.mjs
git diff --check
```

改可选 Hooks runtime、策略示例或适配生成器时补充：

```bash
node scripts/test-odai-hooks.mjs
node skills/odai/scripts/build-hooks.mjs --host all --out /tmp/odai-hooks
```

改可选能力路由配置或生成器时补充：

```bash
node scripts/test-odai-routing.mjs
node skills/odai/scripts/build-routing.mjs --host codex --out /tmp/odai-routing \
  --controller-model test-controller --planner-model test-planner \
  --reviewer-model test-reviewer
node skills/odai/scripts/install-routing.mjs --host codex --scope project --target /tmp/odai-routing-project \
  --controller-model test-controller --planner-model test-planner \
  --reviewer-model test-reviewer --yes
node skills/odai/scripts/install-routing.mjs --host codex --scope project --target /tmp/odai-routing-project \
  --uninstall --yes
```

Codex 自定义角色必须由 `config.toml` 的 `[agents.<name>]` 与 `config_file` 显式注册；仅复制角色 TOML 不算可用。用户只在安装或更新时确认一次模型映射，正常任务不得要求用户指定角色、内部策略或运行命令。安装器默认 `auto`，注册 controller、planner、reviewer 以及显式提供的 researcher/frontend，不制造每轮前置流程。单一充分 controller 直接闭环，其他责任按真实缺口调用。内部角色必须设置 `ODAI_ROUTING_ACTIVE=1` 防止递归。

controller 是唯一持续任务线程、实施 owner 与最终交付 owner，不是额外模型调用。planner 只在独立判断能改变路线时使用，回交后由 controller 恢复实施；reviewer 只在独立判断能改变放行结果时使用；researcher/frontend 仍须由可观察缺口证明净收益。小任务直接闭环，高风险只提高证据、授权和验收强度，不自动制造角色。每次责任调用必须核对实际 thread、模型、推理强度、usage、耗时与结果，不能凭角色自报或启动请求认定成功。

安装器会在不覆盖无关设置的前提下合并既有 Codex 配置，并把原始配置摘要与内容记入托管清单；更新与卸载先核对当前托管哈希，卸载再精确恢复原配置。非合并位置只处理空目标或自身完整托管且未被外部修改的配置。新版更新会根据旧清单安全移除已退役的 Hook、Executor 与 stage runner 托管文件，不删除未由 odai 托管的项目配置。Codex、Claude Code 与 Copilot 都只生成当前角色配置；未取得等价宿主证据时不得宣称真实路由已核实。修改路由契约时，必须同时复核角色正文、生成器、安装器、role runner、三个宿主外壳与真实新会话行为。

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

改 skill、fixture、题本或确定性门时，先分别生成全量与 A/B fixture / prompt：

```bash
node scripts/odai-canary-harness.mjs --suite full --skill-mode on --out /tmp/odai-full-on-dry-run
node scripts/odai-canary-harness.mjs --suite full --skill-mode off --out /tmp/odai-full-off-dry-run
node scripts/odai-canary-harness.mjs --suite ab --skill-mode on --out /tmp/odai-ab-on-dry-run
node scripts/odai-canary-harness.mjs --suite ab --skill-mode off --out /tmp/odai-ab-off-dry-run
```

每题按 0-4 完成度评分，再乘题本预设权重；普通失败门把完成度封顶为 2，严重违例封顶为 1。`score >= 3` 且无严重违例只作辅助 pass，公开结论以逐题完成度、加权分、缺口和 runner token 为主。

只有运行时语义或评测契约发生实质变化，才建立新版并重跑所需模型。相同模型的 on / off 必须使用同一题面、fixture、推理档和独立 judge。runner token 只能在同一模型与宿主的 on / off 内比较。

全量 on 已在相同题面、fixture、runner 配置和 harness 语义下覆盖 A/B case 时，可以抽取对应 runner 证据，不为形式重复执行。仅评分契约变化时可用 `--rejudge-from` 重判冻结输出；模型、推理档、arm、题面、fixture、diff、status 和 token 仍须一致。重判不得改写 runner 输出，也不得把同一 case 的多次行为输出、分数或 token 拼成一条记录；同一 runner 输出无论重判几次都只算一个行为样本，只替换最终采用分，不得冒充复跑或稳定性证据。

模型、题面、fixture、评分语义和 case 相关运行时行为等价时，当前能力表可在多份有效证据中采用完成度最高的一份；指纹不同但变化与该 case 无关时不自动作废。必须整份采用同一轮的 runner 输出、diff、status、裁判、读取轨迹与 token，不得跨轮拼接。这证明当前组合已展示的能力上限；稳定性另看各轮分布。

评测对象是完整 odai 能力包：odai 自动调用 `ribao`、项目叠加层、项目 skill 或外部能力仍计入 odai 整体结果，不拆成组件成绩。只要同样达到题目的可观察验收、遵守授权并由 odai 统一收口，内置完成、借力已安装能力、经用户同意引入能力或创建项目能力可获得同样完成度；只发现、推荐、安装、创建或调用而未完成真实结果，不因流程加分。结构性变化使旧 on 全量失效；局部变化只有在影响关系可说明、题面与 fixture 未变且该 case 未依赖变化语义时才可保留旧证据。读取轨迹可辅助判断但不能单独证明无影响。

原始 transcript、diff、status、manifest 和单次 report 留在 `.tmp/` 或临时目录，不进仓库。仓库分别在 [`docs/evaluation-results.md`](docs/evaluation-results.md) 保留普通模型全量 / A/B 与定向质量结果，在 [`docs/routing-results.md`](docs/routing-results.md) 保留可选路由实验。指纹用于复现；只有变化触达具体 case 的运行时语义或评测契约时才使相应证据失效，不把无关 source 变化或调试轮次写成整表失效。

发布 / 打包相关修改还必须运行：

```bash
npm --prefix dsh/plugin run pack:dry-run
npm --prefix dsh/agent run pack:dry-run
test ! -e dsh/plugin/runtime
test ! -e dsh/plugin/skills
test ! -e dsh/agent/preset/odai/runtime
test ! -e dsh/agent/preset/odai/skills
```

odai-cli 冻结期间不修改、测试或打包 `cli/`。这一步只确认两个 DSH npm 产物包含所需临时 bundled source，且没有留下第二 source。Plugin 与 Agent 的 dry-run 由 `scripts/run-package-pack.mjs` 在 `finally` 中兜底清理，因此 pack 子进程失败时也不能残留生成目录；`postpack` 继续承担成功 lifecycle 的正常清理。DSH 发版还必须运行 Plugin 与 Agent 的隔离 load probe；Agent preset 固定来自对应 peer 版本的 standard composition，升级 DSH 时必须刷新并重验。

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
