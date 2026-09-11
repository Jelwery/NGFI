"""Offline forecast, RIM and legacy relative-valuation support.

DCF/WACC/DCF sensitivity are owned by finance-core/src/valuation.ts. This module
only prepares explicit forecasts and calls the fixed JSON Node bridge. It does
not retrieve data, persist a research case, or silently supply assumptions.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

BRIDGE = Path(__file__).resolve().with_name("valuation_bridge.mjs")
FINANCIAL_TYPES = {"BANK", "INSURANCE", "BROKER", "FINANCIAL_HOLDING"}
DEBT_FIELDS = ("短期借款", "长期借款", "应付债券", "一年内到期的非流动负债", "租赁负债")
ASSET_FIELDS = ("交易性金融资产", "长期股权投资", "其他非流动金融资产", "投资性房地产", "一年内到期的非流动资产", "其他权益工具投资")


def load_json(src):
    if src == "-":
        return json.load(sys.stdin)
    with open(src, encoding="utf-8") as stream:
        return json.load(stream)


def gv(annual, yr, tbl, fld):
    return annual.get(str(yr), {}).get(tbl, {}).get(fld)


def sd(a, b):
    return a / b if a is not None and b else None


def median(vals):
    values = sorted(v for v in vals if v is not None)
    return values[len(values) // 2] if values else None


def str_keys(obj):
    if isinstance(obj, dict):
        return {str(k): str_keys(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [str_keys(v) for v in obj]
    return obj


def number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be an explicit finite number")
    return value


def core_calculate(op, inputs):
    """Fixed operations and executable script; no shell, eval, dynamic path or code."""
    if op not in {"dcf", "dcf_sensitivity", "wacc"}:
        raise ValueError("unsupported finance-core operation")
    completed = subprocess.run(
        ["node", str(BRIDGE)], input=json.dumps({"op": op, "input": inputs}, allow_nan=False),
        text=True, capture_output=True, timeout=30, check=False,
    )
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("finance-core bridge unavailable; build @finance2dsh/core first: " + completed.stderr[-500:]) from exc
    if completed.returncode or response.get("ok") is not True:
        raise ValueError(response.get("error", "finance-core bridge failed"))
    return response["result"]


def calc_wacc(inputs):
    return core_calculate("wacc", inputs)


def derive_shares(annual):
    """Legacy historical EPS share proxy, not a replacement for dated diluted shares."""
    estimates = []
    for year in sorted(annual):
        profit = gv(annual, year, "利润表", "归属于母公司所有者的净利润")
        if profit is None:
            profit = gv(annual, year, "利润表", "净利润")
        eps = gv(annual, year, "利润表", "基本每股收益")
        if profit is not None and eps and profit / eps > 0:
            estimates.append(profit / eps)
    if estimates:
        return median(estimates)
    for year in sorted(annual, reverse=True):
        shares = gv(annual, year, "资产负债表", "实收资本(或股本)")
        if shares is not None and shares > 0:
            return shares
    return None


def derive_tax_rate(annual):
    rates = []
    for year in sorted(annual)[-3:]:
        tax = gv(annual, year, "利润表", "所得税费用")
        profit = gv(annual, year, "利润表", "利润总额")
        if tax is not None and profit and 0 <= tax / profit <= 1:
            rates.append(tax / profit)
    return median(rates)


def derive_depr(annual, years, rev_latest):
    """Historical diagnostic only. Missing depreciation remains unknown."""
    values = [abs(v) for year in years if (v := gv(annual, year, "现金流量表", "固定资产折旧、油气资产折耗、生产性生物资产折旧")) is not None]
    source = "cf_statement"
    if not values:
        source = "bs_acc_dep_diff"
        for y0, y1 in zip(sorted(years), sorted(years)[1:]):
            d0 = gv(annual, y0, "资产负债表", "累计折旧")
            d1 = gv(annual, y1, "资产负债表", "累计折旧")
            if d0 is not None and d1 is not None and d1 > d0:
                values.append(d1 - d0)
    if not values:
        return None, "missing", None
    amount = sum(values) / len(values)
    return amount, source, sd(amount, rev_latest)


def derive_nwc_rate(annual, years):
    """Historical diagnostic ΔNWC/Δrevenue; missing/flat revenue is not zero NWC."""
    rates = []
    for y0, y1 in zip(sorted(years), sorted(years)[1:]):
        v = [gv(annual, y, "资产负债表", f) for y in (y0, y1) for f in ("应收账款", "存货", "应付账款")]
        r0, r1 = [gv(annual, y, "利润表", "营业收入") for y in (y0, y1)]
        if any(x is None for x in v) or r0 is None or r1 is None or r0 == r1:
            continue
        rates.append(((v[3] + v[4] - v[5]) - (v[0] + v[1] - v[2])) / (r1 - r0))
    return sum(rates) / len(rates) if rates else None


def assumption_quality(scenario, keys):
    sources = scenario.get("assumption_sources", {})
    if not isinstance(sources, dict):
        raise ValueError("assumption_sources must be an object")
    assumptions = {key: {"value": scenario[key], "kind": "assumption", "source": sources.get(key),
                         "status": "sourced" if isinstance(sources.get(key), str) and sources[key].strip() else "unverified"}
                   for key in keys}
    warnings = [f"assumption source missing: {key}" for key, item in assumptions.items() if item["status"] == "unverified"]
    return {"status": "partial" if warnings else "ok", "assumptions": assumptions, "warnings": warnings,
            "limitations": ["Assumptions are not reported facts; source/PIT admissibility must be audited in the research ledger."]}


def forecast_fcff(data, scenario, shares=None):
    """Build an explicit FCFF schedule, without discounting or automatic forecasts.

    Required: rev_growth (1-30 annual values), gm, sm_rate, admin_rate, rd_rate,
    other_inc_rate, tax_surcharge_rate, tax_rate, depr_annual, capex_annual,
    nwc_change_rate, depr_in_cogs, wacc, term_g. Rate/amount fields can be
    scalars or same-length schedules except wacc, term_g and nwc_change_rate.
    Optional bridge: net_debt OR nfa_addback, minority_ratio, total_shares.
    """
    annual = data["annual_data"]
    if not annual:
        raise ValueError("annual_data is empty")
    latest = max(annual)
    revenue = number(gv(annual, latest, "利润表", "营业收入"), "reported revenue")
    if revenue <= 0:
        raise ValueError("reported revenue must be positive")
    growth = scenario.get("rev_growth")
    if not isinstance(growth, list) or not 1 <= len(growth) <= 30:
        raise ValueError("rev_growth must contain 1-30 explicit annual assumptions")
    keys = ["rev_growth", "gm", "sm_rate", "admin_rate", "rd_rate", "other_inc_rate", "tax_surcharge_rate",
            "tax_rate", "depr_annual", "capex_annual", "nwc_change_rate", "depr_in_cogs", "wacc", "term_g"]
    missing = [key for key in keys if key not in scenario]
    if missing:
        raise ValueError("missing explicit forecast assumptions: " + ", ".join(missing))
    if not isinstance(scenario["depr_in_cogs"], bool):
        raise ValueError("depr_in_cogs must explicitly be true or false")
    n = len(growth)

    def at(key, index):
        value = scenario[key]
        if isinstance(value, list):
            if len(value) != n:
                raise ValueError(f"{key} must have {n} annual values")
            value = value[index]
        return number(value, key)

    details = []
    for i in range(n):
        previous = revenue
        g = at("rev_growth", i)
        if g <= -1:
            raise ValueError("rev_growth must be greater than -1")
        revenue *= 1 + g
        gm, tax = at("gm", i), at("tax_rate", i)
        if not 0 <= gm <= 1 or not 0 <= tax <= 1:
            raise ValueError("gm and tax_rate must be in [0, 1]")
        depr, capex = at("depr_annual", i), at("capex_annual", i)
        if depr < 0 or capex < 0:
            raise ValueError("depr_annual and capex_annual must be nonnegative")
        operating = revenue * (gm - at("sm_rate", i) - at("admin_rate", i) - at("rd_rate", i)
                               + at("other_inc_rate", i) - at("tax_surcharge_rate", i))
        ebit = operating if scenario["depr_in_cogs"] else operating - depr
        nwc = (revenue - previous) * number(scenario["nwc_change_rate"], "nwc_change_rate")
        details.append({"year": int(latest) + i + 1, "revenue": revenue, "ebit": ebit,
                        "depreciation": depr, "capex": capex, "nwc_change": nwc,
                        "fcff": ebit * (1 - tax) + depr - capex - nwc})

    optional = [key for key in ("net_debt", "nfa_addback", "minority_ratio", "total_shares") if key in scenario]
    quality = assumption_quality(scenario, keys + optional)
    bridge = None
    if "net_debt" in scenario and "nfa_addback" in scenario:
        raise ValueError("supply net_debt or nfa_addback, not both")
    if "net_debt" in scenario:
        bridge = number(scenario["net_debt"], "net_debt")
    elif "nfa_addback" in scenario:
        bridge = -number(scenario["nfa_addback"], "nfa_addback")
    else:
        cash = gv(annual, latest, "资产负债表", "货币资金")
        debt = [gv(annual, latest, "资产负债表", f) for f in DEBT_FIELDS]
        assets = [gv(annual, latest, "资产负债表", f) for f in ASSET_FIELDS]
        if cash is not None and all(v is not None for v in debt + assets):
            bridge = sum(number(v, "debt") for v in debt) - number(cash, "cash") - sum(number(v, "financial asset") for v in assets)
        else:
            quality["warnings"].append("EV only: cash/debt/non-operating-asset bridge is incomplete; unknown is not zero")

    total_shares = shares if shares is not None else scenario.get("total_shares")
    if total_shares is None:
        total_shares = derive_shares(annual)
        quality["warnings"].append("shares use a historical EPS/capital proxy or are missing; verify dated diluted shares")
    if total_shares is not None and number(total_shares, "total_shares") <= 0:
        raise ValueError("total_shares must be positive")
    minority = scenario.get("minority_ratio")
    if minority is None:
        minority_bs = gv(annual, latest, "资产负债表", "少数股东权益")
        parent = gv(annual, latest, "资产负债表", "归属于母公司股东权益合计")
        if minority_bs is not None and parent is not None and minority_bs + parent > 0:
            minority = minority_bs / (minority_bs + parent)
            quality["warnings"].append("minority_ratio uses book-equity allocation as a valuation proxy")
        else:
            quality["warnings"].append("parent equity/per-share value unavailable: minority allocation is unknown")
    if minority is not None and not 0 <= number(minority, "minority_ratio") < 1:
        raise ValueError("minority_ratio must be in [0, 1)")
    quality["status"] = "partial" if quality["warnings"] else "ok"
    inputs = {"freeCashFlows": [row["fcff"] for row in details], "discountRate": number(scenario["wacc"], "wacc"),
              "terminal": {"method": "gordon-growth", "terminalGrowthRate": number(scenario["term_g"], "term_g")}}
    if bridge is not None:
        inputs["netDebt"] = bridge
    if total_shares is not None:
        inputs["sharesOutstanding"] = total_shares
    return {"core_input": inputs, "forecast_details": details, "minority_ratio": minority, "quality": quality}


def calc_dcf(data, scenarios, shares=None):
    if data.get("company_type") in FINANCIAL_TYPES:
        return {"skipped": True, "reason": "金融企业标准FCFF/DCF不适用；使用P/EV、PB、DDM、RIM或SOTP"}
    results = {}
    try:
        if not scenarios:
            raise ValueError("explicit scenarios are required")
        for name, scenario in scenarios.items():
            prepared = forecast_fcff(data, scenario, shares)
            core = core_calculate("dcf", prepared["core_input"])
            minority = prepared["minority_ratio"]
            equity = core["equityValue"] * (1 - minority) if core["equityValue"] is not None and minority is not None else None
            for row, pv in zip(prepared["forecast_details"], core["presentValueFreeCashFlows"]):
                row["pv_fcff"] = pv
            results[name] = {"enterprise_value": core["enterpriseValue"], "equity_value": equity,
                             "per_share": sd(equity, core["sharesOutstanding"]),
                             "pv_forecast_fcf": core["presentValueExplicitPeriod"], "terminal_value": core["terminalValue"],
                             "pv_terminal": core["presentValueTerminal"], "forecast_details": prepared["forecast_details"],
                             "wacc": scenario["wacc"], "term_g": scenario["term_g"], "quality": prepared["quality"],
                             "derived": {"total_shares": core["sharesOutstanding"], "minority_ratio": minority,
                                         "nfa_addback": -core["netDebt"] if core["netDebt"] is not None else None},
                             "canonical_dcf": core}
    except (ValueError, KeyError) as exc:
        return {"error": str(exc), "status": "needs_input"}
    return results


def calc_sensitivity(data, scenarios, total_shares=None, discount_rates=None, terminal_growth_rates=None):
    if data.get("company_type") in FINANCIAL_TYPES:
        return {"skipped": True, "reason": "金融企业标准FCFF/DCF不适用"}
    try:
        scenario = scenarios["neutral"]
        prepared = forecast_fcff(data, scenario, total_shares)
        inputs = dict(prepared["core_input"])
        wacc = inputs.pop("discountRate")
        growth = inputs.pop("terminal")["terminalGrowthRate"]
        inputs["discountRates"] = discount_rates if discount_rates is not None else [wacc + d for d in (-.02, -.01, 0, .01, .02)]
        inputs["terminal"] = {"method": "gordon-growth", "terminalGrowthRates": terminal_growth_rates if terminal_growth_rates is not None else [growth + d for d in (-.01, -.005, 0, .005, .01)]}
        core = core_calculate("dcf_sensitivity", inputs)
        minority = prepared["minority_ratio"]
        if core["metric"] == "enterprise-value":
            grid = core["grid"]
        else:
            grid = [[value * (1 - minority) if value is not None and minority is not None else None for value in row] for row in core["grid"]]
        return {"metric": core["metric"], "wacc_range": core["discountRates"], "g_range": core["terminalAxis"],
                "matrix": [{"wacc": w, "values": row} for w, row in zip(core["discountRates"], grid)],
                "quality": prepared["quality"], "canonical_sensitivity": core}
    except (ValueError, KeyError) as exc:
        return {"error": str(exc), "status": "needs_input"}


def calc_relative_valuation(data, peer_pe, ke, scenarios, shares=None):
    """Preserve legacy PE/PB diagnostics; runtime comps use finance_relative_valuation."""
    annual = data["annual_data"]
    latest = max(annual)
    total_shares = shares if shares is not None else derive_shares(annual)
    if total_shares is None or total_shares <= 0:
        return {"error": "无法推导总股本"}
    profit = gv(annual, latest, "利润表", "归属于母公司所有者的净利润")
    eps = sd(profit, total_shares) if shares is not None else gv(annual, latest, "利润表", "基本每股收益")
    if eps is None:
        eps = sd(profit, total_shares)
    if eps is None or eps <= 0 or peer_pe <= 0 or ke <= 0:
        return {"error": "positive EPS, peer PE and Ke required; use other metrics for losses"}
    bps = sd(gv(annual, latest, "资产负债表", "归属于母公司股东权益合计"), total_shares)
    results = {}
    for name, scenario in scenarios.items():
        growth = scenario.get("eps_growth", scenario["rev_growth"][0])
        e = eps * (1 + number(growth, "eps_growth"))
        results[name] = {"eps_est": e, "eps_growth_proxy": "explicit EPS growth" if "eps_growth" in scenario else f"{name} Y1 rev_growth proxy",
                         "pe_band_basis": "peer_pe-2 ~ peer_pe+3 经验区间", "value_low": e * max(0, peer_pe - 2),
                         "value_mid": e * peer_pe, "value_high": e * (peer_pe + 3)}
    roe = median([sd(gv(annual, year, "利润表", "归属于母公司所有者的净利润"), gv(annual, year, "资产负债表", "归属于母公司股东权益合计")) for year in sorted(annual)[-3:]])
    if roe is not None and roe > 0 and bps is not None:
        justified = roe / ke
        results["pb_valuation"] = {"bps_latest": bps, "pb_justified": justified, "pb_basis": "3yr median ROE/Ke",
                                   "band_basis": "justified PB × [0.6, 1.5] 经验区间",
                                   "pessimistic": [bps * justified * .6, bps * justified * .9],
                                   "neutral": [bps * justified * .9, bps * justified * 1.2],
                                   "optimistic": [bps * justified * 1.2, bps * justified * 1.5]}
    else:
        results["pb_valuation"] = {"bps_latest": bps, "note": "positive ROE/权益数据不足，PB估值跳过"}
    results["quality"] = {"status": "partial", "limitations": ["Empirical PE/PB bands and revenue-to-EPS proxies are assumptions, not market observations.", "Annual EPS is not automatically TTM or consensus EPS."]}
    return results


def calc_rim(data, ke, g_re, fade_years=5, shares=None, payout_ratio=None):
    """Remaining-income model: stable perpetuity or ROE fade to historical anchor."""
    annual = data["annual_data"]
    if not annual:
        return {"error": "annual_data is empty"}
    years = sorted(annual)
    profit = gv(annual, years[-1], "利润表", "归属于母公司所有者的净利润")
    equity = gv(annual, years[-1], "资产负债表", "归属于母公司股东权益合计")
    total_shares = shares if shares is not None else derive_shares(annual)
    if profit is None or equity is None or equity <= 0 or total_shares is None or total_shares <= 0:
        return {"error": "归母净利润、正归母权益或总股本数据缺失，RIM跳过"}
    if number(ke, "ke") - number(g_re, "g_re") <= .01:
        return {"error": "Ke-g≤1%，RIM永续无法收敛"}
    if not isinstance(fade_years, int) or isinstance(fade_years, bool) or not 1 <= fade_years <= 30:
        return {"error": "fade_years must be 1-30"}
    bps, roe0 = equity / total_shares, profit / equity
    anchor = median([sd(gv(annual, year, "利润表", "归属于母公司所有者的净利润"), gv(annual, year, "资产负债表", "归属于母公司股东权益合计")) for year in years[-5:]])
    if roe0 <= 0 or anchor is None or anchor <= 0:
        return {"error": "ROE或历史ROE中位数≤0，RIM不适用"}
    payout = payout_ratio
    source = "explicit_assumption" if payout is not None else "missing"
    if payout is None:
        payouts = []
        for year in years[-3:]:
            np_y = gv(annual, year, "利润表", "归属于母公司所有者的净利润")
            div = gv(annual, year, "现金流量表", "分配股利、利润或偿付利息所支付的现金")
            if div is None:
                div = gv(annual, year, "现金流量表", "分配股利、利润或偿付利息支付的现金")
            minority = gv(annual, year, "现金流量表", "子公司支付给少数股东的股利、利润")
            interest = gv(annual, year, "利润表", "利息支出")
            if np_y and np_y > 0 and div is not None and minority is not None and interest is not None:
                payouts.append(min(max((abs(div) - abs(minority) - abs(interest)) / np_y, 0), 1))
        if payouts:
            payout, source = sum(payouts) / len(payouts), "cf_derived"
    if payout is not None and not 0 <= number(payout, "payout_ratio") <= 1:
        return {"error": "payout_ratio must be in [0, 1]"}
    re_series, pv_re, bps_t = [], 0.0, bps
    if (roe0 - anchor) / anchor > .2:
        if payout is None:
            return {"error": "RIM fade requires explicit payout_ratio or complete dividend components", "status": "needs_input"}
        mode = f"fade_to_anchor({fade_years}y)"
        for t in range(1, fade_years + 1):
            roe_t = roe0 + (anchor - roe0) * t / fade_years
            re_t = (roe_t - ke) * bps_t
            pv_re += re_t / ((1 + ke) ** t)
            re_series.append({"year": t, "roe": roe_t, "re_per_share": re_t})
            bps_t *= 1 + roe_t * (1 - payout)
        terminal_re = (anchor - ke) * bps_t / (ke - g_re)
        pv_re += terminal_re / ((1 + ke) ** fade_years)
    else:
        mode = "stable_perpetuity"
        pv_re = (anchor - ke) * bps / (ke - g_re)
        terminal_re = pv_re
    value = bps + pv_re
    return {"bps": bps, "roe_latest": roe0, "roe_hist": anchor, "roe_anchor": anchor, "mode": mode,
            "ke": ke, "g_re": g_re, "fade_years": fade_years, "payout_ratio": payout, "retention_source": source,
            "pv_residual_earnings": pv_re, "terminal_re": terminal_re, "re_series": re_series,
            "implied_pb": value / bps, "value_per_share": value,
            "quality": {"status": "partial", "assumptions": {"ke": ke, "g_re": g_re, "fade_years": fade_years, "payout_ratio": payout},
                        "limitations": ["Historical ROE anchor and book equity are proxies; validate clean-surplus accounting and assumption sources."]}}


def main():
    parser = argparse.ArgumentParser(description="Offline explicit forecast, canonical DCF bridge, RIM and PE/PB diagnostics")
    parser.add_argument("data_json")
    parser.add_argument("-s", "--scenario-file", required=True)
    parser.add_argument("-o", "--output")
    parser.add_argument("--shares", type=float)
    parser.add_argument("--peer-pe", type=float, required=True)
    parser.add_argument("--rf", type=float, required=True)
    parser.add_argument("--ke", type=float, required=True)
    parser.add_argument("--g-re", type=float, required=True)
    parser.add_argument("--rim-fade-years", type=int, default=5)
    parser.add_argument("--payout-ratio", type=float)
    args = parser.parse_args()
    data, scenarios = load_json(args.data_json), load_json(args.scenario_file)
    output = {"rf_used": args.rf, "ke_used": args.ke, "peer_pe_used": args.peer_pe,
              "dcf": calc_dcf(data, scenarios, args.shares),
              "rim": calc_rim(data, args.ke, args.g_re, args.rim_fade_years, args.shares, args.payout_ratio),
              "relative": calc_relative_valuation(data, args.peer_pe, args.ke, scenarios, args.shares),
              "sensitivity": calc_sensitivity(data, scenarios, args.shares)}
    js = json.dumps(str_keys(output), ensure_ascii=False, indent=2, allow_nan=False)
    if args.output:
        Path(args.output).write_text(js, encoding="utf-8")
    else:
        print(js)
    return 1 if any(isinstance(value, dict) and "error" in value for value in output.values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
