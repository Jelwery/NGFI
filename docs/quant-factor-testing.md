# 因子完整流程验收指南

本次可验收的是 F0–F4 工程闭环：版本化因子 → 有界裂变 → 冻结开发/测试评估 → 预登记模型与回放 → 四类解释。合成测试通过不代表因子有效、真实 CNE6 验收或可上线。

## 1. 一次准备

在 NGFI 仓库根目录执行，要求 Node 22.19+（或 24+）、项目指定 pnpm 和 uv：

```bash
corepack pnpm install --frozen-lockfile
uv sync --project packages/combinatorial-optimization --frozen --extra dev
corepack pnpm build
```

`uv` 不在 PATH 时设置 `NGFI_UV_EXECUTABLE` 为其真实绝对路径。例如本机安装位置：

```bash
export NGFI_UV_EXECUTABLE="$HOME/Library/Python/3.9/bin/uv"
```

首次依赖安装需要网络，研究计算阶段固定使用离线已安装环境。

## 2. 一条命令验收完整链路

```bash
node scripts/quant-factor-smoke.mjs
```

脚本会逐步打印进度，结束输出 `PASS` 和 `manifest.json` 的绝对路径。每次为合成验收创建独立临时 runtime，保留所有输入、实际 CLI 参数、结果和预期拒绝信息；不会清理既有研究记录。任一非预期错误都会返回非零退出码，失败目录也会保留。

| 阶段 | 你应该看到什么 |
|---|---|
| 数据导入、算子目录 | v3 合成数据获得 datasetId、caseId；目录含算子版本与契约 |
| 裂变、登记 | 17 个定义、17 条血缘；交互因子有两个父因子；保留 familyId 和版本身份 |
| 无效阶段 | `developmnt` 被拒绝，case revision 不变 |
| 开发评估、比较 | 开发结果、冻结 selection、候选理由和逐 horizon 指标 |
| 结构解释 | definitions/lineage/factor card 展示公式、输入、算子和依赖 |
| 风格解释 | 逐日行业投影、系数、R²、剩余信号诊断；状态 complete |
| 冻结测试 | test complete；相同请求重放返回 replay=true |
| 注册模型回放 | 交互因子作为 modelFeatures，父因子仅供计算；实验 complete，重放 replay=true |
| 模型预测解释 | Ridge 贡献与预测核对，状态 complete |
| 收益解释 | daily 可查询，收益平账且 Carino linked.status=available |
| 风险解释 | partial，所有日期 blocked，原因是未提供合格 CNE6；这是预期结果 |
| 跨 workspace 治理 | 同样本的新评估被 overlaps 拒绝 |

脚本采用固定合成价格、固定变化成交量、合成平价指数和已知逐股收益。数据始终为 `synthetic: true`。验证阈值 `minimumRankIc=-1`、`duplicateCorrelation=1` 等专用于工程连通测试，不用于证明投资价值。实验规格在开发计算前冻结；若预登记因子未入选，脚本直接失败，不自动调整参数。

## 3. 亲自查看与重放

打开脚本打印目录中的这些文件：

- `dataset.json`：完整输入及合成来源说明。
- `derive.json`、`factors.json`：裂变请求、资产定义。
- `evaluation.json`：三个窗口、筛选规则、风格控制及预登记实验。
- `spec.json`：实际模型特征、依赖定义、训练/风险/交易设置。
- `explanation.json`：开发区间内的风格解释请求。
- `N-command.json`、`N-result.json`：每步真实命令参数和返回值。
- `manifest.json`：runtimeRoot、workspace、caseId、datasetId、evaluationId、runId、验收步骤状态。

将 `NGFI_RUNTIME_DATA_ROOT` 设置为 manifest 中的 runtimeRoot，CLI 即可读取本次验收。然后使用 manifest 中的实际 ID，按 [操作员命令](quant-research.md#操作员-cli) 查询：

```bash
corepack pnpm quant:research --workspace factor-smoke list
```

模型/收益/风险的实际查询命令已分别保存在对应 `N-command.json`。也可以直接重放某个只读 command 文件，不必手工复制 ID：

```bash
node --input-type=module -e '
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const command = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const result = spawnSync(command.executable, command.args, {
  env: { ...process.env, ...command.env }, stdio: "inherit"
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
' /实际输出目录/对应只读步骤-command.json
```

写请求中的 revision 代表当时的状态，不能机械重放旧 revision。先用 `list` 获取当前 revision。中断恢复还需同一输入、同一代码/依赖身份与 `--resume`；代码改变会改变任务身份，不能冒充原任务恢复。

## 4. 验证错误恢复和计算边界

完整 CLI 脚本覆盖日常正向流程与关键拒绝流程。故障注入、已知真值核对、并发与身份完整性由自动回归覆盖：

```bash
corepack pnpm exec vitest run tests/factor-research-workflow.test.ts tests/portfolio-risk-contracts.test.ts tests/quant-workflow-integration.test.ts
corepack pnpm test:quant-research
corepack pnpm check
```

`pnpm check` 需要 `uv` 在 PATH 中；仅设置 `NGFI_UV_EXECUTABLE` 不会改变 pnpm 的 Python 测试命令。本机可先执行 `export PATH="$HOME/Library/Python/3.9/bin:$PATH"`。

本轮新增/补强回归包括：依赖不作为模型特征、非法或重复特征/v2 兼容、33 因子风格解释、阶段错误无写入、失败原因持久化及显式恢复、收盘前/收盘时/决策时/决策后的 CNE6 发布时间边界。

## 5. 在 Agent 中查看

以同一个 runtimeRoot 启动 `strategy-research` preset，再发送：

> 使用 finance_quant_research 查看 factor-smoke workspace 的实验列表。根据返回的实际 ID 查询因子家族、冻结评估比较，以及模型、收益、风险归因。分别说明四类解释回答什么问题、哪些输入缺失、是否可晋级。只读取已登记结果。

首次工程验收建议以 CLI 为准；Agent 还依赖可用的模型服务，输出受 8 MiB 限制，应分页查询。

## 6. 换真实数据时

保持统一且持久的 runtimeRoot，保留所有研究域历史。按 schema 准备获准使用的 PIT 行情、历史成员/行业、实际指数、期初可见权重与暴露、因子及逐股特异收益，再预登记未观察的测试窗口。

风险归因需要同日合格 CNE6 快照，发布时间满足 `closeAt <= availableAt <= decisionAt`；主动风险还需要同期期初基准权重。缺失或质量不合格应 blocked，不能用小样本模型代替全市场验收。

F5 真实样本净增量、A2/A4/完整 CNE6 数据门禁、容量和前向观察仍需独立验收；HAC/FDR、重训消融、分区 checkpoint 与规模化缓存也不属于当前实现。所有结果的 `promotionEligible` 保持 false。
