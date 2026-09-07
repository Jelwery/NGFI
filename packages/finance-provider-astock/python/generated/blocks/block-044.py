from datetime import datetime, timedelta, timezone   # 不要 import datetime 模块：§8.2 的 `from datetime import datetime` 会遮蔽它

# A 股的"今天"按北京时间算。用本机 date.today() 在海外时区会错开一天
# （如新西兰比北京早 4~5 小时，北京傍晚时本机已跨到次日），
# 监控窗口首日/末日会因此提前纳入或提前剔除。
CN_TZ = timezone(timedelta(hours=8))

def cn_today() -> str:
    """北京时间的今天（YYYY-MM-DD）。"""
    return datetime.now(CN_TZ).date().isoformat()

MONITOR_URL = "https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json"

# ⚠️ MARKET 是三值且**含字母 "B"**（北交所），不是 0/1 二值。
# 写成 `"SH" if MARKET=="1" else "SZ"` 会把北交所标的整片错标成 SZ——
# 实测 2026-07-31 全量 16 只里就有 3 只 MARKET="B"（*ST康乐 920575 等）。
_MONITOR_MARKET = {"1": "SH", "0": "SZ", "B": "BJ"}

def em_stock_monitor(only_active: bool = True) -> list[dict]:
    """东财重点监控池。
    only_active=True 只留今天仍在监控窗口内的（按 VALIDATESTARTDATE~VALIDATEENDDATE 过滤）。
    返回: [{code, name, market, start, end, link}]
    """
    r = em_get(MONITOR_URL, headers={"Referer": "https://vipmoney.eastmoney.com/"}, timeout=20)
    rows = r.json() or []
    today = cn_today()
    out = []
    for x in rows:
        start, end = x.get("VALIDATESTARTDATE", ""), x.get("VALIDATEENDDATE", "")
        if only_active and not (start <= today <= end):
            continue
        raw_mkt = str(x.get("MARKET", "")).upper()
        out.append({
            "code":   x.get("STKCODE", ""),
            "name":   x.get("STKNAME", ""),
            # 未知取值不猜市场，原样带出（`?<原值>`），避免静默标错
            "market": _MONITOR_MARKET.get(raw_mkt, f"?{raw_mkt}"),
            "start":  start, "end": end,
            "link":   x.get("LINK_URL", ""),
        })
    return out

# 用法
pool = em_stock_monitor()
print(f"当前重点监控 {len(pool)} 只")
for s in pool[:5]:
    print(f"  {s['code']} {s['name']}({s['market']}) 监控期 {s['start']}~{s['end']}")
