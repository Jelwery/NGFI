# cne6_engine/algorithm/descriptors/analyst_descriptors.py
"""Analyst-based CNE6 descriptors (Sentiment) — Layer-3 interface.

Barra's official formulas are unpublished; definitions follow the CNE6 调研报告
§8 (RRIBS=评级变化、EPIBSC=盈利预测变化、EARNC=盈利修正) and are here
implemented as documented approximations over a 90-day window:

- ``analyst_rating_change``     +1 上调 / −1 下调 / 0 维持, 每事件行
- ``analyst_eps_forecast_change`` 一致预期 EPS 水平快照（每股，CNY）
- ``analyst_earnings_revision`` +1 上调修正 / −1 下调修正, 每事件行

These descriptors activate automatically once a Layer-1 source fills the
AnalystData contract; with no data they are excluded at the registry gate.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np
import polars as pl

WINDOW_DAYS = 90


def _window_start(date: str) -> str:
    d = datetime.fromisoformat(date) - timedelta(days=WINDOW_DAYS)
    return d.isoformat()


def _spread(
    window: pl.DataFrame, field: str, codes: list[str],
) -> np.ndarray:
    """(up − down) / (up + down) of event magnitudes per code, NaN-aware."""
    agg = (
        window.filter(pl.col(field).is_not_null())
        .group_by("code")
        .agg(
            pl.col(field).sum().alias("_sum"),
            pl.col(field).abs().sum().alias("_abs"),
        )
    )
    sums = dict(zip(agg["code"].to_list(), agg["_sum"].to_list()))
    abss = dict(zip(agg["code"].to_list(), agg["_abs"].to_list()))
    out = np.full(len(codes), np.nan)
    for i, code in enumerate(codes):
        s = sums.get(code)
        a = abss.get(code, 0.0)
        if a > 0 and s is not None and np.isfinite(s):
            out[i] = s / a
    return out


def compute_analyst_descriptors(
    analyst, date: str, codes: list[str],
) -> dict[str, np.ndarray]:
    """All analyst descriptors for one date. Returns name → (N,) array.

    With no data (None or empty frame) returns ``{}`` so the registry keeps
    these descriptors excluded.
    """
    if analyst is None or analyst.frame.is_empty():
        return {}
    window = analyst.frame.filter(
        (pl.col("date") <= date) & (pl.col("date") > _window_start(date))
    ).filter(pl.col("code").is_in(codes))

    result: dict[str, np.ndarray] = {}
    result["RRIBS"] = _spread(window, "analyst_rating_change", codes)
    result["EARNC"] = _spread(window, "analyst_earnings_revision", codes)

    # EPIBSC: consensus-EPS level change across the window, relative.
    levels = (
        window.filter(pl.col("analyst_eps_forecast_change").is_not_null())
        .sort(["code", "date"])
        .group_by("code")
        .agg(
            pl.col("analyst_eps_forecast_change").first().alias("_first"),
            pl.col("analyst_eps_forecast_change").last().alias("_last"),
        )
    )
    first = dict(zip(levels["code"].to_list(), levels["_first"].to_list()))
    last = dict(zip(levels["code"].to_list(), levels["_last"].to_list()))
    out = np.full(len(codes), np.nan)
    for i, code in enumerate(codes):
        f = first.get(code)
        l = last.get(code)
        if f is not None and l is not None and np.isfinite(f) and f != 0:
            out[i] = (l - f) / abs(f)
    result["EPIBSC"] = out
    return result
