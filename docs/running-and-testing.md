# NGFI 运行与测试

## 环境与安全边界

- Node.js 22.19+、pnpm 11、Python 3.12+、uv。
- DSH 状态固定在仓库内 `.runtime/`；不读写用户全局 DSH home。
- 人工维护的 preset 位于 `config/agent-presets/`；`pnpm preset:generate` 确定性复制到 `generated/agent-presets/`，`pnpm preset:check` 检测 drift。
- 默认 sandbox 为只读，Agent 仅能调用 preset 显式 allowlist 中的工具。
- shell、任意 URL、raw provider/MCP、订单和实盘交易均不在 finance Agent surface。
- 默认门禁离线运行，不请求模型或真实 provider。
- A 股 60 项能力只经 8 个 curated tools 和 `feature-registry.json` 的闭合 feature/dataset/variant 映射调用；不接受任意 callable、URL、header、Cookie、Python、shell 或 SQL。
- public-web 适配器固定 host/operation，禁重定向并限制超时、响应体、并发和重试。403、429、验证码、登录页、异常空响应与 schema drift 都 fail closed。

## 安装与总门禁

```bash
pnpm install --frozen-lockfile
uv sync --frozen
uv sync --project packages/combinatorial-optimization --extra dev --frozen
uv sync --project packages/finance-data-service/providers/tdx --frozen
pnpm check
```

`pnpm check` 顺序执行：

1. capability manifest、依赖边界、preset drift、上游完整性、许可证和安全扫描；
2. 所有 TypeScript package build/typecheck 和离线 Vitest；
3. `combinatorial-optimization/ngfi_quant` 组合/验证测试和 CNE6 offline suite（warning-as-error）；
4. canonical Skills V2 contracts 与 company selftest；
5. DSH runtime prepare、headless dump 和 Web dump；
6. Git tracked/untracked 状态漂移检测。

可单独运行：

```bash
pnpm check:static
pnpm test:ts
pnpm test:python
pnpm test:cne6
pnpm test:skills
pnpm test:runtime
```

## Skills

唯一运行入口是 `skills/`。当前 canonical Skills、V2 合并规则和离线 CLI 边界见根目录 `SKILLS_V2.md` 与 `skills/migration-manifest.json`。财务 Python helper 已归入 `packages/finance-core/python/`，取数由 `finance-data-service` 管理；它们与 `macro-cycle-policy-analysis` 的 PDF helper 都不会因为 Skill 被发现而获得执行权限。

## Presets

默认 preset 仍是 `finance-analyst`。设置 `NGFI_AGENT_PRESET` 为 `company-research`、`strategy-research` 或 `portfolio-risk` 可在 headless/Web profile 中选择职责隔离的治理 preset；其他值会在 runtime prepare 时拒绝。所有 preset 共享现有 20 个基础金融工具，但只增加职责所需的 research、strategy/signal 或 portfolio tools。

## 测试责任

| 层级 | 位置 | 默认门禁 |
|---|---|---|
| package 单元/契约 | 各 `packages/*` 的源码与根 `tests/*-contracts.test.ts` / 领域测试 | `pnpm test:ts` |
| 跨包契约 | `tests/` 中 data reconciliation、research audit、TS/Python bridge | `pnpm test:ts` |
| runtime/composition | `tests/composition.test.ts`、`tests/isolation.test.ts`、`tests/*adapter.test.ts` | `pnpm test:ts`、`pnpm test:runtime` |
| immutable eval fixtures | `evals/` 与 package 内固定 fixture | 对应 contract test |
| live tests | `tests/*.live.test.ts`、CNE6 live marker | 仅显式 `test:live:*` |
| A 股 60 项 feature matrix | `tests/a-stock-feature-matrix.test.ts` 与 `tests/fixtures/a-stock-data/features.json` | `pnpm test:ts`；逐项覆盖成功、合法 no-data、schema drift、参数上限、provenance、单位和 truncated |

`packages/combinatorial-optimization` 作为现有兼容入口保留；本阶段不做目录改名，避免同时破坏 Python project、CLI、文档和测试引用。其环境、cache、egg-info 和本地数据均位于被忽略且可重建的位置。

## 可选 live 检查

以下命令不属于默认 CI；缺少凭据、授权、网络或数据资产时应报告未运行，不能伪造通过：

```bash
pnpm test:live:yfinance
pnpm test:e2e:model
pnpm test:e2e:web
pnpm test:live:cne6
```

### A 股统一低频 probe

```bash
# 单 feature
pnpm data:astock:live -- --feature quote.tencent

# 分组：identity | market | research | activity | macro-index
pnpm data:astock:live -- --group macro-index

# 全部 60 项；必须显式确认低频顺序执行
pnpm data:astock:live -- --all --low-frequency
```

probe 按 source rate group 顺序执行；每个 capability 的全部 variant 都会尝试。输出状态只有 `pass`、`no-data`、`blocked-auth`、`unavailable-network`、`rate-limited`、`schema-drift`、`upstream-error`。59 个零 Key feature 会真实进入受控 provider；`disclosures.iwencai-semantic` 在未配置 `IWENCAI_API_KEY` 时返回 expected `blocked-auth` 且 `attempted: false`，配置后才发起受控请求。任何临时网络或上游错误都保留真实状态，不能改写为 pass。

结构化结果写入 `.runtime/a-stock-live-matrix.json`，文件模式为 `0600`，不包含响应正文、Cookie 或 credential。BSE 匿名 Cookie 只存在于探针进程内；BaoStock 使用匿名 client session。全量 probe 不是压力测试，默认每个 variant 只请求最小记录数。

如果需要从专用 secret 文件运行带 Key 的 iWenCai probe，先确认文件被 Git 忽略且权限为 `0600`，再在不回显内容的子 shell 中加载：

```bash
(
  test "$(stat -f %Lp .runtime/secrets/a-share-data.env)" = 600
  set -a
  . ./.runtime/secrets/a-share-data.env
  set +a
  pnpm data:astock:live -- --feature disclosures.iwencai-semantic
)
```

不要用此命令读取或打印 secret 文件内容。除 iWenCai 外的 59 项不需要用户 credential；TDX official、iFinD 和 TuShare 是可选增强源，不是 60 项公开能力的前置条件。

真实模型凭据仅从进程环境或被 Git 忽略的仓库根 `.env` 读取，绝不写入 generated preset、profile、日志或 `.runtime/settings.yaml`。

### 固定上游与同步

当前 `a-stock-data` 固定为稳定 tag `v3.8.0`、tag object `9f995e66ee792255e492a15627f98615627041c6`、peeled commit `2012ce7cd0e75d379c5e6cbd3115514f300f3bc8`。

```bash
pnpm data:upstream:check
pnpm data:upstream:test
pnpm data:upstream:report
pnpm data:upstream:sync -- --version v3.8.0
```

`check`/`test` 离线校验 snapshot、generated code、source/capability manifest 与 feature registry；`report` 生成 deterministic diff。`sync` 只接受完整稳定 semver tag，并把 tag object、peeled commit、tree 和文件 hash 写入 lock。候选更新必须进入人工审核 PR，不自动 merge/deploy；禁止跟随浮动 `main`，禁止运行时执行远端 Markdown，也禁止手改 upstream snapshot 或 generated 文件。

## 整合后的组合研究契约

- workspace package 20→14，公开 Skill 15→11。provider 实现在 `finance-data-service/src/providers/`，Python/上游资产在同包 `providers/`；来源身份与权限不合并，registry/router 仍不依赖具体 provider。
- `company-research` 是完整研究入口，`financial-analysis` 保留行业/三表/风险方法，`equity-valuation` 渐进加载 DCF、相对估值和 consensus。Python 估值仅生成显式现金流情景，折现与敏感性调用唯一的 finance-core 实现。
- `combinatorial-optimization` 同时安装 `cne6_engine` 和 `ngfi_quant`。先运行 `uv sync --project packages/combinatorial-optimization --extra dev --frozen`；工具运行时 `--offline --no-sync`，不安装包、不联网。
- CNE6 每个 descriptor 输出 `quality_flag`、有效计数/原始分母、raw coverage、填补 mask、祖先字段原因；snapshot 保留 source/descriptor/data quality。模型实际可得时间由发布者提供 `build_portfolio_risk_snapshot(..., available_at=...)`，缺失时优化器拒绝，不能用报告日期冒充可得时间。
- `finance_portfolio_optimize` 需要已确认持仓 hash、portfolio research case、revision、注册的 mandate artifact 和有证据引用的评分。输入范例可见 `packages/combinatorial-optimization/quant_tests/test_optimizer.py:example_input`，工具调用范例见 `tests/portfolio-tools.test.ts`。原始评分经平均并列 rank 映射 [-1,1]，不是收益率预测。
- mandate 固定权重/现金界、行业/风格主动暴露带、L1/2 换手、ADV 参与率及质量门槛；本版全部是硬约束，`relaxations=[]`。OSQP 后做100股增量整手修复并重验约束；保留已有零股，不保证整数全局最优，不能满足则拒绝。shadow prices 仅解释连续解。
- `finance_rebalance_plan` 只读已登记的成功 OptimizationRun，核对持仓不变，不重新求解；只生成 dry-run 草案，没有下单路径。
- `finance_strategy_backtest(tier=research)` 支持明确执行日的 target schedules（执行开盘前已知）、原始价、滞后 ADV、T+1、成本/滑点、停牌/方向性涨跌停、现金、送转与分红应收/到账日。历史费率由 `costModel` 与按生效日排序的 `costSchedule` 确定，日台账记录实际费率 hash，不能以当前费率冒充历史。payDate 缺失的同日分红结算显式标记 proxy/partial。
- 基准需要实际 CSI300/CSI800 序列，归因还需要对应 PIT 权重/暴露/因子收益；缺失返回 partial，不下载实时数据补历史。行业/风格/选股残差、现金、成本及交易时点残差逐日与累计核对；第一日基准在首个收盘点归一，初始建仓损益单列。`benchmarkConvention` 显式区分 price/total-return（默认 price 并记入台账），选股残差不等于纯选股能力。
- `tier=walk-forward` 预登记候选权重/阈值、数据/代码版本、种子、purge/标签期限与不重叠测试窗。训练选候选，测试一次；相同请求返回已登记结果，修改参数是新实验。回报输入应来自冻结含成本回测，协议不会证明调用方提供的收益血缘。
- 大型输入可先登记 JSON artifact；当前计算桥输入/输出上限8MiB，应选择有界股票池或因子式协方差。CNE6 真数据全市场覆盖和实时源没有随离线测试自动验收。

## A0/A1 数据契约验收

冻结配置为 `config/equity-data-acceptance.json`，执行证据与阻断项见 `docs/equity-data-a0-a1-acceptance.md`。`cne6_engine.data_sources.cli acceptance` 只做来源盘点及候选结构/完整性/时间校验，不发布数据、不切换 CURRENT、不把 schema pass 当作 A2 数据通过。可加 `--candidate /absolute/path` 校验 manifest + JSONL，或 `--output .runtime/新文件名.json` 保留盘点；已有输出不覆盖。

`node scripts/freeze-equity-baseline.mjs equity-a0-a1 --check` 在完整 `pnpm check` 通过且源码未变化后，创建本地内容寻址版本，包含未跟踪源码、差异、锁文件、运行环境和检查日志；不会 commit/push。A2 样本采集必须先解除来源矩阵中的历史主表、PIT 和授权阻断项。

## A2 真实样本构建

`node --env-file=.runtime/secrets/tushare.env --import tsx scripts/acquire-equity-sample.ts bootstrap` 使用既有 TuShare MCP client 构建候选主表/日历；随后 `select` 固定24只样本，`sample <group>` 和 `repair <partition>` 分批构建。每批最多30请求、单worker、明确停止条件；完整缓存重放无需凭据和网络。凭据文件必须被Git忽略且权限0600。

`cne6_engine.data_sources.cli sample --output .runtime/equity-data/a2/新目录` 从固定原始分区生成诊断Parquet和验收报告，不写CURRENT。详见 `docs/equity-data-a2-sample-acceptance.md`；样本可复算及行情覆盖通过不等于全市场PIT或策略准入。A0/A1原始缺口矩阵作为历史契约保留，实际新增数据证据以A2报告为准。

## 当前基线

治理开始前（2026-09-07）在 `afd0748` 上实测：4 个 TypeScript packages build/typecheck 通过，11 个 Vitest files / 52 tests 通过，CNE6 129 passed / 2 skipped，runtime prepare 与两套 profile dump 通过。各阶段的最新计数以 CI 输出与 `docs/capabilities/status.md` 为准，不用历史数字冒充当前状态。
