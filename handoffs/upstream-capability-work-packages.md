# NGFI 能力迁移实施工作包

> 用途：把单个工作包原样交给新的实现 Agent。
> 依据：[外部能力迁移深度调研](./upstream-capability-adoption-study.md)。
> 范围：能力内核、Skill、工具与评测。排除新数据源、Web/UI、Bot、通知和实盘交易。

## 0. 所有实现 Agent 的共同约束

开始任一工作包前必须：

1. 阅读根 README、docs/ngfi-evolution-roadmap.md、handoffs/upstream-capability-adoption-study.md 和相关现有 package/test。
2. 检查 git status。工作树可能有其他人的未提交修改；不得覆盖、回滚或格式化无关文件。
3. 不新增数据抓取、provider 或任意 URL 调用。输入统一来自 finance-core canonical data contract 或离线 fixture。
4. 不修改 DSH core，不建立第二套 agent loop，不实现 UI、Bot、通知或订单。
5. 领域算法必须是确定性函数；LLM 只负责选择、组织和解释。
6. missing、unfillable、insufficient、not-meaningful 和 error 必须分开；禁止用零代替。
7. 可复算结果必须携带算法版本、输入引用、配置 hash 和数据快照引用。
8. 先写 contract tests，再接 DSH tool；领域 package 不得依赖 DSH。
9. 新 package 要加入 workspace、root references、build/typecheck/test；禁止用宽泛 any 绕过契约。
10. 除非工作包要求，不改 README；详细设计放 docs。

## 1. 依赖关系

~~~text
WP01 research contracts ─┬─ WP02 workspace/replay ─┬─ WP04 report audit
                         │                         ├─ WP05 research stages
                         │                         └─ WP06 thesis diff
WP03 strategy contracts ─┼─ WP08 indicators ───────┐
                         ├─ WP09 smoke backtest     ├─ WP10 first strategy
                         └─ WP07 signal ledger ─────┤
                                                   └─ WP11 research validation
WP01 + WP05 ───────────────────────────────────────── WP12 adversarial review
WP03 + WP11 ───────────────────────────────────────── WP13 factor research
WP01 + current CNE6 ───────────────────────────────── WP14 portfolio risk
all stable domain packages ────────────────────────── WP15 DSH integration
~~~

WP01 和 WP03 可以并行。WP08 可在 WP03 的 bar contract 冻结后并行。其他工作按依赖执行。

## WP01：Research Core 契约

**目标**：建立可审计研究的最小领域对象，不实现运行器。

**文件范围**：

- packages/research-core/package.json
- packages/research-core/tsconfig.json
- packages/research-core/src/contracts.ts
- packages/research-core/src/identity.ts
- packages/research-core/src/validation.ts
- packages/research-core/src/index.ts
- tests/research-core.test.ts
- 必要 workspace/root TypeScript 接线

**必须定义**：

- ResearchCase：caseId、subject、mandate、asOf、status、createdAt、updatedAt。
- SourceRef：provider、upstream、sourceKind、URL/hash，以及 observed/published/available/retrieved 时间。
- Evidence：id、kind、subject、field/value/excerpt、period/unit/currency、quality、sourceRef、limitations。
- Assumption：id、name、value/range、unit、scenario、rationale、evidenceRefs、owner、version。
- Claim：id、text、status、confidenceLabel、evidenceRefs、counterEvidenceRefs、falsifiers。
- ModelRun：id、model、version、inputRefs、parameters、output、warnings、createdAt。
- Gap：operation、reasonCode、detail、attemptedCapabilities。
- ResearchRunManifest：runId、caseId、asOf、代码/配置/模型版本、artifact hashes、状态。

**硬约束**：使用 discriminated union；ID 由 canonical JSON + hash 生成；对象键排序、数组保序；Evidence 与 Assumption 不共用类型；confidence 是 low/medium/high/unknown 而非伪概率；运行时执行 strict validation。

**参考**：Vibe schemas/merge；NGFI data-v2 contracts。

**验收**：同语义不同 key 顺序生成同 id；语义字段变化生成不同 id；非法日期、NaN/Infinity、空引用、未知状态被拒；Evidence 可无损保存 DataProvenance；新增测试和 typecheck 通过。

**派发提示词**：

> 实现 docs/upstream-capability-work-packages.md 的 WP01。严格只修改列出的路径和必要 workspace 配置。先阅读调研报告、evolution roadmap 和 finance-core/data-v2。不要实现存储、DSH 工具或 UI。以运行时可验证、稳定 identity、JSON-safe 和负例测试为验收中心。

## WP02：Research Workspace 与冻结回放

**依赖**：WP01。

**目标**：研究案例独立于聊天会话存在，并能冻结、校验和重放。

**文件范围**：packages/research-workspace/、tests/research-workspace.test.ts、evals/frozen-replay/fixtures/README.md。

**目录契约**：

~~~text
.runtime/research/<case-id>/
├── case.json
├── evidence.jsonl
├── assumptions.json
├── claims.json
├── model-runs/
├── runs/<run-id>/manifest.json
├── artifacts/
├── memo.md
└── decision-log.jsonl
~~~

**能力**：create/open/update/archive；append evidence/decision；原子写；revision；锁；artifact hash；snapshot；verify；seed replay；diff 两次运行。

**禁止**：损坏文件当空文件后覆盖；跟随 symlink；允许路径穿越；失败或空结果覆盖最后成功快照。

**参考**：Vibe fixture/snapshot/ledger；dsh-trading holdings store。

**验收**：损坏、revision 冲突、路径穿越、symlink、hash 篡改、旧 schema、重复 append 均有测试；frozen replay 不访问网络。

**派发提示词**：

> 实现 WP02。Research Workspace 只消费 WP01 类型，不依赖 DSH 和 provider。优先文件存储与冻结回放，不引入数据库。所有写入采用安全原子写；损坏必须显式报错并保留原文件。

## WP03：Strategy、Screener 与 Signal 契约

**目标**：冻结所有量化能力的公共接口，不实现具体策略。

**文件范围**：packages/strategy-core/、tests/strategy-contracts.test.ts、evals/strategy-contracts/README.md。

**必须定义**：

- StrategySpec：id/version/horizon/economicAssumption/failureConditions/parameters/researchStatus。
- StrategyDefinition：对单标的时序 bars 产生 entry/exit observations。
- ScreenerDefinition：对一个 as-of 窗口返回 match/null，无交易路径语义。
- SignalObservation：strategyHash/inputHash/snapshotId/instrument/signalAt/availableAt/configHash/payload/explanation/quality。
- ExecutionDefinition：确认时间、最早可成交时间、价格字段、无法成交条件。
- BacktestRun：engine/version/tier、dataset/config/strategy hash、cost model、benchmark、metrics、artifacts、status。
- StrategyResearchStatus：experimental/candidate/shadow/approved/retired/rejected。

**规则**：SignalObservation 不含可变生命周期；状态通过事件投影；相同输入产生同 id；策略定义与配置分别 hash；market regime 是 overlay，不是选择策略。

**参考**：breakout contracts/signal_lifecycle；dsh-trading strategy/screener types。

**验收**：golden fixture 锁语义；非法信号顺序、未来时间、非有限值、未知执行定义和重复插件 id 被拒。

**派发提示词**：

> 实现 WP03。先做纯 TypeScript contract、identity、registry 和 validator；不要写回测器、存储、策略或 DSH tool。重点保证 Strategy 与 Screener 分离、SignalObservation 不可变、ExecutionDefinition 可版本化、hash 可稳定复算。

## WP04：Research Audit

**依赖**：WP01、WP02。

**目标**：报告只有通过结构、引用、数值和来源冲突门禁后才能标为 complete。

**文件范围**：packages/research-audit/、tests/research-audit.test.ts、evals/research-audit/fixtures/。

**能力**：evidence/calculation 引用存在性；同行数字绑定与 display 检查；calculation inputRefs 闭包和 DAG 环检测；重大来源冲突必须被显式处理；必需章节、gap 与 status 一致；可选稳定抽样复核清单。

**参考**：Vibe number_fidelity/validator；ai-berkshire report_audit。

**验收 fixture**：正确报告、引用不存在、引用真实但数字错误、单位缩放、百分数、日期和证券代码误识别、原始浮点冒充 display、未处理冲突、无证据报告。

**派发提示词**：

> 实现 WP04。主门禁必须是“报告数字与同行引用绑定”，随机抽检只能是次级输出。机制词法与金融领域词法分离。失败返回结构化 finding，不直接修改报告。

## WP05：研究阶段与准出运行器

**依赖**：WP01、WP02、WP04。

**目标**：实现可组合阶段协议，不复制 Vibe 整套 orchestrator。

**文件范围**：packages/research-workflow/、tests/research-workflow.test.ts。

**能力**：WorkflowDefinition、stage dependency、required capabilities/calculations、stage result、gap、retry、resume、final gate。首个 company-research-v1 为 scope → fundamentals → valuation → risks → memo。

**原则**：规则由 workflow 注册，core 不写死金融字段；失败阶段可重试且不污染已完成阶段；done 与 outcome 分离；complete 必须通过 audit。

**派发提示词**：

> 实现 WP05。参考 Vibe plugin/stage validator，但基于 NGFI DSH runtime 和 WP01/WP02/WP04 重写。不要启动第二套 Agent runtime；先用注入式 stage executor 完成离线测试。

## WP06：Thesis Snapshot 与 Drift

**依赖**：WP01、WP02。

**目标**：新证据只更新真正受影响的论点。

**文件范围**：packages/research-core/src/thesis.ts、packages/research-core/src/diff.ts、tests/thesis-drift.test.ts、skills/thesis-review/SKILL.md。

**固定维度**：核心假设、估值锚点、红线、管理层或资本配置、竞争优势。输出 improved/unchanged/weakened/insufficient，区分事实变化、价格变化和措辞变化。

**参考**：ai-berkshire thesis-drift；Vibe alerts。

**验收**：同义改写不算 drift；只有价格变化不能改变业务 claim；非 unchanged 必须引用变化 evidence；缺基线返回 insufficient。

**派发提示词**：

> 实现 WP06。diff 以结构化 Claim、Assumption、Evidence 为主，不做 Markdown 字符串 diff。Skill 只指导解释，分类和引用完整性由纯函数保证。

## WP07：Signal Ledger、Outcome 与 Calibration

**依赖**：WP03、WP02。

**目标**：保存信号、生命周期事件、多期限结果、用户反馈和经验校准。

**文件范围**：packages/signal-evaluation/、tests/signal-lifecycle.test.ts、tests/signal-outcomes.test.ts、tests/signal-calibration.test.ts。

**能力**：observation append-only；lifecycle event + projection；5/10/20/60 日 outcome revision；matured/unfillable/expired/unable；benchmark return、MAE/MFE、direction hit；feedback；按 strategy/horizon/regime/dataQuality/market 分组；每 bucket 独立最小样本门槛；生成 calibration snapshot，但不自动修改策略。

**参考**：breakout signal repository/outcomes；DSA DecisionSignal outcome/calibration。

**验收**：不可成交为 null；修订不覆盖；相反信号不跨策略版本互相失效；样本不足不输出比率；聚合可追到 observation ids。

**派发提示词**：

> 实现 WP07。先做内存 store 和文件 store，不引入服务数据库。SignalObservation 是不可变事实，生命周期和 outcome 用 append-only event/revision 表达。校准只提供统计证据，不自动调权。

## WP08：Technical Analysis 纯函数包

**依赖**：WP03 的 bar contract 草案。

**目标**：提供策略和 Agent 共用的确定性指标。

**文件范围**：packages/technical-analysis/、tests/technical-analysis.test.ts。

**首批指标**：SMA、EMA、总体标准差、BOLL、MACD、Wilder RSI、KDJ。输出与 bars 等长，warm-up 显式为空。

**参考**：dsh-trading indicators math/types/presets/tests。

**验收**：手算 fixture、常数序列、极短序列、gap、非法 period、NaN/Infinity、输入不变性；与至少一个独立库离线对拍，但运行时不新增该依赖。

**派发提示词**：

> 实现 WP08。仅迁移纯函数和定义，不迁移颜色、pane、UI 或动态源码执行。输入使用 WP03 canonical bar；数值不四舍五入，展示层负责格式化。

## WP09：Smoke Backtest Engine

**依赖**：WP03、WP08。

**目标**：提供快速确定性回测，用于契约、golden fixture 和候选预检。

**文件范围**：packages/strategy-core/src/smoke-backtest.ts、tests/smoke-backtest.test.ts。

**能力**：long/cash；i 收盘确认、i+1 可交易开盘成交；手续费、滑点；trade/equity；return/CAGR/drawdown/Sharpe/win rate/profit factor/exposure。

**补强要求**：拒绝时间乱序、重复时间、非法 OHLC、非有限数；最后未平仓估值语义显式；输出 engineTier=smoke；不能据此把策略晋级为 approved。

**派发提示词**：

> 实现 WP09。参考 dsh-trading engine，但不带 UI 类型。固定成交语义并用 golden tests 锁住。类型和文档必须阻止调用方把 smoke 结果误标为 research-grade。

## WP10：首个 Strategy Plugin

**依赖**：WP03、WP08、WP09。

**目标**：移植横盘吸筹—放量突破，压实插件链路。

**文件范围**：packages/strategy-accumulation-breakout/、tests/strategy-accumulation-breakout.test.ts、evals/strategy-contracts/accumulation-breakout-v1.json。

**能力**：box detection、振幅、量能突破、涨幅、MA60、位置、回踩；输出统一 SignalObservation。市场状态作为外部 qualification overlay，不藏在策略里。

**参考**：breakout signals.py、accumulation_breakout_v1.py、entry golden；dsh volume screener。

**验收**：复制上游 synthetic seed=42 golden；未来 bar 改变不影响历史信号；配置变化改变 config hash；数据不足不产生信号；策略异常不影响 registry 其他插件。

**派发提示词**：

> 实现 WP10。只迁移策略算法和测试语义，数据必须来自 NGFI canonical bars；不要复制扫描器、SQLite、Web、优化器或纸面交易。策略保持 experimental。

## WP11：Research-grade Backtest 与策略准入

**依赖**：WP03、WP07、WP10。

**目标**：形成统一策略研究和晋级证据。

**文件范围**：packages/quant-research/pyproject.toml、packages/quant-research/ngfi_quant/、packages/quant-research/tests/、必要 root Python/scripts 接线。

**模块**：execution calendar、A 股费用与整手、涨跌停或停牌不可成交、组合资金核算、基准、IS/OOS、nested walk-forward、cost stress、CSCV-PBO、deflated Sharpe、minimum track record、promotion decision。

**输出**：符合 WP03 BacktestRun JSON Schema，保存 dataset/strategy/config/cost/benchmark hash。

**参考**：breakout research/portfolio_accounting.py、walkforward.py、research/cscv.py、deflated_sharpe.py、min_track_record.py、promotion_v2.py。

**验收**：参数只在训练集选择；测试集只评价冻结候选；候选和基准使用相同股票池、日期、成本；重叠信号、资金不足、停牌、涨跌停有明确 rejection；样本不足为 insufficient；双倍成本以新 cost hash 重放；同 fixture 结果一致。

**派发提示词**：

> 实现 WP11。以 breakout 研究层为行为参考，重写无数据库依赖的纯计算入口。先完成组合核算、IS/OOS 和 cost stress，再增加 WF/PBO/DSR。不得读网络或当前时间；数据和 as-of 由调用方显式传入。

## WP12：Evidence-grounded Adversarial Review

**依赖**：WP01、WP02、WP04、WP05。

**目标**：共享事实底稿上的多方、空方、反驳和裁判审阅。

**文件范围**：packages/research-workflow/src/adversarial-review.ts、tests/adversarial-review.test.ts、skills/adversarial-research/SKILL.md。

**规则**：所有角色共享同一冻结 dossier；角色使用独立 DSH session；sees 控制依赖；空底稿拒绝；截断记 gap；并发推进拒绝；单阶段失败后整体可继续；每段输出经过 WP04 数字审计；裁判只产出共识事实、争议、缺口和裁决条件，不投票决定信号。

**参考**：Vibe debate/arithmetic；DSA deliberation。

**派发提示词**：

> 实现 WP12。先用可注入 mock chat executor 做完整测试，再接当前 DSH session API。禁止角色自行取数；禁止把辩论票数直接转换成交易权重。

## WP13：Factor Research Kernel

**依赖**：WP03、WP11。

**目标**：重写最小因子研究内核，不迁移 QuantFlow 平台。

**文件范围**：packages/quant-research/ngfi_quant/factors/、packages/quant-research/tests/test_factors.py。

**V1 能力**：date/instrument/factor 长表；截面 winsorize、标准化和缺失策略；行业或市值中性化；IC、RankIC、ICIR；分组收益与多空收益；turnover、coverage；Pearson/Spearman 相关矩阵；等权、IC 权重、最小相关性约束组合；完整 lineage 与 train/test 边界。

**参考**：QuantFlow 能力拆分和 Spearman combiner；不要复制薄 wrapper 或随机 id。

**验收**：手算样本、未来收益 shift 防泄漏、全空截面、常数因子、重复键、缺失、权重和为零、训练测试越界均有测试；每项结果带样本数和覆盖率。

**派发提示词**：

> 实现 WP13。QuantFlow 只作功能目录参考，算法按公开定义和 NGFI 契约独立实现。不要依赖 panda_factor、MongoDB、Redis、RabbitMQ 或模型服务。V1 不做自动生成公式和 ML 模型。

## WP14：Holdings 与 CNE6 Portfolio Risk

**依赖**：WP01；复用现有 CNE6。

**目标**：把 CNE6 从算法 CLI 包装成组合能力。

**文件范围**：packages/portfolio-risk/、tests/portfolio-risk-contracts.test.ts，以及 combinatorial-optimization 内必要的只读高层入口和测试。

**能力**：staged/confirmed holdings；CSV/JSON import；snapshot；factor exposure；total/factor/specific risk；marginal risk；scenario stress；reconciliation。

**规则**：持仓只接受显式导入，不接券商；未映射证券和币种不得静默忽略；输出带 CNE6 model version、as-of、coverage、covariance quality 和 input hash。

**参考**：dsh-trading holdings；当前 NGFI CNE6 contracts/synthesis/factor_cov/specific_risk。

**派发提示词**：

> 实现 WP14。不要修改 CNE6 底层算法，先建立 holdings 与 risk snapshot 契约和只读 facade。持仓导入采用 staged-confirmed；风险无法 reconciliation 时 fail closed。

## WP15：DSH Tools、Skills 与 Evals 接线

**依赖**：只接已经稳定并通过测试的领域包。

**目标**：把领域能力暴露给 DSH，而不让业务算法进入 bundle。

**文件范围**：packages/dsh-finance-tools/、packages/dsh-finance-bundle/、generated/agent-presets/、skills/、evals/、composition 和 isolation tests。

**原则**：tool 是薄适配；按职责拆 company-research、strategy-research、portfolio-risk preset；保持 allowlist；不启用 shell/web；Skill 只写流程与解释纪律，公式和 gate 留在代码。

**新增 eval**：frozen replay、引用完整性、数字忠实度、策略工具轨迹、禁止工具、样本不足、数据降级、对抗审阅、signal outcome。

**派发提示词**：

> 实现 WP15 中当前已完成领域包的 DSH 接线。先列出稳定 exports 与工具最小参数，再改 bundle/preset。不得在 tool 中重写领域逻辑，不得暴露整个 provider 输出或任意上游接口。完成 build、typecheck、unit、composition、isolation 和相关 eval。

## 2. 推荐派发顺序

单 Agent 串行顺序：WP01 → WP03 → WP02 → WP04 → WP08 → WP09 → WP10 → WP07 → WP11 → WP05 → WP06 → WP12 → WP14 → WP13 → WP15。

若允许并行，第一波只并行 WP01 与 WP03；WP03 的 bar contract 冻结后可以启动 WP08。第二波可并行 WP02、WP07、WP09。各 Agent 必须拥有互不重叠的 package；根 workspace 文件由专门的集成 Agent 统一处理。

## 3. 每个 Agent 的交付模板

最终回复必须包含：

1. 实现的契约和能力；
2. 修改文件的绝对路径；
3. 参考的上游 commit 和文件；
4. 哪些部分是复制、适配或独立重写；
5. 测试命令与结果；
6. 未运行测试及原因；
7. 已知限制；
8. 对后续工作包开放的稳定接口；
9. 未触碰的数据、UI 和 runtime 边界；
10. 回滚方式。

只有契约、负例测试和可复算 fixture 同时完成，工作包才算完成。代码量、工具数量和 README 描述不作为完成证据。

## 4. 上游固定版本与源码定位

实现 Agent 应读取固定 commit，不能直接以不断变化的默认分支作为验收基线。可以将上游仓库克隆到系统临时目录，只读研究后删除；不得把完整 checkout 放进 NGFI。

| 别名 | 仓库 | 固定 commit |
|---|---|---|
| VIBE | https://github.com/simonlin1212/Vibe-Research | 09e8404a33ba0d05e036e01207be4701c61d692c |
| BREAKOUT | https://github.com/fredombobo/a-share-accumulation-breakout | c6a7d8d7397dfe6c02c97da8da83dea7c4ae6453 |
| DSA | https://github.com/ZhuLinsen/daily_stock_analysis | 303f4e1c18b7e149bc2b7618eb63a6574507bc6b |
| DSH_TRADING | https://github.com/zhu1090093659/dsh-trading | c942057723ca7054519414575101e6bcc5ef7128 |
| BERKSHIRE | https://github.com/xbtlin/ai-berkshire | f98eff38d01a17a39d95940709afce61e75c8ac7 |
| STOCK_SKILLS | https://github.com/24mlight/agent-agnostic-stock-skills | 03e4a75910b757b23c40d1d76e68c5d4dd36b838 |
| QUANTFLOW | https://github.com/PandaAI-Tech/panda_quantflow | 688b90e74a738b84567efe622a2d9c1e5ce10e00 |

### WP01 / WP02 / WP04 / WP05 / WP12：Vibe 源码地图

| 能力 | 路径 | 使用方式 |
|---|---|---|
| Evidence/Calculation/Manifest schema | orchestrator/src/schemas.ts | Adapt；删除 provider、Codex CLI 和金融插件专属字段 |
| Evidence merge/conflict | orchestrator/src/merge.ts | Adapt；映射到 DataProvenance 和 InstrumentId |
| 运行完整性 | orchestrator/src/validator.ts | Rewrite；只借不变量与负例 |
| 数字忠实度 | orchestrator/src/number_fidelity.ts | Adapt；机制和金融词法分离 |
| 计算展示映射 | orchestrator/src/calc_projection.ts | Adapt |
| 冻结 fixture | orchestrator/src/fixture.ts | Adapt |
| 读缓存快照 | orchestrator/src/snapshot.ts | Reference；Research run 与 provider cache 不混用 |
| evidence diff | orchestrator/src/alerts.ts | Adapt |
| 原子文件工具 | orchestrator/src/fsutil.ts | Adapt；优先复用 NGFI 已有工具（若存在） |
| append-only 台账 | orchestrator/src/ledger.ts | Reference/Adapt |
| 多空辩论 | orchestrator/src/debate.ts | Adapt |
| 算式审计 | orchestrator/src/arithmetic.ts | Adapt |
| 插件式阶段定义 | orchestrator/src/plugin.ts | Reference/Rewrite |
| 金融阶段语义 | orchestrator/src/finance/plugin.ts | Reference；不要复制数据 endpoint |
| 阶段专属校验 | orchestrator/src/finance/stage_validators.ts | Reference/Adapt |
| 主要负例 | orchestrator/test/validator.test.ts、fixture.test.ts、gate.test.ts、debate.test.ts、plugin.test.ts、ledger.test.ts | 重建到 NGFI tests |

### WP03 / WP07 / WP10 / WP11：Breakout 源码地图

| 能力 | 路径 | 使用方式 |
|---|---|---|
| StrategySpec/SignalObservation/hash | ab_screener/strategies/contracts.py | Adapt to TypeScript contract |
| 策略 registry 与故障隔离 | ab_screener/strategies/registry.py | Adapt |
| observation 构造 | ab_screener/strategies/_common.py | Adapt |
| 信号生命周期 | ab_screener/domain/signal_lifecycle.py | Adapt |
| 执行语义 | ab_screener/domain/entry_definition.py、entry_registry.py | Adapt |
| observation store | ab_screener/data/signal_repository.py | Rewrite as store interface/file implementation |
| outcome | ab_screener/application/signal_outcomes.py | Adapt |
| 突破策略 | signals.py、ab_screener/strategies/accumulation_breakout_v1.py | Adapt |
| 其他策略样本 | ab_screener/strategies/*_v1.py | Later；只在主链稳定后迁移 |
| IS/OOS/WF | walkforward.py、ab_screener/research/nested_walkforward.py | Adapt |
| CSCV-PBO | ab_screener/research/cscv.py | Adapt |
| DSR 与最小 track record | ab_screener/research/deflated_sharpe.py、min_track_record.py | Adapt |
| 组合回测 | ab_screener/research/portfolio_accounting.py | Adapt |
| 成本压力 | ab_screener/research/cost_stress.py | Adapt |
| 基准 | ab_screener/research/baselines.py | Adapt |
| 策略晋级 | ab_screener/research/promotion_v2.py、formal_promotion.py | Adapt |
| 关键测试 | tests/test_signal_observations.py、test_signal_lifecycle_v2.py、test_signal_outcomes.py、test_entry_definition_v1_golden.py、test_nested_walkforward_v2.py、test_cscv_pbo.py、test_research_portfolio_accounting.py、test_formal_cost_stress.py | 重建并保留反例语义 |

### WP07 / WP12 / WP15：DSA 源码地图

| 能力 | 路径 | 使用方式 |
|---|---|---|
| DecisionSignal 契约说明 | docs/decision-signals.md | 字段参考，不照搬 action 文案 |
| Signal schema | api/v1/schemas/decision_signals.py | Adapt |
| Signal 提取 | src/services/decision_signal_extractor.py | Legacy import only |
| 数据质量归一 | src/services/decision_signal_data_quality.py | Adapt |
| 决策 guardrail | src/services/decision_profile_policy.py | Reference/Adapt |
| Outcome 与 calibration | src/services/decision_signal_outcome_service.py | Adapt |
| 多 Skill 聚合 | src/agent/skills/aggregator.py | Adapt after calibration exists |
| 冲突分类 | src/agent/skills/synthesis.py、src/agent/disagreement.py | Adapt |
| 多轮审阅 | src/agent/skills/deliberation.py | Reference/Adapt |
| Agent 轨迹评测 | evals/agent_trajectory/metrics.py、tests/test_agent_trajectory_metrics.py | Adapt |
| 关键测试 | tests/test_decision_signal_service.py、test_decision_signal_outcome_service.py、test_multi_agent.py | 选择领域负例重建，不复制应用/DB fixture |

### WP03 / WP08 / WP09 / WP14：dsh-trading 源码地图

| 能力 | 路径 | 使用方式 |
|---|---|---|
| 指标契约与纯函数 | packages/indicators/src/types.ts、math.ts、presets.ts | Copy/Adapt |
| 指标 validator | packages/indicators/src/validate.ts、validate-node.ts | Adapt；暂不开放动态源码 |
| 策略契约 | packages/strategies/src/types.ts | Adapt |
| 策略序列 validator | packages/strategies/src/validate.ts | Adapt |
| smoke backtest | packages/strategies/src/engine.ts | Copy/Adapt |
| 策略样板 | packages/strategies/src/paradigms/ | Copy as fixtures/examples |
| screener 契约与样板 | packages/strategies/src/screeners/ | Adapt |
| 持仓契约与 store | packages/holdings/src/types.ts、store-core.ts、store-fs.ts | Adapt |
| 关键测试 | packages/indicators/test/、packages/strategies/test/、packages/holdings/test/ | 迁移对应纯函数与负例测试 |

### WP04 / WP06 与研究 Skill：AI Berkshire、Stock Skills

| 能力 | 仓库与路径 | 使用方式 |
|---|---|---|
| 终值 PE/IRR 与审计 | BERKSHIRE tools/terminal_value.py | Adapt into finance-core |
| Markdown 数字抽检 | BERKSHIRE tools/report_audit.py | Secondary audit |
| 精确计算补缺 | BERKSHIRE tools/financial_rigor.py | 先与 finance-core 去重 |
| Thesis 基线/漂移 | BERKSHIRE skills/thesis-tracker.md、thesis-drift.md | Adapt |
| 盈利复盘/管理层/质量/行业 | BERKSHIRE skills/earnings-review.md、management-deep-dive.md、quality-screen.md、industry-funnel.md、bottleneck-hunter.md | Reference |
| SOTP/估值路由 | STOCK_SKILLS skills/company-valuation/SKILL.md、references/sotp.md | Reference |
| 业绩复盘结构 | STOCK_SKILLS skills/earnings-recap/SKILL.md | Reference |

### WP13：QuantFlow 源码地图

| 能力 | 路径 | 使用方式 |
|---|---|---|
| 节点抽象 | src/panda_plugins/base/base_work_node.py、work_node_registery.py | Reference only |
| IC/相关性/分组 | src/panda_plugins/internal/factor_ic_calculation_node.py、factor_correlation_calculation_node.py、factor_to_group_node.py | Rewrite |
| 权重与合成 | factor_weight_adjust_node.py、factor_weight_calculation_node.py、multi_factor_merge_node.py | Rewrite |
| Spearman importance combiner | src/panda_ml/importance_spearman_factor_combiner.py | Reference/Rewrite |
| 因子/ML 能力目录 | src/panda_plugins/internal/ | Backlog vocabulary only |
| 事件回测结构 | src/panda_backtest/backtest_common/system/event/ | Reference only |

## 5. 单工作包执行检查表

新 Agent 开始前：

- [ ] 当前依赖工作包已合入或其稳定接口已经提供。
- [ ] 已记录当前 NGFI HEAD 和工作树状态。
- [ ] 已将所需上游固定到本节 commit，而非默认分支最新状态。
- [ ] 已读上游测试和注释中记录的反例，不只读 happy path。
- [ ] 已列出将复制、适配、重写和拒绝迁移的文件。

实现期间：

- [ ] 领域代码不依赖 DSH、UI、网络或数据库实现。
- [ ] 时间、单位、币种、复权和 missing 状态没有被压扁。
- [ ] hash 输入是 canonical、完整且可解释的。
- [ ] 没有将错误、缺失或样本不足变成成功空结果。
- [ ] 负例测试与正例同时提交。

交付前：

- [ ] package 自身 build/typecheck/test 通过。
- [ ] root 受影响测试通过。
- [ ] 没有意外修改现有用户工作树文件。
- [ ] 没有把上游 checkout、数据、报告或缓存加入仓库。
- [ ] 对下一工作包声明稳定 exports 与未完成边界。
