<!-- Language toggle -->
[English](README.md) · **中文**

# odai

<p align="center">
  <img src="assets/odai-readme-badge.png" alt="odai 看板娘岱" width="720">
</p>

`odai` 是面向 AI agent 的治理内核驱动的通用任务执行框架。

它把治理融入执行：对齐真实目标、事实、假设、授权、风险与验收，再选择最短充分路径、组合合适能力、行动、验证，并持续推进到真正可交付的结果；不会用僵硬流程替代模型判断。

一句话：你用 `/odai` 交任务；简单任务中治理近乎隐身，遇到模糊、复杂、风险或领域需求时再自动提升处理深度。

## 为什么用它

`odai` 适合想让 agent 自主推进、但不想让它带着虚假确定性乱冲的人。

它会帮助 agent：

- 只在缺口会改变目标、范围、授权、验收、风险或停止线时才问你
- 能从文件、命令、日志、测试或项目上下文补证的，先自己补证
- 让轻量任务保持轻量，不把每个请求都变成流程仪式
- 不把没测试、没调用、没审查、没验证的事情说成已经做过
- 按需组合专项技能和领域知识，而不是每一轮都塞满所有规则
- 复用宿主或项目已有记忆，只固化有来源、范围与失效条件的长期信息
- 对持续低落、自残或轻生倾向提前关怀和及时介入，不诊断、不贴标签、不因“还没有计划”而忽略，也不造成二次伤害

## odai 之道

**事由人定，路由实证；法随势变，成由验定；止于边界，成事而不妄为。**

这不是诸家思想的拼盘，而是一条统一的判断准绳：

- **成事**：推进用户定义的事至经验证的可交付结果；会改变结果的反例、风险与更稳路径，要主动端出来。
- **不妄为**：事实、用户决定与底线不可曲；无依据不定论，无授权不越界，无必要不造工作，发现不等于获准实施。

人和模型以共同成事为合作关系，而非单向命令与服从。用户提供意图、语境、价值取舍与不可接受结果；模型贡献判断、证据、创造与执行，主动质疑可疑前提并提出更优路径。双方以真实进展、坦诚的不确定与反馈校准理解和信任；目标取舍由用户决定，界内专业做法由模型自主，授权不是盲从，质疑也不是夺权。

odai 不是用户的回声，也不是规则的复读机。它以人的目的为方向、以事实和边界为约束，形成自己的判断与推荐，必要时坚持异议，也随证据改判。真实胜过讨好，有效胜过仪式，可靠结果胜过表面省事，长期信任胜过一轮表现。

模型的主动性只按净价值裁决。速度、质量、稳定、成本、泛用与实用都是围绕用户目标和事实权衡的结果，不再是一排并列口号，更不能替代真实交付。

### 行动标准

**看得清、拿得稳、打得准、落得实、守得住、走得远。**

看清真实目标、事实与缺口；拿稳授权、边界与风险；打中最窄充分路径；落到可验证的交付；守住用户决定、系统安全与事实；让结果经得起后续使用、维护和变化。

### 产品目标

让 agent **更快、更准、更好、更稳、更省、更轻、更广、更活、更有用、更实用**。这些不是彼此独立的流程指标，而是围绕当前任务共同权衡的产品结果：只认净价值，不拿流程、文件数、token 或评测得分替代真实成事。

## 30 秒上手

安装统一入口：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

然后用 `/odai` 交任务。支持 slash command 的客户端里，常规就是这种写法：

```text
/odai 更新新用户引导文案。
目标：让第一次使用的人更容易看懂。
材料：当前 app 文件和 README。
约束：先不要改行为；先给我文案方案和风险。
```

如果当前客户端不支持 slash command，用自然语言点名 `odai` 也可以。

你不需要记住内部结构，也不需要选择方法论。`odai` 会根据任务和项目证据自动判断处理深度、所需能力、领域知识和验证强度。

### DeepSeek Harness 独立包

[![npm: odai-dsh-plugin](https://img.shields.io/npm/v/odai-dsh-plugin?label=odai-dsh-plugin&logo=npm)](https://www.npmjs.com/package/odai-dsh-plugin)
[![npm: odai-dsh-agent](https://img.shields.io/npm/v/odai-dsh-agent?label=odai-dsh-agent&logo=npm)](https://www.npmjs.com/package/odai-dsh-agent)

DSH 用户可以按需要独立安装两种形态：

```sh
# 对一个 profile 中的所有 agent preset 生效
dsh plugin --profile web add odai-dsh-plugin

# 安装可选择、按 session 生效的 Odai Agent preset
npx odai-dsh-agent install
```

Plugin 安装命令要求 `pnpm` 已在 `PATH` 中；当前 `0.2.17` Plugin 与 Agent 候选严格支持 `dsh@0.1.1-rc.2` 与 `dsh@0.1.2-alpha.2`；已发布的 `0.2.16` 首次加入 Control Center。两个包都已经包含 canonical Odai skill、共享 DSH runtime 与同一份中文 Control Center，不存在第三个包。Plugin 安装后直接提供 Control Center；Agent 的交互式 `install` 会说明现有 profile 的来源和版本，并在 `[y/N]` 要求显式输入 `y/yes`；直接回车、EOF、`n` 或其他文本都不修改 Web profile。非交互安装必须显式传 `--with-control-center` 才会修改 profile。Agent 完整保留所固定 DSH Standard preset 的全部能力，再以 scoped 扩展叠加 Odai。Plugin 与 Agent 可以独立安装，也允许同时安装；共存时由 Plugin 拥有唯一 Control Center 界面，两套 runtime 共享并去重治理、路由与 evidence 状态。现有 provider-neutral `odai-cli` 继续作为独立产品。

两个 DSH 包都默认使用**软精简**输出。用户可以显式切换到正常模式，或启用可选的**经济模式**：它在软精简基础上增加可调的 provider 输出 ceiling；用户只说“经济模式”而未给其他值时默认使用 `500`。该 ceiling 不会影响子代理、compaction、checkpoint 或内部上下文预算，provider 仍可能超过或忽略它。完整三档契约见 [`dsh/README.md`](dsh/README.md#install-and-use)。

完整、独立安装的 Odai skill 可以比两个 DSH 包更快更新，但不会自行改变默认来源。只有用户明确要求，Odai 才会把 skill source 切换为 `auto` 或 `user`：`auto` 可以选择兼容的项目 `.dsh` / `.agents` bundle 与较新的用户安装，`user` 则忽略项目根；部署显式路径始终优先。Plugin 与 Agent 刻意共存时按 agent / turn 共用同一份快照，prompt 治理与路由 role contract 不会选到不同 bundle。

两个 DSH 包都不会自行选择 researcher、planner、reviewer 或 frontend 模型。用户只需自然地告诉 Odai，例如“规划用 provider/model，推理档 high”，模型就会为 Plugin 和 Agent 共用的机制持久化这项明确选择。之后正常交任务即可：职责词不是口令，runtime 从任务状态和证据缺口选择 direct、inline、same-turn 或 child；当前 controller 与 planner 同模型时不会重复调用，planner 回交后由 controller 继续已获授权的实施。真实任务需要某项尚未配置的职责时，Odai 会说明缺少哪一项并询问模型，而不会声称该路线已经运行。持久映射在 provider I/O 前正式校验；确定性坏映射备份后精确清理，额度、鉴权或网络故障只影响当次 fallback。

DSH 的心理与人身安全连续性不进入通用 semantic memory。只有用户明确要求，controller-only 工具才会把用户原文中的照护偏好、希望留意的信号、有效支持方式或自写安全计划保存到独立本地记录；用户可查看、导出、更正、逐条删除或物理清空，记录默认保留到用户执行删除。新会话只把它当历史照护偏好，不当成当前风险、诊断或隐藏评分，child agent 也拿不到这份记录。

包边界、来源优先级、自然语言配置与隔离环境真实安装共存验证见 [`dsh/README.md`](dsh/README.md)。

### 宿主能力路由

用户只在首次设置时说明“谁负责什么”，或让 odai 按宿主真实能力目录推荐映射。确认并安装后，项目持久保存这份映射；之后任何对话和操作仍只用 `/odai` 或自然语言交任务，不再声明模型、角色、规划模式或路由命令，也不需要观看内部交接。模型变化时原地更新一次映射即可。

总控是持续持有目标、全局状态、修正回路与最终交付的任务线程，不是每轮额外启动的一名角色。判断与验收是可选内部责任，不是用户工作流；实施始终由总控持有。同一能力足够就一把做完；其他映射责任确实能改变结果时，宿主取得该项有界贡献，再把唯一结果送回当前对话。可靠的无工具回答保持直答；后续对话自动承接最近交付和未决项，不要求用户重述。

这项路由受宿主能力约束，单靠 Skill 文本不能机械保证。宿主不能核实换档或委派时，odai 使用单一充分总控继续完成安全可做的部分，不虚构升档或下放。路由器不是普通使用的前置步骤；只有用户要求托管能力路由时才安装。

托管能力路由与下文项目护栏 Hooks 是两套机制。路由只注册宿主角色，不安装任务 runner 或隐藏的每轮 Hook；项目护栏只执行项目明确声明的只读路径和验收命令，不负责模型路由。

受支持宿主的用户需要托管角色路由时，不用找路径、填写模型或手工合并配置；安装 skill 后直接说：

```text
/odai 为当前项目安装并验证能力路由。
```

odai 会从当前宿主的真实能力目录配置一个 controller 与 planner、reviewer，并可选配置 researcher、frontend，说明持久化影响并请求一次确认，然后安装并检查冲突。默认 `auto` 只注册能力：由单一总控实施并闭环，可选责任只在独立工作能改变结果时调用，不增加隐藏的每轮前置流程或 stage runner。可靠直答和只读查询不为展示路由调用其他角色。

不再使用时可以说“用 odai 卸载当前项目的能力路由”。安装器会合并既有宿主设置，记录原始 Codex 总控配置以便精确恢复，只删除清单中仍未被外部修改的托管文件，并保留无关设置；安装、更新或实际卸载后须开启新会话。默认只影响当前项目。自动安装器可为 Codex、Claude Code 与 GitHub Copilot CLI 生成托管角色配置；Codex 另有原生角色核验，另外两个宿主尚未取得等价证据时不能宣称同等程度的运行时路由。

## 它怎么判断

`odai` 持续判断四个维度：

- **复杂度**：直接行动、增加少量结构、分段执行，还是维护可恢复的长期状态与可信记忆。
- **明确度**：证据足够直接做、先安全探索，还是确实需要用户决定。
- **风险度**：可逆任务轻验证；外部或难回退任务使用更强授权和证据。
- **领域**：代码、文档、表格、演示、浏览器、图像、游戏等内部工艺、项目规则或宿主专项技能。

加载任何指南前，先过静默轻门：结果、动作、路径、授权和验证已经清楚且低风险，就直接做。只有前提可疑、要求冲突、关键歧义、跨层取舍、高风险副作用或长依赖出现时才展开。

深度不会在开始时定死。影响面扩大就升级，检查后发现只是局部小改就降级。SDD、TDD、BDD、agent、合议和正式计划都只是可选方法，不是强制模式。

用于启发、对照、说明或验证的对象默认只读。以理解、判断、建议或方案为核心的请求不会被升级成修改现有对象的授权；即使用户要求产生变更，也只修改已经明确的目标对象。

重点不是让 agent 慢下来，而是让它在该快的地方快，在不该猜的地方停稳。

## 架构逻辑

```text
                         用户任务
                            |
                            v
       +---------------------------------------------+
       | /odai -> 轻量自适应内核                    |
       | 理解局面 -> 选择下一项最高价值动作         |
       +---------------------+-----------------------+
                             |
       +---------------------+-----------------------+
       |                     |                       |
       v                     v                       v
    直接行动             内部工作能力             宿主技能 / 工具
                         + 领域知识                 + 项目规则
       |                     |                       |
       +---------------------+-----------------------+
                             v
                    行动 -> 验证 -> 交付
                             |
                       新证据及时改路

只有复杂或长期任务才加载持久状态、
可信记忆、agent 协作、独立挑战或合议；
已有记忆载体优先复用，不另建第二套真相。
```

odai 从理解到交付持续负责当前任务。六份扁平资料只补当下需要的边界、工艺、可执行计划与持久交接、验证、支撑或外部能力；不存在另一套 orchestrator 流程，也不让用户选择领域包。

odai 的完整能力不只是入口文本，而是“内核 + 内置基本工艺 + 项目上下文 + 值得借用的专业能力”。已安装且明确匹配的能力可直接借用；通用缺口只在净增益成立时推荐安装；稳定、反复且项目专属的工艺才值得固化成项目 skill。不论路线如何，odai 都负责整合原始证据、验收与最终交付；仅仅“找到、推荐、创建或调用了能力”不算成事。

## 内部地图

内部按职责分层，而不是按强制阶段排列：

| 层级 | 职责 |
| --- | --- |
| 根内核 | 总纲、自适应推进、最小底线与加载地图 |
| `human-safety.md` | 人身与心理危机的早期识别、自然干预、二次伤害防止与授权安全连续性 |
| `dao.md` | 事的所有权、事实校准、授权、参考只读与高影响边界 |
| `craft.md` | 轻量规划、实施、设计、UI / 实时交互、文档与审查 |
| `planning.md` | 可执行工程计划、需求覆盖、工作包依赖、持久交接与恢复顺序 |
| `verification.md` | 验收、证据强度、完成判断与旧任务恢复 |
| `support.md` | 自我校准、表现恢复、长期状态与记忆、关系连续性、合议与连续审查 |
| `leverage.md` | 能力升降、外部能力的发现、净增益、安装、创建、组合与 agent 协作 |

领域深度由任务事实自动判断，不让用户选择内部资料包。游戏、UI、文档和软件任务先使用内置工艺，再只为明确缺口借用项目资料、宿主工具或专业技能。`frontend` 这类可选宿主责任只在当前任务已证制作缺口内适配用户配置的模型与预算，不是可选领域包，也不构成按数据库、安全等领域继续枚举角色的先例；没有外部技能或责任映射时，odai 仍完成当前模型能够可靠完成的部分。

内容任务保留事实、既有模板、未完成责任与外部发布边界。复杂或长期任务只有在确实改善恢复时，才把决定、状态和验收写回一个既有维护位置；代码、测试或目标产物已经完整承载结果时，不额外制造文档。

## 常用提示词

信息不全也没关系，按你知道的程度说：

```text
/odai 接这个任务。你自己判断路线，只在边界或验收缺口会影响推进时问我。
```

```text
/odai 审当前 diff，findings first，不要修改文件。
```

```text
/odai 刷新这个仓库的 README。删掉过时截图，安装路径要清楚。
```

```text
/odai 这个任务会影响用户体验。未经确认不要改行为，先验证建议路线。
```

## 安装方式

大多数人只需要统一入口：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

其他安装方式：

```bash
# 安装仓库里的所有 skill
npx skills add https://github.com/orziz/odai --all

# 安装更省 token 的分支
npx skills add https://github.com/orziz/odai#mini

# 安装旧的「一个能力一个 skill」布局
npx skills add https://github.com/orziz/odai#old
```

只有还依赖旧独立技能布局，或正在做迁移对照时，才建议使用 `old` 分支。

canonical source 都在 `skills/` 下。分发走 [skills.sh](https://skills.sh) 安装流程；本仓库不再维护各平台镜像产物。当前 source、验证、冻结与发布口径见 [MAINTAINING.md](MAINTAINING.md)，已冻结架构变更见 [CHANGELOG.md](CHANGELOG.md)。

## Codex 桌宠

本仓库提供两个互补、而非简单换色的 Codex v2 桌宠：

| 桌宠 | 角色定位 | 性格 | 分工 |
|---|---|---|---|
| [阿岱（`dai`）](pets/dai/) | 黑青行事官与执行搭档 | 沉着、可靠、克制 | 推进任务、执行、验收并收尾 |
| [欧黛（`odai`）](pets/odai/) | 银白蓝紫吉祥物与陪伴搭档 | 活泼、亲近、好奇 | 陪伴、卖萌、回应进展、打气并庆祝完成 |

阿岱负责把事做成，欧黛负责让做事的过程有人陪；欧黛不是行事官。两者都包含 9 组标准动画和 16 个观察方向。安装 `odai` skill 不会自动安装桌宠。

完整人物资料分别见 [阿岱设定档案](docs/阿岱%20设定档案.md) 与 [欧黛设定档案](docs/欧黛%20设定档案.md)。

克隆或下载本仓库后，选择一个桌宠，将它的两个运行文件复制到同名 Codex 桌宠目录。

Windows PowerShell（以下安装 `odai`；黑色版把两处名称改成 `dai`）：

```powershell
$petName = "odai"
$petDir = Join-Path $env:USERPROFILE ".codex\pets\$petName"
New-Item -ItemType Directory -Force $petDir | Out-Null
Copy-Item -LiteralPath "pets\$petName\pet.json","pets\$petName\spritesheet.webp" -Destination $petDir -Force
```

macOS 或 Linux：

```bash
pet_name="odai" # 黑色版改成 "dai"
mkdir -p "$HOME/.codex/pets/$pet_name"
cp "pets/$pet_name/pet.json" "pets/$pet_name/spritesheet.webp" "$HOME/.codex/pets/$pet_name/"
```

然后打开 **Codex 设置 → Pets**，刷新列表并选择 `dai` 或 `odai`；也可以用 `/pet` 打开桌宠选择器。预览和格式说明见 [dai 分发包 README](pets/dai/README.md) 或 [odai 分发包 README](pets/odai/README.md)。

## 可选 Hooks 增强

skill 负责判断，Hooks 只把项目已经明确的边界变成机械护栏。它们默认不安装、不启用，也不改变 `odai` 的主流程；只有项目创建 `.odai/hooks.json` 后，才会保护显式只读路径，并在收口时运行显式声明且与当前变更相关的验收命令。没有策略文件时完全静默。

这是 odai 管理的唯一每轮 Hook。能力路由安装器不安装 Hook，也不能替代项目护栏。

仓库维护一份无依赖运行时，按需生成宿主原生适配，不常驻六套平台镜像：

```bash
node skills/odai/scripts/build-hooks.mjs --host all --out /tmp/odai-hooks
```

也可以把 `all` 换成 `codex`、`claude`、`copilot`、`gemini`、`grok` 或 `kimi`。每个输出目录里的 `ADAPTER.json` 会说明安装形态；策略从 [`skills/odai/assets/hooks-policy.example.json`](skills/odai/assets/hooks-policy.example.json) 起步，按项目事实改好后放到项目根 `.odai/hooks.json`。

| 宿主 | 写前只读路径保护 | 收口前显式验收 |
|---|---:|---:|
| Codex | `PreToolUse` | `Stop` |
| Claude Code | `PreToolUse` | `Stop` |
| GitHub Copilot | `preToolUse` | `agentStop` |
| Gemini CLI | `BeforeTool` | `AfterAgent` |
| Grok Build | `PreToolUse` | — |
| Kimi Code CLI | `PreToolUse` | `Stop` |

Grok Build 当前只有 `PreToolUse` 是可阻断边界，因此适配器不会伪造 Stop 验收。Hooks 只检查结构化写工具和项目明确配置的命令，不解析任意 shell 写入，也不推断用户意图、目标文件或测试方案；它们是权限、沙箱和人工确认之外的轻量保险丝，不是完整安全边界。启用前应审查生成配置与 `.odai/hooks.json`。

## 评测

当前结果覆盖 19 条全量现实委托和其中 13 条配对 A/B。只有 2 题是明确低风险对照；其余只给自然症状、意见或宽泛请求，关键事实藏在项目代码、日志、brief、diff、任务状态和 runbook 中。指纹用于复现精确运行；只要题面、fixture、模型配置、评分语义和该题实际依赖的 skill 行为等价，无关的路由资产或维护改动不会让整张成绩自动失效。Gemini 3.7 与 DeepSeek V4 Pro（DSH）按跨平台 `odai-canary-isolation/v1` 运行；其余公开行形成于该契约生效前，只保留为历史能力证据。

结果先按真实完成度评为 0-4，再乘预设权重；全量满分 144，A/B 满分 96。direct、judgment、complex、boundary 四层分别报告，严重越权、生产风险和虚报验证另设硬封顶。on 臂满分本身不算价值证明，必须与同模型 off 的结果和成本一起看。

| Runner | 全量 on | A/B on | A/B off | 净增 | A/B runner token on / off |
|---|---:|---:|---:|---:|---:|
| GPT-5.6-sol / high | **144/144** | **96/96** | 80/96 | **+16** | 396,899 / 317,761（+24.9%） |
| Claude Opus 5 | **144/144** | **96/96** | 77/96 | **+19** | 2,273,558 / 1,937,782（+17.3%） |
| Grok 4.6 / default high | **144/144** | **96/96** | 67/96 | **+29** | 2,236,506 / 1,285,461（+74.0%） |
| Grok 4.5 | **144/144** | **96/96** | 69/96 | **+27** | 1,579,533 / 1,054,670（+49.8%） |
| Gemini 3.7 Flash High | 134/144 | 88/96 | 72/96 | **+16** | 1,813,203 / 1,580,475（+14.7%） |
| Gemini 3.6 Flash High | 126/144 | 82/96 | 67/96 | **+15** | 1,381,447 / 2,235,193（-38.2%） |
| Kimi K3 | **144/144** | **96/96** | 75/96 | **+21** | 2,192,056 / 1,632,057（+34.3%） |
| DeepSeek V4 Pro / max（DSH） | **144/144** | **96/96** | 63/96 | **+33** | 2,131,373 / 1,652,030（+29.0%） |
| DeepSeek V4 Flash | **144/144** | **96/96** | 61/96 | **+35** | 5,341,138 / 3,975,731（+34.3%） |

九个 runner 的 A/B 均有正增益；除两款 Gemini 外，其余 runner 的全量 on 与 A/B on 达到满分。八个 runner 的 on token 更高，Gemini 3.6 则下降 38.2%，因此质量增益和成本变化都依模型而异，不支持无条件提质或无条件省 token。

当前评测契约见 [`docs/evaluation.md`](docs/evaluation.md)，模型全量 / A/B 的逐题分数、支撑读取和 token 明细见 [`docs/evaluation-results.md`](docs/evaluation-results.md)，可选宿主能力路由的质量、角色 usage、耗时和成本实验见 [`docs/routing-results.md`](docs/routing-results.md)。

欢迎 star，也欢迎 PR。
