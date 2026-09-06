# -*- coding: utf-8 -*-
"""skill 自检：P0/P1/P2a 修复的合成数据回归测试。

用法（离线，无网络依赖）：
    python scripts/selftest.py
全部通过 → exit 0；任一失败 → exit 1。
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

FAILED = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILED.append(name)


# ── 1. format_stock_code（P0-2） ─────────────────────────────────
from extract_financials import format_stock_code

print("== format_stock_code ==")
valid = {"sh.600519": "sh600519", "600519": "sh600519", "sh600519": "sh600519",
         "SH.600519": "sh600519", "sz.002555": "sz002555", "002555": "sz002555",
         "sz002555": "sz002555"}
for k, v in valid.items():
    check(f"{k!r} -> {v}", format_stock_code(k) == v, f"got {format_stock_code(k)!r}")
for bad in ["abc", "12345", "830799"]:
    try:
        format_stock_code(bad)
        check(f"{bad!r} 应抛 ValueError", False)
    except ValueError:
        check(f"{bad!r} 抛 ValueError", True)

# ── 合成数据构造 ────────────────────────────────────────────────
def mk_annual(rev=1000.0, opr=100.0, fex=20.0, pnp=80.0, eps=8.0,
              st=None, lt=0.0, ie=None, dep_cf=None, acc_dep=True,
              ar=(100.0, 100.0, 100.0), revs=(1000.0, 1000.0, 1000.0)):
    a = {}
    years = ["2022", "2023", "2024"]
    for i, y in enumerate(years):
        pl = {"营业收入": revs[i], "营业成本": revs[i] * 0.6, "营业利润": opr, "财务费用": fex,
              "归属于母公司所有者的净利润": pnp, "基本每股收益": eps,
              "销售费用": 50.0, "管理费用": 50.0, "研发费用": 20.0, "营业税金及附加": 10.0}
        if ie is not None:
            pl["利息支出"] = ie
        b = {"资产总计": 2000.0, "负债合计": 600.0, "货币资金": 200.0,
             "归属于母公司股东权益合计": 1000.0, "少数股东权益": 50.0,
             "应收账款": ar[i], "存货": 100.0, "应付账款": 100.0,
             "流动资产合计": 400.0, "流动负债合计": 200.0, "未分配利润": 300.0,
             "固定资产": 300.0, "长期借款": lt}
        if st is not None:
            b["短期借款"] = st
        if acc_dep:
            b["累计折旧"] = 50.0 + i * 10.0
        cf = {"经营活动产生的现金流量净额": 120.0,
              "投资活动产生的现金流量净额": -50.0,
              "筹资活动产生的现金流量净额": -20.0,
              "销售商品、提供劳务收到的现金": 1000.0,
              "购建固定资产、无形资产和其他长期资产所支付的现金": -50.0}
        if dep_cf is not None:
            cf["固定资产折旧、油气资产折耗、生产性生物资产折旧"] = dep_cf
        a[y] = {"利润表": pl, "资产负债表": b, "现金流量表": cf}
    return {"annual_data": a, "company_type": "GENERAL"}


# ── 2. calc_ratios（P0-1 EBIT、P1-3 零值、P1-4 r_est） ──────────
import calc_ratios

print("== calc_ratios ==")
d = mk_annual()
r = calc_ratios.calc_all(d)
check("EBIT = 营业利润+财务费用 (100+20=120)", abs(r["profitability"]["2024"]["ebit"] - 120.0) < 1e-9,
      f"got {r['profitability']['2024']['ebit']}")
check("npm 正常 (80/1000=0.08)", abs(r["profitability"]["2024"]["npm"] - 0.08) < 1e-9)
check("sd(0,100)=0.0（零值不丢）", calc_ratios.sd(0, 100) == 0.0)
check("sd(None,100)=None（缺失不造假）", calc_ratios.sd(None, 100) is None)

d_zero_np = mk_annual(pnp=0.0, eps=0.0)
r0 = calc_ratios.calc_all(d_zero_np)
check("净利润=0 时 npm=0.0 而非 None", r0["profitability"]["2024"]["npm"] == 0.0)

d_st0 = mk_annual(st=0.0)
r_st0 = calc_ratios.calc_all(d_st0)
check("短期借款=0 → st_borrowing=0", r_st0["solvency"]["2024"]["st_borrowing"] == 0.0)
check("短期借款缺失 → st_borrowing=None", r["solvency"]["2024"]["st_borrowing"] is None)
check("零负债 → r_est=None", r["roa_vs_r"]["2024"]["r_est"] is None)
check("零负债 → direction=N/A (无有息负债)",
      r["roa_vs_r"]["2024"]["leverage_direction"] == "N/A (无有息负债)")

d_debt = mk_annual(st=100.0, ie=5.0)
r_debt = calc_ratios.calc_all(d_debt)
check("有债有息 → r_est=利息支出/有息负债 (5/100=0.05)",
      abs(r_debt["roa_vs_r"]["2024"]["r_est"] - 0.05) < 1e-9)
check("有债 → direction 为三态之一",
      r_debt["roa_vs_r"]["2024"]["leverage_direction"] in ("CREATES", "DESTROYS", "NEUTRAL"))

# ── 3. calc_risk_models（P0-1、P0-4、P1-2） ──────────────────────
import calc_risk_models as crm

print("== calc_risk_models ==")
z = crm.calc_altman_z(d)
check("Z X3 = EBIT/TA (120/2000=0.06)", abs(z[2024]["x3_ebit_ta"] - 0.06) < 1e-9)
check("derive_shares = 归母净利/EPS 中位数 (80/8=10)", crm.derive_shares(d["annual_data"]) == 10.0)

m = crm.calc_m_score(d_st0)
check("DEPI 数据缺失 → depi=1.0 且 note 非空",
      m[2023]["depi"] == 1.0 and m[2023]["depi_note"] is not None)
check("M-Score 可算时 risk_flag 为 LOW/HIGH",
      m[2023]["risk_flag"] in ("LOW", "HIGH (> -1.78)"))

d_empty = {"annual_data": {"2023": {"利润表": {}, "资产负债表": {}, "现金流量表": {}},
                           "2024": {"利润表": {}, "资产负债表": {}, "现金流量表": {}}},
           "company_type": "GENERAL"}
m2 = crm.calc_m_score(d_empty)
check("M-Score 不可算 → risk_flag=N/A (数据不足)", m2[2024]["risk_flag"] == "N/A (数据不足)")

# ── 4. calc_valuation（P0-4、P1-1、P2a-A1/A2） ───────────────────
import calc_valuation as cv

print("== calc_valuation ==")
years_sorted = sorted(d["annual_data"].keys())

dep, src, rate = cv.derive_depr(d["annual_data"], years_sorted, 1000.0)
check("derive_depr 二级回退 → bs_acc_dep_diff (avg=10)",
      src == "bs_acc_dep_diff" and abs(dep - 10.0) < 1e-9, f"got {src}/{dep}")

d_cfdep = mk_annual(dep_cf=30.0)
dep, src, _ = cv.derive_depr(d_cfdep["annual_data"], years_sorted, 1000.0)
check("derive_depr CF字段优先 → cf_statement (avg=30)", src == "cf_statement" and abs(dep - 30.0) < 1e-9)

d_nodep = mk_annual(acc_dep=False)
dep, src, _ = cv.derive_depr(d_nodep["annual_data"], years_sorted, 1000.0)
check("derive_depr 无数据 → assumed_2pct_revenue (1000*0.02=20)",
      src == "assumed_2pct_revenue" and abs(dep - 20.0) < 1e-9)

nwc = cv.derive_nwc_rate(d["annual_data"], years_sorted)
check("derive_nwc_rate 平稳数据 → 0.0", nwc == 0.0, f"got {nwc}")
d_nwc = mk_annual(ar=(100.0, 102.0, 104.1), revs=(1000.0, 1050.0, 1102.5))
nwc = cv.derive_nwc_rate(d_nwc["annual_data"], years_sorted)
check("derive_nwc_rate 增长数据 → 0.04", abs(nwc - 0.04) < 1e-9, f"got {nwc}")

scen = {"pessimistic": {"wacc": 0.10, "term_g": 0.015, "rev_growth": [-0.03, 0.0, 0.0, 0.0, 0.0],
                        "gm": [0.4] * 5, "sm_rate": [0.1] * 5},
        "neutral": {"wacc": 0.09, "term_g": 0.02, "rev_growth": [0.03, 0.05, 0.05, 0.05, 0.05],
                    "gm": [0.4] * 5, "sm_rate": [0.1] * 5},
        "optimistic": {"wacc": 0.08, "term_g": 0.025, "rev_growth": [0.08, 0.10, 0.10, 0.10, 0.08],
                       "gm": [0.4] * 5, "sm_rate": [0.1] * 5}}

for ct in ("BROKER", "FINANCIAL_HOLDING"):
    dd = dict(d)
    dd["company_type"] = ct
    res = cv.calc_dcf(dd, scen)
    check(f"{ct} 跳过 DCF（P2a-A1）", res.get("skipped") is True)

rel = cv.calc_relative_valuation(d, 15.0, 0.10, scen)
check("justified PB = 3yr中位ROE/Ke (0.08/0.10=0.8)",
      abs(rel["pb_valuation"]["pb_justified"] - 0.8) < 1e-9, f"got {rel['pb_valuation']['pb_justified']}")
check("eps_est = EPS×(1+Y1增速) (8×1.03=8.24)",
      abs(rel["neutral"]["eps_est"] - 8.24) < 1e-9, f"got {rel['neutral']['eps_est']}")

dcf_nwc = cv.calc_dcf(d_nwc, scen)
sen_nwc = cv.calc_sensitivity(d_nwc, scen, 10.0)
center = sen_nwc["matrix"][2]["values"][2]
check("敏感性中心==DCF中性（NWC>0 合成数据，P2a-A2）",
      abs(center / dcf_nwc["neutral"]["per_share"] - 1.0) < 0.001,
      f"center={center:.2f} dcf={dcf_nwc['neutral']['per_share']:.2f}")

# ── 5. 静默硬编码修复（3a/3b） ─────────────────────────────────
print("== 硬编码修复 ==")
dcf_synth = cv.calc_dcf(d, scen)
dd15 = dcf_synth["neutral"]["derived"]
check("tax_source=assumed_0.15（合成数据无所得税字段）", dd15["tax_source"] == "assumed_0.15",
      f"got {dd15['tax_source']}")
check("capex_source=cf_statement（合成数据有capex）", dd15["capex_source"] == "cf_statement")
check("minority_source=derived（合成数据有少数股东权益）", dd15["minority_source"] == "derived")

d_norev = json.loads(json.dumps(d))
for y in d_norev["annual_data"]:
    del d_norev["annual_data"][y]["利润表"]["营业收入"]
res = cv.calc_dcf(d_norev, scen)
check("营收缺失 → calc_dcf 报错不编数字（原 or 1）", res.get("error") is not None)
d_nopnp = json.loads(json.dumps(d))
for y in d_nopnp["annual_data"]:
    del d_nopnp["annual_data"][y]["利润表"]["归属于母公司所有者的净利润"]
rim_err = cv.calc_rim(d_nopnp, 0.09, 0.025)
check("数据缺失 → calc_rim 报错（原 or 1/or 10）", rim_err.get("error") is not None)
rim_ok = cv.calc_rim(d, 0.09, 0.025)
check("RIM 稳定模式：ROE 8% < Ke 9% → PB=0.846<1（原hack强制1.0）",
      rim_ok["mode"] == "stable_perpetuity" and abs(rim_ok["implied_pb"] - 0.8461538461538461) < 1e-9,
      f"got mode={rim_ok['mode']} pb={rim_ok['implied_pb']}")
check("RIM roe_latest=0.08, bps=100",
      abs(rim_ok["roe_latest"] - 0.08) < 1e-9 and abs(rim_ok["bps"] - 100.0) < 1e-9)
check("RIM 留存率字段缺失 → retention_source=assumed_0.5",
      rim_ok["retention_source"] == "assumed_0.5")
check("PB估值输出含 band_basis 口径说明", "band_basis" in rel["pb_valuation"])

d_fade = json.loads(json.dumps(d))
d_fade["annual_data"]["2024"]["利润表"]["归属于母公司所有者的净利润"] = 300.0
rim_fade = cv.calc_rim(d_fade, 0.09, 0.025)
check("RIM 衰减模式：最新ROE 30% vs 历史 8% → fade_to_anchor(5y)",
      rim_fade["mode"] == "fade_to_anchor(5y)", f"got {rim_fade['mode']}")
check("RIM re_series 长度=5 且首年 ROE=0.256",
      len(rim_fade["re_series"]) == 5 and abs(rim_fade["re_series"][0]["roe"] - 0.256) < 1e-9,
      f"got {rim_fade['re_series'][0]['roe'] if rim_fade['re_series'] else None}")

d_div = json.loads(json.dumps(d))
for y in d_div["annual_data"]:
    d_div["annual_data"][y]["现金流量表"]["分配股利、利润或偿付利息支付的现金"] = -40.0
rim_div = cv.calc_rim(d_div, 0.09, 0.025)
check("RIM 留存率从CF推导（分红40/净利80=50%）→ retention_source=cf_derived",
      rim_div["retention_source"] == "cf_derived" and abs(rim_div["payout_ratio"] - 0.5) < 1e-9)

rim_conv = cv.calc_rim(d, 0.09, 0.085)
check("RIM Ke-g≤1% → 报错不收敛", rim_conv.get("error") is not None)

# ── 汇总 ────────────────────────────────────────────────────────
print()
if FAILED:
    print(f"FAILED: {len(FAILED)} 项 -> {FAILED}")
    sys.exit(1)
print("ALL TESTS PASSED")
