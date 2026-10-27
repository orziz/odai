# 宿主路由的安装与配置

用户要求为 Codex、Claude Code 或 Copilot 安装、更新、卸载或修复职责路由时读取。安装本技能和 `odai` 只使规则与脚本可发现，不自动修改宿主配置；DSH 已内置编排时使用其现有能力，不运行这里的安装器。

1. 从宿主确认实际模型、能力与作用域。controller、planner、reviewer 显式映射，researcher、frontend、creative 和 writer 按需选择，默认不生成，也不从其他职责继承映射；creative 与 writer 只读，交回内容由总控核对后落盘；从真实模型目录核对，不虚构模型 ID。默认当前项目，跨项目作用域须明确授权。
2. 先用 `scripts/build-routing.mjs --help` 查看生成接口；治理安装位置不相邻时显式传入 `--governance-root`。
3. 需要持久安装、更新或卸载时使用 `scripts/install-routing.mjs --help` 对应入口，说明映射、写入范围与新会话生效条件。已有授权覆盖本次动作时直接执行；否则完成准备后取得授权。
4. 按安装结果在新会话核对真实角色和模型的实际调用。生成文件和配置成功只证明文件生成，不证明路由已调用。托管清单负责更新、漂移检查、卸载与恢复，遇到外部修改不覆盖。

## Claude Code 总控调用本机 CLI

`build-routing.mjs` 与 `install-routing.mjs` 在 `--host claude` 下接受非 controller 职责的 `--<role>-cli <codex|antigravity|grok>`，必须同时显式提供该职责的 `--<role>-model`；`--<role>-effort` 可选。未指定 CLI 的职责仍使用 Claude Code 原生子代理，controller 始终保持原生。Codex 宿主接受 `--<role>-cli <claude|antigravity|grok>`，controller 保持原生；Copilot 不接受 CLI 选项。

例如，先在临时输出目录生成 Claude Code 总控与 planner、由 Codex 承担 reviewer 的配置（模型名替换为已确认可用的 ID）：

```sh
node skills/odai-orchestration/scripts/build-routing.mjs \
  --host claude --out <临时输出目录> \
  --controller-model <Claude模型> --planner-model <Claude模型> \
  --reviewer-cli codex --reviewer-model <Codex模型> --reviewer-effort high
```

取得目标项目安装授权后，用相同的模型与 CLI 参数调用 `install-routing.mjs --host claude --scope project --target <项目目录> … --yes`。已有安装通过安装器更新；生成器遇到旧输出中相反后端的文件会拒绝并要求新的 `--out` 目录，避免留下同名原生代理。用户级安装使用 `--scope user --target <配置目录>`，其调用说明与权限指向配置目录内执行器的绝对路径。

本机职责不生成同名原生代理；安装器管理 `.claude/odai-run-role.mjs`、`.claude/odai-local-cli.mjs`、角色合同与路由清单，并向宿主设置的 `permissions.allow` 合并执行器 Bash 权限。既有权限与其他设置保留；更新、漂移检查和卸载覆盖新文件，卸载仅撤回安装器新增的权限。存在非托管的同名原生代理时拒绝安装，不覆盖它。

总控把有界任务包写入文件，再按生成的 controller 说明调用，例如：

```sh
node .claude/odai-run-role.mjs --role reviewer --input <任务包文件> \
  --evidence <证据文件> --output <正文文件>
```

执行器把角色合同和任务包交给目标 CLI，所有职责均只读；制作任务只能交回未应用补丁，由总控核对落盘。需要先安装并登录目标 CLI；子进程继承 Claude Code 的环境变量，需要代理时应在启动 Claude Code 的环境中配置 `HTTPS_PROXY` 等变量。可执行文件分别由 `ODAI_CODEX_COMMAND`、`ODAI_AGY_COMMAND`、`ODAI_GROK_COMMAND` 覆盖。默认超时 1200 秒，`--timeout` 接受 1–7200 整数秒。

执行器输出 version 1 证据；省略 `--evidence` 时，Claude 宿主持久保存在执行器同目录 `role-evidence/`，Codex 本机 CLI 保存到当前项目 `.odai/role-evidence/`，路径写到 stderr。证据是运行产物，卸载保留。只有调用完成、正文非空且实际模型核实时才输出正文并退出 0；能取得推理档证据的 CLI 出现推理档不一致时同样失败。失败退出非 0，不输出正文、不覆盖已有正文文件。Codex 通过本次会话的模型与推理档取证；Antigravity 和 Grok 目前只能把推理档记为 `requested-only`，证据如实记录、不阻断回交，与 DSH 的规则一致。

Antigravity 1.4.7 下禁用斜杠展开使计划模式失效；只读依赖无界面授权拒绝和 DONE 工具的执行后检查（不能撤销已发生的动作）。不要给 odai 使用的 agy 配置写类 permissions.allow；被拒动作可能使正文为空。Grok 适配继续标注**按官方文档及既有评测证据实现，当前适配未实测**：优先取 JSON `modelUsage`，缺失时回退会话 summary；格式不符或证据缺失就失败。各 CLI 自身的会话或计划目录可能产生运行记录，只读边界针对被委托项目。

安装只启用按缺口选择的分工，不注入每轮必走流程。没有宿主适配或无法取得所需能力时，治理仍独立工作：继续安全可完成的部分，准确交付剩余缺口；不要把技能已安装、角色已配置或一次自报当成调用和收益证明。

writer 用于方向已定的起草、改写、翻译与本地化，creative 负责方向、构思与品味把关；未配置 writer 时 creative 照旧承接写作。可选参数为 `--writer-model`、`--writer-effort`，Claude 宿主另有 `--writer-cli`；默认不生成映射。


## Codex 的本机 CLI 与权限

Codex 使用 `.codex/odai-run-role.mjs`、`odai-local-cli.mjs`、`role-contracts/` 和 `odai-routing.json`；本机映射不生成同名原生代理。构建和安装接口相同，例如（仅一种配置，模型须自行确认）：

```sh
node skills/odai-orchestration/scripts/build-routing.mjs --host codex --out /tmp/odai-preview --controller-model gpt-6.1-sol --planner-model gpt-6.1-sol --reviewer-cli claude --reviewer-model haiku --reviewer-session continue
```

总控在 codex-cli 0.163.0 的默认 workspace-write 沙箱中实测：本机 CLI 职责因无法联网而失败，claude 返回零 token、退出码 1；CODEX_THREAD_ID 已确认注入命令环境。安装器不修改沙箱、联网或审批策略。

运行具体执行器命令（例如 `node .codex/odai-run-role.mjs --role reviewer --input task.md`）时，需要申请越出沙箱，理由是需要联网，并写入本机 CLI 自己的目录；由用户按自己的审批策略批准该命令。用户拒绝或当前审批策略不允许时，如实报告该职责不可用，不改用别的模型。越出后 CLI 可联网、访问凭据并写自身会话目录；撤回时拒绝后续批准，恢复用户自行修改的配置并重开会话。

依据：本机 `codex --help` 列出 `--ask-for-approval on-request`，`codex exec --help` 列出沙箱选项；已安装 `@openai/codex/README.md` 仅提供入门及文档链接，未说明逐命令越出沙箱的申请接口。因此这里不指定未经核实的申请参数。

Codex 本机 CLI 的证据和续接状态分别位于当前项目 `.odai/role-evidence/`、`.odai/role-sessions/`，用户级安装也按执行器的 `--cwd`（省略时为当前目录）确定项目。建议将这两个目录加入项目 `.gitignore`；安装器不自动修改 `.gitignore`。

## 显式会话续接

构建/安装可用 `--<role>-session fresh|continue`；清单对应 `session`，省略为 fresh。Claude Code 原生职责开启 continue 时，用 SendMessage 继续上次派出的同一个子代理，可按名字或 agentId 续发，已完成的子代理也可以续发，不新派（Claude Code 2.1.307 本机实测）。Codex 原生角色续接证据不足，显式 continue 报错。

本机 CLI 复用共用适配器：claude、antigravity 支持，codex、grok 不支持并报错。宿主键按清单 host 优先取对应变量（Claude：`CLAUDE_CODE_SESSION_ID`；Codex：`CODEX_THREAD_ID`），另一变量后备，再取显式 `--session-key`，均缺失时报错。显式键须在同一宿主会话内稳定、跨会话唯一。路由标识为 backend + cli + model，各职责可共享。

Claude 状态位于执行器旁 `role-sessions/<键SHA256>.json`，Codex 本机 CLI 状态位于当前项目 `.odai/role-sessions/<键SHA256>.json`，与 `role-evidence/` 同级；锁目录 `<状态文件>.lock` 保证跨进程串行，等待超时明确失败。异常强杀遗留锁时，确认进程已结束后由用户移除该具体锁。状态原子替换，卸载保留状态和证据。证据 `observed.session.mode` 使用 `created`、`resumed`、`resume-failed-created`；未开启续接时省略该项。续接错误仅新开一次并在 stderr 和证据注明；超时、取消、边界越界不重开，不换模型。每次仍发送完整合同和任务包并核实模型。后端会话由各 CLI 自行存放管理，odai 不删除，只读模型证据所需部分；上下文逐次增长，由后端压缩。

默认映射、合同与宿主配置保持既有行为；由于编排 requiredFiles 增加及执行器升级，ADAPTER/安装清单的真实 bundle digest 和复制的执行器字节会变化，不能宣称全部生成文件逐字节不变。


## 可选点名与主导模式路由 Hook

默认只注册角色，不装路由 Hook。只有 Claude Code / Codex 显式传 `--named-dispatch` 或 `--lead-mode` 才生成和安装声明式路由 Hook；Copilot 拒绝这两个参数。两者可组合，共用脚本、状态与托管清单；只传 `--named-dispatch` 保持点名行为。点名识别复用 `recognize-routing.mjs`，不依赖项目护栏的 `.odai/hooks.json`。新消息取代旧待办，“继续”保留，否定取消；未配置或名字不符只注入说明，不拦工具。

Claude 合并 UserPromptSubmit、PreToolUse、PostToolUse、Stop 条目到项目 `settings.local.json`（用户级为 `settings.json`）；更新/卸载只移除托管条目，外部漂移拒绝覆盖。Hook 和共用识别脚本在执行器同目录，`odai-named-dispatch.json` 保存独立映射，路由安装清单记录文件摘要和设置恢复信息，与护栏清单分开。状态在 `.claude/named-dispatch/<session_id SHA256>.json`；Codex 状态在当前项目 `.odai/named-dispatch/`，建议加入 `.gitignore`，安装器不修改忽略规则。状态原子替换且锁定，卸载保留。

UserPromptSubmit 的 `hookSpecificOutput.additionalContext` 向总控说明职责、时机和调用方式。PreToolUse 拦截尚有开始时点名的写类工具：Claude 的 Edit/Write/MultiEdit/NotebookEdit/Bash，Codex 的 apply_patch、shell/shell_command/exec_command 以及未知工具均按写类处理。只读工具放行，当前职责本身的原生委派或独立执行器命令放行。PostToolUse 才记录满足：本机 CLI 要有本次任务之后的执行器证据、模型核实和退出 0；Claude 同步子代理仅在 tool_response.status 为 completed 时满足，其他状态不算完成，Codex spawn_agent 只记 agent_id，wait 收到 completed 才满足。Claude 的结构化 tool_response.isAsync === true 或 status === async_launched（文本 `Async agent launched successfully.` 保留作后备）只记进行中、agentId 和 tool_use_id。用户角色的 `<task-notification>`（会话 origin 为 `{kind: "task-notification", producer: "session-task"}`）、`<system-reminder>` 及 Codex `<subagent_notification>` 都按继续处理，不重新识别或清空待办。Claude 完成通知优先按 `<tool-use-id>` 匹配，其次按 `<task-id>` 等于 agentId 匹配，只有 `<status>completed</status>` 才满足（钩子输入无需 origin）；failed/killed/cancelled/canceled 记失败，缺失或未知状态继续等待，不以 summary 或 output-file 推测完成。Hook 将 tool_response.resolvedModel 记入状态，并提示总控最终答复采用该宿主字段，不采用子代理自报；与配置模型明显不符时提示，不拦截、不重试。状态标签及 completed 值已从本机 Claude Code 2.1.307 通知序列化实现核实。失败或未核实记录原因，不重试、不替换模型。开始时点名未结束或任何后台职责进行中时 Stop 放行、不消耗催办；前序结束后才催完成时点名，每项最多一次，stop_hook_active 时直接放行，防止循环。

Codex 沿用护栏的插件形式，生成 `.codex/named-dispatch-plugin/.codex-plugin/plugin.json` 和 `hooks/hooks.json`，并生成本地来源清单 `.codex/.agents/plugins/marketplace.json`：`{"name":"odai-local-routing","plugins":[{"name":"odai-named-dispatch","source":"./named-dispatch-plugin"}]}`。source 相对于来源根目录 `.codex/`。本机 codex-cli 0.163.0 在隔离 CODEX_HOME 下已成功登记来源并安装生成的插件，不调用模型。安装后的插件命令指向安装目录内脚本的绝对路径，插件复制到缓存后仍使用原清单；移动安装目录需要重新安装路由和插件。安装器不执行登记、安装或信任操作，也不放宽沙箱。

用户在安装路由后执行（项目路径须为真实绝对路径；用户级安装把来源改成对应配置目录）：

```sh
export CODEX_HOME="$(mktemp -d)"
codex plugin marketplace add /绝对路径/项目/.codex
codex plugin add odai-named-dispatch@odai-local-routing
```

保持同一 CODEX_HOME，在该临时项目中启动交互式 `codex`。如提示文件夹信任，审阅后选择 `Trust and continue`；在 `Hooks need review` 中选择 `Review hooks`，核对四个事件的命令确实指向已审阅的 `odai-route-hook.mjs`，再信任（`Trust` 或 `Trust all and continue`）。选择 `Continue without trusting` 时 Hook 不运行。以上选项来自本机二进制 UI 文本；本次没有执行交互式信任或模型请求。Hook 在信任后可在沙箱外运行，更新命令后须重新审阅。

本机依据：codex --help、codex plugin add --help、codex plugin marketplace add --help；codex-cli 二进制内的 user-prompt-submit/pre-tool-use/post-tool-use/stop.command.input/output schema。Claude Code 2.1.307 二进制的输入 schema、Hook 输出帮助与退出码说明明确 additionalContext 注入上下文、PreToolUse 退出 2 阻断工具，以及 Stop decision:block。agent_type 可出现在 --agent 主线程，只以 agent_id 区分子代理。仓库 integrations/hooks 提供两宿主的 Stop/PreToolUse 和插件格式先例。以上为静态契约依据，不代表真实宿主调用已验证。

卸载：`node skills/odai-orchestration/scripts/install-routing.mjs --host <claude|codex> --scope project --target <项目> --uninstall --yes`。也可用原映射参数更新且省略 `--named-dispatch` 和 `--lead-mode`，撤回路由 Hook，保留角色；Codex 另由用户卸载插件。

`--lead-mode` 安装主导能力后，说“开启主导模式”或“这个会话由 <已映射模型名> 主导”，用“关闭主导模式”退出；默认未开启。按宿主会话保存 `lead`（enabled、roles），新任务保留开关、清空任务进度，宿主通知只续作。只使用匹配的 planner/reviewer 插槽；缺失或不匹配时说明，不换模型。现有安装器仍要求 controller/planner/reviewer 映射；运行时兼容只含一个或缺少两个主导插槽的清单。

主导模式开启期间，每次 UserPromptSubmit 的直接用户任务都注入简短流程（开启时也注入）：第一次改动前先派规划，有改动时做完派审查，审查回交最后单独一行写 `VERDICT: pass` 或 `VERDICT: changes-requested`，最终答复按宿主记录说明实际模型。只讲已启用插槽对应的部分；宿主通知不注入流程。规划拦截在启用审查插槽时也带上结论格式，供总控提前派审查使用。

第一次写类工具前才生成 planner 请求，与同职责同开始时机的点名合并；后台进行中禁止抢写，Stop 不消耗审查催办。成功的非职责写类 PostToolUse 累计 `writes`，没有写入不自动审查；任意命令与未知工具仍保守视作写类。Stop 生成 reviewer 请求，与完成时点名合并，要求回交末行 VERDICT。同步取 content；后台只读取启动回执记录的 outputFile（支持文本或 assistant JSONL）；Codex 取 wait.completed；本机执行器取已核实证据的 output 文件或本次标准输出。缺少输出或结论冲突/无效时不追加轮次；下一次 Stop 拦一次，要求最终答复如实说明审查结论未按格式给出，以 invalidNudged 记录已提示。stop_hook_active 时放行且不消耗这次提示。共用解析器接受 Markdown、引号、全角冒号与句号，关键字不区分大小写，仍要求最后非空行是结论。

请求复用 done/result、inProgress、agentId、toolUseId、resolvedModel、nudged，审查另记 leadReview、round（0–2）、reviewWrites、handback、verdict、repairNudged。changes-requested 后下一次 Stop 催修正一次；有新的成功写入才再审，最多额外两轮。stop_hook_active 放行，不消耗催办；调用失败或主导审查模型不符只说明，不重试。用 `node --test scripts/lead-dispatch.test.mjs scripts/named-dispatch.test.mjs` 验证隔离夹具，不调用真实模型。
