# NGFI Skills V2

V2 的三套原始能力已归入 canonical `skills/`。本轮公开入口进一步由15个收为11个：公司深研统一为 `company-research`，财务分析统一为 `financial-analysis`，DCF/相对估值/consensus 统一为 `equity-valuation` 的渐进子流程；下列三套历史能力仍保留：

- `skills/investment-behavior-diagnosis`
- `skills/macro-cycle-policy-analysis`
- `skills/financial-analysis`

这样保留了原版在复杂任务中的上下文一致性，同时吸收 A/B 测试中原子化版本的有效部分：输入 fast-path、边界判断、理论到行业追溯和明确的数据契约。

当前 DSH 要求 frontmatter 的 `name` 为 kebab-case，因此三套 Skill 的调用名分别是：

- `/investment-behavior-diagnosis`
- `/macro-cycle-policy-analysis`
- `/financial-analysis`

中文 `description` 保留，因此自然语言中文请求仍可依据描述触发；显式调用时使用以上名称。DSH runtime 只挂载这一个 `skills/` 根。

## 为什么采用“整体 Skill + 内部阶段契约”

A/B 测试中，原子化版本没有表现出整体优势：B 均分 78.0，A 均分 80.0；B 的 Token 高 5.5%，硬失败率也更高。主要问题不是知识拆分，而是编排器没有稳定传递数据优先级、安全规则和停止状态。

V2 因此采用：

1. 三个用户可调用的完整 Skill；
2. Skill 顶部的最高优先级控制层；
3. 内部阶段状态 `ok|partial|needs_input|data_conflict|tool_error|fatal`；
4. 只有复杂任务才启用子 Agent；
5. 财务输出由脚本和 JSON 契约强制校验。

## V2 关键改进

### 投资行为诊断

- 信息不足时只问 2-4 个关键问题；
- 数字冲突优先于心理诊断；
- 以“行为可能理性”为零假设，避免为了诊断而诊断；
- 最多深挖 3 个偏差，每个必须绑定证据、替代解释、行动和复盘指标；
- 禁止针对当前标的给买卖、仓位和价格建议；
- 未要求时不生成文件。

### 宏观周期与政策分析

- 支持用户提供的冻结检索快照，并严格锁定截止时间；
- 工具失败和信息不足时 fail closed，不编造当前指标；
- 用户断言与冻结数据冲突时，以可审计数据为准；
- 供给冲击下区分总通胀与核心通胀，不机械套美林时钟；
- 行业结论必须追溯到框架 ID、证据 ID、传导机制和反证条件；
- 简单任务单会话完成，只有复杂行业映射才启用双 Agent。

### 公司财务分析

- 唯一代码、数据解析、公司类型、致命信号、输出校验五道闸门；
- 默认先独立估值后比较市场价格；显式 intrinsic-only 模式保留股价防火墙；
- 计算统一放在 finance-core，取数放在 data-service，禁止临时重写财务公式；
- `calc_ratios.py` 的 ROA 口径锁定为 EBIT/总资产；
- 银行明确跳过通用 Z/M 模型，使用银行专属指标和估值方法；
- CV-1 由主 Agent 重算，触发后禁止启动估值；
- 历史 `state.json` 仅作为离线导入验证格式；新研究使用 evidence/model-runs 台账，不再建立第二套状态生命周期。

## 财务校验器

```bash
python "packages/finance-core/python/validate_state.py" path/to/state.json

python "packages/finance-core/python/validate_finance_output.py" \
  --report path/to/report.md \
  --state path/to/state.json
```

规范计算通过 `run_canonical.py` 调用，例如：

```bash
python "packages/finance-core/python/run_canonical.py" \
  --script calc_ratios.py \
  --input path/to/_data.json \
  --output path/to/_ratios.json
```

包装器会把脚本、输入和输出 SHA-256、退出码及耗时追加到工作目录的 `_provenance.json`。

## 回归测试

```bash
python -m unittest discover -s tests -v
python "packages/finance-core/python/selftest.py"
python tests/run_dsh_smoke.py
```

测试覆盖：

- 三套 Skill 的控制层位置；
- 行为诊断的输入、冲突和理性零假设；
- 宏观冻结数据和对抗前提防护；
- 财务股价防火墙、规范脚本和银行分叉；
- `state.json` 正反例；
- ROA 必须为 EBIT/总资产。

`run_dsh_smoke.py` 使用 DeepSeek-V4-Flash/high 真实加载三套 V2 Skill，复测 A/B 中风险最高的三类行为：伪造宏观数据、当前股价对抗指令、盈亏数字冲突。完整输出与检查结果保存在 `tests/dsh-smoke-results.json`。

## 与原版的关系

V2 在原版脚本和参考资料上做增量强化。三套 Skill 及其测试与 NGFI 主工程共同维护；`skills_v2/` 和仓库根目录中文副本不再是运行入口。行为诊断以原生产版为 canonical 基础，V2 独有理论资料以 `v2-*-toolkit.md` 兼容 reference 保留。
