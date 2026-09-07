# A 股 60 项能力与工具路由

运行时单一事实来源是 `packages/finance-provider-astock/feature-registry.json`。当前固定上游为 `a-stock-data v3.8.0`（tag object `9f995e66ee792255e492a15627f98615627041c6`，peeled commit `2012ce7cd0e75d379c5e6cbd3115514f300f3bc8`）。60 个 capability、67 个 capability-callable 映射和 70 个受控 tool variant 全部闭合；组合项允许同一个锁定 callable 提供多个高层视图。

## 调用规则

- `feature` 和 `dataset` 都是工具 schema 中的闭合 enum；组合项再用闭合 `variant` 消歧。禁止传上游函数名、URL、headers、Cookie、Python、shell、SQL 或 raw MCP。
- 新增 feature 路径由 `a-stock-public` 执行。省略 `source` 或使用 `source: auto` 时仍锁定该受控 provider；显式 source 也只能是 `a-stock-public`。原有 canonical quote/bars/fundamentals 等调用继续使用既有 provider 路由。
- Tier A 为专用 canonical 契约；Tier B 为版本化 `AshareFeatureDatasetV1` records envelope。两级结果都有 provenance、日期/时点、单位、warnings、limitations、limit/truncated 与 fallback chain。
- `implemented-*` 描述实现状态，不代表实时网络一定可用；live health 可能是 `pass`、`no-data`、`blocked-auth`、`unavailable-network`、`rate-limited`、`schema-drift` 或 `upstream-error`。
- 证券范围的 feature 先用 `finance_cn_instrument` 规范化。market、industry、macro 类 feature 不要求伪造 instrument。

工具简称：`instrument`=`finance_cn_instrument`，`quote`=`finance_cn_quote`，`bars`=`finance_cn_bars`，`fundamentals`=`finance_cn_fundamentals`，`disclosures`=`finance_cn_disclosures`，`market_activity`=`finance_cn_market_activity`，`macro_index`=`finance_cn_macro_index`。

## 完整矩阵

| ID | Feature | Tool:dataset（variant） | 默认来源链 | Tier | Auth |
|---|---|---|---|---|---|
| 001 | `market.tdx` | quote:`tdx-quote` (quote)<br>bars:`tdx-bars` (bars)<br>market_activity:`order-book` (order-book)<br>market_activity:`time-and-sales` (time-and-sales) | mootdx | A | none |
| 002 | `quote.tencent` | quote:`tencent-quote` | tencent-finance | A | none |
| 003 | `bars.baidu-ma` | bars:`baidu-bars-ma` | baidu-gushitong | B | none |
| 004 | `bars.adjustment` | bars:`adjustment-data` (factor)<br>bars:`adjustment-data` (adjusted-bars) | sina-finance | A | none |
| 005 | `disclosures.research-report` | disclosures:`research-report` (stock)<br>disclosures:`industry-research-report` (industry) | eastmoney-reportapi | B | none |
| 006 | `disclosures.research-document` | disclosures:`research-document` | eastmoney-reportapi | B | none |
| 007 | `disclosures.eps-consensus` | disclosures:`eps-consensus` | ths-basic | B | none |
| 008 | `disclosures.iwencai-semantic` | disclosures:`iwencai-semantic-search` (search/query) | iwencai | B | API key |
| 009 | `market-activity.hot-reason` | market_activity:`hot-reason` | ths-hot | B | none |
| 010 | `market-activity.northbound-minute-flow` | market_activity:`northbound-minute-flow` | ths-hsgt | B | none |
| 011 | `instrument.concept-membership` | instrument:`concept-membership` | eastmoney-push2 | B | none |
| 012 | `market-activity.stock-fund-flow-minute` | market_activity:`stock-fund-flow-minute` | eastmoney-push2 | B | none |
| 013 | `market-activity.dragon-tiger-stock` | market_activity:`dragon-tiger-stock` | eastmoney-datacenter | B | none |
| 014 | `fundamentals.lockup-expiry` | fundamentals:`lockup-expiry` | eastmoney-datacenter | B | none |
| 015 | `market-activity.industry-performance-ranking` | market_activity:`industry-performance-ranking` | eastmoney-push2 | B | none |
| 016 | `market-activity.board-fund-flow` | market_activity:`board-fund-flow` | eastmoney-push2 | B | none |
| 017 | `market-activity.dragon-tiger-market` | market_activity:`dragon-tiger-market` | eastmoney-datacenter | B | none |
| 018 | `market-activity.margin-trading` | market_activity:`margin-trading` | eastmoney-datacenter | B | none |
| 019 | `market-activity.block-trade` | market_activity:`block-trade` | eastmoney-datacenter | B | none |
| 020 | `fundamentals.holder-count-change` | fundamentals:`holder-count-change` | eastmoney-datacenter | B | none |
| 021 | `fundamentals.dividend-history` | fundamentals:`dividend-history` | eastmoney-datacenter | B | none |
| 022 | `market-activity.stock-fund-flow-daily` | market_activity:`stock-fund-flow-daily` | eastmoney-push2 | B | none |
| 023 | `market-activity.chip-distribution` | market_activity:`chip-distribution` | mootdx → baostock | B | none |
| 024 | `disclosures.stock-news` | disclosures:`stock-news` | eastmoney-push2 | B | none |
| 025 | `disclosures.market-telegraph` | disclosures:`market-telegraph` | cailianpress | B | none |
| 026 | `disclosures.global-news` | disclosures:`global-news` | eastmoney-push2 | B | none |
| 027 | `fundamentals.tdx-finance-snapshot` | fundamentals:`tdx-finance-snapshot` | mootdx | B | none |
| 028 | `fundamentals.tdx-f10` | fundamentals:`tdx-f10` | mootdx | B | none |
| 029 | `instrument.company-profile` | instrument:`company-profile` | eastmoney-push2 | A | none |
| 030 | `fundamentals.financial-statements` | fundamentals:`financial-statements` | sina-finance | A | none |
| 031 | `fundamentals.valuation-history` | fundamentals:`valuation-history` | baostock | B | anonymous client |
| 032 | `instrument.listing-status` | instrument:`listing-status` | baostock | A | anonymous client |
| 033 | `instrument.sw-industry` | instrument:`sw-industry` (history/as-of) | sw-research | B | none |
| 034 | `disclosures.announcement` | disclosures:`announcement` | cninfo | A | none |
| 035 | `disclosures.tdx-announcement-summary` | disclosures:`tdx-announcement-summary` | mootdx | B | none |
| 036 | `market-activity.limit-up-pool` | market_activity:`limit-up-pool` | eastmoney-push2 | B | none |
| 037 | `market-activity.broken-limit-pool` | market_activity:`broken-limit-pool` | eastmoney-push2 | B | none |
| 038 | `market-activity.limit-down-pool` | market_activity:`limit-down-pool` | eastmoney-push2 | B | none |
| 039 | `market-activity.previous-limit-up-pool` | market_activity:`previous-limit-up-pool` | eastmoney-push2 | B | none |
| 040 | `market-activity.limit-up-reason` | market_activity:`limit-up-reason` | ths-hot | B | none |
| 041 | `market-activity.limit-up-sentiment` | market_activity:`limit-up-sentiment` | eastmoney-push2 | B | none |
| 042 | `market-activity.stock-monitor` | market_activity:`stock-monitor` | eastmoney-push2 | B | none |
| 043 | `market-activity.price-anomaly-events` | market_activity:`price-anomaly-events` | eastmoney-push2 | B | none |
| 044 | `market-activity.price-anomaly-count` | market_activity:`price-anomaly-count` | eastmoney-push2 | B | none |
| 045 | `market-activity.option-contracts` | market_activity:`option-contracts` | sina-finance | B | none |
| 046 | `market-activity.option-tquote` | market_activity:`option-tquote` | sina-finance | B | none |
| 047 | `market-activity.option-greeks` | market_activity:`option-greeks` | sina-finance | B | none |
| 048 | `disclosures.investor-relations-qa` | disclosures:`investor-relations-qa` | cninfo | B | none |
| 049 | `market-activity.ths-hot-list` | market_activity:`ths-hot-list` | ths-hot | B | none |
| 050 | `market-activity.eastmoney-hot-rank` | market_activity:`eastmoney-hot-rank` | eastmoney-push2 | B | none |
| 051 | `market-activity.hot-concept` | market_activity:`hot-concept` | eastmoney-push2 | B | none |
| 052 | `macro.social-financing-flow` | macro_index:`social-financing-flow` | pboc | A | none |
| 053 | `macro.pmi` | macro_index:`pmi` | nbs | A | none |
| 054 | `index.constituents` | macro_index:`index-constituents` | csi → cni | A | none |
| 055 | `index.weights` | macro_index:`index-weights` | csi → cni | A | none |
| 056 | `index.valuation` | macro_index:`index-valuation` | csi | A | none |
| 057 | `index.trading-calendar` | macro_index:`trading-calendar` | szse-official | A | none |
| 058 | `market-activity.margin-trading-official` | market_activity:`margin-trading-official` | szse-official → sse-official | B | none |
| 059 | `market.bse-official` | quote:`bse-snapshot` (quote)<br>market_activity:`bse-order-book` (order-book) | bse-official | A | anonymous session |
| 060 | `market-activity.official-backups` | market_activity:`dragon-tiger-backup` (dragon-tiger)<br>market_activity:`fund-flow-backup` (fund-flow)<br>disclosures:`announcement-backup` (announcement) | sse-official → szse-official → sina-finance → eastmoney-push2 | B | none |

## 参数与输出

- `finance_cn_instrument`：`query` 必填；可选 `feature`/`dataset`、`variant`、`as_of`、`limit`。
- `finance_cn_quote`：`instrument` 必填；可选 `feature`/`dataset`、`variant`、`trade_date`、`as_of`、`limit`。
- `finance_cn_bars`：`instrument`、`start_date`、`end_date` 和 `adjustment` 必填；interval 为 `1m|5m|15m|30m|60m|1d|1wk|1mo`，非 `1d` 必须选择相应 feature。
- `finance_cn_fundamentals`：`instrument` 必填；按 dataset 可用 `report_period`、日期范围、`trade_date`、`forward_days`、`category`、`statement`。
- `finance_cn_disclosures`：证券级 dataset 要求 `instrument`；iWenCai、市场电报、全球资讯和行业研报不强制 instrument。iWenCai 使用 `search_text`，不能使用通用 `query`。
- `finance_cn_market_activity`：按 feature 声明 instrument/market/industry/derivative scope；可用参数只有 schema 列出的日期、board、period、option 和 limit 字段。
- `finance_cn_macro_index`：指数 feature 需要 canonical index；交易日历和宏观按 dataset 使用 exchange/date/year。

结果为 Tier B 时读取 `records`、`returned`、`truncated`、`fieldUnits` 和 `limitations`；嵌套上游对象会被序列化成标量字符串，不返回 DataFrame repr、HTML 或 raw response。

## 鉴权、健康与降级

- capability 008 是唯一 `implemented-optional-auth`。未配置 `IWENCAI_API_KEY` 时，catalog/live 为 `blocked-auth`；配置后仍可能因权限、限流或 schema 变化失败。
- BaoStock 的 `client` 和 BSE 的 `session` 都是匿名运行机制，不是用户 credential。BSE Cookie 仅在进程内保存。
- 其他 59 项不要求用户 Key。TDX official、iFinD 和 TuShare 是可选增强源，不影响 `a-stock-public` 的 59 项零 Key映射。
- 只有成功码、响应身份、日期、分页和 schema 均通过验证后，空集合才可解释为 `no-data`。403、429、验证码、登录页、重定向、超限和 schema drift 必须 fail closed。
- public-web/mootdx/BaoStock 均为 best-effort；没有 live `pass` 时只能报告真实状态，不得依据 manifest 或 fixture 宣称实时可用。
