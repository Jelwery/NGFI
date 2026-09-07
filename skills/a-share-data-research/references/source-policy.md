# A 股来源与时点纪律

本文件用于核对多来源、历史时点、复权或财务披露。目标是让每项数字可追溯、可比较且 point-in-time safe，而不是让来源数量看起来更多。

## 来源层级与 provenance

在 capability 适配且状态健康的前提下，依次偏好 `official`、`licensed`、`community`、`public-web`。聚合源不因结构整齐就升级为官方源；派生值标为 `derived`，并保留输入 refs、算法版本和口径。

引用数据时至少保留：

- canonical instrument 或 capability；
- `requestedProvider`（如有）、`actualProvider`、`upstreamSource`、`sourceKind`；
- `fetchedAt`，以及适用的 `observedAt`、`publishedAt`、`availableAt`；
- timezone、currency、unit、adjustment、fiscalPeriod；
- status/quality flags、warnings/limitations、fallback chain。

历史 `finance_cn_quote(as_of)` 的 snapshot 必须保留实际单日 bars 的 provider/upstream、观察和抓取时间、fallback chain 及 `adjustment: none`，并明确其不是历史实时 quote 或历史盘口。fundamentals 经 `report_period` 或日期范围筛选后，顶层 `fiscalPeriod`、`publishedAt`、`availableAt` 等 provenance 必须对应最终所选期间。

来源 URL 必须脱敏。不要输出或保存 token、API key、Cookie、Authorization header、带凭据的 query URL 或本机 secret 路径。

## 时间语义

- **交易日**是市场数据所属日期；**抓取时间**是系统取得数据的时刻。两者不可互换。
- A 股盘中与日终结果使用 `Asia/Shanghai`；跨时区源同时保留原时区和转换口径。自然语言中的“今天/昨天”先映射到明确日期，再判断是否为交易日。
- **报告期**描述经营归属期；**公告日/发布时间**描述对外披露时间；`available_date`/`availableAt` 描述该数据最早能被研究者使用的时间。历史 `as_of` 分析只使用 `availableAt <= as_of` 的数据。
- `finance_cn_quote(as_of)` 只读取目标自然日对应的单日 `1d`、`adjustment: none` bar。周末、节假日等休市日保留实际 canonical 状态，不以前一交易日回填；可以另行说明最近已完成交易日，但不能把其值作为目标日 snapshot 返回。
- 合格查询确认目标日期尚未发布时，返回 canonical `no-data`，可在 warning 说明 `not-published`；其他失败保留其实际状态，不能把最近值伪装成目标日期。
- 指数文件若只是最新成分快照，必须标为当前快照，不能冒充历史成分或历史权重。

## 价格与财务口径

- 每个价格序列声明 `adjustment: none | qfq | hfq`。不同复权方式不能直接拼接或比较；跨 provider 前先核对除权除息和公司行动。
- 价格带 quote currency；成交量、成交额、换手率和估值字段分别声明单位/比例口径。百分数与小数不得混用。
- fundamentals 请求用 `report_period` 精确选择报告期，或用成对的 `start_date`/`end_date` 选择期间范围；顶层 provenance 必须来自最终所选期间，不能沿用过滤前其他期间的 `fiscalPeriod`、`publishedAt` 或 `availableAt`。财务比较还要对齐 annual/quarterly/TTM、币种、单位、合并/母公司口径和会计口径。公告中的原始披露与聚合源标准化字段要明确区分。
- canonical `unsupported` 表示没有 capability/provider 映射；catalog health/路由的 `unavailable` 表示已知 provider 当前不可路由或不健康；`unauthorized`/`insufficient-permission` 表示鉴权或权限受阻；canonical `no-data` 只表示合格查询完成但没有匹配记录。它们以及 `missing`、TuShare `insufficient-points`、`rate-limited`、`provider-error`、`schema-drift`、`stale`、`partial` 都不是零，空数组/空对象也不自动等于 `no-data`。
- 带 `page` 的工具只允许省略或 `page: 1`。`page > 1` 必须拒绝；需要更多结果时缩窄或拆分为多个不重叠日期范围，不改用 cursor。

## Fallback 与冲突

仅 `source: auto` 可自动 fallback。用户显式指定 provider 时不自动换源；可以报告建议的替代来源，但实际改用前先取得用户同意。发生 fallback 时说明请求来源、每次失败/跳过原因、实际来源及 source-kind/质量变化，不得只展示最终成功值。

多来源冲突按以下顺序处理：

1. 确认是同一 canonical instrument、交易日或报告期。
2. 对齐复权、币种、单位、合并口径、发布版本与可见时间。
3. 若差异仍存在，并列来源 A 与 B 的值、时间、状态和 provenance，并说明差异是否超过该 capability 的阈值。
4. 不静默平均，不按预设观点挑值；只有来源更正或明确口径差异能解释冲突时，才说明哪一个更适用于当前问题。

## 文档与解释边界

公告、研报或新闻的 snippet 只能用于定位文档。未读取正文时写明正文不可得，不基于 snippet 得出实质结论。价格上涨、成交活跃、资金流或热度是市场观察，不能据此证明个体心理状态、FOMO、羊群或泡沫，也不能转化为个性化买卖、仓位、杠杆或收益保证。
