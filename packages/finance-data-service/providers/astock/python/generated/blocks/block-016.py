import requests

def eastmoney_fund_flow_minute(code: str) -> list[dict]:
    """
    个股资金流向（分钟级，当日盘中）。
    code: 6位股票代码
    返回: [{time, main_net, small_net, mid_net, large_net, super_net}, ...]
    单位: 元
    """
    # #46：secid 必须走 em_secid()。旧的 `startswith("6")` 会把沪市 ETF(51x)、
    # 科创 ETF(588x)、沪 B(900x) 错判成深市 → 接口返回 `data: null`。
    # ⚠️ 但要分清两件事：**路由修好 ≠ ETF 就有资金流**。2026-08-19 同批次实测，
    #    600519/300750 各返回 100 条，而 510300/588000 即便 secid 正确仍为 0 条 ——
    #    东财这个**个股**资金流接口本身不覆盖 ETF。ETF 资金流请另找端点。
    secid = em_secid(code)
    url = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get"
    params = {
        "secid": secid, "klt": 1,
        "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56,f57",
    }
    headers = {
        "User-Agent": UA,
        "Referer": "https://quote.eastmoney.com/",
        "Origin": "https://quote.eastmoney.com",
    }
    try:
        r = em_get(url, params=params, headers=headers, timeout=10)
        d = r.json()
    except Exception as e:
        print(f"[WARN] push2 资金流请求失败: {e}")
        return []

    rows = []
    # #46：接口对不存在/路由错误的 secid 返回 `"data": null`，
    # `.get("data", {})` 拿到的是 None 而非 {}，直接 .get() 会 AttributeError。
    for line in (d.get("data") or {}).get("klines") or []:
        parts = line.split(",")
        if len(parts) >= 6:
            rows.append({
                "time": parts[0],
                "main_net": float(parts[1]),
                "small_net": float(parts[2]),
                "mid_net": float(parts[3]),
                "large_net": float(parts[4]),
                "super_net": float(parts[5]),
            })
    return rows

# 用法: 分钟级实时资金流
realtime = eastmoney_fund_flow_minute("000858")
if realtime:
    last = realtime[-1]
    signal = "bullish" if last["main_net"] > 0 else "bearish"
    print(f"主力净流入: {last['main_net']:.0f}元 → {signal}")
    # 统计全天主力净流入
    total = sum(r["main_net"] for r in realtime)
    print(f"全天主力累计: {total/1e4:.0f}万元")
