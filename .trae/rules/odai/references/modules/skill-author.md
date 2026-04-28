---
name: skill-author
description: 纳既定能力为内模块源
scenario: 新增、改写、补骨架、沉淀提示或流程
---

此模块司标准源。务在将既定能力纳入 odai，不别起第二外部 skill。所落者，当为标准模块源 `odai/references/modules/<module-name>.md` 与必要 support files。

用户所述未必齐整。须先收束目标模块/新旧关系/名称/类型/落盘路径/support files 范围；凡未定，列为待确认，不得暗自拍板。

定位：此模块只司标准源。可创建或更新 skills/odai/ 下之模块源，但不司多端同步、镜像分发或 README 回写。

## 最小工作骨架

```text
目标模块：
今断：新增 | 修改 | 更名 | 补骨架
待确认名称：
类型判断：普通 | review | workflow | script-wrapper
源文件：
support files：
今判：
边界与禁区：
待定：
次步：
```

## 裁断

1. 用户明言“新增”或“修改”，先采之；惟与仓库现状相冲，乃回问。
2. 已有同名或近似模块者，先续改旧稿，不轻拆新入口。
3. 既有文件、模块名、草稿或路径者，循其旧锚推进。
4. 名称/类型/路径/support files 范围/覆盖影响/真实意图有疑，即低成本发问。
5. 大删、大覆、大更名，先与用户对齐。

## 名与类

1. 新模块默认用小写 kebab-case；优先沿既有命名轴：dao、feature-*、design-*、implement-*、project-*、review-*、skill-*、harness-*。
2. 文案可称“道”，惟模块 id、frontmatter name 与文件名仍用 dao。
3. frontmatter 至少有 name、description；需路由或说明时，再加 scenario。
4. Claude wrapper 元数据只认标准源 frontmatter 明写之字段；当前 skill-sync 识别 claude-allowed-tools、claude-argument-hint。
5. 先断类型，再定写法：
   - 普通：单角、一次性输出、无状态流。
   - review：重范围、证据、严重度与裁决。
   - workflow：重阶段、状态与继续推进。
   - script-wrapper：脚本为真执行体，模块只司收参与触发。
6. 能轻则轻，不为虚整而添重模板。

## 落盘

1. canonical 路径默认是 odai/references/modules/<module-name>.md；第一版即应落真实源文件，不只停于聊天草稿。
2. 后续续写同一源稿，不开平行版本；若是改旧模块，即直改旧源稿。
3. 可借近似模块骨架，惟只取相关之节，不机械照抄。
4. 模块正文只写本模块运行时真规则；入口、README、dao playbook、terminology、skill-sync 等已定全局口径，优先引用，不复重抄。
5. odai/references/<module-name>/ 存长规则；assets/<module-name>/ 存模板；scripts/<module-name>/ 仅在脚本真为执行依据时设。
6. 不空建目录，不把应由脚本稳定完成之事改写成模型手工流程。
7. 未经确认之扩展，只得写成建议或待定项。
8. 用户既曰“做”，即直改标准源。

## 提问与边界

1. 目标/名称/类型/路径/support files 范围/覆盖影响/真实意图有疑，皆须问。
2. 先报已知、未定与所问，不偷替用户定案。
3. 可用结构化提问时，即调用宿主提问工具；不可用，则先明言，再改文字问答；得答后径行。
4. 本模块默认不做 .claude、.github、.trae 与 README 安装同步；若需同步，应在标准源定稳后转入 skill-sync。

## 可直行之事

1. 搜现有模块、README 与相近源稿。
2. 创建或更新 odai/references/modules/<module-name>.md。
3. 视需增改 odai/references/<module-name>/、assets/<module-name>/、scripts/<module-name>/。
4. 回写边界、类型、命名、正文结构与 support file 关系。
