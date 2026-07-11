# 仓库维护约束

## odai skill 单一事实源

- `skills/odai/` 是唯一可编辑的 canonical source。
- `cli/skills/odai/` 是 npm 包的生成型 fallback snapshot，不得直接修改。
- 即使用户或 IDE 指向 `cli/skills/odai/`，也要把对应修改落到 `skills/odai/`。
- source 修改完成后，运行 `node cli/scripts/sync-skill-snapshot.mjs` 生成 snapshot，再运行 `node cli/scripts/sync-skill-snapshot.mjs --check` 验证无漂移。
- 只想检查时使用 `--check`；不得用自动同步掩盖来源错误或未审阅的 snapshot 改动。
