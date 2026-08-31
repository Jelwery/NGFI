# cne6_engine/algorithm/matrix_utils.py
"""Matrix utility functions for the CNE6 covariance matrix engine.

Provides correlation extraction, eigenvalue flooring, exposure standardization,
and associated helpers used across Modules 2, 4, and 5.
"""

import numpy as np


def extract_volatility_diag(cov_matrix: np.ndarray) -> np.ndarray:
    """Extract volatility from the diagonal of a covariance matrix.

    sigma_i = sqrt(max(C_{ii}, 0))

    Args:
        cov_matrix: (K, K) covariance matrix.

    Returns:
        (K,) array of volatilities.
    """
    diag = np.diag(cov_matrix).copy()
    diag = np.maximum(diag, 0.0)
    return np.sqrt(diag)


def extract_correlation_matrix(cov_matrix: np.ndarray) -> np.ndarray:
    """Normalize a covariance matrix to a correlation matrix.

    corr = D^{-1/2} @ cov @ D^{-1/2}
    where D = diag(C_{11}, ..., C_{KK}).

    Args:
        cov_matrix: (K, K) covariance matrix.

    Returns:
        (K, K) correlation matrix.
    """
    sigma = extract_volatility_diag(cov_matrix)
    # Guard against zero / near-zero variance to avoid division by zero
    inv_sigma = np.where(sigma > 1e-12, 1.0 / sigma, 0.0)
    D_inv = np.diag(inv_sigma)
    corr = D_inv @ cov_matrix @ D_inv
    # Force exact 1.0 on diagonal for numerical safety
    np.fill_diagonal(corr, 1.0)
    return corr


def combine_to_covariance(
    volatilities: np.ndarray,
    correlation: np.ndarray,
) -> np.ndarray:
    """Combine volatilities and a correlation matrix into a covariance matrix.

    F = diag(sigma) @ corr @ diag(sigma)

    Args:
        volatilities: (K,) array of standard deviations.
        correlation: (K, K) correlation matrix.

    Returns:
        (K, K) covariance matrix.
    """
    D = np.diag(volatilities)
    return D @ correlation @ D


def eigenvalue_flooring(
    cov_matrix: np.ndarray,
    floor_ratio: float = 0.01,
) -> np.ndarray:
    """Floor small eigenvalues to improve conditioning.

    Eigenvalues below lam_max * floor_ratio are raised to that value,
    then the matrix is reconstructed: V @ diag(clamped) @ V^T.

    Args:
        cov_matrix: (K, K) symmetric matrix (need not be PSD).
        floor_ratio: Minimum eigenvalue as a fraction of the maximum.

    Returns:
        (K, K) symmetric positive-definite matrix.
    """
    eigvals, eigvecs = np.linalg.eigh(cov_matrix)
    lam_max = np.max(eigvals)
    floor_val = lam_max * floor_ratio
    clamped = np.maximum(eigvals, floor_val)
    F_fixed = eigvecs @ np.diag(clamped) @ eigvecs.T
    # Enforce exact symmetry
    return (F_fixed + F_fixed.T) / 2.0


def winsorize_by_std(x: np.ndarray, n_std: float = 3.0) -> np.ndarray:
    """Clip values beyond ±n_std from the mean.

    Args:
        x: Input array (any shape).
        n_std: Number of standard deviations for the clip boundary.

    Returns:
        Clipped array of the same shape as x.
    """
    x = np.asarray(x, dtype=np.float64)
    mean = np.nanmean(x)
    std = np.nanstd(x)
    lower = mean - n_std * std
    upper = mean + n_std * std
    return np.clip(x, lower, upper)


def standardize_exposures(
    X: np.ndarray,
    weights: np.ndarray,
    n_std: float = 3.0,
) -> np.ndarray:
    """Standardize exposures per CNE5 methodology.

    For each column:
    1. Subtract cap-weighted mean.
    2. Divide by equal-weighted standard deviation.
    3. Winsorize at ±n_std (default 3.0).

    Args:
        X: (N, K) raw exposure matrix.
        weights: (N,) array of positive weights (e.g. sqrt(market cap)).
        n_std: Winsorization threshold in standard deviations.

    Returns:
        (N, K) standardized exposure matrix.
    """
    X = np.asarray(X, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    N, K = X.shape

    w_sum = np.nansum(weights)
    if w_sum <= 0:
        raise ValueError("weights must sum to a positive value")

    result = np.empty_like(X)
    for k in range(K):
        col = X[:, k]

        # Cap-weighted mean
        w_mean = np.nansum(weights * col) / w_sum

        # Center
        centered = col - w_mean

        # Equal-weighted standard deviation
        ew_std = np.nanstd(centered)

        # Scale to unit variance
        if ew_std > 1e-12:
            scaled = centered / ew_std
        else:
            scaled = np.zeros_like(centered)

        # Winsorize
        result[:, k] = winsorize_by_std(scaled, n_std=n_std)

    return result
