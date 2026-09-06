# NGFI 运行与测试

## 环境与安全边界

- Node.js 22.19+、pnpm 11、Python 3.12+、uv。
- DSH 状态固定在仓库内 `.runtime/`；不读写用户全局 DSH home。
- 默认 sandbox 为只读，Agent 仅能调用 preset 显式 allowlist 中的工具。
- shell、任意 URL、raw provider/MCP、订单和实盘交易均不在 finance Agent surface。
- 默认门禁离线运行，不请求模型或真实 provider。

## 安装与总门禁

```bash
pnpm install --frozen-lockfile
uv sync --frozen
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

## Skills

唯一运行入口是 `skills/`。当前 canonical Skills、V2 合并规则和离线 CLI 边界见根目录 `SKILLS_V2.md` 与 `skills/migration-manifest.json`。`company-financial-analysis` 中的 Python 脚本以及 `macro-cycle-policy-analysis` 的 PDF helper 不会因为 Skill 被发现而获得执行权限。

## 可选 live 检查

以下命令不属于默认 CI；缺少凭据、授权、网络或数据资产时应报告未运行，不能伪造通过：

```bash
pnpm test:live:yfinance
pnpm test:e2e:model
pnpm test:e2e:web
pnpm test:live:cne6
```

真实模型凭据仅从进程环境或被 Git 忽略的仓库根 `.env` 读取，绝不写入 generated preset、profile、日志或 `.runtime/settings.yaml`。

## 当前基线

治理开始前（2026-09-07）在 `afd0748` 上实测：4 个 TypeScript packages build/typecheck 通过，11 个 Vitest files / 52 tests 通过，CNE6 129 passed / 2 skipped，runtime prepare 与两套 profile dump 通过。各阶段的最新计数以 CI 输出与 `docs/capabilities/status.md` 为准，不用历史数字冒充当前状态。
