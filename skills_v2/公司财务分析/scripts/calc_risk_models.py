"""
财务风险模型计算工具 v1.0 —— Z值、M-Score、AG 预警、Benford 筛查

用法：
    python calc_risk_models.py data.json [ratios.json]
    python calc_risk_models.py data.json ratios.json --output risk.json
"""

import sys
import json
import argparse
import math
from pathlib import Path
from collections import Counter


def load_json(source):
    if source == "-":
        return json.load(sys.stdin)
    return json.load(open(source, encoding="utf-8"))


def get_val(annual, year, table, field):
    try:
        return annual.get(str(year), {}).get(table, {}).get(field)
    except Exception:
        return None


def derive_shares(annual):
    """从 EPS 和 归母净利润反推总股本（与 calc_valuation 同法）。"""
    est = []
    for ys in annual.keys():
        np_val = get_val(annual, ys, "利润表", "归属于母公司所有者的净利润") or get_val(annual, ys, "利润表", "净利润")
        eps = get_val(annual, ys, "利润表", "基本每股收益")
        if np_val and eps and eps > 0:
            est.append(abs(np_val / eps))
    return sorted(est)[len(est)//2] if est else None


def calc_altman_z(data):
    """Altman Z-Score（仅适用于 GENERAL 类型企业）。"""
    annual = data["annual_data"]
    if data.get("company_type") not in ("GENERAL", "UNKNOWN"):
        return {"error": "Z-Score 不适用于金融企业", "skipped": True}

    # 需要市值数据（用户提供或估算）
    # 此处仅计算可用的中间变量，Z 值由分析时补充市值后最终确定
    results = {}
    for year_str in sorted(annual.keys()):
        y = int(year_str)
        rev = get_val(annual, y, "利润表", "营业收入")
        p_np = get_val(annual, y, "利润表", "归属于母公司所有者的净利润")
        ebit = get_val(annual, y, "利润表", "营业利润")
        fin_exp = get_val(annual, y, "利润表", "财务费用")
        ta = get_val(annual, y, "资产负债表", "资产总计")
        tl = get_val(annual, y, "资产负债表", "负债合计")
        ca = get_val(annual, y, "资产负债表", "流动资产合计")
        cl = get_val(annual, y, "资产负债表", "流动负债合计")
        pe = get_val(annual, y, "资产负债表", "归属于母公司股东权益合计")
        re_val = get_val(annual, y, "资产负债表", "未分配利润")

        # X1 = 营运资金 / 总资产
        wc = (ca - cl) if ca is not None and cl is not None else None
        x1 = wc / ta if wc is not None and ta else None
        # X2 = 留存收益 / 总资产
        x2 = re_val / ta if re_val is not None and ta else None
        # X3 = EBIT / 总资产
        ebit_val = (ebit or 0) + (fin_exp or 0) if ebit is not None else None
        x3 = ebit_val / ta if ebit_val is not None and ta else None
        # X4, X5
        x5 = rev / ta if rev is not None and ta else None

        results[y] = {
            "x1_wc_ta": x1,
            "x2_re_ta": x2,
            "x3_ebit_ta": x3,
            "x5_sales_ta": x5,
            "requires_market_cap": True,
            "note": "X4 需要市值数据，由分析阶段补充。使用 Z = 1.2*X1 + 1.4*X2 + 3.3*X3 + 0.6*X4 + 0.999*X5",
        }

    return results


def calc_m_score(data):
    """Beneish M-Score（8 变量），仅适用于 GENERAL 类型企业。"""
    annual = data["annual_data"]
    if data.get("company_type") not in ("GENERAL", "UNKNOWN"):
        return {"error": "M-Score 不适用于金融企业", "skipped": True}

    years = sorted(annual.keys())
    results = {}

    for i in range(1, len(years)):
        y = int(years[i])
        py = int(years[i - 1])

        rev = get_val(annual, y, "利润表", "营业收入")
        prev_rev = get_val(annual, py, "利润表", "营业收入")
        cogs = get_val(annual, y, "利润表", "营业成本")
        prev_cogs = get_val(annual, py, "利润表", "营业成本")
        ar = get_val(annual, y, "资产负债表", "应收账款")
        prev_ar = get_val(annual, py, "资产负债表", "应收账款")
        sell = get_val(annual, y, "利润表", "销售费用")
        admin = get_val(annual, y, "利润表", "管理费用")
        prev_sell = get_val(annual, py, "利润表", "销售费用")
        prev_admin = get_val(annual, py, "利润表", "管理费用")
        ta = get_val(annual, y, "资产负债表", "资产总计")
        tl = get_val(annual, y, "资产负债表", "负债合计")
        prev_ta = get_val(annual, py, "资产负债表", "资产总计")
        prev_tl = get_val(annual, py, "资产负债表", "负债合计")
        np_val = get_val(annual, y, "利润表", "净利润") or get_val(annual, y, "利润表", "归属于母公司所有者的净利润")
        oper_cf = get_val(annual, y, "现金流量表", "经营活动产生的现金流量净额")
        ca = get_val(annual, y, "资产负债表", "流动资产合计")
        fa = get_val(annual, y, "资产负债表", "固定资产")

        # DSRI: Days Sales in Receivables Index
        dsr_y = ar / rev if ar and rev else None
        dsr_py = prev_ar / prev_rev if prev_ar and prev_rev else None
        dsri = dsr_y / dsr_py if dsr_y and dsr_py else None

        # GMI: Gross Margin Index
        gm_y = (rev - cogs) / rev if rev and cogs else None
        gm_py = (prev_rev - prev_cogs) / prev_rev if prev_rev and prev_cogs else None
        gmi = gm_py / gm_y if gm_y and gm_py else None

        # AQI: Asset Quality Index
        # 1 - [(CA_t + FA_t + Other) / TA_t] / [(CA_{t-1} + FA_{t-1} + Other) / TA_{t-1}]
        non_ca_ratio_y = (ta - ca) / ta if ta and ca else None
        non_ca_ratio_py = (prev_ta - get_val(annual, py, "资产负债表", "流动资产合计")) / prev_ta if prev_ta else None
        aqi = non_ca_ratio_y / non_ca_ratio_py if non_ca_ratio_y and non_ca_ratio_py else None

        # SGI: Sales Growth Index
        sgi = rev / prev_rev if rev and prev_rev else None

        # SGAI: SGA Expense Index
        sga_y = (sell + admin) / rev if sell and admin and rev else None
        sga_py = (prev_sell + prev_admin) / prev_rev if prev_sell and prev_admin and prev_rev else None
        sgai = sga_y / sga_py if sga_y and sga_py else None

        # LVGI: Leverage Index
        lvg_y = tl / ta if tl and ta else None
        lvg_py = prev_tl / prev_ta if prev_tl and prev_ta else None
        lvgi = lvg_y / lvg_py if lvg_y and lvg_py else None

        # TATA: Total Accruals to Total Assets（不是指数，是当前值）
        tata = (np_val - oper_cf) / ta if np_val and oper_cf and ta else None

        # DEPI: 折旧率指数 = (上年折旧/(上年折旧+上年固定资产)) / (当年折旧/(当年折旧+当年固定资产))
        depi = 1.0
        depi_note = "折旧字段缺失，DEPI按中性值1.0处理"
        dep_y = get_val(annual, y, "现金流量表", "固定资产折旧、油气资产折耗、生产性生物资产折旧")
        dep_py = get_val(annual, py, "现金流量表", "固定资产折旧、油气资产折耗、生产性生物资产折旧")
        ppe_y = get_val(annual, y, "资产负债表", "固定资产")
        ppe_py = get_val(annual, py, "资产负债表", "固定资产")
        if all([dep_y, dep_py, ppe_y, ppe_py]):
            rate_y = abs(dep_y) / (abs(dep_y) + abs(ppe_y)) if (abs(dep_y) + abs(ppe_y)) != 0 else None
            rate_py = abs(dep_py) / (abs(dep_py) + abs(ppe_py)) if (abs(dep_py) + abs(ppe_py)) != 0 else None
            if rate_y and rate_py and rate_y != 0:
                depi = rate_py / rate_y
                depi_note = None

        # AQI 如不可计算取 1.0
        aqi_val = aqi if aqi else 1.0
        m_score = None
        if all([dsri, gmi, sgi, sgai, lvgi, tata is not None]):
            m_score = (-4.84 + 0.92 * dsri + 0.528 * gmi + 0.404 * aqi_val
                       + 0.892 * sgi + 0.115 * depi - 0.172 * sgai
                       + 4.679 * tata - 0.327 * lvgi)

        results[y] = {
            "dsri": dsri,
            "gmi": gmi,
            "aqi": aqi_val,
            "sgi": sgi,
            "depi": depi,
            "depi_note": depi_note,
            "sgai": sgai,
            "lvgi": lvgi,
            "tata": tata,
            "m_score": m_score,
            "risk_flag": ("HIGH (> -1.78)" if m_score is not None and m_score > -1.78
                          else ("LOW" if m_score is not None else "N/A (数据不足)")),
        }

        # 单项预警
        warnings = []
        if dsri and dsri > 1.2:
            warnings.append(f"DSRI={dsri:.3f}>1.2: AR增长快于销售")
        if gmi and gmi > 1.1:
            warnings.append(f"GMI={gmi:.3f}>1.1: 毛利率恶化→操纵动机增强")
        if aqi and aqi > 1.2:
            warnings.append(f"AQI={aqi:.3f}>1.2: 资产质量指数偏高")
        if sgi and sgi > 1.5:
            warnings.append(f"SGI={sgi:.3f}>1.5: 高速增长→业绩压力")
        if lvgi and lvgi > 1.1:
            warnings.append(f"LVGI={lvgi:.3f}>1.1: 杠杆上升→债务契约压力")
        results[y]["warnings"] = warnings

    return results


def calc_ag(data):
    """总资产增长率（AG）分析。"""
    annual = data["annual_data"]
    years = sorted(annual.keys())
    ag_values = {}

    for i in range(1, len(years)):
        y = int(years[i])
        py = int(years[i - 1])
        ta = get_val(annual, y, "资产负债表", "资产总计")
        prev_ta = get_val(annual, py, "资产负债表", "资产总计")
        ag = (ta - prev_ta) / prev_ta if ta and prev_ta else None
        ag_values[y] = ag

    three_yr_avg = sum(v for v in ag_values.values() if v) / max(1, sum(1 for v in ag_values.values() if v))

    risk = "NORMAL"
    if three_yr_avg > 0.5:
        risk = "EXTREME"
    elif three_yr_avg > 0.3:
        risk = "HIGH"
    elif three_yr_avg > 0.2:
        risk = "WARNING"
    elif three_yr_avg > 0.1:
        risk = "CONCERN"

    return {
        "annual_ag": ag_values,
        "three_year_avg": three_yr_avg,
        "risk_level": risk,
        "reference": "Cooper et al. (2008): AG与未来股票收益率强负相关",
    }


def calc_benford(values, label="data"):
    """Benford 第一数字定律检测。"""
    if len(values) < 30:
        return {"error": f"样本量 {len(values)} < 30，不适用 Benford 定律", "skipped": True}

    # 提取首位数字
    first_digits = []
    for v in values:
        if v and v > 0:
            s = f"{abs(v):.0f}"
            first_digits.append(int(s[0]))

    if len(first_digits) < 30:
        return {"error": "有效数字不足", "skipped": True}

    # 实际分布
    counter = Counter(first_digits)
    actual = {d: counter.get(d, 0) / len(first_digits) for d in range(1, 10)}

    # 理论分布
    expected = {d: math.log10(1 + 1 / d) for d in range(1, 10)}

    # 偏差
    deviations = {d: actual[d] - expected[d] for d in range(1, 10)}
    max_dev = max(abs(v) for v in deviations.values())

    return {
        "sample_size": len(first_digits),
        "actual_distribution": actual,
        "expected_distribution": expected,
        "deviations": deviations,
        "max_deviation": max_dev,
        "assessment": "关注" if max_dev > 0.15 else "正常",
    }


def str_keys(obj):
    """递归转换所有dict键为字符串（JSON兼容）。"""
    if isinstance(obj, dict):
        return {str(k): str_keys(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [str_keys(v) for v in obj]
    return obj


def main():
    parser = argparse.ArgumentParser(description="财务风险模型计算")
    parser.add_argument("data_json", help="extract_financials.py 输出的 JSON")
    parser.add_argument("-o", "--output", help="输出 JSON 文件路径")
    parser.add_argument("--market-cap", type=float, help="总市值（亿元），用于Z值X4计算。从WebSearch获取最新市值")
    parser.add_argument("--benford", action="store_true", help="运行 Benford 筛查")
    args = parser.parse_args()

    data = load_json(args.data_json)

    z_result = calc_altman_z(data)
    # 如有市值，补全Z值（历史年份优先用当年年末收盘价）
    if args.market_cap and not z_result.get("skipped"):
        hist_px = (data.get("metadata") or {}).get("year_end_prices") or {}
        shares = derive_shares(data["annual_data"]) if hist_px else None
        for y_int, comp in z_result.items():
            if isinstance(comp, dict) and comp.get("requires_market_cap"):
                tl = get_val(data["annual_data"], y_int, "资产负债表", "负债合计")
                if tl and tl != 0:
                    price = hist_px.get(str(y_int))
                    if price and shares:
                        mkt = price * shares
                        comp["x4_source"] = "year_end_price"
                        comp["shares_used"] = shares
                    else:
                        mkt = args.market_cap * 1e8
                        comp["x4_source"] = "current_market_cap_approx"
                        comp["x4_note"] = "历史年末价格不可得，X4用当前市值近似，趋势解读受限"
                    x4 = mkt / tl
                    comp["x4_mve_tl"] = x4
                    comp["market_cap_used"] = args.market_cap
                    x1 = comp.get("x1_wc_ta") or 0
                    x2 = comp.get("x2_re_ta") or 0
                    x3 = comp.get("x3_ebit_ta") or 0
                    x5 = comp.get("x5_sales_ta") or 0
                    z = 1.2*x1 + 1.4*x2 + 3.3*x3 + 0.6*x4 + 0.999*x5
                    comp["z_score"] = z
                    comp["z_status"] = "SAFE" if z > 2.675 else ("GREY" if z > 1.81 else "HIGH RISK")

    output = {
        "z_score": z_result,
        "m_score": calc_m_score(data),
        "ag_analysis": calc_ag(data),
    }

    # Benford 筛查（可选，较耗时）
    if args.benford:
        annual = data["annual_data"]
        # 提取所有利润表科目的最新年报数值
        latest_year = sorted(annual.keys())[-1]
        pl_values = list(annual[latest_year].get("利润表", {}).values())
        output["benford_pl"] = calc_benford(pl_values, "利润表科目")

        bs_values = list(annual[latest_year].get("资产负债表", {}).values())
        output["benford_bs"] = calc_benford(bs_values, "资产负债表科目")

    output = str_keys(output)
    json_str = json.dumps(output, ensure_ascii=True, indent=2, default=str)

    if args.output:
        Path(args.output).write_text(json_str, encoding="utf-8")
        print(f"# 风险模型结果已保存至: {args.output}", file=sys.stderr)
    else:
        print(json_str)


if __name__ == "__main__":
    main()
