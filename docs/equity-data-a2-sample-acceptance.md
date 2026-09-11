# A2 首批真实数据构建与样本验收

日期：2026-09-10。继承 A0/A1 内容快照 `equity-a0-a1-1bb79e9c8e44b525` 和固定 D=`2026-09-09`。本轮开始真实构建数据，不再等待用户提供预制数据目录；用户授权使用现有工具与 TuShare，凭据仅保存在被 Git 忽略且权限为0600的本地秘密文件，不在本文/源码/数据中出现。

## 当前结论

- **已构建真实候选数据**：三交易所当前及退市证券主表、沪深历史日历、24只分层样本历史行情/股本/复权/名称/停牌/涨跌停/公司行动/财报版本/行业，以及CSI300/CSI800价格与全收益序列。
- **已完成样本工程验证与部分数据核验**：484个原始请求分区保留hash和schema身份，5个Parquet文件可完全离线复算，两个独立重建目录（candidate-v7 / replay-v7）的数据hash逐字节一致。
- **A2 整体未通过**：原始版本时点、北交所身份/日历独立证据、18个早期停牌冲突、风险模型可行性仍为blocked；全市场分区验收和20个真实交易日增量未执行。评估窗内115条已实施事件具备所需结算日期；18条历史缺pay_date记录均在2016年前，部分为纯送转，单列而不误作评估窗阻断。没有切换CURRENT、没有宣布策略准入、没有跳到A3。
- **本轮新增两项真实门禁判定**：`riskModel` 与 `tradingStatusConsistency` 不再是 `not-run`/仅计数，而是由确定性代码在真实样本上判定并给出精确原因（见下方“剩余门禁与精确原因”）。风险模型对全市场的 `riskAcceptance` 仍 blocked。
- 本轮完整 `pnpm check` 的最终退出码及源码版本以 `.runtime/equity-baselines/equity-a2-*/manifest.json` 为准；仅 `checks.status=pass` 的manifest代表工程通过。

## 构建规模与布局

数据根 `.runtime/equity-data/a2/`：

- `plans/`：不可变请求批次；每批≤30请求、单worker、请求起点间隔≥1.25秒、请求超时20秒、批次600秒，同轮不重试。
- `requests/<requestHash>.json`：保留原始TuShare解析响应、实际fetchedAt、请求、工具schema hash、内容hash和artifact hash；成功响应原样留存，空集不改成数据通过。
- `runs/`：每批起止时间、成功/缓存/失败及停止原因；失败即停止当前批次，重放只读取已校验缓存，无凭据也不联网。
- `selection.json`：初版候选保留；`selection-v2.json`：在样本历史取数之前排除评估窗外已退市证券，并用D日成交额替代小市值流动性近似；仍标candidate/unverified，不按事后收益重选。
- `candidate-v6/`：上一轮样本候选；`candidate-v7/`：本轮当前样本候选（含 `riskModelProbe`/`tradingStatusConflicts` 诊断）；`replay-v7/`：独立离线重建，逐字节一致。更早candidate-v1/v2/v3保留，不覆盖。
- `gold/`：原始年报、公告元数据、原件核对及指数身份资料；没有上传第三方。

| 内容 | 实际数量 / 范围 |
|---|---|
| 证券主表 | 5,900行：SSE上市2317/退市147，SZSE上市2901/退市187，BSE上市343/退市5；暂停上市集合为空，保留空响应证据 |
| 历史日历 | SSE/SZSE各6,461个自然日，2009-01-01至D；逐日连续/唯一/交易所身份核验；各4,297个交易日 |
| D日全市场截面 | daily与daily_basic各5,550条；不是历史全市场验收，仍需与有效期主表和停牌逐条核对 |
| 样本 | 24只，SSE/SZSE/BSE各8；含银行、普通公司、ST、IPO、低成交额、历史退市/转板、长期停牌及公司行动 |
| 样本原始日线 | 59,159行；包括源返回的上市前/跨市场历史，原样保留 |
| 规范证券日面板 | 58,538行，含停牌和missing状态，不用零收益代替缺失 |
| 财报 | 7,018行；report_type=1最新合并、4调整合并、5调整前合并并存，不覆盖旧版本，不宣称已计算TTM/MRQ |
| 公司行动 | 1,116行，305条实施记录；2016年至D的115条实施事件均有现金到账日期，其中12条送转亦有股份上市日；18条历史缺pay_date记录单列 |
| 行业 | 34条当前+历史归属；in/out日期不等于首次披露时间 |
| 基准权重 | 2026-08-31 CSI300 300只、CSI800 800只，两者各合计100%；不是完整历史调样/每日权重 |
| 基准收益序列 | 000300.SH / 000906.SH（price），H00300.CSI / H00906.CSI（total-return），每条4,297日，共17,188行 |
| 正式采集请求 | 484个唯一分区；另有前置权限、源文档和官方原件诊断请求，不混入分区计数 |

样本代码以 `selection-v2.json` 为唯一来源；没有为“凑齐成功”删除退市/新股/问题证券。观典防务旧北交所标识包含新三板/转板历史，保留为身份验收案例，不能把其当前代码历史直接当同市场普通A股。

## 源权限与实际修复

### TuShare

实测可用：stock_basic、trade_cal（沪深）、daily、daily_basic、adj_factor、namechange、suspend_d、stk_limit、income、balancesheet、cashflow、dividend、index_member_all、index_weight、index_daily、bse_mapping。

实测不足：stock_st、anns_d 返回 insufficient-permission。未使用其他身份、付费、代理或技术手段绕过；历史名称可作为独立特征来源，但 `st_from_name` 明确标为推导，不能冒充已获授权的官方ST全量历史。

修复 `resolveTushareEndpoint`：原默认 `/mcp/token=...` 返回missing_token，当前服务接受`/mcp/?token=...`；保持固定官方HTTPS host、脱敏、无raw tool逃逸。仅接口可发现不代表具有每项数据权限。

### 截断、版本和时间

- 12只股票资产负债表长窗恰好100行，经年份分区确认存在截断；保存旧响应，新增早/晚分区补齐，采集器和缓存消费均拒绝触达100行边界的balancesheet作为完整结果。
- income/cashflow/其他源也保留条数上限；不把行数小于上限等同于已证明完整，仍要核对预期报告期。
- index_member_all默认仅最新，另取is_new=N补历史；没有用最新行业回填历史。
- 明确财报1/4/5类型，不把今天最新行当历史首次版本；所有历史来源缺实际首次可得证明时仍 `source_available_at=null, quality_flag=unverified`，不填May-1或午夜。
- 原始日线未复权；vol手×100为股、amount千元×1000为人民币元，daily_basic万股/万元×10000，换手百分数÷100。
- TuShare `pre_close` 是除权参考昨收，面板命名 `ex_right_preclose`，不得误当昨日原始收盘；复权因子独立存储。
- 原始板块/名称/股本日期与fetchedAt分开；元数据完整性不自动赋予PIT安全。

### 公开公告

现有公开feature的日志污染造成NDJSON记录数错误，保留失败记录，不手改vendor/generated代码。canonical公告路径的问题独立定位为巨潮`announcementTypeName=null`，仅把可选分类映射为通用`announcement`，不改标题/日期/身份必填校验；修复后真实查询浦发2026-03至04公告成功，24条、未截断。

## 实质验收结果

- 样本2016-01-01至D：35,538个正常应交易证券日均有原始行情，覆盖100%；另外的源确认整日停牌不混进正常交易分母。原始总分母/排除/逐证券日期保留。
- 3,140条源返回的上市区间外/交易所成立前行情单列exclusions，主要涉及BSE旧身份/新三板数据；不是删除后假装没有缺口。
- 18条2009–2012年数据同时有成交与“全天停牌”记录，状态明确为conflict，不能进入正常成交；虽在策略评估窗前，仍影响warm-up和模型验收，门禁blocked。
- BSE接口日历返回空。TuShare官方文档说明可参考沪深共同日历，但本项目只把它标为provider-convention-proxy，4,705条BSE证券日保持标记，等待交易所/转板规则独立证据。
- 财报所有记录有来源公告日期，且1/4/5版本分开，但精确首次可得/原件版本尚未逐条核对；coverage=0的“已证明sourceAvailability”指严格证据门禁，不表示没有日期或没有采集数据。
- 公司行动按有效窗口及事件类型验收：2016年至D的115条实施事件均满足登记/除权日期及正现金派息的pay_date要求，其中12条正股份送转事件亦有div_listdate。更早18条缺pay_date包含纯股份事件，不能都称“缺现金到账”；仍保留原始null，不当零。股份上市日尚需账户规则验证后才能视作可卖日。
- 四条基准序列交易日连续、身份经index_basic确认；历史指数成分调样/权重发布时间、单独源核验未完成，不能宣称完整基准复制验收。
- CNE6 snapshot、42 descriptor实数据覆盖、协方差专项和全市场20日增量均未借样本门禁宣布通过；optimizer仍不消费这些未批准候选。

机器可读结果为 `candidate-v7/acceptance.json`，包含每证券/年份覆盖、状态计数、最长停牌段、源行业标签、异常、分母、全部rawLineage，以及本轮新增的 `riskModelProbe`（逐评估日满秩可行性）与 `tradingStatusConflicts`（18条同日冲突明细与分类）。未来全市场还要增加完整行业/市值/流动性分桶和独立证券主表对照，不能用当前24只概括全市场。

## 独立金标准

浦发银行《2025年年度报告》，巨潮announcementId `1225062336`，来源公告日期2026-03-31；源timestamp落于上海午夜，**时间精度仅按日期处理**。原始PDF SHA-256：

```text
e4d1cff0461c0ef24d26551ca68e31ad323a1b3eadd8a3c03f00feada364de22
```

已实际渲染并查看PDF第28/29页（印刷页11/12），财务表单位人民币百万元，股数附注为股。以下8项与TuShare20251231合并报表完全一致：营业收入173,964百万元、利润总额53,374百万元、归母净利50,017百万元、经营现金流375,836百万元、总资产10,081,746百万元、总负债9,257,316百万元、归母权益816,914百万元、期末总股本33,305,838,300股。结果见 `gold/pudong-financial-check.json`。

这只是1家公司1个时点8个字段的独立值核验，不扩展成三所/所有行业/全部历史财报/PIT通过。源原件和版本定位保留，可继续扩金标准；不是两个同上游wrapper互相背书。

## 测试、重放与安全

- 新增TS采集测试13项、Python样本测试11项；初次验证真实复现反向窗口未拒绝、缓存联网、冲突状态错误3项，修复业务逻辑后断言保持不变。
- 定向TS：111项通过（采集13 + TuShare58 + A股provider40）；Python样本/acceptance/publication：53项通过。
- canonical公告fixture补充分类null场景，真实网络验证也通过；没有放松其他源schema边界。
- 对candidate-v7与replay-v7比较：除生成时间外报告一致，5个Parquet hash完全相同；采集daily组全缓存重放 `requestStarts=0`，无需凭据。
- Node/Python对原始分区hash核对一致；源码与已取得候选/原件扫描未发现凭据。秘密文件0600，仓库gitignore生效。
- 本轮不新增顶层package、不新增Agent公开工具、不改optimizer、不下单；旧A0/A1版本与所有失败/旧候选均保留。

## 复算命令

从仓库根运行。只有实际缺分区的采集才需要凭据；不要直接在命令参数里写token。

```bash
node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts bootstrap
node --import tsx scripts/acquire-equity-sample.ts select
node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts sample daily
node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts repair balance-early
node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts repair balance-late
node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts repair industry-history
node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts repair benchmarks
uv run --project packages/combinatorial-optimization --offline --no-sync --no-env-file --no-config python -m cne6_engine.data_sources.cli sample --output .runtime/equity-data/a2/new-replay
node scripts/freeze-equity-baseline.mjs equity-a2-sample --check
```

所有请求计划可见plans目录；sample还支持daily_basic/adj_factor/namechange/suspend_d/stk_limit/dividend/income/balancesheet/cashflow/index_member_all；财务历史版本通过repair `<income|balancesheet|cashflow>-type-<4|5>`，每批24请求。触达行数上限或失败即停，不能无限重跑。旧完整balancesheet计划中被截断的缓存会拒绝重用，须使用两个修复计划。

## 2026-09-10 后续执行：总门禁与真实观测

本轮未完成A2全部验收，不能固定为“A2完成版”。新增 `cne6_engine.data_sources.cli a2-audit` 对现有样本文件、原始采集血缘与当天观测做真实完整性复核，并输出 `DataAcceptanceRun`；当前只支持审核既有sample证据，不能接受调用方填写pass就升级为全市场验收。

- `a2-audit --candidate .runtime/equity-data/a2/candidate-v7 --output .runtime/equity-data/a2/新文件.json`：未通过时退出码2，`readyForA3=false`、`promotionAllowed=false`，不修改CURRENT。
- `node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts observe`：仅实际上海日期17:00后运行，禁止指定过去日期，独立目录保存实际采集证据；重复日期拒绝覆盖。历史D不改变，观测日期另行记录。
- 已实际记录2026-09-10收盘后观测：daily/daily_basic各5549行，suspend_d 12行；行情源观测日为1，**正式已验收发布观察仍为0/20**。没有安装或声称已启动无人值守调度；后续需实际每日运行或经批准配置持续运行服务。
- 原始观测结果位于 `observations/2026-09-10/observation.json`，总审计位于 `a2-audit-final-20260910.json`。总审计不把同日重复、历史补拉、无采集引用或仅declared pass当作有效观察。
- 修复公开feature库打印信息污染单行NDJSON的问题：标准输出只保留协议，响应warnings明确说明出现上游诊断，不保留或转发可能包含秘密的原始诊断文本。
- 输出隔离修复后BaoStock独立复核仍失败，源返回 `10001011 黑名单用户，请与管理员联系`；停止该来源，没有轮换身份/网络绕过。北交所规则正文直接下载返回HTTP403，未绕过，网页摘录不提升为原始hash证据。
- 核对代码仍发现A2风险前置缺口：历史回归因子集合来自终点活跃风格，财报契约只支持单报告期一行，实际历史多版本未接入CNE6风险生成；不以测试通过代替这些工作完成。
- 本轮新增15项A2审计测试，覆盖空资产、篡改、symlink、引用缺失、日期倒灌/跨日/过早运行、重复会话及sample不晋级。首次复现2项证据门禁缺陷后修复并全部通过；真实进程输出隔离回归2项通过。
- GitHub CLI未认证，无法执行push/PR；用户可在当前会话运行 `! gh auth login`。未创建PR，未提交声称A2完成的commit或标签。

## 2026-09-11 后续执行：真实判定 riskModel 与 tradingStatusConsistency

本轮把两条原为 `not-run`/仅计数的门禁改为确定性代码在真实样本上判定，并把结论写入 sample 报告与 `a2-audit`。样本重建产物固定为 `candidate-v7`，`replay-v7` 逐字节复算一致。风险模型对全市场 `riskAcceptance` 仍 blocked。

- **riskModel（样本可行性）= blocked**：新增 `risk_model_probe` 用点时行业成员区间（`_pit_industry_lookup`，重叠/无区间判 None，不回填当前分类）逐评估日测 CNE6 截面是否满秩。因子数 `K = 1(country) + 行业哑元 + 风格数`。真实结果：24只样本评估窗内 **2597 个正常成交日全部 rank-deficient（N≤K）**——去掉分析师情绪后 8 风格模型 0 天可行、9 风格模型 0 天可行、仅“价值+质量”2 风格才有 1170 天可行；单日最大截面仅 20 只。结论：**24只样本在数学上无法识别 CNE6 因子收益**，需要点时行业、点时流通股本与全市场宽度后才能估计并验收协方差。`riskAcceptance`（全市场）随之 blocked，不是“未跑”。
- **tradingStatusConsistency = blocked（原因已精确分类，不放松）**：18 条冲突全部是同日源冲突——`suspend_d` 返回全天停牌（`suspend_type=S`、`suspend_timing` 空）而 `daily` 同日返回成交bar。日期范围 **2009-02-23 至 2012-07-06，全部落在 2016 评估窗之前（评估窗内冲突=0）**，但仍处 warm-up，需与交易所官方停牌公告逐条对账后才能消除，未与真实公告核对前保持 blocked。冲突明细（securityId+date）与分类写入 `candidate-v7/acceptance.json` 的 `tradingStatusConflicts`。
- `a2-audit` 现要求 sample 报告必须携带 `riskModelProbe` 与 `tradingStatusConflicts` 诊断，缺失即拒绝；新增门禁 `riskModelFeasibility`（样本域）与保留的 `riskAcceptance`（全市场域）分列，审计恒 `status=blocked`、`promotionAllowed=false`、`readyForA3=false`。
- **20 交易日增量真实观察仍为 1/20**：`observations/` 仅 `2026-09-10` 一天真实收盘后采集证据；本轮未新增真实交易日（不可在单会话伪造时间经过）。`incrementalPublicationStability` 保持 blocked，`acceptedPublicationDays=0`。
- 本轮新增/更新单测：`test_data_sample.py` 增 6 项（点时行业区间解析、重叠判 None、rank-deficient 判定、满秩才 pass、非成交/空窗忽略），`test_a2_gate.py` 增 2 项（riskModel/riskModelFeasibility/riskAcceptance 门禁与诊断透出、缺诊断即拒绝）。定向套件 32 项通过。

## 剩余门禁与精确原因（供后续会话续接）

样本工程域已 pass 的门禁：`hashIntegrity`、`SSE_SZSE_calendar_continuity`、`sampleRawPriceCoverage`、`corporateActionSettlementDates`、`benchmarkPriceTotalReturnContinuity`、`artifactIntegrity`。以下为仍未清零项，均无法在本会话诚实变 pass：

| 门禁 | 状态 | 精确原因 | 解除所需（下一步） |
|---|---|---|---|
| `BSE_identity_calendar` | blocked | 北交所接口日历返回空；只标 provider-convention-proxy（4,705 证券日）；官方规则正文直接下载 HTTP 403，未绕过 | 授权/官方来源核验北交所成立时间、新三板/精选层/转板/换码与交易日规则 |
| `originalFinancialVintages` | blocked | 财报保留 report_type 1/4/5，但精确首次可得/原件版本未逐条核对；`source_available_at=null` | 采购/授权原始季报原件与披露时间戳，确定性重构 TTM/MRQ |
| `industryPublicationTime` | blocked | SW 成员有 in/out 日期但不等于首次披露时点；当前工作簿不能证明历史 vintage | 授权行业分类 vintage/首次可得时间，显式映射历史taxonomy |
| `tradingStatusConsistency` | blocked | 18 条同日“成交 vs 全天停牌”源冲突（2009–2012，评估窗前）；已精确分类 | 与交易所官方停牌公告逐条对账 |
| `fullMarketHistoricalMaster` | blocked | 24只样本+D日截面不能代表全市场逐历史时点集合 | 授权有效期化全市场证券主表，逐时点解释纳入/排除 |
| `benchmarkOriginalPublication` | blocked | 指数返回最新文件而非历史 as-of vintage；缺原件发布时间与逐日调样血缘 | 授权 CSI300/800 历史成分/权重/价格与全收益，含方法学 |
| `historicalIndexConstituentCoverage` | blocked | 仅一份 2026-08-31 权重快照，不是 2016..D 历史成分/权重 | 同上，构建历史成分/权重后再推全市场 |
| `riskModelFeasibility`（样本） | blocked | 24只样本截面 N≤K，2597/2597 评估日 rank-deficient，无法识别 CNE6 因子 | 点时行业 + 点时流通股本 + 全市场宽度 |
| `riskAcceptance`（全市场） | blocked | 无全市场 42-descriptor/风险覆盖与协方差校准；样本域也无法估计协方差 | A2 全市场数据通过后运行全量风险验收（对称/PSD/重构/修复幅度阈值见契约） |
| `fullMarketCoverage` | blocked | 未做全市场分区构建与分层覆盖 | 断点续传按日/证券块构建，只重试失败分区 |
| `incrementalPublicationStability` | blocked | 真实收盘观察 1/20；不可伪造时间经过 | 实际每日运行 `observe`，累计 20 个真实交易日 |
| `twentyDayIncremental`（sample 报告位） | not-run | 同上，属持续运行验收 | 同上 |


## 下一工作包

不要求用户再构建数据，继续由项目工具执行：

1. 修复并独立核对BSE历史证券身份（成立时间/新三板/精选层/转板/换码）、官方交易日与有效期规则；全市场主表逐历史时点解释，不只当前列表。
2. 对18个warm-up停牌冲突逐源/官方公告核验；历史公司行动按现金/股份类型及实际消费窗口核对，不能把纯送转无pay_date误当缺失现金，也不得凭经验补零/补同日。
3. 扩展金融/非金融、三所、退市和修订报告原件金标准；支持date-only可得时间区间，而非要求不必要的伪精确时间。先冻结区间消费规则，若与A0严格门槛不一致必须登记新契约，不能暗中把unknown改成safe。
4. 在以上样本门禁通过后构建历史CSI300/800的完整成分/权重，再按日/证券块推进全市场。20交易日增量持续观察不能压缩为一次会话。
5. A2实质门禁通过后才进入A3优化器升级；A0/A1和本轮工程版本不代表A2数据或投资策略通过。
