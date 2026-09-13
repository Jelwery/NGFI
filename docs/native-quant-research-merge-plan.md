# Native Quant Research 合并计划

- 日期：2026-09-12
- 状态：M0–M6 已完成；M7 离线工程、CLI、联网审计、Web 启动及在线模型（Model Hub headless）验收通过，仅浏览器交互 UI E2E 仍 blocked（无可控浏览器连接），因此不宣布 M7 全部完成。逐包证据见文末执行记录。
- 决策：完整吸收 `feat/native-quant-research` 的研究能力，统一计算、成交与持久化边界，保留 A3 默认行为。
- 本次交付：用户已授权从 M0 开始完整实施，并逐项更新本文件；工作在 `integrate/native-quant-research`，不自动提交、推送或合入 main，不修改 A2/A4 真实验收结论。
- 主线规划：[权益研究驱动的 Smart Beta 计划](equity-research-smart-beta-plan.md)
- 来源依据：[NGFI 本轮工作区交付报告（完整版）](https://my.feishu.cn/wiki/HqEswCrV6i1m8fkb9ZCcAWaqnIf?from=from_copylink)，document ID `DM4sdlvkHoGquoxG2Oyc02X5nye`，读取版本 revision 6。

## Context

当前 NGFI 正在完成权益研究 Smart Beta 计划中的 A3。制定本计划期间，主线已合入 A3 工程升级的最后一个工作包，但全市场性能与真实数据门禁尚未通过。与此同时，`feat/native-quant-research` 在较早基线上完成了因子图、滚动模型、组合优化、逐日回测和实验追溯，能够补充后续 A4 所需的研究链路。

两条分支不是简单的新增文件关系：主线已收拢 package 并升级优化器、账户和执行契约，来源分支仍使用旧目录且新增了独立优化、回测与存储。因此，合并不能恢复旧架构，也不能只解决文本冲突而忽略经济语义。

采用已确认的“**完整吸收、统一内核**”：保留因子图、Ridge/HGB、mean-variance/top-k、CLI/Agent 和实验追溯能力；将其接入现有 package、成交账本和 ResearchWorkspace。完整吸收指能力保留，不指旧实现逐行照搬，不意味着 A2、A3 全市场验证或 A4 自动完成。

## 1. 已核实的仓库与阶段基线

### 1.1 Git 关系

| 项目 | 核实结果 |
|---|---|
| 目标工作区 | 当前 `NGFI` 仓库根目录（不在文档中保存本机绝对路径） |
| 共同 remote | `https://github.com/Jelwery/NGFI.git` |
| 目标提交 | `main` / `origin/main`：`3ebc44daed18cc3d39edb5a5401023536175c9a7` |
| 来源提交 | `feat/native-quant-research`：`0676dcadb4cc9e3a64f8548daa34f929ef45deaf` |
| 共同祖先 | `a17b499897ef27e9ee3478b9843f2da99b674e53` |
| 分叉情况 | 目标独有 18 个提交，来源独有 2 个提交 |
| 来源提交 1 | `6e314a0e7711d9c71b1ad22dae6f5886247198b2`：原生量化研究流水线与工程治理 |
| 来源提交 2 | `0676dcadb4cc9e3a64f8548daa34f929ef45deaf`：README 调整 |
| 来源相对共同祖先的增量 | 46 个文件：新增 23、修改 23；增加 4,011 行、删除 49 行 |
| 写计划前的目标工作区 | 干净；本计划将成为新增未跟踪文档 |

这是**同一仓库在共同祖先之后的两条开发线整合**，不是无共同历史的仓库拼接。46 个文件和行数是来源增量，不是两个分支 tip 之间全部差异，也不是实际 Git 冲突数量。

飞书报告中的来源工作区位于作者主目录下的 `Documents/fragments/NGFI`，当前机器不存在该目录。报告描述了当时尚未提交的工作区；远程来源分支现已包含上述两个提交，文件数和增删行数与报告一致。本计划以远程固定提交的代码为准，报告用于解释能力、边界与历史证据，不推断来源机器还有哪些未发布改动。

计划阶段探查开始时目标曾为 `17effcb`，随后其他工作合入 A3 第 6 包。只读探查阶段没有执行 checkout、fetch、merge 或 cherry-pick，来源代码通过 GitHub API 读取；后续实施阶段已在 M0 获取固定来源、创建集成分支并完成三方预演，详见执行记录。

### 1.2 当前阶段状态

| 领域 | 当前结论 | 合并不得改变的边界 |
|---|---|---|
| A0/A1 | 已有工程与数据契约验收记录 | 不覆盖已冻结来源、用途和时间契约 |
| A2 | 整体 blocked；样本风险可行性、交易状态冲突、来源时点、全市场覆盖等仍有缺口 | 来源密集面板校验、Ledoit–Wolf 或 Demo 不能替代真实数据验收 |
| A3 工程工作包 1–6 | 已合入 main，PR #6–#11 | 六项行为均作为合并回归基线 |
| A3 全市场规模验证 | 尚未通过，依赖 A2 真实全市场数据 | 500 证券契约上限不是全市场性能证明 |
| A4 | 优化—账户回放—可信实验登记尚未整体验收 | 原生研究链路是实施素材，不是 A4 已完成的证据 |
| B 阶段 | 仍受主计划的数据、实验与人工准入闸门约束 | 不借合并启动大规模搜索、策略记忆进化或自动晋级 |

A3 六项回归基线：

1. 分域 freshness，不把财务研究与日行情套入同一窗口。
2. 有分资产、无分持仓和基准分离；无分资产不污染评分池 rank。
3. 连续目标中的成交成本代理，以及整手成交后的精算差异。
4. 现金、可卖量与持仓数量纳入一体确认的账户快照。
5. 逐资产 lot、零股保持、整数 oracle 与搜索失败分类。
6. 有界、分块、按实际字节验证 hash 的内容寻址 artifact 读取。

真实数据的精确阻断原因以 [A2 样本验收记录](equity-data-a2-sample-acceptance.md) 为准。历史指数成分/权重覆盖通过，不等于原始发布时间、逐日调样血缘或全市场风险验收通过。

### 1.3 证据有效期

飞书 revision 6 记录了来源分支的 71 项量化测试、22 项 TS 定向测试、12 项 CNE6 定向测试及合成 Demo；同时明确没有在该次报告中重跑完整 `pnpm check`、完整 Vitest、联网漏洞审计或 Web E2E。这些是**历史来源证据**，不是本次合并验证结果。

实际实施前再次核对双方 SHA、dirty-tree 指纹、锁文件和工具链。若任一分支继续推进，先增补差异和影响，再实施；不能用本计划中的固定行号或历史通过数量冒充新版本证据。

## 2. 目标架构与能力迁移

```text
可信操作员 CLI / strategy-research DSH 工具
  → 共用研究应用层：导入、登记、执行、查询
  → ResearchWorkspace：case / Evidence / ModelRun / artifact / run manifest
  → 固定 Python 计算入口
      PIT 数据与版本化因子图
        → Ridge / HGB 滚动模型及诊断
        → 明确的优化目标与风险策略
        → 现有 portfolio 逐日决策与账户回放
        → 现有 execution 成交与费用内核
  → 同一 workspace 登记结果、失败和复算证据
```

DSH 保持唯一 Agent loop。网络留在数据层，计算留在领域模块，持久状态只由研究 workspace 管理；不新建量化前端、任务平台或通用模型插件系统。

### 2.1 来源能力的落点

下表的来源 Python 文件均位于来源提交的 `packages/quant-research/ngfi_quant/`，不是目标工作区现存路径。

| 来源能力 | 目标落点与处理 |
|---|---|
| `research_contracts.py` | 迁入 `packages/combinatorial-optimization/ngfi_quant/`；复用证券、时间和 hash 契约，显式登记用途、优化目标、风险来源、账户及规则引用 |
| `research_factors.py` | 因子图、12 个模板、17 个固定算子整合到现有 `ngfi_quant/factors/`；复用语义等价的预处理和诊断 |
| `research_models.py` | 迁入现有量化包；保留 Ridge/HGB、训练集预处理、标签成熟、交易日 embargo 和模型复算 |
| `research_optimizer.py` | 整合到现有优化模块；共享校验、风险和约束组件，显式保留不同目标，不覆盖 A3 |
| `target_backtest.py` | 将逐日 policy、固定委托量、实际持仓反馈接入 `portfolio.py`；不保留第二套独立账户循环 |
| `experiment.py` | 保留纯计算编排和诊断；登记、持久化和恢复交给现有研究应用层 |
| `experiment_store.py` | 不迁入独立 Python 台账；import/run/get/list、不可变性、分页、隔离与完整性能力由 ResearchWorkspace 承接 |
| `research_cli.py` 与 CLI scripts | 保留 `pnpm quant:research`、`pnpm quant:demo` 的能力；CLI 与 DSH 共用应用层，Python 仅保留固定计算职责 |
| Python tests | 迁入 `packages/combinatorial-optimization/quant_tests/`；按新契约改写预期，保留来源用例的验证意图 |
| TS 工具与测试 | 增量整合到 `strategy-tools.ts`、`index.ts` 和现有 `tests/`，保留主线 portfolio、walk-forward 与注册行为 |
| preset 与能力清单 | 修改 canonical preset 后重新生成，按当前注册表校验；不采用来源历史工具数量 |
| 依赖与审计 | 在现有 Python 项目整合依赖、重解锁文件、更新实际许可证清单及审计路径 |

**不恢复** `packages/quant-research` 或已删除的 provider package。保持当前 14 个 workspace package 的组织边界；新增领域模块不是新增顶层 package。

### 2.2 已存在且应复用的实现

以下行号以目标基线 `3ebc44d` 为准。

| 职责 | 现有实现 | 复用注意事项 |
|---|---|---|
| A3 优化 | `packages/combinatorial-optimization/ngfi_quant/optimizer.py:579`，`optimize_portfolio` | 保留原默认输入、目标、拒绝语义及 dry-run 输出 |
| 纯计算调仓入口 | `packages/combinatorial-optimization/ngfi_quant/optimizer.py:709`，`rebalance_plan` | 与 DSH 从已保存 run 提取计划的行为区分，不重复求解已登记结果 |
| 成交与现金 | `packages/combinatorial-optimization/ngfi_quant/execution.py:14`、`:88`、`:129`，`money`、`fee_ledger`、`fill_order` | 费用、现金分精度及价格越界策略只能有一套 |
| 账户回放 | `packages/combinatorial-optimization/ngfi_quant/portfolio.py:209`，`run_research_backtest` | 需扩展逐日决策和冻结数量，不能只接权重表 |
| CNE6 快照 | `packages/combinatorial-optimization/cne6_engine/interfaces/portfolio_risk.py:145`，`build_portfolio_risk_snapshot` | 保留主线来源、descriptor、覆盖与发布时间约束 |
| 跨语言固定桥 | `packages/dsh-finance-tools/src/strategy-tools.ts:52`，`quantBridge` | 不丢失主线操作枚举、离线与环境隔离参数 |
| 账户确认与输入治理 | `packages/dsh-finance-tools/src/portfolio-tools.ts:87`、`:151`、`:190` | confirmed account、注册 artifact、评分 evidence 校验不得被原生入口绕过 |
| 代码身份与安全读取 | `packages/dsh-finance-tools/src/runtime-store.ts:9`、`:80`，`quantCodeIdentity`、`readContentAddressedJson` | 使用完整代码内容及锁文件身份，分清语义 hash 与文件字节 hash |
| 持久化 | `packages/research-workspace/src/workspace.ts:534`、`:565`、`:589`，`saveModelRun`、`writeArtifact`、`saveRunManifest` | 单一 revision、不可变 artifact 和运行状态来源 |
| Python 内容身份 | `packages/combinatorial-optimization/ngfi_quant/hashing.py:32`、`:54`，`canonical_json`、`stable_hash` | 保留主线规范化，不以来源旧序列化方式覆盖 |

### 2.3 因子处理不按名称盲目合并

现有 `factors/preprocessing.py` 和 `factors/analytics.py` 已覆盖标准化、去极值、中性化、IC、分组、换手和相关性，但不能全部作为来源实现的无损替代：

- 主线 `winsorize` 是分位数截断，来源是 MAD；保留显式方法和版本。
- 主线中性化可含行业与市值，来源为行业去均值并处理单样本行业；校验样本不足与缺失语义后再复用。
- 主线 `compute_forward_returns` 基于逐证券行情行和 close-to-close；来源标签是交易日历上的 `open(t+1+h)/open(t+1)-1`，不可改名互换。
- 来源相关性按日期计算后汇总，主线 `correlation_matrix` 的现有口径会汇集多日期样本；研究诊断保留逐日截面定义。
- 通过共同 fixture 验证数值、并列 rank、缺失、常数截面和样本边界后，再合并可等价的代码；不维护隐式双算法。

## 3. 必须冻结的语义与治理边界

### 3.1 优化目标明确分派

| 模式 | 信号与风险 | 保留行为 |
|---|---|---|
| A3 rank-active | 平均并列 rank 偏好 `[-1,1]`，相对 CSI 基准的主动风险 | OSQP、L1/2 换手、行业/风格主动暴露、成本代理、硬约束和现有拒绝语义不变 |
| forecast mean-variance | 带 horizon 和单位的预测收益，绝对组合风险 | 保留原生均值—方差目标及明确选择的 CLARABEL |
| constrained top-k | 先确定性选候选，再拟合受约束目标组合 | 保留原生 top-k 能力，不声称求得全局最优基数约束组合 |

只抽取当前消费者确实共用的证券对齐、风险矩阵、持仓、交易约束、费用和整手诊断。保留各模式独立的输入与风险策略，不把新模式强塞进 A3 `_prepare`，不通过 arbitrary callback 或用户源码选择目标。

必须同批更新 schema、生产者、消费者和测试：

1. 预测收益不能直接当 A3 rank alpha；若需跨模式转换，登记转换规则与版本，不能保留收益单位却实际只用排序。
2. 原生 full-L1 与主线 L1/2 不可混用。若公共内部量为 `T_half = 0.5 * sum(abs(delta))`，来源上限为 `L_full`、惩罚为 `lambda_full * sum(abs(delta))`，对应内部上限为 `L_full / 2`、惩罚系数为 `2 * lambda_full`。输入、输出和报告均回显定义。
3. 预测模式的 CNE6 日频协方差按交易日 horizon 缩放时，注明线性聚合及跨期相关近似；线性缩放的是特异方差，而非特异标准差。A3 日频主动风险保持原义。
4. top-k 的 `k` 是候选选择数量，不是强制总持仓数。冻结或必须保留的持仓不能被候选排序删除；被选候选集不可行，不等于所有 top-k 组合都不可行。
5. 不静默切换求解器、风险来源、目标模式或放松硬约束。
6. 主线约束精算、逐资产 lot 和搜索诊断被新模式复用时，分别验证目标函数、约束及 oracle 口径；不要求原生旧浮点结果或 CLARABEL 与 OSQP 字节相同。

**结果权限边界**：原生模式产出“研究目标及其时点内可行性”，含明确的数据用途、假设账户、决策时间、风险源与规则版本；不保证未来成交或跳空后的约束仍满足。只有经过现有 A3 确认账户、mandate、证据和质量校验路径的结果，才能成为已有 A3 `OptimizationRun`，供 `finance_rebalance_plan` 提取 dry-run 计划。原生结果即便使用 CNE6，也不能改名后直接进入该路径。

### 3.2 风险、时间与数据用途

- CNE6 保留主线 `sourceQuality`、`descriptorQuality`、`dataQuality`、原始覆盖分母及 proxy 标记，不退回只验证矩阵的消费契约。
- 来源上海时区与日期检查可吸收，但不能弱化主线“发布时间不早于模型末日收盘”的校验。诊断快照可显式缺发布时间；用于决策时必须有真实 `availableAt`，禁止猜测。
- 数值 `warning` 与来源可用于策略是两件事；矩阵有效、条件数、来源质量和 proxy 许可分别由显式策略决定。
- Ledoit–Wolf 保留为原生实验明确选择的风险源；它不能成为 A3 fallback，也不能代替 A2 的风险模型验收。选择 CNE6 却没有合格快照时直接失败。
- 首轮保留来源密集面板和有界资源约束，记录 500 证券、200,000 行、32 因子、每图 64 节点、窗口 1,000、因子面板 200 万单元等边界。它们是契约上限，不是性能保证。
- `raw-no-corporate-actions` 数据仍限定在声明的无公司行动实验范围。连续 `previousClose` 校验不是不存在公司行动的证明，也不能把复权价当原始成交价。
- 不补造上市前行情、不把未知停牌或历史成员填为正常、不以删除证券或缩短期间宣布原定验收通过。

### 3.3 统一逐日回放，不保留第二个账本

主线 `portfolio.py:275–297` 当前根据成交日开盘价将 target weights 转成数量，且目标提前给定；来源 `replay_targets` 在决策日冻结数量并读取实际成交后的账户。二者不能通过传递同一权重表实现等价。

在现有 `run_research_backtest` 内扩展明确的逐日决策路径：

1. 处理已有现金结算、持仓批次及公司行动。
2. 决策截止时点只暴露合法数据、实际现金、持仓和可卖量。
3. 调用对应优化模式，冻结委托数量、规则、价格基准与容量依据。
4. 下一合法交易时点由既有 `fill_order` 结算。
5. 记录请求量、实际成交量、拒绝、部分成交和过期，反馈实际账户给下一次决策。

约束如下：

- 开盘跳空不能反向重算已经决定的委托数量；现金不足可以减少实际成交，但不能倒改请求量。
- 容量依据在决策时已知。来源前一日成交量与主线 ADV notional 是不同口径，显式登记，不读取未来全天量决定委托。
- 共用 `money`、费用分项、T+1、方向性交易许可、涨跌停和逐资产 lot；不能在来源循环里继续用浮点累加维护另一本现金账。
- 原生路径每天验证持仓估值的 PIT 可见性；缺失或未来估值不伪造净值，按该路径契约阻断或标记不可用。
- 来源将滑点价格夹到边界，主线 `fill_order` 会拒绝越界成交。**采用主线拒绝规则**，登记行为版本和针对性测试，不要求复现来源成交数或 Demo 旧收益。
- 旧固定持有期和显式 target-schedule 入口保留原有明确契约；新增冻结数量路径不静默改变其含义，不保留长期转发壳。
- 主线已有公司行动、分红应收/到账日和历史费率不被来源较窄能力覆盖。复杂事件未支持时明确阻断；record/ex/pay、批次可卖期等完整扩展仍按 A4 验收。

### 3.4 基准与收益诊断

保留来源“同日期、费用和执行规则下的合格池等权组合”，名称固定为实验等权基准。冻结持仓先占用预算、剩余预算再分配的逻辑通过共同回放器执行。

实际 CSI300/CSI800、价格/全收益序列、复制误差和实验等权组合分别记录。等权组合不能填入实际指数缺口；原生实验计算完成可以与“真实基准/归因未验收”同时成立。现有 A3/A4 入口缺真实基准或归因时仍保持 missing/partial，不降级判为策略验证通过。

模型 OOS RMSE、逐日 RankIC、分组收益、相关性及净值指标保留为诊断。模型预测标签不是实际成交收益，两者的 horizon、费用、成交及样本分母必须明确。

### 3.5 一套实验存储与运行身份

复用 ResearchWorkspace 的 Evidence、ModelRun、artifact 和 run manifest；来源 `ExperimentStore` 的功能由该体系承接，不新增 `.runtime/finance-data/quant-research/<workspace>` 作为第二个权威台账。

- CLI 与 DSH 经过同一应用层进行 import/run/get/list；写操作绑定 workspace/case 和 revision，Python 只计算，不自行修改 case。
- 只读 catalog/schema 不创建实验状态；分页和 workspace 隔离继续保留。
- 登记数据、spec、目标模式、mandate、成本、基准、种子、训练折、完整代码内容及依赖锁；保留实际运行库版本，不只 hash 来源列出的固定几份文件。
- 区分内容身份 hash 与 artifact 原始字节 hash；TS/Python 规范化通过共同 fixture 验证，不能用语义 hash 充当文件完整性 hash。
- 大数据由可信操作员导入为注册 artifact；Agent 只提交 JSON 或 ID。计算侧只接收由应用层解析、限定目录与大小并验证 hash/schema/行数的 artifact 描述，拒绝 Agent 直接指定任意路径。
- 输入、结果按有界 artifact 分区保存，不能让 128 MiB 单产物上限变成扩大 8 MiB Agent 上下文的理由；每一边界分别限额。
- 合并后的代码、契约或经济语义改变产生新 run 身份。旧产物不可覆盖，来源 Demo 的旧 run ID 不是新系统的验收目标。
- 实施前盘点是否有必须迁移的真实旧产物；若存在，保留旧身份并生成明确的导入映射与新登记，不默默改写历史 hash。合成 Demo 不作为必须迁移的真实历史。

### 3.6 登记、恢复与实验准入

主线已在 `strategy-tools.ts:160` 的研究/walk-forward 入口做 register-before-test，但 `validation.py:132` 仍接受调用方收益，`DateFold` 仍使用自然日 purge；来源滚动模型不能自动修复这些已有接口。

- 新原生实验从登记参数、特征、模型、优化与实际成交生成收益，保存相应 BacktestRun 和中间引用，不接受手填收益作为该链路的结果。
- 重复已完成请求返回原结果；中断后只能继续同一冻结登记，检查已有阶段产物，失败和重试均留证据。
- 恢复能力未实现的阶段明确 blocked，不能换 ID 后当作新未见测试。
- 新原生模型保留交易日历、标签成熟与 embargo 语义；不以其存在宣称旧 walk-forward 已完成迁移。
- 跨候选 TestPartition 使用记录、完整恢复协议、独立归因与最终样本外准入仍作为 A4 的独立验收。原生运行始终 `promotionEligible: false`，不自动晋级。

### 3.7 CLI、DSH 与安全治理

保留 `finance_quant_research` 的 catalog/schema/import/run/get/list 六类能力，仅加入 strategy-research preset；默认分析师及其他 preset 不扩权。CLI 作为同一应用层的操作员入口，不继续拥有另一套 Python 存储。

桥接保留主线 `--frozen --offline --no-sync --no-env-file --no-config`，吸收来源的进程组取消、超时清理和 BLAS 线程限制；保留固定操作枚举、严格 JSON、有限输入输出和错误日志上限。不得因新增入口重新开放任意代码、路径、模型 pickle、配置注入或网络访问。

canonical/generated preset 按生成流程同步，能力清单按实际工具注册和验证结果更新。来源默认分析师 20 个工具、35 个治理工具等数字属于历史基线，不能覆盖当前测试断言。

依赖整合到当前 `packages/combinatorial-optimization/pyproject.toml`，新增实际使用的 pandas、Pydantic、scikit-learn、CLARABEL、threadpoolctl 等直接依赖，保留 OSQP 与 CNE6 所需依赖。来源 Python `>=3.12`、目标 `>=3.11` 及 NumPy/Numba 等约束需先验证交集；不能直接覆盖目标 Python 下限和锁文件。优先保持目标支持范围，确需升级则单列影响并确认。

漏洞审计按当前实际 Python 项目核对：根目录、`packages/combinatorial-optimization`、`packages/finance-data-service/providers/tdx`。不保留旧 `finance-provider-tdx` 或独立 `quant-research` 路径；许可证基线重新生成，保留强 copyleft 检测和经证据核实的版本级分类，不关闭 TLS 校验。

## 4. 实施工作包与退出条件

一次只推进一个主要契约/行为工作包，数据采集、模型收益搜索和整合不同时展开。以下是实施与验收顺序，不意味着将半成品逐批并入 main；完整能力联通并验收前不暴露可误用的完整 run 入口。

| ID | 主要改动 | 退出条件与失败处理 |
|---|---|---|
| M0 基线与三方预演 | 固定双方 SHA、工具链与 dirty-tree；盘点数据产物；获实际合并授权后在独立集成分支获取固定来源并做三方预演 | 输出目录迁移、修改/删除和同文件冲突清单；主线推进或存在未归属改动时先重定基线，不覆盖 |
| M1 路径、契约、依赖 | 统一 Python 安装与测试目录；冻结模式、单位、时间/风险/换手定义；整合 pyproject 与锁文件 | 依赖交集和公共契约通过，现有 A3 baseline 不退化；冲突不可通过恢复旧 package 规避 |
| M2 因子与模型 | 迁移因子图、模板、滚动模型、诊断及 lineage，复用等价因子操作 | 数值、PIT、训练隔离、标签成熟与复算通过；非等价算法显式版本化 |
| M3 优化与风险 | 显式目标分派，共享适用约束、风险校验与整手诊断，补齐 CNE6 时间校验 | A3 golden fixtures 保持经济语义；原生 mean-variance/top-k 可用，不能绕过质量或计划权限 |
| M4 统一回放 | 在 portfolio 接入逐日 policy、冻结数量、实际成交反馈 | 跳空、部分成交、缺失估值、T+1、费用、现金、逐资产 lot 及既有公司行动回归通过 |
| M5 实验登记与产物 | research-workflow 编排、research-workspace 存储查询、内容身份与恢复 | 不可变性、跨 workspace 隔离、重复请求、并发和中断处理通过；不产生平行台账 |
| M6 CLI、DSH 与治理 | 六类 action、CLI、preset、能力清单、安全桥接、依赖审计 | 真实 Node→Python 集成可运行；仅 strategy preset 增加工具；旧 portfolio/walk-forward 行为保留 |
| M7 综合验收 | 合成 Demo、完整离线门禁、联网审计、实际 headless/Web 操作 | 汇总 done/blocked/evidence/next；确认来源能力覆盖与 A3 不退化，再申请提交/合并 |

用户后续已授权实际实施；M0 的集成分支、固定来源获取和三方预演已执行。不能使用全局 `ours/theirs` 解决语义冲突，不能仅 cherry-pick 后测试变绿就宣称完成整合；最终保留来源提交追溯关系与人工整合记录。具体文本冲突以固定快照的预演结果为准。

### 4.1 关键文件与冲突解决原则

| 目标文件/区域 | 处理原则 |
|---|---|
| `packages/combinatorial-optimization/ngfi_quant/{optimizer,execution,portfolio,agent_bridge,hashing}.py` | 主线为骨架，逐行为接入来源能力；不恢复被删除的旧路径 |
| `packages/combinatorial-optimization/ngfi_quant/factors/` | 算子、训练特征和诊断按语义合并，不复制整套近似实现 |
| `packages/combinatorial-optimization/cne6_engine/interfaces/portfolio_risk.py` | 保留主线 after-close 与来源/descriptor/coverage 信息，增量吸收日期校验 |
| `packages/dsh-finance-tools/src/{strategy-tools,index,runtime-store}.ts` | 保留主线操作和安全参数，新增研究 action 和取消能力；不能丢失原有注册/持仓绑定 |
| `packages/research-workflow/src/`、`packages/research-workspace/src/` | 新增必要的研究编排和持久化能力，复用既有 case、revision、ModelRun、artifact |
| 根 `package.json`、量化 `pyproject.toml` / `uv.lock` | 保留主线 pytest、skills 路径和 pnpm 要求，增量添加 CLI 与直接依赖 |
| `scripts/dependency-audit.mjs`、来源漏洞审计与 CLI scripts | 使用当前包结构，保留审计范围和证书安全，不保留旧项目列表 |
| `config/agent-presets/strategy-research/`、`generated/agent-presets/strategy-research/` | canonical 修改后生成，不手工拼接生成文件 |
| `tests/`、`packages/combinatorial-optimization/quant_tests/` | 来源测试意图保留，A3 回归保留，旧路径和不再等价的数值预期同批更新 |
| `docs/quant-research.md`、运行指南、能力清单、许可证清单 | 原生指南为后续迁入文件；更新路径、模式、限制与实测证据，不退回来源历史数量 |

表中为实现落点；实际改动与完成状态以文末逐包执行记录和工作区差异为准。

## 5. 验证与验收

### 5.1 功能与负路径矩阵

| 验证域 | 必测场景 |
|---|---|
| A3 回归 | 六个工作包；确认账户 cash/sellable 不符拒绝；无分持仓不污染 rank；完整基准与风险覆盖；成本代理；逐资产 lot/oracle；内容寻址 |
| 优化语义 | rank 与预测收益不可混用；full-L1/L1-half 等价转换；主动/绝对风险；horizon 方差缩放；top-k 冻结持仓和被选集合不可行；无静默 fallback |
| 因子与模型 | 固定算子数值；MAD/分位数区别；并列 rank；常数/缺失截面；单样本行业；Ridge/HGB 复算；train-only scaler/clip；不加载 pickle |
| 时间隔离 | 注入未来行情、特征、标签和风险发布时间；历史结果拒绝或不变；交易日假期、跨时区、成熟边界与 embargo |
| 账户闭环 | 决策固定数量、跳空不改委托、现金不足和部分成交、实际持仓反馈、订单过期、零股、逐资产 lot、T+1、费用按分、停牌与涨跌停 |
| 估值与公司行动 | 非调仓日未来/缺失估值；分红应收与到账；已支持送转和历史费率；未支持事件不静默忽略 |
| 基准与归因 | 等权实验基准独立标记；实际 CSI 数据缺失保持 missing/partial；不将 reconciliation 恒等式当完整归因证明 |
| 身份与存储 | TS/Python canonical fixture；内容 hash 与字节 hash 区分；篡改、重复请求、revision 冲突、跨 workspace 隔离、失败登记与中断恢复 |
| 安全 | 重复 JSON key、非有限数、路径穿越、软链接、非普通文件、超限读写、stdout/stderr 上限、进程组取消和超时；离线参数保留 |
| 入口与权限 | CLI 六类操作；Agent 只传 JSON/ID；默认 preset 不扩权；原 A3 portfolio、backtest、walk-forward 注册路径无回归 |

### 5.2 工具链与命令

以下为验收命令清单；原生集成测试和 CLI 已在 M6 落地，实际执行次数、最终结果与环境阻断见 M7 记录，不以清单本身表示通过。

先使用项目声明的 pnpm `11.19.0`、Node 支持范围、uv 和冻结 Python 环境。安装行为仅在获授权的准备阶段执行，工具运行时不自动下载或同步依赖。

```bash
pnpm test:quant-research
pnpm exec vitest run tests/portfolio-tools.test.ts tests/content-addressed-artifact.test.ts tests/strategy-tools.test.ts tests/quant-workflow-integration.test.ts tests/composition.test.ts
pnpm test:cne6
pnpm check
pnpm dependency:audit
pnpm quant:demo
git diff --check
```

新增原生测试纳入现有 `test:quant-research` 和 `pnpm check` 聚合链；迁移测试目录不能导致来源测试或 A3 测试未被收集。新增许可证和漏洞审计测试同样进入全量 TS 门禁。

验证策略：

1. 固定当前 A3 输入与经济输出作为 golden baseline；求解器、平台浮点差异使用事先登记的容差，实际 artifact hash 照实保留。
2. 用去敏固定 fixture 迁移来源因子、模型和目标行为；因账本统一而改变的成交结果单列，不伪称旧结果字节复现。
3. 合成 Demo 验证工程闭环。`synthetic` 标记随数据和结果追溯，`promotionEligible=false`；不把合成日期称交易所日历，不用收益率宣称投资业绩。
4. CLI 完成 catalog/schema/import/run/get/list，检查分区结果、分页、失败、重复请求与取消。
5. 通过 `NGFI_AGENT_PRESET=strategy-research` 运行项目 headless/Web 入口；用浏览器实际操作查询、运行和失败路径，并检查默认 preset 未扩权。浏览器不可用时记录 Web 验证 blocked，不能以类型检查代替。
6. 环境缺失、联网审计失败、真实数据缺口分别记录 blocked，不修改阈值、锁文件或许可证基线来掩盖失败。

### 5.3 三种独立结论

每个工作包与最终验收都报告 `done / blocked / evidence / next`，最后分别给出：

- **工程集成**：能力是否联通、契约是否一致、A3 是否回归、安全与复算是否通过。
- **数据用途**：指定 universe、日期和字段是否有合格来源、PIT 和覆盖；有限实验输入不能替代 A2 全市场验收。
- **策略证据**：样本外或前向结果是否支持增量；工程 complete 不等于策略有效。

来源合成 Demo、固定测试通过和 `complete` 只能支持第一类结论。A2 blocked、A3 全市场性能、A4 归因/测试窗治理等未完成项必须继续显式保留。

## 6. 回退、停止条件与交付边界

- 不修改正式数据发布或 CURRENT，不改写历史研究产物。
- 工作区出现未归属改动、目标继续推进或来源 SHA 改变时，暂停相应整合步骤并更新基线；不自动 stash、丢弃或覆盖其他工作。
- 合并前失败保留在集成分支，定位具体工作包；不通过全局 ours/theirs、恢复旧 package、放松质量门禁或清空工作区解决。
- 合并后确需回退，通过经授权的新 revert 提交处理；不 force-push，不删除旧实验。回退只影响未来运行，不重写历史结果。
- 单次资源超限、风险质量不合格、候选不可行、整数搜索未命中、数据缺失和运行中断分别报告，不混称策略失败或数学不可行。
- 不以提交或推送作为工作完成的自动步骤；提交、创建 PR 和合并仍需授权。

用户已要求按本计划完整实施并逐项更新记录；不改变既有 Smart Beta 数据/策略准入结论，不直接将来源 package 覆盖到 main。

## 7. 执行记录

### M0 — done（2026-09-12）

- 分支：`integrate/native-quant-research`，从 `3ebc44d` 创建；来源已获取为 `origin/feat/native-quant-research@0676dca`，共同祖先仍为 `a17b499`。
- `git merge-tree --write-tree --name-only` 预演得到 tree `d80c5930d2e970a19c6e05a6530b1cc0a949decd`，28 个冲突路径；未把冲突树写入工作区或 index，后续按能力逐项移植。
- 冲突分类：9 个内容冲突（README、能力/许可证/运行文档、package.json、CNE6 facade、strategy-tools、composition/strategy tests）；15 个目录迁移位置冲突（8 个新 Python 模块、7 个 Python 测试）；4 个旧路径 modify/delete（agent_bridge、execution、pyproject、uv.lock）。
- 本地没有来源报告的旧 checkout，也没有默认 `.runtime/finance-data` 或原生量化 runs；已有 `.runtime/equity-data` 等 A2 产物保持不动，不触碰 secrets/CURRENT。未配置为本次输入的外部数据根未作迁移。
- 工具链：Node `24.13.0`，`corepack pnpm 11.19.0`（PATH 无直接 pnpm），uv `0.11.28`，量化 venv Python `3.13.12`。
- 锁文件 SHA256：pnpm `92cc8bea0852c2af4624f78b2ce4a0fec214df4cd9db082cfdb05dc56170e453`；根 uv `4c75c6a886f3393cc1101d95aba5eb2c688905c7881f563ffd31608622f74a72`；量化 uv `21111582e163ae59b8e4d4f12c0320807e40729514c5a885e78739b565eb6671`。
- evidence：冻结离线 quant pytest **54 passed / 24 subtests**；portfolio-tools、portfolio-risk-contracts、content-addressed-artifact **26 passed**。
- blocked：无 M0 阻断；实际最终 Git merge/提交未执行。
- next：M1 统一数据/模式契约、直接依赖和测试目录，继续保留原生算法来源 SHA。

### M1 — done（2026-09-12）

- `research_contracts.py` 落在现有 `combinatorial-optimization/ngfi_quant`；schema v2 明确 `research-diagnostic`、显式 CNE6/Ledoit–Wolf 风险源、synthetic 标记、逐资产 lot、停牌状态及其可得时间；旧 schema/全局 lot/策略准入用途不会静默兼容。
- 保留主线 Python `>=3.11` 和 pandas `3.0.5`；新增 Pydantic、scikit-learn、CLARABEL、threadpoolctl 直接依赖。首次沿用来源 pandas<3 产生降级，已修正为保留主线版本并重新锁定；无新增顶层 package。
- evidence：`uv lock --check --offline` 通过；新契约和原 A3 optimizer 定向测试 **23 passed / 29 subtests**，首轮 all-pass；新契约用例覆盖严格字段、时间、密集面板、hash、规则缺失和用途隔离。
- 测试流程：Step1–4 完成，LANG=python（TS 边界另用 javascript 规则），执行来源为空；TARGETS 为本计划明确的领域/应用模块；BUG_MAP 初始为空，现有口径差异不冒充现存缺陷。测试临时目录为系统临时目录，不写入仓库。
- blocked：无 M1 阻断；Python 3.11 运行本体未单独执行（uv 已校验声明范围的依赖可解析），当前实测为 3.13.12。
- next：M2 将来源因子图整合到现有 factors，并保留原生逐日模型与诊断语义。

### M2 — done（2026-09-12）

- 来源 `0676dca` 的因子图迁入 `ngfi_quant/factors/graph.py`：12 模板、17 固定算子、PIT 面板、逐日 IC/分组/相关性；复用主线 `standardize_values`，MAD 与分位数、中性化与标签差异保留显式算法。
- 新增 `research_models.py`：Ridge/HGB、训练期 clipping/scaler、交易日成熟与 embargo、输入矩阵行列对齐、训练身份和逐日预测；标签可见时间同时纳入行情与交易状态时间。
- `demo.py` 为明确 synthetic 的 v2 输入生成器，沿用固定 seed、100 工作日/8 证券，并使用分精度行情及显式规则；不冒充真实日历或数据。
- evidence（Step5 生成→验证，首轮 all-pass）：因子新旧用例 **14 passed / 22 subtests**；滚动模型 **5 passed**，包括未来扰动不改历史、HGB 固定复算、训练不足拒绝。pandas 3.0.5 兼容已通过这些实测。
- blocked：无 M2 阻断；模型诊断不构成 A4 测试窗治理或收益准入。
- next：M3 共享风险校验和约束边界，保留 A3 OSQP，同时实现明确的原生 CLARABEL 目标。

### M3 — done（2026-09-12）

- A3 `optimizer.py` 提取共同 CNE6 校验和 L1/2 定义，原 A3 输入/输出与 OSQP 目标不改；原生 mean-variance/top-k 同模块使用 CLARABEL，输出目标类型、full-L1 及换算系数、研究权限边界。
- 原生风险必须显式选择；CNE6 复用 A3 来源/质量/覆盖/PSD/重构检查，horizon 仅缩放预测风险；Ledoit–Wolf 无法成为 CNE6 失败 fallback。CNE6 producer 保留 after-close 校验并严格解析日期/时间。
- 原生决策整手计划复用 `_repair`、`_diagnostics`、`_lot_oracle` 与唯一 `fill_order`，记录账户 hash、估算成交和可行性范围；top-k 候选数不删除冻结持仓，连续/整数/未来成交保证分开。
- evidence（Step5 两次增量生成→验证均 all-pass）：A3+原生优化+CNE6 facade **32 passed / 18 subtests**；追加共享整手案例后 A3+原生优化 **24 passed / 18 subtests**。
- blocked：无 M3 阻断；真实 CNE6 可用性仍按 A2 门禁，未伪造风险输入。
- next：M4 在现有 `run_research_backtest` 内接入冻结数量和逐日 policy，不新增独立目标回测账本。

### M4 — done（2026-09-12）

- 现有 `run_research_backtest` 新增内部 sequential policy 路径：显式开盘/决策时点、冻结数量/lot/容量、次日成交、订单过期和实际账户反馈；旧固定持有期与 target schedule 契约保留。
- 新 `experiment.py` 只编排因子→模型→优化→同一回放器，并投影原生查询分区；现金/费用/持仓仍由原 `portfolio.py` + `execution.py` 结算。等权实验基准与 CSI 缺失状态明确分开。
- 每日持仓估值检查 PIT；跳空不改请求量，部分成交保留请求和实成交；冻结委托跨公司行动未定义调整时拒绝，已有公司行动/应收/历史费率测试保持通过。
- evidence（Step5 生成→验证→修复）：首轮新增路径因漏导入 `TargetSchedule` 失败，定位为实现接线错误，补齐导入、未放宽断言；复跑回放+原 portfolio/execution **23 passed / 9 subtests**。原生完整实验/复算/风险失败/top-k 成本对照 **4 passed**。
- blocked：无 M4 有界原生路径阻断；A4 完整公司行动、独立归因、跨候选测试窗仍未验收。
- next：M5 使用 ResearchWorkspace 完成统一导入、登记、分区产物、查询和同任务恢复。

### M5 — done（2026-09-12）

- `research-workflow/src/quant-research.ts` 实现统一 import/run/get/list 应用层；数据、证据、登记、分区结果、ModelRun 和 manifest 均进入 ResearchWorkspace，无独立 ExperimentStore。
- 运行身份包含 dataset/spec/代码锁身份；计算返回逐分区内容 hash 校验，落盘字节 hash 由 workspace 登记。重复完成请求复用结果；中断留 decision evidence，必须显式 resume 原登记，已保存结果可补齐未完成 manifest。
- workspace 增加注册 artifact 有界读取、case 查询和跨 await 运行互斥；128 MiB 文件/产物上限。进程崩溃遗留的锁不自动删除，需先确认持有进程，防止双写；正常失败会释放锁并可恢复同任务。
- evidence：应用层新测试 **3 passed**；联合既有 workspace 回归 **15 passed**；research-workflow typecheck 通过。首次类型检查使用旧 lib 缺新增方法，按依赖顺序 build 后解决；另修正列表 hash 可选类型，未更改断言。
- blocked：无 M5 应用层阻断；当前单测注入固定计算器，真实 Python/大 artifact 通道及 Agent 权限由 M6 验证；跨候选 holdout 治理仍归 A4。
- next：M6 接入受限临时 artifact 计算传输、CLI/DSH 同应用层、preset 与审计。

### M6 — done（2026-09-12）

- 真实 `research-artifact` 桥接通过私有临时目录传输并双侧验证字节 hash/大小，Python 只计算；保留 offline/no-sync/no-env-file/no-config，超时/取消终止进程组，拒绝符号链接、非普通文件、重复 JSON key 和非有限数。
- `finance_quant_research` 六类 action 和 `pnpm quant:research/quant:demo` 共用应用层。仅 strategy preset 增加工具，默认 20 个 finance 工具不变；治理新增到 17 个、全 registry 37 个，14 package 不变。
- canonical preset 已重新生成；新增原生指南，更新 README、运行指南、Skill 和能力清单。Python 根导出用 `run_native_experiment` 区别现有验证模块的 `run_experiment`。
- 完整 BacktestRun、账本和计算身份一并存入分区 artifact；不仅保存摘要。相同 case 重复导入复用 dataset 登记。
- 审计脚本覆盖 Node + 当前 3 个 Python 项目；许可证新规则保留强 copyleft 检查。实际 wheel 文本核实 pandas 3.0.5 的 GPL 兼容性说明和 SciPy 1.18.1 的主体 BSD/附带 runtime 许可，版本级分类附 THIRD_PARTY_NOTICES，未批准二进制再分发。
- evidence：真实 DSH/Python + composition/strategy/portfolio **23 passed**；安全传输 **3 passed / 3 subtests**；审计测试 **4 passed**；最后应用层+artifact **9 passed**；build/typecheck/preset/边界/能力门禁通过。`check:static` 最终通过：27 capabilities（9 kernel/18 exposed）、562 许可证条目、安全扫描 558 文件。
- CLI Demo 实测 complete：synthetic=true、4 折、39 预测日、promotionEligible=false；actualBenchmarkStatus=missing、strategyValidationStatus=blocked，不以合成收益证明策略有效。
- 失败处理：许可证初次更新失败后按真实安装许可证核对再分类；静态扫描发现计划两处本机绝对路径，改为相对说明，没有禁用检查。
- blocked：无 M6 功能阻断；联网漏洞审计、完整离线门禁及浏览器/在线模型验证进入 M7。
- next：M7 执行综合回归与可用环境验证，分别报告工程、数据用途、策略证据。

### M7 — engineering pass / interactive validation blocked（2026-09-12）

#### 已完成与验证证据

| 检查 | 最终结果 |
|---|---|
| 完整 `corepack pnpm check` | 最终版本退出码 0；静态、build、typecheck、TS、quant、CNE6、skills、runtime 和工作区漂移检查通过 |
| TypeScript | 55 个文件，**1,089 passed** |
| Python quant（3.13.12） | **91 passed / 66 subtests** |
| Python quant（3.11.15） | 独立 `.runtime/quant-python311` 冻结环境，**91 passed / 66 subtests**；未替换默认 venv |
| CNE6 | **219 passed / 2 skipped**，沿用 warning-as-error 配置 |
| Skill 契约与财务 selftest | 14 项契约通过，finance-core selftest 通过 |
| 运行时 | headless/Web profile dump、4 个 preset materialization 通过 |
| Web 启动 | strategy-research preset 在 loopback 动态端口启动，HTTP **200**，smoke 后正常停止 |
| 在线模型 headless（2026-09-13） | 经 `openai-compatible` provider 接入 Model Hub（`gpt-5.6-terra`），`pnpm run test:e2e:model` 返回 `ok:true`；`credentialSource=process-environment`、真实工具链 `skill → finance_security_reference → finance_market_data` 命中，凭据未入库 |
| Node 联网审计 | high **0**、critical **0**、moderate **1**；high 阈值门禁通过，不称零漏洞 |
| Python 联网审计 | 根 41、量化 69、TDX 10 个生产包均未发现已知漏洞或 adverse status |
| 许可证与静态安全 | 562 生产许可证条目通过；27 capabilities（9 kernel/18 exposed）、14 package、preset drift、安全扫描通过 |
| 文档与差异 | 计划/指南相对链接、`git diff --check` 通过；无提交/推送/main 合并 |

最终 Demo case 为 `case-b493c357861516e319eb0e3dd944a3f671567575af65a816831aa3b79b3be9a3`，run 为 `sha256:39603baaa591fd4a7cb7a090d0c96b79ed3da965b8f1f1ff5076b231fe637227`，revision 22。4 折、39 预测日、39 条成交，CLI fills 分页返回 2 条；synthetic=true、promotionEligible=false、strategyValidationStatus=blocked。产物在默认 research/demo workspace，旧 Demo 保留不覆盖。

最终实现差异内容指纹：`sha256:82b84aed33a031dac1adf662a08f90b3fbe968b89f6fff45224aae1f3fb8cab9`。计算方法为对 45 个变更/新增的非 Markdown 文件按仓库相对路径排序，依次 hash `path + NUL + bytes + NUL`；用于未提交实现版本定位，不替代逐 artifact 身份。

#### 最终边界修正

- CLI 原始 JSON 通过固定 Python parser 校验后再进入应用层，重复键与 NaN 不在预解析时被吞掉；新增 parser 回归通过。
- diagnostics 按每日行分页，benchmark 查询只返回指标；完整 backtest/账本仍保存在注册 artifact。
- catalog/schema 拒绝额外 action 参数，Agent 不能借只读动作隐藏无关输入。
- 共享整数 oracle 先判断组合数，再创建惰性范围，避免极大 ADV 在上限检查前分配巨大 list；极大流动性回归通过，A3 经济结果不变。
- 上述修正后再次运行完整 `pnpm check`，不是沿用修正前绿灯。

#### 测试流程总结

- 范围：7 个新增 Python 测试文件、37 个顶层测试方法；4 个新增 TS 测试文件、9 个测试（其中 2 个为真实跨语言集成）；另更新 composition 权限断言，既有测试全部保留。
- 缺陷分析：初始未将合法口径差异当作缺陷；实现中漏导入、JSON 边界、分页及 oracle 资源边界已定位修正并回归，无为通过而放宽断言或清除失败证据。
- 生成→验证→修复的过程见 M1–M6；最终常规测试全部通过并复核。
- Step6：本任务未要求覆盖率阈值，无项目约定或 flux 覆盖率门禁，按工作流 `CHECK_COV_MODE=skip`，不虚构覆盖率百分比。
- Step7：`utree flush --repo-path` 已执行成功；执行来源为空，不新建额外 flux/缺陷报告文件。

#### 仍阻断与下一步

1. **浏览器交互 blocked**：浏览器连接查询为空。已验证 Web HTTP 启动，但未实际点击/输入验证页面，不将 HTTP 200 等同完整 UI E2E；接通浏览器后验证 catalog、运行、分页、失败及默认 preset 未扩权。
2. **在线模型 done（2026-09-13）**：用户授权的 Model Hub 凭据通过项目支持的 `openai-compatible` provider（`NGFI_LLM_BASE_URL`=Model Hub unified v1、`NGFI_LLM_MODEL=gpt-5.6-terra`、`NGFI_API_KEY` 经进程环境注入，未写入任何受跟踪文件）接入。实测 `pnpm run test:e2e:model` 返回 `ok:true`：`credentialSource=process-environment`、`selection.provider=openai-compatible`/`model=gpt-5.6-terra`、`preset=finance-analyst`，真实工具链 `skill → finance_security_reference → finance_market_data` 全部命中，中文答复披露 yfinance best-effort 来源、观察时间与抓取时间。仅验证 headless 在线模型链路，不改变 A2/A3/A4 数据门禁。凭据不入库。
3. **非阻断安全待办**：Node `yaml@2.8.1` 命中 `GHSA-48c2-rrv3-qjmp`（深层 YAML 集合 stack overflow，moderate，修复版本 >=2.8.3），同时来自根依赖和 DSH 链；本轮保留原依赖不扩大升级范围，需单独评估升级并重跑 runtime/许可证检查。
4. **数据/策略门禁不变**：A2、A3 全市场性能和 A4 未完成项保持 blocked；模型、等权 Demo 和测试通过不提供真实市场收益准入。
5. **Git 交付待授权**：所有实现留在 `integrate/native-quant-research` 未提交工作区；来源 SHA 和三方冲突清单已留存，未创建 merge commit、PR 或推送。人工复核和补齐 M7 环境验证后，再决定提交及合入 main。

结论：有界原生研究能力的代码整合、离线工程验收与在线模型 headless 链路验收已完成；M7 仅剩浏览器 UI 交互 E2E 一项环境依赖验证未完成，不能称“全部上线/全部合并完成”。
