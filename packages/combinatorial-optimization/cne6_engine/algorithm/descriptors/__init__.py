# cne6_engine/algorithm/descriptors/__init__.py
"""Descriptor computation entry point: DataBundle + date → descriptor frame."""
from __future__ import annotations

from datetime import datetime, timedelta

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
    DESCRIPTOR_PROXY_REASONS,
)
from cne6_engine.interfaces.contracts import QualityRecord

MIN_COVERAGE = 0.5


def _coverage(values: np.ndarray) -> float:
    return float(np.isfinite(values).sum() / values.size) if values.size else 0.0


def _required_ok(spec_required: tuple[str, ...], coverage: dict[str, float]) -> bool:
    return all(
        coverage.get(field, 0.0) >= MIN_COVERAGE for field in spec_required
    )


def _prev_month_end_index(dates: list[str], date: str) -> int | None:
    """Last observed trading day in the immediately previous calendar month."""
    previous = datetime.fromisoformat(date).replace(day=1) - timedelta(days=1)
    month = previous.strftime("%Y-%m")
    indices = [i for i, ds in enumerate(dates) if ds[:7] == month]
    return indices[-1] if indices else None


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
    original_codes = sorted(set(bundle.provenance.get("universe", {}).get("codes", codes)) | set(codes))
    denominator = len(original_codes)
    code_index = {code: i for i, code in enumerate(codes)}

    coverage: dict[str, float] = {
        "daily_return": _coverage(panel.returns),
        "close": _coverage(panel.close),
        "turnover_rate": _coverage(panel.turnover[:, -252:]),
        "float_market_cap": _coverage(panel.float_cap),
        "total_market_cap": _coverage(panel.total_cap),
        "benchmark_return": _coverage(panel.benchmark),
    }
    coverage["industry"] = sum(ind != "未知" for ind in panel.industry) / len(codes) if codes else 0.0

    me_idx = _prev_month_end_index(panel.dates, date)
    fund_values = compute_fundamental_descriptors(
        bundle.fundamentals, date, codes,
        panel.total_cap[:, -1],
        panel.close[:, me_idx] if me_idx is not None else np.full(len(codes), np.nan),
        total_cap_prev=(panel.total_cap[:, -2] if panel.t >= 2 else None),
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
        "original_universe": {"codes": original_codes, "count": denominator},
        "descriptor_quality": {},
        "source_quality": bundle.quality.to_dict(),
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
        except (ValueError, np.linalg.LinAlgError) as exc:
            meta["excluded"][name] = f"compute error: {exc}"
            continue

    if bundle.analyst is not None:
        try:
            values.update(compute_analyst_descriptors(
                bundle.analyst, date, codes,
            ))
        except (ValueError, np.linalg.LinAlgError) as exc:
            for name in ("RRIBS", "EPIBSC", "EARNC"):
                meta["excluded"][name] = f"compute error: {exc}"

    for name, spec in DESCRIPTORS.items():
        raw = np.asarray(values.get(name, np.full(len(codes), np.nan)), dtype=float)
        mask = np.isfinite(raw)
        numerator = int(mask.sum())
        rate = numerator / denominator if denominator else 0.0
        ancestors = list(spec.required)
        if any(field in _FUNDAMENTAL_FIELDS for field in spec.required):
            ancestors.append("available_date")
        records = {
            field: bundle.quality.field_records.get(field, QualityRecord(
                quality_flag="good" if bundle.quality.provider_verified and bundle.quality.quality_flag == "good" else "unverified",
                reasons=() if bundle.quality.provider_verified else ("provider_not_verified",),
                point_in_time=bundle.quality.point_in_time,
            )).to_dict()
            for field in ancestors
        }
        reasons = list(DESCRIPTOR_PROXY_REASONS.get(name, ()))
        reasons.extend(f"{field}:{reason}" for field, record in records.items() for reason in record["reasons"])
        if name == "MLEV" and panel.t < 2:
            reasons.append("previous_trading_day_cap_unavailable")
        if name == "DTOP" and me_idx is None:
            reasons.append("previous_calendar_month_close_unavailable")
        sparse_fields = [field for field in spec.required if coverage.get(field, 1.0) < 1.0]
        if sparse_fields:
            reasons.extend(f"sparse_input_window:{field}" for field in sparse_fields)
        flags = {record["quality_flag"] for record in records.values()}
        flag = ("missing" if numerator == 0 else
                "proxy" if sparse_fields or name in DESCRIPTOR_PROXY_REASONS or "proxy" in flags else
                "imputed" if "imputed" in flags else
                "unverified" if not bundle.quality.provider_verified or flags & {"unverified", "missing"} else "good")
        aligned_raw = [float(raw[code_index[c]]) if c in code_index and mask[code_index[c]] else None for c in original_codes]
        meta["descriptor_quality"][name] = {
            "quality_flag": flag, "coverage": rate, "numerator": numerator,
            "denominator": denominator, "raw_values": aligned_raw,
            "valid_mask": [v is not None for v in aligned_raw],
            "quality_mask": [flag if v is not None else "missing" for v in aligned_raw],
            "reasons": sorted(set(reasons)), "ancestor_fields": records,
            "point_in_time": (True if bundle.quality.point_in_time is True and all(r["point_in_time"] is True for r in records.values()) else False),
        }
        if name not in meta["excluded"] and name in values and rate >= MIN_COVERAGE:
            meta["included"].append(name)
        elif name not in meta["excluded"]:
            meta["excluded"][name] = "insufficient output coverage" if name in values else "no data source field"

    frame = pl.DataFrame(
        {"code": codes}
        | {
            name: pl.Series(name, values[name], dtype=pl.Float64)
            for name in meta["included"]
        }
    )
    return frame, meta


__all__ = ["compute_descriptors", "MarketPanel", "PRICE_DESCRIPTORS"]
