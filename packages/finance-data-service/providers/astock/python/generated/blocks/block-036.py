from contextlib import contextmanager

import baostock as bs
import pandas as pd


@contextmanager
def bs_session():
    """baostock 登录会话 — 必须用上下文管理器，异常路径也保证 logout"""
    lg = bs.login()
    if lg.error_code != "0":
        raise RuntimeError(f"baostock 登录失败: {lg.error_code} {lg.error_msg}")
    try:
        yield
    finally:
        bs.logout()


def _rs_to_df(rs) -> pd.DataFrame:
    """baostock ResultData → DataFrame；错误码转异常，绝不静默返回空表"""
    if rs.error_code != "0":
        raise RuntimeError(f"baostock 查询失败: {rs.error_code} {rs.error_msg}")
    rows = []
    while rs.next():
        rows.append(rs.get_row_data())
    return pd.DataFrame(rows, columns=rs.fields)


def _bs_code(code: str) -> str:
    """6位代码 → baostock 格式；北交所在登录前就拦掉"""
    code = str(code).zfill(6)
    if code[:2] in ("60", "68", "90"):
        return f"sh.{code}"
    if code[:2] in ("00", "30", "20"):
        return f"sz.{code}"
    raise ValueError(
        f"baostock 不支持该代码: {code}（北交所 4/8/92/920 号段会被服务端拒绝，"
        f"报 10004011 股票代码未标识sh或sz）。北交所估值请改用 §1.2 腾讯当日快照。"
    )


def baostock_valuation_history(code: str, start_date: str, end_date: str) -> pd.DataFrame:
    """估值历史序列 — PE/PB/PS/PCF + 换手率 + 停牌 + ST，日频"""
    bs_code = _bs_code(code)          # 先校验，失败就不必登录
    fields = "date,code,close,peTTM,pbMRQ,psTTM,pcfNcfTTM,turn,tradestatus,isST"
    with bs_session():
        rs = bs.query_history_k_data_plus(
            bs_code, fields, start_date=start_date, end_date=end_date,
            frequency="d", adjustflag="3",     # 3=不复权，与 §1.1 通达信口径一致
        )
        df = _rs_to_df(rs)
    for c in ("close", "peTTM", "pbMRQ", "psTTM", "pcfNcfTTM", "turn"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


# 用法
df = baostock_valuation_history("600519", "2016-01-04", "2026-08-18")
print(len(df), "行", df.iloc[0]["date"], "→", df.iloc[-1]["date"])
print(df.tail(2)[["date", "close", "peTTM", "pbMRQ", "psTTM", "turn", "isST"]].to_string(index=False))
# 实测 2026-08-19：2581 行；2026-08-18 peTTM=19.93 pbMRQ=6.46 psTTM=9.37 turn=0.3098

# ST 标记实测有效：000004 在 2024-01 至今的 610 个交易日里有 276 天 isST=1
st = baostock_valuation_history("000004", "2024-01-01", "2026-08-18")
print("isST 分布:", st["isST"].value_counts().to_dict())     # {'0': 334, '1': 276}

# 停牌：tradestatus == "0"
print("停牌天数:", (df["tradestatus"] == "0").sum())
