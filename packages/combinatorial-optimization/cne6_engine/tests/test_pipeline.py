# cne6_engine/tests/test_pipeline.py
"""End-to-end pipeline test on a synthetic 90-stock, 3-industry market."""
from datetime import date, timedelta

import numpy as np
import polars as pl
import pytest

from cne6_engine.algorithm.pipeline import compute_covariance
from cne6_engine.interfaces.contracts import (
    BenchmarkSeries,
    DataBundle,
    FundamentalHistory,
    IndustryMembership,
    MarketData,
)

N_DATES = 120
N_PER_IND = 30
INDUSTRIES = ["银行", "白酒", "电子"]


def _weekdays(n: int, start: date) -> list[str]:
    days, cur = [], start
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


DATES = _weekdays(N_DATES, date(2024, 1, 2))
END_DATE = DATES[-1]


class StubAdapter:
    def __init__(self, bundle):
        self._bundle = bundle

    def load_bundle(self, end_date):
        return self._bundle


def _build_bundle(seed=5) -> DataBundle:
    rng = np.random.default_rng(seed)
    codes, industries, caps = [], [], []
    for g, ind in enumerate(INDUSTRIES):
        for i in range(N_PER_IND):
            codes.append(f"sz.{g * N_PER_IND + i:06d}")
            industries.append(ind)
            caps.append(float(10 ** rng.uniform(9, 11)))
    codes = sorted(codes)
    order = np.argsort(codes)
    industries = [industries[i] for i in order]
    caps = np.array([caps[i] for i in order])
    n = len(codes)

    # Factor structure in returns: country + industry + cap-loading style.
    bench_ret = 0.0005 + 0.004 * rng.standard_t(3, N_DATES) / 3
    industry_load = np.array(
        [0.001 if ind == "白酒" else (-0.0005 if ind == "银行" else 0.0)
         for ind in industries]
    )
    style_load = (np.log(caps) - np.log(caps).mean()) / np.log(caps).std()

    rows = []
    close = np.full(n, 100.0)
    for t, d in enumerate(DATES):
        r = (
            bench_ret[t]
            + industry_load
            + 0.001 * style_load * bench_ret[t]
            + rng.normal(0, 0.015, n)
        )
        prev = close.copy()
        close = close * (1 + r)
        for i in range(n):
            rows.append({
                "code": codes[i], "date": d,
                "open": prev[i], "high": close[i] * 1.01,
                "low": prev[i] * 0.99, "close": close[i],
                "preclose": prev[i],
                "volume": 1e6, "amount": close[i] * 1e6,
                "daily_return": r[i],
                "turnover_rate": 0.01,
                "float_market_cap": caps[i],
                "total_market_cap": caps[i],
            })
    market = pl.DataFrame(rows).sort(["code", "date"])

    bench_close = 1000.0 * np.cumprod(1 + bench_ret)
    bench = pl.DataFrame({
        "date": DATES, "close": bench_close, "daily_return": bench_ret,
    })

    fund_rows = []
    for i, c in enumerate(codes):
        base_rev = 1e10 * (1 + 0.1 * i / n)
        for y in range(2020, 2025):
            fund_rows.append({
                "code": c, "report_date": f"{y}-12-31",
                "available_date": f"{y + 1}-04-30",
                "revenue": base_rev * (1 + 0.05) ** (y - 2020),
                "net_income": base_rev * 0.1,
                "eps": 1.0 + 0.1 * (y - 2020),
                "equity": caps[i] * 0.5,
                "operating_cashflow": base_rev * 0.15,
                "total_assets": caps[i] * 1.2,
                "total_liabilities": caps[i] * 0.7,
                "long_term_debt": None, "preferred_equity": None,
                "cogs": None, "capex": None,
                "depreciation_amortization": None, "ebit": None,
                "dividend_per_share": None, "total_shares": None,
                "cash": None, "short_term_debt": None,
                "investment_cashflow": None,
                "non_current_liabilities": None, "parent_equity": None,
            })
    fund = pl.DataFrame(fund_rows)
    for col in ["long_term_debt", "preferred_equity", "cogs", "capex",
                "depreciation_amortization", "ebit", "dividend_per_share",
                "total_shares", "cash", "short_term_debt",
                "investment_cashflow", "non_current_liabilities",
                "parent_equity"]:
        fund = fund.with_columns(pl.col(col).cast(pl.Float64))
    fund = fund.sort(["code", "report_date"])

    bundle = DataBundle(
        market=MarketData(frame=market),
        benchmark=BenchmarkSeries(frame=bench),
        fundamentals=FundamentalHistory(frame=fund),
        industry=IndustryMembership(frame=pl.DataFrame({
            "code": codes, "industry": industries,
        })),
    )
    bundle.validate()
    return bundle


@pytest.fixture(scope="module")
def bundle():
    return _build_bundle()


@pytest.fixture(scope="module")
def pipeline_result(bundle, tmp_path_factory):
    cache_dir = str(tmp_path_factory.mktemp("exposure_cache"))
    return compute_covariance(
        END_DATE,
        adapter=StubAdapter(bundle),
        lookback_days=N_DATES,
        cache_dir=cache_dir,
        factor_cov_kwargs=dict(
            vol_half_life=20, vol_nw_lags=2,
            corr_half_life=60, corr_nw_lags=1,
            vra_half_life=10, n_simulations=10,
        ),
        verbose=False,
    )


class TestPipeline:
    def test_result_structure(self, pipeline_result):
        r = pipeline_result
        N, K = r["exposures"].shape
        assert N == N_PER_IND * len(INDUSTRIES)
        assert r["sigma_stock"].shape == (N, N)
        assert r["factor_cov"].shape == (K, K)
        assert len(r["specific_risk"]) == N
        assert len(r["codes"]) == N
        assert len(r["factor_names"]) == K

    def test_factor_names_layout(self, pipeline_result):
        names = pipeline_result["factor_names"]
        assert names[0] == "COUNTRY"
        industries = names[1:1 + len(INDUSTRIES)]
        assert sorted(industries) == sorted(INDUSTRIES)
        assert "Size" in names
        assert "Volatility" in names

    def test_factor_cov_psd(self, pipeline_result):
        F = pipeline_result["factor_cov"]
        assert np.allclose(F, F.T)
        assert np.linalg.eigvalsh(F).min() > 0

    def test_specific_risk_positive(self, pipeline_result):
        sigma = pipeline_result["specific_risk"]
        assert (sigma > 0).all()
        # Synthetic specific risk is ~1.5% daily.
        assert 0.005 < np.median(sigma) < 0.05

    def test_stock_cov_properties(self, pipeline_result):
        S = pipeline_result["sigma_stock"]
        assert np.allclose(S, S.T)
        assert (np.diag(S) > 0).all()
        eig = np.linalg.eigvalsh(S)
        # Nearly PSD; allow tiny numerical negatives.
        assert eig.min() > -1e-8 * abs(eig.max())

    def test_regression_days(self, pipeline_result):
        # Early dates lack history for some descriptors → smaller style set
        # → those days drop out by design. Most days must remain valid.
        assert pipeline_result["meta"]["n_days"] >= N_DATES * 0.6

    def test_cache_reuse(self, bundle, tmp_path):
        cache_dir = str(tmp_path / "cache")
        kwargs = dict(
            adapter=StubAdapter(bundle), lookback_days=N_DATES,
            cache_dir=cache_dir, verbose=False,
            factor_cov_kwargs=dict(
                vol_half_life=20, vol_nw_lags=2,
                corr_half_life=60, corr_nw_lags=1,
                vra_half_life=10, n_simulations=5,
            ),
        )
        first = compute_covariance(END_DATE, **kwargs)
        import os
        cached_files = os.listdir(cache_dir)
        assert len(cached_files) == N_DATES
        second = compute_covariance(END_DATE, **kwargs)
        assert np.allclose(first["sigma_stock"], second["sigma_stock"])

    def test_outputs_saved(self, bundle, tmp_path):
        out_dir = str(tmp_path / "out")
        compute_covariance(
            END_DATE,
            adapter=StubAdapter(bundle), lookback_days=N_DATES,
            cache_dir=str(tmp_path / "cache"),
            output_dir=out_dir, verbose=False,
            factor_cov_kwargs=dict(
                vol_half_life=20, vol_nw_lags=2,
                corr_half_life=60, corr_nw_lags=1,
                vra_half_life=10, n_simulations=5,
            ),
        )
        import os
        files = set(os.listdir(out_dir))
        for suffix in ["exposures", "factor_cov", "specific_risk", "stock_cov"]:
            assert f"{suffix}_{END_DATE}.npy" in files
        assert f"codes_{END_DATE}.json" in files
        assert f"factor_names_{END_DATE}.json" in files
        assert "metadata.json" in files
