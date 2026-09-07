# NGFI 应该怎么做：基于 dsh-trading 与 MLE-Agent RecCore 的架构判断与演进路线

> 调研日期：2026-09-04<br>
> 分析对象：NGFI `5f9b30e`、dsh-trading `31917e5`、MLE-Agent RecCore `0d21d72` 及其本地工作区<br>
> 说明：本文回答产品与工程方向，不主张直接复制任何一个参照项目。`dsh-trading` 使用 PolyForm Noncommercial 1.0.0，若 NGFI 涉及商业用途，应只借鉴思想，除非另行取得代码使用授权。

## 核心摘要

NGFI 不应该把下一阶段定义成“补齐更多金融工具”或“做一个简化版 dsh-trading”。它应该成为一个**可审计、可恢复、可评测的金融研究与组合决策系统**：把用户问题转化为研究任务，把结构化数据和原始披露转化为证据，把证据与假设转化为模型，把模型与反例转化为结论，再把整个过程保存为可以继续更新的研究案例。

当前 NGFI 的底座其实是三者中最适合作为“可信金融推理内核”的：它已经把 DSH adapter、领域契约、provider、确定性计算和 Skill 分层；字段显式区分 `available`、`missing`、`provider-error`、`stale`；估值计算可脱离 Agent 测试；运行时与全局 DSH 隔离；还有针对金融分析与投资行为诊断的 rubric。2026-09-04 实测 `pnpm check` 全部通过：TypeScript 侧 52 个测试通过，CNE6 侧 129 passed、2 skipped。因此，正确策略是**保留现有内核，补齐研究闭环**，而不是推倒重写。

两个参照项目分别提供了不同答案：

- MLE-Agent RecCore 证明，垂直 Agent 的价值来自“完成真实工作流”，不是拥有一个新的通用 runtime。它把 DSH 当宿主，只维护插件、Skill、领域知识、会话记忆和运维规则，并让离线验证、正式任务、指标分析形成闭环。NGFI 应照搬的是这种产品哲学、分层记忆、可观测和 self-improve 机制。
- dsh-trading 证明，当能力扩展到多市场、多 provider、持久对象和 UI 时，必须有稳定的 canonical contract、registry/router、Tool–Store–View 一致性，以及危险动作的服务层安全闸门。NGFI 应吸收这些抽象，但不应近期复制其 45 个 package、19+ connector、桌面壳、图表终端和交易执行面。

建议路线是：先建设 Research Workspace、Evidence/Assumption Ledger、官方 filing/document 能力和冻结评测；再把数据层升级为按能力路由的 Provider Registry，并把 CNE6 从孤立 CLI 接入组合风险工作流；最后仅在真实使用证明有必要时，做轻量 Research Cockpit。实盘交易不应进入近期范围。

## 一、先纠正问题：NGFI 缺的不是“功能数量”，而是闭环

### 1. 当前 NGFI 已经具备的正确资产

NGFI 目前不是空壳。它已经完成五项重要基础工作。

第一，依赖方向是健康的：DSH profile → bundle → DSH tools → `finance-core` contract/compute ← provider。`finance-core` 不依赖 DSH，provider 不感知 session 或 UI，只有 adapter 层接触 DSH。这让金融语义能脱离模型运行时单测，也让未来更换数据源不必重写 Skill。该设计在现有设计文档中已经明确，并由代码落实[[NGFI Finance2DSH 设计]](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/docs/finance2dsh-plan.md)。

第二，数据契约已经有“金融数据不能只给一个裸数字”的意识。`ObservationMeta` 包含 provider、source、retrieved/observed/reported time、fiscal period、period type、currency 和 unit；字段不是 `number | null`，而是带状态的 `ObservedField<T>`[[NGFI contracts]](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/packages/finance-core/src/contracts.ts)。这是非常值得保留的核心，不应为了兼容某个 connector 而退化。

第三，估值和行为审计中的关键计算已经从 LLM 中移出。WACC、DCF、敏感性、相对估值、行为市场证据和交易记录审计是确定性函数，Agent 负责选择输入、解释假设和综合结论，而不是心算。这比“给模型更多行情工具”更接近可信金融系统。

第四，运行时隔离做得正确。NGFI 使用仓库内 `.runtime`，不污染 `~/.dsh`；Web 与 headless 都由项目 profile 组装；工具 allowlist 只开放 `skill` 和 12 个 `finance_*` 工具[[NGFI policy]](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/packages/dsh-finance-bundle/src/policy.ts)。这种封闭组合比把用户机器上的全部工具暴露给金融 Agent 更安全，也更容易复现。

第五，项目已经有质量语言，而不只看“能否回答”。现有 rubric 把数据正确性、时间口径、来源质量、方法正确性、完整性和综合判断分开评分，并定义硬失败；行为诊断还做过真实 DSH 输出的匿名成对比较[[NGFI evals]](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/evals/README.md)。这为后续迭代提供了比主观 demo 更可靠的基础。

### 2. 真正断裂的地方

NGFI 的问题是上述能力仍然像一组“可调用函数”，还不是研究系统。

目前的公司研究 Skill 描述了 Scope → Research → Ground → Model → Reconcile → Audit → Synthesize，但关键的 Research 环节事实上没有启用：finance preset 明确不允许 `web_search`/`web_fetch`，也没有读取 filing、财报 PDF、IR 材料和新闻正文的 provider。于是所谓 deep dive 只能依靠 yfinance 的聚合字段完成，无法可靠回答管理层指引、会计政策变化、分部结构、风险因素、业绩会解释和预期修正等问题。现有文档对此披露得很诚实[[NGFI 运行与测试]](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/docs/running-and-testing.md)。

其次，`FinanceDataProvider` 当前是一个单体接口：同一个 provider 必须同时实现 security reference、fundamentals、market data、estimates 和 comparables。现实里，最佳行情源、财报源、标识映射源、分析师预期源、公司行动源往往不是同一家。继续沿这个接口增加 provider，最终会得到大量“不支持但被迫实现”的空方法，或隐蔽的跨源拼接。

第三，研究没有持久对象。DSH session 保存了对话轨迹，但“某家公司某个时点的研究”没有独立的 evidence、assumptions、model runs、memo、decision log 和更新状态。用户过一周回来问“上次关于利润率的假设还成立吗”，系统只能依赖上下文或重新研究，不能做增量 diff。

第四，CNE6 与 Agent 主链是割裂的。README 把它列为能力，但它仍是独立数据构建和风险模型 CLI，尚未挂到 DSH tool allowlist；完整全市场资产也尚未验收[[NGFI README]](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/README.md)。因此 NGFI 现在能做单股基本面分析，却还不能自然回答“我的组合对哪些风格因子暴露最大”“这次调仓如何改变边际风险”。

最后，现有 25 个基本面案例主要校验结构与 required tools，尚未形成默认执行的冻结数据端到端 benchmark。实时 yfinance 会漂移，LLM judge 会抖动，如果没有固定 as-of fixture，就无法判断一次得分变化来自代码、模型还是市场数据。

## 二、三个项目不是同一种东西，不能按功能表横向抄

| 维度 | NGFI 当前 | MLE-Agent RecCore | dsh-trading | 对 NGFI 的启示 |
|---|---|---|---|---|
| 核心目标 | 金融分析内核与 Skill 验证 | 对话推进推荐工程全流程 | Agent 原生多市场交易终端 | 定位应偏“研究工作流”，不是终端复制 |
| DSH 关系 | 仓库内独立 runtime/profile | 全局 DSH + 外置插件/Skill/知识 | 插件 monorepo + 市场 bundles + UI | 坚持不 fork，按场景选择组合方式 |
| 领域核心 | 数据契约、估值、行为审计 | 工程任务、实验验证、平台操作 | 行情、指标、策略、交易、知识 | 继续强化金融语义与决策质量 |
| 数据扩展 | 单一 `FinanceDataProvider` | 主要复用外部 CLI | registry/router + 多 connector | 引入按能力路由，不复制全部 connector |
| 记忆/知识 | Skill references；无研究 case | 群 MEMORY + topic knowledge + artifacts | 结构化 knowledge cards + graph | 先做 case workspace 和来源治理，图谱后置 |
| UI/入口 | DSH Web + headless | 飞书 + Web + CLI | 三栏终端 + desktop | 先复用 DSH Web，必要时只做研究视图 |
| 安全 | 只读 sandbox、工具白名单 | 群成员≈shell 用户，强调边界 | dry-run + live switch + approval fail-closed | 研究期保持无交易权限；未来执行需多重闸门 |
| 质量机制 | rubric、单测、少量真实 E2E | proto→local→正式任务→指标 | connector contract tests、回测与 UI 验证 | 建立冻结评测 + live health + 真实研究任务三层门禁 |

### 1. 应从 MLE-Agent RecCore 学什么

MLE-Agent 最重要的经验是：它明确宣称“这不是一个应用”。仓库只给 DSH 增加插件、Skill 和领域知识，让同一套 Agent 经飞书、Web、CLI 完成真实推荐工程任务[[MLE README]](<external-mle-reference>/README.md)。这种克制值得 NGFI 继承。

更具体地说，应吸收四点。

一是**以工作结果定义能力**。MLE 的 Skill 不是“查一个指标”，而是 proto-eval、LocalRun、提交训练、看 DeepInsight、诊断吞吐等任务链。NGFI 的能力也不应继续按数据接口罗列，而应定义成“建立/更新公司研究”“审计一个投资论点”“比较两个情景”“诊断组合风险”“复盘一次决策”。

二是**把低成本验证放在正式动作之前**。MLE 用公开数据 proto 和单卡 LocalRun 先验证模型 idea，再提交昂贵训练任务。金融对应物是：固定历史切片 → 确定性模型与数据质量检查 → 冻结 case replay → live 数据 smoke → 人工投资委员会审阅。不要让 Agent 从实时网页直接跳到确信度很高的结论。

三是**分层记忆而非无限对话**。MLE 的 `MEMORY.md` 只保留目标、当前状态、约束、索引和下一步，详细事实进入 topic knowledge，原始材料进 artifacts[[MLE memory skill]](<external-mle-reference>/.agents/skills/lark-group-memory/SKILL.md)。NGFI 可以把这一模式直接映射到每个研究 case。

四是**可观测要覆盖完整链路**。MLE 明确区分 Agent trajectory、服务/bridge log 和用户原始消息三类证据[[MLE AGENTS]](<external-mle-reference>/AGENTS.md)。NGFI 也应分别保留：模型与 tool trace、provider 请求/质量日志、研究输入与最终 artifact；否则出现错误时无法判断是 Agent 漏步骤、provider 返回坏数据，还是输入本身含糊。

### 2. 应从 dsh-trading 学什么

dsh-trading 的价值不只是 connector 数量，而是它在规模扩张后被迫形成的边界。

第一是**canonical vocabulary**。它要求消费方只说市场规范 symbol，connector 在边界转换成供应商方言，输出再统一返回规范形；因此切换 provider 不会让 watchlist、策略和历史状态失效[[dsh-trading symbol vocabulary]](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/docs/symbol-vocabulary.md)。NGFI 也需要 canonical instrument identity，且必须比 ticker 更强：至少包含市场、交易所、证券类型、交易币种和稳定标识；美股 filing 可以关联 CIK，跨供应商映射可选 FIGI/ISIN。OpenFIGI 官方 API 支持把第三方标识映射到 FIGI，可作为可插拔映射源而不是系统唯一真相[[OpenFIGI API]](https://www.openfigi.com/api/documentation)。

第二是**registry/router**。dsh-trading 让 connector 注册 service，由市场路由决定当前 active provider，Tool 和 UI 都消费同一 service 层[[dsh-trading API]](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/packages/api/src/index.ts)[[dsh-trading router]](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/packages/router/src/index.ts)。NGFI 应采用类似思想，但路由维度不能只是 market，而应是 `capability × market × asOf requirement`。例如 AAPL 的价格、SEC filing、标准化财务和 consensus 可以来自四个 provider，结果在 evidence ledger 汇合。

第三是**能力三元组**。dsh-trading 的设计把可见能力理解为 Tool × Registry/Store × View：Agent 能操作，host 有唯一持久状态，用户能看见并校验[[Agentic Native Blueprint]](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/docs/design/agentic-native-architecture.md)。NGFI 不必为每项数据做 UI，但所有“持久研究对象”都应满足这个约束，例如 assumption、evidence、valuation run、risk snapshot 和 decision note。

第四是**危险动作在服务层 fail-closed**。dsh-trading 的下单默认 dry-run，实盘还需要 `liveTrading` 开关和交互审批；无头环境拒绝执行[[dsh-trading base gate]](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/packages/base/src/index.ts)。NGFI 近期不应做交易，但未来若接账户或下单，安全必须落在 execution service，而不是只写进 prompt。

### 3. 不应照搬什么

不要照搬 dsh-trading 的产品面。它服务的是主动交易终端，因此图表、盘口、衍生品、watchlist、19+ connector、桌面打包和实时 UI 都合理；NGFI 目前的差异化资产却是基本面、估值、行为诊断与 CNE6。复制终端会把资源消耗在低差异化区域，并引入实时性、行情授权、账户安全和桌面兼容等长期成本。dsh-trading 本身也有一些标为“设计定稿、待实现”的蓝图，不能把文档中的目标状态全部当成成熟事实。

也不要原样复制 MLE 的全局安装与飞书桥。MLE 是单人内部工程 Agent，拥有完整 shell 权限，并明确说明群成员等同机器 shell 用户[[MLE README]](<external-mle-reference>/README.md)。NGFI 面向金融数据和潜在账户信息，继续使用仓库内隔离 runtime、只读 sandbox 和最小 allowlist 更合适。飞书/消息入口只有在异步研究任务成为真实需求时才增加。

## 三、NGFI 的产品定位：研究操作系统，而非聊天式行情工具

建议把北极星定义为：

> 用户给出证券、组合或投资问题后，NGFI 能创建一个可恢复的研究案例，在明确时点和数据边界内收集证据、维护假设、运行确定性模型、提出竞争解释与证伪条件，产出可审计 memo；新信息到来时只更新受影响的证据、模型和结论。

这一定义带来几个边界：

- “回答得像分析师”不算完成；事实必须能定位到 provider observation 或原始披露。
- “目标价算出来了”不算完成；输入、情景、敏感性、与市场/同业冲突都要可见。
- “保存了会话”不等于有记忆；研究对象、证据和决策必须独立于聊天存在。
- “接了更多数据源”不等于可靠；路由、时点、单位、冲突、缺失和降级都必须显式。
- “能回测”不等于能交易；研究、组合建议、模拟执行和真实执行是四个不同权限域。

近期建议只服务三条主工作流：

1. **Company Research**：建立或更新一家公司/证券的研究 memo。
2. **Portfolio Risk**：导入持仓，解释因子暴露、边际风险、集中度和情景变化。
3. **Decision Review**：把事前论点、行为证据和事后结果放在同一记录中复盘。

这三条分别复用现有基本面/估值、CNE6、投资行为诊断资产，能形成 NGFI 自己的闭环；技术指标策略和真实交易不是当前差异化核心。

## 四、建议的目标架构

```text
入口：DSH Web / headless（未来可选消息入口）
                         │
             场景 Presets + Workflow Skills
       company-research | portfolio-risk | decision-review
                         │
       Research Workspace / Evidence & Assumption Ledger
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
  Research Tools    Deterministic Core   Artifact Renderer
       │             valuation/risk/       memo/table/chart
       │             behavior audit
       ▼
  Capability Registry + Routing + Quality Policy
       │
  identity | market | fundamentals | filings | estimates | risk
       │
  yfinance / SEC EDGAR / CNE6 / future licensed providers
```

### 1. 把单体 provider 拆成 capability contracts

保留 `ObservationMeta` 和 `ObservedField`，但把 `FinanceDataProvider` 拆成小接口：

- `InstrumentReferenceProvider`：规范证券身份与 provider symbol 映射；
- `MarketDataProvider`：价格、公司行动和交易日历；
- `FundamentalsProvider`：标准化财务事实；
- `DisclosureProvider`：filing、公告、IR 文档与段落引用；
- `EstimateProvider`：一致预期及其观察时间；
- `RiskModelProvider`：暴露、因子协方差、特异风险和模型版本。

provider 可实现其中任意子集。Registry 按 capability 和 market 注册；Router 的选择结果必须进入输出元数据。fallback 不能静默发生，至少记录 requested provider、actual provider、reason 和 quality downgrade。

同时把证券身份从裸 ticker 升级为 `InstrumentId`。建议最小字段为：`market`、`exchange`、`symbol`、`assetType`、`quoteCurrency`、`providerSymbols`，并预留 `cik`、`figi`、`isin`。这一步必须先于第二、第三行情源，否则每增加一个源都会扩散 symbol 特判。

### 2. 建立 Evidence/Assumption Ledger

这是 NGFI 最关键的新领域对象。建议不是让 Agent 自由写一篇长 Markdown，而是同时维护机器可读台账：

```text
Claim
  id, text, status, confidence, tags
  evidenceRefs[], counterEvidenceRefs[]

Evidence
  id, kind(structured|filing|web|user|calculation)
  sourceRef, observedAt/reportedAt/retrievedAt, excerpt/value
  provider, unit/currency/period, quality, limitations

Assumption
  id, name, value/range, unit, rationale
  evidenceRefs[], scenario, owner, updatedAt

ModelRun
  id, model, version, inputRefs[], output, warnings, createdAt
```

这样做不是为数据库而数据库，而是解决四个具体问题：数字可追溯、事实与假设不混淆、新证据能定位受影响结论、同一模型可以复算。早期用 JSON/YAML + Markdown 即可，不需要先上向量库或图数据库。

### 3. Research Workspace 作为持久工作单元

借鉴 MLE 的分层记忆，每个研究任务建议落成：

```text
workspace/research/<case-id>/
├── MEMORY.md          # 目标、状态、约束、索引、下一步；保持短小
├── case.yml           # instrument/portfolio、asOf、mandate、状态
├── evidence.jsonl     # append-only 证据与更新
├── assumptions.yml    # 当前有效假设和情景
├── claims.yml         # 结论、反证和置信度
├── model-runs/        # 可复算输入输出
├── artifacts/         # filing、表格、图片、中间数据
├── memo.md            # 当前交付版本
└── decision-log.jsonl # 人与 Agent 的关键决策，append-only
```

这里必须区分三种东西：market/provider cache 是可重建的原始数据；case memory 是某次研究的上下文；global knowledge 是跨 case 可复用的方法或已经审阅的事实。三者不能混在一个“记忆库”中。

### 4. 先接官方披露，不先堆行情 connector

美股研究的第一新增 provider 应是 SEC EDGAR，而不是第二个免费报价源。SEC 官方提供 submissions history、XBRL company facts、frames 和 nightly bulk archive，可为 filing 与结构化事实提供一手来源[[SEC EDGAR APIs]](https://www.sec.gov/edgar/sec-api-documentation)。具体实现应分两层：

- `DisclosureProvider` 返回 filing metadata、原文定位、段落和 source hash；
- `FundamentalsProvider` 把 XBRL facts 映射到内部 canonical fields，并保留 concept、form、filed、fy/fp、frame 和 accession。

对 A 股也采用同样契约，但数据源选择要单独完成条款、稳定性和 PIT 调研。不要让新浪/东财抓取逻辑直接成为全系统语义。yfinance 继续保留为个人研究和开发 fallback；项目自身已明确它不具备 SLA 或正式授权保证，因此不能承担未来生产数据层的唯一来源。

### 5. 把 CNE6 接成组合风险能力，而不是暴露算法零件

CNE6 完成正式全市场资产重建与质量验收后，增加 `RiskModelProvider`，对 Agent 只暴露少数高层工具：

- `finance_portfolio_exposure`：组合行业与风格暴露；
- `finance_portfolio_risk`：总风险、因子风险、特异风险和主要贡献者；
- `finance_marginal_risk`：拟议调仓前后的边际变化；
- `finance_scenario_stress`：对显式因子冲击做情景分析。

每次结果必须带模型版本、as-of date、universe coverage、缺失持仓、协方差质量和 fallback。不要让 LLM 直接拼矩阵或调用十几个 descriptor 工具。先支持“用户显式上传的持仓快照”，不直接接券商账户。

### 6. Preset 按工作职责拆分，不按市场或每个 Skill 拆分

当前单一 `finance-analyst` 对 12 个工具尚可，但加入 filing、知识、组合和 artifacts 后会迅速膨胀。建议形成三个 preset：

- `company-research`：identity、fundamentals、market、filing、estimates、valuation、evidence；
- `portfolio-risk`：holdings import、risk model、market、scenario、artifact；
- `decision-review`：trade audit、market evidence、case history、behavior references。

它们共享 `finance-core` 与 workspace contract。跨领域请求由一个薄的 coordinator 选择 preset 或 workflow，不要创建第二套 agent loop。这个方向同时继承 dsh-trading 的会话级能力隔离和 MLE 对 Skill 上下文的严格裁剪。

### 7. UI 只做“审阅面”，不做交易终端

短期继续复用 DSH Web。真正需要定制 UI 时，只做一个 Research Cockpit：

- 左侧：case、watchlist/portfolio、更新状态；
- 中间：memo、模型表格、敏感性图、风险贡献；
- 右侧：Agent 对话；
- 抽屉：来源原文、evidence lineage、assumption diff。

UI 的判断标准不是“像 Bloomberg/TradingView”，而是用户能否在 30 秒内回答：这个结论依赖哪些事实和假设？哪个来源过期？新信息改变了什么？如果 DSH artifact 和 tool-view 扩展足够，就不要做独立桌面壳。

## 五、分阶段路线图

### Phase 0：收口产品边界与契约（1–2 周）

目标是停止继续横向加功能，先固定未来两年的公共边界。

交付：

1. 新增仓库级 `AGENTS.md`，明确产品目标、目录职责、数据/时间/来源纪律、安全边界与 Git 规则。
2. 定稿 `InstrumentId`、capability provider interfaces、`SourceRef`、Evidence/Assumption/ModelRun schema。
3. 把现有 yfinance 包适配到 capability registry，保持现有 12 个 tool 的外部名称兼容。
4. 为 provider routing、fallback provenance、symbol translation 加 contract tests。
5. 把当前 CNE6 的 14 条 warning 分类：预期稀疏窗口显式抑制或转质量标记；PSD warning 增加修复后残差/最小特征值断言，避免测试长期噪声化。

验收：现有 `pnpm check` 全绿；所有当前 E2E 输出不变或有迁移说明；新增 provider 不需要实现无关 capability；任何 fallback 都可在结果中看见。

### Phase 1：跑通可审计 Company Research（2–4 周）

目标是让“deep dive”第一次名副其实。

交付：

1. Research Workspace 与 case create/open/update/archive 工具。
2. Evidence/Assumption Ledger 及 claim-level citation。
3. SEC submissions + filing document reader + Company Facts provider。
4. `company-research` preset 和“建立研究/事件更新/论点审计”三个 workflow Skill。
5. memo renderer：至少生成 Markdown，包含 conclusion、evidence、assumptions、valuation、risks、counter-thesis、falsifiers 和 limitations。
6. 选择 5 家结构差异明显的公司做冻结 as-of cases：普通工业/软件、银行、平台、周期品、高增长公司各一例。

验收：每个重大数字和事实都能定位到 evidence；更新一个 filing 后能列出 changed evidence/assumptions/claims；冻结案例重复运行不会因实时行情漂移而改变事实正确性得分；银行案例不会套用工业公司 FCF 模板。

### Phase 2：接通 Portfolio Risk 与研究记忆（3–5 周）

目标是把 CNE6 从“附带算法项目”变成 NGFI 的独特能力。

交付：

1. 全市场数据构建、覆盖率和 PIT 质量报告达到明确门槛后发布风险模型 snapshot。
2. `RiskModelProvider` 与四个高层组合工具。
3. 标准 holdings import schema，支持 CSV/JSON，拒绝账户凭据。
4. `portfolio-risk` preset，生成风险贡献、暴露、集中度和情景报告。
5. case/global knowledge 分层；研究结论可人工确认后晋升为可复用 knowledge，不能由 Agent 自动把未审阅观点写成事实。

验收：组合权重、未映射证券、币种和 as-of 都有硬校验；风险可按因子与持仓 reconciliation；拟议调仓前后结果可复算；模型 snapshot 更新不会覆盖旧报告的可重现性。

### Phase 3：运营化与轻量产品体验（按真实使用决定）

目标是让系统持续工作，而不是做一次 demo。

候选交付：研究任务队列、定时事件检测、结果通知、Research Cockpit、团队共享、权限和审计。触发条件应是前两阶段已有真实用户反复使用，而不是因为参照项目有 UI。

只有出现明确的“从 NGFI 发起订单”需求时，才单独立项 execution domain；届时至少采用 dry-run 默认、显式 live 开关、逐单审批、headless fail-closed、限额/标的白名单和 append-only audit。研究 Agent 不得直接持有执行权限。

## 六、评测与运营：真正决定系统能否变强

建议把测试分为四层，不再用一个总命令混合解释所有信号。

1. **Deterministic unit/contract**：公式、schema、normalization、identifier、routing、PIT 和 risk decomposition。
2. **Frozen replay**：固定 provider response、filing 和 as-of，比较结构化结果、引用完整性与 hard failures；这是回归主门禁。
3. **Live provider health**：只判断可访问性、schema drift、延迟、覆盖和 freshness，不评价 Agent 投资结论。
4. **Agent task eval**：在同一冻结证据包上比较模型/Skill，使用 rubric + hard failure + 匿名 pairwise；定期多采样，避免一次运行下结论。

此外增加真实使用指标：

- evidence coverage：重大事实有来源的比例；
- temporal integrity：时点/期间错误率；
- model reproducibility：同一 inputs 能否复算同一 outputs；
- update precision：新事件后只修改真正受影响的 claims 比例；
- human correction rate：用户纠正数字、来源、假设和结论的次数；
- task completion：从创建 case 到可审阅 memo 的完成率与耗时；
- hard failure rate：伪造来源、混淆历史/预测、无效估值、静默 fallback 等。

借鉴 MLE 的 self-improve 目标，用户纠正或重复失败应进入 triage：一次性 case 事实写 case knowledge；跨 case 的金融方法写 Skill/reference；provider bug 写代码和回归 fixture；运行时问题写 ops/lessons。任何自动晋升都要有人确认，防止错误沉淀。

## 七、明确不做清单

未来两个阶段建议明确不做：

- 不 fork DSH，不创建金融专用 ReAct loop。
- 不直接复制 dsh-trading connector 或 UI 代码；除产品不匹配外，还有非商业许可证约束[[dsh-trading License]](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/LICENSE)。
- 不以 connector 数量、Skill 数量或回答长度作为成功指标。
- 不在官方披露能力之前做复杂知识图谱；先用文件/SQLite、清晰元数据和确定性检索。
- 不让一个 provider 为所有数据负责，也不静默 fallback。
- 不把 yfinance、网页 snippet 或二手知识卡当作权威披露。
- 不在 CNE6 全市场资产与质量报告完成前宣称组合风险能力可用。
- 不近期做盘口、分钟级实时流、技术指标商店、策略托管、实盘下单或桌面客户端。
- 不让 Agent 自动把自己的推断写成跨 case 的“事实知识”。

## 八、现在就可以开始的十项 backlog

按价值和依赖排序：

1. 写 NGFI `AGENTS.md`，把产品边界和证据纪律变成每轮默认约束。
2. 为研究 case、Evidence、Assumption、Claim、ModelRun 写 schema 与 fixture。
3. 把 `FinanceDataProvider` 拆为 capability interfaces，并实现 registry/router。
4. 定义 canonical `InstrumentId` 和 provider symbol adapter。
5. 用现有 yfinance adapter 完成兼容迁移，确保 tool API 不破坏。
6. 实现 SEC submissions/companyfacts 最小 provider 与 source citation。
7. 创建 `company-research` preset 和 workspace 工具，完成一个 AAPL 冻结 case。
8. 把 25 个现有 eval 中最有区分度的 8–10 个变成冻结 replay，先追求深度而非数量。
9. 为 CNE6 定义 `RiskModelSnapshot` 契约与质量门槛，暂不挂 Agent。
10. 用 5–10 个真实研究任务做 dogfood，记录人工纠正，再决定 UI、消息入口和下一数据源。

如果团队容量有限，前六项就是下一里程碑。完成后，NGFI 会从“能调用金融工具的 DSH demo”跨到“可建立、更新并审计研究案例的系统”；而增加第 20 个数据工具不会产生同等级别的跃迁。

## 九、一个完整任务应该怎样流过系统

用“更新 AAPL 季报后的研究观点”可以检验上述设计是不是实际闭环，而不只是多了几种抽象。理想流程如下。

### 1. 创建或恢复研究案例

用户说“更新 AAPL 最新季报后的估值和风险”。coordinator 先用 canonical identity 解析出 AAPL 对应的证券、交易所、币种和 CIK，再查询是否存在相同 mandate 的 active case。不存在则创建；存在则读取简短 `MEMORY.md`、当前 claims、assumptions 和最后一次更新点，而不是把历史对话全部重新塞入 context。

case 的 `asOf` 必须明确。用户问“最新”时可以使用当前可得信息，但系统仍要记录执行时点；用户问“站在 2024 年末看”时，router 只能选择支持该时点的数据能力，不能把今天已知的事实泄漏进去。如果现有 provider 不支持 PIT，系统应拒绝把结果描述为严格历史回测。

### 2. 建立更新范围，而不是全量重做

DisclosureProvider 获取最新 10-Q/10-K metadata，与 case 中最后一个 accession 比较。若没有新 filing，则明确说明“官方披露无新增”，转而检查价格、consensus 或用户指定事件；若有新增 filing，只提取新文档及其与上一期相关段落的差异。每份原文 artifact 保存 URL、accession、下载时间、内容 hash 和解析版本。

结构化 facts 同样按 observation key 去重。新的收入记录不能简单覆盖旧记录，而应保留 fiscal period、form、filed date、frame 和修订关系。若 SEC XBRL 与 yfinance 聚合值不同，Evidence Ledger 同时保存两个 observation，并由质量策略决定哪个用于模型；报告必须解释差异，而不是挑一个看起来顺眼的数字。

### 3. 从证据变更传播到假设和结论

系统先生成 `EvidenceDelta`：新增、修订、失效、冲突和 unchanged。然后通过显式引用关系找到受影响的 assumptions 和 claims。例如服务收入增速、毛利率和资本开支变化可能影响收入增长、经营利润率、再投资率假设；现金余额变化只影响 EV–equity bridge，不应让整份竞争格局分析失效。

Agent 可以提出“把基准情景营业利润率从 A 调到 B”，但不能直接覆盖。它必须给出旧值、新值、证据、理由、受影响模型和置信度。如果变化由用户判断而非披露事实驱动，owner 应标为 `user` 或 `analyst`，不能伪装成 provider observation。

### 4. 确定性复算与冲突检查

所有受影响的 ModelRun 使用固定版本的输入引用重新执行。系统保留旧 run，不做原地覆盖；新 run 记录 core package version、公式版本、scenario、input refs、warnings 和 output。然后执行完整性检查：

- WACC 与 terminal growth 是否满足数学约束；
- 预测期收入、利润、税率、再投资和 FCF 是否互相 reconciliation；
- enterprise value 到 equity value 的现金/债务桥是否使用同一 observation cut；
- 股数、币种和每股单位是否一致；
- terminal value 占比是否过高；
- DCF、comps 和 consensus 的分歧能否由不同假设解释。

这些检查应返回结构化 violations，而不只是一段 prompt。Agent 只能解释或请求用户改变假设，不能绕过硬失败继续给“正常目标价”。

### 5. 输出增量 memo 与审计包

最终交付不只是新版 memo，还应有一页 change summary：

- 新增了哪些一手证据；
- 哪些旧证据失效或被修订；
- 哪些假设改变、谁决定、为什么；
- 估值区间和主要风险如何变化；
- 哪些原结论保持不变；
- 下一次需要观察的证伪指标与时间点。

用户在 UI 或 Markdown 中点开任一重要论断，都能走 `claim → evidence/model run → source/input` 回溯。若用户纠正了一个映射错误，该纠正先进入当前 case；确认属于通用 provider bug 后，再生成 fixture 和代码修复。至此，任务才算完成。

这个例子也说明为什么 Research Workspace、ledger 和 capability routing 的优先级高于新 UI：没有这三层，再漂亮的页面仍只是展示一次性文本。

## 十、关键架构决策与取舍

### 决策 1：保持 DSH 为唯一 Agent runtime

**选择**：继续通过 profile、bundle、preset、Skill 和 tool adapter 扩展 DSH。

**放弃**：自建金融 ReAct loop、复制 session/retry/context/compaction、在 core 中嵌入另一个 agent framework。

**理由**：NGFI 的竞争力来自金融数据语义、模型与工作流，不来自通用 orchestration。MLE-Agent 的实践也说明，垂直项目可以在不 fork DSH 的情况下完成复杂任务。只有 DSH 明确无法表达且已有重复失败证据时，才增加小型插件，而不是先造 runtime。

### 决策 2：运行时继续项目内隔离

**选择**：保留仓库内 `.runtime`、固定依赖、最小工具 allowlist 和只读默认权限。

**放弃**：照搬 MLE 的全局 profile 同步方式，或默认继承用户机器上的全部 Skill/CLI。

**理由**：NGFI 更需要可复现、可发布的组合，也可能处理持仓和研究材料。全局能力会让同一 commit 在不同机器上看到不同工具，还会扩大数据泄露和误操作面。未来若同时支持开发者安装和终端用户安装，可以提供显式的 external-integration profile，但不能改变默认隔离原则。

### 决策 3：稳定面是领域契约，不是 provider 返回格式

**选择**：`InstrumentId`、Observation、Evidence、Assumption、ModelRun 和 RiskSnapshot 是稳定公共面；provider schema 只存在于 adapter 内。

**放弃**：把 yfinance、SEC、东财或某个付费数据源的字段直接穿透到 Skill 和 UI。

**理由**：数据源一定会更换、缺字段或改变 schema。只要上层依赖 provider 私有字段，就无法真正做到 router 和 fallback。canonical contract 不应追求覆盖所有供应商字段，而应覆盖 NGFI 已承诺的研究语义；特殊原始字段可附在 provenance 中，不进入默认推理面。

### 决策 4：按 capability 路由，且禁止静默降级

**选择**：同一研究案例可以由多个 provider 分别负责 identity、price、filing、fundamentals、estimates 和 risk；每个 observation 保留实际来源。

**放弃**：为每个市场选一个“万能 provider”，或 provider 失败时静默换源。

**理由**：研究结论常常需要跨源，而且不同源对时点、调整口径和授权的保证不同。fallback 不是纯工程细节，它可能改变结论质量。因此降级必须成为 Evidence 的一部分，严重时触发 incomplete，而不是只写一条后台日志。

### 决策 5：文件优先，数据库后置

**选择**：Phase 1 用 versioned JSON/YAML/JSONL/Markdown 建 case workspace；索引规模或并发需要出现后再引入 SQLite。

**放弃**：一开始建设向量数据库、知识图谱服务或多租户后端。

**理由**：文件最容易人工审计、diff、备份和修复，符合当前单机 DSH 形态。Evidence 的主查询维度是 case、instrument、time、source 和 claim ref，并不天然需要 embedding。未来引入数据库时，文件 schema 可以成为逻辑模型和迁移源，而不是前期原型债务。

### 决策 6：知识写入需要人工确认

**选择**：Agent 可以提出 `knowledge candidate`，但跨 case knowledge 的晋升由人确认；原始来源和有效期必须保留。

**放弃**：把模型生成的 memo 自动切片并写入长期知识库。

**理由**：金融结论高度时变且带条件。无审核的自动记忆会把暂时推断、过期政策和错误映射固化，后续检索又会把它当证据，形成反馈污染。case 内记忆可以自动维护，因为其边界和来源明确；global knowledge 的门槛应更高。

### 决策 7：研究与执行分域

**选择**：近期没有账户读取和下单工具；持仓由用户显式导入。未来 execution 单独建 service、preset、权限和审计。

**放弃**：为了“Agent 原生”让研究 Agent 直接拥有交易能力。

**理由**：研究错误通常可修订，交易错误会产生不可逆损失。dsh-trading 的多重闸门值得借鉴，恰恰说明执行不是再加一个 tool 那么简单。即使未来上线，研究结论也只能生成 order proposal，不能绕过人类审批。

### 决策 8：UI 跟随已验证对象，而不是先定义产品

**选择**：先用 DSH Web、Markdown artifact 和结构化 tool result 验证工作流；定制 UI 只展示已经稳定的 case、ledger、model run 和 risk snapshot。

**放弃**：先复制 dsh-trading 三栏终端，再寻找内容填充。

**理由**：UI 会固化领域对象和交互模型。如果底层还没有“更新研究”和“审计假设”的稳定语义，页面只能围绕聊天和行情组织，反而把 NGFI 拉回同质化方向。

## 十一、主要风险与控制办法

| 风险 | 早期信号 | 控制办法 |
|---|---|---|
| 过度设计 ledger | schema 字段很多，但真实 case 没有消费者 | 从 5 个冻结 case 反推最小字段；未被审计、更新或渲染使用的字段不进入 V1 |
| provider 扩张失控 | 每接一个源都新增一套工具名 | provider 只注册 capability；工具名表达用户任务，不表达供应商 |
| 多源冲突被掩盖 | 报告只显示最终数字，没有候选 observation | 冲突进入 Evidence；质量策略和选择理由可见；重大冲突阻断自动结论 |
| 时点穿越 | 历史 case 使用今天的估值、股数或修订后财报 | 所有读取接受 `asOf`；不支持 PIT 的 capability 显式声明并禁止用于严格回放 |
| 文档抽取幻觉 | 引用存在，但原文不支持 claim | 保存 excerpt、定位和 hash；claim-level entailment 抽检；无法读取正文时不得引用 snippet 充数 |
| CNE6 伪精度 | universe 缺失或协方差质量差仍给精确风险值 | RiskSnapshot 带 coverage/quality；门槛不达标返回 partial/invalid；保留旧 snapshot |
| Agent context 膨胀 | 工具和 Skill 越加越多，选择错误率上升 | 按工作职责拆 preset；Skill 渐进加载；固定 prompt 层保持稳定 |
| 评测过拟合 | 25 个案例得分提高，真实任务仍需大量纠正 | 冻结回归、live health、真实 dogfood 三套指标分开；保留隐藏案例和多采样 |
| 数据授权阻塞产品化 | 开发源可用，但无法对外或商业使用 | provider metadata 记录 usage class；生产 profile 只允许审核通过的数据源 |
| 长期记忆污染 | 旧结论在新 case 中被当作当前事实 | knowledge 带来源、有效期、review status；默认只作为线索，当前事实仍回到原始来源核验 |
| 安全边界漂移 | 新工具绕开只读策略或可访问用户未授权目录 | tool allowlist、workspace scope、敏感数据测试和服务层鉴权；高风险能力独立 profile |
| 工程重心被 UI 吸走 | 大量时间用于图表细节，研究成功率不变 | UI 立项必须绑定可量化审阅问题和真实用户频次；没有数据则继续使用 DSH Web |

其中最大的失败模式不是某个技术选型错误，而是目标漂移：一边做研究 Agent，一边追逐行情终端、量化平台、个人理财、知识管理和实盘交易。建议每个新需求都先回答：它是否提高三条主工作流之一的完成率、可信度或更新效率？不能回答，就先不进入主线。

## 结论

NGFI 最值得坚持的是现有的可信内核：canonical observation metadata、显式缺失状态、确定性金融计算、provider 隔离、工具白名单和质量 rubric。最需要改变的是产品组织方式：从一次性回答转向持久 research case，从单 provider 聚合转向 capability routing，从“分析结果”转向 evidence–assumption–model–claim 可追溯链，从孤立 CNE6 算法转向组合风险工作流。

一句话概括三者的组合：**用 NGFI 的金融契约和确定性计算做内核，用 MLE-Agent 的工作流、记忆和运营方式把它变成能长期干活的 Agent，再选择性吸收 dsh-trading 的 provider registry、canonical identity 与安全闸门；不要复制它的交易终端产品面。**

## 参考资料

1. [NGFI README](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/README.md)
2. [NGFI Finance2DSH 设计与实施计划](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/docs/finance2dsh-plan.md)
3. [NGFI 运行与测试说明](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/docs/running-and-testing.md)
4. [NGFI canonical contracts](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/packages/finance-core/src/contracts.ts)
5. [NGFI yfinance provider](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/packages/finance-provider-yfinance/src/index.ts)
6. [NGFI finance tool policy](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/packages/dsh-finance-bundle/src/policy.ts)
7. [NGFI evaluations](https://github.com/Jelwery/NGFI/blob/5f9b30e7b60781c6ac93a8c9381dda6cd5a59c1f/evals/README.md)
8. [dsh-trading 中文 README](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/README_zh.md)
9. [dsh-trading Agentic Native 架构](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/docs/design/agentic-native-architecture.md)
10. [dsh-trading connector playbook](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/docs/connector-playbook.md)
11. [dsh-trading canonical symbol vocabulary](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/docs/symbol-vocabulary.md)
12. [dsh-trading API contracts](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/packages/api/src/index.ts)
13. [dsh-trading provider router](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/packages/router/src/index.ts)
14. [dsh-trading knowledge design](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/docs/design/knowledge-graph.md)
15. [dsh-trading strategy engine](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/packages/strategies/src/engine.ts)
16. [dsh-trading License](https://github.com/zhu1090093659/dsh-trading/blob/31917e5abcdca060e65e1cc85dab6ba097fdb043/LICENSE)
17. [MLE-Agent RecCore README](<external-mle-reference>/README.md)
18. [MLE-Agent RecCore AGENTS](<external-mle-reference>/AGENTS.md)
19. [MLE-Agent RecCore group memory Skill](<external-mle-reference>/.agents/skills/lark-group-memory/SKILL.md)
20. [MLE-Agent RecCore proto-eval Skill](<external-mle-reference>/.agents/skills/proto-eval/SKILL.md)
21. [MLE-Agent RecCore 运维说明](<external-mle-reference>/docs/ops.md)
22. [SEC EDGAR APIs](https://www.sec.gov/edgar/sec-api-documentation)
23. [OpenFIGI API Documentation](https://www.openfigi.com/api/documentation)
