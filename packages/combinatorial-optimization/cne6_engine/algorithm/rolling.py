# cne6_engine/algorithm/rolling.py
"""Numpy/Numba rolling primitives for descriptor computation.

All kernels are NaN-aware: suspended days / missing caps simply drop out of
windows instead of poisoning the estimate.  Matrices are (N, T) — stocks on
rows, trade dates on columns, oldest first.
"""
from __future__ import annotations

import numpy as np
from numba import njit


def ewma_weights(window: int, half_life: int) -> np.ndarray:
    """Trailing-window EWMA weights, oldest→newest, normalized to sum 1."""
    if window <= 0:
        raise ValueError(f"window must be positive, got {window}")
    if half_life <= 0:
        raise ValueError(f"half_life must be positive, got {half_life}")
    delta = 0.5 ** (1.0 / half_life)
    w = delta ** np.arange(window - 1, -1, -1)
    return w / w.sum()


@njit(cache=True)
def _wls_at_targets(
    y: np.ndarray, x: np.ndarray, window: int, half_life: int,
    targets: np.ndarray, first_valid: np.ndarray | None = None,
) -> np.ndarray:
    """Rolling EWMA-weighted regression at target column indices.

    Matches the reference implementation (_rolling_regress, fill_na=0):
    NaN returns are zero-filled with full EWMA weight, and stocks whose first
    observation is inside the window are excluded for that target (as if not
    listed at the window start).

    Returns (N, M, 3): beta, alpha, residual std (equal-weight over the
    window's regression rows) for each stock i at each target targets[m].
    """
    N, T = y.shape
    M = len(targets)
    out = np.full((N, M, 3), np.nan)

    delta = 0.5 ** (1.0 / half_life)
    weights = np.empty(window, dtype=np.float64)
    for k in range(window):
        weights[k] = delta ** (window - 1 - k)

    for i in range(N):
        s_i = 0 if first_valid is None else int(first_valid[i])
        for m in range(M):
            t_end = targets[m]
            start = t_end - window + 1
            if start < 0:
                continue
            if s_i > start:
                continue

            w_sum = 0.0
            wy = 0.0
            wx = 0.0
            n = 0
            for k in range(window):
                xv = x[start + k]
                if np.isnan(xv):
                    continue
                yv = y[i, start + k]
                if np.isnan(yv):
                    yv = 0.0
                w = weights[k]
                w_sum += w
                wy += w * yv
                wx += w * xv
                n += 1

            if w_sum <= 0.0 or n < 2:
                continue
            wy /= w_sum
            wx /= w_sum

            cov = 0.0
            var = 0.0
            for k in range(window):
                xv = x[start + k]
                if np.isnan(xv):
                    continue
                yv = y[i, start + k]
                if np.isnan(yv):
                    yv = 0.0
                w = weights[k]
                dy = yv - wy
                dx = xv - wx
                cov += w * dy * dx
                var += w * dx * dx

            if var <= 1e-12:
                continue
            beta = cov / var
            alpha = wy - beta * wx

            sse = 0.0
            for k in range(window):
                xv = x[start + k]
                if np.isnan(xv):
                    continue
                yv = y[i, start + k]
                if np.isnan(yv):
                    yv = 0.0
                resid = yv - (alpha + beta * xv)
                sse += resid * resid

            sigma = np.sqrt(sse / n) if n > 1 else np.nan
            out[i, m, 0] = beta
            out[i, m, 1] = alpha
            out[i, m, 2] = sigma
    return out


@njit(cache=True)
def _ewma_sum_at(
    series: np.ndarray, window: int, half_life: int, targets: np.ndarray,
) -> np.ndarray:
    """Normalized EWMA weighted sum over trailing windows at target indices.

    Returns (N, M).  NaN entries drop out and weights renormalize.
    """
    N, T = series.shape
    M = len(targets)
    out = np.full((N, M), np.nan)

    delta = 0.5 ** (1.0 / half_life)
    weights = np.empty(window, dtype=np.float64)
    for k in range(window):
        weights[k] = delta ** (window - 1 - k)

    for i in range(N):
        for m in range(M):
            t_end = targets[m]
            start = t_end - window + 1
            if start < 0:
                continue
            total = 0.0
            w_sum = 0.0
            for k in range(window):
                v = series[i, start + k]
                if not np.isnan(v):
                    w = weights[k]
                    total += w * v
                    w_sum += w
            if w_sum > 0.0:
                out[i, m] = total / w_sum
    return out


@njit(cache=True)
def _ewma_sum_at_sliding(
    series: np.ndarray, window: int, half_life: int, targets: np.ndarray,
) -> np.ndarray:
    """Sliding-window variant of _ewma_sum_at for consecutive targets.

    Requires ``targets`` to be consecutive (step 1) and
    ``targets[0] - window + 1 >= 0``; use _ewma_sum_at otherwise.
    O(N·(window + M)) instead of O(N·M·window) via the recurrence
    S(t) = delta·S(t−1) + g_t − delta^window·g_{t−window}, where g is the
    NaN-substituted-by-0 series (h series tracks valid weights the same way).
    """
    N, T = series.shape
    M = len(targets)
    out = np.full((N, M), np.nan)
    if M == 0:
        return out
    start0 = targets[0] - window + 1
    if start0 < 0:
        return out

    delta = 0.5 ** (1.0 / half_life)
    delta_w = delta ** window
    weights = np.empty(window, dtype=np.float64)
    for k in range(window):
        weights[k] = delta ** (window - 1 - k)

    for i in range(N):
        total = 0.0
        w_sum = 0.0
        for k in range(window):
            v = series[i, start0 + k]
            if not np.isnan(v):
                w = weights[k]
                total += w * v
                w_sum += w
        if w_sum > 0.0:
            out[i, 0] = total / w_sum
        for m in range(1, M):
            pos_new = targets[m]
            pos_old = pos_new - window
            v_new = series[i, pos_new]
            v_old = series[i, pos_old]
            h_new = 1.0 if not np.isnan(v_new) else 0.0
            g_new = v_new if h_new else 0.0
            h_old = 1.0 if not np.isnan(v_old) else 0.0
            g_old = v_old if h_old else 0.0
            total = delta * total + g_new - delta_w * g_old
            w_sum = delta * w_sum + h_new - delta_w * h_old
            if w_sum > 0.0:
                out[i, m] = total / w_sum
    return out


@njit(cache=True)
def _wls_at_targets_sliding(
    y: np.ndarray, x: np.ndarray, window: int, half_life: int,
    targets: np.ndarray, first_valid: np.ndarray | None = None,
) -> np.ndarray:
    """Sliding variant of _wls_at_targets for consecutive targets (step 1).

    Same zero-fill / listing semantics as _wls_at_targets.  Weighted moments
    slide with the recurrence S(t) = delta·S(t−1) + g_t − delta^W·g_{t−W};
    the unweighted SSE is recovered from unweighted moments (exact identity
    for Σ(y − α − βx)² given the fitted α, β).
    """
    N, T = y.shape
    M = len(targets)
    out = np.full((N, M, 3), np.nan)
    if M == 0:
        return out
    start0 = targets[0] - window + 1
    if start0 < 0:
        return out

    delta = 0.5 ** (1.0 / half_life)
    delta_w = delta ** window
    weights = np.empty(window, dtype=np.float64)
    for k in range(window):
        weights[k] = delta ** (window - 1 - k)

    for i in range(N):
        s_i = 0 if first_valid is None else int(first_valid[i])
        if s_i > start0:
            continue
        w_sum = 0.0
        wy = 0.0
        wx = 0.0
        wxx = 0.0
        wxy = 0.0
        wyy = 0.0
        n_valid = 0
        uy = 0.0
        ux = 0.0
        uxx = 0.0
        uxy = 0.0
        uyy = 0.0
        for k in range(window):
            xv = x[start0 + k]
            if np.isnan(xv):
                continue
            yv = y[i, start0 + k]
            if np.isnan(yv):
                yv = 0.0
            w = weights[k]
            w_sum += w
            wy += w * yv
            wx += w * xv
            wxx += w * xv * xv
            wxy += w * xv * yv
            wyy += w * yv * yv
            n_valid += 1
            uy += yv
            ux += xv
            uxx += xv * xv
            uxy += xv * yv
            uyy += yv * yv
        if w_sum > 0.0 and n_valid > 1:
            my = wy / w_sum
            mx = wx / w_sum
            var = wxx / w_sum - mx * mx
            if var > 1e-12:
                beta = (wxy / w_sum - my * mx) / var
                alpha = my - beta * mx
                sse = (uyy - 2.0 * alpha * uy - 2.0 * beta * uxy
                       + alpha * alpha * n_valid + 2.0 * alpha * beta * ux
                       + beta * beta * uxx)
                sigma = np.sqrt(max(sse, 0.0) / n_valid) if n_valid > 1 else np.nan
                out[i, 0, 0] = beta
                out[i, 0, 1] = alpha
                out[i, 0, 2] = sigma

        n_valid_f = float(n_valid)
        for m in range(1, M):
            pos_new = targets[m]
            pos_old = pos_new - window
            x_new = x[pos_new]
            x_old = x[pos_old]
            y_new = y[i, pos_new]
            y_old = y[i, pos_old]
            h_new = 1.0 if not np.isnan(x_new) else 0.0
            h_old = 1.0 if not np.isnan(x_old) else 0.0
            xg_new = x_new if h_new else 0.0
            xg_old = x_old if h_old else 0.0
            yg_new = y_new if (h_new and not np.isnan(y_new)) else 0.0
            yg_old = y_old if (h_old and not np.isnan(y_old)) else 0.0

            w_sum = delta * w_sum + h_new - delta_w * h_old
            wy = delta * wy + yg_new - delta_w * yg_old
            wx = delta * wx + xg_new - delta_w * xg_old
            wxx = delta * wxx + xg_new * xg_new - delta_w * xg_old * xg_old
            wxy = delta * wxy + xg_new * yg_new - delta_w * xg_old * yg_old
            wyy = delta * wyy + yg_new * yg_new - delta_w * yg_old * yg_old
            # Unweighted row count: plain add/subtract, no delta.
            n_valid_f = n_valid_f + h_new - h_old
            uy = uy + yg_new - yg_old
            ux = ux + xg_new - xg_old
            uxx = uxx + xg_new * xg_new - xg_old * xg_old
            uxy = uxy + xg_new * yg_new - xg_old * yg_old
            uyy = uyy + yg_new * yg_new - yg_old * yg_old

            if w_sum <= 0.0 or n_valid_f < 2.0:
                continue
            my = wy / w_sum
            mx = wx / w_sum
            var = wxx / w_sum - mx * mx
            if var <= 1e-12:
                continue
            beta = (wxy / w_sum - my * mx) / var
            alpha = my - beta * mx
            sse = (uyy - 2.0 * alpha * uy - 2.0 * beta * uxy
                   + alpha * alpha * n_valid_f
                   + 2.0 * alpha * beta * ux + beta * beta * uxx)
            n_res = int(round(n_valid_f))
            sigma = np.sqrt(max(sse, 0.0) / n_res) if n_res > 1 else np.nan
            out[i, m, 0] = beta
            out[i, m, 1] = alpha
            out[i, m, 2] = sigma
    return out


@njit(cache=True)
def _ewma_std_last(
    series: np.ndarray, window: int, half_life: int,
) -> np.ndarray:
    """EWMA weighted standard deviation over the last window. Returns (N,)."""
    N, T = series.shape
    out = np.full(N, np.nan)
    start = T - window
    if start < 0:
        return out

    delta = 0.5 ** (1.0 / half_life)
    weights = np.empty(window, dtype=np.float64)
    for k in range(window):
        weights[k] = delta ** (window - 1 - k)

    for i in range(N):
        w_sum = 0.0
        mean = 0.0
        n_valid = 0
        for k in range(window):
            v = series[i, start + k]
            if not np.isnan(v):
                w = weights[k]
                mean += w * v
                w_sum += w
                n_valid += 1
        if n_valid < window // 2 or w_sum <= 0.0:
            continue
        mean /= w_sum
        var = 0.0
        for k in range(window):
            v = series[i, start + k]
            if not np.isnan(v):
                d = v - mean
                var += weights[k] * d * d
        out[i] = np.sqrt(var / w_sum)
    return out


@njit(cache=True)
def _trailing_sum(series: np.ndarray, window: int) -> np.ndarray:
    """Sum over the last `window` entries, NaN treated as 0. Returns (N,)."""
    N, T = series.shape
    out = np.full(N, np.nan)
    start = T - window
    if start < 0:
        return out
    for i in range(N):
        total = 0.0
        has_value = False
        for k in range(start, T):
            v = series[i, k]
            if not np.isnan(v):
                total += v
                has_value = True
        if has_value:
            out[i] = total
    return out


def monthly_returns(close: np.ndarray, lag: int = 21) -> np.ndarray:
    """Month-over-month returns: m[:, j] = close[j]/close[j-lag] - 1.

    First `lag` columns are NaN.  Uses adjusted closes; NaN propagates.
    """
    N, T = close.shape
    out = np.full((N, T), np.nan)
    if T > lag:
        with np.errstate(invalid="ignore", divide="ignore"):
            ratio = close[:, lag:] / close[:, :-lag]
        out[:, lag:] = np.where(np.isfinite(ratio) & (ratio > 0), ratio - 1.0, np.nan)
    return out


def cmra_range(log_returns: np.ndarray, months: int = 12, days_per_month: int = 21) -> np.ndarray:
    """CNE6 CMRA: range of trailing cumulative log-return sums over i*21 days.

    z_i = sum of last i*21 log returns (NaN→0); CMRA = max(z) - min(z).
    """
    N, T = log_returns.shape
    filled = np.where(np.isfinite(log_returns), log_returns, 0.0)
    cum = np.cumsum(filled, axis=1)
    total = cum[:, -1]
    idx = T - np.arange(1, months + 1) * days_per_month - 1
    safe = np.where(idx >= 0, idx, 0)
    z = total[:, None] - np.where(idx >= 0, cum[:, safe], 0.0)
    return np.nanmax(z, axis=1) - np.nanmin(z, axis=1)
