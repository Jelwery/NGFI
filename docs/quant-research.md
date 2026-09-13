# NGFI 原生量化研究

原生研究在现有 `packages/combinatorial-optimization` 中提供 PIT 面板、版本化因子图、Ridge/HGB 滚动模型、mean-variance/top-k 目标和逐日回放。它与 A3 共用风险校验、整手诊断和成交账本，与其他研究共用 ResearchWorkspace；不需要独立 quant-research package 或 LocalQuant 服务。

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

`schema` 返回权威 JSON Schema，源码为 `ngfi_quant/research_contracts.py`。当前 schemaVersion 为 `"2"`；旧版字段不静默兼容。

- 数据声明 `snapshotId/asOf/provenance/synthetic`、`priceBasis: raw-no-corporate-actions`、`universePolicy`。
- 交易日具有 `date/openAt/closeAt/decisionAt`，按上海业务日期解释，决策必须早于下一交易日开盘。
- 行情为完整证券×日历密集面板，包含证券身份、OHLC/previousClose、volume/amount、eligible/industry，以及必填的 suspended、limitRate、lotSize、statusAvailableAt。不猜测未知交易规则或历史成员。
- 外部特征逐条保存 `value/availableAt/sourceHash`；不可见值保持缺失，不填成 0。
- 研究规格必须明确 `risk.source: cne6 | ledoit-wolf`；用途仅 `research-diagnostic`。CNE6 不可用不回退 Ledoit–Wolf。
- CNE6 保留来源/descriptor/覆盖等质量信息，按 policy 校验，发布时间不能早于最后模型日收盘。
- 最高 500 证券、200,000 条 bars、32 因子、每图 64 节点、算子窗口 1,000、因子面板 200 万单元；不是性能保证，也不是 A2 全市场验收。

12 个模板、17 个固定算子由 catalog 查询；拒绝源码、动态算子、循环依赖和负时间偏移。MAD 去极值与旧分位数方法有明确区别。滚动标签使用交易日历上的 `open(t+1+h)/open(t+1)-1`，训练只使用成熟且可见的标签，裁剪/标准化仅在训练集拟合，HGB 不加载 pickle。

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

## Agent 入口

仅 `strategy-research` preset 暴露 `finance_quant_research`：

```json
{"action":"catalog"}
{"action":"schema"}
{"action":"list","workspace_id":"demo"}
```

`import` 接受 `workspace_id/dataset`，返回 case 和 revision。`run` 要求 `workspace_id/case_id/expected_revision/dataset_id/spec`；恢复还需 `resume: true`。`get` 要求 `workspace_id/case_id/run_id`，可指定 `section/offset/limit`。

可查询 summary、spec、models、predictions、factors、diagnostics、factorSummary、correlations、modelDiagnostics、equity、orders、fills、decisions、benchmark。列表分页 limit 为 1–200。

Agent 不可提供文件路径、源码、网络地址或模型文件。单次 Agent 输入输出上限 8 MiB；较大数据通过操作员 CLI 导入，计算传输/单 artifact 上限 128 MiB。计算子进程超时 120 秒，超时或取消终止进程组；这不是大规模异步任务队列。

## 验证与明确限制

```bash
pnpm test:quant-research
pnpm exec vitest run tests/quant-research-workflow.test.ts tests/quant-workflow-integration.test.ts tests/strategy-tools.test.ts tests/composition.test.ts
pnpm check
pnpm dependency:audit
```

来源真实性、历史行业/成员、完整公司行动、跨候选 holdout 治理、全市场容量和前向收益并未因为原生链路可运行而验收。无券商连接、实盘下单、自动超参搜索或自动晋级。

合并步骤、来源提交及逐包证据见 [合并计划](native-quant-research-merge-plan.md)；真实数据门禁见 [A2 记录](equity-data-a2-sample-acceptance.md)。
