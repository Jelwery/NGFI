"""Read-only CNE6 model snapshot facade for portfolio-risk consumers.

This module does not estimate or alter exposures, factor covariance, or
specific risk.  It validates and projects an existing ``compute_covariance``
result into a deterministic, JSON-safe contract.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

from cne6_engine import __version__
from cne6_engine.algorithm.registry import level1_names

MODEL_NAME = "CNE6"
SNAPSHOT_SCHEMA_VERSION = "1"
DEFAULT_RECONCILIATION_TOLERANCE = 1e-10
DEFAULT_CONDITION_WARNING = 1e8
CNE6_TIMEZONE = ZoneInfo("Asia/Shanghai")


class Cne6PortfolioSnapshotError(ValueError):
    """Raised when a pipeline result cannot be represented safely."""


def _require_matrix(
    value: Any,
    name: str,
    shape: tuple[int, int],
) -> np.ndarray:
    matrix = np.asarray(value, dtype=np.float64)
    if matrix.shape != shape:
        raise Cne6PortfolioSnapshotError(
            f"{name} shape {matrix.shape} does not match {shape}"
        )
    if not np.isfinite(matrix).all():
        raise Cne6PortfolioSnapshotError(f"{name} contains non-finite values")
    return matrix


def _require_vector(value: Any, name: str, length: int) -> np.ndarray:
    vector = np.asarray(value, dtype=np.float64)
    if vector.shape != (length,):
        raise Cne6PortfolioSnapshotError(
            f"{name} shape {vector.shape} does not match ({length},)"
        )
    if not np.isfinite(vector).all():
        raise Cne6PortfolioSnapshotError(f"{name} contains non-finite values")
    return vector


def _instrument_for_code(code: str) -> dict[str, str]:
    parts = code.lower().split(".")
    if len(parts) != 2 or parts[0] not in {"sh", "sz", "bj"}:
        raise Cne6PortfolioSnapshotError(f"unsupported CNE6 security code: {code}")
    symbol = parts[1]
    if len(symbol) != 6 or not symbol.isdigit():
        raise Cne6PortfolioSnapshotError(f"invalid CNE6 security symbol: {code}")
    exchange = {"sh": "SSE", "sz": "SZSE", "bj": "BSE"}[parts[0]]
    return {
        "market": "CN",
        "exchange": exchange,
        "symbol": symbol,
        "assetType": "equity",
    }


def _factor_kind(name: str) -> str:
    if name == "COUNTRY":
        return "country"
    if name in set(level1_names()):
        return "style"
    return "industry"


def _stable_hash(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _quality(
    exposures: np.ndarray,
    factor_cov: np.ndarray,
    specific_risk: np.ndarray,
    stock_cov: np.ndarray,
    *,
    reconciliation_tolerance: float,
    condition_warning: float,
) -> dict[str, Any]:
    factor_asymmetry = float(np.max(np.abs(factor_cov - factor_cov.T)))
    stock_asymmetry = float(np.max(np.abs(stock_cov - stock_cov.T)))
    max_asymmetry = max(factor_asymmetry, stock_asymmetry)
    factor_eigenvalues = np.linalg.eigvalsh((factor_cov + factor_cov.T) / 2.0)
    stock_eigenvalues = np.linalg.eigvalsh((stock_cov + stock_cov.T) / 2.0)
    min_eigenvalue = float(min(factor_eigenvalues.min(), stock_eigenvalues.min()))
    max_eigenvalue = float(max(factor_eigenvalues.max(), stock_eigenvalues.max()))
    positive_semidefinite = min_eigenvalue >= -reconciliation_tolerance
    symmetric = max_asymmetry <= reconciliation_tolerance
    positive_factor_eigenvalues = factor_eigenvalues[factor_eigenvalues > reconciliation_tolerance]
    condition_number = (
        float(factor_eigenvalues.max() / positive_factor_eigenvalues.min())
        if len(positive_factor_eigenvalues) == len(factor_eigenvalues)
        else None
    )
    rebuilt = exposures @ factor_cov @ exposures.T
    rebuilt[np.diag_indices(len(specific_risk))] += specific_risk ** 2
    stock_reconciliation_max_error = float(np.max(np.abs(rebuilt - stock_cov)))
    issues: list[str] = []
    if not symmetric:
        issues.append("factor or stock covariance is not symmetric")
    if not positive_semidefinite:
        issues.append("factor or stock covariance is not positive semidefinite")
    if stock_reconciliation_max_error > reconciliation_tolerance:
        issues.append("stock covariance does not equal X F X' + diag(specific_risk^2)")
    if condition_number is None:
        issues.append("factor covariance is singular at the configured tolerance")
    elif condition_number > condition_warning:
        issues.append("factor covariance condition number exceeds the warning threshold")
    invalid = (
        not symmetric
        or not positive_semidefinite
        or stock_reconciliation_max_error > reconciliation_tolerance
    )
    return {
        "status": "invalid" if invalid else ("warning" if issues else "ok"),
        "symmetric": symmetric,
        "positiveSemidefinite": positive_semidefinite,
        "maxAsymmetry": max_asymmetry,
        "minEigenvalue": min_eigenvalue,
        "maxEigenvalue": max_eigenvalue,
        "conditionNumber": condition_number,
        "stockReconciliationMaxError": stock_reconciliation_max_error,
        "issues": issues,
    }


def build_portfolio_risk_snapshot(
    pipeline_result: dict[str, Any],
    *,
    available_at: str,
    model_version: str | None = None,
    reconciliation_tolerance: float = DEFAULT_RECONCILIATION_TOLERANCE,
    condition_warning: float = DEFAULT_CONDITION_WARNING,
) -> dict[str, Any]:
    """Validate and project one existing CNE6 pipeline result.

    The returned data contains no writable adapter, loader, or algorithm hook.
    Consumers receive only model arrays, lineage, coverage, and quality state.
    """
    if not isinstance(pipeline_result, dict):
        raise Cne6PortfolioSnapshotError("pipeline_result must be a dict")
    try:
        available_instant = datetime.fromisoformat(available_at.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise Cne6PortfolioSnapshotError(
            "available_at must be an ISO-8601 timestamp with timezone"
        ) from error
    if available_instant.tzinfo is None or available_instant.utcoffset() is None:
        raise Cne6PortfolioSnapshotError(
            "available_at must be an ISO-8601 timestamp with timezone"
        )
    if not np.isfinite(reconciliation_tolerance) or reconciliation_tolerance <= 0:
        raise Cne6PortfolioSnapshotError("reconciliation_tolerance must be positive")
    if not np.isfinite(condition_warning) or condition_warning <= 1:
        raise Cne6PortfolioSnapshotError("condition_warning must be greater than one")

    codes = pipeline_result.get("codes")
    factor_names = pipeline_result.get("factor_names")
    meta = pipeline_result.get("meta")
    if not isinstance(codes, list) or not codes or not all(isinstance(code, str) for code in codes):
        raise Cne6PortfolioSnapshotError("codes must be a non-empty string list")
    if len(set(codes)) != len(codes):
        raise Cne6PortfolioSnapshotError("codes must be unique")
    if (
        not isinstance(factor_names, list)
        or not factor_names
        or not all(isinstance(name, str) and name for name in factor_names)
    ):
        raise Cne6PortfolioSnapshotError("factor_names must be a non-empty string list")
    if len(set(factor_names)) != len(factor_names):
        raise Cne6PortfolioSnapshotError("factor_names must be unique")
    if not isinstance(meta, dict) or not isinstance(meta.get("end_date"), str):
        raise Cne6PortfolioSnapshotError("meta.end_date is required")
    try:
        model_date = date.fromisoformat(meta["end_date"])
    except ValueError as error:
        raise Cne6PortfolioSnapshotError("meta.end_date must be an ISO date") from error
    if model_date.isoformat() != meta["end_date"]:
        raise Cne6PortfolioSnapshotError("meta.end_date must be an ISO date")
    if available_instant.astimezone(CNE6_TIMEZONE).date() < model_date:
        raise Cne6PortfolioSnapshotError("available_at cannot precede meta.end_date")

    security_count = len(codes)
    factor_count = len(factor_names)
    exposures = _require_matrix(
        pipeline_result.get("exposures"), "exposures", (security_count, factor_count)
    )
    factor_cov = _require_matrix(
        pipeline_result.get("factor_cov"), "factor_cov", (factor_count, factor_count)
    )
    specific_risk = _require_vector(
        pipeline_result.get("specific_risk"), "specific_risk", security_count
    )
    stock_cov = _require_matrix(
        pipeline_result.get("sigma_stock"), "sigma_stock", (security_count, security_count)
    )
    if np.any(specific_risk <= 0):
        raise Cne6PortfolioSnapshotError("specific_risk must be strictly positive")

    resolved_version = model_version or f"cne6-engine@{__version__}"
    if not isinstance(resolved_version, str) or not resolved_version.strip():
        raise Cne6PortfolioSnapshotError("model_version must be non-empty")
    factors = [
        {"name": name, "kind": _factor_kind(name)}
        for name in factor_names
    ]
    securities = [
        {
            "instrument": _instrument_for_code(code),
            "modelCode": code.lower(),
            "exposures": exposures[index].tolist(),
            "specificRisk": float(specific_risk[index]),
        }
        for index, code in enumerate(codes)
    ]
    quality = _quality(
        exposures,
        factor_cov,
        specific_risk,
        stock_cov,
        reconciliation_tolerance=reconciliation_tolerance,
        condition_warning=condition_warning,
    )
    provenance = meta.get("provenance")
    identity = {
        "model": MODEL_NAME,
        "modelVersion": resolved_version,
        "asOf": meta["end_date"],
        "availableAt": available_at,
        "factors": factors,
        "securities": securities,
        "factorCovariance": factor_cov.tolist(),
        "stockCovariance": stock_cov.tolist(),
        "pipeline": {
            "nDays": meta.get("n_days"),
            "lookbackDays": meta.get("lookback_days"),
            "factorCovarianceParameters": meta.get("factor_cov_kwargs"),
            "specificRiskParameters": meta.get("specific_risk_kwargs"),
            "provenance": provenance,
        },
    }
    return {
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "model": MODEL_NAME,
        "modelVersion": resolved_version,
        "asOf": meta["end_date"],
        "availableAt": available_at,
        "currency": "CNY",
        "covariancePeriod": "daily",
        "factors": factors,
        "securities": securities,
        "factorCovariance": factor_cov.tolist(),
        "stockCovariance": stock_cov.tolist(),
        "coverage": {
            "universeCount": security_count,
            "exposureCount": int(np.isfinite(exposures).all(axis=1).sum()),
            "specificRiskCount": int((np.isfinite(specific_risk) & (specific_risk > 0)).sum()),
        },
        "inputHash": _stable_hash(identity),
        "quality": quality,
    }


__all__ = ["Cne6PortfolioSnapshotError", "build_portfolio_risk_snapshot"]
