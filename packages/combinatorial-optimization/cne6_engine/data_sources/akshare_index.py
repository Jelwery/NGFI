# cne6_engine/data_sources/akshare_index.py
"""Layer 1: benchmark index daily bars via AKShare (Sina source).

Fetches raw index OHLCV; layer-2 adapters turn this into a BenchmarkSeries.
"""
from __future__ import annotations

from datetime import datetime

import polars as pl

_SCHEMA = {
    "date": pl.Utf8, "close": pl.Float64, "daily_return": pl.Float64,
}


def fetch_index_daily(symbol: str, start_date: str) -> pl.DataFrame:
    """Fetch the full daily history for one Sina index symbol (e.g. 'sh000300').

    Returns a frame with columns date (YYYY-MM-DD), close, daily_return.
    The first bar is dropped (its return needs the prior close).
    """
    import akshare as ak

    raw = ak.stock_zh_index_daily(symbol=symbol)
    if raw is None or raw.empty:
        return pl.DataFrame(schema=_SCHEMA)
    return (
        pl.from_pandas(raw)
        .select(
            pl.col("date").cast(pl.Utf8).alias("date"),
            pl.col("close").cast(pl.Float64).alias("close"),
        )
        .sort("date")
        .with_columns(
            (pl.col("close") / pl.col("close").shift(1) - 1.0)
            .alias("daily_return")
        )
        .drop_nulls("daily_return")
        .filter(pl.col("date") >= start_date)
    )


def load_benchmark_cached(
    cache_path: str,
    symbol: str,
    start_date: str,
    end_date: str,
) -> pl.DataFrame:
    """Read the index cache if it covers end_date (or was built today); else fetch.

    The "built today" rule handles end dates on non-trading days: a cache
    written today already contains the newest available bar.
    """
    import os

    if os.path.exists(cache_path):
        cached = pl.read_parquet(cache_path)
        built_today = (
            datetime.fromtimestamp(os.path.getmtime(cache_path)).date()
            == datetime.now().date()
        )
        if built_today or (len(cached) and cached["date"].max() >= end_date):
            return cached

    fresh = fetch_index_daily(symbol, start_date)
    if fresh.is_empty():
        if os.path.exists(cache_path):
            return pl.read_parquet(cache_path)
        raise RuntimeError(f"benchmark fetch returned no data for {symbol}")

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    fresh.write_parquet(cache_path, compression="zstd")
    return fresh
