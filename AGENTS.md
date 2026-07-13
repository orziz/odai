# 仓库维护约束

## odai skill 单一事实源

- `skills/odai/` 是唯一可编辑的 canonical source。
- `cli/skills/` 不在仓库中常驻；它只由 npm `prepack` 临时生成，并在 `postpack` 清理。
- 即使用户或 IDE 指向打包期间临时出现的 `cli/skills/odai/`，也要把对应修改落到 `skills/odai/`。
- source 修改完成后，运行 `node scripts/validate-odai-skill.mjs` 验证 canonical skill。
- 发布相关修改还需运行 `npm --prefix cli run pack:dry-run`，确认产物包含 bundled `skills/odai`，且命令结束后没有遗留 `cli/skills/`。
