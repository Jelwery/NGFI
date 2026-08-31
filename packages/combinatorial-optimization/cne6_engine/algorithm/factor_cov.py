# cne6_engine/algorithm/factor_cov.py
"""Factor covariance estimation (two-pass NW-EWMA + VRA + OBA).

Ported from CNE5 Module 4; factor count is parameterized for CNE6.
"""
from concurrent.futures import ThreadPoolExecutor
from functools import partial

import numpy as np
from cne6_engine.algorithm.ewma import nw_adjusted_covariance, compute_decay_factor
from cne6_engine.algorithm.matrix_utils import (
    extract_volatility_diag,
    extract_correlation_matrix,
    combine_to_covariance,
    eigenvalue_flooring,
)


def compute_vra_multiplier(
    factor_returns: np.ndarray,
    predicted_vols: np.ndarray,
    half_life: int = 42,
) -> float:
    """Compute VRA scalar multiplier m_t.

    B_t = sqrt(mean_k (r_{k,t} / sigma_k)^2)  -- cross-sectional RMS each day.
    m_t = EWMA(B_t, half_life=half_life)       -- final smoothed value.

    Args:
        factor_returns: (T, K) array of daily factor returns.
        predicted_vols: (K,) array of predicted volatilities per factor.
        half_life: EWMA half-life for smoothing B_t.

    Returns:
        Scalar multiplier m_t.
    """
    lam = compute_decay_factor(half_life)
    T = factor_returns.shape[0]
    vols = np.asarray(predicted_vols, dtype=np.float64)

    # Guard against zero / near-zero vols
    inv_vols = np.where(vols > 1e-12, 1.0 / vols, 0.0)

    # Compute B_t for each day
    B = np.empty(T, dtype=np.float64)
    for t in range(T):
        standardized = factor_returns[t, :] * inv_vols
        B[t] = np.sqrt(np.mean(standardized ** 2))

    # EWMA of B_t
    m_t = B[0]
    for t in range(1, T):
        m_t = lam * m_t + (1.0 - lam) * B[t]

    return float(m_t)


def _estimate_raw_factor_cov(
    factor_returns: np.ndarray,
    vol_half_life: int = 84,
    vol_nw_lags: int = 5,
    corr_half_life: int = 504,
    corr_nw_lags: int = 2,
) -> tuple[np.ndarray, np.ndarray]:
    """Two-pass NW-EWMA without VRA or OBA.

    Returns the raw combined covariance matrix and the volatility vector
    (the latter is needed by the caller for VRA computation).
    """
    C_vol = nw_adjusted_covariance(factor_returns, half_life=vol_half_life, nw_lags=vol_nw_lags)
    vols = extract_volatility_diag(C_vol)
    C_corr = nw_adjusted_covariance(factor_returns, half_life=corr_half_life, nw_lags=corr_nw_lags)
    corr = extract_correlation_matrix(C_corr)
    F_raw = combine_to_covariance(vols, corr)
    return F_raw, vols


def monte_carlo_oba(
    F_input: np.ndarray,
    factor_returns: np.ndarray,
    vol_half_life: int = 84,
    vol_nw_lags: int = 5,
    corr_half_life: int = 504,
    corr_nw_lags: int = 2,
    n_simulations: int = 100,
    seed: int | None = 42,
    verbose: bool = False,
    n_workers: int = 4,
) -> np.ndarray:
    """Monte Carlo eigenfactor risk adjustment (OBA).

    Simulates M datasets from F_input, re-estimates the covariance via the
    two-pass NW-EWMA procedure on each, and measures the bias between the
    estimated and "true" eigenfactor variances.  Small eigenfactors are
    systematically underestimated by sample covariance estimators; this
    procedure detects and corrects that bias on a per-eigenfactor basis.

    The bias ratios are normalised so that their geometric mean equals 1 —
    OBA adjusts the *relative* eigenfactor structure while VRA handles the
    overall volatility scale.

    Args:
        F_input: (K, K) covariance matrix to adjust (typically post-VRA).
        factor_returns: Original (T, K) factor returns (used only for T).
        vol_half_life, vol_nw_lags: Volatility-pass NW-EWMA parameters.
        corr_half_life, corr_nw_lags: Correlation-pass NW-EWMA parameters.
        n_simulations: Number of Monte Carlo replications (≥ 50 recommended).
        seed: RNG seed for reproducibility.
        n_workers: Number of threads used for covariance re-estimation.

    Returns:
        (K, K) bias-adjusted positive-definite covariance matrix.
    """
    if n_workers <= 0:
        raise ValueError(f"n_workers must be positive, got {n_workers}")

    # Ensure F_input is strictly PSD for multivariate_normal sampling.
    # Tiny negative eigenvalues can arise from numerical noise in correlation
    # extraction; flooring them to 0 before simulation is harmless.
    eig_raw, eigvecs_raw = np.linalg.eigh(F_input)
    eig_raw = np.maximum(eig_raw, np.max(eig_raw) * 1e-12 if np.max(eig_raw) > 0 else 1e-12)
    F_psd = eigvecs_raw @ np.diag(eig_raw) @ eigvecs_raw.T
    F_psd = (F_psd + F_psd.T) / 2.0

    eigvals, eigvecs = np.linalg.eigh(F_psd)
    K = len(eigvals)
    T = factor_returns.shape[0]
    rng = np.random.default_rng(seed)

    sim_variances = np.zeros((n_simulations, K))

    report_every = max(1, n_simulations // 5)

    simulated_returns = [
        rng.multivariate_normal(np.zeros(K), F_psd, size=T)
        for _ in range(n_simulations)
    ]
    estimate = partial(
        _estimate_raw_factor_cov,
        vol_half_life=vol_half_life,
        vol_nw_lags=vol_nw_lags,
        corr_half_life=corr_half_life,
        corr_nw_lags=corr_nw_lags,
    )
    worker_count = min(n_workers, n_simulations)
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        estimates = executor.map(estimate, simulated_returns)
        for m, (F_sim, _vols_sim) in enumerate(estimates):
            for j in range(K):
                sim_variances[m, j] = eigvecs[:, j] @ F_sim @ eigvecs[:, j]

            if verbose and (m + 1) % report_every == 0:
                print(f"         MC sim {m + 1}/{n_simulations}")

    # Per-eigenfactor mean simulated variance
    mean_sim_var = np.mean(sim_variances, axis=0)
    mean_sim_var = np.maximum(mean_sim_var, 1e-15)
    true_var = np.maximum(eigvals, 1e-15)

    # Volatility bias: if vol_bias[j] > 1 the eigenfactor is underestimated
    vol_bias = np.sqrt(true_var / mean_sim_var)

    # Normalise so geometric mean = 1 (OBA adjusts relative structure only)
    log_bias = np.log(np.maximum(vol_bias, 1e-15))
    vol_bias /= np.exp(np.mean(log_bias))

    # Apply bias to eigenvalues (squared because we work on variance scale)
    adj_eigvals = eigvals * (vol_bias ** 2)

    # Floor to prevent rank deficiency from numerical underflow
    floor_val = np.max(eigvals) * 1e-10
    adj_eigvals = np.maximum(adj_eigvals, floor_val)

    F_adj = eigvecs @ np.diag(adj_eigvals) @ eigvecs.T
    return (F_adj + F_adj.T) / 2.0


def _apply_oba(
    F_vra: np.ndarray,
    factor_returns: np.ndarray,
    oba_method: str,
    vol_half_life: int,
    vol_nw_lags: int,
    corr_half_life: int,
    corr_nw_lags: int,
    n_simulations: int,
    floor_ratio: float,
    seed: int | None,
    verbose: bool,
    max_condition_number: float,
) -> np.ndarray:
    if oba_method == "monte_carlo":
        F_final = monte_carlo_oba(
            F_vra,
            factor_returns,
            vol_half_life=vol_half_life,
            vol_nw_lags=vol_nw_lags,
            corr_half_life=corr_half_life,
            corr_nw_lags=corr_nw_lags,
            n_simulations=n_simulations,
            seed=seed,
            verbose=verbose,
        )
        eigenvalues, eigenvectors = np.linalg.eigh(F_final)
        largest = float(eigenvalues[-1])
        floor = largest / max_condition_number
        if eigenvalues[0] < floor:
            F_final = eigenvectors @ np.diag(
                np.maximum(eigenvalues, floor)
            ) @ eigenvectors.T
            F_final = (F_final + F_final.T) / 2.0
    elif oba_method == "eigenvalue_flooring":
        F_final = eigenvalue_flooring(F_vra, floor_ratio=floor_ratio)
    elif oba_method == "none":
        F_final = F_vra
    else:
        raise ValueError(
            f"Unknown oba_method {oba_method!r}; "
            f"expected 'monte_carlo', 'eigenvalue_flooring', or 'none'"
        )
    return F_final


def compute_factor_covariance_methods(
    factor_returns: np.ndarray,
    methods: tuple[str, ...] = ("monte_carlo",),
    vol_half_life: int = 84,
    vol_nw_lags: int = 5,
    corr_half_life: int = 504,
    corr_nw_lags: int = 2,
    vra_half_life: int = 42,
    n_simulations: int = 100,
    floor_ratio: float = 0.01,
    seed: int | None = 42,
    verbose: bool = False,
    max_condition_number: float = 1e6,
) -> dict[str, np.ndarray]:
    """Compute several OBA variants from one NW-EWMA and VRA estimate."""
    F_raw, vols = _estimate_raw_factor_cov(
        factor_returns,
        vol_half_life=vol_half_life,
        vol_nw_lags=vol_nw_lags,
        corr_half_life=corr_half_life,
        corr_nw_lags=corr_nw_lags,
    )
    m_t = compute_vra_multiplier(
        factor_returns, vols, half_life=vra_half_life,
    )
    F_vra = (m_t ** 2) * F_raw

    return {
        method: _apply_oba(
            F_vra,
            factor_returns,
            method,
            vol_half_life,
            vol_nw_lags,
            corr_half_life,
            corr_nw_lags,
            n_simulations,
            floor_ratio,
            seed,
            verbose,
            max_condition_number,
        )
        for method in methods
    }


def compute_factor_covariance(
    factor_returns: np.ndarray,
    vol_half_life: int = 84,
    vol_nw_lags: int = 5,
    corr_half_life: int = 504,
    corr_nw_lags: int = 2,
    vra_half_life: int = 42,
    oba_method: str = "monte_carlo",
    n_simulations: int = 100,
    floor_ratio: float = 0.01,
    seed: int | None = 42,
    verbose: bool = False,
    max_condition_number: float = 1e6,
) -> np.ndarray:
    """Compute the factor covariance matrix F (K x K).

    Two-pass NW-EWMA:
      1. Short half-life (84) + NW lags (5)  -> extract volatilities.
      2. Long half-life  (504) + NW lags (2) -> extract correlations.
      Combine: F_raw = diag(sigma) @ corr @ diag(sigma).

    VRA (Volatility Regime Adjustment):
      Scalar multiplier m_t via cross-sectional RMS of standardized returns,
      smoothed with EWMA (half_life=42).

    OBA (Eigenfactor Risk Adjustment):
      ``"monte_carlo"`` — full Monte Carlo simulation to estimate and correct
      per-eigenfactor estimation bias (default).
      ``"eigenvalue_flooring"`` — fast simplified floor on eigenvalues.

    Args:
        factor_returns: (T, K) array of daily factor returns.
        vol_half_life: Half-life for the volatility pass.
        vol_nw_lags: Newey-West lags for the volatility pass.
        corr_half_life: Half-life for the correlation pass.
        corr_nw_lags: Newey-West lags for the correlation pass.
        vra_half_life: Half-life for VRA EWMA smoothing.
        oba_method: ``"monte_carlo"`` or ``"eigenvalue_flooring"``.
        n_simulations: Number of Monte Carlo replications (MC OBA only).
        floor_ratio: Minimum eigenvalue fraction (flooring OBA only).
        seed: RNG seed for reproducibility (MC OBA only).

    Returns:
        (K, K) positive-definite factor covariance matrix.
    """
    F_raw, vols = _estimate_raw_factor_cov(
        factor_returns,
        vol_half_life=vol_half_life,
        vol_nw_lags=vol_nw_lags,
        corr_half_life=corr_half_life,
        corr_nw_lags=corr_nw_lags,
    )

    # --- VRA: scalar multiplier ---
    m_t = compute_vra_multiplier(factor_returns, vols, half_life=vra_half_life)
    F_vra = (m_t ** 2) * F_raw

    F_final = _apply_oba(
        F_vra,
        factor_returns,
        oba_method,
        vol_half_life,
        vol_nw_lags,
        corr_half_life,
        corr_nw_lags,
        n_simulations,
        floor_ratio,
        seed,
        verbose,
        max_condition_number,
    )

    return F_final
