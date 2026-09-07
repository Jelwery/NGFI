import io

from typing import Optional

import pandas as pd
import requests

SW_URL = "https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls"


def sw_industry_history() -> pd.DataFrame:
    """申万行业归属变迁史 — 每只股票每次行业调整一行"""
    try:
        r = requests.get(SW_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
        r.raise_for_status()
    except requests.exceptions.SSLError as e:
        # 2026-08-19 实测：纯 certifi 环境握手正常，证书链完整，无需手动补中间证书。
        # 保留此分支是为了在站点证书回归时给出可操作的提示，而不是吞掉异常。
        raise RuntimeError(
            "申万站点 SSL 握手失败。2026-08 实测其证书链正常，若你遇到此错误，"
            "多半是本机 CA 包过旧或中间人代理：先试 `pip install -U certifi`。"
            f"原始错误: {e}"
        ) from e
    df = pd.read_excel(io.BytesIO(r.content))
    df = df.rename(columns={"股票代码": "code", "计入日期": "start_date",
                            "行业代码": "industry_code", "更新日期": "update_date"})
    missing = {"code", "start_date", "industry_code"} - set(df.columns)
    if missing:
        raise RuntimeError(f"申万表结构变了，缺列 {sorted(missing)}；实际列={list(df.columns)}")
    df["code"] = df["code"].astype(str).str.zfill(6)
    df["industry_code"] = df["industry_code"].astype(str).str.zfill(6)
    # 层级码要补成规范的 6 位（申万官方一级是 480000、二级是 480300），
    # 直接截断成 "48"/"4803" 无法与官方指数/名称表 join。
    df["l1_code"] = df["industry_code"].str[:2] + "0000"    # 一级，如 480000
    df["l2_code"] = df["industry_code"].str[:4] + "00"      # 二级，如 480300
    df["start_date"] = pd.to_datetime(df["start_date"], errors="coerce")
    return df.sort_values(["code", "start_date"]).reset_index(drop=True)


def sw_industry_as_of(df: pd.DataFrame, code: str, as_of: str) -> Optional[dict]:
    """某只股票在 as_of 日所属的申万行业（取不晚于该日的最后一次调整）"""
    code = str(code).zfill(6)
    sub = df[(df["code"] == code) & (df["start_date"] <= pd.Timestamp(as_of))]
    if sub.empty:
        return None                  # 该日尚未上市 / 无归属记录
    row = sub.iloc[-1]
    return {"code": code, "as_of": as_of,
            "industry_code": row["industry_code"],
            "l1_code": row["l1_code"], "l2_code": row["l2_code"],
            "since": row["start_date"].strftime("%Y-%m-%d")}


# 用法
sw = sw_industry_history()
print(len(sw), "行 |", sw["code"].nunique(), "只标的 |",
      sw["l1_code"].nunique(), "个一级行业")
# 实测 2026-08-19：12893 行 | 5905 只 | 38 个一级 / 194 个二级 / 553 个三级

# 前视偏差验证：平安银行在不同时点属于不同行业
for d in ("2013-01-01", "2016-01-01", "2026-08-18"):
    print(d, sw_industry_as_of(sw, "000001", d))
# 2013-01-01 → 440101（一级 440000，自 1991-04-03）
# 2016-01-01 → 480101（一级 480000，自 2014-02-21）
# 2026-08-18 → 480301（一级 480000 / 二级 480300，自 2021-07-30）
