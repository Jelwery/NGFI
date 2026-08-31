# cne6_engine/interfaces/sina_adapter.py
"""Layer 2: Sina/AKShare assets → standard contracts.

Builds a DataBundle from package-owned cached assets (Sina price history,
market-cap snapshot, AKShare fundamentals/industry) plus a real benchmark
index series. Approximations required by this source are recorded in
``DataBundle.provenance`` so the algorithm layer and downstream users know
exactly what they are consuming.

Known source limitations (v1):
- East Money K-lines carry native turnover; Sina fallback rows use
  amount / float_market_cap. Float cap is approximated by total cap.
- Rebuilt annual fundamentals use the source announcement date when present
  and a conservative next-year May 1 fallback when it is absent.
- Industry is the current SW-2021 L1 snapshot (no point-in-time history).
"""
from __future__ import annotations

import os
from typing import Callable, Optional

import polars as pl

from cne6_engine.data_sources.akshare_index import load_benchmark_cached
from cne6_engine.interfaces.contracts import (
    BenchmarkSeries,
    DataBundle,
    FundamentalHistory,
    IndustryMembership,
    MarketData,
    MARKET_SCHEMA,
    FUNDAMENTAL_SCHEMA,
)

_DEFAULT_CONFIG = "config.yaml"

# Extended fundamental fields this source cannot provide; their absence
# simply deactivates the dependent descriptors in the registry.
class SinaAdapter:
    """Assemble a validated DataBundle from package-owned cached assets."""

    def __init__(
        self,
        *,
        price_path: str,
        cap_snapshot_path: str,
        fundamentals_path: str,
        industry_path: str,
        benchmark_cache_path: str,
        benchmark_symbol: str = "000300",
        benchmark_start: str = "20150101",
        min_listed_days: int = 252,
        benchmark_fetcher: Optional[Callable[..., pl.DataFrame]] = None,
    ) -> None:
        self.price_path = price_path
        self.cap_snapshot_path = cap_snapshot_path
        self.fundamentals_path = fundamentals_path
        self.industry_path = industry_path
        self.benchmark_cache_path = benchmark_cache_path
        self.benchmark_symbol = benchmark_symbol
        self.benchmark_start = benchmark_start
        self.min_listed_days = min_listed_days
        self._benchmark_fetcher = benchmark_fetcher

    # ------------------------------------------------------------------
    # Config-based construction
    # ------------------------------------------------------------------

    @classmethod
    def from_config(cls, config_path: Optional[str] = None) -> "SinaAdapter":
        import yaml

        if config_path is None:
            config_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", _DEFAULT_CONFIG
            )
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)

        pkg_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        project_root = os.path.normpath(os.path.join(pkg_root, ".."))
        assets = config["assets"]
        asset_root = os.path.normpath(
            os.path.join(project_root, assets.get("root", "."))
        )
        benchmark = config["benchmark"]
        universe = config.get("universe", {})

        return cls(
            price_path=os.path.join(asset_root, assets["price_file"]),
            cap_snapshot_path=os.path.join(asset_root, assets["cap_snapshot_file"]),
            fundamentals_path=os.path.join(asset_root, assets["fundamentals_file"]),
            industry_path=os.path.join(asset_root, assets["industry_file"]),
            benchmark_cache_path=os.path.join(
                project_root, benchmark["cache_file"]
            ),
            benchmark_symbol=benchmark["symbol"],
            benchmark_start=benchmark["start_date"],
            min_listed_days=universe.get("min_listed_days", 252),
        )

    # ------------------------------------------------------------------
    # Bundle assembly
    # ------------------------------------------------------------------

    def load_bundle(self, end_date: str) -> DataBundle:
        industry = self._load_industry()
        market = self._load_market(end_date, industry)
        fundamentals = self._load_fundamentals()
        benchmark = self._load_benchmark(end_date)

        bundle = DataBundle(
            market=market,
            benchmark=benchmark,
            fundamentals=fundamentals,
            industry=industry,
            analyst=None,
            provenance={
                "adapter": "sina",
                "end_date": end_date,
                "turnover_rate": "native East Money daily rate when present; "
                                     "otherwise amount/float_market_cap proxy",
                "fundamental_available_date":
                    "source announcement date; next-year May 1 fallback if absent",
                "industry": "SW-2021 L1 current snapshot, not point-in-time",
                "benchmark": f"CSI {self.benchmark_symbol} daily (East Money)",
                "leverage_ibd": "IBD≈long_term_debt+short_term_debt; "
                                "preferred_equity≈0 (A-share rare)",
                "earnings_quality": "ABS/ACF use LYR annual values "
                                    "(Barra MRQ); EBIT≈利润总额+财务费用",
                "analyst": "contract defined (ANALYST_SCHEMA); no Layer-1 fetcher",
            },
        )
        bundle.validate()
        return bundle

    # ------------------------------------------------------------------
    # Market panel
    # ------------------------------------------------------------------

    def _load_market(
        self, end_date: str, industry: IndustryMembership,
    ) -> MarketData:
        price = pl.read_parquet(self.price_path)
        if price.is_empty():
            raise RuntimeError(f"price asset empty: {self.price_path}")

        price = price.filter(pl.col("date") <= end_date)
        price = self._filter_min_listed(price)

        industry_codes = industry.frame.select("code")
        price = price.join(industry_codes, on="code", how="semi")

        snapshot = pl.read_parquet(self.cap_snapshot_path).filter(
            (pl.col("close") > 0) & (pl.col("total_market_cap") > 0)
        ).with_columns(
            (pl.col("total_market_cap") / pl.col("close")).alias("_shares")
        ).select("code", "_shares")

        market = (
            price.join(snapshot, on="code", how="left")
            .with_columns(
                (pl.col("close") * pl.col("_shares")).alias("_cap"),
            )
            .with_columns(
                pl.when(pl.col("volume") > 0)
                .then(pl.col("close") / pl.col("preclose") - 1.0)
                .otherwise(None)
                .alias("daily_return"),
                pl.col("_cap").alias("float_market_cap"),
                pl.col("_cap").alias("total_market_cap"),
                pl.when(pl.col("turn").is_not_null())
                .then(pl.col("turn"))
                .when(pl.col("_cap").is_not_null() & (pl.col("_cap") > 0))
                .then(pl.col("amount") / pl.col("_cap")).otherwise(None)
                .alias("turnover_rate"),
            )
            .select(list(MARKET_SCHEMA))
            .sort(["code", "date"])
        )
        return MarketData(frame=market)

    def _filter_min_listed(self, price: pl.DataFrame) -> pl.DataFrame:
        counts = price.group_by("code").agg(pl.len().alias("n_obs"))
        valid = counts.filter(pl.col("n_obs") >= self.min_listed_days).select("code")
        return price.join(valid, on="code", how="semi")

    # ------------------------------------------------------------------
    # Fundamentals
    # ------------------------------------------------------------------

    def _load_fundamentals(self) -> FundamentalHistory:
        raw = pl.read_parquet(self.fundamentals_path)
        if raw.is_empty():
            raise RuntimeError(f"fundamentals asset empty: {self.fundamentals_path}")

        missing = [name for name in FUNDAMENTAL_SCHEMA if name not in raw.columns]
        raw = raw.with_columns([
            pl.lit(None).cast(FUNDAMENTAL_SCHEMA[name]).alias(name)
            for name in missing
        ])
        numeric = [
            name for name, dtype in FUNDAMENTAL_SCHEMA.items()
            if dtype == pl.Float64
        ]
        raw = raw.with_columns([pl.col(name).cast(pl.Float64) for name in numeric])
        raw = raw.with_columns([
            pl.when(pl.col(c).is_finite()).then(pl.col(c)).otherwise(None)
            for c in numeric
        ])
        # Drop rows violating the no-look-ahead invariant rather than crash.
        bad = raw.filter(pl.col("available_date") < pl.col("report_date"))
        if bad.height:
            print(f"  dropping {bad.height} fundamental rows with "
                  "available_date < report_date")
            raw = raw.filter(pl.col("available_date") >= pl.col("report_date"))

        frame = raw.select(list(FUNDAMENTAL_SCHEMA)).sort(["code", "report_date"])
        return FundamentalHistory(frame=frame)

    # ------------------------------------------------------------------
    # Industry
    # ------------------------------------------------------------------

    def _load_industry(self) -> IndustryMembership:
        frame = pl.read_parquet(self.industry_path)
        if frame.is_empty():
            raise RuntimeError(f"industry asset empty: {self.industry_path}")
        return IndustryMembership(frame=frame.sort("code"))

    # ------------------------------------------------------------------
    # Benchmark
    # ------------------------------------------------------------------

    def _load_benchmark(self, end_date: str) -> BenchmarkSeries:
        if self._benchmark_fetcher is not None:
            frame = self._benchmark_fetcher(
                self.benchmark_cache_path, self.benchmark_symbol,
                self.benchmark_start, end_date,
            )
        else:
            frame = load_benchmark_cached(
                self.benchmark_cache_path, self.benchmark_symbol,
                self.benchmark_start, end_date,
            )
        frame = frame.filter(pl.col("date") <= end_date).sort("date")
        return BenchmarkSeries(frame=frame)
