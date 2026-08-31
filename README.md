# NGFI

NGFI 是一个基于 [DeepSeek Harness（DSH）](https://www.npmjs.com/package/@deepseek-ai/dsh) 构建的金融研究 Agent。项目已经组合好 DSH 的 agent loop、Web UI、headless runner、金融工具和分析 Skills；配置一个受支持模型的 API Key 后即可运行。

它目前提供：

- 股票资料、行情、财务数据、分析师预期和可比公司数据查询
- WACC、DCF、敏感性分析和相对估值
- 投资行为诊断与交易记录审计
- 可按需加载的金融分析 Skills
- 独立的 CNE6 风格 A 股风险模型与数据构建 CLI
- DSH Web 与一次性 headless 两种运行方式

## 快速开始

环境要求：Node.js 22.19+、pnpm 11、Python 3.12+ 和 [uv](https://docs.astral.sh/uv/)。

```bash
git clone https://github.com/Jelwery/NGFI.git
cd NGFI
cp .env.example .env
```

编辑 `.env`，至少填入默认 DeepSeek provider 的 Key：

```dotenv
NGFI_LLM_PROVIDER=deepseek-official
NGFI_LLM_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=your-api-key
```

安装依赖：

```bash
pnpm install
uv sync
```

直接执行一次金融分析：

```bash
pnpm ask -- "使用 ticker-snapshot 分析 AAPL，并明确数据的观察时间。"
```

或启动 DSH Web UI：

```bash
pnpm web
```

默认只监听 `127.0.0.1:3180`。可在 `.env` 中用 `FINANCE2DSH_PORT` 修改端口；为避免与 DSH 默认 profile 冲突，3080 和 3090 不可用。

## 模型配置

运行入口会读取项目根目录的 `.env`，已有的进程环境变量优先。Key 只通过环境变量传给 DSH，不会写入生成的配置文件；`.env`、运行状态和本地数据均已加入 `.gitignore`。

| Provider | `NGFI_LLM_PROVIDER` | Key 环境变量 | 默认模型 |
|---|---|---|---|
| DeepSeek 原生 DSH adapter | `deepseek-official` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| OpenAI-compatible endpoint | `openai-compatible` | `NGFI_API_KEY` | 必须设置 `NGFI_LLM_MODEL` |

OpenAI-compatible endpoint 还必须配置 `NGFI_LLM_BASE_URL`。协议默认是 `openai-completions`，可通过 `NGFI_LLM_API` 修改；上下文窗口和最大输出 token 可分别通过 `NGFI_CONTEXT_WINDOW` 与 `NGFI_MAX_TOKENS` 设置。完整模板见 [`.env.example`](.env.example)。

如需使用 DeepSeek-compatible gateway，可在保留 `deepseek-official` provider 的同时设置 `DEEPSEEK_BASE_URL`。

## DSH 组合方式

项目不修改 DSH core，而是在仓库内组装两个 profile：

- `finance-headless`：一次性运行任务并返回最终结果
- `finance-dev`：启动 DSH Web UI

两者都挂载 `finance-analyst` preset、项目 Skills 和同一组金融工具，并使用只读 sandbox。运行时 materialize 到仓库内的 `.runtime/`，不会读写用户的全局 DSH home。

主要目录：

```text
src/                                  DSH 启动、环境配置与 E2E 入口
profiles/                             headless 和 Web profile
packages/dsh-finance-bundle/          DSH finance composition 与 runner
packages/dsh-finance-tools/           DSH 金融工具
packages/finance-core/                数据契约与确定性金融计算
packages/finance-provider-yfinance/   yfinance 数据适配器
generated/agent-presets/              finance-analyst preset
skills/                               金融研究与行为诊断 Skills
evals/                                可复用评测用例与 rubric
packages/combinatorial-optimization/  CNE6 风险模型
```

## 验证与测试

完整的离线检查：

```bash
pnpm check
```

它会构建并检查 TypeScript packages、运行稳定测试和 CNE6 离线测试，并验证两个 DSH profile 可以正确组合。

以下测试会访问真实服务：

```bash
pnpm test:e2e:model     # 需要已配置的模型 Key
pnpm test:e2e:web       # 启动并探测本地 Web profile
pnpm test:live:yfinance
pnpm test:live:cne6
```

## CNE6 数据构建

```bash
pnpm cne6:data:probe
pnpm cne6:data:smoke --start-date 2026-07-01 --end-date 2026-08-29 \
  --years 2024 --symbols 600519 000001 --workers 1 --request-delay 1.5
pnpm cne6:data:validate --symbols 600519 000001
```

本地行情与财务数据保存在 `packages/combinatorial-optimization/data/`，不会提交到 Git。请遵守对应数据源的服务条款和访问频率限制。

## 安全说明

- 不要提交 `.env`、API Key、token、私钥或本地凭据文件。
- `.env.example` 只有占位符，可以安全复制后在本地填写。
- DSH 运行目录、session、评测输出和下载的数据均保持本地。
- 外部金融数据可能延迟、不完整或发生字段变化；项目会尽量保留来源、观察时间、期间、币种和缺失状态。

## 免责声明

本项目仅用于研究与工程实践，不构成投资建议。在用于实际决策前，请独立核验数据、模型假设与计算结果。
