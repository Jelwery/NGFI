"""Convex allocation with explicit feasibility, covariance and turnover checks."""

from __future__ import annotations

from datetime import date
from zoneinfo import ZoneInfo

import cvxpy as cp
import numpy as np
from sklearn.covariance import LedoitWolf

from .hashing import stable_hash
from .research_contracts import OptimizerSpec, Security, instant
from .research_factors import ResearchPanel

CNE6_TIMEZONE = ZoneInfo("Asia/Shanghai")


def covariance_at(panel: ResearchPanel, index: int, lookback: int, horizon: int) -> np.ndarray:
    close = panel.fields["close"].iloc[max(0, index - lookback):index + 1]
    returns = close.pct_change(fill_method=None).iloc[1:].to_numpy()
    if returns.shape[0] < 5 or not np.isfinite(returns).all():
        raise ValueError("risk covariance requires at least five complete PIT return rows")
    return LedoitWolf().fit(returns).covariance_ * horizon


def cne6_covariance(snapshot: dict, securities: list[str], decision_at: str, horizon: int) -> np.ndarray:
    """Use the existing CNE6 snapshot contract; never trust declared PSD/reconciliation."""
    if snapshot.get("model") != "CNE6" or snapshot.get("currency") != "CNY" or snapshot.get("covariancePeriod") != "daily":
        raise ValueError("CNE6 snapshot must be daily CNY")
    available_at = snapshot.get("availableAt")
    if not isinstance(available_at, str):
        raise ValueError("CNE6 availableAt must be a timestamp string")
    if instant(available_at) > instant(decision_at):
        raise ValueError("CNE6 snapshot requires a non-future availableAt")
    model_date = snapshot.get("asOf", "9999-12-31")
    from .contracts import require_date
    if not isinstance(model_date, str):
        raise ValueError("CNE6 asOf must be a date string")
    require_date(model_date, "CNE6 asOf")
    parsed_model_date = date.fromisoformat(model_date)
    decision_date = instant(decision_at).astimezone(CNE6_TIMEZONE).date()
    available_date = instant(available_at).astimezone(CNE6_TIMEZONE).date()
    if parsed_model_date > decision_date or parsed_model_date > available_date:
        raise ValueError("CNE6 model date is in the future")
    quality = snapshot.get("quality")
    if quality is not None:
        if not isinstance(quality, dict):
            raise ValueError("CNE6 quality must be an object")
        if (
            quality.get("status") not in {"ok", "warning"}
            or quality.get("symmetric") is not True
            or quality.get("positiveSemidefinite") is not True
        ):
            raise ValueError("CNE6 snapshot has not passed the quality gate")
    rows = snapshot.get("securities", [])
    if not rows or not snapshot.get("factors"):
        raise ValueError("CNE6 requires securities and factors")
    keys = [Security.model_validate(row["instrument"]).key for row in rows]
    if len(set(keys)) != len(keys) or not set(securities) <= set(keys):
        raise ValueError("duplicate or uncovered CNE6 securities")
    exposures = np.asarray([row["exposures"] for row in rows], dtype=float)
    risk = np.asarray([row["specificRisk"] for row in rows], dtype=float)
    factor = np.asarray(snapshot["factorCovariance"], dtype=float)
    _validate_covariance(factor, len(snapshot["factors"]))
    if exposures.shape != (len(rows), len(factor)) or not np.isfinite(exposures).all():
        raise ValueError("invalid CNE6 exposures")
    if not np.isfinite(risk).all() or (risk <= 0).any():
        raise ValueError("invalid CNE6 specific risk")
    stock = exposures @ factor @ exposures.T + np.diag(risk ** 2)
    supplied = np.asarray(snapshot["stockCovariance"], dtype=float)
    _validate_covariance(supplied, len(rows))
    if not np.allclose(stock, supplied, rtol=1e-7, atol=1e-10):
        raise ValueError("CNE6 stock covariance does not reconcile")
    indexes = [keys.index(key) for key in securities]
    return stock[np.ix_(indexes, indexes)] * horizon


def _validate_covariance(matrix: np.ndarray, size: int) -> None:
    if matrix.shape != (size, size) or not np.isfinite(matrix).all():
        raise ValueError("covariance dimensions or values are invalid")
    if not np.allclose(matrix, matrix.T, atol=1e-12, rtol=1e-8):
        raise ValueError("covariance must be symmetric")
    if np.linalg.eigvalsh(matrix).min(initial=0) < -1e-12:
        raise ValueError("covariance must be positive semidefinite")


def optimize_weights(
    securities: list[str], expected: np.ndarray, covariance: np.ndarray, current: np.ndarray,
    eligible: np.ndarray, industries: list[str], spec: OptimizerSpec,
    *, frozen: np.ndarray | None = None,
) -> dict:
    size = len(securities)
    _validate_covariance(covariance, size)
    if not size or len(set(securities)) != size or len(industries) != size:
        raise ValueError("invalid optimizer security/industry alignment")
    for label, vector in (("expected", expected), ("current", current), ("eligible", eligible)):
        if vector.shape != (size,) or not np.isfinite(vector).all():
            raise ValueError(f"invalid {label} vector")
    if (current < 0).any() or current.sum() > 1 + 1e-8:
        raise ValueError("current weights must be long-only with nonnegative cash")
    frozen = np.zeros(size, dtype=bool) if frozen is None else frozen
    if eligible.dtype != bool or frozen.dtype != bool or frozen.shape != (size,):
        raise ValueError("eligibility and frozen masks must be boolean and security-aligned")
    unknown = set(spec.industry_caps) - set(industries)
    if unknown:
        raise ValueError(f"industry caps name absent industries: {sorted(unknown)}")
    weights = cp.Variable(size)
    upper = np.where(eligible | frozen, spec.max_weight, 0.0)
    constraints = [weights >= 0, weights <= upper, cp.sum(weights) <= 1 - spec.cash_reserve,
                   cp.norm1(weights - current) <= spec.max_turnover]
    if frozen.any():
        constraints.append(weights[frozen] == current[frozen])
    for industry, cap in spec.industry_caps.items():
        indexes = [index for index, value in enumerate(industries) if value == industry]
        constraints.append(cp.sum(weights[indexes]) <= cap)
    if spec.method == "top-k":
        selected = sorted(np.flatnonzero(eligible), key=lambda index: (-expected[index], securities[index]))[:spec.top_k]
        unselected = np.ones(size, dtype=bool)
        unselected[selected] = False
        unselected &= ~frozen
        if unselected.any():
            constraints.append(weights[unselected] == 0)
        target = np.zeros(size)
        if selected:
            target[selected] = min(spec.max_weight, (1 - spec.cash_reserve) / len(selected))
        objective = cp.Minimize(cp.sum_squares(weights - target) + spec.turnover_penalty * cp.norm1(weights - current))
    else:
        objective = cp.Maximize(expected @ weights - spec.risk_aversion * cp.quad_form(weights, cp.psd_wrap(covariance))
                                - spec.turnover_penalty * cp.norm1(weights - current))
    problem = cp.Problem(objective, constraints)
    try:
        problem.solve(solver="CLARABEL", max_iter=200, tol_gap_abs=1e-9, tol_feas=1e-9, tol_gap_rel=1e-9)
    except cp.error.SolverError:
        return {"status": "failed", "reason": "solver-error", "weights": None}
    if problem.status != cp.OPTIMAL or weights.value is None:
        return {"status": "failed", "reason": str(problem.status), "weights": None}
    value = np.asarray(weights.value)
    residual = max(float(np.max(np.maximum(-value, 0))), float(np.max(np.maximum(value - upper, 0))),
                   max(0, float(value.sum()) - (1 - spec.cash_reserve)),
                   max(0, float(np.abs(value - current).sum()) - spec.max_turnover))
    for industry, cap in spec.industry_caps.items():
        residual = max(residual, sum(value[i] for i, name in enumerate(industries) if name == industry) - cap)
    if frozen.any():
        residual = max(residual, float(np.max(np.abs(value[frozen] - current[frozen]))))
    if not np.isfinite(value).all() or residual > 1e-7:
        return {"status": "failed", "reason": "constraint-residual", "weights": None}
    value = np.maximum(0, value)
    value[value < 1e-9] = 0.0
    return {
        "status": "complete", "weights": dict(zip(securities, value.tolist())),
        "cashWeight": float(1 - value.sum()), "turnover": float(np.abs(value - current).sum()),
        "expectedReturn": float(expected @ value), "variance": float(value @ covariance @ value),
        "covarianceHash": stable_hash(covariance.tolist()), "maximumViolation": max(0, float(residual)),
        "solver": "CLARABEL", "objective": float(problem.value),
    }
