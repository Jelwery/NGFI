import urllib.request

def tencent_quote(codes: list[str]) -> dict[str, dict]:
    """
    批量拉取腾讯财经实时行情。
    codes: ["688017", "300476", "002463"]
    也支持指数: ["000001", "000300", "399006"]
    也支持ETF: ["510050", "510300"]
    返回: {code: {name, price, pe_ttm, pb, mcap, ...}}
    """
    # 前缀路由：与全局 get_prefix() 一致。5x 沪ETF / 000300 等沪指数不能落到 sz（会返回空或错票）。
    SH_INDEX = {"000300", "000905", "000016", "000688", "000852", "000010"}   # 沪指数白名单
    prefixed = []
    key_of = {}          # 带前缀的查询键 → 调用方原始写法，保证结果键与入参一一对应
    for c in codes:
        low = c.lower()
        if low.startswith(("sh", "sz", "bj")):        # 显式前缀透传，解决 000001 等歧义
            p = low
        elif c.startswith("92"):                      # 北交所 920 号段须先于 9x 判断
            p = f"bj{c}"
        elif c in SH_INDEX or c.startswith(("5", "6", "9")):
            p = f"sh{c}"
        elif c.startswith(("4", "8")):
            p = f"bj{c}"
        else:
            p = f"sz{c}"
        prefixed.append(p)
        key_of[p] = c    # 显式前缀入参原样返回，裸代码返回裸代码

    url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0")
    resp = urllib.request.urlopen(req, timeout=10)
    data = resp.read().decode("gbk")

    result = {}
    for line in data.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        # 用入参原样做键：批量里同时传 sh000001 与 sz000001 时，若都退回裸 6 位码
        # 会撞成同一个键、后者静默覆盖前者，显式前缀这个特性就白做了。
        code = key_of.get(key, key[2:])
        result[code] = {
            "name":         vals[1],
            "price":        float(vals[3]) if vals[3] else 0,
            "last_close":   float(vals[4]) if vals[4] else 0,
            "open":         float(vals[5]) if vals[5] else 0,
            "change_amt":   float(vals[31]) if vals[31] else 0,
            "change_pct":   float(vals[32]) if vals[32] else 0,
            "high":         float(vals[33]) if vals[33] else 0,
            "low":          float(vals[34]) if vals[34] else 0,
            "amount_wan":   float(vals[37]) if vals[37] else 0,
            "turnover_pct": float(vals[38]) if vals[38] else 0,
            "pe_ttm":       float(vals[39]) if vals[39] else 0,
            "amplitude_pct":float(vals[43]) if vals[43] else 0,
            # ⚠️ 44=流通市值、45=总市值（曾标反）。总股本≠流通股本时差数倍，见上方踩坑提醒二
            "float_mcap_yi":float(vals[44]) if vals[44] else 0,
            "mcap_yi":      float(vals[45]) if vals[45] else 0,
            "pb":           float(vals[46]) if vals[46] else 0,
            "limit_up":     float(vals[47]) if vals[47] else 0,
            "limit_down":   float(vals[48]) if vals[48] else 0,
            "vol_ratio":    float(vals[49]) if vals[49] else 0,
            "pe_static":    float(vals[52]) if vals[52] else 0,
        }
        # 僵尸报价检测：腾讯对「已迁移的北交所老码 / 长期停牌股」照样返回 HTTP 200 +
        # 一份定格在最后交易日的报价（成交量 0、最新价==昨收），不报任何错。
        # 直接拿去算估值会得出完全错误的结论（实测 bj832982 报 112.60，真实新码 920982 为 131.74）。
        q = result[code]
        q["is_stale"] = (q["amount_wan"] == 0 and q["price"] == q["last_close"] and q["price"] > 0)
        if q["is_stale"] and key[2:4] in ("43", "83", "87"):
            q["stale_reason"] = "北交所老号段，多数已迁至 920xxx，请按名称反查现行代码"
        elif q["is_stale"]:
            q["stale_reason"] = "成交量为 0（停牌 / 未开盘 / 废码），报价非当日真实成交"
    return result

# 用法: 个股
quotes = tencent_quote(["688017", "300476", "002463"])
for code, q in quotes.items():
    print(f"{q['name']}({code}): {q['price']}元 PE={q['pe_ttm']} PB={q['pb']} 市值={q['mcap_yi']}亿")

# 用法: 指数 — sh000001=上证指数, sh000300=沪深300, sz399006=创业板指
index_quotes = tencent_quote(["000001", "000300", "399006"])

# 用法: ETF — sh510050=上证50ETF, sh510300=沪深300ETF
etf_quotes = tencent_quote(["510050", "510300"])
