def limit_up_sentiment(date: str) -> dict:
    """打板情绪温度计：连板梯队 + 炸板率 + 涨跌停对比。"""
    zt, zb, dt = em_zt_pool(date), em_zb_pool(date), em_dt_pool(date)
    ladder = {}
    for s in zt:
        ladder[s["limit_days"]] = ladder.get(s["limit_days"], 0) + 1
    zt_n, zb_n = len(zt), len(zb)
    return {"date": date, "zt_count": zt_n, "zb_count": zb_n, "dt_count": len(dt),
        "break_rate": round(zb_n / (zt_n + zb_n) * 100, 1) if (zt_n + zb_n) else 0,  # 炸板率%
        "max_height": max((s["limit_days"] for s in zt), default=0),                 # 最高连板
        "ladder": dict(sorted(ladder.items()))}                                       # 连板梯队 {板数:家数}

# 用法
s = limit_up_sentiment("20260626")
print(f"涨停{s['zt_count']} 炸板{s['zb_count']}(炸板率{s['break_rate']}%) "
      f"跌停{s['dt_count']} 最高{s['max_height']}连板")
print(f"连板梯队: {s['ladder']}")
