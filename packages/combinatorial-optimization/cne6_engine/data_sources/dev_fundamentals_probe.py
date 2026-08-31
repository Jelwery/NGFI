# cne6_engine/data_sources/dev_fundamentals_probe.py
"""Dev-only helper to debug Layer-3 descriptors with real AKShare data.

This is NOT the production Line-1/Line-2 fetcher (owned by the data team).
It exists so the algorithm layer can be eyeballed against real values:
fetch one annual statement period, merge into the FUNDAMENTAL_SCHEMA contract,
and hand the parquet to a script that runs compute_descriptors.

Usage (from CNE6 root):
    python -m cne6_engine.data_sources.dev_fundamentals_probe --probe
    python -m cne6_engine.data_sources.dev_fundamentals_probe --years 2024 2023
    python -m cne6_engine.data_sources.dev_fundamentals_probe --years 2024 \\
        --only-symbols "600519 601398"

Output: data/reference/fundamentals_debug.parquet, dividends_debug.parquet.

Column mapping is fuzzy (contains-match on 东财科目名) and version-sensitive;
run --probe first to print the raw columns of every endpoint.
"""
from __future__ import annotations

import argparse
import datetime
import os
import sys
from typing import Callable

import numpy as np
import polars as pl

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
from cne6_engine.interfaces.contracts import FUNDAMENTAL_SCHEMA

OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "..", "data", "reference",
)

_FIELDS = {
    "income": {
        "revenue": ("营业总收入", "营业收入"),
        "net_income": ("归母净利润", "净利润"),
        "eps": ("基本每股收益",),
        "cogs": ("营业成本", "营业总支出-营业支出"),
        "profit_total": ("利润总额",),
        "fin_expense": ("财务费用",),
    },
    "balance": {
        "total_assets": ("资产-总资产", "资产总计", "总资产"),
        "total_liabilities": ("负债-总负债", "负债合计", "总负债"),
        "equity": ("股东权益合计", "所有者权益合计"),
        "parent_equity": ("归属于母公司股东权益合计", "归母股东权益"),
        "preferred_equity": ("优先股",),
        "long_term_debt": ("长期借款",),
        "short_term_debt": ("短期借款",),
        "cash": ("货币资金",),
        "total_shares": ("股本",),
        "non_current_liabilities": ("非流动负债合计", "负债-非流动负债合计"),
    },
    "cashflow": {
        "operating_cashflow": ("经营性现金流-现金流量净额", "经营活动产生的现金流量净额"),
        "investment_cashflow": ("投资性现金流-现金流量净额", "投资活动产生的现金流量净额"),
        "capex": ("购建固定资产",),
        "dep": ("固定资产折旧",),
        "amort": ("无形资产摊销",),
    },
}


def _prefixed(code: str) -> str:
    if code.startswith(("4", "8", "9")):
        return f"bj.{code}"
    return f"sh.{code}" if code.startswith(("6", "5")) else f"sz.{code}"


def _find(cols: list[str], *names: str) -> str | None:
    for name in names:
        for col in cols:
            if name in col:
                return col
    return None


def _number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def probe() -> None:
    import akshare as ak

    for name, call in [
        ("lrb", lambda: ak.stock_lrb_em(date="20241231")),
        ("zcfz", lambda: ak.stock_zcfz_em(date="20241231")),
        ("xjll", lambda: ak.stock_xjll_em(date="20241231")),
        ("fhps", lambda: ak.stock_fhps_em(date="20241231")),
    ]:
        df = call()
        print(f"\n=== {name} ({df.shape[0]} x {df.shape[1]}) ===")
        print(df.columns.tolist())


def _rows_from(
    raw, year: int, fields: dict[str, tuple[str, ...]],
) -> pl.DataFrame:
    """Normalize one full-market annual statement into (code, report_date,
    available_date, **fields) rows.  `raw` is the pandas AKShare response."""
    df = pl.DataFrame(raw)
    cols = df.columns
    code_col = _find(cols, "股票代码")
    if code_col is None:
        return pl.DataFrame()
    announce_col = _find(cols, "公告日期")
    hits = {
        out_name: _find(cols, *names) for out_name, names in fields.items()
    }

    rows = []
    for item in df.iter_rows(named=True):
        code_raw = str(item.get(code_col, "")).split(".")[-1].zfill(6)
        if not code_raw.isdigit():
            continue
        announced = str(item.get(announce_col, ""))[:10]
        try:
            datetime.datetime.strptime(announced, "%Y-%m-%d")
            available = announced
        except ValueError:
            available = f"{year + 1}-05-01"
        row: dict = {"code": _prefixed(code_raw),
                     "report_date": f"{year}-12-31",
                     "available_date": available}
        for out_name, hit in hits.items():
            v = item.get(hit) if hit is not None else None
            row[out_name] = _number(v)
        rows.append(row)

    if not rows:
        return pl.DataFrame(
            schema={"code": pl.Utf8, "report_date": pl.Utf8,
                    "available_date": pl.Utf8})
    out = pl.DataFrame(rows, orient="row")
    for name in hits:
        out = out.with_columns(pl.col(name).cast(pl.Float64))
    return out


def _combine(*frames: pl.DataFrame) -> pl.DataFrame:
    """Concat + group by (code, report_date) with max announcement date."""
    frames = [f for f in frames if f.height]
    if not frames:
        return pl.DataFrame(
            schema={"code": pl.Utf8, "report_date": pl.Utf8,
                    "available_date": pl.Utf8})
    value_cols = sorted({
        c for f in frames for c in f.columns
        if c not in ("code", "report_date", "available_date")
    })
    frame = pl.concat(frames, how="diagonal_relaxed")
    return (
        frame.group_by(["code", "report_date"])
        .agg(
            pl.col("available_date").max(),
            *[pl.col(c).drop_nulls().last().alias(c) for c in value_cols],
        )
        .sort(["code", "report_date"])
    )


def fetch_year(
    year: int, symbols: set[str] | None, *,
    before_request: Callable[[], None] | None = None,
    strict_dividends: bool = False,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Annual statements + dividends merged into contract frames."""
    import akshare as ak

    def call(func):
        if before_request is not None:
            before_request()
        return func()

    income = _rows_from(
        call(lambda: ak.stock_lrb_em(date=f"{year}1231")),
        year, _FIELDS["income"])
    balance = _rows_from(
        call(lambda: ak.stock_zcfz_em(date=f"{year}1231")),
        year, _FIELDS["balance"])
    cashflow = _rows_from(
        call(lambda: ak.stock_xjll_em(date=f"{year}1231")),
        year, _FIELDS["cashflow"])

    merged = _combine(income, balance, cashflow)
    if merged.height:
        merged = merged.with_columns(
            (pl.col("profit_total") + pl.col("fin_expense")).alias("ebit"),
            pl.when(pl.col("dep").is_not_null() | pl.col("amort").is_not_null())
            .then(pl.sum_horizontal("dep", "amort", ignore_nulls=True))
            .otherwise(None).alias("depreciation_amortization"),
        )
    for name in FUNDAMENTAL_SCHEMA:
        if name not in merged.columns:
            merged = merged.with_columns(
                pl.lit(None).cast(FUNDAMENTAL_SCHEMA[name]).alias(name))
        else:
            merged = merged.with_columns(
                pl.col(name).cast(FUNDAMENTAL_SCHEMA[name]))
    merged = merged.select(list(FUNDAMENTAL_SCHEMA))

    prefixed = {_prefixed(s) for s in symbols} if symbols else None
    if prefixed:
        merged = merged.filter(pl.col("code").is_in(prefixed))

    # --- dividends (ak.stock_fhps_em, per report period) ---
    schema = {"code": pl.Utf8, "report_date": pl.Utf8,
              "dividend_per_share": pl.Float64, "pay_date": pl.Utf8}
    try:
        fhps = pl.DataFrame(call(lambda: ak.stock_fhps_em(date=f"{year}1231")))
        div_col = _find(fhps.columns, "现金分红")
        pay_col = _find(fhps.columns, "除权除息")
        code_col = _find(fhps.columns, "股票代码", "代码")
        rows = []
        if div_col and code_col:
            for item in fhps.iter_rows(named=True):
                code_raw = str(item.get(code_col, "")).split(".")[-1].zfill(6)
                if not code_raw.isdigit():
                    continue
                v = _number(item.get(div_col))
                if v is None:
                    continue
                if prefixed and _prefixed(code_raw) not in prefixed:
                    continue
                rows.append({
                    "code": _prefixed(code_raw),
                    "report_date": str(item.get("报告期", f"{year}-12-31"))[:10],
                    "dividend_per_share": v / 10.0,
                    "pay_date": (str(item.get(pay_col, ""))[:10]
                                 if pay_col else ""),
                })
        dividends = pl.DataFrame(rows, schema=schema, orient="row")
    except Exception as exc:
        if strict_dividends:
            raise
        print(f"dividends {year}: {type(exc).__name__} {exc}")
        dividends = pl.DataFrame(schema=schema)
    return merged, dividends


def _print_coverage(frame: pl.DataFrame) -> None:
    print("field coverage (non-null share, latest annual row):")
    print(frame.select(
        [pl.col(c).is_not_null().mean().round(3).alias(c)
         for c in FUNDAMENTAL_SCHEMA
         if c not in ("code", "report_date", "available_date")]
    ).to_dict(as_series=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true",
                        help="print raw AKShare columns, no fetching")
    parser.add_argument("--years", nargs="+", type=int, default=[2024])
    parser.add_argument("--only-symbols", default=None,
                        help="space-separated bare codes: '600519 601398'")
    args = parser.parse_args()

    if args.probe:
        probe()
        return
    symbols = set(args.only_symbols.split()) if args.only_symbols else None

    frames, div_frames = [], []
    for year in args.years:
        frame, dividends = fetch_year(year, symbols)
        print(f"{year}: {frame.height} statement rows, "
              f"{dividends.height} dividend rows")
        _print_coverage(frame)
        frames.append(frame)
        div_frames.append(dividends)

    os.makedirs(OUT_DIR, exist_ok=True)
    pl.concat(frames, how="vertical_relaxed").write_parquet(
        os.path.join(OUT_DIR, "fundamentals_debug.parquet"))
    pl.concat(div_frames, how="vertical_relaxed").write_parquet(
        os.path.join(OUT_DIR, "dividends_debug.parquet"))
    print(f"written: {os.path.join(OUT_DIR, 'fundamentals_debug.parquet')}")


if __name__ == "__main__":
    main()
