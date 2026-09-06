# A 股能力与工具路由

本文件用于在问题跨多个数据域或需要指定来源时选择最小工具集合。入口工作流已足够处理简单请求；只有需要细化 capability、参数或 fallback 顺序时读取本表。

## Curated tools

| 工具 | 适用问题 | 关键输入 | 回答时保留 |
|---|---|---|---|
| `finance_data_catalog` | 可用能力、市场覆盖、provider health、鉴权/权限、频率和限制 | capability、market、可选 source | provider 状态、auth/permission、限制与检查时间 |
| `finance_cn_instrument` | 证券代码/provider symbol 规范化；不支持中文名称查询 | 六位代码、exchange-qualified 代码或 canonical identifier；歧义时 exchange/asset type | canonical instrument，以及 provider 若返回的名称、市场、交易所、类型 |
| `finance_cn_quote` | 无 `as_of` 时为当前 quote；有 `as_of` 时为目标日单日未复权 bars 映射的稳定 quote snapshot | canonical instrument、可选 `as_of` | 实际 bars provenance、`adjustment: none`、交易日、observedAt、fetchedAt、币种/单位；历史结果不是实时 quote/盘口 |
| `finance_cn_bars` | 日 K、成交量额、换手 | canonical instrument、日期范围、`interval: 1d`、adjustment、limit、page（省略或 1） | 实际起止交易日、复权、时区、limit/partial |
| `finance_cn_fundamentals` | 三表/财务指标；`corporate-actions` 仅为受控稳定 surface | canonical instrument、`report_period` 或成对的 `start_date`/`end_date`、as_of、limit、page（省略或 1） | 所选报告期、对应的顶层 provenance、published/available date、币种、单位、合并口径 |
| `finance_cn_disclosures` | 公告；`research-consensus` 仅为受控稳定 surface | canonical instrument、文档类型、日期范围、limit、page（省略或 1） | document refs、标题、发布时间、正文可读状态 |
| `finance_cn_market_activity` | `capital-flow`/`market-signal`/`order-book` 的受控稳定 surface | canonical instrument/market、受控 capability enum、日期范围、limit、page（省略或 1） | canonical 状态、实际 provider 与可用性诊断 |
| `finance_cn_macro_index` | 指数/交易日历；`macro` 仅为受控稳定 surface | 受控 capability、index/exchange、as_of/date range、limit、page（省略或 1） | canonical 状态、source date、发布日期、频率、单位、是否历史快照 |

所有带 `source` 的工具只接受 `source: auto` 或 `finance_data_catalog` 返回的 approved provider id；支持 PIT 的取数工具只接受 ISO `as_of` 和受控日期范围。provider id 与 provenance 中的 `upstreamSource` 不同；例如 `a-stock-public` 是 provider，而腾讯、东方财富、新浪等具体站点是该 provider 可记录的 upstream source，不能直接作为 `source` 参数。不要把任意 URL、endpoint、SQL、shell、Python 或上游函数名作为逃生入口。

带 `page` 的工具只支持省略或 `page: 1`；`page > 1` 会被拒绝。结果超出 limit 时缩窄日期，或拆成多个不重叠日期范围分别查询；不要使用不存在的 cursor。

`corporate-actions`、`research-consensus`、`capital-flow`、`market-signal`、`order-book` 和 `macro` 是受控稳定 surface，但当前没有默认 routable provider，不能计作已经实现的数据 capability。只有 catalog 明确显示映射、`routable: true` 且 health/权限合格时才能取数；当前默认组合会返回 `unsupported`。

## 最短组合

- “600519 今天价格”：instrument → quote。
- “600519 某日收盘快照”：instrument → quote(`as_of`)；按单日 `adjustment: none` bars 的 snapshot 解释，不当成历史实时 quote 或盘口。
- “600519 最近一年前复权日线”：instrument → bars。
- “600519.SH 2024 年报与公告原文”：instrument → fundamentals + disclosures。
- “000300.SH 某日成分和当日是否开市”：instrument（指数身份）→ macro_index。
- “北向/主力资金、龙虎榜或两融”：instrument（个股请求）→ catalog；仅发现已映射且可路由的目标 capability 时再调用 market_activity。
- “哪个来源支持历史指数权重”：catalog → macro_index；catalog 只发现能力，不代替取数。

一个请求包含多个事实域时可组合工具，但不要为了完整感调用无关工具。先取得 canonical instrument，再把同一 canonical id 传给后续工具。

## Capability 候选来源优先级

生产组合当前只有一套全局静态 provider priority，不能为每个 capability 单独排序。路由先按 capability、市场与可路由性筛选；`tushare-mcp` 只在完成配置并可路由时参与，`cne6-local` 只在本地发布物可用时参与，`tdx-community` 只在批准的服务器已配置时参与。TDX official 与 iFinD official 当前只是 catalog 中的 dormant 边界，不进入实际候选。历史 `finance_cn_quote(as_of)` 按 `market-bars` 候选路由，而非当前 quote 候选。

下表记录当前实际候选顺序。共同能力使用 TuShare → CNE6 local/PIT fallback → TDX community → public 的整体折中；这保证 `market-bars` 和 `fundamentals` 都不会让 CNE6 抢在已配置、可路由的 licensed TuShare 之前。

| Capability | 当前 `source: auto` 候选顺序 | 特别检查 |
|---|---|---|
| 证券代码规范化 | `tushare-mcp` → `a-stock-public` | 只接受六位、exchange-qualified 或 canonical identifier；不做中文名称查询 |
| 当前实时/快照 | `tdx-community` → `a-stock-public` | 目标交易日是否匹配；public provider 的 upstreamSource 可为腾讯/东财/新浪 |
| 历史 K 线 | `tushare-mcp` → `cne6-local` → `tdx-community` → `a-stock-public` | CNE6 是本地/PIT fallback；明示 `none/qfq/hfq` 并检查候选支持的复权方式；public upstream 可为东财/新浪 |
| 财务 | `tushare-mcp` → `cne6-local` → `a-stock-public` | CNE6 是本地/PIT fallback；用 `report_period` 或日期范围选择期间，核对公告/可见日、币种、单位、合并口径 |
| 公告 | `a-stock-public` | 不以新闻摘要替代公告正文 |
| 公司行动/研报与一致预期/市场活动/宏观 | 当前没有默认 routable provider | 仅为受控稳定 surface，不是已实现的数据 capability；默认返回 `unsupported` |
| 指数 | `a-stock-public` | 最新快照不得冒充历史；CNE6 不提供 index capability |
| 交易日历 | `tushare-mcp` → `a-stock-public` | 合格查询确认尚未发布时返回 canonical `no-data`，可在 warning 说明 `not-published` |
| 本地风险数据 | 只读 `cne6-local` | 报告版本、coverage、quality；不假装全市场完整 |

## 权限与降级

先用 `finance_data_catalog` 区分状态：没有 canonical capability/provider 映射是 canonical `unsupported`；provider 已知但当前不可路由或不健康时保留 catalog health/路由的 `unavailable` 诊断；鉴权或接口权限受阻是 `unauthorized`/`insufficient-permission`（TuShare 还可能为 `insufficient-points`）；只有合格 provider 实际完成查询却无匹配记录才是 canonical `no-data`。这些状态以及 `rate-limited` 都不能互相替代。

仅 `source: auto` 可在合格候选间自动 fallback，并披露每次失败与质量变化。用户显式指定 TDX official、iFinD、TuShare 或其他 provider 时不自动换源；说明失败状态和所需本地账号、套餐、积分或接口权限，可以建议替代来源，但未经用户同意不得实际改用。不要要求用户把秘密值发进对话，也不要猜测权限已开通。
