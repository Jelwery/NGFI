import requests

# 板块类型 → 东财 fs 参数
_BOARD_FS = {"industry": "m:90+t:2", "concept": "m:90+t:3", "region": "m:90+t:1"}
# 周期 → (排序fid, 主力净额, 主力净占比, 涨跌幅, 领涨股name)；四档明细仅今日
_BOARD_PERIOD = {
    "today": ("f62",  "f62",  "f184", "f3",   "f204"),
    "5d":    ("f164", "f164", "f165", "f109", "f257"),
    "10d":   ("f174", "f174", "f175", "f160", None),   # 10日领涨股名称字段不稳定，省略
}

def board_fund_flow(board_type: str = "industry", period: str = "today",
                    top_n: int = 20) -> dict:
    """
    板块资金流向排名（按主力净流入降序）。
    board_type: industry(行业) / concept(概念) / region(地域)
    period:     today(今日) / 5d(5日) / 10d(10日)
    返回: {board_type, period, total, rows:[{rank, name, code, change_pct,
           main_net(主力净额,元), main_pct(主力净占比,%), leader(领涨股),
           # 仅 today：super_large_net/large_net/medium_net/small_net(超大/大/中/小单净额,元)}]}
    注：板块级只有 今日/5日/10日（无 3日，个股级才有）。主力净额 = 超大单 + 大单。
    """
    if board_type not in _BOARD_FS:
        raise ValueError(f"board_type 须为 {list(_BOARD_FS)}")
    if period not in _BOARD_PERIOD:
        raise ValueError(f"period 须为 {list(_BOARD_PERIOD)}")
    fid, f_main, f_pct, f_chg, f_leader = _BOARD_PERIOD[period]

    fields = ["f12", "f14", f_chg, f_main, f_pct]
    if f_leader:
        fields.append(f_leader)
    if period == "today":
        fields += ["f66", "f72", "f78", "f84"]   # 超大/大/中/小单净额

    url = "https://push2.eastmoney.com/api/qt/clist/get"
    base = {
        "pz": "200", "po": "1", "np": "1",
        "fltt": "2", "invt": "2", "fid": fid,       # fid + po=1：按该周期主力净额降序
        "fs": _BOARD_FS[board_type],
        "fields": ",".join(dict.fromkeys(fields)),  # 去重保序
    }
    # ⚠️ 板块数超过单页上限：实测行业 496 个、概念 495 个，写死 pz=200 会把两者都截断，
    # total 也会误报成 200。先取第一页拿真实 total，需要更多才翻页（多数调用 top_n≤200，
    # 只发一次请求；em_get 有限流，不无谓翻页）。
    def _page(pn: int):
        r = em_get(url, params={**base, "pn": str(pn)},
                   headers={"User-Agent": UA}, timeout=15)
        d = r.json().get("data") or {}
        return (d.get("diff") or []), int(d.get("total") or 0)

    _PAGE = 200
    items, total = _page(1)
    pn = 2
    while len(items) < top_n:
        if total and len(items) >= total:
            break                      # 已取满接口声明的总数
        more, _ = _page(pn)
        if not more:
            break                      # 防御：API 提前返空则停止，避免死循环
        items += more
        pn += 1
        if len(more) < _PAGE:
            break                      # 不足一页＝已到末页（total 缺失时的收敛条件）
    total = max(total, len(items))

    rows = []
    for i, it in enumerate(items):
        row = {
            "rank": i + 1,
            "name": it.get("f14", ""),
            "code": it.get("f12", ""),
            "change_pct": it.get(f_chg, 0),
            "main_net": it.get(f_main, 0),          # 主力净流入净额（元）
            "main_pct": it.get(f_pct, 0),           # 主力净流入净占比（%）
            "leader": it.get(f_leader, "") if f_leader else "",
        }
        if period == "today":
            row.update({
                "super_large_net": it.get("f66", 0),
                "large_net":       it.get("f72", 0),
                "medium_net":      it.get("f78", 0),
                "small_net":       it.get("f84", 0),
            })
        rows.append(row)

    return {"board_type": board_type, "period": period,
            "total": total, "rows": rows[:top_n]}

# 用法
d = board_fund_flow("industry", "today", 10)
print(f"行业板块今日主力净流入 TOP{len(d['rows'])}（共 {d['total']} 个）:")
for r in d["rows"]:
    print(f"  {r['rank']}. {r['name']}: 主力 {r['main_net']/1e8:.2f}亿 ({r['main_pct']}%) "
          f"涨跌{r['change_pct']}% 超大{r['super_large_net']/1e8:.2f}亿 领涨{r['leader']}")

# 概念板块 5 日资金流
concept_5d = board_fund_flow("concept", "5d", 10)
# 地域板块 10 日资金流
region_10d = board_fund_flow("region", "10d", 10)
