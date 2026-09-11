from datetime import datetime, timedelta

def lockup_expiry(code: str, trade_date: str, forward_days: int = 90) -> dict:
    """
    限售解禁日历。
    返回: {history: [...], upcoming: [...]}
    """
    # 1. 历史解禁记录
    history_data = eastmoney_datacenter(
        "RPT_LIFT_STAGE",
        filter_str=f"(SECURITY_CODE=\"{code}\")",
        page_size=15,
        sort_columns="FREE_DATE", sort_types="-1",
    )
    history = []
    for row in history_data:
        history.append({
            "date": str(row.get("FREE_DATE", ""))[:10],
            "type": row.get("FREE_SHARES_TYPE", ""),        # 解禁类型(东财2026改列名, 旧LIMITED_STOCK_TYPE已废)
            "shares": row.get("FREE_SHARES", 0),             # 本次解禁股数(万股)
            "able_shares": row.get("ABLE_FREE_SHARES", 0),   # 实际可流通股数(万股, 更贴近真实抛压)
            "ratio": row.get("FREE_RATIO", 0),               # 占总股本比(小数, ×100 得百分比)
        })

    # 2. 未来待解禁
    end_date = datetime.strptime(trade_date, "%Y-%m-%d") + timedelta(days=forward_days)
    end_str = end_date.strftime("%Y-%m-%d")
    upcoming_data = eastmoney_datacenter(
        "RPT_LIFT_STAGE",
        filter_str=f"(SECURITY_CODE=\"{code}\")(FREE_DATE>='{trade_date}')(FREE_DATE<='{end_str}')",
        page_size=20,
        sort_columns="FREE_DATE", sort_types="1",
    )
    upcoming = []
    for row in upcoming_data:
        upcoming.append({
            "date": str(row.get("FREE_DATE", ""))[:10],
            "type": row.get("FREE_SHARES_TYPE", ""),        # 解禁类型(东财2026改列名, 旧LIMITED_STOCK_TYPE已废)
            "shares": row.get("FREE_SHARES", 0),             # 本次解禁股数(万股)
            "able_shares": row.get("ABLE_FREE_SHARES", 0),   # 实际可流通股数(万股, 更贴近真实抛压)
            "ratio": row.get("FREE_RATIO", 0),               # 占总股本比(小数, ×100 得百分比)
        })

    return {"history": history, "upcoming": upcoming}

# 用法
data = lockup_expiry("002475", "2026-05-17")
print(f"历史解禁 {len(data['history'])} 批")
for h in data["history"][:5]:
    print(f"  {h['date']}: {h['type']} 数量={h['shares']}")
if data["upcoming"]:
    print(f"未来90天待解禁 {len(data['upcoming'])} 批")
else:
    print("未来90天无待解禁")
