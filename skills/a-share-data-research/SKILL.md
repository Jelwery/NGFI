---
name: a-share-data-research
description: 查询与研究中国 A 股数据。覆盖沪深北股票、ETF、指数的身份、行情、K 线、盘口、逐笔、财务、公司行动、公告、研报、资金流、市场异动、期权、宏观和指数数据。60 项上游能力均通过 8 个 curated tools 的闭合 feature/dataset enum 暴露；iWenCai 是唯一可选鉴权能力。只做可审计的数据研究，不提供交易、账户、下单或个性化投资建议。
---

# A 股数据研究

只使用以下 8 个 curated tools：`finance_data_catalog`、`finance_cn_instrument`、`finance_cn_quote`、`finance_cn_bars`、`finance_cn_fundamentals`、`finance_cn_disclosures`、`finance_cn_market_activity`、`finance_cn_macro_index`。不要调用上游 Python 函数、raw MCP、任意 URL、shell、SQL，也不要在 Skill 中实现抓取。

## 工作流

1. **先规范化证券。** 涉及证券时先用 `finance_cn_instrument` 把六位代码、`sh600519`、`600519.SH` 或 canonical identifier 转为 canonical instrument。`000001`、`000300` 等歧义码要明确交易所与资产类型；前后缀冲突必须报错。纯宏观、全市场榜单和交易日历不要求虚构证券身份。
2. **先查 catalog 再选择 feature。** `finance_data_catalog` 可按 `feature` 过滤，并返回 capability、callable、tool、dataset、source chain、auth、contract tier、PIT grade、限制和 live health。`implemented-*` 只表示实现已映射；实时可用性以 health/live probe 为准。
3. **使用最窄的工具与闭合 enum。**
   - 身份、公司资料、上市状态、概念和申万行业：`finance_cn_instrument`。
   - 腾讯/TDX/BSE quote：`finance_cn_quote`；历史 `as_of` 仍是目标日未复权日线派生快照，不是历史实时盘口。
   - 日/分钟 K、百度 MA、复权因子和复权行情：`finance_cn_bars`。
   - 三表、TDX 财务/F10、估值历史、解禁、股东户数和分红：`finance_cn_fundamentals`。
   - 公告、研报/PDF、一致预期、iWenCai、新闻、电报和互动易：`finance_cn_disclosures`。
   - 盘口/逐笔、资金流、龙虎榜、两融、大宗、涨跌停、异动、热榜、期权和官方备份：`finance_cn_market_activity`。
   - 社融、PMI、指数成分/权重/估值和交易日历：`finance_cn_macro_index`。
4. **按契约解释结果。** 核心身份、quote、bars、财务、公告、指数、日历及宏观结果使用 Tier A canonical payload；长尾使用 `AshareFeatureDatasetV1`（Tier B）。两者都必须保留 provenance、实际日期、单位、warnings、limitations、limit/truncated 和 fallback chain。
5. **控制参数。** 只能使用工具 schema 中列出的 `feature`、`dataset` 和参数。组合 capability 需要时用闭合 `variant`。列表请求设置合理 `limit`；看到 `truncated: true` 时缩小日期范围或请求范围，不猜 cursor。
6. **按真实状态回答。** 只有已验证的成功空结果才是 `no-data`。403、登录页或验证码是权限/访问受阻，429 是 `rate-limited`，字段变化是 `schema-drift`，网络问题是 `unavailable-network`；不得把它们写成空数组、0 或成功。
7. **披露来源与降级。** 区分 provider（例如 `a-stock-public`）与 `upstreamSource`（例如腾讯、东财、巨潮、交易所）。发生 fallback 时保留每次尝试、失败原因和质量变化；多来源冲突先对齐证券、日期、复权、单位和口径，再并列结果，不静默平均。

## 鉴权与来源边界

- 59 项能力不要求用户 credential。mootdx 使用内置固定服务器 allowlist；BaoStock 使用匿名客户端会话；北交所仅使用进程内匿名 Cookie；公开 HTTP 来源使用固定 host/operation allowlist。
- `disclosures.iwencai-semantic` 是唯一 optional-auth feature。无 `IWENCAI_API_KEY` 时预期为 `blocked-auth`，且不影响其他 59 项；有 Key 时仍按 live health 判断结果。不要索取、复述或记录 Key。
- TDX official、iFinD、TuShare 是可选增强 provider，不是 59 项零 Key能力的前置条件。用户显式指定增强源时不静默改源；`source: auto` 的 fallback 必须出现在 provenance。
- public-web 是 best-effort，不承诺 SLA；不绕过验证码、付费墙、访问控制或反自动化机制。

完整 60 项 feature、dataset、source 与 contract tier 映射见 [capability-routing.md](references/capability-routing.md)，时间、单位、PIT 与内容使用纪律见 [source-policy.md](references/source-policy.md)。

## 回答边界

- PDF/附件只把 document ref、hash、标题、发布时间和来源作为证据；未读取正文时不得把 snippet 当正文。
- 当前快照不能冒充历史 PIT 数据；未发布月份、缺失数值、空响应和过期 quote 不得填 0。
- 不提供个性化投资建议，也不提供自动交易、账户、下单、仓位建议或收益保证。价格、成交、资金流和热度也不能证明个体心理状态。
