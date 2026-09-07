# Finance2DSH 设计与实施计划

状态：V1 已落地并通过本机真实链路验收
日期：2026-08-30

## 1. 项目目标

Finance2DSH 的目标不是复刻 FinanceHarness，也不是参加 FinanceGym 排行，而是把 FinanceHarness 中有价值的金融分析方法迁移到原生 DeepSeek Harness（DSH）上，形成一套可插拔、可测试、可替换数据源的金融研究能力。

核心原则：保留 FinanceHarness 的金融语义、分析工作流和工具设计，复用 DSH 的 agent loop、context、工具运行时、Skills、会话和恢复机制。

首版重点验证三个问题：

1. DSH 原生 loop 配合高质量金融 Skills，能否稳定执行完整的公司研究流程。
2. 结构化金融数据工具和确定性计算工具，能否显著降低数字、期间、单位和估值错误。
3. 这套能力能否以外置 bundle/plugin 接入 DSH，而不修改 DSH core。

## 2. 明确的非目标

首版不做：

- 不 fork、clone 或修改 DSH 源码。
- 不迁移 FinanceHarness 的 Agent.run、dispatch、tool registry、skill registry、session、SSE、recovery、retry 和 context-budget 代码。
- 不创建第二套 ReAct loop 或金融专用 agent runtime。
- 不使用 MCP。
- 不以 FinanceGym benchmark 或 leaderboard 为目标。
- 不建设 FinanceGym 冻结语料库、FAISS/SQLite 检索服务或严格 PIT 环境。
- 不建设 Gateway、门户、多用户隔离或远程部署系统。
- 不在首版一次性迁移全部金融工具。
- 不把 yfinance 当成有 SLA 或生产授权保证的正式数据源。

## 3. 与现有 DSH 的关系

### 3.1 参考工程

参考 <external-dsh-reference> 的以下工程实践：

- 独立 workspace 管理固定版本的 DSH npm 依赖。
- 用 package.json 的 dsh.bundle.patch 声明外置 bundle。
- 用 cordis.patch.yml 装配插件，而不是修改 DSH core。
- Profile 决定一套运行时加载哪些 bundles。
- Agent source config 生成 DSH preset。
- Preset 对每个 Agent 做工具 allow-list 和 Skill 挂载。
- 使用独立 .runtime 作为项目专属 DSH_HOME。
- 提供 generate、validate、test、typecheck、check 等确定性命令。

暂不照搬：

- RecPilot Gateway 和 iframe 集成。
- Supabase session persistence。
- 多用户 workspace namespace。
- TQS/TrustData MCP 生成逻辑。
- 与 RecPilot 业务绑定的 Agent schema 字段。

### 3.2 不影响本地原生 DSH 的硬约束

Finance2DSH 必须独立拥有：

- Node/Python 依赖和 lockfile。
- Profile 和 bundle 配置。
- 生成目录。
- Skills 根目录。
- .runtime 状态目录。
- 测试临时目录和临时端口。

不得：

- 修改 ~/.dsh/settings.yaml。
- 修改 ~/.dsh/profiles/web。
- 写入 ~/.dsh/skills 或 ~/.agents/skills。
- 复用原生 DSH 的 session、storage 或 profile 目录。
- 把插件复制进 DSH 安装包目录。
- 在测试中默认监听 3080 或 3090。
- 依赖 <external-dsh-reference>/node_modules 运行。

开发运行时设置：

    DSH_HOME=<repositoryRoot>/.runtime
    Finance 开发 Runtime 默认端口=3180

端口规则：

- 单元测试不启动网络服务，不占用端口。
- Composition 测试使用 dsh --dump-config，不启动服务。
- E2E 测试动态申请空闲 loopback 端口，不写死 3080、3090 或 3180。
- 手工开发默认可用 3180，但启动前必须检查端口是否空闲；支持环境变量覆盖。
- 测试结束必须等待子进程退出；所有状态只允许留在项目 `.runtime` 中。

### 3.3 DSH 概念映射

| DSH 概念 | 职责 | Finance2DSH 用法 |
|---|---|---|
| Profile | 决定运行时安装和启用哪些 bundles | 独立 finance-dev profile |
| Bundle | 可安装的插件组合 | 装配 Finance 工具和默认配置 |
| Provider | 一项数据能力的具体实现 | yfinance；未来可替换正式数据源 |
| Preset | 某类 Agent 的 persona、工具和 Skill | finance-analyst |
| Skill | 描述金融任务的分析流程 | DCF、深度研究、相对估值等 |
| Tool | 查询数据或执行确定性计算 | fundamentals、WACC、DCF 等 |

## 4. 总体架构

    DSH 原生 Profile / Agent Loop / Session / Context
                             │
                             ▼
                    dsh-finance-bundle
                             │
                             ▼
                     dsh-finance-tools
                   （唯一 DSH adapter）
                             │
                             ▼
                       finance-core
              contracts / normalization / compute
                             │
                             ▼
                 finance-provider-yfinance
                             │
                             ▼
                  本地 Python yfinance runner

依赖方向必须单向：

    DSH profile
      → dsh-finance-bundle
      → dsh-finance-tools
      → finance-core interfaces
      ← finance-provider-yfinance

约束：

- finance-core 不 import 任何 DSH package。
- Provider 不感知 DSH agent、session、tool call 或 UI。
- 只有 dsh-finance-tools 和 bundle 可以 import DSH/Cordis API。
- Skills 可以依赖稳定的工具名称和输出语义，但不能依赖 DSH 内部实现。
- 领域计算优先写成纯函数，便于脱离 DSH 测试。
- Provider 输出先规范化成内部 contract，再交给 DSH adapter。

## 5. 建议目录结构

    Finance2DSH/
    ├── package.json
    ├── pnpm-workspace.yaml
    ├── pyproject.toml
    ├── README.md
    ├── docs/
    │   └── finance2dsh-plan.md
    ├── packages/
    │   ├── finance-core/
    │   │   ├── src/contracts/
    │   │   ├── src/normalization/
    │   │   ├── src/valuation/
    │   │   └── src/risk/
    │   ├── finance-provider-yfinance/
    │   │   ├── src/
    │   │   └── python/
    │   ├── dsh-finance-tools/
    │   │   └── src/
    │   └── dsh-finance-bundle/
    │       ├── package.json
    │       └── cordis.patch.yml
    ├── agents/
    │   └── finance-analyst.json
    ├── prompts/
    │   └── finance-analyst.md
    ├── skills/
    │   ├── ticker-snapshot/SKILL.md
    │   ├── financial-analysis/SKILL.md
    │   ├── dcf-valuation/SKILL.md
    │   ├── relative-valuation/SKILL.md
    │   ├── consensus-check/SKILL.md
    │   └── equity-deep-dive/SKILL.md
    ├── profiles/
    │   └── finance-dev/
    ├── generated/
    ├── evals/
    │   ├── cases/
    │   ├── rubric/
    │   └── baselines/
    └── tests/

目录可以在实现时按 DSH package 的实际发布约束微调，但职责边界不变。

## 6. 金融研究 Loop

Finance2DSH 不实现新的循环。金融研究流程主要由 persona 和 Skills 表达，交给 DSH 原生 agent loop 执行：

    1. Scope
       确认公司、证券、市场、问题、报告期、币种和输出深度

    2. Research
       搜集近期业绩、指引、战略、行业变化及 bull/bear 观点

    3. Ground
       获取公司身份、基本面、资产负债、价格和市场数据

    4. Model
       显式建立假设，执行 WACC、DCF、敏感性和相对估值

    5. Reconcile
       比较 DCF、comps、consensus，定位和解释分歧

    6. Audit
       检查来源、期间、币种、单位、假设、缺失项和计算一致性

    7. Synthesize
       输出判断、估值区间、关键驱动、催化剂、风险和置信边界

首版不引入显式金融状态机。如果评测显示模型经常跳过关键步骤，再考虑增加：

- assumptions ledger；
- evidence ledger；
- completeness checker；
- agent-scoped task context。

这些能力应作为独立插件或可选 service，而不是修改 DSH loop。

## 7. Web 研究方案

首版不迁移 FinanceHarness 的 DDGS search、visit、reader 和 citation runtime。

优先复用 DSH：

- ctx.web provider seam；
- web_search；
- web_fetch；
- 并发搜索、去重、超时、取消；
- canonical output；
- source URL、snippet、publishedAt；
- DSH 原生 UI 和 session event。

金融 Skills 强制以下研究纪律：

1. 搜索结果用于发现来源，不把 snippet 自动视为充分证据。
2. 关键事实优先读取公司 IR、监管机构、交易所和正式 filing 正文。
3. 引用必须能够实际支持对应结论。
4. 明确区分网页发布日期、财务报告期和市场数据观察时间。
5. 无法读取正文时标注限制，不补造细节。
6. 重要数字优先来自结构化金融工具；网页数字用于交叉验证。

V1 profile 不启用 `web_search` / `web_fetch`。当前 DSH 的默认 `web_search` 依赖另一套 provider 凭证，`web_fetch` 也没有在本项目中配置可用 provider；为避免把未验证的研究能力混入金融闭环，初始 finance preset 只允许 `skill` 和九个 `finance_*` 工具。后续投资行为诊断升级新增三个 `finance_behavior_*` 工具，但 web 仍未启用；新闻、filing 正文与网页引用研究继续留待独立 provider 阶段。

DSH 当前 web seam 尚不原生覆盖 PDF 类型和复杂文档抽取。只有评测确认这是主要失败来源后，才新增 finance_document_read，避免过早复制 FinanceHarness reader。

## 8. V1 工具范围

### 8.1 数据工具

#### finance_security_reference

提供 canonical ticker、公司名称、交易所、国家/地区、sector/industry、quote currency、当前价格及其观察时间、shares outstanding、market cap、beta 和 52-week range。

#### finance_fundamentals

提供年度、季度或 TTM 的标准化基本面，包括 revenue、operating income、net income、EBITDA、operating cash flow、capex、free cash flow、cash、debt、margins 和 growth rates。

必须明确 fiscal period、period type、currency 和单位。

#### finance_market_data

提供历史 OHLCV、调整后价格、收益率、SMA 等基础派生指标，以及无风险利率等估值所需市场输入。

#### finance_estimates

若首个 provider 能稳定支持，则提供 forward EPS/revenue、analyst counts、price target 分布和 rating distribution。如果 yfinance 数据完整性不足，本工具可延后至 V1.1，不以不稳定字段阻塞核心闭环。

#### finance_comparables

接受目标公司和显式 peer ticker 列表，返回原始 peer 指标、标准化估值倍数、缺失值说明、peer median，以及应用到目标公司的 implied value range。

工具不自动声称 peer 选择合理；peer 选择及理由由 Skill/模型负责。

### 8.2 计算工具

- finance_wacc
- finance_dcf
- finance_dcf_sensitivity
- finance_relative_valuation

计算工具必须：

- 使用纯函数核心。
- 对输入进行完整范围和单位校验。
- 返回中间量而不只返回最终价格。
- 清楚区分输入数据与模型假设。
- 对 WACC 小于或等于 terminal growth 等无效组合显式失败。
- 返回 terminal value 占 enterprise value 的比例。
- 可以脱离 DSH 做 golden tests/property tests。

### 8.3 暂缓工具

- 通用 calc：优先使用 DSH Code Mode 或语言自身算术能力。
- beta、VaR、correlation 专用工具：不是公司基本面研究首版关键路径。
- FinanceGym/PIT search/fetch。
- 自定义 update_plan、load_skill、load_tool。
- FinanceHarness 的 compose_citations。

## 9. Canonical 数据契约

至少建立以下公共概念。

### 9.1 Observation metadata

    interface ObservationMeta {
      provider: string
      source?: string
      retrievedAt: string
      observedAt?: string
      reportedAt?: string
      fiscalPeriod?: string
      periodType?: 'annual' | 'quarterly' | 'ttm' | 'spot' | 'estimate'
      currency?: string
      unit?: string
    }

### 9.2 Field status

字段不能用无意义的 0 替代缺失值。至少区分：

- available
- missing
- not-applicable
- provider-error
- stale

### 9.3 数值原则

- 内部明确原始单位和归一化单位。
- 百分比与小数倍数不能混用。
- 金额必须携带 currency。
- 财务期间必须携带 annual/quarterly/TTM/estimate。
- NaN、Infinity、numpy scalar 等不得进入 JSON contract。
- 不对缺失字段静默填充或猜测。

严格 PIT 不是 V1 要求，但所有数据都应保留可获得的观察时间、报告时间和来源，为未来 asOf provider 留出兼容空间。

## 10. yfinance Provider

### 10.1 凭证和定位

yfinance 通常不需要 API key、token 或 Yahoo 登录。它是 Yahoo Finance 公开接口的非官方 Python 封装，而不是有 SLA 的官方数据服务。

因此首版可以零凭证运行，但必须接受以下事实：

- 可能限流或返回 HTTP 429。
- Yahoo 页面/API 变化可能使字段失效。
- Ticker.info 和 analyst/estimate 字段可能缺失或变化。
- 不同市场的 ticker、币种和字段覆盖不同。
- 无 token 不代表无限量、稳定或拥有商业数据授权。

### 10.2 首版接入方式

不使用 MCP。推荐：

    DSH TypeScript tool
      → finance-provider-yfinance TypeScript adapter
      → 本地 Python runner
      → yfinance
      → JSON stdout

Python runner 是 provider 私有实现，不开放服务端口。

首版实现要求（已完成；暂未实现的性能增强另行标注）：

- 使用固定 Python/yfinance 版本和 lockfile。
- 输入和 stdout 使用版本化 JSON envelope。
- stdout 只输出协议 JSON，诊断写 stderr。
- 对超时、取消、非零退出和 malformed JSON 分类报错。
- 每次工具调用按业务对象批量取字段，避免逐字段启动 Python。
- TypeScript adapter 支持取消、超时、输出上限与 TTL cache；provider 级指数退避暂缓，交由 DSH LLM retry 与后续正式数据 provider 分别负责。
- 对可安全缓存的静态/低频字段增加 TTL cache。
- 将 yfinance 原始字段映射集中在 provider 包，不泄漏到 finance-core。
- 默认测试覆盖纯函数、进程协议错误、DSH tool adapter、composition、runtime 隔离和 eval 资产；live yfinance 单独标记，不进入默认稳定测试。

如果后续进程启动成本成为瓶颈，再评估常驻 worker；首版不预先增加生命周期复杂度。

## 11. Skills 规划

### ticker-snapshot

快速回答公司身份、规模、价格位置和近期走势。

### financial-analysis

分析收入、利润率、现金流、资产负债、盈利质量和主要异常，强调三张表交叉验证。

### dcf-valuation

从基本面和市场输入建立显式预测、WACC、DCF 和敏感性区间。

### relative-valuation

要求显式选择 peer、解释选择理由、对比增长/利润率/回报率，避免只比较倍数。

### consensus-check

区分历史事实和 sell-side expectation，并用近期业绩、指引和修正方向进行验证。

### equity-deep-dive

组合前述能力，完成 qualitative research → fundamentals → valuation → reconciliation → synthesis。

FinanceHarness 的五个 Skills 只能作为初稿参考，需要重写：

- 删除 prev:call-id 等 FinanceHarness runtime 专属语法。
- 使用 Finance2DSH 的稳定工具名称和 canonical output。
- 加强期间、单位、币种、来源和缺失值纪律。
- 把敏感性分析设为 DCF 的默认组成部分。
- 增加财务质量和三表交叉验证，而不是只做 Yahoo 字段汇总。

## 12. Rubric 与评测

Rubric 用于回归和架构决策，不用于刷 FinanceGym 排名。

### 12.1 六个主维度

| 维度 | 检查内容 |
|---|---|
| 数据正确性 | 数字是否来自工具，单位、币种和符号是否正确 |
| 时间口径 | FY/Q/TTM、历史/当前/预测是否区分 |
| 来源质量 | 关键事实是否来自实际读取且可靠的来源 |
| 方法正确性 | WACC、DCF、comps 的公式和输入使用是否正确 |
| 分析完整性 | 是否覆盖业务、财务、估值、催化剂与风险 |
| 综合判断 | 是否解释证据冲突，而非机械罗列或平均 |

### 12.2 硬性失败项

- 编造财务数字或来源。
- 用当前值冒充历史报告期数据。
- 混淆币种、单位、百分比和倍数。
- 将 consensus/forecast 写成事实。
- DCF 输入与文字假设不一致。
- WACC 小于或等于 terminal growth 时仍输出正常估值。
- 引用未读取或不能支持结论的网页。
- 只给目标价，不披露关键假设和敏感性。

### 12.3 初始 case set

先准备约 20–30 个高质量案例：

- 5 个 ticker snapshot。
- 5 个财务质量分析。
- 5 个 DCF。
- 5 个相对估值。
- 5 个完整 deep dive。
- 若干缺数据、币种差异、异常行业或数据冲突案例。

每阶段与“原生 DSH + 通用 Web、无 Finance 工具”的 baseline 比较，不以工具数量或回答长度作为成功指标。

## 13. 分阶段实施与当前状态

### Phase 0：工程骨架与 baseline（已完成）

工作：

- 建立独立 pnpm workspace 和 Python 环境。
- 固定 DSH npm 版本。
- 建立隔离 DSH_HOME 和端口策略。
- 建立最小 finance-dev profile。
- 建立 rubric 和首批 baseline cases。
- 验证 profile 可以执行 --dump-config，且不会访问 ~/.dsh。

验收：

- pnpm check 可重复通过。
- 默认测试不监听端口。
- E2E 不使用 3080/3090。
- 原生 DSH 配置和 session 无变化。

### Phase 1：Skills-first（已完成，Web research 除外）

工作：

- 建立 finance-analyst preset/persona。
- 重写六个金融 Skills。
- 暂不启用未经本项目验证的 web_search 和 web_fetch。
- 保留 rubric/case set 作为后续 baseline 对照入口。

目的：

- 先测量“工作流和分析纪律”本身的价值。
- 避免将工具实现和 prompt 改进混在一次实验中。

### Phase 2：核心数据与估值工具（已完成）

工作：

- 实现 finance-core contracts 和 normalization。
- 实现 yfinance Python runner/provider。
- 实现 reference、fundamentals 和 market data。
- 实现 WACC、DCF、sensitivity、relative valuation。
- 用薄 DSH adapter 注册 canonical tools。

验收：

- 纯计算拥有 golden tests 和边界测试。
- 数据字段有来源、期间、币种、单位和状态。
- provider 故障不会被误呈现为 0 或正常值。
- rubric 相比 Phase 1 baseline 有可解释提升。

### Phase 3：研究可靠性（部分完成）

工作：

- 完善 estimates/consensus，或根据 provider 质量决定延后。
- 强化网页证据和引用纪律。
- 增加 assumptions/evidence audit。
- 用失败案例优化 Skill 和工具 schema。
- 评估长 PDF/filing reader 是否成为必要能力。

### Phase 4：可选扩展（部分完成）

- 第二数据 provider。
- 正式/授权数据源。
- 将已迁移的 CNE6 风险引擎在全市场资产验收后接成只读 DSH tools。
- 可选 asOf/PIT provider。
- 常驻 Python worker。
- 接入 RecPilot managed profile。

任何扩展都应保持 finance-core 与 DSH 解耦。

## 14. 测试策略

### 单元测试

- 金融公式。
- 字段映射和单位转换。
- 缺失值、NaN、Infinity 清洗。
- 时间期间解析。
- provider error taxonomy。
- 工具参数和 canonical output schema。

### Contract tests

- Python runner 请求/响应版本。
- yfinance recorded fixture → canonical domain model。
- DSH tool schema → finance-core input/output。

### Composition tests

- bundle 可以被独立 profile 解析。
- 最终 config 包含期望插件且不修改用户 profile。
- finance preset 只暴露授权工具。
- web_search/web_fetch 的启用状态明确。

### E2E tests

- 使用项目隔离的 DSH_HOME（`Finance2DSH/.runtime`），不访问用户原生 `~/.dsh`。
- 使用动态空闲端口和 loopback host。
- 测试结束清理子进程。
- 默认使用 fixtures 或 mock provider。
- live yfinance 测试单独运行，失败不与纯逻辑回归混淆。

## 15. 后续接入 RecPilot 的方式

Finance2DSH 独立验证通过后，再对 <external-dsh-reference> 做最小接线：

1. 将发布后的 Finance bundle 加入 managed profile dependencies/bundles。
2. 扩展 Agent source schema，使金融 Agent 能选择 Finance 工具和 Web 工具。
3. 新增 finance-analyst agent config、prompt 和 Skills。
4. 由 generator 生成 preset 和严格 allow-list。
5. 不修改 @deepseek-ai/dsh、agent loop、session 或 Web UI。

这一步不应通过复制 Finance2DSH 源码进入 RecPilot 完成，而应优先消费一个版本化 package；本地开发阶段可以使用 workspace/file dependency。

## 16. 已确认的 V1 决策

- 市场聚焦美股，验证后再扩展其他市场。
- DSH 固定为 `0.1.1-rc.2`，Trae 插件固定为 `0.1.3`。
- 使用外置 bundle、profile patch 和 preset，不 clone/fork、不修改 DSH core。
- 项目运行状态固定在 `Finance2DSH/.runtime`；不读写 `~/.dsh`。
- 默认模型固定为 `trae-official / GPT-5.6-Sol / xhigh`。
- yfinance 无 token；`finance_estimates` 为 best-effort，失败不得阻塞 fundamentals + DCF。
- 默认输出语言跟随用户；字段名和工具 contract 保持英文。
- PIT 只在 contract 层预留，不做实现。
- 不增加 `ctx.finance` service，直到出现第二个 provider 或跨工具的 agent-scoped 状态。
- 不使用 MCP。

## 17. V1 落地清单与验收结果

已实现：

- `finance-core`：canonical contracts、缺失值/JSON-safe normalization、WACC、DCF、敏感性、相对估值。
- `finance-provider-yfinance`：版本化 stdin/stdout runner、超时/取消/输出限制/TTL cache，以及 reference、fundamentals、market、estimates、comparables。
- `dsh-finance-tools`：九个初始金融工具；投资行为诊断升级另加三个 provider-neutral 行为工具，当前共十二个 `finance_*` tools。
- `dsh-finance-bundle`：全局工具注册、preset-scoped allowlist、薄 headless runner。
- `finance-headless` / `finance-dev`：独立 profile；Web 默认 3180，3080/3090 被拒绝。
- `finance-analyst` preset 与七个 Skills（含后续接入的 `investment-behavior-diagnosis`）。
- 六维 rubric、八项 hard failure 和 25 个初始案例。
- 项目 runtime materializer：只在 `.runtime` 中生成 profile、preset、settings、session/storage。

本机 2026-08-30 验收：

- build 和 TypeScript typecheck 通过。
- 默认稳定测试通过：6 个测试文件、23 项测试。
- 六个 Skills 均通过 `skill-creator/scripts/quick_validate.py`。
- live yfinance：AAPL reference/market、fundamentals、estimates 均通过。
- DSH headless 真调用通过：`trae-official / GPT-5.6-Sol / xhigh`，挂载 `finance-analyst`，调用 `skill`、`finance_security_reference` 与 `finance_market_data` 后完成回答。
- Web smoke 通过：动态申请 loopback 端口并收到 HTTP 200；验收后子进程已退出，未占用 3080/3090。
- 安全复核通过：`.runtime` 中无 token/auth/secret 文件，模型设置文件权限为 0600，无 Finance2DSH 遗留进程。

## 18. CNE6 组合风险引擎迁移

`<external-cne6-handoff>` 已迁入 `packages/combinatorial-optimization/`，作为与 DSH 和 yfinance 解耦的 Python package。保留三层架构、算法、测试、交接手册与参考实现，并做了以下项目化调整：

- 数据资产改为 package-local `data/`，不再依赖不存在的相邻 CNE5 目录。
- 独立 `.venv`、`uv.lock` 与测试脚本，不污染根 yfinance 环境。
- 数据源严格保持为新浪行情、AKShare/Sina 基准、AKShare/东财财务与分红；不替换为 yfinance。
- 移除重复 MiniRacer 直依赖以解决同名模块冲突，并修正实测东财字段映射。
- 稳定测试纳入根 `pnpm check`；真实网络测试通过 `pnpm test:live:cne6` 显式执行。
- 已新增独立的一键数据 CLI：`probe`、`rebuild`、`validate`、`smoke`。它不接入 DSH runtime，不启动端口；默认串行限速，带指数退避、按日期窗逐股 checkpoint、严格 schema/coverage 校验和校验后原子发布。
- 行情首选交接手册允许的东财 qfq 与真换手率；因本机实测 push2 域会持续主动断连，`auto` 可回退到新浪未复权行情。小股票池市值可回退为新浪现价 × 东财股本结构，实际来源写入质量报告，不静默掩盖。

迁移验收口径分两层：算法与 synthetic pipeline 必须稳定通过；真实源 smoke 必须能读取新浪贵州茅台日线、沪深 300、东财年报与分红。由于原交接包没有携带全市场 Parquet 资产，完整 5,000+ 股票协方差管线必须在重建资产后另行验收，当前不声明完成。CNE6 尚未挂载到 DSH allowlist，以免暴露一个缺少生产资产的工具。

本机迁移与 CLI 完成后实测：CNE6 稳定套件 129 passed、2 skipped；真实源套件 3 passed。新浪贵州茅台日线返回 5,993 行，AKShare/Sina 沪深 300与 AKShare/东财 2024 年报三表、分红均成功。

2026-08-31 进一步完成一键重建 CLI 的真实小样本验收：单 worker、1.5 秒请求间隔，600519/000001，2026-07-01 至 2026-08-29，2024 年报；产出 86 行行情、2 行市值、2 行财务、2 行行业、50 行沪深300和2行分红，三类覆盖率均为 100%。这是 CLI/恢复/发布链路验收，不代表 5,000+ 股票全市场资产已重建。

运行细节和可复现命令见 `docs/running-and-testing.md`。
