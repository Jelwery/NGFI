# cne6_engine/tests/test_factor_return.py
"""Factor return regression tests."""
import numpy as np
import pytest

from cne6_engine.algorithm.factor_return import (
    daily_cross_sectional_regression_time_varying,
    weighted_ls_regression,
)


class TestWeightedLS:
    def test_recovers_exact_solution(self):
        rng = np.random.default_rng(1)
        X = rng.normal(size=(100, 4))
        f_true = np.array([0.01, -0.02, 0.005, 0.001])
        y = X @ f_true
        w = np.abs(rng.normal(1e10, 1e9, 100))
        f = weighted_ls_regression(X, y, w)
        assert np.allclose(f, f_true, atol=1e-12)

    def test_weights_pull_toward_weighted_observations(self):
        # Two clusters; heavy weight on one → fit passes through it.
        X = np.column_stack([np.ones(4), np.array([0.0, 0.0, 1.0, 1.0])])
        y = np.array([0.0, 0.0, 1.0, 1.0])
        w = np.array([100.0, 100.0, 1.0, 1.0])
        f = weighted_ls_regression(X, y, w)
        pred = X @ f
        assert abs(pred[0]) < 0.01


class TestTimeVaryingRegression:
    def _setup(self, seed=2, n_stocks=150, n_ind=3):
        rng = np.random.default_rng(seed)
        codes = [f"sz.{i:06d}" for i in range(n_stocks)]
        industry = rng.integers(0, n_ind, n_stocks)
        caps = np.abs(rng.normal(1e10, 1e9, n_stocks)) + 1e9

        dummy = np.zeros((n_stocks, n_ind))
        for i, g in enumerate(industry):
            dummy[i, g] = 1.0
        style = rng.normal(0, 1, (n_stocks, 2))
        X = np.column_stack([np.ones(n_stocks), dummy, style])
        return rng, X, caps, n_ind

    def test_constrained_recovery_with_feasible_f(self):
        rng, X, caps, n_ind = self._setup()
        # Industry returns satisfying the cap-weighted zero constraint.
        w = X[:, 1:1 + n_ind].T @ caps
        w = w / w.sum()
        v = rng.normal(0.003, 0.001, n_ind)
        f_ind = v - (v @ w) * w / (w @ w)
        f_true = np.concatenate([[0.008], f_ind, [0.004, -0.003]])
        y = X @ f_true + rng.normal(0, 1e-5, len(caps))
        f, _ = daily_cross_sectional_regression_time_varying(
            y[np.newaxis, :], X[np.newaxis, :, :], caps[np.newaxis, :],
            industry_count=n_ind,
        )
        assert np.allclose(f[0], f_true, atol=1e-5)

    def test_industry_constraint_holds(self):
        rng, X, caps, n_ind = self._setup()
        f_true = np.array([0.008, 0.003, -0.002, 0.001, 0.004, -0.003])
        y = X @ f_true + rng.normal(0, 1e-5, len(caps))
        f, _ = daily_cross_sectional_regression_time_varying(
            y[np.newaxis, :], X[np.newaxis, :, :], caps[np.newaxis, :],
            industry_count=n_ind,
        )
        industry_returns = f[0][1:1 + n_ind]
        industry_caps = X[:, 1:1 + n_ind].T @ caps
        # Relative threshold: absolute cancellation is machine-precision
        # against cap magnitudes of ~1e10.
        assert abs(industry_returns @ industry_caps) / industry_caps.sum() < 1e-12

    def test_country_factor_absorbs_market_return(self):
        # All stocks move together → country factor carries it.
        rng, X, caps, n_ind = self._setup()
        y = 0.01 + 0.0 * X @ np.zeros(X.shape[1]) + rng.normal(0, 1e-5, len(caps))
        f, _ = daily_cross_sectional_regression_time_varying(
            y[np.newaxis, :], X[np.newaxis, :, :], caps[np.newaxis, :],
            industry_count=n_ind,
        )
        assert f[0][0] == pytest.approx(0.01, abs=1e-5)
        assert np.abs(f[0][1:]).max() < 1e-4

    def test_nan_returns_dropped(self):
        rng, X, caps, n_ind = self._setup()
        f_true = np.array([0.008, 0.003, -0.002, 0.001, 0.004, -0.003])
        y = X @ f_true + rng.normal(0, 1e-5, len(caps))
        y[:50] = np.nan  # suspend half the market
        f, u = daily_cross_sectional_regression_time_varying(
            y[np.newaxis, :], X[np.newaxis, :, :], caps[np.newaxis, :],
            industry_count=n_ind,
        )
        assert np.all(np.isfinite(f[0]))
        assert np.isnan(u[0, :50]).all()
        assert np.isfinite(u[0, 50:]).all()

    def test_insufficient_stocks_skips_day(self):
        rng, X, caps, n_ind = self._setup()
        y = np.full(len(caps), np.nan)
        f, u = daily_cross_sectional_regression_time_varying(
            y[np.newaxis, :], X[np.newaxis, :, :], caps[np.newaxis, :],
            industry_count=n_ind,
        )
        assert np.isnan(f[0]).all()
