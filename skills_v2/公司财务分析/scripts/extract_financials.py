"""
财务数据提取工具 v3.0 —— 基于 akshare API 的三张表结构化提取。

v3.0 变更：
  - 废弃 PDF/OCR 提取，改用 akshare（新浪财经数据源）作为唯一数据源
  - 三张表合计 300+ 字段，覆盖分析框架 95%+ 需求
  - 自动识别金融/非金融企业
  - 输出标准化 JSON + 可读摘要

使用方法：
    python scripts/extract_financials.py <股票代码> [--years 5]

示例：
    python scripts/extract_financials.py 002555          # 三七互娱
    python scripts/extract_financials.py 600519          # 贵州茅台
    python scripts/extract_financials.py 601318 --years 3  # 中国平安（最近3年）

依赖：
    pip install akshare pandas

数据来源：新浪财经（通过 akshare 封装），与东方财富/同花顺共享同一套 XBRL 底层数据。
"""

import sys
import json
import argparse
from pathlib import Path


# ── 配置 ──────────────────────────────────────────────────────────

# sina API 需要的股票代码格式：sz002555 / sh600519
def format_stock_code(code):
    """将任意格式的股票代码标准化为 sina 格式（szXXXXXX 或 shXXXXXX）。"""
    c = str(code).strip().upper().replace("SH", "").replace("SZ", "").replace("BJ", "").replace(".", "").replace(" ", "")
    c = "".join(ch for ch in c if ch.isdigit())
    if len(c) != 6:
        raise ValueError(f"无效股票代码: {code!r}（应为6位数字，如 600519 或 sh.600519）")
    if c.startswith(("6", "9")):
        return f"sh{c}"
    if c.startswith(("0", "3")):
        return f"sz{c}"
    raise ValueError(f"北交所或无法识别的代码: {code!r}（北交所暂不支持 akshare/Sina，请改用 WebSearch 数据源）")


# 金融企业识别特征科目（注：列名可能因 Sina API 版本而有细微差异）
# 保险特征
INSURANCE_BS_INDICATORS = [
    "保险合同准备金", "应收保费", "应收分保账款",
    "保险合同负债", "应付赔付款",
]
# 银行特征
BANK_BS_INDICATORS = [
    "发放贷款及垫款净额", "吸收存款",
    "存放中央银行款项", "向中央银行借款",
]
# 券商特征
BROKER_BS_INDICATORS = [
    "代理买卖证券款", "融出资金",
    "结算备付金", "买入返售金融资产",
    "衍生金融资产", "存出保证金",
]
# 金控集团：同时具有多个金融子行业特征，由阶段1 WebSearch 确认
# extract 层面不单独设金控检测——如同时触发保险+银行+券商中≥2类特征，标记为 FINANCIAL_HOLDING

# 附注层数据标签（API 无法提供，需 WebSearch 补充）
NOTES_DATA_CHECKLIST = [
    "受限资金金额及明细",
    "在建工程项目明细与预算",
    "大股东股权质押比例",
    "应收账款账龄结构与坏账计提比例",
    "商誉减值测试参数（折现率、增长率）",
    "研发投入资本化率",
    "关联交易明细与定价",
    "短期借款类型（信用/质押/抵押/保证）",
    "诉讼/或有负债",
]


# ── 核心提取函数 ──────────────────────────────────────────────────

def extract_all_data(stock_code, years=5, verbose=True):
    """
    从 akshare 提取三张表完整数据。
    返回: (company_type, data_dict, metadata)
    """
    try:
        import akshare as ak
        import pandas as pd
    except ImportError:
        print("# 错误: 需要安装 akshare", file=sys.stderr)
        print("# 运行: pip install akshare pandas", file=sys.stderr)
        sys.exit(1)

    try:
        sina_code = format_stock_code(stock_code)
    except ValueError as e:
        print(f"# 错误: {e}", file=sys.stderr)
        sys.exit(1)
    if verbose:
        print(f"# 股票代码: {sina_code}", file=sys.stderr)
        print(f"# 正在从新浪财经获取数据...", file=sys.stderr)

    all_data = {"利润表": None, "资产负债表": None, "现金流量表": None}
    errors = []

    # ── 提取利润表 ──
    try:
        df_pl = ak.stock_financial_report_sina(stock=sina_code, symbol="利润表")
        all_data["利润表"] = df_pl
        if verbose:
            print(f"# 利润表: {df_pl.shape[0]} 行 × {df_pl.shape[1]} 列", file=sys.stderr)
    except Exception as e:
        errors.append(f"利润表提取失败: {e}")

    # ── 提取资产负债表 ──
    try:
        df_bs = ak.stock_financial_report_sina(stock=sina_code, symbol="资产负债表")
        all_data["资产负债表"] = df_bs
        if verbose:
            print(f"# 资产负债表: {df_bs.shape[0]} 行 × {df_bs.shape[1]} 列", file=sys.stderr)
    except Exception as e:
        errors.append(f"资产负债表提取失败: {e}")

    # ── 提取现金流量表 ──
    try:
        df_cf = ak.stock_financial_report_sina(stock=sina_code, symbol="现金流量表")
        all_data["现金流量表"] = df_cf
        if verbose:
            print(f"# 现金流量表: {df_cf.shape[0]} 行 × {df_cf.shape[1]} 列", file=sys.stderr)
    except Exception as e:
        errors.append(f"现金流量表提取失败: {e}")

    if errors and verbose:
        print(f"\n# 警告: {len(errors)} 个提取错误:", file=sys.stderr)
        for e in errors:
            print(f"#   - {e}", file=sys.stderr)

    if all(df is None for df in all_data.values()):
        print("# 错误: 三张表全部提取失败（请检查股票代码/网络后重试）", file=sys.stderr)
        for e in errors:
            print(f"#   - {e}", file=sys.stderr)
        sys.exit(1)

    # ── 识别公司类型 ──
    company_type = detect_company_type(all_data)
    if verbose:
        print(f"\n# 公司类型: {company_type}", file=sys.stderr)

    # ── 获取可用报告期 ──
    periods = get_available_periods(all_data)
    if periods:
        if verbose:
            print(f"# 可用报告期: {len(periods)} 个（{periods[0]} ~ {periods[-1]}）", file=sys.stderr)
    else:
        print("# 错误: 未找到可用报告期", file=sys.stderr)
        sys.exit(1)

    # ── 提取关键年度数据 ──
    annual = extract_annual_snapshots(all_data, years, verbose=verbose)

    # ── 提取最新季度（如果晚于最新年报） ──
    latest_qtr = None
    latest_qtr_period = None
    annual_periods_set = {int(str(p)[:4]) for p in [k for k in annual.keys()]}
    all_periods = get_available_periods(all_data)
    for p in sorted(all_periods, reverse=True):
        year = int(str(p)[:4])
        if year not in annual_periods_set:
            latest_qtr = extract_single_period(all_data, p)
            if latest_qtr:
                latest_qtr_period = p
                if verbose:
                    print(f"# 最新季度: {p}", file=sys.stderr)
            break

    # ── 去年同季度快照（用于增量更新同比） ──
    prev_year_qtr = None
    if latest_qtr_period is not None:
        prev_int = int(str(latest_qtr_period)) - 10000
        for q in all_periods:
            if int(str(q)) == prev_int:
                prev_year_qtr = extract_single_period(all_data, q)
                if verbose and prev_year_qtr:
                    print(f"# 去年同季度: {q}", file=sys.stderr)
                break

    # ── 历史年末收盘价（用于Z值X4逐年计算，与财报同源的新浪行情接口） ──
    year_end_prices = {}
    try:
        min_y, max_y = min(int(y) for y in annual), max(int(y) for y in annual)
        df_px = ak.stock_zh_a_daily(symbol=sina_code, start_date=f"{min_y}0101", end_date=f"{max_y}1231", adjust="")
        df_px["date"] = df_px["date"].astype(str)
        for y in annual:
            yr = int(y)
            sub = df_px[(df_px["date"] >= f"{yr}-01-01") & (df_px["date"] <= f"{yr}-12-31")]
            if not sub.empty:
                year_end_prices[y] = float(sub.iloc[-1]["close"])
        if verbose and year_end_prices:
            print(f"# 历史年末收盘价: {len(year_end_prices)} 年", file=sys.stderr)
    except Exception as e:
        if verbose:
            print(f"# 警告: 历史价格获取失败（Z值X4将用当前市值近似）: {e}", file=sys.stderr)

    return company_type, annual, latest_qtr, prev_year_qtr, {
        "stock_code": sina_code,  # sina格式: sh600519 / sz002555
        "sina_code": sina_code,
        "company_type": company_type,
        "periods_count": len(periods),
        "periods_range": f"{periods[0]} ~ {periods[-1]}" if periods else "N/A",
        "errors": errors,
        "year_end_prices": year_end_prices,
        "notes_checklist": NOTES_DATA_CHECKLIST,
    }


def detect_company_type(data):
    """
    通过资产负债表科目识别金融/非金融企业。
    关键：不仅检查列是否存在，还要检查这些列在最新报告期是否有实际非零数据。
    """
    import pandas as pd
    df_bs = data.get("资产负债表")
    if df_bs is None:
        return "UNKNOWN"

    # 取年报数据检测（不是仅取最新一条，而是检查所有年报中是否有数据）
    annual_periods = sorted([p for p in df_bs["报告日"].unique() if str(p).endswith("1231")], reverse=True)
    if not annual_periods:
        annual_periods = [df_bs["报告日"].iloc[0]]
    check_periods = annual_periods[:3]  # 最近3年年报

    # 保险特征：检查关键保险科目在任何年报中是否有非零数值
    insurance_score = 0
    for col in INSURANCE_BS_INDICATORS:
        if col not in df_bs.columns:
            continue
        for period in check_periods:
            row = df_bs[df_bs["报告日"] == period]
            if row.empty:
                continue
            val = row[col].values[0]
            try:
                if not pd.isna(val) and abs(float(val)) > 1e6:
                    insurance_score += 1
                    break
            except (ValueError, TypeError):
                continue

    # 银行特征
    bank_score = 0
    for col in BANK_BS_INDICATORS:
        if col not in df_bs.columns:
            continue
        for period in check_periods:
            row = df_bs[df_bs["报告日"] == period]
            if row.empty:
                continue
            val = row[col].values[0]
            try:
                if not pd.isna(val) and abs(float(val)) > 1e6:
                    bank_score += 1
                    break
            except (ValueError, TypeError):
                continue

    # 券商特征
    broker_score = 0
    for col in BROKER_BS_INDICATORS:
        if col not in df_bs.columns:
            continue
        for period in check_periods:
            row = df_bs[df_bs["报告日"] == period]
            if row.empty:
                continue
            val = row[col].values[0]
            try:
                if not pd.isna(val) and abs(float(val)) > 1e6:
                    broker_score += 1
                    break
            except (ValueError, TypeError):
                continue

    # 金控集团：同时触发≥2类金融特征
    scores = {"保险": insurance_score, "银行": bank_score, "券商": broker_score}
    multi_types = [k for k, v in scores.items() if v >= 2]
    if len(multi_types) >= 2:
        return "FINANCIAL_HOLDING"
    elif insurance_score >= 2:
        return "INSURANCE"
    elif bank_score >= 2:
        return "BANK"
    elif broker_score >= 2:
        return "BROKER"
    else:
        return "GENERAL"


def get_available_periods(data):
    """获取所有可用报告期（去重排序）。"""
    periods = set()
    for df in data.values():
        if df is not None and "报告日" in df.columns:
            periods.update(df["报告日"].dropna().unique())
    return sorted(periods, reverse=True)


def extract_single_period(data, period):
    """提取单个报告期的数据（用于最新季度）。"""
    import pandas as pd
    result = {}
    for table_name, df in data.items():
        if df is None: continue
        row = df[df["报告日"] == period]
        if row.empty: continue
        row_dict = {}
        for col in df.columns:
            if col in ("报告日", "报表来源", "是否审计", "币种", "公告日期", "公司代码", "公司简称", "备注"):
                continue
            val = row[col].values[0]
            if pd.isna(val):
                row_dict[col] = 0.0  # 报表空行=0，与"列缺失=数据不可得"区分
                continue
            try:
                num_val = float(val)
                row_dict[col] = num_val
            except (ValueError, TypeError): continue
        result[table_name] = row_dict
    return result if result else None


def extract_annual_snapshots(data, years, verbose=True):
    """
    从完整数据中提取最近 N 年的年报快照。
    返回结构: {年份: {报表名: {科目: 值}}}
    金额单位: 元（原始值）
    """
    import pandas as pd

    periods = get_available_periods(data)
    # 只取年报（12-31）
    annual_periods = [p for p in periods if str(p).endswith("1231")]
    annual_periods = annual_periods[:years]  # 最近 N 年

    if not annual_periods:
        print("# 警告: 未找到年报数据", file=sys.stderr)
        return {}

    if verbose:
        print(f"# 提取年报: {annual_periods}", file=sys.stderr)

    result = {}
    for period in sorted(annual_periods):
        year = int(str(period)[:4])
        year_data = {}
        for table_name, df in data.items():
            if df is None:
                continue
            # 筛选该报告期的数据
            row = df[df["报告日"] == period]
            if row.empty:
                continue
            # 提取所有非 NaN 的科目数值
            row_dict = {}
            for col in df.columns:
                if col in ("报告日", "报表来源", "是否审计", "币种", "公告日期", "公司代码", "公司简称", "备注"):
                    continue
                val = row[col].values[0]
                if pd.isna(val):
                    row_dict[col] = 0.0  # 报表空行=0（如无短期借款），与"列缺失=数据不可得"区分
                    continue
                try:
                    num_val = float(val)
                    row_dict[col] = num_val
                except (ValueError, TypeError):
                    # 跳过非数值列（如日期字符串）
                    continue
            year_data[table_name] = row_dict
        result[year] = year_data

    return result


# ── 格式化输出 ─────────────────────────────────────────────────────

def format_amount(val):
    """将金额格式化为可读字符串（亿/万）。"""
    if val is None:
        return "N/A"
    abs_val = abs(val)
    if abs_val >= 1e8:
        return f"{val/1e8:.2f}亿"
    elif abs_val >= 1e4:
        return f"{val/1e4:.2f}万"
    else:
        return f"{val:.2f}"


def print_summary(company_type, annual_data, metadata):
    """打印人类可读的数据摘要。"""
    print("\n" + "=" * 70)
    print("数据提取摘要")
    print("=" * 70)
    print(f"股票代码: {metadata['stock_code']}")
    print(f"公司类型: {company_type}")
    print(f"年报数量: {len(annual_data)}")

    # 打印关键指标
    key_pl_items = ["营业收入", "营业成本", "销售费用", "管理费用", "研发费用",
                    "财务费用", "投资收益", "营业利润", "利润总额", "净利润",
                    "归属于母公司所有者的净利润", "基本每股收益"]
    key_bs_items = ["资产总计", "货币资金", "应收账款", "存货", "商誉",
                    "短期借款", "长期借款", "合同负债",
                    "归属于母公司股东权益合计", "负债合计"]
    key_cf_items = ["经营活动产生的现金流量净额", "投资活动产生的现金流量净额",
                    "筹资活动产生的现金流量净额",
                    "销售商品、提供劳务收到的现金",
                    "购建固定资产、无形资产和其他长期资产所支付的现金"]

    if company_type in ("INSURANCE", "BANK"):
        key_pl_items.extend(["保险服务收入", "利息收入", "手续费及佣金收入"])
        key_bs_items.extend(["保险合同负债", "发放贷款及垫款", "吸收存款"])

    for table_name, items in [("利润表", key_pl_items),
                               ("资产负债表", key_bs_items),
                               ("现金流量表", key_cf_items)]:
        print(f"\n### {table_name} 关键科目")
        print(f"{'科目':<28}", end="")
        for year in sorted(annual_data.keys()):
            print(f"{year:>14}", end="")
        print()
        print("-" * (28 + 14 * len(annual_data)))

        for item in items:
            print(f"{item:<28}", end="")
            for year in sorted(annual_data.keys()):
                val = annual_data[year].get(table_name, {}).get(item)
                if val is not None:
                    print(f"{format_amount(val):>14}", end="")
                else:
                    print(f"{'N/A':>14}", end="")
            print()

    # 附注数据提醒
    print("\n" + "-" * 70)
    print("以下数据 API 无法提供，需从年报附注或 WebSearch 补充：")
    for i, note in enumerate(metadata["notes_checklist"], 1):
        print(f"  {i}. {note}")

    print("\n" + "=" * 70)
    print("数据可信度: L1 (新浪财经 API，与交易所XBRL数据一致)")
    print("需交叉验证: 归母净利润、EPS、总资产、营收（用 WebSearch）")
    print("=" * 70)


# ── 主程序 ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="从 akshare API 提取 A 股上市公司三张表数据"
    )
    parser.add_argument(
        "stock_code",
        help="股票代码（6位数字），如 002555、600519",
    )
    parser.add_argument(
        "--years", type=int, default=5,
        help="提取最近几年的年报数据（默认5年）",
    )
    parser.add_argument(
        "--json-only", action="store_true",
        help="仅输出 JSON（不打印可读摘要）",
    )
    parser.add_argument(
        "--output", "-o",
        help="JSON 输出文件路径",
    )
    args = parser.parse_args()

    # 提取数据
    company_type, annual_data, latest_quarter, prev_year_quarter, metadata = extract_all_data(
        args.stock_code, args.years, verbose=not args.json_only
    )

    # 构建 JSON 输出
    output = {
        "metadata": metadata,
        "company_type": company_type,
        "annual_data": annual_data,
    }
    if latest_quarter:
        output["latest_quarter"] = latest_quarter
    if prev_year_quarter:
        output["prev_year_quarter"] = prev_year_quarter

    # 打印摘要（除非 --json-only）
    json_str = json.dumps(output, ensure_ascii=True, indent=2, default=str)
    if args.output:
        Path(args.output).write_text(json_str, encoding="utf-8")
        if not args.json_only:
            print(f"\n# JSON 已保存至: {args.output}")
    elif not args.json_only:
        print_summary(company_type, annual_data, metadata)
        print("\n# JSON 输出:")
        print(json_str)
    else:
        # --json-only: only JSON to stdout
        print(json_str)


if __name__ == "__main__":
    main()
