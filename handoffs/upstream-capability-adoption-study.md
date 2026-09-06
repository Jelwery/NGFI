# NGFI 外部能力迁移深度调研

> **Historical input:** 本文是 Phase 2 迁移前的调研快照。实现状态与当前入口以 `docs/capabilities/manifest.json`、`docs/capabilities/status.md` 和根 README 为准。

> 调研日期：2026-09-06
> 对象：ai-berkshire、Vibe-Research、a-share-accumulation-breakout、daily_stock_analysis、agent-agnostic-stock-skills、panda_quantflow、dsh-trading，以及当前 NGFI 工作树。
> 用途：供后续实现 Agent 做代码级迁移。本报告不是产品竞品分析。

## 一、范围与核心结论

本轮采用三个边界：NGFI 数据层正在单独建设，不比较数据源和抓取覆盖，所有新增能力必须消费现有 canonical data contract；平台、Web、桌面端和 Bot 暂不进入近期工作包；许可证只记录、不参与当前技术优先级排序，但正式发布前仍需恢复许可证门禁。

核心结论如下：

1. **最值得迁移的不是某个完整仓库，而是四条能力链**：可审计研究运行、策略与信号、回测与研究验证、组合与反馈。七个上游没有任何一个同时满足 NGFI 的 PIT、来源追踪、确定性计算、DSH runtime 与组合风险要求。
2. **Vibe-Research 是研究可信度层最强的来源。** 它的 evidence、calculations、stages、manifest、report 运行结构，以及证据冲突、数字忠实度、冻结 replay 和共享事实底稿辩论，应该优先迁移[[Vibe schemas]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/schemas.ts)。
3. **a-share-accumulation-breakout 是量化研究治理最强的来源。** 重点不是一个突破公式，而是不可变 SignalObservation、策略语义 hash、执行定义、生命周期、IS/OOS、walk-forward、CSCV-PBO、成本压力和策略晋级[[Breakout contracts]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/strategies/contracts.py)。
4. **daily_stock_analysis 最值得迁移的是 outcome、反馈、校准和多能力冲突处理。** 它已经把分析意见变成有期限和生命周期的 DecisionSignal，并按期限、市场阶段、数据质量和决策风格做后验分组[[DSA decision signals]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/docs/decision-signals.md)。
5. **dsh-trading 最有价值的是纯函数能力和插件验证。** 指标、策略、screener、信号序列验证、多场景试算与 staged-confirmed 台账都可借鉴；它的简单回测器只适合作为 smoke engine[[dsh strategies]](https://github.com/zhu1090093659/dsh-trading/tree/c942057723ca7054519414575101e6bcc5ef7128/packages/strategies)。
6. **QuantFlow 的能力目录有价值，但现有实现应重写。** 因子 IC、相关性、分组和组合是 NGFI 中期所需能力；但代码强依赖 panda_factor，主因子节点测试稀少，部分调用存在明显类型或参数问题[[QuantFlow factor nodes]](https://github.com/PandaAI-Tech/panda_quantflow/tree/688b90e74a738b84567efe622a2d9c1e5ce10e00/src/panda_plugins/internal)。

推荐建设顺序：

~~~text
研究对象与运行账本
  → 报告、数字与引用审计
  → 策略、信号与执行语义契约
  → 最小回测 + OOS/WF/过拟合控制
  → 信号 outcome 与校准
  → 第一条策略插件
  → 多路研究辩论与融合
  → 因子研究与组合风险
~~~

## 二、NGFI 现状与真正缺口

### 2.1 已有能力，不应重复建设

- DSH Web 与 headless 已共用 finance-analyst preset 和工具集合，运行环境隔离，见 [README](../NGFI/README.md:138)。
- A 股已有 capability 级 provider contract。InstrumentId、DataCapability、CanonicalDataResult、DataProvenance、显式状态和 fallback chain 位于 [data-v2 contracts](../NGFI/packages/finance-core/src/data-v2/contracts.ts:20)。
- provider 质量等级、认证模式、重试、限流、熔断和路由已经位于 [data service](../NGFI/packages/finance-data-service/src/types.ts:42)。外部项目的数据抓取层不应再建立平行实现。
- WACC、DCF、敏感性和相对估值已有确定性 TypeScript 实现，见 [valuation.ts](../NGFI/packages/finance-core/src/valuation.ts:16)。
- 行为市场证据与交易行为审计已有工具、Skill 和 eval。
- CNE6 已有因子收益、因子协方差、特异风险和数据构建代码，缺的是面向组合任务的高层接口。
- 工作区根部的公司财务分析、宏观周期与政策分析、投资行为诊断三套本地 Skill，已经覆盖大量方法知识。外部 Skill 若只重复这些知识，不应优先迁移。

### 2.2 真正缺失的公共能力

| 能力 | 当前状态 | 直接影响 |
|---|---|---|
| Research Case | 只有路线图设计 | 研究仍依附会话，不能稳定更新、冻结和比较 |
| Evidence/Claim/Assumption/ModelRun | data provenance 已有，研究账本没有 | 数据能追踪，结论和假设不能机器回溯 |
| Run manifest 与 artifact gate | 缺失 | 无法严格区分 complete、partial、failed |
| 报告数字忠实度 | 只有回答 rubric | 引用可能真实，但同行数字仍可能写错 |
| Strategy/Signal 公共契约 | 缺失 | 基本面、技术和事件信号无法统一比较 |
| Research-grade BacktestRun | 缺失 | 策略、配置、快照、成本、基准和结果不能绑定 |
| OOS/WF/PBO | 缺失 | 新策略没有统一准入门槛 |
| Signal outcome/calibration | 缺失 | 无法持续学习能力的适用条件 |
| 多路冲突审阅 | 缺失 | 多空与跨能力冲突没有结构化裁决 |
| Alpha factor research | 缺失 | 因子 idea 到验证和组合的链条未形成 |

外部能力迁移必须先建立公共“插座”，再接具体策略和研究方法。直接复制大量 Skill，会扩大无法度量的输出面。

## 三、逐仓库能力拆解

### 3.1 Vibe-Research：研究运行、证据与准出

**运行产物契约。** 一次研究被拆成 raw、fetch、evidence、calcs、calculations、stages、events、report 和 manifest。Calculation 包含函数版本、输入、输入引用和结构化输出；stage 引用 evidence 与 calculation；manifest 记录代码、配置、模型和原始文件 hash[[Vibe schemas]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/schemas.ts)。它与 NGFI 路线图中的 Research Workspace 高度一致。

**证据合并与冲突检测。** mergeEvidence 按 id 去重时比较决定事实语义的字段，避免值相同但单位或市场不同的事实被静默折叠；detectSourceConflicts 按证券、市场、字段、期间、复权、单位和记录键聚类，只把跨来源不同值记为冲突[[Vibe merge]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/merge.ts)。

**阶段校验与准出。** validator 检查必需能力、必需计算、gap、引用存在性、计算输入与引用一致性、来源冲突覆盖、报告章节和合规规则。其价值是“失败必须出声”，而不是要求所有步骤永远成功[[Vibe validator]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/validator.ts)。

**数字忠实度。** number_fidelity 抽取报告中的数字，判断它能否绑定到同一行引用的 evidence 或 calculation，并区分计算输入、中间量、格式化输出和无来源数字[[Vibe number fidelity]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/number_fidelity.ts)。这是比随机抽检更适合作为主门禁的机制。

**冻结回放与变化检测。** fixture 锁定来源运行、数据日、模型或计算口径和文件 hash，拒绝路径越界与篡改；alerts 对两个运行的 evidence 做字段级 diff[[Vibe fixture]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/fixture.ts)[[Vibe alerts]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/alerts.ts)。

**共享事实底稿的对抗审阅。** 多方、空方、反驳和裁判使用同一不可变 dossier，每个阶段是独立会话，只能看到契约允许的前序阶段；空 dossier 拒绝启动，阶段输出另做数字审计[[Vibe debate]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/debate.ts)。

迁移裁决：schemas、merge、number fidelity 和 fixture 为 **Adapt/P0**；validator 围绕 NGFI 契约重写；debate 与 arithmetic 为 **Adapt/P1**；calc 中季度累计转单季、TTM、前瞻 CAGR、一致预期分歧和估值消化年数是当前计算库的有效补充[[Vibe formulas]](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/calc/formulas.py)。

### 3.2 a-share-accumulation-breakout：策略治理与研究验证

**策略身份。** StrategySpec 同时要求版本、经济假设、失效条件、PIT 测试说明和 golden fixture；SignalObservation 绑定 strategy hash、input hash、snapshot、config hash、信号日和执行定义[[Breakout contracts]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/strategies/contracts.py)。

**信号与执行分离。** 策略在某日收盘产生观察，统一执行定义规定下一可交易日开盘；golden fixture 锁定定义快照、语义 hash 和代表性输出[[Breakout entry definition]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/domain/entry_definition.py)。

**注册与晋级。** 策略状态覆盖 experimental、candidate、shadow、active、retired、rejected，单插件异常不拖垮其他插件，只有达到研究状态门槛才能进入候选池[[Breakout registry]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/strategies/registry.py)。

**独立信号样板。** 仓库含吸筹突破、波动收缩、趋势回踩、平台突破、超卖反转和相对强度等插件[[Breakout strategies]](https://github.com/fredombobo/a-share-accumulation-breakout/tree/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/strategies)。它们不都值得成为生产策略，但适合作为插件契约和相关性测试样本。

**研究验证链。** run_is_oos 先在 IS 选择参数，再冻结候选和预声明邻域到 OOS；wf_recheck 用多个训练/测试窗口并要求最小样本、回撤和 OOS/IS 衰减达标[[Breakout walk-forward]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/walkforward.py)。cscv_pbo 估计参数选择过拟合概率，NaN、Inf 和样本不足时 fail closed[[Breakout CSCV]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/research/cscv.py)。

**组合回测与结果修订。** 研究层模拟资金占用、重叠信号、组合仓位、拒绝原因、基准和双倍成本压力[[Breakout portfolio accounting]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/research/portfolio_accounting.py)。Outcome 区分 matured、unfillable、expired，无法成交的收益为 null，修订 append-only[[Breakout outcomes]](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/application/signal_outcomes.py)。

迁移裁决：StrategySpec、SignalObservation、identity 和 registry 为 **Adapt/P0**；entry definition、lifecycle 和 outcome revision 为 **Adapt/P0-P1**；成本模型、组合核算、baseline、walk-forward、CSCV-PBO、deflated Sharpe 和 minimum track record 为 **Adapt/P1**；accumulation breakout 为 **Adapt/P1** 的首个完整插件。SQLite、Web 和纸面账户不迁移。

### 3.3 daily_stock_analysis：反馈、多能力融合与 Agent 评测

**DecisionSignal。** 它将报告判断单独持久化，包含来源、动作、置信度、分数、期限、市场阶段、计划、失效条件、证据、数据质量和生命周期，并明确它不是订单[[DSA decision signals]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/docs/decision-signals.md)。NGFI 应吸收字段维度，但应避免把 LLM 建议和确定性量化信号混为一类。

**后验与校准。** Outcome 可按 action、horizon、market phase、data quality、decision profile 和来源分组；样本不足 30 时保留计数但不发布命中率，并计算最大不利波动[[DSA outcome service]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/src/services/decision_signal_outcome_service.py)。

**聚合与冲突。** SkillAggregator 剔除非法信号，按置信度和历史表现加权，证据不足回落为中性，并保留各路信号；ConflictDetector 区分方向冲突、分数离散、高置信异议和调整矛盾[[DSA aggregation]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/src/agent/skills/aggregator.py)[[DSA synthesis]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/src/agent/skills/synthesis.py)。

**Deliberation 与 trajectory eval。** 它支持规则式、LLM 式、自我复核和多轮调停，并记录意见修订[[DSA deliberation]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/src/agent/skills/deliberation.py)。Trajectory eval 衡量预期工具命中、遗漏、重复调用、失败重试、缓存和步数预算[[DSA trajectory metrics]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/evals/agent_trajectory/metrics.py)[[DSA trajectory tests]](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/tests/test_agent_trajectory_metrics.py)。

迁移裁决：Signal outcome、feedback、样本门槛和分组校准为 **Adapt/P1**；ConflictDetector 和低敏感分歧摘要为 **Adapt/P1**；多轮 deliberation 为 **Reference/Adapt/P2**，先采用 Vibe 的共享 dossier；trajectory eval 为 **Adapt/P1**。ResearchArtifact 只作 legacy import 参考，NGFI 应从 ledger 正向生成 memo。模型自报 confidence 只有经 outcome 校准后才能影响权重。

### 3.4 dsh-trading：指标、策略扩展与持仓确认

**纯函数指标包。** IndicatorDefinition 把参数和 compute 统一起来，SMA、EMA、BOLL、MACD、RSI、KDJ 都与输入 K 线逐条对齐，warm-up 显式为空[[dsh indicators]](https://github.com/zhu1090093659/dsh-trading/tree/c942057723ca7054519414575101e6bcc5ef7128/packages/indicators)。这套实现轻、测试充分，可作为 NGFI 技术分析内核的起点。

**Strategy 与 Screener 分离。** StrategyDefinition 产生时序 entry/exit 序列；ScreenerDefinition 只在一个 as-of 窗口判断标的是否命中。NGFI 应保留这个区分，避免把全市场选股和单标的交易路径放进一个接口[[dsh strategy types]](https://github.com/zhu1090093659/dsh-trading/blob/c942057723ca7054519414575101e6bcc5ef7128/packages/strategies/src/types.ts)[[dsh screener types]](https://github.com/zhu1090093659/dsh-trading/blob/c942057723ca7054519414575101e6bcc5ef7128/packages/strategies/src/screeners/types.ts)。

**自定义策略验证。** 它检查源码长度、参数边界、编译结果，并在上涨、下跌、平盘、缺口和短序列上试跑；信号必须按时间递增、与 bar 对齐、entry/exit 严格交替，Node 端还通过 vm 设置超时[[dsh validator]](https://github.com/zhu1090093659/dsh-trading/blob/c942057723ca7054519414575101e6bcc5ef7128/packages/strategies/src/validate.ts)。NGFI 即使首期不开放用户代码，也应迁移“插件注册前验证”的思想。

**最小确定性回测器。** 它固定第 i 根收盘确认、第 i+1 根开盘成交，支持手续费、滑点、权益曲线、回撤、Sharpe、胜率、盈亏比和暴露度[[dsh engine]](https://github.com/zhu1090093659/dsh-trading/blob/c942057723ca7054519414575101e6bcc5ef7128/packages/strategies/src/engine.ts)。适合做契约测试和快速 smoke，不适合正式策略准出。

**staged/confirmed 持仓。** Agent 解析出的持仓先进入待确认区，用户确认后才进入正式持仓；写操作带 revision、幂等和原子写[[dsh holdings]](https://github.com/zhu1090093659/dsh-trading/blob/c942057723ca7054519414575101e6bcc5ef7128/packages/holdings/src/types.ts)。这可以直接服务 Portfolio Risk，无需等待 UI。

迁移裁决：indicators math、definitions 和测试为 **Copy/Adapt/P1**；strategy/screener contracts 和 sequence validator 为 **Adapt/P0-P1**；simple backtest 为 **Copy as smoke engine/P1**，必须标注 engine tier；holdings store 为 **Adapt/P1**。自定义源码执行暂缓，未来必须使用进程或容器隔离，不能把 Node vm 当安全边界。

### 3.5 ai-berkshire：估值护栏、报告抽检和论文跟踪

**终值约束。** terminal_value 将终值 PE 写成 (1-g/ROIC)/(r-g)，检查资本成本与永续增长的币种一致性、r-g 最小宽度，并要求离散风险进入情景而不是随意塞进折现率[[AI Berkshire terminal value]](https://github.com/xbtlin/ai-berkshire/blob/f98eff38d01a17a39d95940709afce61e75c8ac7/tools/terminal_value.py)。它比当前标准 Gordon Growth DCF 多了一层估值假设合法性审计。

**报告抽检。** report_audit 能从 Markdown 表格抽取数值、稳定随机抽样，并根据复核值生成准出判决[[AI Berkshire report audit]](https://github.com/xbtlin/ai-berkshire/blob/f98eff38d01a17a39d95940709afce61e75c8ac7/tools/report_audit.py)。它不如 Vibe 的逐引用数字绑定严格，但可作为外部复核抽样层。

**Thesis drift。** 其流程区分事实改变、价格改变和措辞改变，按估值锚点、核心假设、红线、管理层和护城河做 Improved、Unchanged、Weakened 判断[[AI Berkshire thesis drift]](https://github.com/xbtlin/ai-berkshire/blob/f98eff38d01a17a39d95940709afce61e75c8ac7/skills/thesis-drift.md)。这适合映射为 Research Case 的增量更新。

**研究 SOP。** investment-research、earnings-review、management-deep-dive、quality-screen、bottleneck-hunter 和 portfolio-review 都有清晰的证据问题和失败条件[[AI Berkshire skills]](https://github.com/xbtlin/ai-berkshire/tree/f98eff38d01a17a39d95940709afce61e75c8ac7/skills)。应拆成 references 和 workflow，不能把“大师角色”直接当信号源。

迁移裁决：终值 PE、IRR 和三项审计为 **Adapt into finance-core/P1**；report audit 为 **Adapt as secondary audit/P1**；thesis tracker/drift 为 **Adapt/P1**；行业、管理层、盈利复盘等 SOP 为 **Reference/P2**。financial_rigor 中 NGFI 已有的计算不重复迁移。

### 3.6 agent-agnostic-stock-skills：方法 reference

价值主要在 DCF、相对估值、SOTP、WACC/ERP、业绩复盘和一致预期检查的方法说明[[Stock Skills valuation]](https://github.com/24mlight/agent-agnostic-stock-skills/blob/03e4a75910b757b23c40d1d76e68c5d4dd36b838/skills/company-valuation/SKILL.md)[[Stock Skills SOTP]](https://github.com/24mlight/agent-agnostic-stock-skills/blob/03e4a75910b757b23c40d1d76e68c5d4dd36b838/skills/company-valuation/references/sotp.md)。

它的示例直接依赖 yfinance 或 AkShare，计算代码内嵌在 Skill，默认参数带市场和时间假设，HTML 报告又混合取数、分析与渲染。当前 NGFI 已有更严格的工具、估值函数和本地公司财务分析 Skill，不应整包复制。

只提取三类 reference：公司类型到估值方法的路由表；SOTP 的适用条件、分部桥接和 conglomerate discount 检查；earnings recap 的 actual、estimate、reaction、quality 四段式结构。迁移方式为 **Reference/P2**，公式必须进入确定性 core，取数必须使用 NGFI 工具。

### 3.7 panda_quantflow：能力目录有价值，实现应重写

QuantFlow 覆盖公式因子、单因子分析、IC、相关性、分组、权重调整、Spearman 组合、PCA、多类 ML、回测和工作流节点[[QuantFlow nodes]](https://github.com/PandaAI-Tech/panda_quantflow/tree/688b90e74a738b84567efe622a2d9c1e5ce10e00/src/panda_plugins/internal)。这些名称可以帮助 NGFI 设计长期 capability catalog。

但代码不适合首批迁移：多数核心节点只是外部 panda_factor 的薄包装；factor_ic_calculation_node 中存在对 DataFrame 执行 int 转换及错误的 int 参数调用；因子权重节点使用随机 id 并直接修改输入 DataFrame；仓库只发现少量 LLM/code-checker 测试，没有覆盖主要因子节点和回测内核；工作流又与 MongoDB、Redis、消息队列和因子服务深度耦合。

因此 BaseWorkNode、input/output model 和 registry 仅作 **Reference**；IC、RankIC、分组收益、换手、相关性、因子中性化和组合权重按公开定义 **Rewrite/P2**；ML 因子和 AI 生成公式放到 Later；事件驱动回测只作参考，近期以 breakout 的研究验证链为主。

## 四、跨仓库能力裁决

### 4.1 研究与审计

| 子能力 | 主来源 | 辅助来源 | 方式 | 优先级 |
|---|---|---|---|---|
| Research run schema | Vibe | DSA ResearchArtifact | Adapt | P0 |
| Evidence merge/conflict | Vibe | NGFI provenance | Adapt | P0 |
| Calculation lineage | Vibe | NGFI finance-core | Adapt | P0 |
| Stage validator/gap | Vibe | 本地公司财务分析 | Rewrite | P0 |
| 报告引用/数字忠实度 | Vibe | ai-berkshire 抽检 | Adapt | P0 |
| Frozen replay | Vibe | NGFI evals | Adapt | P0 |
| Thesis update/drift | ai-berkshire | Vibe alerts | Adapt | P1 |
| 多空对抗审阅 | Vibe | DSA deliberation | Adapt | P1 |
| Agent trajectory eval | DSA | NGFI evals | Adapt | P1 |

### 4.2 策略、信号与验证

| 子能力 | 主来源 | 辅助来源 | 方式 | 优先级 |
|---|---|---|---|---|
| StrategySpec/SignalObservation | breakout | dsh-trading | Adapt | P0 |
| Screener vs Strategy | dsh-trading | breakout | Adapt | P0 |
| 插件注册与状态晋级 | breakout | dsh validator | Adapt | P0 |
| 指标纯函数 | dsh-trading | Vibe indicators | Copy/Adapt | P1 |
| 信号序列校验 | dsh-trading | breakout golden | Adapt | P1 |
| smoke backtest | dsh-trading | 无 | Copy/Adapt | P1 |
| A 股研究级回测 | breakout | DSA outcome | Adapt | P1 |
| IS/OOS + walk-forward | breakout | 无 | Adapt | P1 |
| PBO/DSR/min track record | breakout | 无 | Adapt | P1 |
| 信号生命周期/outcome | breakout | DSA DecisionSignal | Adapt | P1 |
| 分组校准与反馈 | DSA | breakout outcome | Adapt | P1 |
| 首个突破策略 | breakout | dsh volume screener | Adapt | P1 |
| 因子研究算子 | QuantFlow | breakout validation | Rewrite | P2 |

### 4.3 组合与风险

| 子能力 | 主来源 | NGFI 结合点 | 方式 | 优先级 |
|---|---|---|---|---|
| staged/confirmed holdings | dsh-trading | portfolio-risk | Adapt | P1 |
| 组合资金与成本核算 | breakout | quant-research | Adapt | P1 |
| 市场状态 overlay | breakout | SignalQualification | Adapt | P1 |
| 风险因子/协方差/特异风险 | NGFI CNE6 | 高层 risk API | 保留并包装 | P1/P2 |
| 多因子组合 | QuantFlow | CNE6 + factor lab | Rewrite | P2 |

### 4.4 第一批可以直接搬算法主体的资产

用户判断“可以 copy 的非常多”是成立的，但 copy 的粒度应是纯函数、契约与测试，不是应用目录。下列资产具备较清晰的输入输出边界，适合作为第一批移植候选：

| 源资产 | 建议目标 | 可保留内容 | 必须改动 |
|---|---|---|---|
| Vibe calc/formulas.py | finance-core 或独立 calculation 子模块 | PE、CAGR、PEG、分歧和消化年数公式与 fixture | 改为 TS 或确定统一 Python 边界；复用 NGFI result status |
| Vibe calc/series.py | finance-core | quarterize、latest quarter、TTM、YoY、QoQ | 对接 canonical period/unit；补修订口径 |
| Vibe number_fidelity.ts | research-audit | 数字抽取、scale binding、引用绑定机制 | 领域词法插件化；适配 NGFI Evidence/ModelRun |
| Vibe arithmetic.ts | research-audit | 显式算式重算和错误分类 | 收紧允许表达式；绑定 calculation record |
| Vibe merge.ts | research-core | evidence 去重和跨源冲突 | 事实键改用 InstrumentId/SourceRef |
| Vibe fixture.ts | research-workspace | hash、篡改、路径和 replay 机制 | 使用 NGFI manifest/schema |
| Breakout contracts.py | strategy-core | StrategySpec、SignalObservation、稳定 hash | TypeScript 化；扩展多 signal family |
| Breakout signal_lifecycle.py | signal-evaluation | 状态转移表和 fail-closed | 删除订单态或放入未来扩展；保留研究态 |
| Breakout cscv.py | quant-research | CSCV-PBO 纯统计主体 | 增加固定 tie policy、输入时间索引与输出 lineage |
| Breakout deflated_sharpe.py | quant-research | Deflated Sharpe 纯函数 | 与统一统计结果和 trial registry 对接 |
| Breakout min_track_record.py | quant-research | MinTRL 纯函数 | 明确采样频率与置信水平 |
| Breakout costs.py | quant-research | A 股整手、佣金、印花税、滑点和不可成交规则 | 参数化费率生效日；移除全局配置 |
| dsh-trading indicators/math.ts | technical-analysis | SMA、EMA、BOLL、MACD、RSI、KDJ | RSI 边界需独立复核；删除 UI 字段 |
| dsh-trading strategies/engine.ts | strategy-core smoke engine | 下一根开盘成交、equity 与基础指标 | 加强 bar 校验、期末持仓口径和 engine tier |
| dsh-trading strategies/validate.ts | strategy-core | 信号时间、价格、顺序和状态一致性 | 暂不接动态源码编译；只验证注册插件 |
| dsh-trading holdings/store-core.ts | portfolio-risk | staged/confirmed、revision、幂等 | InstrumentId、多币种与 as-of 扩展 |
| DSA decision_signal_data_quality.py | signal-evaluation | 质量等级归一与最差等级聚合 | 改用 NGFI DataStatus/quality tier |
| DSA disagreement.py | signal-evaluation | 冲突类型和低敏感摘要 | 输入改为统一 SignalObservation |
| AI Berkshire terminal_value.py | finance-core | exit PE、spread audit、离散风险归属 | 删除公司 preset 和日期常量；复核 payout/IRR 口径 |

“可保留内容”指保留算法行为与测试期望；即使技术上可直接复制，也必须通过目标 package 的 public API 暴露，不能让上游文件路径成为 NGFI 的运行时依赖。

## 五、目标架构

建议目录如下，名称可以调整，但职责不要重新塞回一个大 finance-core。

~~~text
packages/
├── research-core/             ResearchCase/Evidence/Claim/Assumption/ModelRun/Gap
├── research-workspace/        case/run 存储、manifest、冻结 replay、diff
├── research-audit/            schema、引用、数字忠实度、报告准出
├── technical-analysis/        纯指标、IndicatorDefinition、validator
├── strategy-core/             StrategySpec/Screener/SignalObservation/registry/lifecycle
├── quant-research/            Python：研究回测、组合核算、WF/PBO/DSR
├── signal-evaluation/         outcome、校准、feedback、weight suggestion
├── portfolio-risk/            holdings + CNE6 高层风险入口
├── finance-core/              现有计算；补终值审计
├── dsh-finance-tools/         稳定领域能力的薄适配
└── dsh-finance-bundle/        只负责组合，不放业务算法

skills/
├── company-research/
├── thesis-review/
├── adversarial-research/
├── strategy-research/
└── portfolio-risk/

evals/
├── frozen-replay/
├── research-audit/
├── strategy-contracts/
├── strategy-oos/
└── agent-trajectory/
~~~

核心对象关系：

~~~text
ResearchCase
 ├─ Evidence[] ───────────────┐
 ├─ Assumption[]              │
 ├─ Claim[] ─ refs ───────────┤
 ├─ ModelRun[] ─ inputRefs ───┤
 └─ ResearchRun/Manifest      │
                              ▼
StrategySpec ── produces ── SignalObservation
                              │
                    Qualification / Regime
                              │
                         BacktestRun
                              │
                    SignalOutcome revisions
                              │
                    CalibrationSnapshot
                              │
                       FusionRecommendation
                              │
              PortfolioProposal + RiskSnapshot
~~~

Evidence 是特定时点可见的事实；Claim 是可被反证的判断；Assumption 是模型主动采用的未知量；ModelRun 是可复算计算；SignalObservation 是某个版本化能力在冻结输入上的输出。这些对象必须分离。

## 六、关键设计决策

### 6.1 Copy 的含义

Copy 只表示算法主体可以复制，不表示保留原路径和外围系统。每次迁移必须先写 NGFI 输入输出契约；把上游算法放进纯函数边界；删除网络、数据库、UI、全局配置和本机路径依赖；复制或重建测试；增加 sourceProject、sourceCommit、sourcePath 元数据；最后用 NGFI fixture 验证。

### 6.2 两级回测引擎

不应在 dsh-trading 轻引擎和 breakout 研究引擎之间二选一：

- smoke：纯 TypeScript、单标的、确定性、毫秒级，验证信号序列与下一根开盘成交。
- research：Python、横截面或组合、交易日历、停牌涨跌停、成本、基准、PIT、OOS、WF、PBO，用于策略准出。

两者共享 StrategySpec、SignalObservation 和 BacktestRun JSON Schema。只有 research tier 可以改变策略晋级状态。

### 6.3 置信度与权重

必须区分 modelConfidence、evidenceQuality、empiricalReliability 和 fusionWeight。模型自报置信度只能用于展示或低权重启发；历史校准和证据质量才可进入融合策略。样本不足时必须回到预注册先验或观察状态，不能根据少量胜率放大权重。

### 6.4 研究 Agent 与策略插件

Research Skill 产出 Claim、counter-evidence、falsifier 和可选 ResearchSignal；确定性策略产出 QuantSignal；事件解析器产出 EventSignal；所有信号进入统一 outcome 和 calibration；只有经校准的 signal family 才参与融合。

多 Agent 辩论用于发现论证漏洞和信息缺口，不等于增加独立 alpha，也不能用 Agent 投票替代样本外验证。

## 七、优先级与里程碑

### P0：公共契约与研究可信度

1. ResearchCase、Evidence、Claim、Assumption、ModelRun、RunManifest。
2. versioned file workspace、原子写和 append-only ledger。
3. evidence merge/conflict、calculation lineage、report citation/number fidelity。
4. StrategySpec、ScreenerDefinition、SignalObservation、ExecutionDefinition、BacktestRun。
5. frozen replay 与 golden fixture。

退出条件：冻结研究可以复跑；重要数字可追到 evidence 或 calculation；相同策略、配置、输入和快照生成稳定 id；篡改输入或报告数字会被测试抓住。

### P1：首个闭环

1. 指标纯函数包。
2. smoke backtest 和 A 股 research backtest。
3. 横盘吸筹—放量突破插件。
4. IS/OOS、nested walk-forward、成本压力、基准和 PBO。
5. SignalOutcome、feedback 和 calibration。
6. report audit、thesis drift、共享 dossier 多空审阅。
7. staged/confirmed holdings 与 CNE6 高层风险调用。

退出条件：策略从 experimental 开始，能在冻结数据上产生可重放信号，完成样本外验证并记录多期限结果；缺失、不可成交或样本不足不能被写成零或通过状态。

### P2：扩展能力库

1. 其余技术策略与横截面 screener。
2. 财报复盘、SOTP、管理层、行业瓶颈等研究 Skills。
3. Agent trajectory eval 和多轮 deliberation。
4. 因子 IC、RankIC、分组收益、换手、相关性、中性化与组合。
5. 研究和量化信号融合与动态权重实验。

退出条件：新增能力只需实现公共接口并提供 fixture/eval；不修改主 runtime；权重变化有历史证据和版本；策略相关性与增量价值可测。

## 八、不建议迁移的内容

- 七个仓库的任何数据抓取层；NGFI 数据层是唯一入口。
- 第二套 Agent loop、MCP server、工作流服务器或任务数据库。
- Web、桌面端、通知、Bot 和图表渲染。
- 从旧 Markdown 报告反向猜 Evidence 的主流程；只允许作为 legacy import。
- 让 LLM 直接计算财务指标、策略收益或组合矩阵。
- 直接执行 Agent 生成的 Python 或 JavaScript 策略代码。
- 把模型自报 confidence 当作可校准概率。
- 在没有 OOS 和最小样本门槛时，根据单次回测自动调高权重。
- 把 no-data、unfillable 或 insufficient 写成收益零或中性信号。
- 同时复制多个策略再补契约；应先用一个策略压实全链路。

## 九、推荐的最小演示链

第一条端到端能力选择“横盘吸筹—放量突破”，验收目标不是证明策略赚钱，而是证明 NGFI 的能力平台成立：

1. 从 NGFI data service 取得冻结日线和市场基准。
2. 写入 DataSnapshotRef 与 hash。
3. 运行版本化 StrategySpec，产生不可变 SignalObservation。
4. 通过 signal sequence 和 execution definition 校验。
5. 使用 smoke engine 做快速一致性检查。
6. 使用 research engine 做组合级含成本回测。
7. 执行 IS/OOS、walk-forward、基准和 PBO。
8. 保存 BacktestRun 与 artifact hash。
9. 策略保持 experimental，除非准入门槛全部通过。
10. 到期后追加 5、10、20 日 outcome，不覆盖旧 revision。
11. 样本足够时生成 calibration snapshot。
12. 把结果作为 Evidence 或 ModelRun 注入 memo，而不是由策略直接写报告。

这条链跑通后，其他技术策略、基本面 signal、事件 signal 和 AI factor 才有统一落点。

## 十、最终结论

如果目标是尽快建设很多能力，最佳路径仍不是把七个仓库各复制一部分到根目录，而是先把它们共同隐含的能力协议抽出来。

近期最值得落地的五组资产依次是：Vibe 的研究账本、证据冲突、数字忠实度和冻结回放；breakout 的策略身份、信号观察、执行定义和研究验证；DSA 的 outcome、校准、反馈与冲突融合；dsh-trading 的指标纯函数、策略验证和两阶段持仓；ai-berkshire 的终值审计、报告抽检和 thesis drift。

agent-agnostic-stock-skills 用于补充方法 reference，panda_quantflow 用于定义 P2 因子能力目录。这样既能大量吸收已有成果，又不会把 NGFI 变成七套不兼容的运行时。

## 十一、调研方法与限制

本报告对七个仓库执行了浅克隆，并按上表固定 commit 阅读核心源码、配置、测试、README 和设计文档；结论以源码与测试为主，README 为辅。由于本轮明确排除数据调研，没有验证任何真实数据端点、数据条款、覆盖率或时效性；也没有运行七个仓库的完整依赖安装、live test、回测收益复现或生产压测。因此本文的“成熟”表示契约、实现边界和测试证据相对完整，不表示策略能产生真实超额收益。

GitHub 搜索对这些 2026 年仓库与 commit 尚未形成有效索引，本轮外部事实主要来自固定 commit 的实际仓库内容，而不是搜索摘要。正式迁移时应重新确认目标 commit，并把行为 fixture 固定在 NGFI 仓库中。

具体实施任务、文件所有权和可直接交给新 Agent 的提示词见 [实施工作包](./upstream-capability-work-packages.md)。

## 参考资料

1. [NGFI README](../NGFI/README.md)
2. [NGFI data-v2 contracts](../NGFI/packages/finance-core/src/data-v2/contracts.ts)
3. [NGFI evolution roadmap](../NGFI/docs/ngfi-evolution-roadmap.md)
4. [Vibe-Research schemas](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/schemas.ts)
5. [Vibe-Research evidence merge](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/merge.ts)
6. [Vibe-Research validator](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/validator.ts)
7. [Vibe-Research number fidelity](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/number_fidelity.ts)
8. [Vibe-Research fixture](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/fixture.ts)
9. [Vibe-Research debate](https://github.com/simonlin1212/Vibe-Research/blob/09e8404a33ba0d05e036e01207be4701c61d692c/orchestrator/src/debate.ts)
10. [Breakout contracts](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/strategies/contracts.py)
11. [Breakout registry](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/strategies/registry.py)
12. [Breakout walk-forward](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/walkforward.py)
13. [Breakout CSCV-PBO](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/research/cscv.py)
14. [Breakout portfolio accounting](https://github.com/fredombobo/a-share-accumulation-breakout/blob/c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453/ab_screener/research/portfolio_accounting.py)
15. [daily_stock_analysis DecisionSignal](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/docs/decision-signals.md)
16. [daily_stock_analysis aggregation](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/src/agent/skills/aggregator.py)
17. [daily_stock_analysis deliberation](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/src/agent/skills/deliberation.py)
18. [daily_stock_analysis trajectory metrics](https://github.com/ZhuLinsen/daily_stock_analysis/blob/303f4e1c18b7e149bc2b7618eb63a6574507bc6b/evals/agent_trajectory/metrics.py)
19. [dsh-trading indicators](https://github.com/zhu1090093659/dsh-trading/tree/c942057723ca7054519414575101e6bcc5ef7128/packages/indicators)
20. [dsh-trading strategies](https://github.com/zhu1090093659/dsh-trading/tree/c942057723ca7054519414575101e6bcc5ef7128/packages/strategies)
21. [dsh-trading holdings](https://github.com/zhu1090093659/dsh-trading/tree/c942057723ca7054519414575101e6bcc5ef7128/packages/holdings)
22. [AI Berkshire terminal value](https://github.com/xbtlin/ai-berkshire/blob/f98eff38d01a17a39d95940709afce61e75c8ac7/tools/terminal_value.py)
23. [AI Berkshire report audit](https://github.com/xbtlin/ai-berkshire/blob/f98eff38d01a17a39d95940709afce61e75c8ac7/tools/report_audit.py)
24. [AI Berkshire thesis drift](https://github.com/xbtlin/ai-berkshire/blob/f98eff38d01a17a39d95940709afce61e75c8ac7/skills/thesis-drift.md)
25. [Agent-agnostic valuation](https://github.com/24mlight/agent-agnostic-stock-skills/blob/03e4a75910b757b23c40d1d76e68c5d4dd36b838/skills/company-valuation/SKILL.md)
26. [Panda QuantFlow factor nodes](https://github.com/PandaAI-Tech/panda_quantflow/tree/688b90e74a738b84567efe622a2d9c1e5ce10e00/src/panda_plugins/internal)
