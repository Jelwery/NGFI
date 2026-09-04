"""
估值计算工具 v1.1 —— DCF 三情景 + RIM + 相对估值 + 敏感性矩阵
所有公司特定值从输入数据推导。预测假设通过 --scenario-file 传入（必传）。

用法：
    python calc_valuation.py data.json --scenario-file scenario.json
    python calc_valuation.py data.json -s scenario.json -o valuation.json
    python calc_valuation.py data.json -s scenario.json --peer-pe 16 --rf 0.025
"""

import sys, json, argparse
from pathlib import Path

# ── helpers ──────────────────────────────────────────────────────

def load_json(src):
    return json.load(open(src, encoding="utf-8")) if src != "-" else json.load(sys.stdin)

def gv(annual, yr, tbl, fld):
    try: return annual[str(yr)].get(tbl, {}).get(fld)
    except: return None

def sd(a, b):
    return a / b if a is not None and b else None

def median(vals):
    s = sorted(v for v in vals if v is not None)
    if not s: return None
    return s[len(s)//2]

def str_keys(obj):
    if isinstance(obj, dict): return {str(k): str_keys(v) for k, v in obj.items()}
    if isinstance(obj, list): return [str_keys(v) for v in obj]
    return obj

# ── 数据推导函数 ──────────────────────────────────────────────────

def derive_shares(annual):
    """从 EPS 和 净利润 反推总股本。"""
    years = sorted(annual.keys())
    shares_estimates = []
    for ys in years:
        np_val = gv(annual, ys, "利润表", "归属于母公司所有者的净利润") or gv(annual, ys, "利润表", "净利润")
        eps = gv(annual, ys, "利润表", "基本每股收益")
        if np_val and eps and eps > 0:
            shares_estimates.append(abs(np_val / eps))
    if shares_estimates:
        return median(shares_estimates)
    # fallback: 实收资本
    for ys in years:
        sc = gv(annual, ys, "资产负债表", "实收资本(或股本)")
        if sc: return sc
    return None

def derive_tax_rate(annual):
    """近3年 所得税/利润总额 的中位数。"""
    years = sorted(annual.keys())
    rates = []
    for ys in years:
        tax = gv(annual, ys, "利润表", "所得税费用")
        tp = gv(annual, ys, "利润表", "利润总额")
        if tax is not None and tp and tp != 0:
            r = tax / tp
            if 0 < r < 1:
                rates.append(r)
    return median(rates) if rates else None

# ── DCF ───────────────────────────────────────────────────────────

def derive_depr(annual, years, rev_latest):
    """折旧推导：优先CF表字段 → 回退BS累计折旧差分 → 最后才用明确假设。"""
    depr_source = "cf_statement"
    depr_vals = []
    for ys in years:
        dp = gv(annual, ys, "现金流量表", "固定资产折旧、油气资产折耗、生产性生物资产折旧")
        if dp: depr_vals.append(abs(dp))
    if not depr_vals:
        diffs = []
        sy = sorted([int(y) for y in years])
        for i in range(1, len(sy)):
            a0 = gv(annual, sy[i-1], "资产负债表", "累计折旧")
            a1 = gv(annual, sy[i], "资产负债表", "累计折旧")
            if a0 is not None and a1 is not None and a1 > a0:
                diffs.append(a1 - a0)
        if diffs:
            depr_vals = diffs
            depr_source = "bs_acc_dep_diff"
    if depr_vals:
        avg_depr = sum(depr_vals) / len(depr_vals)
    else:
        avg_depr = rev_latest * 0.02
        depr_source = "assumed_2pct_revenue"
    return avg_depr, depr_source, avg_depr / rev_latest


def derive_nwc_rate(annual, years):
    """NWC变动率：多年平均ΔNWC/ΔRev。结果不合理或数据不足时保守取0。"""
    sorted_ys = sorted([int(y) for y in years])
    rates = []
    for i in range(1, len(sorted_ys)):
        y1, y0 = sorted_ys[i], sorted_ys[i-1]
        ar1 = gv(annual, y1, "资产负债表", "应收账款") or 0
        ar0 = gv(annual, y0, "资产负债表", "应收账款") or 0
        inv1 = gv(annual, y1, "资产负债表", "存货") or 0
        inv0 = gv(annual, y0, "资产负债表", "存货") or 0
        ap1 = gv(annual, y1, "资产负债表", "应付账款") or 0
        ap0 = gv(annual, y0, "资产负债表", "应付账款") or 0
        rev1 = gv(annual, y1, "利润表", "营业收入") or 0
        rev0 = gv(annual, y0, "利润表", "营业收入") or 0
        d_nwc = (ar1 - ar0) + (inv1 - inv0) - (ap1 - ap0)
        d_rev = rev1 - rev0
        if abs(d_rev) > rev0 * 0.01:  # 排除收入几乎不变的年份（噪声大）
            r = d_nwc / d_rev
            if 0 < r < 0.1:  # 仅接受小而正的NWC/Rev比率（收入增长需少量NWC支撑）
                rates.append(r)
    return sum(rates) / len(rates) if rates else 0.0


def calc_dcf(data, scenarios):
    annual = data["annual_data"]
    years = sorted(annual.keys())
    latest_year = int(years[-1])
    ct = data.get("company_type", "GENERAL")
    if ct in ("INSURANCE", "BANK", "BROKER", "FINANCIAL_HOLDING"):
        return {"skipped": True, "reason": "金融企业用行业专属方法（保险P/EV+DDM、银行/券商PB+DDM+PE、金控SOTP），标准DCF不适用"}

    rev_latest = gv(annual, latest_year, "利润表", "营业收入")
    if not rev_latest:
        return {"error": "营业收入数据缺失，估值跳过"}

    # 数据推导值
    total_shares = derive_shares(annual)
    if total_shares is None:
        return {"error": "无法推导总股本，请提供 --shares 参数"}
    tax_derived = derive_tax_rate(annual)
    tax_rate = tax_derived if tax_derived is not None else 0.15
    tax_source = "derived" if tax_derived is not None else "assumed_0.15"

    # capex: 取最近年报实际值；缺失时用营收2%假设（须披露）
    capex_vals = []
    for ys in years:
        cx = gv(annual, ys, "现金流量表", "购建固定资产、无形资产和其他长期资产所支付的现金")
        if cx: capex_vals.append(abs(cx))
    if capex_vals:
        avg_capex = sum(capex_vals) / len(capex_vals)
        capex_source = "cf_statement"
    else:
        avg_capex = rev_latest * 0.02
        capex_source = "assumed_2pct_revenue"

    avg_depr, depr_source, avg_depr_rate = derive_depr(annual, years, rev_latest)

    # BS调整项（完整口径：负债含应付债券/一年内到期非流动负债/租赁负债；金融资产含一年内到期非流动资产/其他权益工具投资）
    cash_val = gv(annual, latest_year, "资产负债表", "货币资金") or 0
    debt_val = ((gv(annual, latest_year, "资产负债表", "短期借款") or 0)
              + (gv(annual, latest_year, "资产负债表", "长期借款") or 0)
              + (gv(annual, latest_year, "资产负债表", "应付债券") or 0)
              + (gv(annual, latest_year, "资产负债表", "一年内到期的非流动负债") or 0)
              + (gv(annual, latest_year, "资产负债表", "租赁负债") or 0))
    fin_assets = ((gv(annual, latest_year, "资产负债表", "交易性金融资产") or 0)
                + (gv(annual, latest_year, "资产负债表", "长期股权投资") or 0)
                + (gv(annual, latest_year, "资产负债表", "其他非流动金融资产") or 0)
                + (gv(annual, latest_year, "资产负债表", "投资性房地产") or 0)
                + (gv(annual, latest_year, "资产负债表", "一年内到期的非流动资产") or 0)
                + (gv(annual, latest_year, "资产负债表", "其他权益工具投资") or 0))
    nwc_change_rate = derive_nwc_rate(annual, years)

    results = {}
    for name, s in scenarios.items():
        rev = rev_latest
        total_pv_fcf = 0
        details = []
        for i in range(5):
            yr = latest_year + i + 1
            rev = rev * (1 + s["rev_growth"][i])
            gm = s["gm"][i]
            cogs = rev * (1 - gm)
            sm = rev * s["sm_rate"][i] if isinstance(s["sm_rate"], list) else rev * s["sm_rate"]
            admin = rev * s["admin_rate"] if isinstance(s.get("admin_rate"), (int, float)) else rev * 0.035
            rd = rev * s["rd_rate"] if isinstance(s.get("rd_rate"), (int, float)) else rev * 0.045
            other = rev * s.get("other_inc_rate", 0.01)
            tax_surch = rev * s.get("tax_surcharge_rate", 0.0)
            ebitda = rev - cogs - sm - admin - rd + other - tax_surch
            # 周期股/重资产特化：scenario 可显式指定年均折旧与年均capex（如保全性capex），否则回退脚本推导
            # depr_in_cogs=true（中国准则报表口径）：营业成本已含折旧摊销，scenario的gm即含D&A后毛利率，
            # ebit 直接用 ebitda（不再重复扣折旧），FCFF 再按实际 D&A 全额加回（tax shield 经 nopat 体现）
            s_depr = s.get("depr_annual")
            depr_in_cogs = s.get("depr_in_cogs", False)
            if isinstance(s_depr, (int, float)) and s_depr > 0:
                depr = s_depr
                ebit = ebitda if depr_in_cogs else ebitda - depr
            else:
                depr = rev * avg_depr_rate
                ebit = ebitda - depr
            nopat = ebit * (1 - tax_rate)
            s_capex = s.get("capex_annual")
            capex = s_capex if isinstance(s_capex, (int, float)) and s_capex > 0 else avg_capex * (rev / rev_latest)
            nwc_change = s["rev_growth"][i] * rev * nwc_change_rate
            fcff = nopat + depr - capex - nwc_change
            pv = fcff / ((1 + s["wacc"]) ** (i + 1))
            total_pv_fcf += pv
            details.append({"year": yr, "revenue": rev, "ebit": ebit, "fcff": fcff, "pv_fcff": pv})

        last_fcff = details[-1]["fcff"]
        tv = last_fcff * (1 + s["term_g"]) / (s["wacc"] - s["term_g"])
        pv_tv = tv / ((1 + s["wacc"]) ** 5)
        ev = total_pv_fcf + pv_tv
        s_nfa = s.get("nfa_addback")
        nfa_add = s_nfa if isinstance(s_nfa, (int, float)) and s_nfa > 0 else (cash_val + fin_assets - debt_val)
        eq = ev + nfa_add
        minority = gv(annual, latest_year, "资产负债表", "少数股东权益")
        parent_eq_val = gv(annual, latest_year, "资产负债表", "归属于母公司股东权益合计")
        if minority is not None and parent_eq_val and (minority + parent_eq_val):
            minority_ratio = minority / (minority + parent_eq_val)
            minority_source = "derived"
        else:
            minority_ratio = 0.02
            minority_source = "assumed_0.02"
        eq_adj = eq * (1 - minority_ratio)
        per_share = eq_adj / total_shares
        capex_src = "scenario_override" if isinstance(s.get("capex_annual"), (int, float)) and s["capex_annual"] > 0 else capex_source
        depr_src = "scenario_override" if isinstance(s.get("depr_annual"), (int, float)) and s["depr_annual"] > 0 else depr_source
        nfa_src = "scenario_override" if isinstance(s.get("nfa_addback"), (int, float)) and s["nfa_addback"] > 0 else "cash+fin_assets-debt(全口径)"
        results[name] = {"enterprise_value": ev, "equity_value": eq_adj, "per_share": per_share,
            "pv_forecast_fcf": total_pv_fcf, "terminal_value": tv, "pv_terminal": pv_tv,
            "forecast_details": details, "wacc": s["wacc"], "term_g": s["term_g"],
            "derived": {"total_shares": total_shares, "tax_rate": tax_rate, "tax_source": tax_source,
                "minority_ratio": minority_ratio, "minority_source": minority_source,
                "avg_capex": avg_capex, "capex_source": capex_src,
                "avg_depr": avg_depr, "depr_source": depr_src,
                "avg_depr_rate": avg_depr_rate, "revenue_latest": rev_latest,
                "nfa_addback": nfa_add, "nfa_source": nfa_src}}
    return results

# ── 敏感性 ────────────────────────────────────────────────────────

def calc_sensitivity(data, scenarios, total_shares):
    annual = data["annual_data"]
    years = sorted(annual.keys())
    latest_year = int(years[-1])
    tax_rate = derive_tax_rate(annual) or 0.15
    rev_latest = gv(annual, latest_year, "利润表", "营业收入")
    if not rev_latest:
        return {"error": "营业收入数据缺失，敏感性跳过"}
    cash_val = gv(annual, latest_year, "资产负债表", "货币资金") or 0
    debt_val = ((gv(annual, latest_year, "资产负债表", "短期借款") or 0)
              + (gv(annual, latest_year, "资产负债表", "长期借款") or 0)
              + (gv(annual, latest_year, "资产负债表", "应付债券") or 0)
              + (gv(annual, latest_year, "资产负债表", "一年内到期的非流动负债") or 0)
              + (gv(annual, latest_year, "资产负债表", "租赁负债") or 0))
    fin_assets = ((gv(annual, latest_year, "资产负债表", "交易性金融资产") or 0)
                + (gv(annual, latest_year, "资产负债表", "长期股权投资") or 0)
                + (gv(annual, latest_year, "资产负债表", "其他非流动金融资产") or 0)
                + (gv(annual, latest_year, "资产负债表", "投资性房地产") or 0)
                + (gv(annual, latest_year, "资产负债表", "一年内到期的非流动资产") or 0)
                + (gv(annual, latest_year, "资产负债表", "其他权益工具投资") or 0))
    _neu0 = scenarios.get("neutral", {})
    s_nfa_s = _neu0.get("nfa_addback")
    nfa_addback_s = s_nfa_s if isinstance(s_nfa_s, (int, float)) and s_nfa_s > 0 else (cash_val + fin_assets - debt_val)

    depr_ovr = _neu0.get("depr_annual")
    depr_in_cogs_s = _neu0.get("depr_in_cogs", False)
    capex_ovr = _neu0.get("capex_annual")
    nwc_rate = derive_nwc_rate(annual, years)

    depr_derived = derive_depr(annual, years, rev_latest)
    avg_depr_rate = depr_derived[2]

    capex_vals = []
    for ys in years:
        cx = gv(annual, ys, "现金流量表", "购建固定资产、无形资产和其他长期资产所支付的现金")
        if cx: capex_vals.append(abs(cx))
    avg_cx = sum(capex_vals)/len(capex_vals) if capex_vals else rev_latest*0.02

    neu = scenarios.get("neutral", {})
    rev_g = neu.get("rev_growth", [0.03]*5)
    gm_arr = neu.get("gm", [0.75]*5)
    sm_arr = neu.get("sm_rate", [0.48]*5) if isinstance(neu.get("sm_rate"), list) else [neu.get("sm_rate", 0.48)]*5
    adm = neu.get("admin_rate", 0.035) if isinstance(neu.get("admin_rate"), (int, float)) else 0.035
    rd = neu.get("rd_rate", 0.045) if isinstance(neu.get("rd_rate"), (int, float)) else 0.045
    oi = neu.get("other_inc_rate", 0.01)

    # 实际折现前5年FCFF（复用DCF计算逻辑）
    rev = rev_latest
    pv_5y = 0.0
    for i in range(5):
        rev = rev * (1 + rev_g[i])
        gm = gm_arr[i]
        sm = sm_arr[i] if i < len(sm_arr) else sm_arr[-1]
        tax_surch = rev * neu.get("tax_surcharge_rate", 0.0)
        ebitda = rev*gm - rev*sm - rev*adm - rev*rd + rev*oi - tax_surch
        if isinstance(depr_ovr, (int, float)) and depr_ovr > 0:
            depr_t = depr_ovr
            ebit = ebitda if depr_in_cogs_s else ebitda - depr_ovr
        else:
            depr_t = rev * avg_depr_rate
            ebit = ebitda - rev*avg_depr_rate
        capex = capex_ovr if isinstance(capex_ovr, (int, float)) and capex_ovr > 0 else avg_cx * (rev / rev_latest)
        fcff = ebit*(1-tax_rate) + depr_t - capex - rev_g[i]*rev*nwc_rate
        pv_5y += fcff / ((1 + neu.get("wacc", 0.09)) ** (i+1))
    last_fcff = fcff  # 第五年FCFF，用于终值

    # 以中性 scenario 的 WACC 和 g 为中心，上下浮动
    neu_wacc = neu.get("wacc", 0.09)
    neu_g = neu.get("term_g", 0.025)
    # 敏感性网格 WACC±1%/±2%、g±0.5%/±1%：研报标准展示网格，非公司特定参数
    offsets_wacc = [-0.02, -0.01, 0.0, 0.01, 0.02]
    offsets_g = [-0.01, -0.005, 0.0, 0.005, 0.01]
    wacc_range = [max(neu_g + 0.02, neu_wacc + o) for o in offsets_wacc]  # wacc不能太接近g
    g_range = [max(0.005, neu_g + o) for o in offsets_g]  # g不能为负
    # 少数股东占比（与主DCF一致）
    minority_s = gv(annual, latest_year, "资产负债表", "少数股东权益")
    parent_eq_s = gv(annual, latest_year, "资产负债表", "归属于母公司股东权益合计")
    if minority_s is not None and parent_eq_s and (minority_s + parent_eq_s):
        mratio = minority_s / (minority_s + parent_eq_s)
    else:
        mratio = 0.02
    matrix = []
    for w in wacc_range:
        row = []
        for g in g_range:
            if w <= g: row.append(None)
            else:
                tv = last_fcff*(1+g)/(w-g)
                pv_tv = tv/((1+w)**5)
                ev = pv_5y+pv_tv
                eq = (ev+nfa_addback_s)*(1 - mratio)
                row.append(eq/total_shares)
        matrix.append({"wacc": w, "values": row})
    return {"wacc_range": wacc_range, "g_range": g_range, "matrix": matrix}

# ── 相对估值 ──────────────────────────────────────────────────────

def calc_relative_valuation(data, peer_pe, ke, scenarios):
    annual = data["annual_data"]
    years = sorted(annual.keys())
    latest_year = int(years[-1])
    eps = gv(annual, latest_year, "利润表", "基本每股收益")
    if eps is None or eps <= 0:
        np_val = gv(annual, latest_year, "利润表", "归属于母公司所有者的净利润")
        shares = derive_shares(annual)
        eps = np_val / shares if (np_val is not None and shares) else None
    if eps is None:
        return {"error": "无法推导EPS，相对估值跳过"}
    pe_val = gv(annual, latest_year, "资产负债表", "归属于母公司股东权益合计")
    total_shares = derive_shares(annual)
    if total_shares is None:
        return {"error": "无法推导总股本"}
    bps = pe_val / total_shares if pe_val else None
    # EPS 情景：用各情景自己的 Y1 营收增速作为 EPS 增速代理（与 DCF 假设一致）
    eps_scens = {}
    for name, s in scenarios.items():
        g1 = s["rev_growth"][0]
        eps_scens[name] = eps * (1 + g1)
    results = {}
    # PE区间 peer_pe-2 ~ peer_pe+3：经验保守区间设定（无学术依据，报告须说明口径）
    for name, e in eps_scens.items():
        results[name] = {"eps_est": e, "eps_growth_proxy": f"{name} Y1 rev_growth",
                         "pe_band_basis": "peer_pe-2 ~ peer_pe+3 经验区间",
                         "value_low": e*(peer_pe-2), "value_mid": e*peer_pe, "value_high": e*(peer_pe+3)}
    # PB 估值带：justified PB = 近3年ROE中位数 / Ke（替代硬编码 1.5-4.0x）
    roe_vals = []
    for ys in years[-3:]:
        np_y = gv(annual, ys, "利润表", "归属于母公司所有者的净利润")
        eq_y = gv(annual, ys, "资产负债表", "归属于母公司股东权益合计")
        if np_y is not None and eq_y:
            roe_vals.append(np_y / eq_y)
    roe_med = median(roe_vals) if roe_vals else None
    if roe_med is not None and ke and ke > 0:
        pb_just = roe_med / ke if roe_med > 0 else 1.0
        pb_basis = "3yr median ROE/Ke" if roe_med > 0 else "ROE<=0，按账面价值中性处理"
    else:
        pb_just = None
        pb_basis = None
    if pb_just and bps:
        # 带宽度系数 0.6/0.9/1.2/1.5：围绕justified PB的经验保守区间（无学术依据，报告须说明口径）
        results["pb_valuation"] = {"bps_latest": bps, "pb_justified": pb_just, "pb_basis": pb_basis,
            "band_basis": "justified PB × [0.6, 1.5] 经验区间",
            "pessimistic": [bps*pb_just*0.6, bps*pb_just*0.9],
            "neutral": [bps*pb_just*0.9, bps*pb_just*1.2],
            "optimistic": [bps*pb_just*1.2, bps*pb_just*1.5]}
    else:
        results["pb_valuation"] = {"bps_latest": bps, "note": "ROE/权益数据不足，PB估值跳过"}
    return results

# ── RIM ───────────────────────────────────────────────────────────

def calc_rim(data, ke, g_re, fade_years=5):
    """剩余收益模型：稳定模式（锚点永续）或衰减模式（ROE线性衰减至历史中枢）。"""
    annual = data["annual_data"]
    years = sorted(annual.keys())
    latest_year = int(years[-1])
    pnp = gv(annual, latest_year, "利润表", "归属于母公司所有者的净利润")
    pe = gv(annual, latest_year, "资产负债表", "归属于母公司股东权益合计")
    if pnp is None or not pe:
        return {"error": "归母净利润或归母权益数据缺失，RIM跳过"}
    total_shares = derive_shares(annual)
    if total_shares is None: return {"error": "无法推导总股本"}
    if ke - g_re <= 0.01:
        return {"error": f"Ke-g={ke-g_re:.3f}≤1%，RIM永续无法收敛"}
    bps = pe / total_shares
    roe0 = pnp / pe
    if roe0 <= 0:
        return {"error": "ROE<=0，RIM不适用"}

    # 历史ROE中位数（长期可持续水平，抗周期）
    roe_hist_vals = []
    for ys in years[-5:]:
        np_y = gv(annual, ys, "利润表", "归属于母公司所有者的净利润")
        eq_y = gv(annual, ys, "资产负债表", "归属于母公司股东权益合计")
        if np_y is not None and eq_y:
            roe_hist_vals.append(np_y / eq_y)
    roe_hist = median(roe_hist_vals) if roe_hist_vals else roe0
    if roe_hist <= 0:
        return {"error": "历史ROE中位数≤0，RIM不适用"}

    # 留存率：1 - 近3年均归母分红/归母净利（分红字段缺失时按0.5并标注）
    # 归母分红 = 分配股利总额 - 少数股东股利 - 利息支出（新浪字段名有"所"字变体，两个都试）
    payouts = []
    for ys in years[-3:]:
        np_y = gv(annual, ys, "利润表", "归属于母公司所有者的净利润")
        div_y = gv(annual, ys, "现金流量表", "分配股利、利润或偿付利息所支付的现金")
        if div_y is None:
            div_y = gv(annual, ys, "现金流量表", "分配股利、利润或偿付利息支付的现金")
        if div_y is not None:
            div_min = gv(annual, ys, "现金流量表", "子公司支付给少数股东的股利、利润")
            ie_y = gv(annual, ys, "利润表", "利息支出")
            if div_min is not None:
                div_y = div_y - div_min
            if ie_y is not None:
                div_y = div_y - abs(ie_y)
        if np_y and div_y is not None:
            payouts.append(min(max(abs(div_y) / np_y, 0.0), 1.0))
    if payouts:
        payout = sum(payouts) / len(payouts)
        retention_source = "cf_derived"
    else:
        payout = 0.5
        retention_source = "assumed_0.5"
    b_ret = max(0.05, 1.0 - payout)

    # RE路径：最新ROE与历史中枢差距≤20%视为稳定；否则线性衰减
    pv_re = 0.0
    re_series = []
    bps_t = bps
    gap_ratio = (roe0 - roe_hist) / roe_hist
    if gap_ratio > 0.2:
        mode = f"fade_to_anchor({fade_years}y)"
        for t in range(1, fade_years + 1):
            roe_t = roe0 + (roe_hist - roe0) * t / fade_years
            re_t = (roe_t - ke) * bps_t
            pv_re += re_t / ((1 + ke) ** t)
            re_series.append({"year": t, "roe": roe_t, "re_per_share": re_t})
            bps_t = bps_t * (1 + roe_t * b_ret)
        # 终值：锚点ROE的永续（roe_hist≤ke时自然为负）
        tv = (roe_hist - ke) * bps_t / (ke - g_re)
        pv_re += tv / ((1 + ke) ** fade_years)
        terminal_re = tv
    else:
        mode = "stable_perpetuity"
        spread = roe_hist - ke
        pv_re = spread * bps / (ke - g_re)
        terminal_re = pv_re
    value_per_share = bps + pv_re
    implied_pb = value_per_share / bps
    return {"bps": bps, "roe_latest": roe0, "roe_hist": roe_hist, "roe_anchor": roe_hist,
            "mode": mode, "ke": ke, "g_re": g_re, "fade_years": fade_years,
            "payout_ratio": payout, "retention_source": retention_source,
            "pv_residual_earnings": pv_re, "terminal_re": terminal_re,
            "re_series": re_series, "implied_pb": implied_pb,
            "value_per_share": value_per_share}

# ── main ──────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="DCF估值计算")
    p.add_argument("data_json", help="extract_financials.py 输出的 JSON")
    p.add_argument("-s", "--scenario-file", required=True, help="三情景假设 JSON 文件（必传）")
    p.add_argument("-o", "--output", help="输出 JSON 文件路径")
    p.add_argument("--shares", type=float, help="手动指定总股本（股），不传则从数据推导")
    p.add_argument("--peer-pe", type=float, required=True, help="可比公司 PE 中位数（必传，来自阶段1可比公司分析）")
    p.add_argument("--rf", type=float, required=True, help="无风险利率（必传。当前10年期国债收益率，WebSearch获取）")
    p.add_argument("--ke", type=float, required=True, help="股权成本Ke（必传。CAPM: Rf + β × ERP）")
    p.add_argument("--g-re", type=float, default=0.025, help="剩余收益永续增长率（RE的长期增速，默认2.5%,约等于GDP长期增速）")
    p.add_argument("--rim-fade-years", type=int, default=5, help="RIM ROE衰减年数（默认5；按护城河调整：宽10/窄5/无3）")
    args = p.parse_args()

    if not 0.005 <= args.rf <= 0.10:
        print(f"# 警告: --rf={args.rf} 超出合理区间 [0.5%, 10%]，请核实国债收益率", file=sys.stderr)
    if args.ke <= args.rf:
        print(f"# 警告: Ke({args.ke}) <= Rf({args.rf})，CAPM 假设异常（Ke = Rf + β×ERP 必须 > Rf）", file=sys.stderr)

    data = load_json(args.data_json)
    scenarios = load_json(args.scenario_file)
    annual = data["annual_data"]
    total_shares = args.shares or derive_shares(annual)
    if total_shares is None:
        print("ERROR: 无法推导总股本，请用 --shares 指定", file=sys.stderr); sys.exit(1)

    # 提取一次derived数据用于顶层输出（方便state.json捕获）
    dcf_result = calc_dcf(data, scenarios)
    top_derived = {"total_shares": total_shares}
    if "neutral" in dcf_result and "derived" in dcf_result["neutral"]:
        top_derived.update(dcf_result["neutral"]["derived"])

    output = {
        "rf_used": args.rf,
        "ke_used": args.ke,
        "peer_pe_used": args.peer_pe,
        "derived": top_derived,
        "dcf": dcf_result,
        "rim": calc_rim(data, args.ke, args.g_re, args.rim_fade_years),
        "relative": calc_relative_valuation(data, args.peer_pe, args.ke, scenarios),
        "sensitivity": calc_sensitivity(data, scenarios, total_shares),
    }
    output = str_keys(output)
    js = json.dumps(output, ensure_ascii=True, indent=2, default=str)
    if args.output: Path(args.output).write_text(js, encoding="utf-8")
    else: print(js)

if __name__ == "__main__": main()
