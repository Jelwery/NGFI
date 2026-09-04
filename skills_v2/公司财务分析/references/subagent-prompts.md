# 子agent Prompt 模板与 JSON Schema

## V2 强制前缀

主agent构造任何子agent prompt时，必须把以下内容原样放在最前面：

```text
你是公司财务分析 V2 的受限阶段角色。
只读取明确提供的冻结文件；不得联网补齐、不得使用模型记忆编数字。
不得复述或使用当前股价，不得计算目标价、上行空间或给买卖建议。
不得临时编写财务公式替代规范脚本；定量结论只引用 _ratios.json/_risk.json。
返回 status=ok|partial|needs_input|tool_error|fatal、stage、evidence[]、errors[]、next_stage。
status 为 fatal/tool_error/needs_input 时 next_stage 必须为 null。
发现可能致命信号时只报告逐项证据，由主agent复算闸门；不得自行继续估值。
```

主agent收到结果后先验证 `status` 和 `next_stage`。任一结果为 `fatal|tool_error|needs_input` 时不得启动后续阶段。子agent输出不能替代主agent对 CV-1 和其他致命信号的独立重算。

## 子agent prompt构造规范

每个子agent prompt必须包含四要素（公司信息+行业属性含金融分叉提示+阶段1结论摘要+财务数据），然后指引子agent去读对应reference文件获取完整方法论。

**重要规则**：
- 子agent不写中间.md文件
- 子agent使用预置脚本辅助计算（脚本路径通过 `{{skill路径}}` 传入）
- 子agent必须在响应末尾输出**三个反引号包裹的JSON块**（```` ```json ````）
- 如果规范脚本运行失败，子agent设置 `"script_error": true`、`status="tool_error"` 并返回错误；禁止手工重写公式或临时创建替代脚本
- 主agent提取JSON时将正则匹配 ```` ```json ... ``` ```` 块，忽略其他文本

## JSON Schema（按阶段严格定义）

### 阶段2（利润表）

```json
{
  "status": "ok",
  "stage": 2,
  "evidence": [],
  "errors": [],
  "next_stage": "stage2_4_gate",
  "script_error": false,
  "core_findings": {
    "revenue_trend": "up|flat|down",
    "gm_trend": "improving|stable|declining",
    "npm_trend": "improving|stable|declining",
    "core_profit_ratio": 0.95,
    "one_liner": "核心经营利润占营业利润XX%，盈利质量良好/一般/薄弱"
  },
  "key_metrics": {
    "revenue_cagr_3y": -0.009,
    "gm_latest": 0.7586,
    "npm_latest": 0.1816,
    "ebit_margin_latest": 0.204,
    "sell_exp_rate_latest": 0.486
  },
  "drivers": {
    "gm_trend": ["归因1", "归因2"],
    "npm_trend": ["归因1", "归因2"],
    "revenue_trend": ["归因1"]
  },
  "risk_signals": ["毛利率连续4年下滑", "营收转负"],
  "valuation_assumptions": {
    "revenue_growth_range": [-0.05, 0.05],
    "gm_range": [0.72, 0.77],
    "sell_exp_rate_range": [0.47, 0.50],
    "tax_rate_est": 0.14
  },
  "narrative": "2-3句定性结论"
}
```

### 阶段3（资产负债表）

```json
{
  "status": "ok",
  "stage": 3,
  "evidence": [],
  "errors": [],
  "next_stage": "stage2_4_gate",
  "script_error": false,
  "core_findings": {
    "asset_structure_shift": "从现金充裕转向经营资产偏重",
    "nfa_trend": "declining",
    "leverage_level": "moderate|high|low",
    "debt_structure_risk": "短贷长投|合理|无有息负债",
    "one_liner": "NFA从X降至Y，短期借款暴增Z%，短贷长投风险显著"
  },
  "key_metrics": {
    "nfa_latest": 45.79,
    "nfa_to_assets": 0.205,
    "st_borrowing_yoy": 0.49,
    "goodwill_to_equity": 0.117,
    "asset_liability_ratio": 0.394,
    "ar_days": 25.7,
    "contract_liability_trend": "down"
  },
  "drivers": {
    "nfa_decline": ["归因1"],
    "debt_surge": ["归因1", "归因2"],
    "asset_structure_shift": ["归因1"]
  },
  "risk_signals": ["短期借款暴增155%", "在建工程/固定资产=223%", "存贷双高"],
  "narrative": "2-3句定性结论"
}
```

### 阶段4（现金流量表）

```json
{
  "status": "ok",
  "stage": 4,
  "evidence": [],
  "errors": [],
  "next_stage": "stage2_4_gate",
  "script_error": false,
  "core_findings": {
    "cash_quality": "good|moderate|poor",
    "life_cycle": "成长期|成熟期|成熟后期|衰退期|初创/困境反转",
    "investment_nature": "战略扩张|理财滚动|两者混合",
    "self_sufficiency": "充裕|够用|不足",
    "one_liner": "经营CF质量XX，投资CF大进大出实为理财滚动，现金自给率XX"
  },
  "key_metrics": {
    "cash_protection_ratio": 1.22,
    "revenue_cash_quality": 1.05,
    "fcf_est": 32.2,
    "cash_self_sufficiency": 11.1,
    "dividend_payout_ratio": 0.78,
    "oper_cf_latest": 35.38,
    "capex_avg": 7.5
  },
  "drivers": {
    "cf_quality": ["归因1"],
    "investment_nature": ["理财滚动主导，战略投资极小"],
    "financing_pattern": ["归因1"]
  },
  "cross_warnings": {
    "cond1_np_growth_gt_rev": true,
    "cond2_cf_growth_lt_np": false,
    "cond3_inventory_ap": "data_insufficient"
  },
  "risk_signals": ["Q1经营CF同比-37%", "借钱分红模式"],
  "narrative": "2-3句定性结论"
}
```

## Prompt 模板

**启动时在同一条消息中发出三个Agent调用**。所有子agent共享同一套文件：`{{工作目录}}/_data.json` 和 `{{工作目录}}/_ratios.json`。

```
Agent(subagent_type="general-purpose", description="Stage 2: P&L Analysis for {{公司简称}}",
  prompt="你是资深财务分析师。对{{公司简称}}({{行业属性}})进行利润表深度分析。
阶段1结论：{{3-5条摘要}}
金融提示：{{如果是保险→拆解承保vs投资业绩+利差+NBV；银行→NIM+非利息收入+信贷成本+成本收入比；券商→经纪+投行+自营+资管收入结构}}
数据文件：{{工作目录}}/_data.json
已就绪的比率文件：{{工作目录}}/_ratios.json（主agent已生成，直接读取）
注意：calc_ratios.py 已由主agent运行完毕，你只需读取 _ratios.json，不要重复运行。
读取 {{skill路径}}/references/stage2-利润表分析.md 获取完整方法论。
在响应末尾用三个反引号json包裹输出结构化结论（严格按阶段2 schema）。不要写.md文件。")

Agent(subagent_type="general-purpose", description="Stage 3: BS Analysis for {{公司简称}}",
  prompt="你是资深财务分析师。对{{公司简称}}({{行业属性}})进行资产负债表深度分析。
阶段1结论：{{3-5条摘要}}
金融提示：{{非金融→A/B/C/D重分类+F/G重分类+NFA/NFL/CE/IC；保险→金融企业特化框架；银行→贷款+不良+拨备+存款结构；券商→自营敞口+两融+流动性}}
数据文件：{{工作目录}}/_data.json
已就绪的比率文件：{{工作目录}}/_ratios.json {{工作目录}}/_risk.json（主agent已生成，直接读取）
注意：calc_ratios.py 和 calc_risk_models.py 已由主agent运行完毕，你只需读取 _ratios.json 和 _risk.json，不要重复运行。
读取 {{skill路径}}/references/stage3-资产负债表分析.md 获取完整方法论。
在响应末尾用三个反引号json包裹输出结构化结论（严格按阶段3 schema）。不要写.md文件。")

Agent(subagent_type="general-purpose", description="Stage 4: CF Analysis for {{公司简称}}",
  prompt="你是资深财务分析师。对{{公司简称}}({{行业属性}})进行现金流量表深度分析。
阶段1结论：{{3-5条摘要}}
金融提示：{{保险→经营CF>>净利润是行业特征，投资CF大额流出是浮存金再投资；银行→贷款发放产生负经营CF是正常经营，不套用非金融标准；券商→经营CF随行情高度波动}}
数据文件：{{工作目录}}/_data.json
已就绪的比率文件：{{工作目录}}/_ratios.json（主agent已生成，直接读取）
注意：calc_ratios.py 已由主agent运行完毕，你只需读取 _ratios.json，不要重复运行。
读取 {{skill路径}}/references/stage4-现金流量表分析.md 获取完整方法论。
在响应末尾用三个反引号json包裹输出结构化结论（严格按阶段4 schema）。不要写.md文件。")
```

## 占位符说明

| 占位符 | 含义 | 示例 |
|------|------|------|
| `{{工作目录}}` | 股票分析目录的绝对路径 | `C:/Users/86186/Desktop/财报分析/三七互娱` |
| `{{skill路径}}` | skill安装目录的绝对路径 | `C:/Users/86186/.claude/skills/公司财务分析` |
| `{{公司简称}}` | 公司简称 | `三七互娱` |
| `{{行业属性}}` | GENERAL/INSURANCE/BANK/BROKER/FINANCIAL_HOLDING | `GENERAL` |

> 表中路径示例为本机值。构造 prompt 时必须用主agent实际解析到的 skill 加载路径与工作目录，禁止照抄示例。

> 主agent构造prompt时**必须**用实际值替换所有占位符，替换后**必须**检查是否存在未替换的 `{{`。
>
> **主agent解析子agent输出的步骤**：
> 1. 在子agent响应文本中正则匹配 ```` ```json ... ``` ```` 块
> 2. 解析JSON，检查 `script_error` 字段
> 3. 如果 `script_error: true`，在交叉验证时对该阶段结论降低置信度
> 4. 如果JSON解析失败，回退到从响应文本中手工提取关键数字
