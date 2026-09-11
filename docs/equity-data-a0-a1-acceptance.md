# A0 / A1 验收与版本冻结记录

日期：2026-09-10（Asia/Shanghai）。对应 `docs/equity-research-smart-beta-plan.md` 的 A0、A1；不包含 A2 全市场验收或 A3 优化器升级。

## 结论与范围

- A0 用途、六个宇宙、日期、历史窗口、覆盖率、数值容差及资源预算已冻结在 `config/equity-data-acceptance.json`。
- A1 的 12 个数据域均登记字段、候选来源、代码证据、时点缺口、授权类别和 DATA-01…12 待办；11 个为必需域，分析师域为可选。**矩阵完整不等于来源已合格。** 当前没有任何域完成全历史独立验收。
- 运行 `acceptance` 只做盘点与候选 schema/完整性/时间顺序校验；不修改 CURRENT，不认证原始来源，不准入策略。来源缺口仍返回 `dataAcceptanceStatus=blocked`、`strategyPromotionAllowed=false`。
- 工程阶段的总门禁与不可变源码版本以 `.runtime/equity-baselines/equity-a0-a1-*/manifest.json` 为准；只有其中 `checks.status=pass` 的版本才是本次验收基线。该目录保存完整源文件清单、源码 tar、差异补丁、运行环境/锁文件版本及检查日志。此文不会将一个尚未运行的门禁提前写成通过。
- 没有提交、推送、下单、采购数据、读取浏览器凭据或改写飞书文档。版本先采用本地内容寻址源码快照；后续若获明确授权，可另建 Git 提交/标签。

## A0：冻结内容

| 项目 | 冻结值 / 证据 |
|---|---|
| 起点 Git HEAD | `51c8a5d43a84f29b1e736ea99a7dfc1e19174a8b`，dirty worktree；保留上一轮全部改动 |
| 入口源码快照 | `equity-a0-entry-d85acd7f0b319d0f`；完整 tree hash `d85acd7f0b319d0f9dd42700b50395b62238430137a385e2dc774633834e8043`，入口未重新运行总门禁 |
| 当前契约版本 | `equity-data-a0-a1-v1` |
| 契约 SHA-256 | `0b35a6141398001e016e54d3f4a16a409809fa4f4213e661d83961957169996a`，Node 与 Python 对文件字节计算一致 |
| 固定 D | `2026-09-09`；任务开始为 UTC `2026-09-09T20:14:38Z`，上海已是 9 月 10 日凌晨 |
| D 的适用含义 | SZSE 官方月历确认开市，Sina 已观测该日日线；证明该日行情已有公开输出，不证明全市场已发布，更不证明内部正式风险快照存在。全市场 publication gate 仍 blocked |
| 目标评估窗口 | `2016-01-01` 至 D；不足必须记 blocked，不缩窗冒充完成 |
| warm-up | 首次评估前至少 1576 个交易日价格：1040 长期窗口 + 273 skip + 11 smoothing + 252 风险回归；首个暴露前至少 6 个已可得年度报告。实际起点必须由交易所历史日历和公告时点倒推，不按自然年伪造 |
| 范围 | SSE/SZSE/BSE 历史普通 A 股；包括退市、ST、IPO、停牌；金融、基金、债券等类型不能靠代码前缀混淆 |
| 宇宙 | U_all / U_eligible / U_model / U_research / U_hold / U_benchmark 分别定义，保留排除原因和原始分母 |
| 研究用途 | research-diagnostic 可披露降级；strategy-validation 禁止未知 PIT、当前行业/股本回填历史 |
| 基准 | CSI300 主基准，CSI800 稳健性；价格/全收益明确区分，首个投资池为历史 CSI800，验收分母仍为全市场 |
| 覆盖门槛 | 全市场解释、消费 PIT/价格、持仓/使用基准风险与约束输入 100%；正常行情 ≥99.5%；合格池风险名称 ≥98%、流通市值 ≥99.5% |
| 数值门槛 | 对称绝对误差 ≤1e-10；PSD 容差 1e-10；协方差重构相对误差 ≤1e-8、绝对误差 ≤1e-12；相对 Frobenius 修复幅度 ≤1%；现金按分核对，硬约束 0 违规 |
| 规模预算 | 50/300/800/全市场；800 只 P95≤60s，全市场≤180s，峰值≤8GiB；仅冻结预算，尚未声称实测通过 |
| 采集预算 | 初批 24 只，沪深北各 8；1 worker、间隔≥1s、单请求≤20s、最多30个请求/600s、同轮不重试；认证/限流/验证码/schema 错误即停，不轮换代理绕过 |

冻结配置的每次变动必须产生新内容 hash 和新实验/验收版本。已有 CNE6 `config.yaml` 的 2015 年基准起点、当前股票名单以及默认 qfq/Sina fallback **没有被自动改成上述已合格数据**。

## A1：真实环境盘点

本轮只检查项目配置和指定数据根，不扫描其他项目或个人目录寻找凭据。

- 仓库根 `.env` 不存在。
- 进程未配置 `TUSHARE_TOKEN` / `TUSHARE_MCP_URL`、`IFIND_MCP_URL` / `IFIND_MCP_CREDENTIAL`、`CNE6_DATA_ROOT`。
- 默认 `packages/combinatorial-optimization/data` 不存在，无 CURRENT/quality-report。
- 当前 TuShare mapper 只覆盖 stock_basic / trade_cal / daily / fina_indicator 等四类能力，**配置 token 也不等于获得原始财报、历史股本、行业 vintage、公司行动、CSI 权重等全部内容**。
- 软件/provider 可用性不证明数据许可；公开访问不等于允许批量再分发，完整历史数据授权须由数据责任人提供证据。

### 数据缺口与下一动作

机器可读的逐字段来源矩阵位于冻结 JSON；下表是人读索引。

| 待办 | 域 | 当前问题 | 解除条件 |
|---|---|---|---|
| DATA-01 | 证券主表 | 当前/单证券列表不能代表三交易所历史、退市和 ST | 提供合法有效日期化主表及标识映射；独立核对历史退市/BSE/ST 样本 |
| DATA-02 | 日历 | 只观测 SZSE 当月；feature 返回整月且可能截断 | 三交易所历史日历/会话/规则证据，消费者严格限制窗口，保留完整分母 |
| DATA-03 | 原始行情 | 东财 transport 失败；Sina 单位/复权/历史修订未经独立确认 | 合法 raw 历史源、原文单位与 adjustment 证明、退市/BSE 覆盖，不混用复权数据成交 |
| DATA-04 | 停牌/涨跌停 | 事件榜单不是每个证券日的完整状态 | 完整历史可交易方向/停复牌/上下限及当时可得时间，未知阻断交易 |
| DATA-05 | 交易规则 | 当前固定 100 股不是所有板块历史规则 | 原始规则版本、tick/minimum order/零股/结算/费率表；未支持范围显式排除 |
| DATA-06 | 股本 | 当前市值/价格反推历史，总市值等同流通市值 | PIT 总/流通股本和生效事件，替换两个 cap proxy |
| DATA-07 | 行业 | 历史表有 start/update，不代表历史首次可见 vintage | 行业分类版本、有效日期、公告可得时间与历史修订原件 |
| DATA-08 | 财务 | 年报代 TTM/MRQ、May-1 推断、原公告来源丢失 | 原始及修订季报、合并口径、单位/日期/定位证据，可确定性重建 TTM/MRQ |
| DATA-09 | 公司行动 | 公共 helper 丢 record/pay/新增股份可卖日，缺字段置零 | 分开所有事件日期与实际执行状态，独立核对每股/每10股单位 |
| DATA-10 | 基准 | 官方 latest 文件不等于历史 as-of，缺 CSI800/全收益 | 授权 CSI300/800 历史成分、权重、调样和两类收益指数 |
| DATA-11 | 研究正文 | 搜索摘要不等于原件及首次披露 | 获准保存的正文版本、内容 hash、段落定位与日期；回溯 LLM 单列泄漏限制 |
| DATA-12 | 可选分析师 | 无合格历史修订源 | 初版固定字典显式停用相关3因子或获得原始 vintage，不填0 |

### 有界 live probes

每项只做最小只读诊断。失败没有修改为通过；所有结果都保留在 `.runtime/`，不把行情正文提交 Git。

| 请求 | 结果 | 用途边界 |
|---|---|---|
| SZSE 2026-09 日历 | available；返回20条并 `truncated=true`，包含请求 endDate 之后日期 | 确认9月9日开市；不拿响应 envelope 的范围冒充行级过滤/全月验收 |
| Tencent feature quote | available；无可证明交易时间字段 | 与 Sina 9月9日价格相符仅供诊断，不能据 fetchedAt 伪造交易日 |
| canonical quote（East Money） | transport / blocked | 不无限重试或绕过 |
| canonical raw bars（East Money） | transport / blocked | 不用 qfq fallback 冒充 raw 成交行情 |
| Sina direct 单证券日线 | available；最后日期9月9日 | `qualityFlag=unverified`，调整/原始单位/PIT 不升为 real；未使用代理池 |

证据 SHA-256：

```text
133b02b35b3468a33222a67002fea8d8afcd0ef2c796c07eded626c3c3a1b106  .runtime/equity-a0-calendar-probe.json
c8a03ece839e2148db1b09b7e25d4cedd84ccc541c8cf5c8adda8da7c04c7408  .runtime/equity-a0-quote-probe.json
05d03f7ddf51ed97f73d33ea98e723b5b57d965b779422baffc1faef50428815  .runtime/equity-a0-canonical-quote.json
f5224910a73b074c4a99d52bd90ad9bffcd003d5c456cf1e5cbcf3bc5c355747  .runtime/equity-a0-bars-probe.json
923dca73bc3afebc7a1887edb0619527413d4ace66c3bcc9330788eeb0827026  .runtime/equity-a0-sina-date-probe.json
13e9700d2381ac69f5971084187e5b7238095300e9b21f30161a69af48aa386c  .runtime/equity-a0-a1-accepted-inventory.json
```

## 发布契约与验证

实现位置：`cne6_engine/data_sources/acceptance.py`，CLI 复用 `cne6_engine.data_sources.cli acceptance`；未创建新 package 或并行 provider。

- 候选布局为 `manifest.json` + `reference/*.jsonl`。manifest 绑定契约、代码、规则、六个宇宙、来源许可类别和证据 hash、时间窗口、质量矩阵和逐证券失败清单。
- 每条记录保留 domain/securityId/field/value/unit/currency、经济有效时间、来源可得时间、实际首次获取及修订获取时间、原文 hash/版本/locator、qualityFlag/reason。
- 候选 `publishedAt` 和 `availableAt` 必须为 null，不能在未验收时声称已正式发布或生成可用信号；正式发布及信号时间校验属于后续 A2/A4。
- 原始来源时间未知只能降级诊断，不能进入 strategy-validation。回溯模式另存 simulationAsOf/reconstructedAt，不伪造历史 firstFetchedAt。
- coverage 必须与 validCount/totalCount 一致，原始 denominator 定义与 hash 均必需；**A1 校验分母身份及算术，不认证外部主表的真实性或完整性**。
- 拒绝重复 JSON key、NaN/Infinity/浮点溢出、未来来源、越界行情、错误币种、缺字段、资产 hash/大小/行数不符、重复行和不安全文件名/最终文件 symlink。
- 尚不承诺对抗本地恶意进程并发替换目录；这些是受信任运维发起的本地候选检查，不暴露为 Agent 任意路径工具。
- `strategy-validation` 的 real/许可 hash 是必要而非充分条件：返回始终 `promotionAllowed=false`；不得把手填 real 或格式正确的 SHA 当独立证据。

运行命令（从仓库根）：

```bash
uv run --project packages/combinatorial-optimization --offline --no-sync --no-env-file --no-config python -m cne6_engine.data_sources.cli acceptance --output .runtime/equity-a0-a1-run.json
uv run --project packages/combinatorial-optimization --offline --no-sync --no-env-file --no-config python -m cne6_engine.data_sources.cli acceptance --candidate /absolute/path/to/candidate
uv run --project packages/combinatorial-optimization --offline --no-sync python -m pytest -q packages/combinatorial-optimization/cne6_engine/tests/test_data_acceptance.py packages/combinatorial-optimization/cne6_engine/tests/test_data_rebuild.py
node scripts/freeze-equity-baseline.mjs equity-a0-a1 --check
```

输出以 exclusive-create 保存，重复文件名拒绝覆盖；重跑请用新输出名。freeze 脚本用非忽略 Git 源文件集合生成内容清单，排除 `.runtime`、秘密和构建缓存；检查过程中源码发生变化则拒绝冻结。完整 tar 包保存未跟踪源码，不能仅用 HEAD 或 diff hash 冒充完整版本。

### 已执行小范围验证

- 新验收测试30项 + 原有发布回归12项：42 passed。
- 测试生成第1轮 26 passed / 2 failed，分别确认 JSON 指数溢出、行情窗口未核对；修复源码后两项断言保持不变并通过，再补正式发布时间与分母身份负路径。
- 覆盖正常诊断、retrospective、缺失 PIT、来源/获取/修订时间、伪覆盖、授权、币种、日期窗口、哈希、重复、symlink、路径穿越、CURRENT 不变。
- Node/Python 对冻结配置原始字节 SHA-256 一致。此为跨语言 hash 检查，不宣称实现了 TS 的全部发布 schema。
- 第一次总门禁在安全扫描停止：把数据权限描述命名为 `authorization` 触发 credential-assignment；已改为 `usageRights` 并通过原扫描，未修改扫描器或白名单。入口 tar 的 macOS AppleDouble 元数据经复核不影响全部521个源文件内容；最终 freeze 禁止写入额外元数据。
- 总 `pnpm check` 的最终出口、日志 hash、运行时与源码 hash 由前述验收基线 manifest 记录；数据有效性与策略有效性仍分别 blocked / not-evaluated。

## 下一个工作包：A2 前置核验

A0/A1 基线固定后，仅推进 A2；不跳过数据缺口去并行改 A3 optimizer 或 B1 Smart Beta。

已冻结 A2 首批：24只，沪深北各8；金融/非金融、ST、IPO、长期停牌、退市历史、分红、送转/拆股、低流动性均须有真实证据。按历史主表和确定性 securityId 排序选样，记录 selection input hash；不能先看未来表现再选择样本，也不能将不存在的类别标签硬贴在今天的股票上。

**当前 A2 acquisition = blocked**：DATA-01 历史主表、DATA-02 三交易所历史日历、DATA-03/04/06/07/08/09/10 关键 PIT 字段与授权尚未完成。用户下一步需提供已有授权数据根或明确可用数据服务及字段权限（不要在聊天发送 token）；若没有，先确认采购/授权方案，不能擅自购买。公开来源可以继续在已登记小预算内做诊断，但不得把诊断样本冒充全市场验收。

解锁后顺序：只读验证授权及文件清单 → 固定24只 selection manifest 和源文件hash → 取样/原文金标准抽检 → 候选发布/schema及A2实质门禁 → 历史CSI300/800 → 全市场分区 → 20个实际交易日增量观察。失败保留 last-good 和逐分区原因，不降低分母或门槛。
