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
uv sync --project packages/quant-research --frozen
uv sync --project packages/combinatorial-optimization --frozen --extra dev
pnpm check
```

`pnpm check` 顺序执行：

1. capability manifest、依赖边界、preset drift、上游完整性、许可证和安全扫描；
2. 所有 TypeScript package build/typecheck 和离线 Vitest；
3. quant-research Python tests（存在该 package 时）和 CNE6 offline suite；
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

量化研究端到端验证不需要模型凭据或真实行情：

```bash
pnpm quant:demo
pnpm test:quant-research
pnpm exec vitest run tests/quant-workflow-integration.test.ts
```

`quant:demo` 运行显式合成数据；DSH 集成测试通过真实 uv/Python 子进程完成 import/run/get/list，并验证工作区隔离。必须先同步量化 Python 环境且将 uv 加入 PATH；不会自动安装 LocalQuant 或请求外部数据。数据契约、训练边界、组合约束和成交语义见 [量化研究指南](quant-research.md)。

许可证基线更新还需要 TDX 的冻结环境：

```bash
uv sync --project packages/finance-provider-tdx --frozen
pnpm dependency:licenses:update
pnpm dependency:licenses:check
```

只在依赖实际变化且审阅许可证后更新基线；普通 `check` 不要求全部 Python 环境已安装。

## Skills

唯一运行入口是 `skills/`。当前 canonical Skills、V2 合并规则和离线 CLI 边界见根目录 `SKILLS_V2.md` 与 `skills/migration-manifest.json`。`company-financial-analysis` 中的 Python 脚本以及 `macro-cycle-policy-analysis` 的 PDF helper 不会因为 Skill 被发现而获得执行权限。

## Presets

默认 preset 仍是 `finance-analyst`。设置 `NGFI_AGENT_PRESET` 为 `company-research`、`strategy-research` 或 `portfolio-risk` 可在 headless/Web profile 中选择职责隔离的治理 preset；其他值会在 runtime prepare 时拒绝。所有 preset 共享现有 20 个基础金融工具，但只增加职责所需的 research、strategy/signal 或 portfolio tools。

`finance_quant_research` 仅增加到 `strategy-research`。它接收原生 JSON 规格或数据/实验 ID，不接受路径、源码、任意模型文件或网络地址。大数据通过可信操作员 CLI 导入，Agent 按 ID 调用；计算超时和 `partial` 结果必须如实披露。

## 测试责任

| 层级 | 位置 | 默认门禁 |
|---|---|---|
| package 单元/契约 | 各 `packages/*` 的源码与根 `tests/*-contracts.test.ts` / 领域测试 | `pnpm test:ts` |
| 跨包契约 | `tests/` 中 data reconciliation、research audit、TS/Python bridge | `pnpm test:ts` |
| 原生量化闭环 | `packages/quant-research/tests/`、`tests/quant-workflow-integration.test.ts` | `pnpm test:python`、`pnpm test:ts` |
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

## 当前基线

治理开始前（2026-09-07）在 `afd0748` 上实测：4 个 TypeScript packages build/typecheck 通过，11 个 Vitest files / 52 tests 通过，CNE6 129 passed / 2 skipped，runtime prepare 与两套 profile dump 通过。各阶段的最新计数以 CI 输出与 `docs/capabilities/status.md` 为准，不用历史数字冒充当前状态。
