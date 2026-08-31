"""Specific (idiosyncratic) risk estimation.

Ported from CNE5 Module 5.

Pipeline:
    1. EWMA volatility per stock (half_life=21)
    2. Newey-West autocorrelation adjustment (half_life=252, lags=5)
    3. Bayesian Shrinkage toward group means (q=0.25, n_groups=10)
    4. Volatility Regime Adjustment (half_life=42)
"""
import numpy as np
from numba import njit
from cne6_engine.algorithm.ewma import ewma_volatility, compute_decay_factor


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _ewma_specific_volatility(specific_returns: np.ndarray, half_life: int) -> np.ndarray:
    """Compute EWMA volatility for each stock.

    For each stock independently computes a time-series EWMA of squared
    specific returns and takes the most recent value.

    Args:
        specific_returns: (T, N) array of daily specific returns.
        half_life: EWMA half-life in days.

    Returns:
        (N,) array of current volatility estimates.
    """
    T, N = specific_returns.shape
    sigma = np.empty(N, dtype=np.float64)
    for n in range(N):
        vol_ts = ewma_volatility(specific_returns[:, n], half_life=half_life)
        sigma[n] = vol_ts[-1]
    return sigma


@njit(cache=True)
def _nw_adjust_all_numba(
    specific_returns: np.ndarray,
    delta: float,
    nw_lags: int,
) -> np.ndarray:
    """Compute Newey-West adjustment factors for all stocks.

    For each stock n:
        f_n = sqrt(1 + 2 * sum_{k=1}^{L} w_k * rho_k)

    where w_k = (L+1-k)/(L+1) are Bartlett weights and rho_k is the
    EWMA-weighted autocorrelation at lag k (half_life = 252 / log(1/delta)).

    Args:
        specific_returns: (T, N) array of daily specific returns.
        delta: EWMA decay factor (0.5 ** (1 / nw_half_life)).
        nw_lags: Number of Newey-West lags.

    Returns:
        (N,) array of NW adjustment factors (>= 1 in most cases, >= 0).
    """
    T, N = specific_returns.shape
    factors = np.ones(N)

    if nw_lags <= 0 or T <= 1:
        return factors

    # Pre-compute EWMA weights (identical across stocks)
    weights = np.empty(T, dtype=np.float64)
    for t in range(T):
        weights[t] = delta ** (T - 1 - t)
    for n in range(N):
        # --- EWMA-weighted mean ---
        mean = 0.0
        valid_weight = 0.0
        for t in range(T):
            value = specific_returns[t, n]
            if np.isfinite(value):
                mean += weights[t] * value
                valid_weight += weights[t]
        if valid_weight <= 0.0:
            continue
        mean /= valid_weight

        # --- De-mean ---
        demeaned = np.empty(T, dtype=np.float64)
        for t in range(T):
            value = specific_returns[t, n]
            demeaned[t] = value - mean if np.isfinite(value) else np.nan

        # --- gamma_0 (EWMA variance) ---
        gamma_0 = 0.0
        for t in range(T):
            if np.isfinite(demeaned[t]):
                gamma_0 += weights[t] * demeaned[t] ** 2
        gamma_0 /= valid_weight

        if gamma_0 <= 1e-12:
            continue

        # --- gamma_k for k=1..L with Bartlett weighting ---
        total = 0.0
        for k in range(1, nw_lags + 1):
            if k >= T:
                continue
            gamma_k = 0.0
            w_k_sum = 0.0
            for t in range(k, T):
                if np.isfinite(demeaned[t]) and np.isfinite(demeaned[t - k]):
                    w_k_sum += weights[t]
                    gamma_k += weights[t] * demeaned[t] * demeaned[t - k]
            if w_k_sum <= 0.0:
                continue
            gamma_k /= w_k_sum

            rho_k = gamma_k / gamma_0
            w_bartlett = (nw_lags + 1 - k) / (nw_lags + 1)
            total += w_bartlett * rho_k

        var_factor = 1.0 + 2.0 * total
        if var_factor < 1e-12:
            var_factor = 1e-12
        factors[n] = np.sqrt(var_factor)

    return factors


def _nw_adjustment(
    specific_returns: np.ndarray,
    sigma_ewma: np.ndarray,
    nw_lags: int,
    nw_half_life: int,
) -> np.ndarray:
    """Apply Newey-West adjustment to EWMA volatility estimates.

    Args:
        specific_returns: (T, N) array of daily specific returns.
        sigma_ewma: (N,) EWMA volatility estimates.
        nw_lags: Number of Newey-West lags.
        nw_half_life: EWMA half-life for autocorrelation computation.

    Returns:
        (N,) NW-adjusted volatility estimates.
    """
    if nw_lags <= 0:
        return sigma_ewma
    delta = compute_decay_factor(nw_half_life)
    factors = _nw_adjust_all_numba(
        np.asarray(specific_returns, dtype=np.float64),
        delta,
        nw_lags,
    )
    return sigma_ewma * factors


def _vra_adjustment(
    specific_returns: np.ndarray,
    sigma: np.ndarray,
    half_life: int = 42,
) -> np.ndarray:
    """Apply Volatility Regime Adjustment to specific risk estimates.

    B_t  = sqrt(mean_n (u_{n,t} / sigma_n)^2)
    m_t  = EWMA(B_t, half_life=half_life)
    sigma_vra[n] = sigma[n] * sqrt(m_t)

    Args:
        specific_returns: (T, N) array of daily specific returns.
        sigma: (N,) predicted volatility estimates (after Bayesian shrinkage).
        half_life: EWMA half-life for smoothing B_t.

    Returns:
        (N,) VRA-adjusted volatility estimates.
    """
    lam = compute_decay_factor(half_life)

    # Guard against zero / near-zero vols
    sigma_safe = np.where(sigma > 1e-12, sigma, 1e-12)

    # Standardize each day's specific returns by the current sigma estimate
    standardized = specific_returns / sigma_safe[np.newaxis, :]  # (T, N)

    # Cross-sectional RMS for every day, excluding unavailable observations.
    finite = np.isfinite(standardized)
    counts = finite.sum(axis=1)
    mean_squares = np.divide(
        np.where(finite, standardized ** 2, 0.0).sum(axis=1),
        counts,
        out=np.full(len(standardized), np.nan),
        where=counts > 0,
    )
    B_t = np.sqrt(mean_squares)  # (T,)
    B_t = B_t[np.isfinite(B_t)]
    if len(B_t) == 0:
        return sigma.copy()

    # EWMA of B_t
    m_t = float(B_t[0])
    for t in range(1, len(B_t)):
        m_t = lam * m_t + (1.0 - lam) * B_t[t]

    if m_t < 1e-12:
        m_t = 1e-12

    return sigma * m_t


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def bayesian_shrinkage(
    raw_sigma: np.ndarray,
    market_caps: np.ndarray,
    q: float = 0.25,
    n_groups: int = 10,
) -> np.ndarray:
    """Apply Bayesian shrinkage toward group means (USE4 formulas 5.6-5.9).

    1. Segment stocks into *n_groups* market-cap ordered groups (deciles).
    2. Per group:
       prior_mean(s) = cap-weighted mean of sigma
       Delta_group   = sqrt(mean((sigma - prior_mean)^2))
    3. Per stock:
       nu_n = (q * |diff|) / (Delta_group + q * |diff|)
       sigma_n^SH = nu_n * prior_mean + (1 - nu_n) * sigma_n

    Intuition: stocks far from their group mean are heavily shrunk toward the
    group mean. The parameter *q* controls the overall shrinkage strength.

    Args:
        raw_sigma: (N,) raw volatility estimates.
        market_caps: (N,) market capitalisations (used for cap-weighted prior).
        q: Shrinkage intensity parameter (CNE5/CNE6 standard: 0.25).
        n_groups: Number of market-cap groups (CNE5/CNE6 standard: 10).

    Returns:
        (N,) shrunk volatility estimates.
    """
    N = len(raw_sigma)
    if N == 0:
        return np.array([], dtype=np.float64)
    if n_groups > N:
        n_groups = N

    raw_sigma = np.asarray(raw_sigma, dtype=np.float64)
    market_caps = np.asarray(market_caps, dtype=np.float64)

    # --- 1. Sort by market cap and partition into groups ---
    sort_idx = np.argsort(market_caps, kind="stable")

    group_sizes = np.full(n_groups, N // n_groups, dtype=np.intp)
    group_sizes[: N % n_groups] += 1  # distribute remainder

    group_id = np.empty(N, dtype=np.intp)
    start = 0
    for g in range(n_groups):
        sz = group_sizes[g]
        if sz > 0:
            group_id[sort_idx[start: start + sz]] = g
            start += sz

    # --- 2. Per-group statistics ---
    prior_means = np.zeros(n_groups, dtype=np.float64)
    deltas = np.zeros(n_groups, dtype=np.float64)

    for g in range(n_groups):
        idx = np.where(group_id == g)[0]
        if len(idx) == 0:
            continue
        g_sigma = raw_sigma[idx]
        g_mcap = market_caps[idx]
        pos = np.isfinite(g_mcap) & (g_mcap > 0)
        if pos.any():
            prior_means[g] = np.average(g_sigma[pos], weights=g_mcap[pos])
        else:
            prior_means[g] = float(np.nanmean(g_sigma))
        deltas[g] = np.sqrt(np.mean((g_sigma - prior_means[g]) ** 2))

    # --- 3. Apply shrinkage ---
    group_mean = prior_means[group_id]
    group_delta = deltas[group_id]
    diff = np.abs(raw_sigma - group_mean)

    with np.errstate(divide="ignore", invalid="ignore"):
        nu = np.where(
            group_delta + q * diff > 0,
            (q * diff) / (group_delta + q * diff),
            0.0,
        )

    return nu * group_mean + (1.0 - nu) * raw_sigma


def compute_specific_risk(
    specific_returns: np.ndarray,
    market_caps: np.ndarray,
    vol_half_life: int = 21,
    nw_lags: int = 5,
    nw_half_life: int = 252,
    bayesian_q: float = 0.25,
    vra_half_life: int = 42,
) -> np.ndarray:
    """Compute specific (idiosyncratic) risk for each stock.

    4-step pipeline:

    1. **EWMA** -- time-series EWMA of squared specific returns per stock.
    2. **NW**    -- Newey-West autocorrelation adjustment using
                   Bartlett-weighted lagged autocorrelations.
    3. **Bayesian Shrinkage** -- pull extreme estimates toward market-cap
                                 group means (USE4 formulas 5.6-5.9).
    4. **VRA**   -- Volatility Regime Adjustment: cross-sectional bias
                    statistic smoothed via EWMA.

    Args:
        specific_returns: (T, N) array of daily specific returns.
        market_caps: (N,) array of market capitalisations.
        vol_half_life: EWMA half-life for volatility (default 21).
        nw_lags: Newey-West lags (default 5).
        nw_half_life: Newey-West EWMA half-life (default 252).
        bayesian_q: Bayesian shrinkage parameter (default 0.25).
        vra_half_life: VRA EWMA half-life (default 42).

    Returns:
        (N,) array of specific risk (daily standard deviation) estimates.
    """
    specific_returns = np.asarray(specific_returns, dtype=np.float64)
    market_caps = np.asarray(market_caps, dtype=np.float64)

    T, N = specific_returns.shape

    if T < 2:
        raise ValueError(f"Need at least 2 observations, got {T}")
    if N == 0:
        return np.array([], dtype=np.float64)

    # Step 1: EWMA volatility per stock
    sigma = _ewma_specific_volatility(specific_returns, vol_half_life)

    # Step 2: Newey-West adjustment
    sigma = _nw_adjustment(specific_returns, sigma, nw_lags, nw_half_life)

    # Step 3: Bayesian shrinkage
    sigma = bayesian_shrinkage(sigma, market_caps, q=bayesian_q)

    # Step 4: Volatility Regime Adjustment
    sigma = _vra_adjustment(specific_returns, sigma, half_life=vra_half_life)

    return sigma
