# NGFI

NGFI 是一个基于 [DeepSeek Harness（DSH）](https://www.npmjs.com/package/@deepseek-ai/dsh) 构建的全球股票与中国 A 股研究 Agent。项目已经组合好 DSH 的 agent loop、Web UI、headless runner、结构化金融工具和分析 Skills；配置一个受支持模型的 API Key 后即可运行。

它目前提供：

- 全球股票的证券资料、行情、财务数据、分析师预期和可比公司数据查询
- A 股证券代码规范化，以及行情、财务、公告、指数和交易日历数据的统一查询入口；另有长尾 capability 的受控稳定 surface（当前没有默认 routable provider，不代表已实现数据能力）
- WACC、DCF、敏感性分析和相对估值
- 投资行为诊断与交易记录审计
- 可按需加载的金融分析 Skills
- 受控 research workspace、冻结 replay、报告 audit、thesis drift 与隔离式对抗审阅
- 固定策略/指标、smoke 与 research backtest、信号 outcome/calibration 证据链
- staged-confirmed 持仓和 CNE6 portfolio/marginal/scenario risk
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

也可以查询 A 股；涉及证券时 Agent 会先规范化代码，再调用下游数据工具：

```bash
pnpm ask -- "分析 600519.SH 最近四个报告期的经营变化，严格按当时可见数据并列出来源。"
```

或启动 DSH Web UI：

```bash
pnpm web
```

默认只监听 `127.0.0.1:3180`。可在 `.env` 中用 `FINANCE2DSH_PORT` 修改端口；为避免与 DSH 默认 profile 冲突，3080 和 3090 不可用。

默认使用兼容的 `finance-analyst` preset。可通过 `NGFI_AGENT_PRESET=company-research`、`strategy-research` 或 `portfolio-risk` 选择职责隔离的治理 preset；每个 preset 继承原有 20 个金融工具，只增加本职责所需的受控工具。

## 模型配置

运行入口会读取项目根目录的 `.env`，已有的进程环境变量优先。模型 Key 只通过环境变量传给 DSH，不会写入生成的配置文件；`.env`、运行状态和本地数据均已加入 `.gitignore`。A 股 provider 凭据应与项目 `.env` 分开存放，见下文“凭据隔离”。

| Provider | `NGFI_LLM_PROVIDER` | Key 环境变量 | 默认模型 |
|---|---|---|---|
| DeepSeek 原生 DSH adapter | `deepseek-official` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| OpenAI-compatible endpoint | `openai-compatible` | `NGFI_API_KEY` | 必须设置 `NGFI_LLM_MODEL` |

OpenAI-compatible endpoint 还必须配置 `NGFI_LLM_BASE_URL`。协议默认是 `openai-completions`，可通过 `NGFI_LLM_API` 修改；上下文窗口和最大输出 token 可分别通过 `NGFI_CONTEXT_WINDOW` 与 `NGFI_MAX_TOKENS` 设置。完整模板见 [`.env.example`](.env.example)。

如需使用 DeepSeek-compatible gateway，可在保留 `deepseek-official` provider 的同时设置 `DEEPSEEK_BASE_URL`。

## A 股数据契约

A 股数据只通过以下 8 个 curated tools 暴露给 Agent。它们是稳定、受控的研究入口，不会把任意上游接口直接暴露给模型。

| 工具 | 用途 |
|---|---|
| `finance_data_catalog` | 查询 capability、approved provider、健康状态、鉴权与限制 |
| `finance_cn_instrument` | 将六位证券代码、带交易所前后缀的代码或 canonical identifier 规范化为 canonical instrument |
| `finance_cn_quote` | 当前 quote；指定 `as_of` 时返回由目标日单日未复权 bars 映射的稳定 quote snapshot |
| `finance_cn_bars` | 受控日期范围和复权方式的历史 K 线 |
| `finance_cn_fundamentals` | 财务期间筛选；`corporate-actions` 仅为受控稳定 surface，当前没有默认 routable provider |
| `finance_cn_disclosures` | 公告查询；`research-consensus` 仅为受控稳定 surface，当前没有默认 routable provider |
| `finance_cn_market_activity` | `capital-flow`、`market-signal`、`order-book` 的受控稳定 surface，当前没有默认 routable provider |
| `finance_cn_macro_index` | 指数和交易日历查询；`macro` 仅为受控稳定 surface，当前没有默认 routable provider |

`corporate-actions`、`research-consensus`、`capital-flow`、`market-signal`、`order-book` 和 `macro` 是受控稳定 surface，但当前没有默认 routable provider，不能计作已经实现的数据 capability。只有运行时 catalog 明确返回 capability 映射、`routable: true` 且 health/授权合格时才能取数；当前默认组合会返回 `unsupported`，不能因工具或参数存在就宣称数据可用。

执行规则：

- **Normalize first**：涉及证券时必须先调用 `finance_cn_instrument`，再把同一个 canonical instrument 传给 quote、bars、fundamentals 等下游工具。该工具只接受六位证券代码、带交易所前后缀的代码（如 `sh600519`、`600519.SH`）或 canonical identifier；当前没有中文证券名称查询。纯宏观或交易日历查询不要求虚构证券身份。
- **受控来源**：`source` 只能是 `auto` 或 `finance_data_catalog` 返回的 approved provider id。工具参数不接受任意 URL、raw MCP 工具名、shell、Python、SQL 或上游函数名。
- **`source: auto` 优先级**：当前注册表只有一套全局静态 priority，不能为每个 capability 单独排序。对共同支持的能力，已配置且可路由的 `tushare-mcp` 优先于 `cne6-local`；CNE6 是本地/PIT fallback。具体而言，`market-bars` 为 TuShare → CNE6 → TDX community → public，`fundamentals` 为 TuShare → CNE6 → public；不支持该 capability、未配置或不可路由的 provider 不进入候选。
- **来源可追溯**：回答保留 `requestedProvider`、`actualProvider`、`upstreamSource`、`sourceKind`、`fetchedAt`，以及适用的观察、发布和可见时间、币种、单位、复权、状态、warnings、limitations 与 fallback chain。
- **历史 quote 语义**：`finance_cn_quote(as_of)` 使用目标自然日的单日 `1d`、`adjustment: none` bars 映射稳定 quote snapshot，并保留实际 bars provenance。它不是历史实时 quote 或历史盘口；休市日不以前一交易日回填。
- **Point-in-time（PIT）安全**：历史 `as_of` 只能使用当时已经可见的数据。交易日、抓取时间、报告期、公告/发布时间和 `availableAt` 不可互换；当前快照不能冒充历史快照。fundamentals 用 `report_period` 或成对的 `start_date`/`end_date` 选择期间，顶层 provenance 必须对应最终所选期间。
- **单页边界**：带 `page` 的工具只接受省略或 `page: 1`；`page > 1` 会被拒绝。单次范围过大时缩窄日期或拆成多个不重叠日期范围查询。
- **缺失不是零**：canonical `no-data` 只表示合格查询完成但没有匹配记录；没有 capability 映射是 canonical `unsupported`，已知 provider 当前不可路由或不健康应保留 catalog/路由的 `unavailable` 诊断，鉴权/权限受阻是 `unauthorized`/`insufficient-permission`。这些状态以及 `missing`、`provider-error`、`stale` 和 `partial` 都不能写成 0。多来源冲突先对齐身份和口径，再并列 provenance，不静默平均。

## A 股 provider 状态

下表描述代码中的能力边界，而不是可用性承诺。运行时状态以 `finance_data_catalog` 的当前结果为准。

| Provider | 类型 | 当前状态与配置 |
|---|---|---|
| `a-stock-public` | `public-web` / 部分官方公开端点 | 已实现且无需凭据；网络和字段稳定性按调用检查，best-effort、无 SLA，未做 live 探测时 catalog 可显示 degraded |
| `tushare-mcp` | TuShare 官方 MCP | 可选；未配置时 dormant，配置 `TUSHARE_MCP_URL` 和/或 `TUSHARE_TOKEN` 后通过握手与工具 inventory 判断实际能力；套餐、接口权限和积分仍可能限制结果 |
| `tdx-official` | TDX 官方/授权服务 | 当前是 dormant 配置边界，尚未完成 live transport 验证；`TDX_DATA_KEY` 不会自动使其变为可用，官方本地客户端还受 Windows 平台限制 |
| `tdx-community` | 社区 TDX-compatible 行情 | 已实现 quote/bars；必须显式配置批准的 `host:port` 列表并通过连通性探测，非官方且无服务保证 |
| `ifind-official` | iFinD 官方/授权 MCP | 当前是 dormant 配置边界；即使配置 endpoint 与 credential，也要等认证 live handshake 验证后才能启用，不会读取浏览器 Cookie 或代替用户登录 |
| `cne6-local` | 本地只读已发布数据 | 已实现且不联网、不需要凭据；仅读取本地发布的 CNE6 artifacts，状态取决于数据是否存在、完整及 PIT 合规，partial 数据会报告 degraded |

全球股票默认数据源 yfinance 和 A 股公开来源一样属于 best-effort 数据源；对生产或交易决策使用前应独立核验。

### 凭据隔离

`.env.example` 只包含占位符。项目根 `.env` 用于模型 provider；A 股 live provider 的秘密值放在 Git 已忽略的 `.runtime/secrets/a-share-data.env`，并限制为当前用户可读：

```bash
umask 077
mkdir -p .runtime/secrets
touch .runtime/secrets/a-share-data.env
chmod 700 .runtime/secrets
chmod 600 .runtime/secrets/a-share-data.env
```

按需复制 [`.env.example`](.env.example) 中对应的 A 股条目并替换占位符；不要把未使用的 provider 凭据放入文件。运行时和 TuShare live smoke 都使用同一个严格 0600 loader，且进程环境中的同名值优先。项目根 `.env` 一旦包含 A 股 secret key 会直接拒绝启动，即使进程环境中已有同名值。TDX/iFinD 命令若要复用专用文件，可在不回显内容的子 shell 中显式加载：

```bash
(
  set -a
  . ./.runtime/secrets/a-share-data.env
  set +a
  NGFI_LIVE_TDX=1 NGFI_LIVE_IFIND=1 pnpm test:live:matrix
)
```

不要提交、粘贴、打印或通过命令行参数传递凭据，也不要把带 token 的 URL 写进日志。安全扫描只报告文件和规则，不打印命中的秘密值。

## DSH 组合方式

项目不修改 DSH core，而是在仓库内组装两个 profile：

- `finance-headless`：一次性运行任务并返回最终结果
- `finance-dev`：启动 DSH Web UI

两者默认挂载 `finance-analyst`，也可通过 `NGFI_AGENT_PRESET` 选择三个治理 preset；项目 Skills、`@finance2dsh/dsh-bundle` 和 20 个基础金融工具保持一致，profile 只改变交互界面/runner。两者都使用只读 sandbox。运行时 materialize 到仓库内的 `.runtime/`，不会读写用户的全局 DSH home。

主要目录：

```text
src/                                  DSH 启动、环境配置与 E2E 入口
profiles/                             headless 和 Web profile
packages/dsh-finance-bundle/          DSH finance composition 与 runner
packages/dsh-finance-tools/           DSH 金融工具
packages/finance-core/                数据契约与确定性金融计算
packages/finance-provider-yfinance/   全球股票 yfinance 数据适配器
packages/finance-data-service/        A 股 provider 注册、路由与 fallback
packages/finance-provider-astock/     固定公开来源 A 股适配器
packages/finance-provider-tushare-mcp/ TuShare MCP 适配器
packages/finance-provider-tdx/        TDX official/community 边界
packages/finance-provider-ifind/      iFinD official 配置边界
packages/finance-provider-cne6/       CNE6 本地只读适配器
config/agent-presets/                 人工维护的四个 preset source of truth
generated/agent-presets/              确定性生成的四个 preset
skills/                               金融研究与行为诊断 Skills
evals/                                可复用评测用例与 rubric
packages/combinatorial-optimization/  CNE6 风险模型
```

## 验证与测试

三套完整的 V2 Skill 已合并到仓库根目录；其设计、契约与独立回归测试说明见 [`SKILLS_V2.md`](SKILLS_V2.md)。

默认测试是离线且可复现的；不会因为存在本地凭据就自动访问外部数据源：

```bash
pnpm check
pnpm dependency:licenses:check
pnpm data:upstream:test
```

`pnpm check` 会构建并检查 TypeScript packages、运行稳定测试和 CNE6 离线测试，并验证两个 DSH profile 可以正确组合。`pnpm data:upstream:test` 仅做静态、离线、无代码执行的 snapshot/生成物/manifest 验证。自动同步会在只读 `prepare` job 中额外运行候选 snapshot 自带的离线 Python suite：依赖先从受信任的默认分支 lock 准备，候选代码随后只在固定 digest、无网络、只读文件系统、非 root 且受资源限制的容器中运行。写权限 job 不执行候选代码；验证通过时只推版本分支并创建人工审阅 PR，绝不自动合并或推送默认分支。验证阻塞时，独立的最小写权限 job 只用枚举原因和 workflow run URL 更新已有版本 PR，或创建带 `blocked-upstream` 标签的 issue，不上传候选内容或原始错误。

`pnpm dependency:licenses:check` 是离线门禁：它从已安装的 pnpm production closure（排除平台可选包）和三份 `uv.lock` 的 production closure 生成确定性包列表，并与 [`docs/dependency-licenses.json`](docs/dependency-licenses.json) 中已审查的许可证基线比较；check 模式不要求 Python `.venv`。`UNKNOWN`、`UNLICENSED`、未经审查的许可证或明显强 copyleft 会失败；sharp 的可选 libvips LGPL runtime 以及缺少标准许可证声明的隔离 pytdx provider 均已记录为人工审查例外。依赖升级后先同步三个 Python 环境并审阅差异，再运行 `pnpm dependency:licenses:update`；只有 update 模式读取已安装的 Python metadata。

高危漏洞检查需要联网，必须与离线 `pnpm check` 分开运行：

```bash
pnpm dependency:audit
```

该命令以 `pnpm audit --prod --audit-level high` 检查 Node production 依赖，并用项目要求的 uv 自带 `uv audit --frozen --no-dev` 检查三份 uv production lock；任何生态的扫描器不可用或查询失败都会返回非零，不能视为通过。

安全扫描可分别覆盖已跟踪文件、整个工作树和暂存区：

```bash
pnpm security:scan:tracked
pnpm security:scan:worktree
pnpm security:scan:staged
```

以下命令会访问真实服务或检查一个明确的 live 阻塞条件，必须显式运行；它们可能受网络、地域、频率、套餐、积分或账号权限影响。`test:live:tdx` 与 `test:live:ifind` 在当前缺少官方 transport/凭据时应以非零状态退出，不应被解释为 provider 已通过：

```bash
pnpm test:e2e:model     # 需要已配置的模型 Key
pnpm test:e2e:ashare    # 需要模型 Key；加载 A 股 Skill 并要求 instrument + quote/bars
pnpm test:e2e:web       # 启动并探测本地 Web profile
pnpm test:live:yfinance
pnpm test:live:astock
pnpm test:live:tushare
pnpm test:live:tdx
pnpm test:live:ifind
pnpm test:live:cne6     # strict：验证本地已发布 CNE6 artifact
pnpm test:live:cne6:sources  # 访问 CNE6 上游真实数据源
pnpm test:live:matrix   # strict：只运行由 NGFI_LIVE_* 显式开启的 checks
pnpm report:live:matrix # 结构化汇总；blocked/fail 也保持退出码 0
```

未配置的可选 provider 应明确报告 dormant/skip/blocked，而不是伪装为 `no-data`。TDX official 与 iFinD official 当前没有已实现的 live transport，因此是 `blocked-transport`，不是 pass；对应 strict 命令在 transport 落地前返回非零。只有 `report:live:matrix` 是允许汇总 blocked/fail 后返回 0 的信息命令。CNE6 缺少原子 `CURRENT` 快照（或兼容的 legacy `quality-report.json`）或发布物校验失败同样返回非零；可用 `CNE6_DATA_ROOT` 指向一个已发布 artifact。

`test:live:astock` 与 `test:live:tushare` 不使用固定日期或“工作日”推算。它们先查询真实 A 股交易日历，在 `Asia/Shanghai` 时区中选择最近一个已完成且已留出收盘发布缓冲的交易日，再用该日查询 `600519.SH` 的单日行情。交易日历为空、目标日行情为 `no-data`、日期不匹配或数据为空都会使 smoke test 失败。TuShare 测试的初始化、请求和清理失败也只输出脱敏后的诊断。

### 外部事实复核（2026-09-06）

本节只记录公开入口的可达性与能力边界，不代表账号已获授权或 live provider 已通过：TuShare [MCP 文档 463](https://tushare.pro/document/1?doc_id=463)、通达信[量化开放平台文档](https://help.tdx.com.cn/quant/docs/markdown/mindoc-1he2c52nvvdkg.html)、[TdxClaw](https://help.tdx.com.cn/tdxclaw/) 与 [Data Key 文档](https://help.tdx.com.cn/tdxclaw/docs/markdown/tdxclaw-api-key-data.html)、同花顺 [iFinD MCP](https://mcp.51ifind.com/) 与 [Quant API](https://quantapi.51ifind.com/)，以及 [MCP 官方规范](https://modelcontextprotocol.io/) 均于该日返回 HTTP 200；通达信 Data Key 页面明确要求勾选“通达信数据服务”。对 [a-stock-data upstream](https://github.com/simonlin1212/a-stock-data) 的 `git ls-remote` 复核显示最新稳定标签仍为 `v3.8.0`；仓库 lock 记录的完整 tag object 为 `9f995e66ee792255e492a15627f98615627041c6`，peeled commit 为 `2012ce7cd0e75d379c5e6cbd3115514f300f3bc8`。

A 股 upstream 维护命令分为离线检查和显式联网探测：

```bash
pnpm data:upstream:test  # 固定 snapshot 的离线完整性与回归检查
ASTOCK_LIVE_TRADE_DATE=YYYY-MM-DD pnpm data:upstream:live
```

`data:upstream:live` 运行固定 upstream snapshot 自带的 opt-in live suite；交易日是必填项，可按测试需要同时设置 ``ASTOCK_LIVE_MARGIN_DATE``。它不会同步新版本，也不会隐式启用 Agent 数据源。版本检查、同步和 deterministic diff 分别使用 ``pnpm data:upstream:check``、``pnpm data:upstream:sync -- --version vX.Y.Z`` 与 ``pnpm data:upstream:report``。

同步候选必须经过 deterministic diff、许可证/来源审查、离线测试和安全扫描；不要把 upstream 中的任意 URL、抓取代码或原始 MCP 工具直接开放给 Agent。

## CNE6 数据构建

```bash
pnpm cne6:data:probe
pnpm cne6:data:smoke --start-date 2026-07-01 --end-date 2026-08-29 \
  --years 2024 --symbols 600519 000001 --workers 1 --request-delay 1.5
pnpm cne6:data:validate --symbols 600519 000001
```

本地行情与财务数据保存在 `packages/combinatorial-optimization/data/`，不会提交到 Git。请遵守对应数据源的服务条款和访问频率限制。

## 安全说明

- 不要提交 `.env`、`.runtime/secrets/`、API Key、token、私钥或本地凭据文件。
- `.env.example` 只有占位符，可以安全复制后在本地填写。
- DSH 运行目录、session、评测输出和下载的数据均保持本地。
- 外部金融数据可能延迟、不完整或发生字段变化；项目会保留 source/provenance、观察/抓取/发布/可见时间、期间、币种、单位和缺失状态。

## 免责声明

本项目仅用于研究与工程实践，不构成投资建议。在用于实际决策前，请独立核验数据、模型假设与计算结果。
