# cne6_engine/tests/test_contracts.py
"""Contract validation tests — synthetic frames only, no real assets."""
import polars as pl
import pytest

from cne6_engine.interfaces.contracts import (
    BenchmarkSeries,
    DataBundle,
    FundamentalHistory,
    IndustryMembership,
    MarketData,
)


def _market_frame() -> pl.DataFrame:
    return pl.DataFrame({
        "code": ["sh.600519", "sz.000001", "sz.000001"],
        "date": ["2026-01-05", "2026-01-05", "2026-01-06"],
        "open": [1700.0, 10.0, 10.5],
        "high": [1750.0, 10.8, 10.6],
        "low": [1690.0, 9.9, 10.2],
        "close": [1720.0, 10.5, 10.4],
        "preclose": [1710.0, 10.0, 10.5],
        "volume": [2e6, 1e6, 0.0],
        "amount": [3.4e9, 1.05e7, 0.0],
        "daily_return": [0.0058, 0.05, None],
        "turnover_rate": [0.002, 0.01, None],
        "float_market_cap": [1.7e12, 1.05e9, 1.05e9],
        "total_market_cap": [2.1e12, 1.05e9, 1.05e9],
    })


def _benchmark_frame() -> pl.DataFrame:
    return pl.DataFrame({
        "date": ["2026-01-05", "2026-01-06"],
        "close": [3900.0, 3910.0],
        "daily_return": [0.01, 0.0026],
    })


def _fundamental_frame() -> pl.DataFrame:
    base = {
        "code": ["sz.000001", "sz.000001"],
        "report_date": ["2024-12-31", "2025-12-31"],
        "available_date": ["2025-04-30", "2026-04-25"],
        "revenue": [1e10, 1.1e10],
        "net_income": [1e9, 1.2e9],
        "eps": [1.0, 1.2],
        "equity": [5e9, 5.5e9],
        "operating_cashflow": [8e8, 9e8],
        "total_assets": [1.2e10, 1.3e10],
        "total_liabilities": [7e9, 7.5e9],
    }
    for col in ["long_term_debt", "preferred_equity", "cogs", "capex",
                "depreciation_amortization", "ebit", "dividend_per_share",
                "total_shares", "cash", "short_term_debt",
                "investment_cashflow", "non_current_liabilities",
                "parent_equity"]:
        base[col] = [None, None]
    frame = pl.DataFrame(base)
    return frame.with_columns([
        pl.col(c).cast(pl.Float64) for c in [
            "long_term_debt", "preferred_equity", "cogs", "capex",
            "depreciation_amortization", "ebit", "dividend_per_share",
            "total_shares", "cash", "short_term_debt",
            "investment_cashflow", "non_current_liabilities",
            "parent_equity",
        ]
    ])


def _industry_frame() -> pl.DataFrame:
    return pl.DataFrame({
        "code": ["sz.000001", "sh.600519"],
        "industry": ["银行", "白酒"],
    })


class TestMarketData:
    def test_valid_frame_passes(self):
        MarketData(frame=_market_frame()).validate()

    def test_missing_column_fails(self):
        frame = _market_frame().drop("amount")
        with pytest.raises(ValueError, match="missing"):
            MarketData(frame=frame).validate()

    def test_extra_column_fails(self):
        frame = _market_frame().with_columns(pl.lit(1).alias("junk"))
        with pytest.raises(ValueError, match="extra"):
            MarketData(frame=frame).validate()

    def test_duplicate_keys_fail(self):
        frame = pl.concat([_market_frame(), _market_frame()])
        with pytest.raises(ValueError, match="duplicate"):
            MarketData(frame=frame).validate()

    def test_unsorted_fails(self):
        frame = _market_frame().sort(["code", "date"], descending=True)
        with pytest.raises(ValueError, match="sorted"):
            MarketData(frame=frame).validate()

    def test_negative_cap_fails(self):
        frame = _market_frame().with_columns(
            pl.when(pl.col("code") == "sz.000001")
            .then(-1.0).otherwise(pl.col("total_market_cap"))
            .alias("total_market_cap"),
        )
        with pytest.raises(ValueError, match="non-positive market caps"):
            MarketData(frame=frame).validate()

    def test_null_return_allowed_on_suspension(self):
        market = MarketData(frame=_market_frame())
        market.validate()
        nulls = market.frame.filter(
            (pl.col("volume") == 0) & pl.col("daily_return").is_null()
        ).height
        assert nulls == 1

    def test_pivot_shape(self):
        market = MarketData(frame=_market_frame())
        pivoted = market.pivot("close")
        assert pivoted.shape == (2, 3)
        assert set(pivoted.columns) >= {"date", "sz.000001", "sh.600519"}

    def test_dates_and_codes(self):
        market = MarketData(frame=_market_frame())
        assert market.dates == ["2026-01-05", "2026-01-06"]
        assert market.codes == ["sh.600519", "sz.000001"]


class TestBenchmarkSeries:
    def test_valid_passes(self):
        bench = BenchmarkSeries(frame=_benchmark_frame())
        bench.validate()
        assert bench.returns["2026-01-05"] == 0.01

    def test_null_return_fails(self):
        frame = _benchmark_frame().with_columns(
            pl.when(pl.col("date") == "2026-01-06")
            .then(None).otherwise(pl.col("daily_return")).alias("daily_return"),
        )
        with pytest.raises(ValueError, match="null returns"):
            BenchmarkSeries(frame=frame).validate()


class TestFundamentalHistory:
    def test_valid_passes(self):
        fundamentals = FundamentalHistory(frame=_fundamental_frame())
        fundamentals.validate()

    def test_lookahead_fails(self):
        frame = _fundamental_frame().with_columns(
            pl.when(pl.col("report_date") == "2025-12-31")
            .then(pl.lit("2025-06-30"))
            .otherwise(pl.col("available_date")).alias("available_date"),
        )
        with pytest.raises(ValueError, match="lookahead"):
            FundamentalHistory(frame=frame).validate()

    def test_null_key_fails(self):
        frame = _fundamental_frame().with_columns(
            pl.when(pl.col("report_date") == "2025-12-31")
            .then(None).otherwise(pl.col("code")).alias("code"),
        )
        with pytest.raises(ValueError, match="null keys"):
            FundamentalHistory(frame=frame).validate()

    def test_asof_annual_only(self):
        fundamentals = FundamentalHistory(frame=_fundamental_frame())
        asof = fundamentals.asof("2026-01-01")
        # 2025 annual not yet available at 2026-01-01
        assert asof["report_date"].to_list() == ["2024-12-31"]
        asof_late = fundamentals.asof("2026-05-01")
        assert asof_late["report_date"].to_list() == ["2025-12-31"]

    def test_asof_carries_values(self):
        fundamentals = FundamentalHistory(frame=_fundamental_frame())
        row = fundamentals.asof("2026-05-01")
        assert row["equity"][0] == 5.5e9


class TestIndustryMembership:
    def test_valid_passes(self):
        industry = IndustryMembership(frame=_industry_frame())
        industry.validate()
        assert industry.mapping()["sz.000001"] == "银行"
        assert industry.industries == ["白酒", "银行"]

    def test_duplicate_code_fails(self):
        frame = pl.concat([_industry_frame(), _industry_frame().head(1)])
        with pytest.raises(ValueError, match="duplicate"):
            IndustryMembership(frame=frame).validate()


class TestDataBundle:
    def _bundle(self, **overrides):
        market = MarketData(frame=overrides.get("market", _market_frame()))
        benchmark = BenchmarkSeries(frame=overrides.get("benchmark", _benchmark_frame()))
        fundamentals = FundamentalHistory(frame=overrides.get("fundamentals", _fundamental_frame()))
        industry = IndustryMembership(frame=overrides.get("industry", _industry_frame()))
        return DataBundle(
            market=market, benchmark=benchmark,
            fundamentals=fundamentals, industry=industry,
        )

    def test_valid_bundle_passes(self):
        self._bundle().validate()

    def test_unmapped_market_code_fails(self):
        market_frame = _market_frame().with_columns(
            pl.when(pl.col("code") == "sh.600519")
            .then(pl.lit("sh.688001")).otherwise(pl.col("code")).alias("code"),
        )
        with pytest.raises(ValueError, match="without industry"):
            self._bundle(market=market_frame).validate()

    def test_provenance_recorded(self):
        bundle = self._bundle()
        bundle = DataBundle(
            market=bundle.market, benchmark=bundle.benchmark,
            fundamentals=bundle.fundamentals, industry=bundle.industry,
            provenance={"adapter": "test"},
        )
        assert bundle.provenance == {"adapter": "test"}
