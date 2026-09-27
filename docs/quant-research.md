# NGFI 原生量化研究

原生研究在现有 `packages/combinatorial-optimization` 中提供 PIT 面板、版本化因子图、Ridge/HGB 滚动模型、mean-variance/top-k 目标和逐日回放。它与 A3 共用风险校验、整手诊断和成交账本，与其他研究共用 ResearchWorkspace；不需要独立 quant-research package 或 LocalQuant 服务。

源码调研、建设边界及实施记录见 [因子裂变与归因建设方案](quant-factor-analytics-plan.md)。v3 已接入因子资产、受控裂变、评估登记与四类解释；真实数据和策略门禁仍独立验收。

## 安装和合成示例

```bash
pnpm build
uv sync --project packages/combinatorial-optimization --frozen --extra dev
pnpm quant:research --workspace alpha catalog
pnpm quant:research --workspace alpha schema
pnpm quant:demo
pnpm quant:research --workspace demo list
```

使用项目声明的 pnpm 11.19.0；PATH 无 pnpm 时可通过 `corepack pnpm` 调用。运行阶段固定离线、不同步依赖。`NGFI_UV_EXECUTABLE` 可由操作员指定 uv，`NGFI_RUNTIME_DATA_ROOT` 可指定运行数据根。

Demo 是固定 seed 的 100 个合成工作日、8 个证券，不是交易所日历或真实行情。数据和结果始终保留 `synthetic: true`；工程 `complete` 不代表策略有效，`promotionEligible` 恒为 false。

## 数据和研究契约

`schema` 返回权威 JSON Schema，源码为 `ngfi_quant/research_contracts.py`。数据和实验支持 `"2"`、`"3"`，运行时版本必须一致。v2 序列化不增加 v3 字段，旧回放保留旧归因口径。

- 数据声明 `snapshotId/asOf/provenance/synthetic`、`priceBasis: raw-no-corporate-actions`、`universePolicy`。
- 交易日具有 `date/openAt/closeAt/decisionAt`，按上海业务日期解释，决策必须早于下一交易日开盘。
- 行情为完整证券×日历密集面板，包含证券身份、OHLC/previousClose、volume/amount、eligible/industry，以及必填的 suspended、limitRate、lotSize、statusAvailableAt。不猜测未知交易规则或历史成员。
- 外部特征逐条保存 `value/availableAt/sourceHash`；不可见值保持缺失，不填成 0。
- 研究规格必须明确 `risk.source: cne6 | ledoit-wolf`；用途仅 `research-diagnostic`。CNE6 不可用不回退 Ledoit–Wolf。
- CNE6 保留来源/descriptor/覆盖等质量信息，按 policy 校验，发布时间不能早于最后模型日收盘。
- 最高 500 证券、200,000 条 bars、32 因子、每图 64 节点、算子窗口 1,000、因子面板 200 万单元；不是性能保证，也不是 A2 全市场验收。

12 个模板、17 个旧算子由 `catalog` 查询；`factor-catalog` 还提供 v3 算子契约、因子卡及反向依赖。新增 DELTA、TS_RANK、相关/协方差、线性衰减、分位数、argmax/min、SIGN、比较和 SELECT。拒绝源码、动态算子、循环依赖和负时间偏移。MAD 去极值与旧分位数方法有明确区别。滚动标签使用交易日历上的 `open(t+1+h)/open(t+1)-1`，训练只使用成熟且可见的标签，裁剪/标准化仅在训练集拟合，HGB 不加载 pickle。

v3 数据可提供 `benchmark`（CSI300/800、price/total-return、来源 hash、可得时间和值序列），以及 `returnAttribution`（相邻日期、期初可见权重/暴露、country/industry/style 收益、逐股 specificReturns、行业及 model/source hash）。股票收益口径固定 close-to-close total-return，与因子预测标签分别标记。实际指数没有输入时保持 missing，不用实验等权对照填补。

v3 实验自动保存 Ridge 在实际预处理空间中的精确预测贡献。HGB 可在 `modelExplanation` 登记 groups、methods、repeats、seed；methods 支持 `within-date-permutation` 与 `training-mean-ablation`，后者将组替换为已拟合训练均值、不重训模型。误差增量只用成熟标签；分组诊断不具有可加和收益含义。

`spec.factors` 保存计算 DAG 所需的全部定义；v3 可用 `modelFeatures` 显式指定参与训练的因子，省略时使用全部定义。依赖父因子可以只参与计算；实际模型特征必须属于冻结选择，解释分组也只能引用这些特征。`modelFeatures` 本身属于事前登记内容，不能看完测试结果再调整。

## 优化与回放

A3 `finance_portfolio_optimize` 仍使用排名偏好、主动 CNE6 风险和 OSQP，不改变默认契约。原生研究使用预测收益/绝对风险的 mean-variance，或确定性候选选择后的 constrained top-k，由 CLARABEL 求解。top-k 不是全局基数最优，冻结持仓不因候选排序被删除。

原生 `maxTurnover` 是 full-L1；公共内部 L1/2 上限减半、惩罚系数加倍，结果回显口径。horizon 按方差线性缩放，明确忽略跨期协方差的近似，不改变 A3 日频风险定义。

目标经过现有整手与现金约束检查后，在收盘决策时固定数量，下一交易日按实际开盘成交。开盘跳空不重算委托；部分成交、未成交过期及实际持仓反馈可追溯。成交费用按分计算，遵守 T+1、逐资产 lot、停牌、价格限制；滑点越过价格边界按主线规则拒绝，不夹价伪造成交。

原生等权基准只用于实验对照，不冒充 CSI300/800。实际指数/归因缺失单独标记，原有 A3/A4 门禁不放宽。原生研究目标不是经过用户确认账户的 A3 计划，不可直接交给 `finance_rebalance_plan` 作为已审计计划。

## 操作员 CLI

```bash
pnpm quant:research --workspace alpha import /absolute/path/dataset.json
pnpm quant:research --workspace alpha run --case CASE_ID --revision REVISION --dataset-id DATASET_ID --spec /absolute/path/spec.json
pnpm quant:research --workspace alpha get RUN_ID --case CASE_ID --section fills --offset 0 --limit 50
pnpm quant:research --workspace alpha list
```

`CASE_ID/REVISION/DATASET_ID/RUN_ID` 使用前一步实际返回值。导入默认创建 topic research case；向已有 case 导入时指定 `--case` 和当前 `--revision`。

失败/中断在 case 中留证据。恢复用相同数据和 spec，加 `--resume` 并提供当前 revision；不重新定义测试窗口或重选参数。重复已完成请求复用结果。进程崩溃遗留锁须先核对持有进程，不能自动删除锁后重跑。

状态统一位于 `.runtime/finance-data/research/<workspace>/<case>/`，数据、分区结果、ModelRun 和运行 manifest 均由 workspace 管理。内容身份 hash 与 artifact 字节 hash 分开校验；临时 Python 传输目录不是第二个研究台账。

## 因子家族与冻结评估

```bash
pnpm quant:research factor-catalog
pnpm quant:research --workspace alpha factor-register --case CASE_ID --revision REVISION --request /absolute/path/factors.json
pnpm quant:research --workspace alpha factor-derive --case CASE_ID --revision REVISION --request /absolute/path/family.json
pnpm quant:research --workspace alpha factor-get RUN_ID --case CASE_ID --section definitions --limit 32
pnpm quant:research --workspace alpha factor-evaluate --case CASE_ID --revision REVISION --dataset-id DATASET_ID --registration /absolute/path/evaluation.json --stage development
pnpm quant:research --workspace alpha factor-compare --case CASE_ID --evaluation-id EVALUATION_ID --limit 50
pnpm quant:research --workspace alpha factor-explain --case CASE_ID --revision REVISION --evaluation-id EVALUATION_ID --request /absolute/path/explanation.json
pnpm quant:research --workspace alpha factor-evaluate --case CASE_ID --revision REVISION --dataset-id DATASET_ID --registration /absolute/path/evaluation.json --stage test
```

每次写入后更新 revision。`factor-derive` 的固定试点请求：

```json
{"generator":"reversal-volume-v1","hypothesis":"成交量异常时短期下跌的修复是否不同","budget":17}
```

生成 3 个反转、2 个量能对照与 12 个交互表达式；也支持 `mutations-v1` 的 window/aggregate/input/neutralize/interaction。重复提案计入预算，结果保留表达式 hash、版本、父子血缘和重复映射。

`EvaluationRegistration` 要求 hypothesis、完整 factors、train/validation/test；可登记 horizons、候选预算、覆盖阈值、最少 IC 日数、训练方向规则、验证阈值、去重阈值及最终选择数。默认最多 32 个提案，可显式登记至 128；输出仍受 200 万单元上限限制。指标是描述性诊断，未实现 HAC/FDR 显著性、交易净增量或市场状态自动搜索。`styleControls` 必须事前登记 controls/weighting/horizon/maximumCondition；风格解释仅限原定义和登记的开发区间。

`factor-compare --evaluation-id` 返回候选选择理由和分 horizon 指标，development/test 分行标记；省略 ID 返回已有结果索引。`factor-get --section` 支持 `/` 路径，例如 `train/5/momentum_5/daily`；数组或对象条目按 offset/limit 分页。

共享测试窗权威事件在 `<runtimeRoot>/research-domains/quant-v3`，使用锁和 hash 链。证券与日期重叠检查跨 case、workspace、快照生效；旧实验登记会从同一 runtime 下的 workspace 回填为已观察区间。消费在计算前落盘，失败不恢复 unseen。更换 runtime 数据根意味着不同受控研究域，操作员须一并迁移历史记录。删除权威记录不属于受支持的“重置”操作。

无效 stage 和缺少开发选择的测试请求在预约前拒绝。已登记计算失败则追加 `quant-factor-attempt-failed` 决策，保留错误原因、requestHash 和 attempt 引用；恢复必须保持原输入并显式 `--resume`。

需要将因子评估衔接到回放时，先在评估注册中写入 v3 `experimentSpec`：trainingStartDate 位于 train 内、执行区间位于 test 内且留出最后成交日。开发阶段后，只能以完全相同的 spec 和已入选因子运行：

```bash
pnpm quant:research --workspace alpha run --case CASE_ID --revision REVISION --dataset-id DATASET_ID --evaluation-id EVALUATION_ID --spec /absolute/path/registered-spec.json
pnpm quant:research --workspace alpha attribute RUN_ID --case CASE_ID --kind model --section rows --limit 50
pnpm quant:research --workspace alpha attribute RUN_ID --case CASE_ID --kind returns --section daily --limit 20
pnpm quant:research --workspace alpha attribute RUN_ID --case CASE_ID --kind risk --section rows --limit 20
```

`attribute` 只读已登记实验的不可变产物；省略 section 返回摘要。Ridge 使用 rows，分组敏感性使用 groupDiagnostics；收益使用 daily；风险使用 rows。收益逐日独立计算期初持仓、实际成交价、费用、基准复制差异，country 独列；滑点只计一次。specific 输入先逐股核对，现金通过明确重分类展示，超容差保持 unreconciled 并阻断 Carino 连接。Brinson-Fachler 是期初静态持仓的独立视角，不与风格贡献重复求和。

风险归因复用 `portfolio-risk` 公式，以账户 NAV 为分母保留现金，分别计算绝对/主动权重；要求同日且来源合格的 CNE6 快照，满足 `closeAt <= availableAt <= decisionAt`。无合格快照或基准权重时对应项 blocked。原生数据仍不支持公司行动面板；底层账本的 v3 归因已覆盖既有拆股和分红应收规则。

## Agent 入口

仅 `strategy-research` preset 暴露 `finance_quant_research`：

```json
{"action":"catalog"}
{"action":"schema"}
{"action":"list","workspace_id":"demo"}
```

`import` 接受 `workspace_id/dataset`，返回 case 和 revision。`run` 要求 `workspace_id/case_id/expected_revision/dataset_id/spec`；恢复还需 `resume: true`。`get` 要求 `workspace_id/case_id/run_id`，可指定 `section/offset/limit`。

可查询 summary、spec、models、predictions、factors、diagnostics、factorSummary、correlations、modelDiagnostics、equity、orders、fills、decisions、benchmark。列表分页 limit 为 1–200。

新 action 沿用同一工具：factor-register/derive/explain 用 request，factor-evaluate 用 registration/stage，factor-compare 用 evaluation_id，attribute 用 run_id/kind/section；写操作都要求当前 expected_revision。

Agent 不可提供文件路径、源码、网络地址或模型文件。单次 Agent 输入输出上限 8 MiB；较大数据通过操作员 CLI 导入，计算传输/单 artifact 上限 128 MiB。最多 64 种外部特征，预估因子工作集上限 1600 万数值单元，分组扰动最多 20 万行。计算子进程超时 120 秒，超时或取消终止进程组；恢复按冻结任务重算，尚无分区 checkpoint/持久面板缓存。

## 验证与明确限制

个人从零操作、查看各阶段结果和验收标准见 [因子完整流程验收指南](quant-factor-testing.md)。已安装依赖并构建后，一条命令运行实际 CLI 全流程：

```bash
node scripts/quant-factor-smoke.mjs
```

```bash
pnpm test:quant-research
pnpm exec vitest run tests/quant-research-workflow.test.ts tests/quant-workflow-integration.test.ts tests/strategy-tools.test.ts tests/composition.test.ts
pnpm check
pnpm dependency:audit
```

来源真实性、历史行业/成员、完整公司行动、真实 CNE6 截面质量、全市场容量和前向收益并未因为原生链路可运行而验收。共享 holdout 治理只记录受控研究域中的研究动作，不能证明外部人员此前未见数据。无券商连接、实盘下单、自动超参搜索或自动晋级。

合并步骤、来源提交及逐包证据见 [合并计划](native-quant-research-merge-plan.md)；真实数据门禁见 [A2 记录](equity-data-a2-sample-acceptance.md)。
