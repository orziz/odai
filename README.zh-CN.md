<!-- Language toggle -->
[English](README.md) · **中文**

# odai

`odai` 是一套藏在单一入口后面的 AI 技能合集。你不用记一长串技能名，把活儿丢给 `odai` 就行——规划、设计、代码审查、写代码、写总结、游戏策划、游戏视觉设计，它都接。

入口里头有个叫 `道` 的调度员：先读懂你到底想干嘛，再挑模块、定产出（是给你一句短判断、一份草案、一张设计稿、一份审查结论、一张执行单，还是直接开干），信息不够就先问清楚再动手。

- **只想干活？** 一个入口：`odai`。
- **要维护这个仓库？** 另有 `skill-author` 工具，详见 [MAINTAINING.md](MAINTAINING.md)。

> `main` 分支装的是这套统一入口。想用更早的「一个能力一个技能」的旧结构，可以装 `old` 分支（见[如何安装](#如何安装)）。

## 30 秒上手

1. 把 `odai` 装进当前环境：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

（想装整个仓库、精简版或旧结构，见[如何安装](#如何安装)。）

2. 直接把任务交给 `odai`。第一句尽量带上三样：**目标**（想要什么）、**材料**（手上有什么）、**约束**（不能碰什么、必须满足什么）。说不清该走哪个模块也没关系，`道` 会先帮你判断。

3. 心里已经有数、想走哪条路也可以直接点名：

- 「用 `odai` 接这个需求，先判断该走哪个模块，拿不准就问我。」
- 「用 `odai` 走 `道`，先把边界和主路定下来。」
- 「用 `odai` 按 `harness-dev` 一路推进到结果总结。」
- 「用 `odai` 按 `review-sslb` 审这个 PR。」
- 「用 `odai` 用 `ribao` 整理今天的产出。」

## 这到底是个啥

可以把 `odai` 理解成一个「会自己分流的技能工具箱」：

- **对外只有一个门。** 你不用挑技能，`道` 替你判断这次该给一句短判断、一份草案、一张设计稿、一份审查结论、一张执行单，还是直接开干。
- **门后是一组分工明确的模块。** 规划、设计、审查、写代码、游戏策划、游戏视觉、写总结……需要哪个调哪个。
- **`道` 是默认的总调度。** 偏开发推进的活，还有一条 `harness-dev` 路线专门接到底。

几条值得先知道的事：

- 干活只认 `odai` 这一个入口；维护仓库用的是另一个工具 `skill-author`。
- 分发统一走 [skills.sh](https://skills.sh) 标准（`npx skills add`），canonical source 就在 `skills/` 下，不再有各端镜像产物。
- 旧的「多技能并列」结构已经搬到 `old` 分支，仍需要的话单独装。

## 适合谁用

符合下面任意一条，这个仓库就会比较顺手：

- 想把常用 prompt 和 workflow 收成一个入口，懒得记一串技能名
- 想让 AI 在规划、设计、审查、实现之间自己选路往下走
- 喜欢先让一个「调度员」定好方向、边界和第一步，再交给具体模块去做
- 想保留多种审查风格和 workflow，又不想维护一堆并排的安装入口
- 经常要整理 README、项目规则、AI 接手说明，或日报 / commit / PR 描述
- 想用 skills.sh 一条命令把入口接进任意 agent，不手动复制文件

## 如何安装

### 省事装法

只装统一入口（大多数人选这个）：

```bash
npx skills add https://github.com/orziz/odai --skill odai
```

适合：想快速把入口接进环境、不想手动复制一堆文件、平时直接用 `odai` 触发内部模块。

其他几种装法，按需选：

```bash
# 连同仓库里的其他技能一起装
npx skills add https://github.com/orziz/odai

# 更省 token 的精简版（mini 分支）
npx skills add https://github.com/orziz/odai#mini

# 旧的「多技能并列」结构（old 分支）
npx skills add https://github.com/orziz/odai#old
```

什么时候选 `old` 分支：你还在用旧入口、需要 `harness-dev` / `harness-dao` 等的独立安装方式，或者正在做旧结构的迁移对照。

## 怎么用更顺

`odai` 不是把所有模块机械串一遍，而是先由 `道` 判断你这次真正缺的是哪一层、该调哪个模块、该产出什么形态，再去读对应模块继续干。

内部有两条主线：

- **`道`**：默认调度。更适合「先定方向、边界、主路和第一步」，也负责挑模块、定产物形态。
- **`harness-dev`**：开发类的外层 workflow。更适合「接住开发需求、做诊断、判断怎么推进、然后一路往下做」。

也可以越过调度，直接点名单个模块：

- `game-plan`：游戏系统、玩法、数值、经济、商业、关卡与内容规划
- `game-design`：完整游戏视觉设计——UI/UX/UE、角色场景、宣传品牌、特效演出
- `feature-plan`：写规格、做方案取舍、诊断 bug
- `design-spec`：页面、交互、状态、视觉、体验说明
- `implement-code`：边界清楚后的写代码、修 bug、补测试、重构落地
- `project-guide`：README、项目规则、AI 接手基线
- `review-sslb`：三省六部式代码审查（旧的多种审查风格已并到这一个入口）
- `ribao`：日报、commit message、PR message

几个好用的触发示例：

- 「用 `odai` 接这个需求：先判断走哪个模块和产物形态，拿不准就问我。」
- 「用 `odai` 先用 `道` 把边界、主路和关键风险定下来，再往下推。」
- 「用 `odai` 按 `harness-dev` 处理这个实现问题，推进到结果总结。」
- 「用 `odai` 用 `project-guide` 整理这个仓库的 AI 接手基线。」

## 它怎么跟你打交道

那些会主动向你补关键信息的模块，默认都遵守一条交互约定（`skills/odai/references/dao/interaction-contract.md`）：

- 动手前先列清楚：当前理解、已经验证的事实、还没确认的点、必须你拍板的问题。
- 能用结构化提问就用结构化提问；通道不支持时，会说明限制后改成文字、成组地问。
- 收到你的回答后，默认直接接着干当前这一步，不会再等你补一句「继续」。

## 效果展示

![效果展示 1](./assets/image_0.png)
![效果展示 2](./assets/image_1.png)

## 参考与致谢

部分命名方式、组织思路和玩法形式参考过下面这些项目，在此一并致谢：

- [cft0808/edict](https://github.com/cft0808/edict)
- [wanikua/danghuangshang](https://github.com/wanikua/danghuangshang)

欢迎 star，也欢迎提 PR 一起补充更好用的 skill 和 workflow。
