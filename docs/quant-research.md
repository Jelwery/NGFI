# NGFI 原生量化研究

本流水线在现有研究底座上贯通 **因子 → 模型 → 组合优化 → 回测**。LocalQuant 仅作为设计参考，不是依赖、服务或兼容协议；无需安装它，也没有专用导入命令。计算由 NGFI 的 NumPy/pandas、scikit-learn 和 CVXPY 内核执行，DSH 仍是唯一 Agent loop。

当前交付是单机、日频、long-only 的研究基线，不是实盘平台。原有 `finance_strategy_backtest` 的固定持有期研究与 smoke 检查继续保留，新流程使用 `finance_quant_research` 和独立 CLI。

## 快速运行

在仓库根目录安装已锁定的量化环境：

```bash
uv sync --project packages/quant-research --frozen
pnpm quant:research --workspace alpha catalog
pnpm quant:research --workspace alpha schema
pnpm quant:demo
pnpm quant:research --workspace demo list
```

`quant:demo` 使用固定 seed 生成 100 个合成工作日、8 个合成证券，执行 4 个滚动训练窗口和 39 个预测日。日期不是实际交易所日历，价格不是市场行情；输出中的 `synthetic: true` 和来源说明必须保留，不能作为策略业绩。

可信操作员导入真实数据后运行：

```bash
pnpm quant:research --workspace alpha import /absolute/path/dataset.json
pnpm quant:research --workspace alpha run --dataset-id 'sha256:<dataset hash>' --spec /absolute/path/spec.json
pnpm quant:research --workspace alpha get 'sha256:<run hash>' --section summary
pnpm quant:research --workspace alpha get 'sha256:<run hash>' --section fills --offset 0 --limit 50
```

hash 使用上一命令的实际返回值。CLI 默认使用 `.runtime/finance-data/quant-research/<workspace>/`；`NGFI_RUNTIME_DATA_ROOT` 可由可信操作员指定。`NGFI_UV_EXECUTABLE` 可指定 uv；未设置时优先使用本机 `.runtime/python-tools/bin/uv`，否则使用 PATH 中的 uv。运行阶段固定 `--frozen --offline`，不会自动下载依赖或访问数据源。

## 数据快照

权威 JSON schema 来自 `schema` 命令，源契约在 [`research_contracts.py`](../packages/quant-research/ngfi_quant/research_contracts.py)。JSON 使用 camelCase，未知字段会被拒绝。核心字段：

| 字段 | 约定 |
|---|---|
| `schemaVersion` | `"1"` |
| `snapshotId` / `provenance` | 非空快照标识和数据来源说明 |
| `asOf` | 带时区的快照截止时间，覆盖所有行情可见时间及决策时间 |
| `priceBasis` | 当前仅 `"raw-no-corporate-actions"` |
| `universePolicy` | `"historical-membership"` 或 `"explicit-research-universe"` |
| `calendar` | 严格递增的实际交易日；每项有 `date/openAt/closeAt/decisionAt` |
| `bars` | 完整的交易日 × 证券面板，不能跳过停牌或缺失日期 |
| `cne6Models` | 可选的项目原生 CNE6 风险快照列表 |

每条 bar 包含 `date`、`instrument`、`availableAt`、`open/high/low/close/previousClose`、`volume`、`amount`、`eligible`、`industry`，以及可选的 `suspended`、`limitRate`、`features`。证券身份为 `market: "CN"`、`exchange: "SSE" | "SZSE" | "BSE"`、六位 `symbol` 和 `assetType: "equity"`。币种为人民币，价格单位为元，成交量为股，成交额为元。

`eligible`、行业和停牌状态必须是该历史日期的真实状态，不能把今天的指数成分或行业分类回填到历史。当前引擎会校验身份、时间和价格连续性，但不独立验证来源真实性或成员历史。密集面板不能通过伪造上市前价格、补零或猜测可见时间凑齐；遇到这类数据应缩小研究范围或先完善数据建设。

外部财务特征逐条保留来源 hash 和可见时间，例如 `features.roe` 的结构为：

```json
{
  "value": 0.12,
  "availableAt": "2024-04-30T18:00:00+08:00",
  "sourceHash": "sha256:<64 lowercase hexadecimal characters>"
}
```

这是字段格式说明，`sourceHash` 必须替换为实际来源内容 hash。因子只能读取在对应 `decisionAt` 之前已可见的观测；不可见值保持缺失。模型只训练有限且完整的特征/标签行，不将缺失当作零。

## 因子与实验规格

12 个内置模板覆盖动量、反转、低波动、量比、日内收益及 BP/EP/ROE/营收增长。财务模板要求先提供相应 PIT 特征，不会自动抓取或虚构财务数据。

因子是 NGFI 原生、带版本的声明式图。输入可绑定行情字段、`feature:<name>` 或前置定义的 `factor:<id>`。禁止循环依赖、未知算子、负向时间偏移及源码执行。支持的 17 个算子和参数以 `catalog.operators` 为准；截面变换为 `WINSORIZE`（MAD）、`ZSCORE`、`RANK`、`INDUSTRY_NEUTRALIZE`。

以下是完整规格结构示例；研究日期、训练长度和行业名称需要对应实际数据。数据必须包含足够的前置训练历史及 `endDate` 后的一个执行交易日：

```json
{
  "schemaVersion": "1",
  "startDate": "2024-04-01",
  "endDate": "2024-06-28",
  "factors": [
    {
      "id": "momentum_5",
      "version": "1",
      "inputs": {"close": "close"},
      "nodes": [
        {"id": "r", "op": "RETURN", "inputs": ["close"], "params": {"window": 5}}
      ],
      "output": "r",
      "transforms": [{"op": "ZSCORE"}]
    }
  ],
  "model": {
    "kind": "ridge",
    "trainSessions": 60,
    "refitEvery": 10,
    "horizon": 5,
    "embargoSessions": 1,
    "minimumSamples": 60,
    "ridgeAlpha": 1.0,
    "clipQuantile": 0.01,
    "seed": 17
  },
  "optimizer": {
    "method": "mean-variance",
    "maxWeight": 0.1,
    "cashReserve": 0.02,
    "riskAversion": 5.0,
    "maxTurnover": 0.5,
    "turnoverPenalty": 0.001,
    "riskLookback": 60,
    "industryCaps": {}
  },
  "execution": {
    "initialCapital": 1000000.0,
    "rebalanceEvery": 5,
    "lotSize": 100,
    "maxParticipation": 0.05,
    "commissionRate": 0.0003,
    "minimumCommission": 5.0,
    "stampDutyRate": 0.0005,
    "transferFeeRate": 0.00001,
    "slippageRate": 0.0005
  }
}
```

### 滚动模型

标签定义为 `open(t + 1 + horizon) / open(t + 1) - 1`，偏移基于显式交易日历，不按股票数据行数推算。每折在首个预测日前一交易日的决策时点冻结训练数据；标签必须已经结束且可见，再应用 `embargoSessions`。训练窗口不足时返回失败折，不用未来样本补足。

可选模型为 `ridge` 和 `hist-gradient-boosting`。后者使用 scikit-learn，参数为 `maxIter/maxLeafNodes/learningRate/seed`，不是 LightGBM。裁剪阈值及标准化只在训练集拟合。HGB 禁用隐式随机 early stopping；模型产物保留训练 hash、拟合截止时间、参数及预处理状态。Ridge 还保留系数；HGB 通过冻结输入重新训练复现，不加载 pickle。

### 组合优化

默认用决策时可见收益估计 Ledoit-Wolf 收缩协方差，并按标签 horizon 缩放。存在 `cne6Models` 时，选当时已可见的最新 CNE6 快照；每个快照必须分别提供模型日期 `asOf` 和带时区的实际发布时间 `availableAt`，研究只能在 `availableAt <= decisionAt` 时使用。模型日期与发布时间的日界线统一按上海时区解释，不按原始时间戳字符串截取日期。校验 daily/CNY、证券覆盖、矩阵维度、对称性、PSD 及 `B F Bᵀ + diag(specificRisk²)` 对账；结构有效但条件数告警的 `quality.status: "warning"` 可以使用，`invalid` 必须拒绝。没有合格 CNE6 快照则该次优化失败，不静默改用历史协方差。

`mean-variance` 最大化预测收益减风险和换手惩罚。`top-k` 先形成预测排序目标，再求其满足相同约束的近似组合；不是不顾约束的直接等权选股。共同约束包括 long-only、单股上限、现金预留、行业上限及 L1 换手上限。`maxTurnover` 是买卖权重变化绝对值之和，不除以二。决策时已知停牌的持仓被冻结；若冻结持仓与其他约束冲突，则显式不可行，不自动放宽限制。

### 调仓回测

决策日收盘估值确定目标股数，下一交易日开盘尝试成交；开盘跳空不会反过来改变已决定的委托数量。任何持仓收盘价必须在当日 `decisionAt` 前可见，否则回测失败关闭，不使用未来价格、不沿用未声明的旧价格，也不跳过该净值点。先卖后买，按整手、T+1、现金余额、停牌和涨跌停约束执行；涨跌停价和滑点成交价按 0.01 元最小报价单位半入取整，滑点不能越过涨跌停边界。计入佣金、最低佣金、印花税、过户费和滑点。成交参与量上限使用决策日已知成交量，不用未来全天量。

订单记录请求量、成交量、拒绝原因和成交后账本。未成交部分过期；下一次优化使用实际持仓，不假设目标已成交。初始尚未投资的零收益点不参与年化；基准使用相同日期、成本和执行规则的可选池等权组合，不套用 alpha 或风险约束。停牌持仓按实际权重冻结，基准只把扣除冻结权重后的剩余预算等权分配给可交易证券；冻结权重超过可投资预算时显式失败。

## 结果与复现

数据和实验是内容寻址的不可变 JSON 产物。运行身份包含 dataset hash、spec hash、引擎源码 hash 和关键依赖版本；模型、预测、因子、诊断、策略账本和基准各有独立 artifact hash。相同环境及输入可复算，身份冲突或文件内容篡改会报错。

| `get --section` | 内容 |
|---|---|
| `summary` / `spec` | 状态、参数、模型/策略/基准指标、限制 |
| `models` / `predictions` | 训练折和样本外预测 |
| `factors` / `factorSummary` | 因子值、覆盖率、RankIC、ICIR、分组收益和换手 |
| `diagnostics` / `correlations` | 每日因子诊断和平均截面相关性 |
| `modelDiagnostics` | OOS RMSE、RankIC、样本数和每日明细 |
| `equity` / `orders` / `fills` / `decisions` | 净值、委托、成交和优化决策 |
| `benchmark` | 同口径等权基准指标 |

列表结果按 `offset/limit` 分页，`limit` 最大 200；对象结果在 `value` 中返回。`list` 最多列出 200 个运行 ID 和 200 个数据 ID，排序按 hash，不表示创建时间。`partial` 必须结合失败模型折和 `decisions` 检查；`complete` 仅表示这次计算满足工程完成条件，不表示策略有效。

样本外诊断只是评价证据。不能反复使用同一测试窗口筛因子、调参，再称其为未见样本；本版没有自动超参搜索或自动晋级，始终 `promotionEligible: false`。

## DSH 入口

使用 `NGFI_AGENT_PRESET=strategy-research` 启动原有 headless/Web 入口。默认 `finance-analyst` 的工具清单不变。示例：

```bash
NGFI_AGENT_PRESET=strategy-research pnpm ask -- "调用 finance_quant_research，先查看 catalog 和 schema，再列出 demo 工作区已有实验；只检查合成示例，不编造行情或收益结论。"
```

`finance_quant_research` 支持：

```json
{"action": "catalog"}
{"action": "schema"}
{"action": "list", "workspace_id": "demo"}
{"action": "get", "workspace_id": "demo", "run_id": "sha256:<run hash>", "section": "factorSummary", "limit": 20}
```

`import` 接受 `workspace_id/dataset`，`run` 接受 `workspace_id/dataset_id/spec`。Agent 只能传 JSON 或 ID，不能指定文件路径、源码、模型文件或网络地址。大数据先由操作员通过 CLI 导入，再让 Agent 引用 ID。

本机若已配置项目专用 `dsh-trae.local.mjs`，可用相同的 `NGFI_AGENT_PRESET=strategy-research` 运行其 `ask` 或 `start` 命令，复用 TRAEX 的凭据管理；它是 Git 忽略的本机入口，不是所有 clone 都自带的文件。已运行的 Web 进程需停止后重新启动，才会切换 preset 或加载新构建。

## 限制与验证

- 当前只支持 macOS/Linux 单机文件存储和进程级互斥锁，没有分布式任务队列。
- 最多 500 证券、200000 条行情、32 因子、每图 64 节点、窗口 1000；实验因子面板最多 200 万单元。实际可运行规模还受内存和执行时间影响。
- DSH 单次输入/输出最多 8 MiB，计算超时 120 秒。CLI 不受此子进程时限约束，但仍受契约、面板和单产物 128 MiB 限制。
- 不支持公司行动账本。连续 `previousClose` 检查只拦截明显断点，不能独立证明数据没有分红、送转或拆并股；不得用复权价冒充未复权成交价。
- 不自动构建全市场历史面板，未处理上市前/退市后缺失面板，也不验证数据源许可或历史成员真实性。
- 日频成交模型不模拟分钟路径、集合竞价排队或逐笔冲击；税费在单次实验内固定，跨制度时期需另行分段建模。
- 未验证真实市场收益、稳定盈利、全市场容量或实盘成交。

离线验证命令：

```bash
pnpm test:quant-research
pnpm exec vitest run tests/quant-workflow-integration.test.ts tests/strategy-tools.test.ts tests/composition.test.ts
pnpm capability:check
pnpm check
```

测试覆盖 PIT、purge、因子数值、模型复算、优化不可行、CNE6 对账、次日成交、跳空、费用、实际持仓反馈、文件完整性及跨工作区隔离。集成测试会调用真实 uv/Python 子进程，运行前需要安装量化环境并确保 uv 在 PATH。
