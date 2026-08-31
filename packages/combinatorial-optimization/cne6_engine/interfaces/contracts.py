# cne6_engine/interfaces/contracts.py
"""Layer 2 standard data contracts.

These schemas are the stable interface between data adapters (layer 2) and the
algorithm layer (layer 3).  They are defined by what the 46 CNE6 descriptor
variables need — not by what any particular data source happens to provide.

Design rules:
- All frames are long-format Polars DataFrames with strict schemas.
- Fields a source may not provide are nullable; availability is decided by the
  registry (algorithm layer), never by injecting sentinel zeros.
- Every contract carries ``validate()``; adapters must deliver valid frames.
- Provenance metadata records approximations so downstream users know what a
  source actually provided.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

import polars as pl

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

MARKET_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8,
    "date": pl.Utf8,          # YYYY-MM-DD
    "open": pl.Float64,
    "high": pl.Float64,
    "low": pl.Float64,
    "close": pl.Float64,
    "preclose": pl.Float64,
    "volume": pl.Float64,     # shares traded
    "amount": pl.Float64,     # CNY traded value
    "daily_return": pl.Float64,   # NaN on suspension days
    "turnover_rate": pl.Float64,  # nullable; daily fraction (0.02 = 2%)
    "float_market_cap": pl.Float64,  # nullable; CNY
    "total_market_cap": pl.Float64,  # nullable; CNY
}

BENCHMARK_SCHEMA: dict[str, pl.DataType] = {
    "date": pl.Utf8,
    "close": pl.Float64,
    "daily_return": pl.Float64,
}

FUNDAMENTAL_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8,
    "report_date": pl.Utf8,       # fiscal period end
    "available_date": pl.Utf8,    # point-in-time: when the market could see it
    "revenue": pl.Float64,             # nullable beyond this line
    "net_income": pl.Float64,
    "eps": pl.Float64,
    "equity": pl.Float64,             # book value of shareholders' equity
    "operating_cashflow": pl.Float64,
    "total_assets": pl.Float64,
    "total_liabilities": pl.Float64,
    "long_term_debt": pl.Float64,
    "preferred_equity": pl.Float64,
    "cogs": pl.Float64,
    "capex": pl.Float64,
    "depreciation_amortization": pl.Float64,
    "ebit": pl.Float64,
    "dividend_per_share": pl.Float64,
    "total_shares": pl.Float64,
    "cash": pl.Float64,                   # monetary assets
    "short_term_debt": pl.Float64,
    "investment_cashflow": pl.Float64,    # net CFI (negative = outflow)
    "non_current_liabilities": pl.Float64,  # 非流动负债合计
    "parent_equity": pl.Float64,            # 归母股东权益
}

ANALYST_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8,
    "date": pl.Utf8,                      # action/snapshot date, YYYY-MM-DD
    "analyst_rating_change": pl.Float64,          # +1 / −1 / 0 per event day
    "analyst_eps_forecast_change": pl.Float64,    # consensus EPS level (CNY)
    "analyst_earnings_revision": pl.Float64,      # +1 / −1 per revision day
}

INDUSTRY_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8,
    "industry": pl.Utf8,
}

# Required (non-null after load) fundamental fields; the rest are optional
# and their absence simply deactivates dependent descriptors.
_FUNDAMENTAL_REQUIRED = {"code", "report_date", "available_date"}


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _check_schema(frame: pl.DataFrame, schema: dict[str, pl.DataType], name: str) -> None:
    actual = dict(frame.schema)
    if actual != schema:
        missing = set(schema) - set(actual)
        extra = set(actual) - set(schema)
        wrong = {
            c for c in set(schema) & set(actual)
            if actual[c] != schema[c]
        }
        raise ValueError(
            f"{name}: schema mismatch. missing={sorted(missing)} "
            f"extra={sorted(extra)} wrong_type={sorted(wrong)}"
        )


def _check_keys_not_null(frame: pl.DataFrame, keys: list[str], name: str) -> None:
    nulls = frame.select(
        [pl.col(c).is_null().sum().alias(c) for c in keys]
    ).row(0)
    if any(nulls):
        pairs = [f"{c}={n}" for c, n in zip(keys, nulls) if n]
        raise ValueError(f"{name}: null keys ({', '.join(pairs)})")


def _check_unique(frame: pl.DataFrame, keys: list[str], name: str) -> None:
    n = len(frame)
    n_unique = frame.select(pl.struct(keys).n_unique()).item()
    if n_unique != n:
        raise ValueError(f"{name}: duplicate keys {keys} ({n} rows, {n_unique} unique)")


def _check_sorted(frame: pl.DataFrame, keys: list[str], name: str) -> None:
    if len(frame) > 1:
        head = frame.select(keys).head(1).row(0)
        tail = frame.select(keys).tail(1).row(0)
        if head > tail:
            raise ValueError(f"{name}: frames must be sorted ascending by {keys}")


# ---------------------------------------------------------------------------
# Contracts
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MarketData:
    """Daily market data panel for the whole stock universe."""

    frame: pl.DataFrame

    def validate(self) -> None:
        _check_schema(self.frame, MARKET_SCHEMA, "MarketData")
        if self.frame.is_empty():
            return
        _check_keys_not_null(self.frame, ["code", "date"], "MarketData")
        _check_unique(self.frame, ["code", "date"], "MarketData")
        _check_sorted(self.frame, ["code", "date"], "MarketData")
        bad_ret = self.frame.filter(
            pl.col("daily_return").is_not_null()
            & (pl.col("daily_return") < -0.99)
        ).height
        if bad_ret:
            raise ValueError(f"MarketData: {bad_ret} returns below -0.99")
        bad_cap = self.frame.filter(
            (pl.col("total_market_cap").is_not_null()
             & (pl.col("total_market_cap") <= 0))
            | (pl.col("float_market_cap").is_not_null()
               & (pl.col("float_market_cap") <= 0))
        ).height
        if bad_cap:
            raise ValueError(f"MarketData: {bad_cap} non-positive market caps")
        bad_price = self.frame.filter(
            (pl.col("close") <= 0) | (pl.col("preclose") <= 0)
        ).height
        if bad_price:
            raise ValueError(f"MarketData: {bad_price} non-positive prices")

    @property
    def dates(self) -> list[str]:
        return self.frame["date"].unique().sort().to_list()

    @property
    def codes(self) -> list[str]:
        return self.frame["code"].unique().sort().to_list()

    def pivot(self, column: str) -> pl.DataFrame:
        """Pivot one field to a (date x code) matrix frame."""
        return self.frame.pivot(index="date", on="code", values=column).sort("date")


@dataclass(frozen=True)
class BenchmarkSeries:
    """Daily benchmark index series (e.g. CSI 300)."""

    frame: pl.DataFrame

    def validate(self) -> None:
        _check_schema(self.frame, BENCHMARK_SCHEMA, "BenchmarkSeries")
        if self.frame.is_empty():
            return
        _check_keys_not_null(self.frame, ["date"], "BenchmarkSeries")
        _check_unique(self.frame, ["date"], "BenchmarkSeries")
        _check_sorted(self.frame, ["date"], "BenchmarkSeries")
        null_ret = self.frame.filter(pl.col("daily_return").is_null()).height
        if null_ret:
            raise ValueError(f"BenchmarkSeries: {null_ret} null returns")

    @property
    def returns(self) -> dict[str, float]:
        return dict(zip(
            self.frame["date"].to_list(),
            self.frame["daily_return"].to_list(),
        ))


@dataclass(frozen=True)
class FundamentalHistory:
    """Point-in-time fundamental history keyed by report period."""

    frame: pl.DataFrame

    def validate(self) -> None:
        _check_schema(self.frame, FUNDAMENTAL_SCHEMA, "FundamentalHistory")
        if self.frame.is_empty():
            return
        null_required = self.frame.select(
            [pl.col(c).is_null().sum().alias(c) for c in _FUNDAMENTAL_REQUIRED]
        ).row(0)
        if any(null_required):
            pairs = list(zip(_FUNDAMENTAL_REQUIRED, null_required))
            raise ValueError(
                f"FundamentalHistory: null keys {pairs}"
            )
        _check_unique(self.frame, ["code", "report_date"], "FundamentalHistory")
        _check_sorted(self.frame, ["code", "report_date"], "FundamentalHistory")
        bad_avail = self.frame.filter(
            pl.col("available_date") < pl.col("report_date")
        ).height
        if bad_avail:
            raise ValueError(
                f"FundamentalHistory: {bad_avail} rows with available_date "
                "before report_date (lookahead)"
            )

    def asof(self, date: str, *, annual_only: bool = True) -> pl.DataFrame:
        """Latest report observable at ``date`` per code (PIT-safe)."""
        visible = self.frame.filter(pl.col("available_date") <= date)
        if annual_only:
            visible = visible.filter(
                pl.col("report_date").str.slice(5, 5) == "12-31"
            )
        return visible.group_by("code").agg(
            pl.all().sort_by("report_date").last()
        )


@dataclass(frozen=True)
class AnalystData:
    """Analyst-rating / consensus-EPS event history (Sentiment descriptors).

    One row per (code, date): the net rating action, the consensus EPS level
    snapshot, and the net revision event for that day.
    """

    frame: pl.DataFrame

    def validate(self) -> None:
        _check_schema(self.frame, ANALYST_SCHEMA, "AnalystData")
        if self.frame.is_empty():
            return
        _check_keys_not_null(self.frame, ["code", "date"], "AnalystData")
        _check_unique(self.frame, ["code", "date"], "AnalystData")
        _check_sorted(self.frame, ["code", "date"], "AnalystData")


@dataclass(frozen=True)
class IndustryMembership:
    """Stock-to-industry mapping (current snapshot classification)."""

    frame: pl.DataFrame

    def validate(self) -> None:
        _check_schema(self.frame, INDUSTRY_SCHEMA, "IndustryMembership")
        if self.frame.is_empty():
            return
        _check_keys_not_null(self.frame, ["code"], "IndustryMembership")
        _check_unique(self.frame, ["code"], "IndustryMembership")
        null_ind = self.frame.filter(pl.col("industry").is_null()).height
        if null_ind:
            raise ValueError(f"IndustryMembership: {null_ind} null industries")

    @property
    def industries(self) -> list[str]:
        return self.frame["industry"].unique().sort().to_list()

    def mapping(self) -> dict[str, str]:
        return dict(zip(
            self.frame["code"].to_list(),
            self.frame["industry"].to_list(),
        ))


@dataclass(frozen=True)
class DataBundle:
    """Everything the algorithm layer needs, from any adapter."""

    market: MarketData
    benchmark: BenchmarkSeries
    fundamentals: FundamentalHistory
    industry: IndustryMembership
    analyst: Optional[AnalystData] = None
    provenance: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        self.market.validate()
        self.benchmark.validate()
        self.fundamentals.validate()
        self.industry.validate()
        if self.analyst is not None:
            self.analyst.validate()
        market_codes = set(self.market.codes)
        industry_codes = set(self.industry.frame["code"].to_list())
        missing = market_codes - industry_codes
        if missing:
            raise ValueError(
                f"DataBundle: {len(missing)} market codes without industry "
                f"mapping (e.g. {sorted(missing)[:5]})"
            )
