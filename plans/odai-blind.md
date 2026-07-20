# odai 匿名横评计划

本计划定义同类 skill 匿名横评的运行方式。默认五题 fixture 和确定性门禁在 [`odai-blind-cases.json`](odai-blind-cases.json)，执行器是 [`scripts/odai-blind-harness.mjs`](../scripts/odai-blind-harness.mjs)。本计划只维护横评协议，单次结果留在对应输出目录，不并入当前全量 / A/B 结果。

## 运行纪律

- 默认只做 dry-run：校验候选、创建隔离 fixture、冻结匿名顺序并写出协议，不调用模型。
- 每个 runner cell 只保留一次有效行为输出；不得因结果不好而重跑。
- runner 全部冻结后才启动匿名裁判。
- 只有裁判基础设施失败且没有有效裁决时，才可用 `--judge-only` 续裁；不得借机重跑 runner。
- 正式口径以输出目录中的 `protocol.json` 为准，报告不得混算不同候选集或不同裁判批次。

## 准备候选与 fixture

```bash
node scripts/odai-blind-harness.mjs \
  --arm bare \
  --arm odai=skills/odai \
  --arm boluo="$HOME/Downloads/菠萝吹雪.skill" \
  --out /private/tmp/odai-blind-next
```

`--arm bare` 表示无 skill 基线；`--arm NAME=PATH` 可指向单个含 `SKILL.md` 的目录，也可指向包含多个 skill 的仓库，脚本会递归发现技能目录。

`--arm NAME=bare` 用于保留某个匿名候选席位，但明确记录该体系对当前 case 没有对应 skill。比较非统一技能集时，应按 case 只提供候选自己声明适用的最小 skill 或组合；不得把整个工具箱塞给 runner 碰运气。

## 当前同类横评候选

- odai：运行时 canonical `skills/odai`。
- obra/superpowers：`d884ae04edebef577e82ff7c4e143debd0bbec99`。
- mattpocock/skills：`9603c1cc8118d08bc1b3bf34cf714f62178dea3b`。
- NeoLabHQ/context-engineering-kit：`a0bfff1938624ee71b9eeba641d77729ab4f84f6`。
- bare：不提供候选 skill，只保留相同宿主与模型能力。

非统一技能集按 case 匹配如下；空缺表示该体系没有直接对应 skill，以具名 bare 席位参赛：

| Case | odai | Superpowers | mattpocock/skills | Context Kit |
|---|---|---|---|---|
| C1 精确局部修改 | `odai` | `verification-before-completion` | `code-review`、`implement`、`tdd` | `implement-task`、`test-driven-development` |
| C2 主观反馈无基线 | `odai` | `brainstorming` | `grill-me`、`grilling` | `brainstorm` |
| C3 用户给错根因与修法 | `odai` | `systematic-debugging`、`test-driven-development`、`verification-before-completion` | `diagnosing-bugs`、`tdd` | `root-cause-tracing`、`test-driven-development` |
| C4 生产授权边界 | `odai` | — | — | — |
| C5 验收真实性 | `odai` | `verification-before-completion` | — | — |

映射只依据各候选 skill 的公开描述冻结，不得根据运行结果增删技能。

检查以下 dry-run 产物：

- `protocol.json`：候选、模型、用例、skill 指纹和运行参数。
- `private-mapping.json`：由 `--seed` 冻结的逐题匿名顺序。
- `prompts/`：runner 输入。
- `cells/`：已提交 baseline 的隔离 fixture。

## 执行已准备样本

```bash
node scripts/odai-blind-harness.mjs \
  --run-prepared \
  --out /private/tmp/odai-blind-next
```

也可以在首次命令直接加 `--run`，跳过人工检查 dry-run 产物。只冻结 runner、不启动裁判时加 `--no-judge`。

## 只重跑裁判

runner 已全部有效冻结、只有裁判发生基础设施失败时：

```bash
node scripts/odai-blind-harness.mjs \
  --judge-only \
  --out /private/tmp/odai-blind-next
```

`--judge-only` 读取现有 `record.json`，不会重新执行候选。

只需根据冻结 runner 与既有裁决重建统计和报告时：

```bash
node scripts/odai-blind-harness.mjs \
  --report-only \
  --out /private/tmp/odai-blind-next
```

`--report-only` 不调用 runner 或 judge。runner token 按 CLI 的 `input_tokens + output_tokens` 统计；`cached_input_tokens` 是 input 的子集，不重复相加。

## 常用参数

- `--cases C1,C4`：只选择部分 case。
- `--seed VALUE`：固定匿名排列。
- `--concurrency N`：runner 并发数。
- `--runner-model` / `--runner-effort`：runner 模型与 reasoning effort。
- `--judge-model` / `--judge-effort`：judge 模型与 reasoning effort。
- `--report-only`：用既有 runner 与裁决重建统计，不调用模型。
- `--timeout` / `--judge-timeout`：单格超时秒数。
- `--runner-sandbox`：runner sandbox。
- `--codex-command`：指定 Codex 可执行文件。

最终 `summary.json` 和 `report.md` 给出总分、通过数、逐题结果与 token；完整 runner 记录在 `runs/`，匿名裁判提示和裁决在 `judge-work/`。
