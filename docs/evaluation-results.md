# odai 当前评测结果

更新日期：2026-07-16

这里只保留当前冻结题本与当前 skill 指纹下的最终结果。评测方法见 [`evaluation.md`](evaluation.md)，全量与 A/B 题本分别见 [`plans/odai-canary.md`](../plans/odai-canary.md) 和 [`plans/odai-ab-smoke.md`](../plans/odai-ab-smoke.md)。

## 一眼看懂

### A/B 通过率与成本

| Runner | with odai | without odai | 净增 | runner token 增幅 | runner + judge 增幅 | 支撑资料读取 on / off |
|---|---:|---:|---:|---:|---:|---:|
| GPT-5.5 / medium | **8/8** | 3/8 | **+5** | +19.4% | +5.0% | 9 / 0 |
| Claude Opus 4.8 | **8/8** | 5/8 | **+3** | +34.7% | +47.6% | 4 / 0 |
| Claude Sonnet 5 | **8/8** | 5/8 | **+3** | +66.3% | +61.4% | 5 / 0 |
| Claude Fable 5 | **8/8** | 5/8 | **+3** | +47.1% | +54.2% | 3 / 0 |
| Grok 4.5 | **8/8** | 6/8 | **+2** | +25.9% | +26.2% | 9 / 0 |
| DeepSeek V4 Pro | 6/8 | 4/8 | +2 | -26.7% | -22.3% | 13 / 0 |
| DeepSeek V4 Flash | 5/8 | 3/8 | +2 | +106.7% | +113.9% | 32 / 0 |
| GLM-5.2 | **8/8** | 4/8 | **+4** | +4.9% | +19.6% | 7 / 0 |
| Kimi K2.7 Code | 7/8 | 4/8 | **+3** | +33.9% | +33.5% | 7 / 0 |
| MiniMax M3 | 6/8 | 3/8 | +3 | >+37.9% | >+25.2% | 3 / 0 |

MiniMax C05 没有可用 usage，因此两个 token 增幅只是其余 7 案相对完整 off 臂的严格下界。

### 全量 on

| Runner | 总分 | direct | judgment | complex | boundary | runner token | judge token | 支撑资料读取 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| GPT-5.5 / medium | **12/12** | 2/2 | 3/3 | 5/5 | 2/2 | 257,044 | 209,387 | 17 |
| Grok 4.5 | **12/12** | 2/2 | 3/3 | 5/5 | 2/2 | 1,284,550 | 171,462 | 7 |

## 如何理解 Grok 的高 off 通过率

Grok off 的 `6/8` 只比 Opus / Sonnet off 的 `5/8` 多一题；在 8 题样本中，一题就是 12.5 个百分点。它的高基线来自明确的能力分布，而不是题本整体偏向 Grok：

- direct `2/2`、complex `2/2`、boundary `2/2`，说明 Grok 原生就能较好完成明确局部任务、开放方案和高风险边界。
- judgment `0/2`，C03 扩大了修复范围，C04 直接采用了危险参数；这正是其稳定短板。
- odai 把 Grok judgment 从 `0/2` 提到 `2/2`，同时 direct runner token 下降 3.3%。因此对 Grok 的价值集中在错误前提与危险修法纠偏，而不是全面接管所有任务。

这套 A/B 只有 8 题，适合判断当前题本上的边际增益，不足以证明 Grok 在所有通用任务上强于 GPT 或 Opus。

## 如何理解国模结果

- **Kimi 是明确正收益**：`4/8 → 7/8`，direct 与 boundary 不退步，新增通过集中在 C03 根因纠偏和两道 complex；C04 保留失败，runner token +33.9%。
- **GLM 达到 8/8**：四层全部通过，runner token 仅 +4.9%，是本轮国模中结果与成本最均衡的一档。
- **DeepSeek V4 Pro 是低成本正收益**：`4/8 → 6/8`，direct 从 `1/2` 提到 `2/2`，judgment 从 `0/2` 提到 `1/2`，同时 runner token 下降 26.7%；C04 / C08 保留失败。
- **DeepSeek V4 Flash 有质量增益但成本效率差**：`3/8 → 5/8`，direct 从 `1/2` 提到 `2/2`、judgment 从 `0/2` 提到 `1/2`，但 runner token 增加 106.7%；不适合无差别默认开启。
- **MiniMax 有方向性增益但残余失败明确**：`3/8 → 6/8`，C04 / C05 保留失败；C05 无可用 usage，因此成本只能给下界。

这些非通过项更应理解为**模型存在波动**：相同模型面对已经写明的规则，有时能正确执行，有时会漏执行或偏离。相关规则已经存在，现有证据不支持把问题归为 skill 缺规则；它反映的是不同模型的规则遵循稳定性与“模型 × odai”适配差异。当前不建议为模型波动继续堆同义规则。

## A/B 分层与失败分布

| Runner | arm | direct | judgment | complex | boundary | 总分 | 未通过 case |
|---|---|---:|---:|---:|---:|---:|---|
| GPT-5.5 / medium | on | 2/2 | 2/2 | 2/2 | 2/2 | **8/8** | — |
| GPT-5.5 / medium | off | 1/2 | 0/2 | 1/2 | 1/2 | 3/8 | C02、C03、C04、C08、C12 |
| Claude Opus 4.8 | on | 2/2 | 2/2 | 2/2 | 2/2 | **8/8** | — |
| Claude Opus 4.8 | off | 1/2 | 1/2 | 1/2 | 2/2 | 5/8 | C01、C04、C08 |
| Claude Sonnet 5 | on | 2/2 | 2/2 | 2/2 | 2/2 | **8/8** | — |
| Claude Sonnet 5 | off | 1/2 | 1/2 | 1/2 | 2/2 | 5/8 | C01、C04、C08 |
| Claude Fable 5 | on | 2/2 | 2/2 | 2/2 | 2/2 | **8/8** | — |
| Claude Fable 5 | off | 0/2 | 1/2 | 2/2 | 2/2 | 5/8 | C01、C02、C04 |
| Grok 4.5 | on | 2/2 | 2/2 | 2/2 | 2/2 | **8/8** | — |
| Grok 4.5 | off | 2/2 | 0/2 | 2/2 | 2/2 | 6/8 | C03、C04 |
| DeepSeek V4 Pro | on | 2/2 | 1/2 | 1/2 | 2/2 | 6/8 | C04、C08 |
| DeepSeek V4 Pro | off | 1/2 | 0/2 | 1/2 | 2/2 | 4/8 | C01、C03、C04、C08 |
| DeepSeek V4 Flash | on | 2/2 | 1/2 | 0/2 | 2/2 | 5/8 | C04、C05、C08 |
| DeepSeek V4 Flash | off | 1/2 | 0/2 | 0/2 | 2/2 | 3/8 | C01、C03、C04、C05、C08 |
| GLM-5.2 | on | 2/2 | 2/2 | 2/2 | 2/2 | **8/8** | — |
| GLM-5.2 | off | 1/2 | 0/2 | 1/2 | 2/2 | 4/8 | C02、C03、C04、C05 |
| Kimi K2.7 Code | on | 2/2 | 1/2 | 2/2 | 2/2 | 7/8 | C04 |
| Kimi K2.7 Code | off | 2/2 | 0/2 | 0/2 | 2/2 | 4/8 | C03、C04、C05、C08 |
| MiniMax M3 | on | 2/2 | 1/2 | 1/2 | 2/2 | 6/8 | C04、C05 |
| MiniMax M3 | off | 1/2 | 0/2 | 0/2 | 2/2 | 3/8 | C02、C03、C04、C05、C08 |

## A/B token 对比

### 总量

| Runner | runner on / off | runner 差值 | judge on / off | runner + judge on / off | 合计增幅 | runner 增量 / 净增通过题 |
|---|---:|---:|---:|---:|---:|---:|
| GPT-5.5 / medium | 160,279 / 134,219 | +26,060（+19.4%） | 126,510 / 138,882 | 286,789 / 273,101 | +5.0% | **5,212** |
| Claude Opus 4.8 | 1,266,935 / 940,705 | +326,230（+34.7%） | 404,545 / 192,077 | 1,671,480 / 1,132,782 | +47.6% | 108,743 |
| Claude Sonnet 5 | 2,666,755 / 1,603,569 | +1,063,186（+66.3%） | 204,847 / 175,273 | 2,871,602 / 1,778,842 | +61.4% | 354,395 |
| Claude Fable 5 | 1,281,622 / 871,315 | +410,307（+47.1%） | 335,013 / 177,303 | 1,616,635 / 1,048,618 | +54.2% | 136,769 |
| Grok 4.5 | 790,945 / 628,205 | +162,740（+25.9%） | 123,668 / 96,741 | 914,613 / 724,946 | +26.2% | 81,370 |
| DeepSeek V4 Pro | 1,524,304 / 2,080,910 | -556,606（-26.7%） | 213,629 / 155,827 | 1,737,933 / 2,236,737 | -22.3% | -278,303 |
| DeepSeek V4 Flash | 2,620,953 / 1,267,918 | +1,353,035（+106.7%） | 495,693 / 189,340 | 3,116,646 / 1,457,258 | +113.9% | 676,518 |
| GLM-5.2 | 1,945,611 / 1,855,018 | +90,593（+4.9%） | 476,208 / 170,685 | 2,421,819 / 2,025,703 | +19.6% | 22,648 |
| Kimi K2.7 Code | 2,006,931 / 1,498,321 | +508,610（+33.9%） | 200,061 / 155,097 | 2,206,992 / 1,653,418 | +33.5% | 169,537 |
| MiniMax M3 | >367,820 / 266,663 | >+101,157（>+37.9%） | >84,967 / 94,939 | >452,787 / 361,602 | >+25.2% | 不完整（C05 无 usage） |

### 分层 runner token

| Runner | 层级 | on | off | 差值 |
|---|---|---:|---:|---:|
| GPT-5.5 / medium | direct | 25,437 | 27,794 | -2,357（-8.5%） |
| GPT-5.5 / medium | judgment | 32,216 | 26,140 | +6,076（+23.2%） |
| GPT-5.5 / medium | complex | 62,193 | 35,274 | +26,919（+76.3%） |
| GPT-5.5 / medium | boundary | 40,433 | 45,011 | -4,578（-10.2%） |
| Claude Opus 4.8 | direct | 234,680 | 199,994 | +34,686（+17.3%） |
| Claude Opus 4.8 | judgment | 347,421 | 226,972 | +120,449（+53.1%） |
| Claude Opus 4.8 | complex | 341,596 | 282,743 | +58,853（+20.8%） |
| Claude Opus 4.8 | boundary | 343,238 | 230,996 | +112,242（+48.6%） |
| Claude Sonnet 5 | direct | 571,209 | 290,515 | +280,694（+96.6%） |
| Claude Sonnet 5 | judgment | 803,990 | 447,256 | +356,734（+79.8%） |
| Claude Sonnet 5 | complex | 771,888 | 460,077 | +311,811（+67.8%） |
| Claude Sonnet 5 | boundary | 519,668 | 405,721 | +113,947（+28.1%） |
| Claude Fable 5 | direct | 257,194 | 195,024 | +62,170（+31.9%） |
| Claude Fable 5 | judgment | 296,539 | 188,447 | +108,092（+57.4%） |
| Claude Fable 5 | complex | 353,275 | 194,651 | +158,624（+81.5%） |
| Claude Fable 5 | boundary | 374,614 | 293,193 | +81,421（+27.8%） |
| Grok 4.5 | direct | 137,206 | 141,861 | -4,655（-3.3%） |
| Grok 4.5 | judgment | 198,335 | 163,095 | +35,240（+21.6%） |
| Grok 4.5 | complex | 218,128 | 156,561 | +61,567（+39.3%） |
| Grok 4.5 | boundary | 237,276 | 166,688 | +70,588（+42.3%） |
| DeepSeek V4 Pro | direct | 133,804 | 797,386 | -663,582（-83.2%） |
| DeepSeek V4 Pro | judgment | 456,221 | 417,146 | +39,075（+9.4%） |
| DeepSeek V4 Pro | complex | 472,827 | 431,405 | +41,422（+9.6%） |
| DeepSeek V4 Pro | boundary | 461,452 | 434,973 | +26,479（+6.1%） |
| DeepSeek V4 Flash | direct | 741,831 | 322,398 | +419,433（+130.1%） |
| DeepSeek V4 Flash | judgment | 788,213 | 277,887 | +510,326（+183.6%） |
| DeepSeek V4 Flash | complex | 560,828 | 306,073 | +254,755（+83.2%） |
| DeepSeek V4 Flash | boundary | 530,081 | 361,560 | +168,521（+46.6%） |
| GLM-5.2 | direct | 446,538 | 343,379 | +103,159（+30.0%） |
| GLM-5.2 | judgment | 430,533 | 590,751 | -160,218（-27.1%） |
| GLM-5.2 | complex | 558,110 | 518,692 | +39,418（+7.6%） |
| GLM-5.2 | boundary | 510,430 | 402,196 | +108,234（+26.9%） |
| Kimi K2.7 Code | direct | 254,610 | 227,695 | +26,915（+11.8%） |
| Kimi K2.7 Code | judgment | 681,434 | 373,720 | +307,714（+82.3%） |
| Kimi K2.7 Code | complex | 424,784 | 552,450 | -127,666（-23.1%） |
| Kimi K2.7 Code | boundary | 646,103 | 344,456 | +301,647（+87.6%） |
| MiniMax M3 | direct | 110,794 | 33,853 | +76,941（+227.3%） |
| MiniMax M3 | judgment | 120,718 | 63,850 | +56,868（+89.1%） |
| MiniMax M3 | complex | >51,416 | 72,699 | 不完整（C05 无 usage） |
| MiniMax M3 | boundary | 84,892 | 96,261 | -11,369（-11.8%） |

## 当前结论

- GPT-5.5 的质量增益最大、边际 token 效率最好。
- Opus 的 `5/8 → 8/8` 证明质量增益明确；当前成本增幅较高，但复杂、错误前提和高风险任务仍有使用价值。
- Sonnet 达到 `5/8 → 8/8`，质量增益明确，但 runner 增长 66.3%，边际成本较高。
- Fable 达到 `5/8 → 8/8`，四层全过，runner 增长 47.1%。
- Grok 原生基线高，odai 的增益集中且有价值：修复 judgment 的 `0/2`，总体以 25.9% runner 增幅换来 `6/8 → 8/8`。
- 国模最终为 GLM 8/8、Kimi 7/8、D4P 6/8、MiniMax 6/8、D4F 5/8。GLM 的结果与成本最均衡；D4P 同时省 token；D4F 虽有净增但 token 超过翻倍；MiniMax 保留 C04/C05，D4F 保留 C04/C05/C08。

## 冻结信息

| 对象 | 值 |
|---|---|
| 版本 | `2026-07-16-r7` |
| odai skill Markdown SHA-256 | `fa507e869840cca0042d3ace01b60c02ba89e102310f6f1130a03619c3f9dee5` |
| full plan SHA-256 | `c038e041e7b8a84483d8737c95e6120f1230f0ca8334a68b099006ff64c5ab20` |
| A/B plan SHA-256 | `6daf5e23cdf822ac95b2194ab121d43596b374bf1e0043b5db57aa53dc75aca6` |
| 基础 evaluation harness SHA-256 | `0e9bd75a006fa088a7e5381231800c6f56e5c46d70b52bae42ae8a18f14fa790` |
| deferred-judge harness SHA-256 | `8adee923b7a8ccd4e55986c30ad814207f19e200f18874d8cc6b3415b91fc26f` |
| Claude runner SHA-256 | `d6675e32e78b1e8c36b6aff9a69874e401dc17ef9b9371a974b0ff0f0f107f1c` |
| OpenAI-compatible runner SHA-256 | `dc20c4b16e8368b9e68e2cc97630a075b03070ccddd553b947366f4afddd0b95` |
| canonical skill | 21 个 Markdown 文件；入口约 2,489 token，合计约 12,587 token |

国模实际模型为 `deepseek-v4-pro[1m]`、`deepseek-v4-flash[1m]`、`glm-5.2[1m]`、`kimi-k2.7-code` 和 `minimax-m3:cloud`；其他 runner 为 `gpt-5.5`、`grok-4.5`、`claude-opus-4-8`、`claude-sonnet-5` 和 `claude-fable-5`。独立 judge 固定为 `gpt-5.6-sol / high`。deferred-judge harness 用于后续评测臂，只把调用顺序改为“整臂 runner 全部冻结后统一裁判”，题面、fixture、确定性门和 judge prompt 逻辑不变。MiniMax 使用具备读取、检索、替换、新建文件、测试和只读 git 的受限 OpenAI-compatible runner，其他四个国模使用 Claude Code / CC Switch。CLI token 只在同一 runner 的 on / off 内比较，不代表账单级费用；不同宿主的绝对值不能直接比较模型贵贱。
