"""
核心财务比率计算工具 v1.0

输入：extract_financials.py 输出的 JSON
输出：结构化的比率计算结果 JSON

用法：
    python calc_ratios.py data.json
    python calc_ratios.py data.json -o ratios.json
"""

import sys, json, argparse
from pathlib import Path

def load_data(src):
    return json.load(open(src, encoding="utf-8")) if src != "-" else json.load(sys.stdin)

def gv(annual, yr, tbl, fld):
    try: return annual[str(yr)].get(tbl, {}).get(fld)
    except: return None

def sd(a, b):
    return a / b if a is not None and b else None

def str_keys(obj):
    if isinstance(obj, dict): return {str(k): str_keys(v) for k, v in obj.items()}
    if isinstance(obj, list): return [str_keys(v) for v in obj]
    return obj

def calc_all(data):
    annual = data["annual_data"]
    years = sorted(annual.keys())
    ct = data.get("company_type", "GENERAL")
    res = {"years": years, "company_type": ct}

    # profitability
    res["profitability"] = {}
    for ys in years:
        y = int(ys)
        rev = gv(annual,y,"利润表","营业收入")
        cogs = gv(annual,y,"利润表","营业成本")
        pnp = gv(annual,y,"利润表","归属于母公司所有者的净利润")
        opr = gv(annual,y,"利润表","营业利润")
        eps = gv(annual,y,"利润表","基本每股收益")
        fex = gv(annual,y,"利润表","财务费用")
        sel = gv(annual,y,"利润表","销售费用")
        adm = gv(annual,y,"利润表","管理费用")
        rd = gv(annual,y,"利润表","研发费用")
        taxs = gv(annual,y,"利润表","营业税金及附加")
        gm = sd(rev-cogs, rev) if rev and cogs else None
        npm = sd(pnp, rev)
        opm = sd(opr, rev)
        ebit = (opr or 0) + (fex or 0) if opr is not None and fex is not None else None
        ebm = sd(ebit, rev)
        sell_r = sd(sel, rev); adm_r = sd(adm, rev); rd_r = sd(rd, rev)
        core = None
        if rev and cogs is not None and sel is not None and adm is not None and rd is not None and fex is not None:
            core = rev - cogs - (taxs or 0) - sel - adm - rd - fex
        nonrec = (opr - core) if opr is not None and core is not None else None
        cpct = sd(core, opr)
        res["profitability"][ys] = {"gm":gm,"npm":npm,"opm":opm,"ebit":ebit,"ebit_margin":ebm,
            "sell_exp_rate":sell_r,"admin_exp_rate":adm_r,"rd_exp_rate":rd_r,
            "core_operating_profit":core,"non_recurring_net":nonrec,"core_profit_ratio":cpct,
            "parent_np":pnp,"eps":eps,"revenue":rev,"cogs":cogs}

    # efficiency
    res["efficiency"] = {}
    for ys in years:
        y = int(ys)
        rev = gv(annual,y,"利润表","营业收入")
        ta = gv(annual,y,"资产负债表","资产总计")
        ar = gv(annual,y,"资产负债表","应收账款")
        res["efficiency"][ys] = {"total_asset_turnover":sd(rev,ta), "ar_days":sd(365*ar,rev) if ar else None}

    # solvency
    res["solvency"] = {}
    for ys in years:
        y = int(ys)
        ta = gv(annual,y,"资产负债表","资产总计")
        tl = gv(annual,y,"资产负债表","负债合计")
        cash = gv(annual,y,"资产负债表","货币资金")
        st = gv(annual,y,"资产负债表","短期借款")
        lt = gv(annual,y,"资产负债表","长期借款")
        pe = gv(annual,y,"资产负债表","归属于母公司股东权益合计")
        res["solvency"][ys] = {"asset_liability_ratio":sd(tl,ta),"equity_multiplier":sd(ta,pe) if pe else None,
            "total_debt":(st or 0)+(lt or 0),"st_borrowing":st,"lt_borrowing":lt,"cash_to_st_debt":sd(cash,st) if st else None,
            "total_assets":ta,"parent_equity":pe,"cash":cash}

    # cashflow quality
    res["cashflow_quality"] = {}
    for ys in years:
        y = int(ys)
        pnp = gv(annual,y,"利润表","归属于母公司所有者的净利润")
        ocf = gv(annual,y,"现金流量表","经营活动产生的现金流量净额")
        icf = gv(annual,y,"现金流量表","投资活动产生的现金流量净额")
        fcf = gv(annual,y,"现金流量表","筹资活动产生的现金流量净额")
        sc = gv(annual,y,"现金流量表","销售商品、提供劳务收到的现金")
        cpx = gv(annual,y,"现金流量表","购建固定资产、无形资产和其他长期资产所支付的现金") or 0
        rev = gv(annual,y,"利润表","营业收入")
        fcf_val = (ocf or 0) - abs(cpx) if ocf is not None else None
        res["cashflow_quality"][ys] = {"cash_protection_ratio":sd(ocf,pnp),"revenue_cash_quality":sd(sc,rev),
            "oper_cf":ocf,"invest_cf":icf,"fin_cf":fcf,"fcf":fcf_val,"capex":cpx}

    # dupont
    res["dupont"] = {}
    for ys in years:
        y = int(ys)
        rev = gv(annual,y,"利润表","营业收入")
        pnp = gv(annual,y,"利润表","归属于母公司所有者的净利润")
        ta = gv(annual,y,"资产负债表","资产总计")
        pe = gv(annual,y,"资产负债表","归属于母公司股东权益合计")
        n = sd(pnp,rev); t = sd(rev,ta); e = sd(ta,pe) if pe else None
        res["dupont"][ys] = {"npm":n,"tat":t,"em":e,"roe":n*t*e if all([n,t,e]) else None}

    # dupont dynamics
    res["dupont_dynamics"] = []
    sy = sorted([int(y) for y in years])
    for i in range(1,len(sy)):
        y0,y1 = str(sy[i-1]),str(sy[i])
        d0,d1 = res["dupont"][y0],res["dupont"][y1]
        if all([d0["npm"],d0["tat"],d0["em"],d1["npm"],d1["tat"],d1["em"]]):
            cn = d0["tat"]*d0["em"]*(d1["npm"]-d0["npm"])
            ct = d0["npm"]*d0["em"]*(d1["tat"]-d0["tat"])
            ce = d0["npm"]*d0["tat"]*(d1["em"]-d0["em"])
            dr = d1["roe"]-d0["roe"]
            res["dupont_dynamics"].append({"from":y0,"to":y1,"roe_from":d0["roe"],"roe_to":d1["roe"],
                "delta_roe":dr,"npm_contrib":cn,"tat_contrib":ct,"em_contrib":ce,"cross":dr-cn-ct-ce})

    # growth
    res["growth"] = {}
    for i in range(1,len(sy)):
        y0,y1 = str(sy[i-1]),str(sy[i])
        r0 = res["profitability"][y0]["revenue"]; r1 = res["profitability"][y1]["revenue"]
        p0 = res["profitability"][y0]["parent_np"]; p1 = res["profitability"][y1]["parent_np"]
        a0 = res["solvency"][y0]["total_assets"]; a1 = res["solvency"][y1]["total_assets"]
        res["growth"][f"{y0}_{y1}"] = {"revenue_growth":sd(r1-r0,r0) if r0 and r1 else None,
            "profit_growth":sd(p1-p0,p0) if p0 and p1 else None,
            "asset_growth":sd(a1-a0,a0) if a0 and a1 else None}

    # ROA vs r — 借款利率从利息支出/有息负债推导
    res["roa_vs_r"] = {}
    for ys in years:
        y = int(ys)
        eb = res["profitability"][ys]["ebit"]
        ta = res["solvency"][ys]["total_assets"]
        debt = res["solvency"][ys]["total_debt"]
        pe = res["solvency"][ys]["parent_equity"]
        roa = sd(eb,ta); de2 = sd(debt,pe) if pe else None
        # 推导借款利率
        ie = gv(annual, ys, "利润表", "利息支出")
        r_est = abs(ie)/debt if (ie and debt) else None
        # 回退：用 abs(财务费用)/有息负债
        if r_est is None:
            fex_abs = abs(gv(annual,ys,"利润表","财务费用") or 0)
            r_est = fex_abs/debt if debt else None
        sp = roa - r_est if (roa is not None and r_est is not None) else None
        lc = de2 * sp if (de2 is not None and sp is not None) else None
        if r_est is None and not debt:
            direction = "N/A (无有息负债)"
        elif r_est is None:
            direction = "N/A (利率数据不足)"
        else:
            direction = "CREATES" if sp > 0 else ("DESTROYS" if sp < 0 else "NEUTRAL")
        res["roa_vs_r"][ys] = {"roa":roa,"de":de2,"r_est":r_est,"spread":sp,
            "leverage_contribution":lc,"leverage_direction":direction}

    return res

def main():
    p = argparse.ArgumentParser(); p.add_argument("input"); p.add_argument("-o","--output")
    a = p.parse_args()
    data = load_data(a.input)
    ratios = calc_all(data)
    ratios = str_keys(ratios)
    js = json.dumps(ratios, ensure_ascii=True, indent=2, default=str)
    if a.output: Path(a.output).write_text(js, encoding="utf-8")
    else: print(js)

if __name__ == "__main__": main()
