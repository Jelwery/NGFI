# cne6_engine/algorithm/ewma.py
"""Exponentially-weighted moving average and Newey-West covariance estimation."""
import numpy as np
from numba import njit


def compute_decay_factor(half_life: int) -> float:
    """Compute EWMA decay factor from half-life: lambda = 0.5^(1/half_life)."""
    if half_life <= 0:
        raise ValueError(f"half_life must be positive, got {half_life}")
    return 0.5 ** (1.0 / half_life)


def ewma_volatility(
    returns: np.ndarray,
    half_life: int,
    seed_window: int | None = None,
) -> np.ndarray:
    """Compute EWMA volatility for a 1-d return series.

    sigma^2_t = lambda * sigma^2_{t-1} + (1-lambda) * r^2_t

    Args:
        returns: (T,) array of daily returns.
        half_life: EWMA half-life in days.
        seed_window: Number of initial observations used to seed the variance.

    Returns:
        (T,) array of daily volatility estimates.
    """
    lam = compute_decay_factor(half_life)
    arr = np.asarray(returns, dtype=np.float64)
    return _ewma_vol_numba(arr, lam, seed_window or 0)


@njit(cache=True)
def _ewma_vol_numba(returns: np.ndarray, lam: float, seed_window: int) -> np.ndarray:
    T = len(returns)
    var = np.empty(T, dtype=np.float64)

    if seed_window > 0 and seed_window < T:
        count = 0
        mean = 0.0
        for t in range(seed_window):
            if np.isfinite(returns[t]):
                mean += returns[t]
                count += 1
        mean = mean / count if count > 0 else 0.0
        initial_var = 0.0
        if count > 0:
            for t in range(seed_window):
                if np.isfinite(returns[t]):
                    initial_var += (returns[t] - mean) ** 2
            initial_var /= count
        var[seed_window - 1] = initial_var
        for t in range(seed_window, T):
            if np.isfinite(returns[t]):
                var[t] = lam * var[t - 1] + (1.0 - lam) * returns[t] ** 2
            else:
                var[t] = var[t - 1]
        for t in range(seed_window - 1):
            var[t] = var[seed_window - 1]
    else:
        var[0] = returns[0] ** 2 if np.isfinite(returns[0]) else 0.0
        for t in range(1, T):
            if np.isfinite(returns[t]):
                var[t] = lam * var[t - 1] + (1.0 - lam) * returns[t] ** 2
            else:
                var[t] = var[t - 1]

    for t in range(T):
        if var[t] < 0.0:
            var[t] = 0.0
    return np.sqrt(var)


def nw_adjusted_covariance(
    factor_returns: np.ndarray,
    half_life: int,
    nw_lags: int,
) -> np.ndarray:
    """Compute Newey-West adjusted covariance matrix with EWMA weights.

    C(tau, L) = C_0 + sum_{k=1}^{L} w_k * (C_k + C_k^T)
    where w_k = (L+1-k)/(L+1) are Bartlett weights.

    Args:
        factor_returns: (T, K) array of factor returns over time.
        half_life: EWMA half-life for decay weights.
        nw_lags: Number of Newey-West lags.

    Returns:
        (K, K) covariance matrix, guaranteed symmetric.
    """
    if nw_lags < 0:
        raise ValueError(f"nw_lags must be >= 0, got {nw_lags}")
    T, K = factor_returns.shape
    if T == 0:
        raise ValueError("factor_returns must have at least 1 row")
    delta = compute_decay_factor(half_life)
    arr = np.asarray(factor_returns, dtype=np.float64)
    return _nw_cov_numba(arr, delta, nw_lags)


@njit(cache=True, nogil=True)
def _nw_cov_numba(factor_returns: np.ndarray, delta: float, nw_lags: int) -> np.ndarray:
    T, K = factor_returns.shape

    # Pre-compute EWMA weights (most recent = largest)
    weights = np.empty(T, dtype=np.float64)
    for t in range(T):
        weights[t] = delta ** (T - 1 - t)

    # EWMA de-mean
    demeaned = np.empty((T, K), dtype=np.float64)
    for k in range(K):
        mean_k = 0.0
        w_total = 0.0
        for t in range(T):
            value = factor_returns[t, k]
            if np.isfinite(value):
                mean_k += weights[t] * value
                w_total += weights[t]
        mean_k = mean_k / w_total if w_total > 0.0 else 0.0
        for t in range(T):
            value = factor_returns[t, k]
            demeaned[t, k] = value - mean_k if np.isfinite(value) else np.nan

    # Lag-0 covariance
    cov = np.zeros((K, K), dtype=np.float64)
    for i in range(K):
        for j in range(K):
            total = 0.0
            pair_weight = 0.0
            for t in range(T):
                di = demeaned[t, i]
                dj = demeaned[t, j]
                if np.isfinite(di) and np.isfinite(dj):
                    total += weights[t] * di * dj
                    pair_weight += weights[t]
            if pair_weight > 0.0:
                cov[i, j] = total / pair_weight

    # Lagged terms with Bartlett weights
    if nw_lags > 0:
        for lag in range(1, nw_lags + 1):
            n_obs = T - lag
            if n_obs <= 0:
                continue
            w_bartlett = (nw_lags + 1 - lag) / (nw_lags + 1)

            lag_cov = np.zeros((K, K), dtype=np.float64)
            for i in range(K):
                for j in range(K):
                    total = 0.0
                    pair_weight = 0.0
                    for t in range(n_obs):
                        di = demeaned[t, i]
                        dj = demeaned[t + lag, j]
                        if np.isfinite(di) and np.isfinite(dj):
                            weight = delta ** (n_obs - 1 - t)
                            total += weight * di * dj
                            pair_weight += weight
                    if pair_weight > 0.0:
                        lag_cov[i, j] = total / pair_weight
            for i in range(K):
                for j in range(K):
                    cov[i, j] += w_bartlett * (lag_cov[i, j] + lag_cov[j, i])

    # Ensure symmetry
    for i in range(K):
        for j in range(i + 1, K):
            avg = (cov[i, j] + cov[j, i]) / 2.0
            cov[i, j] = avg
            cov[j, i] = avg
    return cov
