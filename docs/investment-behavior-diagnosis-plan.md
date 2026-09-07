# Investment Behavior Diagnosis 升级与接入计划

状态：已完成（Phase 0–5）
日期：2026-08-30
完成日期：2026-08-31
目标 skill：`investment-behavior-diagnosis`
原始基线：`<legacy-skill-source>`
目标工程：`<repositoryRoot>`

## 1. 目标与验收定义

本计划将现有“投资行为诊断”升级为 Finance2DSH 中一个统一、可渐进加载、可选用数据工具、可真实评测的行为金融 skill。升级不是把原内容缩短后搬运，也不是按用户问题穷举多个 skill；它应在保留理论深度的同时，降低误诊、过度断言和数据幻觉，并让数据、理论、诊断与干预之间的责任边界可审计。

完成必须同时满足：

1. 只有一个对外 skill：`investment-behavior-diagnosis`。不按“割肉、追涨、市场泡沫、长期复盘”等 query 类型拆成多个公开 skill。
2. 保留并重组原 skill 的理论主干：偏好与选择、信念与学习、市场聚合机制。长期行为模式作为时间维度和证据要求，而不是第四套理论。
3. skill 可按情境选择“不取数、结构化市场数据、用户交易记录、网页研究”等证据路径；数据是诊断证据，不直接等同于心理偏差。
4. skill 和领域逻辑不依赖 yfinance、CNE6 或某个 web provider。具体 provider 只在组合层实现语义契约。
5. 普通诊断不依赖加载全部理论；需要公式、研究边界或复杂市场机制时才读取对应 reference。
6. 真实 DSH 运行中能够发现并加载 skill、按需加载 reference、调用允许的数据工具、处理缺失和 provider 失败，并完成回答。
7. 与原 skill 的成对评测证明新版更好；不能只以“文件更规范、回答更长、调用工具更多”作为结论。

## 2. 已确认的设计决策

### 2.1 一个公开 skill，内部按职责拆分

用户 query 不可能穷举，而且一个真实请求通常同时包含个人决策、市场判断和长期习惯。因此不采用“一个问题类型一个 skill”的结构。统一入口负责识别任务、选择理论机制、确定证据需求、形成竞争解释并设计干预。

内部结构按知识与执行职责拆分：

```text
skills/investment-behavior-diagnosis/
├── SKILL.md
├── references/
│   ├── preference-and-choice.md
│   ├── belief-and-learning.md
│   ├── market-aggregation.md
│   ├── diagnosis-and-evidence.md
│   └── interventions-and-boundaries.md
└── evals/
    └── evals.json
```

`SKILL.md` 是统一执行内核；references 是理论和方法的渐进加载层；`evals/evals.json` 保存该 skill 的代表性能力测试提示。仓库级评测资产仍放在 `Finance2DSH/evals/`，用于 DSH runner、rubric 和基线对照。

### 2.2 “skill 下的数据工具”是领域所有权，不是 DSH 注册机制

DSH `0.1.1-rc.2` 的 filesystem skill provider 只发现一层 `<root>/<name>/SKILL.md` 或 `<root>/<name>.md`。`skill` 工具会返回正文和 `resourceBase`，但不会注册 skill 目录里的脚本，也不会自动读取 references。模型可调用工具必须由 Cordis/DSH tool plugin 注册。

因此采用以下边界：

- 从使用者视角，行为数据工具属于 `investment-behavior-diagnosis` 的可选能力，由该 skill 决定何时调用。
- 从运行时视角，工具实现位于 Finance2DSH 的 core/provider/DSH adapter 层，由 bundle 注册并加入 preset allowlist。
- `SKILL.md` 只依赖稳定的工具名、输入语义和 canonical output，不 import、不描述 provider 私有字段。
- 行为领域计算写成纯函数；provider 只负责取数和规范化；DSH adapter 只负责 schema、调用和呈现。

这能保留“能力跟随 skill”的产品语义，同时符合 DSH 的真实机制，并允许未来把数据能力整体替换或抽象。

## 3. Skill 内容架构

### 3.1 `SKILL.md` 必须常驻的内容

入口正文目标控制在约 250–400 行、少于 skill-creator 建议的 500 行。即使 reference 暂时不可用，它也必须足以完成安全的普通诊断。常驻内容包括：

1. **触发范围与近邻边界**
   - 触发：用户想理解投资决策中的情绪、参考点、信念更新、追涨杀跌、交易习惯、市场叙事或群体行为。
   - 也触发：用户没有使用“行为金融”一词，但请求本质上是在审视自己的决策过程。
   - 不应触发：纯价格查询、纯财务分析、纯估值、直接要求买卖建议、临床心理诊断。相邻任务由 ticker snapshot、financial analysis 等 skill 负责；混合任务可以协同。

2. **紧凑理论地图**
   - 理性基准：效用、贝叶斯更新、有效市场和套利约束是判断“偏离”的参照，不把所有非理性结果都归因于偏差。
   - 偏好与选择：参考点依赖、损失厌恶、概率加权、心理账户、处置效应、短视损失厌恶和时间不一致。
   - 信念与学习：基率、贝叶斯更新、代表性、保守性、过度自信、确认偏差、有限注意和叙事。
   - 市场聚合：看法差异、卖空约束、有限套利、信息扩散、高阶预期、动量/反转、泡沫和信贷周期。
   - 纵向维度：只有跨时间或多次决策的证据，才足以讨论稳定行为模式。

3. **最少事实与证据分级**
   - 决策对象、时间范围、参考点、可用资金/约束、原始理由、新信息、备选行动、查看/交易频率。
   - 明确区分用户自述、交易记录、市场数据、基本面、外部叙事与模型推断。
   - 信息不足时只追问会改变诊断或干预的少量问题；不为了填模板而盘问。

4. **诊断协议**
   - 每个诊断单元包含：观察证据、候选机制、竞争解释、缺失证据、当前置信度、流程干预、验证指标。
   - 每次只深入最相关的 2–4 个机制；机制数量不构成质量。
   - 将“可能存在的机制”与“已由长期记录支持的模式”分开。
   - 先找合理解释，例如税务、流动性、风险容量、信息变化、投资期限或组合约束，再讨论偏差。

5. **工具选择协议**
   - 不需要外部事实的内省问题，默认不调用数据工具。
   - 涉及实际价格路径、回撤、波动或基准相对表现时，调用结构化市场证据工具。
   - 用户提供多笔交易或决策记录并请求审计时，调用确定性行为审计工具。
   - 涉及当下媒体叙事、关注度、政策或市场事件时，才使用 web search/fetch；搜索结果是发现线索，关键结论尽量读取正文。
   - 基本面、估值和预期变化继续复用已有 `finance_*` 工具，不在行为 skill 内复制。
   - 工具不可用、字段缺失或时间口径不匹配时，降低置信度，不补造。

6. **干预与输出纪律**
   - 干预优先改变决策流程、信息环境、复盘机制和承诺装置，不直接替用户给出买卖指令。
   - 每项干预必须有适用原因和可观测验证指标；避免“删 app、设止损、等 24 小时”等一刀切处方。
   - 默认输出按问题裁剪，不强迫每次都生成完整五段报告。
   - 明确这不是临床诊断，也不是个性化投资建议。

### 3.2 References 的职责

#### `preference-and-choice.md`

承载 CPT 价值函数与权重函数、参考点、四重风险偏好、编辑与框架、心理账户、处置效应、短视损失厌恶、路径依赖、禀赋效应、参考点适应和时间不一致。公式、经典参数和实验结果必须注明适用边界，不能把样本估计当作个人常数。

#### `belief-and-learning.md`

承载贝叶斯基准、基率忽视、代表性、保守性、过度自信、确认偏差、有限注意、叙事、DHS/DSSW 等机制。重点解释相似概念的区别，以及需要什么证据才能区分它们。

#### `market-aggregation.md`

承载有效市场与行为金融的关系、有限套利、卖空约束、看法差异、信息扩散、Grinblatt–Han、价值效应、高阶预期、明斯基周期、泡沫和过度波动。任何“市场处于某阶段”的判断都必须列出可观察信号和替代解释。

#### `diagnosis-and-evidence.md`

承载最少事实、证据层级、竞争假设、置信度语言、长期模式判定、数据工具字段释义、缺失数据处理和若干完整案例。它不重复三份理论 reference。

#### `interventions-and-boundaries.md`

承载按机制组织的流程干预、验证指标、反例、投资建议边界、心理健康边界和易混概念辨析。干预应说明适用条件、潜在副作用与撤销条件。

### 3.3 原内容迁移和质量审计

原内容不丢弃，但要去重和校准：

| 原文件 | 主要去向 | 处理方式 |
|---|---|---|
| `SKILL.md` | 新 `SKILL.md`、诊断协议、干预 reference | 保留核心框架，移除固定 query 路由和过度刚性的统一模板 |
| `cpt-toolkit.md` | `preference-and-choice.md` | 保留公式和机制，补适用边界及参数来源 |
| `belief-toolkit.md` | `belief-and-learning.md` | 合并重复段落，加强竞争机制和可检验证据 |
| `market-toolkit.md` | `market-aggregation.md` | 区分市场事实、模型解释和阶段判断 |
| `knowledge.md` | 五个目标文件 | 作为重组母本，消除与三个 toolkit 的重复，不保留第二套完整知识手册 |

迁移时专项检查以下高风险表述：

- `λ≈2.25` 是经典研究中的代表性估计，不是每个人或每个情境的固定系数。
- “每天看账户约一半时间看到亏损”等表述依赖收益分布和观察窗口，不能作为普遍事实。
- 神经科学、文化差异、冷静期效果等因果表述需要可靠来源；证据不足时降级为建议或删除精确数字。
- 历史市场案例必须带日期和来源，不把单一案例当作一般规律。
- “价格上涨、成交活跃、媒体热度高”不能单独证明泡沫、FOMO、羊群或个人偏差。
- 止损、分批卖出、降低查看频率并非普适最优方案，应改写为条件化的流程选择。

## 4. 可选数据工具设计

### 4.1 选择矩阵

| 证据需求 | 首选能力 | 是否新增 | 说明 |
|---|---|---:|---|
| 用户当下感受、理由、参考点 | 对话追问 | 否 | 不为内省问题强行取数 |
| 价格路径、回撤、波动、基准相对表现 | `finance_behavior_market_evidence` | 是 | 输出行为诊断需要的中性证据包 |
| 多次已完成交易或决策记录 | `finance_behavior_trade_audit` | 是 | 只做描述统计和证据充分性检查 |
| 公司基本面、估值、分析师预期 | 现有 `finance_fundamentals`、`finance_estimates` 等 | 否 | 避免重复建设 |
| 当前叙事、新闻、政策、关注度 | DSH `web_search` / `web_fetch` | 条件启用 | 使用 DSH web seam，不在 skill 内绑定搜索供应商 |
| CNE6 风格、风险和横截面描述量 | 未来 provider 映射 | 暂不新增 | 接口预留，不直接 import CNE6 实现 |
| 理论 reference | `finance_behavior_reference` | 是 | 白名单读取本 skill 的 references，避免开放通用文件读取 |

### 4.2 `finance_behavior_market_evidence`

用途：把市场路径转换为诊断可用、但不带心理标签的证据。

建议输入：

- `ticker`；
- 可选 `benchmark`；
- 一个受限的语义化观察窗口，例如 20/60/120/252 个交易日；
- 可选 `as_of`，provider 不支持历史截面时必须明确拒绝或标记不支持。

建议输出：

- 标的和基准的 observation metadata；
- 起止时间、有效观测数和缺失比例；
- 区间收益、基准超额收益、最大回撤、实现波动率；
- 距离阶段高点/低点、20/60/252 日动量或反转描述量；
- 成交量变化，以及数据充分时的换手代理；
- 每个字段的 status、单位、来源和限制；
- `diagnosticCaveat`：这些统计量不能单独证明损失厌恶、处置效应、代表性、FOMO 或泡沫。

工具不输出 `bias: disposition-effect` 一类结论。模型必须把市场证据和用户自述、交易记录、基本面变化一起解释。

实现边界：

- 计算函数放在 finance-core，使用 canonical bars/reference 输入。
- provider adapter 可先由现有 `FinanceDataProvider` 的 market/reference 能力供数。
- yfinance 字段、Python runner 参数和 CNE6 descriptor 名不得泄漏到 skill 或 core 的公开语义。
- 未来 CNE6 或正式 provider 只需映射同一 evidence contract。

### 4.3 `finance_behavior_trade_audit`

用途：在用户确实提供多笔、可比较的记录时，检验“长期模式”的数据基础。首版接受规范化的 completed trade/decision records，不负责猜测券商导出文件的税务 lot 规则。

建议输入：

- 记录 ID、标的、进入/退出时间、进入/退出价格、方向和可选费用；
- 可选的事前理由、计划期限、置信度、规则是否被遵守；
- 明确的 lot matching 假设；缺少该信息时不计算依赖 lot 的指标。

建议输出：

- 样本量、覆盖时间、字段完整度和可分析范围；
- 盈利/亏损交易的持有期分布、交易频率、重复进出间隔、费用拖累；
- 数据充分时的参考点相关描述统计和置信区间；
- 哪些结论无法由当前样本支持；
- 不输出心理诊断和交易建议。

PGR/PLR 只有在能够重建每次卖出时的已实现与账面机会集时才计算；仅有平仓记录时不得伪装成 Odean 定义的处置效应指标。

该工具是纯函数，不访问账户、不保存用户数据、不依赖 provider。未来若支持 CSV，应由独立导入/规范化层生成上述 records。

### 4.4 `finance_behavior_reference`

DSH 当前 `skill` 工具只提示 `resourceBase`，不会自动读取 references；finance preset 又没有开放通用 `read`。为实现真实渐进加载，新增一个最小权限资源工具：

- 参数只接受五个固定 topic；
- 路径固定解析到 `FINANCE2DSH_SKILLS_DIR/investment-behavior-diagnosis/references/`；
- 拒绝任意路径、`..`、绝对路径和符号链接逃逸；
- 返回 reference 正文与 topic，不枚举或读取其他项目文件；
- 单元测试覆盖白名单、路径边界和缺失文件。

若未来 DSH 提供原生、skill-scoped 的资源读取能力，应删除此适配器并保持 skill 中的逻辑引用不变。

### 4.5 Web 与 CNE6 的解耦策略

Web：优先使用 DSH 原生 `web_search` / `web_fetch` 和 `ctx.web` provider seam，不包装成 `finance_behavior_web_search`。实施时先验证 Finance2DSH 当前 profile 是否有可用 provider 和凭证；只有真实搜索、正文读取、URL 引用均通过，才加入 preset allowlist。否则保留为可选能力并让 skill 明确报告缺失，不把“包已安装”当作“能力已可用”。

CNE6：当前只作为证据能力参考。新 contract 为 beta、波动、换手、动量、反转、行业和风险暴露等可选字段预留 status/provenance，不直接依赖 `packages/combinatorial-optimization` 的模块、数据目录或 provider。等数据能力抽象完成后再实现 adapter。

## 5. 代码边界与拟议落点

计划落点如下，实施时可按现有包结构做小幅调整，但依赖方向不变：

```text
Finance2DSH/
├── skills/investment-behavior-diagnosis/
│   ├── SKILL.md
│   ├── references/*.md
│   └── evals/evals.json
├── packages/finance-core/src/
│   ├── behavior-contracts.ts
│   ├── behavior-market-evidence.ts
│   └── behavior-trade-audit.ts
├── packages/dsh-finance-tools/src/
│   ├── behavior-tools.ts
│   ├── behavior-reference.ts
│   └── index.ts
├── packages/dsh-finance-bundle/src/policy.ts
├── generated/agent-presets/finance-analyst/
├── evals/cases/investment-behavior-diagnosis.json
├── evals/rubric/investment-behavior-diagnosis.yml
└── tests/
    ├── behavior-core.test.ts
    ├── behavior-tools.test.ts
    ├── behavior-skill.test.ts
    └── behavior-evals.test.ts
```

依赖方向：

```text
SKILL.md -> 稳定工具语义
DSH adapter -> finance-core 纯函数 + provider interface
provider adapter -> yfinance / future CNE6 / future licensed data
finance-core -X-> DSH、yfinance、CNE6、web provider
```

如果实现新行为工具暴露出当前 `dsh-finance-tools.apply()` 直接实例化 yfinance 难以测试，应只做最小组合根重构：保留 `createFinanceTools(provider)` 的 provider 注入形式，由 `apply()` 决定默认 provider。不得让 skill 或纯函数创建 yfinance provider。

## 6. 输出模型

新版不强制所有 query 套用同一份长报告。默认输出根据问题深度裁剪，但内部必须完成相同的诊断单元。建议外显结构：

```text
1. 当前判断：最值得关注的 1–3 个机制及置信度
2. 证据与竞争解释：什么支持、什么也可能解释、还缺什么
3. 理论解释：专业机制 + 一句通俗解释
4. 流程干预：具体动作、适用条件、验证指标
5. 若涉及市场：事实、市场机制解释和不确定性分开
```

若信息不足，先给“暂定假设 + 最少追问”，而不是输出空泛模板。若用户只问概念，则直接解释理论，不强行诊断用户。

## 7. 评测与“优于原版”的证明

### 7.1 基线与实验控制

这是对既有 skill 的升级，基线必须是原版，而不是无 skill。实施前将 `<legacy-skill-source>` 快照到评测 workspace。由于原 frontmatter 的中文 `name` 不符合 DSH kebab-case 规则，基线副本只做可加载兼容处理：目录和 `name` 改为 `investment-behavior-diagnosis`，正文、description 和 references 不做实质修改；该差异写入元数据。

每个案例的新版和基线必须：

- 使用相同 DSH 版本、模型、reasoning effort、persona 和工具集合；
- 数据型案例尽量在相邻时间运行并记录 observed/retrieved time；
- 同批启动成对运行，避免先跑完一版再跑另一版造成系统性时点偏差；
- 保存最终回答、tool calls、完成原因、总耗时和可取得的 token usage；
- 不把工具调用次数或回答长度当作质量指标。

skill-creator 要求的测试 workspace 按 iteration 组织，运行产物不混入 skill 正文。仓库提交可保留 prompts、rubric、grader 和汇总结果；包含大量模型输出的临时 workspace 默认忽略，最终报告记录复现命令和版本。

### 7.2 案例覆盖

首轮不少于 12 个真实风格案例，覆盖：

1. 盈利后想卖、害怕卖飞；
2. 亏损后等待回本；
3. 大涨后追入与近期趋势外推；
4. 高频查看账户导致焦虑；
5. 连续盈利后扩大风险；
6. 连续亏损后翻本冲动；
7. 市场是否处于泡沫/狂热阶段；
8. 新信息出现后仍坚持原观点；
9. 有多笔交易记录的长期审计；
10. 信息不足且存在合理非偏差解释；
11. 只问理论概念，不应把用户当诊断对象；
12. 纯价格/基本面近邻请求，不应误触发或过度行为化。

数据案例至少覆盖：真实 yfinance 成功、字段缺失、provider 失败、benchmark 缺失和 web 不可用。涉及未来事实的案例不得使用静态期望答案验证价格数值，而应检查时间戳、来源、字段状态和推断边界。

### 7.3 行为诊断专属 rubric

建议 100 分维度：

| 维度 | 权重 | 核心问题 |
|---|---:|---|
| 理论准确性与保留度 | 20 | 理论是否正确、边界是否清楚、是否保留必要深度 |
| 证据锚定 | 20 | 诊断是否逐项落在用户事实或可靠数据上 |
| 竞争解释与置信度 | 15 | 是否考虑合理替代解释并校准断言 |
| 数据与工具纪律 | 15 | 是否按需选工具、处理时间/来源/缺失且不以数据证明心理 |
| 干预质量 | 15 | 是否具体、条件化、可执行、可验证且不越界为买卖建议 |
| 沟通与任务适配 | 10 | 是否回答用户真正的问题，不过度套模板 |
| 安全与边界 | 5 | 是否避免临床标签、保证收益和个性化指令 |

硬失败包括：

- 根据一次交易或一段价格走势断言用户“患有”某偏差；
- 编造持仓、成本、价格、新闻、来源或理论研究结果；
- 将市场统计特征直接当成泡沫、羊群、FOMO 或处置效应的证明；
- 把相关性写成因果，或把经典样本参数写成个人固定参数；
- 在缺乏长期记录时确认稳定行为模式；
- 以行为诊断名义给出无条件买卖、仓位或止损指令；
- 忽略明显的流动性、税务、期限、风险承受能力或基本面变化等竞争解释；
- provider 失败后补造数据或隐瞒限制；
- reference 无法读取时声称已依据其中内容；
- 对纯理论问题强行分析用户心理。

### 7.4 客观断言与人工比较

客观断言检查：

- skill 被 DSH 发现并通过 `skill` 工具加载；
- 需要理论细节时调用白名单 reference 工具，普通简单案例不过度加载全部 reference；
- 数据型案例调用正确工具，非数据型案例不强制取数；
- 工具输出包含 observation metadata、status 和 caveat；
- 回答包含至少一个竞争解释和一个验证指标；
- 不出现未由输入或工具支持的精确数字；
- 长期模式结论与样本量相匹配；
- 纯近邻任务不会错误使用行为诊断。

主观质量通过 skill-creator 的 review viewer 和盲评比较完成。盲评隐藏版本身份，比较理论深度、诊断有效性、证据纪律、干预可用性和表达质量。

### 7.5 升级通过门槛

新版只有同时满足以下条件，才能声明优于原版：

1. 新版和基线在全部测试中均完成可解析运行，或把 provider/模型故障单独标记而不计入质量比较。
2. 新版无硬失败；数据成功路径和失败路径均通过。
3. 新版客观断言通过率至少 90%，且不低于原版。
4. 新版行为 rubric 加权均分比原版提高至少 8 分，或盲评中至少三分之二的可比较案例胜出；无论采用哪条，理论准确性和安全边界都不得回退。
5. 至少一次真实 DSH headless 运行证明模型加载 skill、按需加载 reference，并在数据型案例调用 `finance_behavior_market_evidence`。
6. 至少一次真实 yfinance 数据测试通过；web 只有在 provider 可用并实测成功后才能声明已启用。
7. 用户可通过生成的 review viewer 检查新版、原版、断言评分、耗时和 token。

若首轮未达标，按 skill-creator 流程分析失败模式、修改 skill/工具并运行下一 iteration，直到达标或明确记录无法改进的原因。

## 8. 测试层次

### 8.1 静态与结构验证

- `quick_validate.py` 验证名称、description 和 frontmatter；实施时使用 Finance2DSH 可用的 Python 环境补齐 PyYAML，不修改系统 Python。
- 验证目录名与 `name` 完全一致，符合 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。
- 验证 `SKILL.md` 行数、reference 链接、topic 白名单和无死链。
- description 做 should-trigger / should-not-trigger 边界集，重点测试纯行情、纯估值和临床心理近邻。

### 8.2 单元与 contract 测试

- 市场证据指标的 golden tests、边界、空数据、非有限值和基准错位。
- 交易审计的样本量、lot 假设、费用、持有期及“不足以计算 PGR/PLR”路径。
- reference 工具的路径约束和只读白名单。
- DSH tool schema 到 finance-core contract 的映射。
- provider error、abort、timeout、stale 和 missing 不变成正常值。

### 8.3 Composition 测试

- finance preset 能发现新 skill。
- allowlist 包含三个行为工具及仍被允许的现有金融工具。
- 未验证 web provider 时不宣称 web 可用；验证后检查 `web_search` / `web_fetch` 同时注册、可见且实际可执行。
- 不修改 DSH core、用户 `~/.dsh` 或全局 skills。

### 8.4 真实模型与数据测试

- 使用隔离的 `Finance2DSH/.runtime` 和真实 `trae-official / GPT-5.6-Sol / xhigh`。
- headless runner 扩展为输出 tool calls、usage 和 duration，便于 skill-creator benchmark。
- live 数据测试与稳定单元测试分开，记录 provider、时间和网络错误。
- 运行成对 baseline/new-skill 案例，生成 `benchmark.json`、`benchmark.md` 和静态 review HTML。
- 完成至少一轮人工 review 后再决定是否继续修改；不可只由编写 skill 的同一上下文自评。

## 9. 分阶段实施顺序

### Phase 0：冻结基线与测试骨架

1. 快照原 skill，记录只为 DSH 加载所做的名称兼容变更。
2. 建立行为 rubric、首轮 eval prompts、断言 schema 和运行目录约定。
3. 先跑少量原版基线，确认 runner 能记录回答、工具、usage 和时延。

验收：原版可在隔离 DSH 中运行，评测不是纸面设计。

### Phase 1：重构 skill 与理论 references

1. 创建统一 `investment-behavior-diagnosis`。
2. 从原四个文件迁移、去重并校准理论。
3. 写入诊断协议、竞争解释、置信度、工具选择和干预边界。
4. 实现受限 reference loader，使渐进加载在当前 DSH 中真实可用。

验收：静态校验、reference 读取测试和无数据模型 smoke 通过。

### Phase 2：行为数据工具

1. 定义 provider-neutral behavior contracts。
2. 实现市场证据纯函数及 `finance_behavior_market_evidence`。
3. 实现交易记录纯函数及 `finance_behavior_trade_audit`。
4. 接入 tool registry 和 preset allowlist，更新 persona 的证据纪律。
5. 验证现有 yfinance adapter；只预留 CNE6 映射。

验收：单元、contract、provider 失败路径和 live yfinance 通过。

### Phase 3：Web 能力核验

1. 检查 DSH web seam、tool plugin、provider 和凭证是否在 Finance2DSH profile 中形成完整链路。
2. 真实执行 search 和 fetch，验证来源 URL、正文和错误行为。
3. 通过后才加入 allowlist 和 skill 工具矩阵；否则保留明确的 optional/unavailable 状态。

验收：不能以安装包存在或配置 dump 出现代替真实调用。

### Phase 4：成对评测与迭代

1. 同批运行新版和原版基线。
2. 在运行期间补全客观断言。
3. 对每个输出评分，聚合 benchmark 并做失败模式分析。
4. 生成 skill-creator review viewer，进行人工检查和盲评。
5. 根据结果修改并进入下一 iteration，直到满足升级门槛。

### Phase 5：全量回归与文档收口

1. 运行 build、typecheck、稳定测试、CNE6 稳定测试、runtime prepare 和 profile dump。
2. 单独运行 live yfinance、真实 DSH E2E，以及可用时的 web live test。
3. 更新 `running-and-testing.md`、主计划状态、工具清单和复现命令。
4. 报告已验证能力、未启用能力、已知限制和新版相对原版的证据。

## 10. 实施约束

- 不修改 `<legacy-skill-source>` 原目录；它是只读基线。
- 不修改 DSH 安装包或 DSH core。
- 不写入 `~/.dsh`、`~/.agents/skills` 或其他用户全局 skill 目录。
- 不把 yfinance、CNE6 或 web provider 名称写进 skill 的诊断逻辑。
- 不为展示完整性而强制每次调用所有工具或加载所有 references。
- 不在没有数据的情况下模拟 live 测试结果。
- 测试产生的凭证、用户交易记录和未脱敏原始数据不得进入仓库。
- 保留当前工作树中与本任务无关的改动。

## 11. 预期最终交付物

1. 一个通过 DSH 和 skill-creator 规范校验的 `investment-behavior-diagnosis` skill。
2. 五份去重、可按需读取且理论内容不降级的 references。
3. 三个 skill 专属可选工具：市场证据、交易审计、reference 读取。
4. provider-neutral contracts、纯函数测试和 DSH adapter 测试。
5. 行为诊断专属 eval cases、rubric、基线快照说明和真实成对 benchmark。
6. 可供用户审阅的 skill-creator review HTML。
7. 更新后的运行文档和明确的已验证/未验证能力清单。

任何后续迭代如果发现 DSH 实际机制与本文假设不符，应先用最小可复现实验确认，再更新计划和实现；不能为了保持文档表面一致而绕过框架边界。

## 12. 实施结果与验收证据

### 12.1 最终结构

实施保持了一个公开入口 `skills/investment-behavior-diagnosis/`。入口 `SKILL.md` 为 135 行，负责触发边界、诊断协议、工具选择、置信度和输出纪律；五份 references 共 699 行，分别承载偏好与选择、信念与学习、市场聚合、证据诊断、干预与边界。理论没有被压缩成 query 路由，也没有拆成多个公开 skill。

当前 DSH 不会自动注册 skill 子目录中的脚本或自动展开 references，因此渐进加载通过白名单工具 `finance_behavior_reference` 实现。其路径固定在 `FINANCE2DSH_SKILLS_DIR/investment-behavior-diagnosis/references/`，拒绝未知 topic、符号链接、越界路径、非普通文件和超限文件。

行为数据能力落实为三个 preset-scoped 工具：

- `finance_behavior_reference`：按需读取五个理论/方法 reference；
- `finance_behavior_market_evidence`：输出 20、60、120 或 252 个有效交易日的中性价格路径证据，可选 benchmark；
- `finance_behavior_trade_audit`：对用户显式提供的规范化交易记录做无 I/O 描述审计，仅在完整卖出日机会集与 lot-matching 假设存在时计算 PGR/PLR。

领域契约和计算位于 `finance-core` 纯函数层；具体 yfinance 获取只存在于 provider/adapter 组合层。skill 和 core 均不 import 或依赖 yfinance、CNE6、web provider 的实现。CNE6 本轮没有注册为行为工具，只验证了新增能力没有破坏其独立工程。

### 12.2 真实框架与数据验证

2026-08-31 在项目隔离 runtime、DSH `0.1.1-rc.2`、`trae-official / GPT-5.6-Sol / xhigh` 下完成：

- `pnpm check` 通过：4 个 TypeScript package 构建和 typecheck 成功；11 个 Vitest 文件、50 个测试通过；CNE6 129 passed、2 skipped；runtime prepare 与 headless/Web profile dump 均成功。CNE6 的 14 条 warning 是现有 synthetic 数值路径中的 empty-slice/协方差告警，没有测试失败。
- `pnpm test:live:yfinance` 通过 4/4：真实 AAPL reference/market、fundamentals、estimates，以及新增 behavior market evidence adapter。
- `pnpm test:e2e` 通过：真实模型加载 `ticker-snapshot`，调用 `finance_security_reference` 与 `finance_market_data`；Web profile 在动态 loopback 端口返回 HTTP 200。
- 独立行为 smoke 以 JSON trace 完成，工具顺序包含 `skill`、`finance_behavior_reference(topic=market-aggregation)`、`finance_behavior_market_evidence(ticker=AAPL, benchmark=SPY, window=60)`，随后补充证券识别；所有工具无 error，turn reason 为 `completed`。回答明确分开市场事实、FOMO 候选机制、竞争解释、缺失证据和验证指标，没有给买卖指令。
- `quick_validate.py` 返回 `Skill is valid!`。

原目录 `<legacy-skill-source>` 未被修改。基线清单记录其五个正文文件的 SHA-256；评测快照仅把目录名和 `SKILL.md` frontmatter name 改成 DSH 可发现的英文名，正文内容没有变化。

### 12.3 新版与原版成对结果

第二轮使用 12 个固定案例；每个案例对新版和原版各进行 1 次真实 DSH 运行，共 24 个 executor 输出。A/B 身份按案例奇偶交错，judge 只看到用户 prompt、匿名回答和工具轨迹；工具必选/禁用断言由程序确定性判定，其余断言及七维 rubric 由同一真实模型在禁用 skills 和工具的 grader profile 中评定。

| 指标 | 新版 | 原版 | 差异 |
|---|---:|---:|---:|
| 合并客观断言 | 53/55（96.36%） | 47/55（85.45%） | +10.91 pp |
| 七维 rubric 均分 | 96.88 | 89.48 | +7.40 |
| rubric 通过案例 | 12/12 | 8/12 | +4 |
| hard failures | 0 | 4 | -4 |
| 非平局盲评胜率 | 8/11（72.73%） | 3/11（27.27%） | +45.46 pp |
| 平均真实 model tokens | 12,411.83 | 22,228.58 | -9,816.75 |
| 平均耗时 | 43.01 秒 | 52.71 秒 | -9.70 秒 |

新版 rubric 差值没有达到单独的 `+8` 路径，但盲评在 11 个非平局案例中赢 8 个，超过三分之二替代门槛；同时新版客观断言超过 90%、不低于原版、0 hard failure，理论准确性和安全边界的逐案例最低分均为 3/4。因此满足第 7.5 节定义的升级门槛。

结果保存在被 Git 忽略的本地评测 workspace：

- `skills/investment-behavior-diagnosis-workspace/iteration-2/benchmark.json`：机器可读聚合；
- `skills/investment-behavior-diagnosis-workspace/iteration-2/benchmark.md`：摘要；
- `skills/investment-behavior-diagnosis-workspace/iteration-2/review.html`：由 skill-creator 官方 `generate_review.py` 生成的 4.5 MiB 静态 viewer，包含当前/上一轮输出、formal grades 和 benchmark；
- 每个 run 的 `outputs/result.json`、`outputs/tool-trace.json`、`grading.json` 与 `timing.json`：回答、调用轨迹、评分证据和真实 usage。

skill-creator 原聚合器在当前产物结构下会把 output characters 回退成 token。项目没有修改已安装的 skill-creator，而是在官方聚合后运行 `scripts/normalize_behavior_benchmark.py`，以每个真实 DSH result 的 `usage.totalTokens` 修正 token，并补充行为 rubric、hard failure 和盲评摘要。

### 12.4 已知限制与后续观察项

- 每个版本每个案例目前只有一次 executor 运行，judge 也只有一次。结果能证明本轮固定条件下达到升级门槛，但不能估计模型采样方差，也不能外推到其他模型/provider。
- 新版剩余两条客观断言缺口：case 5 没有充分展开技能提升的事前/样本外验证；case 12 没有完整披露 missing/status/source limitations。两例仍通过 rubric，且没有 hard failure。后续若继续迭代，应优先围绕这两类一般化问题扩充样本，而不是针对原 prompt 堆固定措辞。
- 静态 review viewer 已生成并可人工审阅；当前没有提交 `feedback.json`，因此 benchmark 不应描述为已完成人类反馈闭环。
- Web 能力保持未启用。真实探测发现 finance agent 不暴露 `web_search`，DeepSeek search provider 尚缺 `DEEPSEEK_API_KEY`，`web_fetch` 也没有启用或配置 provider；详情见 `evals/runtime/web-capability-status.json`。不能声称已具备新闻、叙事或网页正文核验。
- yfinance 是无 SLA 的 best-effort 数据源。任何 provider error、缺失字段或时间口径不足都必须原样降级，不能补造或把缺失当零。
- profile materialization 会重建共享 `.runtime/.agent-presets`；正式命令应像 `pnpm check` 一样串行运行，不要并行执行两个 `dump:*` 命令。
