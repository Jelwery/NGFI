# cne6_engine/algorithm/factor_return.py
"""Daily cross-sectional WLS regression for factor returns.

    r_n = sum_k X_{nk} * f_k + u_n

Ported from CNE5 Module 3; exposures are time-varying (T, N, K) because CNE6
re-synthesizes styles from descriptors every day.
"""
from __future__ import annotations

import numpy as np
from numba import njit
from scipy.linalg import null_space


@njit(cache=True)
def weighted_ls_regression(
    X: np.ndarray, y: np.ndarray, w: np.ndarray,
) -> np.ndarray:
    """Weighted least squares: min ||W^{1/2}(y - X f)||^2."""
    W_sqrt = np.sqrt(w)
    X_w = X * W_sqrt.reshape(-1, 1)
    y_w = y * W_sqrt
    f, _, _, _ = np.linalg.lstsq(X_w, y_w)
    return f


def daily_cross_sectional_regression_time_varying(
    daily_returns: np.ndarray,
    exposures: np.ndarray,
    market_caps: np.ndarray,
    industry_count: int | None = None,
    min_valid: int | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Run WLS using the contemporaneous exposure matrix for every day.

    With ``industry_count`` set, industry factor returns are constrained so
    that their cap-weighted sum is zero — this separates the intercept
    (country) factor from industry factors.
    """
    daily_returns = np.asarray(daily_returns, dtype=np.float64)
    exposures = np.asarray(exposures, dtype=np.float64)
    market_caps = np.asarray(market_caps, dtype=np.float64)
    if exposures.ndim != 3:
        raise ValueError("exposures must have shape (T, N, K)")
    T, N, K = exposures.shape
    if daily_returns.shape != (T, N):
        raise ValueError("daily_returns must have shape (T, N)")
    if market_caps.shape == (N,):
        market_caps = np.broadcast_to(market_caps, (T, N))
    if market_caps.shape != (T, N):
        raise ValueError("market_caps must have shape (N,) or (T, N)")
    required = K + 10 if min_valid is None else min_valid

    factor_returns = np.full((T, K), np.nan, dtype=np.float64)
    specific_returns = np.full((T, N), np.nan, dtype=np.float64)
    for t in range(T):
        X_t = exposures[t]
        y_t = daily_returns[t]
        caps_t = market_caps[t]
        weights = np.maximum(caps_t, 0.0)
        valid = (
            np.isfinite(y_t)
            & np.isfinite(weights)
            & (weights > 0)
            & np.all(np.isfinite(X_t), axis=1)
        )
        if np.sum(valid) < required:
            continue

        basis = None
        if industry_count is not None:
            if industry_count < 1 or industry_count >= K:
                raise ValueError("industry_count is incompatible with exposures")
            valid_caps = caps_t[valid]
            industry_caps = X_t[valid, 1:1 + industry_count].T @ valid_caps
            total_industry_cap = industry_caps.sum()
            if total_industry_cap <= 0:
                continue
            constraint = np.zeros(K, dtype=np.float64)
            constraint[1:1 + industry_count] = industry_caps / total_industry_cap
            basis = null_space(constraint.reshape(1, -1))

        X_valid = X_t[valid]
        if basis is None:
            f_t = weighted_ls_regression(X_valid, y_t[valid], weights[valid])
        else:
            reduced_f = weighted_ls_regression(
                X_valid @ basis, y_t[valid], weights[valid],
            )
            f_t = basis @ reduced_f
        factor_returns[t] = f_t
        specific_returns[t] = y_t - X_t @ f_t
    return factor_returns, specific_returns
