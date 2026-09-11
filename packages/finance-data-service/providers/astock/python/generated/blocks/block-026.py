def dividend_history(code: str, page_size: int = 20) -> list[dict]:
    """
    分红送转历史。
    返回: [{date, bonus_rmb(每股派息), transfer_ratio(转增比例), bonus_ratio(送股比例)}]
    """
    data = eastmoney_datacenter(
        "RPT_SHAREBONUS_DET",
        filter_str=f'(SECURITY_CODE="{code}")',
        page_size=page_size,
        sort_columns="EX_DIVIDEND_DATE", sort_types="-1",
    )
    rows = []
    for row in data:
        rows.append({
            "date": str(row.get("EX_DIVIDEND_DATE", ""))[:10],
            "bonus_rmb": row.get("PRETAX_BONUS_RMB", 0),    # 每股派息(税前)
            "transfer_ratio": row.get("TRANSFER_RATIO", 0),  # 每10股转增
            "bonus_ratio": row.get("BONUS_RATIO", 0),        # 每10股送股
            "plan": row.get("ASSIGN_PROGRESS", ""),           # 进度
        })
    return rows

# 用法
data = dividend_history("600519")
for d in data[:5]:
    print(f"{d['date']}: 每股派息={d['bonus_rmb']}元 转增={d['transfer_ratio']} 送={d['bonus_ratio']}")
