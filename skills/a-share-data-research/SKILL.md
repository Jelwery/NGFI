---
name: a-share-data-research
description: 查询与研究中国 A 股数据。用户询问沪深北股票、ETF 或指数的证券代码规范化、实时/历史行情、K 线、财务报表与指标、公司行动、公告、研报与一致预期、资金流/龙虎榜/两融/大宗/涨停异动、指数成分与估值、交易日历或中国宏观数据时使用；也适用于要求按历史时点、报告期或公告日核验 A 股事实的请求。长尾能力仅在 catalog 显示已映射且可路由时取数。只做可审计的数据研究，不提供个性化投资建议。
---

# A 股数据研究

用最少的 curated 工具形成可追溯证据链。不要调用原始上游端点，也不要在 Skill 中实现抓取。
稳定工具清单依次为：`finance_data_catalog`、`finance_cn_instrument`、`finance_cn_quote`、`finance_cn_bars`、`finance_cn_fundamentals`、`finance_cn_disclosures`、`finance_cn_market_activity`、`finance_cn_macro_index`；清单顺序不改变下述 normalize-first 执行规则。稳定 surface 只承诺受控参数和 canonical 结果，不承诺每个 capability 默认都有可用 provider。

## 工作流

1. **先规范化证券代码。** 涉及证券时先调用 `finance_cn_instrument`，把六位证券代码、带交易所前后缀的代码或 canonical identifier 解析成 canonical instrument；该工具当前不支持中文证券名称查询。对 `000001`、`000300` 等歧义输入先确认交易所与资产类型；显式前后缀冲突时停止并请用户澄清，不能猜。纯宏观或交易日历查询可跳过此步。
2. **按问题选择工具。** 优先使用最窄的工具组合：
   - 能力、来源、健康或权限：`finance_data_catalog`
   - 证券身份：`finance_cn_instrument`
   - 当前 quote，或指定 `as_of` 的历史稳定快照：`finance_cn_quote`。历史结果由目标日单日 `1d`、`adjustment: none` bars 映射，保留实际 bars provenance；它不是历史实时 quote 或历史盘口，休市日不回填
   - 历史日 K：`finance_cn_bars`
   - 三表/财务指标：`finance_cn_fundamentals`；用 `report_period` 或成对的 `start_date`/`end_date` 选择期间，顶层 provenance 必须对应最终所选期间；其 `corporate-actions` 只是受控稳定 surface，先按第 3 步核验
   - 公告：`finance_cn_disclosures`；其 `research-consensus` 只是受控稳定 surface，先按第 3 步核验
   - `capital-flow`、`market-signal`、`order-book` 的受控稳定 surface：`finance_cn_market_activity`，先按第 3 步核验
   - 指数和交易日历：`finance_cn_macro_index`；其 `macro` 只是受控稳定 surface，先按第 3 步核验
3. **先核验长尾 capability。** `corporate-actions`、`research-consensus`、`capital-flow`、`market-signal`、`order-book` 和 `macro` 是受控稳定 surface，但当前没有默认 routable provider，不能计作已经实现的数据 capability。只有 catalog 明确返回 capability 映射、`routable: true` 且 health/权限合格时才能调用；当前默认组合会返回 canonical `unsupported`。已有映射但当前不可路由或不健康时保留 catalog/路由的 `unavailable` 诊断。
4. **选择来源。** 默认 `source: auto`。当前注册表只有一套全局静态 priority，不能为每个 capability 单独排序；共同能力的实际顺序为 TuShare → CNE6 local/PIT fallback → TDX community → public。因此 `market-bars` 按此四级候选，`fundamentals` 为 TuShare → CNE6 → public；不支持目标 capability、未配置或不可路由的 provider 不进入候选。只把 catalog 返回的 approved provider id 传给 `source`，网站/数据接口名称保留为 `upstreamSource`。仅 `source: auto` 可自动 fallback；用户显式指定 provider 时保留该来源及失败状态，可建议替代来源，但未经用户同意不实际换源。详细路由见 [capability-routing.md](references/capability-routing.md)。
5. **控制范围。** 带 `page` 的工具只传省略值或 `page: 1`；`page > 1` 会被拒绝。单次范围过大或结果受 limit 截断时，缩窄日期或拆成多个不重叠日期范围查询，不猜测 cursor。
6. **核对语义再比较。** 统一证券、目标交易日或 as-of、`Asia/Shanghai` 时区、价格复权、币种、单位、报告期、合并口径、公告日/发布时间与 `available_date`。历史时点只能使用当时已可见的信息，避免未来函数。
7. **报告证据质量。** 保留 field status、requested/actual provider、source kind、观察/抓取/发布/可见时间、warnings、limitations 和 fallback chain。区分 canonical `unsupported`（无 capability 映射）、catalog/路由 `unavailable`（已知 provider 当前不可路由或不健康）、`unauthorized`/`insufficient-permission`（鉴权或权限受阻）与 canonical `no-data`（合格查询完成但无记录）；这些状态以及错误、过期或 partial 都不能写成零。详细纪律见 [source-policy.md](references/source-policy.md)。

## 回答边界

- fallback 必须披露实际来源、失败原因和质量降级。数据冲突时先核对口径，再并列各值及 provenance；不要静默平均，也不要挑选更支持某结论的值。
- 公告与研究结论以实际读取的正文为准；snippet 或新闻摘要不能冒充公告正文。
- 若所需 provider 返回 `unauthorized`、`insufficient-permission` 或 TuShare 的 `insufficient-points`，将其与 `no-data` 区分，说明受阻的能力和仍可用的较低层级来源；仅在用户要求该来源或无合格替代时，请用户补充对应账号、套餐、积分或权限。不要索取或复述任何秘密凭据。
- 输出数据事实、口径、局限与可复核的解释，不提供个性化投资建议，不给买卖、仓位或收益保证。价格路径、成交或资金流不能据此证明个体心理状态、FOMO、羊群或泡沫。
