# 增量更新操作指南

## V2 状态契约（覆盖旧版键布局）

V2 的 `state.json` 顶层结构固定为：

```json
{
  "metadata": {
    "code": "sh.600519",
    "name": "公司简称",
    "last_period": "20251231",
    "last_qtr": "20260331",
    "last_report": "公司简称_2025年报.md"
  },
  "stage1": {},
  "stage2_4_summary": {},
  "risk_models": {},
  "last_valuation": {
    "method": "DCF(60%)+PE(40%)",
    "scenario": {},
    "results": {
      "pessimistic": 0,
      "neutral": 0,
      "optimistic": 0,
      "recommended": 0
    }
  },
  "data_snapshots": {}
}
```

下文旧表中“顶层元数据”的 `code/name/last_period/last_qtr/last_report` 在 V2 中均位于 `metadata` 对象内；旧称 `stage5_metrics` 的模块在 V2 中统一为 `risk_models`。严禁使用 `meta`。生成和覆盖后必须运行 `scripts/validate_state.py`，校验未通过不得复用或交付。

估值确实无法执行时，`last_valuation` 使用：

```json
{"status": "unavailable", "reason": "缺失的核心参数及原因"}
```

不得以伪造的四个估值数满足结构要求。

## state.json 字段完整说明

增量更新时，以下字段提供上下文和锚点。读写时按需取用。

### 顶层元数据

| 字段 | 类型 | 含义 | 更新时用途 |
|------|:---:|------|------|
| `code` | str | 股票代码（完整格式 sh.600519 / sz.002555） | 验证state.json匹配当前分析目标 |
| `name` | str | 公司简称 | 报告命名 |
| `last_period` | str | 上次分析覆盖的最新报告期（如"20251231"） | **判断更新深度**：比对新数据的latest_period |
| `last_qtr` | str | 上次分析时的最新季度（如"20260331"） | 如本次无新增季度则跳过轻量更新 |
| `last_report` | str | 上次报告的md文件名 | 覆盖时参考 |

### stage1（阶段1结论）—— 轻量更新直接复用

| 字段 | 含义 | 何时需要更新 |
|------|------|------|
| `company_type` | GENERAL/INSURANCE/BANK | 除非公司主业变更，否则不变 |
| `industry` | 行业描述 | 行业格局重大变化时 |
| `market_rhythm` | 快周期/慢周期 | 基本不变 |
| `moat_rating` | 宽/窄/无 | 除非竞争格局剧变 |
| `management_risk` | 高/中/低 | 有新处罚或治理事件时 |
| `management_note` | 管理层风险详述 | 同上 |
| `key_competitors` | 可比公司列表 | 可比公司发生重大变化时 |
| `swot` | 四象限分析 | 行业/公司发生重大变化时 |

### stage2_4_summary（三表核心指标快照）

所有值为**上次分析时的最新年报数据**。字段按来源分组：

**利润表相关**：
| 字段 | 含义 |
|------|------|
| `revenue_trend` | "up"/"flat"/"down" |
| `revenue_YYYY` | 各年营收（亿元） |
| `revenue_yoy_YYYY` | 各年营收同比（如-0.0846） |
| `gm_YYYY` | 各年毛利率 |
| `gm_trend` | "improving"/"stable"/"declining" |
| `npm_YYYY` | 最新年归母净利率 |
| `core_operating_profit_YYYY` | 核心经营利润 |
| `core_profit_ratio` | 核心经营利润/营业利润 |
| `parent_np_YYYY` | 归母净利润 |
| `eps_YYYY` | 基本每股收益 |
| `sell_exp_rate_YYYY` | 销售费用率 |

**资产负债表相关**：
| 字段 | 含义 |
|------|------|
| `st_borrowing_YYYY` | 短期借款（亿元） |
| `st_borrowing_trend` | 趋势描述 |
| `lt_borrowing_YYYY` | 长期借款 |
| `cash_to_st_debt_YYYY` | 货币资金/短期借款 |
| `nfa_YYYY` | 净金融资产 |
| `nfa_trend` | "improving"/"stable"/"declining" |
| `goodwill_YYYY` | 商誉 |
| `goodwill_to_equity` | 商誉/归母权益 |
| `asset_liability_ratio_YYYY` | 资产负债率 |
| `total_assets_YYYY` | 总资产 |
| `parent_equity_YYYY` | 归母权益 |

**现金流相关**：
| 字段 | 含义 |
|------|------|
| `oper_cf_YYYY` | 经营CF净额 |
| `cash_protection_ratio_YYYY` | 经营CF/归母净利润 |
| `cash_protection_trend` | "stable_above_1"/"declining"/"below_1" |
| `life_cycle` | 生命周期阶段 |
| `cash_self_sufficiency_YYYY` | 现金自给率 |
| `fcf_YYYY` | 自由现金流（亿元） |

**季度前瞻**（如有latest_quarter数据）：
| 字段 | 含义 |
|------|------|
| `q1_YYYY_revenue_yoy` | Q1营收同比 |
| `q1_YYYY_parent_np_yoy` | Q1归母净利润同比 |
| `q1_YYYY_core_np_yoy` | Q1扣非净利润同比 |
| `q1_YYYY_oper_cf` | Q1经营CF |
| `q1_YYYY_oper_cf_yoy` | Q1经营CF同比 |
| `q1_YYYY_oper_cf_warning` | Q1经营CF是否触发预警 |

### stage5_metrics（风险模型结果）

| 字段 | 含义 |
|------|------|
| `roe_YYYY` | 各年ROE |
| `roe_drivers` | 杜邦驱动描述（净利率/周转率/杠杆） |
| `roa_YYYY` | 总资产回报率 |
| `borrowing_rate_est_YYYY` | 估测借款利率 |
| `leverage_direction` | "CREATES"/"DESTROYS"/"NEUTRAL"/"N/A (无有息负债)"/"N/A (利率数据不足)" |
| `z_score_YYYY` | Altman Z值 |
| `z_score_status` | "SAFE"/"GREY"/"HIGH RISK" |
| `z_score_trend` | "improving"/"stable"/"declining" |
| `m_score_YYYY` | Beneish M-Score |
| `m_score_status` | "LOW"/"HIGH" |
| `ag_3y_avg` | 3年平均总资产增长率 |
| `financial_health` | 财务健康度综合评级 |
| `profit_quality` | 盈利质量评级 |
| `growth_rating` | 成长性评级 |
| `overall_risk` | 综合风险等级 |

### last_valuation（上次估值完整快照）

**results 统一接口**（必填，不论公司类型）：

| 字段 | 含义 |
|------|------|
| `results.pessimistic` | 悲观情景每股价值（必填） |
| `results.neutral` | 中性情景每股价值（必填） |
| `results.optimistic` | 乐观情景每股价值（必填） |
| `results.recommended` | 分析师综合推荐值（必填——多方法加权后的最终判断） |

**method**：字符串，说明用了哪些估值方法及权重（如 `"DDM(50%)+PB(30%)+PE(20%)"` 或 `"DCF(60%)+PE(40%)"`）。

**dcf 子对象**（非金融企业）：

| 字段 | 含义 |
|------|------|
| `dcf.pessimistic.per_share` | 悲观DCF每股价值 |
| `dcf.neutral.per_share` | 中性DCF每股价值 |
| `dcf.optimistic.per_share` | 乐观DCF每股价值 |
| `wacc_neutral` | 中性WACC |
| `term_g_neutral` | 中性永续增长率 |
| `capex_avg` | 年均capex（亿元，从CF表实际值推导）。**必须保存**——旧DCF的capex假设直接影响FCF，缺失则估值桥接失真 |

**rim 子对象**：

| 字段 | 含义 |
|------|------|
| `rim.bps` | 每股净资产 |
| `rim.value_per_share` | RIM每股价值 |
| `rim.implied_pb` | RIM隐含PB |

**relative 子对象**：

| 字段 | 含义 |
|------|------|
| `relative.peer_pe_median` | 上次用的可比PE中位数 |
| `relative.neutral_eps_est` | 中性EPS预估 |
| `relative.neutral_range` | 相对估值中性区间 |

**scenario 子对象**（**最关键**——增量更新做估值bridge的核心输入）：

完整的三情景参数。每个情景包含：`wacc`, `term_g`, `rev_growth`（5值数组）, `gm`（5值数组）, `sm_rate`（5值数组或单值）, `admin_rate`, `rd_rate`, `other_inc_rate`。

**其他字段**：

| 字段 | 含义 |
|------|------|
| `ke_used` | 使用的股权成本 |
| `rf_used` | 使用的无风险利率 |
| `peer_pe_used` | 使用的可比PE |
| `sensitivity_center` | 敏感性矩阵中心值区间 |
| `date` | 估值日期 |

### data_snapshots（各年关键数据快照）

每年 13 个字段：`revenue`, `parent_np`, `eps`, `total_assets`, `parent_equity`, `cash`, `st_borrowing`, `lt_borrowing`, `goodwill`, `oper_cf`, `gm`, `npm`, `roe`。单位均为亿元（比率除外）。

**用途**：轻量更新时用于对比新数据的变化幅度。

---

## 增量更新操作流程

### 步骤0：验证 state.json

```
1. 读 state.json，检查 code 字段是否匹配当前分析目标 → 不匹配则走完整分析
2. 检查必填字段是否存在（stage1, stage2_4_summary, last_valuation, data_snapshots）
   → 缺字段时标注"state.json 版本可能过旧，部分旧判断无法复用"
   → 不影响更新继续，但缺失模块的结论需重新分析而非复用
```

### 步骤0.5：重新提取最新数据（必须最先执行）

**增量更新时，旧的 `_data.json` 已被清理。第一步必须重新提取最新完整数据。**

```
python scripts/extract_financials.py <股票代码> --years 5 -o _data.json
```

然后对比新旧数据：
- `_data.json` 的 `annual_data` 最新年报 vs state.json 的 `last_period`
- `_data.json` 的 `latest_quarter` 是否存在且晚于 state.json 的 `last_qtr`

### 步骤1：判断更新深度

**在判断深度之前，必须先做"变化性质判断"。** 新数据不只是"多了几个季度"——可能伴随着产品周期、竞争格局、监管政策、利润构成的重大变化。如果这些变化被忽略直接走轻量更新，估值结论会系统性地滞后于现实。

**变化性质判断清单**（逐项检查，任一触发则升级为标准更新）：

| 维度 | WebSearch 查询模板 | 定量锚点 | 定性判断 |
|------|------|------|------|
| 产品周期 | `"{公司简称}" 新品 上线 {当前年份}` | — | 搜索结果显示有新游/新产品上线→触发 |
| 竞争格局 | `{公司简称} 市场份额 排名 {当前年份}` | Q1营收增速 vs 行业增速偏离 >50% | 如公司-12% vs 行业+8%→差距20pp→触发 |
| 管理层/治理 | `"{公司简称}" 处罚 OR 高管 OR 质押 {当前年份}` | 大股东质押率变化 >10pp | 搜索结果有新处罚/高管变动→触发 |
| 监管政策 | `"{行业}" 政策 新规 {当前年份}` | — | 搜索结果有行业新规→触发 |
| 利润构成 | （从 _data.json 计算） | Q1 (归母-扣非)/归母 >20% | — |
| 资产结构 | （对比 Q1末BS vs 上年末BS） | 任一BS科目变化 >30% | — |

**判断方法**：定量维度用 data.json 直接计算；定性维度用 WebSearch 搜索结果数量和质量判断——搜索结果前3条中有明确相关新闻即触发。

**检查结果**：
- 全部通过 → 继续轻量更新
- 任一项触发 → 升级为标准更新（重跑完整六阶段）
- 在报告中记录每一项的判断依据（搜索了什么、看到了什么、为什么通过/触发）

```python
# 伪代码
new_periods = 新提取数据中的所有报告期（年报+季度）
old_last_period = state["last_period"]  # "20251231"
old_last_qtr = state.get("last_qtr")    # "20260331"

new_annuals = [p for p in new_periods if p > old_last_period and p.endswith("1231")]
new_quarters = [p for p in new_periods if old_last_qtr and p > old_last_qtr]

if len(new_annuals) >= 1:
    depth = "标准更新"
elif len(new_quarters) >= 1:
    depth = "轻量更新"
else:
    # 没有新数据——可能数据源未更新，提示用户
    depth = None
```

### 步骤2：轻量更新实操

#### 2.1 利润表更新

```
1. python extract_financials.py → 获取最新季度数据（latest_quarter + prev_year_quarter）
2. 用 prev_year_quarter（去年同季度快照，提取脚本已自动保存）直接同比：
   - 营收同比 = latest_quarter.利润表.营业收入 / prev_year_quarter.利润表.营业收入 - 1
   - 归母净利润同比、经营CF同比：同法
   - 毛利率变化 = latest_quarter 毛利率 - prev_year_quarter 毛利率（季度值直接比，不做年化）
3. prev_year_quarter 缺失时（上市不足一年等），退而用年化代理并标注：
   年化代理增速 = latest_quarter.营业收入 × 4 / 上年年报营业收入 - 1（标注"年化近似，仅供参考"）
4. 更新 state["stage2_4_summary"] 中的 q1_* 字段
5. 如营收同比转负+经营CF转负 → 触发"现金流危机"预警
```

#### 2.2 资产负债表快照

```
1. 读最新季度BS数据
2. 对比 state["stage2_4_summary"] 中的资产/负债指标：
   - 应收暴增（>30%季环比）→ 标注
   - 短期借款暴增（>20%季环比）→ 标注
   - 商誉减值迹象 → 标注
3. 如结构突变，在报告中加"资产负债表预警"章节
```

#### 2.3 估值重跑（轻量更新核心步骤）

```
1. 读 state["last_valuation"]["scenario"] → 作为基准scenario
2. 根据新季度数据的偏离程度，决定是否修正假设。**单季度数据不能直接替换5年假设——必须遵循保守调整原则：**

   | 信号 | 阈值 | 最大调整幅度 | 逻辑 |
   |------|:---:|:---:|------|
   | Q1营收偏离中性Y1假设 | >10% | 调整Y1增速，不超过旧假设与新数据的均值 | 单季波动大，不足以推翻全年判断 |
   | Q1毛利率偏离中性假设 | >3pp | 调整Y1毛利率，不超过(旧GM + 新Q1_GM)/2 | 单季毛利率受新品上线/活动影响大 |
   | 连续2季度同方向偏离 | — | Y1+Y2都可调整，幅度放宽到旧值的80% | 连续趋势比单季更可靠 |
   | WACC | 无风险利率变化>0.5% | 调整WACC | 利率环境确实变了 |

   **禁止**：用单季度数据直接上修/下修全部5年的假设。Q1的数据只影响Y1假设，Y2-Y5保持不变——除非有连续2季度的趋势确认。
3. 写新的 scenario.json（如假设无变化，可直接复用旧scenario）
4. python calc_valuation.py → 得到新DCF
5. 与旧DCF对比，生成估值变化桥接：

   估值变化桥接公式（逐项叠加）：
   上次中性DCF: state["last_valuation"]["dcf"]["neutral_per_share"]
   本次中性DCF: new_dcf
   
   变化分解：
     + 收入假设上修/下修 = 只改 rev_growth 重跑，对比 delta
     + 毛利率假设变化 = 只改 gm 重跑，对比 delta
     + WACC变化       = 只改 wacc 重跑，对比 delta
     + 时间推进       = (new_dcf × term_g) 近似
     = 合计变化 ≈ new_dcf - old_dcf

   如果逐项之和与总变化差异 >10%，说明存在交叉效应，标注即可。
```

### 步骤3：标准更新实操

```
1. 阶段1：读 state["stage1"]，简要review确认无重大变化。复用除 management_risk 外的所有判断。
   management_risk 需用最新WebSearch重新检查（新处罚/新质押等）。
2. 阶段2-6：完整重跑（流程同首次分析）
3. 报告末尾加变更附录：
   - 数据基础变化：覆盖期对比
   - 关键假设变化：读旧 state["last_valuation"]["scenario"] vs 新 scenario
   - 估值变化桥接
   - 本次新发现 / 上次关注的验证
4. 覆盖 state.json
```

### 步骤4：事件驱动更新实操

```
暴雷事件 → 重点做：
  - 阶段3：资产质量重检（商誉减值、应收可收回性、质押物价值）
  - 阶段5：重跑 calc_risk_models.py（Z/M值可能剧变）

并购事件 → 重点做：
  - 阶段3：新增商誉评估、并表后的资产结构变化
  - 阶段6：如业务板块显著变化，改用SOTP估值
  - 轻量跑阶段2和4（新数据有限，主要验证整合逻辑）

重组/政策颠覆 → 重点做：
  - 阶段1：重新评估行业属性和竞争格局
  - 阶段6：重新评估永续增长率假设（政策可能改变行业天花板）

管理层换血（董事长被立案/CEO突然离职/财务总监更换） → 重点做：
  - 阶段1：重新评估管理层风险（management_risk + management_note更新）
  - 阶段5：检查是否有未披露的财务问题（重跑 calc_risk_models.py）
  - 整体：报告中加"管理层变动风险"醒目章节

审计师变更（从四大换到小所/临阵换审计） → 重点做：
  - 阶段1：检查是否触发致命信号（见SKILL.md阶段1致命信号）
  - 阶段5：重跑 calc_risk_models.py + Benford筛查
  - 整体：降低财务数据可信度至少一个层级

分红/回购政策重大变化：
  - 阶段4：重新评估现金流充裕度和分红可持续性
  - 阶段6：更新DDM估值参数（DPS增长假设）

再融资事件（增发/配股/可转债）：
  - 阶段3：更新股本、稀释EPS计算
  - 阶段6：重新运行 calc_valuation.py（股本变化影响每股价值）

ST/*ST风险警示：
  - 阶段1：加红框警告，标注具体原因
  - 阶段5：重新评估持续经营能力
  - 阶段6：估值降级为PB法，不依赖盈利预测
```

---

## 文件命名规则

增量更新后报告文件名**必须更新**为 `{公司简称}_{最新报告期}.md`，不保留旧文件名。

- 最新报告期 = 新数据中的最晚报告期（如 2026Q1 / 2026半年报 / 2026年报）
- state.json 同步更新 `last_period`、`last_qtr`、`last_report`
- 如果变化性质判断触发升级为标准更新，文件名取最新年报期（如 `_2025年报.md`）

## 边界情况处理

| 情况 | 处理 |
|------|------|
| state.json 缺字段（旧版本升级） | 标注缺失模块，该模块结论不复用，重新分析 |
| scenario 缺 admin_rate 等字段 | 回退到默认值（admin=0.035, rd=0.045, other=0.01） |
| data_snapshots 年份覆盖不足 | 从新提取的 _data.json 中补充缺失年份 |
| 旧场景的 WACC 或 g 超出合理范围 | 不直接复用，重新用CAPM计算WACC |
| 轻量更新时新季度数据比 state 中的更旧 | API可能未更新，提示用户等待或手动输入 |
| 估值bridge中某项delta无法计算 | 标注"Cannot decompose"，只报告总变化 |
| 指标数据缺失（脚本输出 null） | state.json 省略该字段，不写 null |
