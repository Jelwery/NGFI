import requests
import urllib.request
import math
import pandas as pd

def full_valuation(code: str) -> dict:
    """单票完整估值分析"""
    # 1. 腾讯实时行情
    # 92 必须先判：北交所 2024-10 起启用 920xxx 号段，裸 startswith("9") 会误判成沪市，
    # 腾讯对 sh920xxx 返回空载荷（静默失败）。900xxx 沪市 B 股仍走 sh。
    prefix = ("bj" if code.startswith(("92", "8"))
              else "sh" if code.startswith(("6", "9")) else "sz")
    url = f"https://qt.gtimg.cn/q={prefix}{code}"
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0")
    resp = urllib.request.urlopen(req, timeout=10)
    data = resp.read().decode("gbk")
    vals = data.split('"')[1].split("~")
    price = float(vals[3])
    mcap = float(vals[45])   # 45=总市值（44 是流通市值，见「腾讯行情字段」踩坑提醒二）
    pe_ttm = float(vals[39]) if vals[39] else 0
    pb = float(vals[46]) if vals[46] else 0

    # 2. 机构一致预期（直连同花顺）
    df = ths_eps_forecast(code)
    eps_cur = eps_next = None
    analyst_count = 0
    if not df.empty and len(df.columns) >= 3:
        # 按列名取「均值」=机构一致预期EPS（见 ths_eps_forecast 文档）。
        # 不按 iloc 位置取——同花顺表格列序会变；且旧版误用 iloc[2]＝「最小值」
        # 当成一致预期，导致 pe_forward/PEG 系统性偏差，此处一并修正。
        def _pick(row, name):
            for c in df.columns:
                if name in str(c):
                    return row.get(c)
            return None
        try:
            r0 = df.iloc[0]
            v = _pick(r0, "均值");          eps_cur = float(v) if pd.notna(v) else None
            cnt = _pick(r0, "预测机构数");  analyst_count = int(cnt) if pd.notna(cnt) else 0
            if len(df) >= 2:
                vn = _pick(df.iloc[1], "均值"); eps_next = float(vn) if pd.notna(vn) else None
        except (ValueError, TypeError) as e:
            print(f"[WARN] full_valuation EPS 解析失败({e})，估值可能不完整")

    # 3. 估值指标
    pe_fwd = price / eps_cur if eps_cur else float("inf")
    cagr = (eps_next / eps_cur - 1) if (eps_cur and eps_next) else 0
    peg = pe_fwd / (cagr * 100) if cagr > 0 else float("inf")
    digest = (
        math.log(pe_fwd / 30) / math.log(1 + cagr)
        if pe_fwd > 30 and cagr > 0 else 0
    )

    return {
        "name": vals[1],
        "price": price,
        "mcap_yi": mcap,
        "pe_ttm": pe_ttm,
        "pb": pb,
        "eps_cur": eps_cur,
        "eps_next": eps_next,
        "pe_fwd": round(pe_fwd, 1) if eps_cur else None,
        "cagr_pct": round(cagr * 100, 0) if cagr else None,
        "peg": round(peg, 2) if peg != float("inf") else None,
        "digest_years": round(digest, 1),
        "analyst_count": analyst_count,
    }

# 用法
result = full_valuation("688017")
print(result)
