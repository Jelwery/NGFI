# cne6_engine/tests/test_descriptors.py
"""Descriptor engine tests — synthetic panels with hand-computed expectations."""
from datetime import date, datetime, timedelta

import numpy as np
import polars as pl
import pytest

from cne6_engine.algorithm.registry import (
    DESCRIPTORS,
    descriptors_in_level2,
    level1_names,
    level2_names,
)
from cne6_engine.algorithm.rolling import (
    _ewma_sum_at,
    _ewma_sum_at_sliding,
    _trailing_sum,
    _wls_at_targets,
    _wls_at_targets_sliding,
    cmra_range,
    ewma_weights,
    monthly_returns,
)
from cne6_engine.algorithm.descriptors import (
    MarketPanel,
    compute_descriptors,
)
from cne6_engine.interfaces.contracts import (
    AnalystData,
    BenchmarkSeries,
    DataBundle,
    FundamentalHistory,
    IndustryMembership,
    MarketData,
)

B = 0.001  # benchmark daily return


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class TestRegistry:
    def test_all_documented_descriptors(self):
        # 42 = every descriptor documented in the CNE6 reference tables.
        # The "46" marketing figure includes unpublished variables.
        assert len(DESCRIPTORS) == 42

    def test_nine_level1_groups(self):
        assert level1_names() == [
            "Size", "Volatility", "Liquidity", "Momentum",
            "Quality", "Value", "Growth", "Sentiment", "DividendYield",
        ]

    def test_hierarchy_consistent(self):
        for name, spec in DESCRIPTORS.items():
            assert spec.level2 in level2_names(spec.level1), name
            assert name in descriptors_in_level2(spec.level2), name

    def test_level2_count(self):
        assert len(level2_names()) == 21

    def test_sentiment_has_no_public_fields(self):
        for name in ("RRIBS", "EPIBSC", "EARNC"):
            assert any(
                f.startswith("analyst") for f in DESCRIPTORS[name].required
            )


# ---------------------------------------------------------------------------
# Rolling primitives
# ---------------------------------------------------------------------------

class TestRolling:
    def test_ewma_weights_normalized(self):
        w = ewma_weights(10, 5)
        assert np.isclose(w.sum(), 1.0)
        assert w[-1] > w[0]  # newest weighted most

    def test_ewma_sum_constant(self):
        series = np.full((1, 30), 2.5)
        out = _ewma_sum_at(series, 10, 3, np.array([29], dtype=np.int64))
        assert np.isclose(out[0, 0], 2.5)

    def test_ewma_sum_hand_computed(self):
        series = np.array([[1.0, 2.0, 3.0, 4.0]])
        w = ewma_weights(4, 1)  # [1/8, 1/4? ...] delta=0.5
        expected = (w * np.array([1, 2, 3, 4])).sum()
        out = _ewma_sum_at(series, 4, 1, np.array([3], dtype=np.int64))
        assert np.isclose(out[0, 0], expected)

    def test_wls_recovers_linear(self):
        t = np.arange(20, dtype=np.float64)
        x = 0.001 + 0.0001 * t
        y = 2.0 + 3.0 * x  # exact linear relation
        out = _wls_at_targets(
            y[np.newaxis, :], x, 20, 5, np.array([19], dtype=np.int64),
        )
        assert np.isclose(out[0, 0, 0], 3.0)   # beta
        assert np.isclose(out[0, 0, 1], 2.0)   # alpha
        assert np.isclose(out[0, 0, 2], 0.0)   # sigma

    def test_wls_resid_sigma(self):
        t = np.arange(40, dtype=np.float64)
        x = 0.001 + 0.0001 * t
        noise = np.where(t % 2 == 0, 0.002, -0.002)
        y = 0.5 + 1.0 * x + noise
        out = _wls_at_targets(
            y[np.newaxis, :], x, 40, 10, np.array([39], dtype=np.int64),
        )
        assert np.isclose(out[0, 0, 2], 0.002, rtol=0.01)

    def test_trailing_sum_nan_treated_as_zero(self):
        series = np.array([[1.0, np.nan, 3.0]])
        assert np.isclose(_trailing_sum(series, 3)[0], 4.0)

    def test_monthly_returns(self):
        close = np.array([[100.0, 110.0, 121.0]])
        m = monthly_returns(close, lag=1)
        assert np.isclose(m[0, 1], 0.1)
        assert np.isnan(m[0, 0])

    def test_cmra_constant(self):
        log_ret = np.full((1, 252), 0.001)
        # z_i = i*21*r cumulative sums; range = z_12 - z_1 = 231r
        assert np.isclose(cmra_range(log_ret)[0], 231 * 0.001)

    def test_ewma_sliding_matches_direct(self):
        rng = np.random.default_rng(0)
        series = rng.standard_normal((40, 600))
        series[rng.random((40, 600)) < 0.1] = np.nan
        targets = np.arange(560, 571, dtype=np.int64)  # 11 consecutive
        direct = _ewma_sum_at(series, 252, 126, targets)
        sliding = _ewma_sum_at_sliding(series, 252, 126, targets)
        assert np.allclose(direct, sliding, equal_nan=True, rtol=1e-9, atol=1e-15)

    def test_wls_sliding_matches_direct(self):
        rng = np.random.default_rng(1)
        t = np.arange(700)
        y = rng.standard_normal((40, 700)) * 0.02
        y += (0.5 + 1.3 * np.cos(t / 11.0))[None, :]
        y[rng.random((40, 700)) < 0.08] = np.nan
        x = 0.001 + 0.007 * np.sin(t / 37.0)
        targets = np.arange(640, 651, dtype=np.int64)  # 11 consecutive
        direct = _wls_at_targets(y, x, 504, 252, targets)
        sliding = _wls_at_targets_sliding(y, x, 504, 252, targets)
        assert np.allclose(direct, sliding, equal_nan=True, rtol=1e-7, atol=1e-12)

    def test_sliding_requires_consecutive(self):
        series = np.ones((2, 300))
        targets = np.array([99, 100, 150], dtype=np.int64)  # gap → direct path
        direct = _ewma_sum_at(series, 100, 50, targets)
        assert np.isfinite(direct).any()

    def test_wls_zero_fills_nan(self):
        # Reference convention: NaN returns are treated as 0 with full weight.
        y = np.array([[0.02, np.nan, 0.04]])
        x = np.array([0.01, 0.005, 0.015])
        w = ewma_weights(3, 3)
        yf = np.array([0.02, 0.0, 0.04])
        total = w.sum()
        my = (w @ yf) / total
        mx = (w @ x) / total
        var = (w * (x - mx) ** 2).sum() / total
        beta = (w * (x - mx) * (yf - my)).sum() / total / var
        alpha = my - beta * mx
        sse = ((yf - (alpha + beta * x)) ** 2).sum()
        sigma = np.sqrt(sse / 3)
        out = _wls_at_targets(y, x, 3, 3, np.array([2], dtype=np.int64))
        assert np.isclose(out[0, 0, 0], beta)
        assert np.isclose(out[0, 0, 1], alpha)
        assert np.isclose(out[0, 0, 2], sigma)

    def test_wls_excludes_not_yet_listed(self):
        # Stock starts at index 2; window [1,3] starts before listing → NaN.
        y = np.full((1, 6), np.nan)
        y[0, 2:] = 0.01
        x = np.array([0.01, 0.012, 0.008, 0.011, 0.009, 0.01])
        first_valid = np.array([2], dtype=np.int64)
        out = _wls_at_targets(
            y, x, 3, 3, np.array([3], dtype=np.int64), first_valid,
        )
        assert np.isnan(out[0, 0]).all()
        # target at index 5: start=3 == listing index → active, zero-available
        out2 = _wls_at_targets(
            y, x, 3, 3, np.array([5], dtype=np.int64), first_valid,
        )
        assert np.isfinite(out2[0, 0, 0])


# ---------------------------------------------------------------------------
# Synthetic bundle
# ---------------------------------------------------------------------------

def _weekdays(n: int, start: date) -> list[str]:
    days = []
    cur = start
    while len(days) < n:
        if cur.weekday() < 5:
            days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


N_DATES = 1400
DATES = _weekdays(N_DATES, date(2024, 1, 2))
END_DATE = DATES[-1]

STOCKS = {
    "sh.600000": {"alpha": 0.002, "beta": 0.5, "cap": 1e10, "noise": 0.0},
    "sz.000001": {"alpha": 0.0, "beta": 1.0, "cap": 2e10, "noise": 0.0},
    "sh.600519": {"alpha": 0.0, "beta": 1.0, "cap": 5e10, "noise": 0.002},
    "sz.300750": {"alpha": 0.0005, "beta": 1.5, "cap": 1e11, "noise": 0.0},
    "sh.688001": {"alpha": 0.0, "beta": 1.0, "cap": 2e11, "noise": 0.0},
}
TURNOVER = 0.01


def _bench_pattern(kind: str, t: int) -> float:
    if kind == "constant":
        return B
    return B + 0.0004 * (1 if t % 2 == 0 else -1)


def _noise_pattern(t: int) -> int:
    # Period-3, zero-mean: +1, -1, 0 — not collinear with the period-2
    # benchmark alternation, so beta stays identifiable.
    if t % 3 == 0:
        return 1
    if t % 3 == 1:
        return -1
    return 0


def _market_frame(bench_kind: str) -> pl.DataFrame:
    rows = []
    for code, spec in STOCKS.items():
        close = 100.0
        for t, d in enumerate(DATES):
            r = (
                spec["alpha"]
                + spec["beta"] * _bench_pattern(bench_kind, t)
                + spec["noise"] * _noise_pattern(t)
            )
            prev, close = close, close * (1.0 + r)
            rows.append({
                "code": code, "date": d,
                "open": prev, "high": close * 1.01, "low": prev * 0.99,
                "close": close, "preclose": prev,
                "volume": 1e6, "amount": close * 1e6,
                "daily_return": r,
                "turnover_rate": TURNOVER,
                "float_market_cap": spec["cap"],
                "total_market_cap": spec["cap"],
            })
    return pl.DataFrame(rows).sort(["code", "date"])


def _fundamental_frame() -> pl.DataFrame:
    years = list(range(2020, 2025))
    rev = [100e9, 110e9, 120e9, 130e9, 140e9]
    eps = [1.0, 2.0, 3.0, 4.0, 5.0]
    ta = [1000e9, 1010e9, 1020e9, 1030e9, 1040e9]
    capex = [10e9, 12e9, 14e9, 16e9, 18e9]
    shares = [10e9, 11e9, 12e9, 13e9, 14e9]
    rows = []
    for code in STOCKS:
        for i, y in enumerate(years):
            rows.append({
                "code": code,
                "report_date": f"{y}-12-31",
                "available_date": f"{y + 1}-04-30",
                "revenue": rev[i], "net_income": 1e9, "eps": eps[i],
                "equity": 5e9, "operating_cashflow": 8e8,
                "total_assets": ta[i], "total_liabilities": 7e9,
                "long_term_debt": 4e9, "preferred_equity": 0.0,
                "short_term_debt": 1e9, "cash": 2e9,
                "cogs": rev[i] * 0.8, "capex": capex[i],
                "depreciation_amortization": 5e9, "ebit": 3e9,
                "investment_cashflow": -6e9,
                "dividend_per_share": 0.5, "total_shares": shares[i],
                "non_current_liabilities": 3.5e9, "parent_equity": 4.5e9,
            })
    frame = pl.DataFrame(rows)
    for c in ["long_term_debt", "preferred_equity", "short_term_debt", "cash",
              "cogs", "capex", "depreciation_amortization", "ebit",
              "investment_cashflow", "dividend_per_share", "total_shares",
              "non_current_liabilities", "parent_equity"]:
        frame = frame.with_columns(pl.col(c).cast(pl.Float64))
    return frame.sort(["code", "report_date"])


def _make_bundle(bench_kind: str) -> DataBundle:
    bundle = DataBundle(
        market=MarketData(frame=_market_frame(bench_kind)),
        benchmark=BenchmarkSeries(frame=_benchmark_frame(bench_kind)),
        fundamentals=FundamentalHistory(frame=_fundamental_frame()),
        industry=IndustryMembership(frame=pl.DataFrame({
            "code": list(STOCKS), "industry": ["银行"] * len(STOCKS),
        })),
    )
    bundle.validate()
    return bundle


def _pivot_reference(frame: pl.DataFrame, dates: list[str], codes: list[str]):
    """Construction used before the grid rewrite: one pivot per column."""
    f = frame.filter(pl.col("date").is_in(dates))
    out = {}
    for col in ["daily_return", "close", "turnover_rate",
                "float_market_cap", "total_market_cap"]:
        p = f.pivot(index="date", on="code", values=col).sort("date")
        cols = sorted(c for c in p.columns if c != "date")
        out[col] = p.select(cols).to_numpy().T.copy()
    return out


def _analyst_frame() -> pl.DataFrame:
    """Events for two stocks; ±30/±60d inside the 90d window, ±120d outside."""
    base = datetime.fromisoformat(END_DATE)
    d = lambda off: (base - timedelta(days=off)).isoformat()
    rows = [
        ("sh.600000", d(120), 1.0, 1.0, 1.0),
        ("sh.600000", d(60), 1.0, 1.0, 1.0),
        ("sh.600000", d(30), -1.0, 1.5, -1.0),
        ("sz.000001", d(60), 1.0, 2.0, -1.0),
        ("sz.000001", d(30), 1.0, 2.0, -1.0),
    ]
    # neutral coverage for the remaining stocks (spread 0, EPS flat).
    for code in ["sh.600519", "sz.300750", "sh.688001"]:
        rows.append((code, d(60), 1.0, 1.0, 1.0))
        rows.append((code, d(30), -1.0, 1.0, -1.0))
    return pl.DataFrame(
        rows,
        schema=["code", "date", "analyst_rating_change",
                "analyst_eps_forecast_change", "analyst_earnings_revision"],
        orient="row",
    ).sort(["code", "date"])


def _final_close(code: str) -> float:
    """Last close of the calendar month before END_DATE (DTOP denominator)."""
    year, month = int(END_DATE[:4]), int(END_DATE[5:7])
    bound = f"{year}-{month:02d}-01"
    sub = _market_frame("constant").filter(
        (pl.col("code") == code) & (pl.col("date") < bound)
    )
    return float(sub.sort("date")["close"][-1])


def _benchmark_frame(bench_kind: str) -> pl.DataFrame:
    returns = [_bench_pattern(bench_kind, t) for t in range(N_DATES)]
    close = np.cumprod([1000.0] + [1.0 + r for r in returns[1:]])
    return pl.DataFrame({
        "date": DATES, "close": close, "daily_return": returns,
    })


@pytest.fixture(scope="module")
def bundle() -> DataBundle:
    return _make_bundle("constant")


@pytest.fixture(scope="module")
def bundle_varying() -> DataBundle:
    return _make_bundle("varying")


@pytest.fixture(scope="module")
def bundle_analyst() -> DataBundle:
    bundle = _make_bundle("constant")
    return DataBundle(
        market=bundle.market,
        benchmark=bundle.benchmark,
        fundamentals=bundle.fundamentals,
        industry=bundle.industry,
        analyst=AnalystData(frame=_analyst_frame()),
    )


@pytest.fixture(scope="module")
def descriptor_result(bundle):
    return compute_descriptors(bundle, END_DATE)


@pytest.fixture(scope="module")
def descriptor_result_varying(bundle_varying):
    return compute_descriptors(bundle_varying, END_DATE)


def _col(result, name) -> dict[str, float]:
    frame, _ = result
    sub = frame.select("code", name)
    return dict(zip(sub["code"].to_list(), sub[name].to_list()))


def _stock_returns(code: str, bench_kind: str = "constant") -> np.ndarray:
    spec = STOCKS[code]
    return np.array([
        spec["alpha"]
        + spec["beta"] * _bench_pattern(bench_kind, t)
        + spec["noise"] * _noise_pattern(t)
        for t in range(N_DATES)
    ])


def _ewma_dot(values: np.ndarray, window: int, half_life: int) -> float:
    w = 0.5 ** (np.arange(window - 1, -1, -1) / half_life)
    w = w / w.sum()
    return float(w @ values[-window:])


class TestPanelGrid:
    def test_matches_pivot_including_missing_rows(self):
        # Drop one (code, date) row — NaN positions must match the old pivot.
        market = _market_frame("constant").filter(
            ~((pl.col("code") == "sh.600519") & (pl.col("date") == END_DATE))
        )
        bundle = DataBundle(
            market=MarketData(frame=market),
            benchmark=BenchmarkSeries(frame=_benchmark_frame("constant")),
            fundamentals=FundamentalHistory(frame=_fundamental_frame()),
            industry=IndustryMembership(frame=pl.DataFrame({
                "code": list(STOCKS), "industry": ["银行"] * len(STOCKS),
            })),
        )
        panel = MarketPanel.from_bundle(bundle, END_DATE)
        frame = bundle.market.frame.filter(pl.col("date") <= END_DATE)
        dates = frame["date"].unique().sort().to_list()
        codes = sorted(frame["code"].unique().to_list())
        ref = _pivot_reference(frame, dates, codes)
        assert panel.codes == codes
        assert panel.dates == dates
        for name, got in [
            ("daily_return", panel.returns), ("close", panel.close),
            ("turnover_rate", panel.turnover),
            ("float_market_cap", panel.float_cap),
            ("total_market_cap", panel.total_cap),
        ]:
            assert np.array_equal(got, ref[name], equal_nan=True), name


class TestComputeDescriptors:
    def test_frame_shape(self, descriptor_result):
        frame, meta = descriptor_result
        assert frame.height == len(STOCKS)
        assert frame["code"].to_list() == sorted(STOCKS)
        assert meta["n_dates"] == N_DATES

    def test_included_descriptors(self, descriptor_result, descriptor_result_varying):
        _, meta = descriptor_result
        _, meta_varying = descriptor_result_varying
        # Regression-based descriptors need a varying benchmark.
        for name in ["HBETA", "HSIGMA", "HALPHA", "LTHALPHA"]:
            assert name in meta_varying["included"], (
                f"{name}: {meta_varying['excluded'].get(name)}"
            )
        for name in ["LNCAP", "MIDCAP", "DASTD", "CMRA", "STOM", "STOQ", "STOA",
                     "ATVR", "STREV", "SEASON", "INDMOM", "RSTR", "LTRSTR",
                     "BTOP", "ETOP", "CETOP", "DTOA", "ATO", "ROA", "VSAL",
                     "VERN", "VFLO", "AGRO", "EGRO", "SGRO",
                     "MLEV", "BLEV", "EM", "ABS", "ACF", "GP", "GPM",
                     "IGRO", "CXGRO", "DTOP"]:
            assert name in meta["included"], f"{name}: {meta['excluded'].get(name)}"

    def test_sentiment_excluded_without_data(self, descriptor_result):
        _, meta = descriptor_result
        for name in ["RRIBS", "EPIBSC", "EARNC"]:
            assert name in meta["excluded"]

    def test_lncap(self, descriptor_result):
        vals = _col(descriptor_result, "LNCAP")
        for code, spec in STOCKS.items():
            assert np.isclose(vals[code], np.log(spec["cap"]))

    def test_midcap_matches_lstsq(self, descriptor_result):
        codes = sorted(STOCKS)
        x = np.log(np.array([STOCKS[c]["cap"] for c in codes]))
        X = np.column_stack([np.ones(len(x)), x])
        coef, *_ = np.linalg.lstsq(X, x ** 3, rcond=None)
        expected = x ** 3 - X @ coef
        vals = _col(descriptor_result, "MIDCAP")
        for i, code in enumerate(codes):
            assert np.isclose(vals[code], expected[i])

    def test_hbeta(self, descriptor_result_varying):
        vals = _col(descriptor_result_varying, "HBETA")
        for code, spec in STOCKS.items():
            if spec["noise"]:
                # Noise is only approximately orthogonal under EWMA weights.
                assert abs(vals[code] - spec["beta"]) < 0.15, code
            else:
                assert np.isclose(vals[code], spec["beta"]), code

    def test_halpha(self, descriptor_result_varying):
        vals = _col(descriptor_result_varying, "HALPHA")
        assert np.isclose(vals["sh.600000"], 0.002)
        assert np.isclose(vals["sz.000001"], 0.0)
        assert np.isclose(vals["sz.300750"], 0.0005)
        assert abs(vals["sh.600519"]) < 0.0005

    def test_hsigma(self, descriptor_result_varying):
        vals = _col(descriptor_result_varying, "HSIGMA")
        assert np.isclose(vals["sh.600000"], 0.0)
        assert np.isclose(vals["sz.000001"], 0.0)
        # Non-zero on 2/3 of days at ±0.002 → std ≈ 0.002·sqrt(2/3).
        assert 0.0014 < vals["sh.600519"] < 0.0018
        assert np.isclose(vals["sz.300750"], 0.0)

    def test_dastd(self, descriptor_result):
        vals = _col(descriptor_result, "DASTD")
        assert np.isclose(vals["sz.000001"], 0.0)
        assert 0.0 < vals["sh.600519"] < 0.003

    def test_cmra(self, descriptor_result):
        vals = _col(descriptor_result, "CMRA")
        for code, spec in STOCKS.items():
            if spec["noise"]:
                continue
            expected = 231 * np.log1p(spec["alpha"] + spec["beta"] * B)
            assert np.isclose(vals[code], expected, rtol=1e-9)
        assert np.isfinite(vals["sh.600519"])

    def test_liquidity(self, descriptor_result):
        stom = _col(descriptor_result, "STOM")
        stoq = _col(descriptor_result, "STOQ")
        stoa = _col(descriptor_result, "STOA")
        atvr = _col(descriptor_result, "ATVR")
        for code in STOCKS:
            assert np.isclose(stom[code], np.log(21 * TURNOVER))
            assert np.isclose(stoq[code], np.log(63 * TURNOVER / 3))
            assert np.isclose(stoa[code], np.log(252 * TURNOVER / 12))
            assert np.isclose(atvr[code], TURNOVER)

    def test_strev(self, descriptor_result):
        vals = _col(descriptor_result, "STREV")
        for code in STOCKS:
            expected = _ewma_dot(_stock_returns(code), 21, 5)
            assert np.isclose(vals[code], expected, rtol=1e-9), code

    def test_season(self, descriptor_result):
        vals = _col(descriptor_result, "SEASON")
        for code, spec in STOCKS.items():
            if spec["noise"]:
                continue
            r = spec["alpha"] + spec["beta"] * B
            expected = (1.0 + r) ** 21 - 1.0
            assert np.isclose(vals[code], expected, rtol=1e-9)

    def test_indmom(self, descriptor_result):
        vals = _col(descriptor_result, "INDMOM")
        codes = sorted(STOCKS)
        w = np.sqrt(np.array([STOCKS[c]["cap"] for c in codes]))
        rs = np.array([
            _ewma_dot(np.log1p(_stock_returns(c)), 126, 21) for c in codes
        ])
        rs_ind = (w * rs).sum() / w.sum()
        for i, code in enumerate(codes):
            expected = rs_ind - rs[i] * w[i] / w.sum()
            assert np.isclose(vals[code], expected, rtol=1e-9), code

    def test_rstr(self, descriptor_result):
        vals = _col(descriptor_result, "RSTR")
        for code in STOCKS:
            excess = np.log1p(_stock_returns(code)) - np.log1p(B)
            window_vals = [
                _ewma_dot(excess[: t + 1], 252, 126)
                for t in range(N_DATES - 11, N_DATES)
            ]
            expected = float(np.mean(window_vals))
            assert np.isclose(vals[code], expected, rtol=1e-9), code

    def test_ltrstr_negates_rstr(self, descriptor_result):
        rstr = _col(descriptor_result, "RSTR")
        ltrstr = _col(descriptor_result, "LTRSTR")
        for code in ["sh.600000", "sz.000001", "sz.300750"]:
            assert np.isclose(ltrstr[code], -rstr[code], rtol=1e-9)

    def test_lthalpha(self, descriptor_result_varying):
        vals = _col(descriptor_result_varying, "LTHALPHA")
        assert np.isclose(vals["sh.600000"], -0.002)
        assert np.isclose(vals["sz.000001"], 0.0)

    def test_value_ratios(self, descriptor_result):
        btop = _col(descriptor_result, "BTOP")
        etop = _col(descriptor_result, "ETOP")
        cetop = _col(descriptor_result, "CETOP")
        dtoa = _col(descriptor_result, "DTOA")
        ato = _col(descriptor_result, "ATO")
        roa = _col(descriptor_result, "ROA")
        for code, spec in STOCKS.items():
            cap = spec["cap"]
            assert np.isclose(btop[code], 4.5e9 / cap)  # parent equity
            assert np.isclose(etop[code], 1e9 / cap)
            assert np.isclose(cetop[code], 8e8 / cap)
            assert np.isclose(dtoa[code], 7e9 / 1040e9)  # latest TA
            assert np.isclose(ato[code], 140e9 / 1040e9)
            assert np.isclose(roa[code], 1e9 / 1040e9)

    def test_leverage(self, descriptor_result):
        mlev = _col(descriptor_result, "MLEV")
        blev = _col(descriptor_result, "BLEV")
        for code, spec in STOCKS.items():
            cap = spec["cap"]
            # (ME(t−1) + PE=0 + 非流动负债 3.5e9) / ME(t−1); caps constant in fixture
            assert np.isclose(mlev[code], (cap + 3.5e9) / cap)
            # (BE=5e9 + PE=0 + 3.5e9) / 5e9
            assert np.isclose(blev[code], 1.7)

    def test_em(self, descriptor_result):
        em = _col(descriptor_result, "EM")
        for code, spec in STOCKS.items():
            # 3e9 / (ME + 4e9 + 1e9 - 2e9)
            assert np.isclose(em[code], 3e9 / (spec["cap"] + 3e9))

    def test_profitability(self, descriptor_result):
        gp = _col(descriptor_result, "GP")
        gpm = _col(descriptor_result, "GPM")
        for code in STOCKS:
            # (140e9 - 112e9) / 1040e9; GPM = 20% by construction
            assert np.isclose(gp[code], 28e9 / 1040e9)
            assert np.isclose(gpm[code], 0.2)

    def test_earnings_quality(self, descriptor_result):
        acf = _col(descriptor_result, "ACF")
        abs_ = _col(descriptor_result, "ABS")
        for code in STOCKS:
            # ACF = -(1e9 - (8e8 - 6e9) + 5e9)/1040e9
            assert np.isclose(acf[code], -11.2e9 / 1040e9)
            # ABS: NOA0=1036e9, NOA1=1026e9, DA=5e9 → -(10e9-5e9)/1040e9
            assert np.isclose(abs_[code], -5e9 / 1040e9)

    def test_investment_growth(self, descriptor_result):
        igro = _col(descriptor_result, "IGRO")
        cxgro = _col(descriptor_result, "CXGRO")
        for code in STOCKS:
            # shares 10..14e9 linear: slope 1e9 / mean 12e9
            assert np.isclose(igro[code], 1.0 / 12.0)
            # capex 10..18e9 linear: slope 2e9 / mean 14e9
            assert np.isclose(cxgro[code], 1.0 / 7.0)

    def test_dtop(self, descriptor_result):
        dtop = _col(descriptor_result, "DTOP")
        for code in STOCKS:
            # 0.5 per-share TTM dividends / last close
            assert np.isclose(dtop[code], 0.5 / _final_close(code))

    def test_analyst_sentiment(self, bundle_analyst):
        frame, meta = compute_descriptors(bundle_analyst, END_DATE)
        for name in ["RRIBS", "EPIBSC", "EARNC"]:
            assert name in meta["included"]
        vals = {name: dict(zip(
            frame["code"].to_list(), frame[name].to_list(),
        )) for name in ["RRIBS", "EPIBSC", "EARNC"]}
        # only ±30/±60d events count; the +1 at −120d is outside the window
        assert np.isclose(vals["RRIBS"]["sh.600000"], 0.0)   # +1, −1
        assert np.isclose(vals["RRIBS"]["sz.000001"], 1.0)   # +1, +1
        assert np.isclose(vals["EPIBSC"]["sh.600000"], 0.5)  # 1.0 → 1.5
        assert np.isclose(vals["EPIBSC"]["sz.000001"], 0.0)
        assert np.isclose(vals["EARNC"]["sh.600000"], 0.0)   # +1, −1
        assert np.isclose(vals["EARNC"]["sz.000001"], -1.0)  # −1, −1

    def test_variability(self, descriptor_result):
        vsal = _col(descriptor_result, "VSAL")
        series = np.array([100e9, 110e9, 120e9, 130e9, 140e9])
        expected = series.std(ddof=1) / series.mean()
        for code in STOCKS:
            assert np.isclose(vsal[code], expected)

    def test_growth(self, descriptor_result):
        egro = _col(descriptor_result, "EGRO")
        sgro = _col(descriptor_result, "SGRO")
        agro = _col(descriptor_result, "AGRO")
        eps = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        ta = np.array([1000e9, 1010e9, 1020e9, 1030e9, 1040e9])
        for code in STOCKS:
            assert np.isclose(egro[code], 1.0 / eps.mean())
            # per-share revenue is exactly 10.0 every year → flat → zero
            assert np.isclose(sgro[code], 0.0, atol=1e-12)
            assert np.isclose(agro[code], 10e9 / ta.mean())

    def test_pit_visibility(self, bundle):
        # At mid-2024 the 2024 annual (available 2025-04-30) is not yet
        # visible; the 2023 report drives the ratios.
        frame, meta = compute_descriptors(bundle, "2024-06-30")
        ato = dict(zip(frame["code"].to_list(), frame["ATO"].to_list()))
        assert np.isclose(ato["sz.000001"], 130e9 / 1030e9)
        # Latest full-bundle run sees the 2024 report instead.
        ato_end = _col(
            (compute_descriptors(bundle, END_DATE)), "ATO"
        )
        assert np.isclose(ato_end["sz.000001"], 140e9 / 1040e9)
