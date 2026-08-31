# NGFI

NGFI 是一个面向金融研究与量化分析的工具集，提供可审计的估值计算、结构化市场数据适配、投资行为诊断，以及 CNE6 风格的 A 股风险模型。

## 主要能力

- 金融计算核心：WACC、DCF、DCF 敏感性分析和相对估值。
- 数据契约：统一表示证券资料、财务数据、行情、分析师预期与可比公司数据，并显式保留缺失值和观察时间。
- 市场数据适配：通过隔离的 Python 进程读取 yfinance 数据。
- 投资行为分析：结合市场路径证据、交易记录审计和渐进式理论参考，区分事实、候选机制与竞争解释。
- CNE6 风险引擎：计算风格暴露、因子收益、因子协方差、特质风险及股票协方差矩阵。
- Agent 工具适配：将通用金融能力封装为类型明确的工具接口。

## 项目结构

```text
packages/finance-core/                 金融数据契约与确定性计算
packages/finance-provider-yfinance/    yfinance 数据适配器
packages/dsh-finance-tools/            金融工具接口
packages/combinatorial-optimization/   CNE6 风险模型与数据构建 CLI
skills/                                金融分析与投资行为诊断技能
tests/                                 TypeScript 稳定测试
```

## 环境要求

- Node.js 22.19 或更高版本
- pnpm 11
- Python 3.12 或更高版本
- [uv](https://docs.astral.sh/uv/)

## 安装与验证

```bash
pnpm install
uv sync
pnpm check
```

`pnpm check` 会构建并检查 TypeScript packages，运行稳定单元测试，并运行 CNE6 的离线测试。

如需单独运行各测试集：

```bash
pnpm test
pnpm test:cne6
```

真实数据测试默认关闭，因为它们依赖外部数据源及其可用性：

```bash
pnpm test:live:yfinance
pnpm test:live:cne6
```

## CNE6 数据构建

以下命令用于探测上游字段、执行隔离的小样本构建和校验本地数据资产：

```bash
pnpm cne6:data:probe
pnpm cne6:data:smoke --start-date 2026-07-01 --end-date 2026-08-29 \
  --years 2024 --symbols 600519 000001 --workers 1 --request-delay 1.5
pnpm cne6:data:validate --symbols 600519 000001
```

行情与财务数据资产保存在 `packages/combinatorial-optimization/data/`，不会提交到 Git。数据获取应遵守对应数据源的服务条款和访问频率限制。

## 设计原则

- 缺失值保持为缺失，不静默填充为零。
- 所有外部数据携带来源、观察时间、期间和单位信息。
- 估值计算返回完整的输入与结果桥接，便于复核。
- 行为金融机制只作为待验证解释，同时报告竞争解释和证据边界。
- 真实网络测试与稳定的离线回归测试分离。

## 免责声明

本项目仅用于研究与工程实践，不构成投资建议。第三方行情和财务数据可能延迟、不完整或发生字段变化；在用于实际决策前，请独立核验数据、模型假设与计算结果。
