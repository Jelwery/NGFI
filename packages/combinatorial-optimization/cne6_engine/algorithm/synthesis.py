# cne6_engine/algorithm/synthesis.py
"""CNE6 two-stage factor synthesis.

Pipeline (per 调研报告):
  descriptors → MAD winsorize → industry cap-weighted median fill →
  sqrt-cap-weighted Z-score → stage 1: equal-weight → level-2 factors →
  orthogonalize (industry + size, except Size group) →
  stage 2: equal-weight → level-1 style factors → re-standardize.

Missing descriptors drop out of their group's average; a group with zero
available descriptors is skipped entirely — never zero-filled.
"""
from __future__ import annotations

import numpy as np
import polars as pl

from cne6_engine.algorithm.registry import (
    DESCRIPTORS,
    descriptors_in_level2,
    level1_names,
    level2_names,
)

MAD_SCALE = 3.0


def _nan_median(x: np.ndarray) -> float:
    finite = x[np.isfinite(x)]
    return float(np.median(finite)) if len(finite) else np.nan


def mad_winsorize(x: np.ndarray, scale: float = MAD_SCALE) -> np.ndarray:
    """Clip to median ± scale * MAD, NaN-aware."""
    med = _nan_median(x)
    if not np.isfinite(med):
        return x.copy()
    finite = x[np.isfinite(x)]
    mad = float(np.median(np.abs(finite - med)))
    if mad <= 0:
        return x.copy()
    return np.clip(x, med - scale * mad, med + scale * mad)


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    """Median of finite values with weights (sqrt-cap weights, per 调研报告)."""
    ok = np.isfinite(values) & np.isfinite(weights) & (weights > 0)
    if not ok.any():
        return np.nan
    v = values[ok]
    w = weights[ok]
    order = np.argsort(v, kind="stable")
    v_s = v[order]
    w_s = w[order]
    half = w_s.sum() / 2.0
    idx = int(np.searchsorted(np.cumsum(w_s), half))
    return float(v_s[min(idx, len(v_s) - 1)])


def fill_industry_median(
    x: np.ndarray, industry_idx: np.ndarray, n_industries: int,
    weights: np.ndarray | None = None,
) -> tuple[np.ndarray, float]:
    """Fill NaN with cap-weighted industry median, then market median.

    Returns (filled, fill_rate).  Weights are sqrt caps; industries whose
    weighted median is undefined fall back to the market median.
    """
    out = x.copy()
    missing = ~np.isfinite(out)
    if not missing.any():
        return out, 0.0

    market_med = (
        _weighted_median(out, weights)
        if weights is not None else _nan_median(out)
    )
    for g in range(n_industries):
        mask = (industry_idx == g) & missing
        if not mask.any():
            continue
        out[mask] = market_med
    for g in range(n_industries):
        members = (industry_idx == g) & np.isfinite(x)
        if not members.any():
            continue
        g_med = (
            _weighted_median(x[members], weights[members])
            if weights is not None else _nan_median(x[members])
        )
        if np.isfinite(g_med):
            mask = (industry_idx == g) & missing
            out[mask] = g_med
    return out, float(missing.mean())


def weighted_zscore(
    x: np.ndarray, weights: np.ndarray,
) -> tuple[np.ndarray, float, float]:
    """Sqrt-cap-weighted Z-score.  Returns (z, w_mean, w_std)."""
    valid = np.isfinite(x) & np.isfinite(weights) & (weights > 0)
    z = np.full_like(x, np.nan)
    if valid.sum() < 3:
        return z, np.nan, np.nan
    w = weights[valid]
    v = x[valid]
    w_sum = w.sum()
    mean = float(w @ v / w_sum)
    var = float(w @ (v - mean) ** 2 / w_sum)
    std = np.sqrt(var)
    if std <= 1e-12:
        return z, mean, 0.0
    z[valid] = (v - mean) / std
    return z, mean, std


def _orthogonalize(
    x: np.ndarray, controls: np.ndarray,
) -> np.ndarray:
    """Residual of x on controls (lstsq, NaN rows dropped)."""
    valid = np.isfinite(x) & np.all(np.isfinite(controls), axis=1)
    out = x.copy()
    if valid.sum() < controls.shape[1] + 2:
        return out
    X = np.column_stack([np.ones(valid.sum()), controls[valid]])
    coef, *_ = np.linalg.lstsq(X, x[valid], rcond=None)
    out[valid] = x[valid] - X @ coef
    return out


def _industry_dummies(industry_idx: np.ndarray, n_industries: int) -> np.ndarray:
    return (industry_idx[:, np.newaxis] == np.arange(n_industries)).astype(float)


def synthesize_styles(
    descriptor_frame: pl.DataFrame,
    industry_map: dict[str, str],
    caps: np.ndarray,
) -> tuple[np.ndarray, list[str], dict]:
    """Two-stage synthesis: descriptor frame → level-1 style exposures.

    Parameters
    ----------
    descriptor_frame : pl.DataFrame
        Output of compute_descriptors: `code` + descriptor columns.
    industry_map : dict[str, str]
        code → industry label.
    caps : np.ndarray
        Float market caps aligned to descriptor_frame row order.

    Returns
    -------
    (S, style_names, meta) : styles (N, K), names, diagnostics.
    """
    codes = descriptor_frame["code"].to_list()
    n = len(codes)
    descriptor_names = [
        c for c in descriptor_frame.columns if c != "code"
    ]
    if not descriptor_names:
        raise ValueError("descriptor frame has no descriptor columns")

    labels = sorted({industry_map.get(c, "未知") for c in codes})
    label_idx = {lab: i for i, lab in enumerate(labels)}
    industry_idx = np.array(
        [label_idx.get(industry_map.get(c, "未知"), -1) for c in codes]
    )
    n_ind = len(labels)
    dummies = _industry_dummies(industry_idx, n_ind)

    valid_caps = caps[np.isfinite(caps) & (caps > 0)]
    fallback_cap = float(np.median(valid_caps)) if len(valid_caps) else 1.0
    safe_caps = np.where(np.isfinite(caps) & (caps > 0), caps, fallback_cap)
    weights = np.sqrt(safe_caps)

    meta: dict = {
        "industries": labels,
        "fill_rates": {},
        "level2_active": [],
        "level1_active": [],
    }

    # --- Step 1-3: winsorize, fill, standardize each descriptor -----------
    standardized: dict[str, np.ndarray] = {}
    for name in descriptor_names:
        raw = descriptor_frame[name].to_numpy().astype(float)
        clipped = mad_winsorize(raw)
        filled, fill_rate = fill_industry_median(
            clipped, industry_idx, n_ind, weights,
        )
        meta["fill_rates"][name] = fill_rate
        z, _, _ = weighted_zscore(filled, weights)
        standardized[name] = z

    # --- Stage 1: descriptors → level-2 ------------------------------------
    lncap_raw = standardized.get("LNCAP")
    level2_values: dict[str, np.ndarray] = {}
    for l2 in level2_names():
        members = [
            d for d in descriptors_in_level2(l2)
            if d in standardized and np.isfinite(standardized[d]).sum() >= 3
        ]
        if not members:
            continue
        stacked = np.vstack([standardized[d] for d in members])
        level2_values[l2] = np.nanmean(stacked, axis=0)

    # --- Orthogonalization: industry + size, except the Size group --------
    for l2, values in level2_values.items():
        if l2 == "Size":
            continue
        if l2 == "NonLinearSize":
            # Already size-neutral by construction; industry-neutralize only.
            level2_values[l2] = _orthogonalize(values, dummies)
            continue
        controls = dummies if lncap_raw is None else np.column_stack(
            [dummies, lncap_raw]
        )
        level2_values[l2] = _orthogonalize(values, controls)

    meta["level2_active"] = list(level2_values)

    # --- Stage 2: level-2 → level-1 ----------------------------------------
    style_names: list[str] = []
    columns: list[np.ndarray] = []
    for l1 in level1_names():
        members = [l2 for l2 in level2_names(l1) if l2 in level2_values]
        if not members:
            continue
        stacked = np.vstack([level2_values[l2] for l2 in members])
        raw = np.nanmean(stacked, axis=0)
        z, _, _ = weighted_zscore(raw, weights)
        if np.isfinite(z).sum() < 3:
            continue
        style_names.append(l1)
        columns.append(z)
        meta["level1_active"].append(
            {"name": l1, "level2": members}
        )

    if not columns:
        raise ValueError("no style factors could be synthesized")

    S = np.column_stack(columns)
    meta["valid_mask"] = np.isfinite(S).all(axis=1)
    return S, style_names, meta
