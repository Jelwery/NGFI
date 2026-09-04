# NGFI Skills V2

V2 以 `/Users/bytedance/Desktop/ngfi` 为基线，保留三套完整 Skill，不再把工作流拆成大量物理子 Skill：

- `投资行为诊断`
- `宏观周期与政策分析`
- `公司财务分析`

这样保留了原版在复杂任务中的上下文一致性，同时吸收 A/B 测试中原子化版本的有效部分：输入 fast-path、边界判断、理论到行业追溯和明确的数据契约。

当前 DSH 要求 frontmatter 的 `name` 为 kebab-case，因此三套 Skill 的调用名分别是：

- `/investment-behavior-diagnosis`
- `/macro-cycle-policy-analysis`
- `/company-financial-analysis`

中文目录名和中文 `description` 保留，因此自然语言中文请求仍可依据描述触发；显式调用时使用以上名称。

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
- 当前股价、目标价、上行空间和买卖建议采用 fail-closed 防火墙；
- 只允许调用 Skill 内置规范脚本，禁止临时重写财务公式；
- `calc_ratios.py` 的 ROA 口径锁定为 EBIT/总资产；
- 银行明确跳过通用 Z/M 模型，使用银行专属指标和估值方法；
- CV-1 由主 Agent 重算，触发后禁止启动估值；
- `state.json` 使用稳定 Schema，并由脚本验证。

## 财务校验器

```bash
python "公司财务分析/scripts/validate_state.py" path/to/state.json

python "公司财务分析/scripts/validate_finance_output.py" \
  --report path/to/report.md \
  --state path/to/state.json
```

规范计算通过 `run_canonical.py` 调用，例如：

```bash
python "公司财务分析/scripts/run_canonical.py" \
  --script calc_ratios.py \
  --input path/to/_data.json \
  --output path/to/_ratios.json
```

包装器会把脚本、输入和输出 SHA-256、退出码及耗时追加到工作目录的 `_provenance.json`。

## 回归测试

```bash
python -m unittest discover -s tests -v
python "公司财务分析/scripts/selftest.py"
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

V2 复制了原版脚本和参考资料，再做增量强化。原目录 `/Users/bytedance/Desktop/ngfi` 不需要且不应被修改。V2 是独立目录和独立 Git 仓库。
