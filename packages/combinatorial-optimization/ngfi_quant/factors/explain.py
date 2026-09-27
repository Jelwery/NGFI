"""Cross-sectional explanations, in factor-value units, using only PIT controls."""
from __future__ import annotations

from typing import Literal

import numpy as np
import pandas as pd
from pydantic import Field

from ..research_contracts import FactorDefinition, ResearchDataset
from .evaluation import Partition, StyleControlPlan
from .graph import build_panel, compute_factors, factor_diagnostics, forward_labels, factor_resource_estimate


class StyleExplanation(StyleControlPlan):
    schema_version: Literal["3"] = "3"
    factors: list[FactorDefinition] = Field(min_length=1, max_length=128)
    factor: str
    partition: Partition


def explain_style(dataset: ResearchDataset, request: StyleExplanation) -> dict:
    factor_resource_estimate(dataset, request.factors)
    if request.factor not in {factor.id for factor in request.factors}:
        raise ValueError("unknown explained factor")
    panel = build_panel(dataset)
    if request.partition.start not in panel.dates or request.partition.end not in panel.dates:
        raise ValueError("explanation bounds must be trading sessions")
    factors = compute_factors(panel, request.factors)
    raw = factors[request.factor]
    residual = pd.DataFrame(np.nan, index=panel.dates, columns=panel.securities)
    days = []
    cap = panel.fields.get("feature:market_cap")
    for day in raw.loc[request.partition.start:request.partition.end].index:
        x = pd.DataFrame({"country": 1.0}, index=panel.securities)
        reason = None
        for control in request.controls:
            if control == "industry":
                sectors = pd.Series({key: panel.bars[day, key].industry for key in panel.securities if panel.eligible.loc[day, key]})
                dummies = pd.get_dummies(sectors, prefix="industry", drop_first=True, dtype=float)
                x = pd.concat([x, dummies], axis=1)
            else:
                frame = cap if control == "log-market-cap" else panel.fields.get(control)
                if frame is None:
                    reason = f"missing-control:{control}"
                    break
                x[control] = np.log(frame.loc[day].where(frame.loc[day] > 0)) if control == "log-market-cap" else frame.loc[day]
        weights = pd.Series(1.0, index=panel.securities)
        if request.weighting == "sqrt-market-cap":
            if cap is None:
                reason = "missing-control:feature:market_cap"
            else:
                weights = np.sqrt(cap.loc[day].where(cap.loc[day] > 0))
        valid = raw.loc[day].notna() & x.notna().all(axis=1) & weights.notna() & panel.eligible.loc[day]
        if reason:
            days.append({"date": day, "status": "blocked", "reason": reason, "samples": 0})
            continue
        matrix, target, w = x.loc[valid].to_numpy(), raw.loc[day, valid].to_numpy(), weights.loc[valid].to_numpy()
        if len(target) <= x.shape[1]:
            days.append({"date": day, "status": "blocked", "reason": "insufficient-degrees-of-freedom", "samples": len(target)})
            continue
        w = w / w.mean()
        weighted = matrix * np.sqrt(w[:, None])
        beta, _, rank, singular = np.linalg.lstsq(weighted, target * np.sqrt(w), rcond=None)
        condition = float(singular[0] / singular[-1]) if singular[-1] > 0 else float("inf")
        record = {"date": day, "samples": len(target), "rank": int(rank), "columns": list(x.columns),
                  "conditionNumber": condition if np.isfinite(condition) else None, "weighting": request.weighting}
        if rank < x.shape[1] or condition > request.maximum_condition:
            days.append({**record, "status": "blocked", "reason": "rank-deficient-or-ill-conditioned"})
            continue
        error = target - matrix @ beta
        total = float(np.sum(w * (target - np.average(target, weights=w)) ** 2))
        rss = float(np.sum(w * error ** 2))
        r2 = 1 - rss / total if total > 1e-20 else None
        # Numerical dust from a perfectly explained factor must not acquire a rank IC.
        if np.max(np.abs(error)) <= 1e-10 * max(1.0, float(np.max(np.abs(target)))):
            error[:] = 0
        residual.loc[day, valid] = error
        days.append({**record, "status": "complete", "coefficients": dict(zip(x.columns, beta.tolist())),
                     "rSquared": r2, "adjustedRSquared": 1 - (1 - r2) * (len(target) - 1) / (len(target) - rank) if r2 is not None else None,
                     "residualCoverage": float(valid.sum() / max(1, panel.eligible.loc[day].sum()))})
    labels, boundaries = forward_labels(panel, request.horizon)
    from ..research_contracts import instant
    cutoff = panel.dataset.calendar[panel.dates.index(request.partition.end)].decision_at
    for day, (end, available) in boundaries.items():
        if end > request.partition.end or instant(available) > instant(cutoff):
            labels.loc[day] = np.nan
    return {"schemaVersion": "3", "kind": "factor-style", "unit": "factor-value", "datasetId": dataset.hash,
            "requestId": request.hash, "status": "complete" if all(day["status"] == "complete" for day in days) else "partial",
            "days": days, "diagnostics": factor_diagnostics(panel, {"raw": raw, "residual": residual}, labels,
                                                          request.partition.start, request.partition.end),
            "residuals": [{"date": day, "values": {key: float(value) if np.isfinite(value) else None for key, value in row.items()}}
                          for day, row in residual.loc[request.partition.start:request.partition.end].iterrows()],
            "interpretation": "unexplained relative to specified controls; not causal attribution or pure alpha",
            "promotionEligible": False}
