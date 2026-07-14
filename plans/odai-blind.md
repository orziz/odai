# odai 匿名横评计划

本计划定义同类 skill 匿名横评的运行方式。默认五题 fixture 和确定性门禁在 [`odai-blind-cases.json`](odai-blind-cases.json)，执行器是 [`scripts/odai-blind-harness.mjs`](../scripts/odai-blind-harness.mjs)。稳定结果与结论边界见 [`docs/evaluation.md`](../docs/evaluation.md)。

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

## 常用参数

- `--cases C1,C4`：只选择部分 case。
- `--seed VALUE`：固定匿名排列。
- `--concurrency N`：runner 并发数。
- `--runner-model` / `--runner-effort`：runner 模型与 reasoning effort。
- `--judge-model` / `--judge-effort`：judge 模型与 reasoning effort。
- `--timeout` / `--judge-timeout`：单格超时秒数。
- `--runner-sandbox`：runner sandbox。
- `--codex-command`：指定 Codex 可执行文件。

最终 `summary.json` 和 `report.md` 给出总分、通过数、逐题结果与 token；完整 runner 记录在 `runs/`，匿名裁判提示和裁决在 `judge-work/`。
