# cne6_engine/algorithm/descriptors/__init__.py
"""Descriptor computation entry point: DataBundle + date → descriptor frame."""
from __future__ import annotations

from datetime import datetime

import numpy as np
import polars as pl

from cne6_engine.algorithm.descriptors.analyst_descriptors import (
    compute_analyst_descriptors,
)
from cne6_engine.algorithm.descriptors.fundamental_descriptors import (
    compute_fundamental_descriptors,
    fundamental_field_coverage,
)
from cne6_engine.algorithm.descriptors.price_descriptors import (
    PRICE_DESCRIPTORS,
    MarketPanel,
)
from cne6_engine.algorithm.registry import (
    _FUNDAMENTAL_FIELDS,
    DESCRIPTORS,
)

MIN_COVERAGE = 0.5


def _coverage(values: np.ndarray) -> float:
    if len(values) == 0:
        return 0.0
    return float(np.mean(np.isfinite(values)))


def _required_ok(spec_required: tuple[str, ...], coverage: dict[str, float]) -> bool:
    return all(
        coverage.get(field, 0.0) >= MIN_COVERAGE for field in spec_required
    )


def _prev_month_end_index(dates: list[str], date: str) -> int:
    """Index of the last trading day in the calendar month before `date`."""
    d = datetime.fromisoformat(date)
    mark = (d.year, d.month)
    idx = 0
    for i, ds in enumerate(dates):
        if (int(ds[:4]), int(ds[5:7])) < mark:
            idx = i
    return idx


def compute_descriptors(
    bundle, date: str,
) -> tuple[pl.DataFrame, dict]:
    """Compute all available descriptors for one date.

    Returns (frame, meta): frame has one row per stock with a `code` column
    plus one column per activated descriptor; meta records coverage and
    exclusion reasons per descriptor.
    """
    panel = MarketPanel.from_bundle(bundle, date)
    codes = panel.codes

    coverage: dict[str, float] = {
        "daily_return": _coverage(panel.returns),
        "close": _coverage(panel.close),
        "turnover_rate": _coverage(panel.turnover[:, -252:]),
        "float_market_cap": _coverage(panel.float_cap),
        "total_market_cap": _coverage(panel.total_cap),
        "benchmark_return": _coverage(panel.benchmark),
    }
    coverage["industry"] = 1.0 if "未知" not in set(panel.industry) else 0.0

    me_idx = _prev_month_end_index(panel.dates, date)
    fund_values = compute_fundamental_descriptors(
        bundle.fundamentals, date, codes,
        panel.total_cap[:, -1], panel.close[:, me_idx],
        total_cap_prev=(
            panel.total_cap[:, -2]
            if panel.t >= 2 else panel.total_cap[:, -1]
        ),
    )
    coverage.update(fundamental_field_coverage(
        bundle.fundamentals, date, codes, tuple(_FUNDAMENTAL_FIELDS),
    ))

    meta: dict = {
        "date": date,
        "n_stocks": len(codes),
        "n_dates": panel.t,
        "coverage": coverage,
        "included": [],
        "excluded": {},
    }

    values: dict[str, np.ndarray] = {}
    values.update(fund_values)

    for name, func in PRICE_DESCRIPTORS.items():
        spec = DESCRIPTORS[name]
        if not _required_ok(spec.required, coverage):
            meta["excluded"][name] = "insufficient field coverage"
            continue
        try:
            values[name] = func(panel)
        except Exception as exc:  # one bad descriptor must not kill the panel
            meta["excluded"][name] = f"compute error: {exc}"
            continue

    if bundle.analyst is not None:
        try:
            values.update(compute_analyst_descriptors(
                bundle.analyst, date, codes,
            ))
        except Exception as exc:
            for name in ("RRIBS", "EPIBSC", "EARNC"):
                meta["excluded"][name] = f"compute error: {exc}"

    for name in DESCRIPTORS:
        if name in meta["excluded"]:
            continue
        if name in values and _coverage(values[name]) >= MIN_COVERAGE:
            meta["included"].append(name)
        else:
            reason = (
                "insufficient output coverage"
                if name in values else "no data source field"
            )
            meta["excluded"][name] = reason
            values.pop(name, None)

    frame = pl.DataFrame(
        {"code": codes}
        | {
            name: pl.Series(name, values[name], dtype=pl.Float64)
            for name in meta["included"]
        }
    )
    return frame, meta


__all__ = ["compute_descriptors", "MarketPanel", "PRICE_DESCRIPTORS"]
