ANOMALY_BASE = "https://dycalchis.eastmoney.com/price-anomaly"
# 东财 H5 固定公共参数，缺 team 会被拒（unknow team）
HQ_PARAMS = {"team": "h5", "product": "EastMoney", "client": "WAP",
             "version": "9001", "name": "WAP", "user": "123"}

# 异动规则码（e 字段）→ 文字说明；s==6 且 e∈{4,5,6,7} 时按 e*10 取更严阈值那档
ANOMALY_RULES = {
    1:  "主板连续10个交易日内4次出现同向异常波动",
    2:  "创业板连续10个交易日内3次出现同向异常波动",
    3:  "科创板连续10个交易日内3次出现同向异常波动",
    4:  "连续十个交易日内日收盘价涨跌幅偏离值累计达到+100%",
    5:  "连续十个交易日内日收盘价涨跌幅偏离值累计达到-50%",
    6:  "连续三十个交易日内日收盘价涨跌幅偏离值累计达到+200%",
    7:  "连续三十个交易日内日收盘价涨跌幅偏离值累计达到-70%",
    8:  "北交所连续10个交易日内3次出现同向异常波动",
    40: "连续十个交易日内日收盘价涨跌幅偏离值累计达到+150%",
    50: "连续十个交易日内日收盘价涨跌幅偏离值累计达到-60%",
    60: "连续30个交易日内日收盘价涨跌幅偏离值累计达到+300%",
    70: "连续30个交易日内日收盘价涨跌幅偏离值累计达到-75%",
}

def _anomaly_market(code, m, board=None) -> str:
    """异动记录 → 交易所。
    ⚠️ 不能只看 m：东财体系里**北交所与深市同为 m=0**（拉北交所清单用的就是 `m:0+t:81`），
       只按 `m==1 else "SZ"` 会把北交所标的错标成 SZ——而异动规则码 8 正是北交所专用，
       说明北交所记录确实会出现在本接口。代码号段无歧义，优先用它判。
    """
    c = str(code or "")
    if c.startswith(("4", "8", "92")) or board == 8:   # 与 get_prefix() 同一套号段规则（#51）
        return "BJ"
    return "SH" if m == 1 else "SZ"

def _anomaly_get(path: str, page_size: int, page_no: int, **extra) -> dict:
    params = {**HQ_PARAMS, "pageSize": str(page_size), "pageNo": str(page_no), **extra}
    r = em_get(f"{ANOMALY_BASE}/{path}", params=params,
               headers={"Referer": "https://vipmoney.eastmoney.com/"}, timeout=20)
    d = r.json()
    if d.get("result") != 0:
        # 正向识别：接口用 result!=0 表达拒绝，不能当成「今天没异动」静默吞掉
        raise RuntimeError(f"东财异动接口拒绝: result={d.get('result')} msg={d.get('msg')!r}")
    return d

def em_price_anomaly(page_size: int = 200, page_no: int = 1) -> dict:
    """日内异动明细（price-anomaly/list）。返回 {date, items:[...]}"""
    d = _anomaly_get("list", page_size, page_no)
    items = []
    for x in d.get("data") or []:
        e = x.get("e")
        key = e * 10 if (x.get("s") == 6 and e in (4, 5, 6, 7)) else e
        items.append({
            "code": x.get("c"), "name": x.get("n"),
            "market": _anomaly_market(x.get("c"), x.get("m"), x.get("s")),
            "change_pct": x.get("a"),          # 当日涨跌幅%
            "deviation": x.get("x"),           # 累计偏离值%
            "days": x.get("d"),                # 统计窗口天数
            "board": x.get("s"),               # 板块码：1=主板 4=创业板 6=科创板(阈值加严) 8=北交所
            "rule_code": key,
            "rule": ANOMALY_RULES.get(key, f"未知规则码 {key}"),
            "is_today": x.get("o") != 2,
        })
    return {"date": str(d.get("date", "")), "pages": d.get("pages", 0), "items": items}

def em_price_anomaly_count(page_size: int = 50, page_no: int = 1,
                           sort_key: str = "", sort_dir: str = "") -> dict:
    """异动统计（price-anomaly/count）：按标的聚合的异动次数 + 现价。"""
    d = _anomaly_get("count", page_size, page_no, sortKey=sort_key, sortDir=sort_dir)
    items = [{
        "code": x.get("c"), "name": x.get("n"),
        "market": _anomaly_market(x.get("c"), x.get("m"), x.get("s")),
        "price": x.get("p"),                 # 最新价（已核对腾讯行情，3/3 一致）
        "change_pct": x.get("a"),            # 涨跌幅%（已核对腾讯行情，3/3 一致）
        "times": x.get("t"),                 # 窗口内异动次数
        "deviation": x.get("x"),             # 累计偏离值%
        "days": x.get("d"),                  # 统计窗口天数
        "board": x.get("s"),
    } for x in d.get("data") or []]
    return {"date": str(d.get("date", "")), "pages": d.get("pages", 0), "items": items}

# 用法
a = em_price_anomaly(page_size=200)
print(f"{a['date']} 日内异动 {len(a['items'])} 条")
for s in a["items"][:5]:
    print(f"  {s['code']} {s['name']} {s['change_pct']}% 偏离{s['deviation']}%/{s['days']}日 | {s['rule']}")

c = em_price_anomaly_count(page_size=50)
for s in c["items"][:5]:
    print(f"  {s['code']} {s['name']} {s['price']}元 {s['change_pct']}% 异动{s['times']}次")

# 与重点监控池交叉：异动 且 已在监控名单 = 最高风险
monitor_codes = {x["code"] for x in em_stock_monitor()}
hot = [s for s in a["items"] if s["code"] in monitor_codes]
print(f"异动且在监控池: {[(s['code'], s['name']) for s in hot]}")
