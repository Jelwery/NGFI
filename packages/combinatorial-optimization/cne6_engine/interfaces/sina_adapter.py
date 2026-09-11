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

import hashlib
import json
import os
from pathlib import Path
from typing import Callable, Optional

import polars as pl

from cne6_engine.data_sources.akshare_index import load_benchmark_cached
from cne6_engine.data_sources.publication import (
    resolve_published_root,
    verify_snapshot_manifest,
)
from cne6_engine.interfaces.contracts import (
    BenchmarkSeries,
    DataBundle,
    DataQuality,
    QualityRecord,
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
        immutable_snapshot: bool = False,
        snapshot_root: Optional[str] = None,
        snapshot_id: Optional[str] = None,
        snapshot_files: tuple[str, ...] = (),
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
        self._immutable_snapshot = immutable_snapshot
        self._snapshot_root = snapshot_root
        self._snapshot_id = snapshot_id
        self._snapshot_files = snapshot_files
        self._field_quality: dict[str, QualityRecord] = {}
        self._universe: dict = {}
        self._fundamental_exclusions = 0

    @property
    def cache_identity(self) -> Optional[str]:
        """Immutable publication identity used to namespace derived caches."""
        return self._snapshot_id

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

        configured_paths = {
            "price_path": Path(asset_root, assets["price_file"]),
            "cap_snapshot_path": Path(asset_root, assets["cap_snapshot_file"]),
            "fundamentals_path": Path(asset_root, assets["fundamentals_file"]),
            "industry_path": Path(asset_root, assets["industry_file"]),
            "benchmark_cache_path": Path(project_root, benchmark["cache_file"]),
        }
        reference_parents = {path.parent for path in configured_paths.values()}
        immutable_snapshot = False
        selected_snapshot_root: Optional[Path] = None
        selected_snapshot_id: Optional[str] = None
        snapshot_files: tuple[str, ...] = ()
        if len(reference_parents) == 1:
            legacy_reference = next(iter(reference_parents))
            if legacy_reference.name == "reference":
                try:
                    legacy_reference.parent.lstat()
                except FileNotFoundError:
                    # A clean checkout intentionally has no ignored market-data
                    # directory. Construction remains deterministic; load_bundle
                    # will fail closed when it actually attempts to read assets.
                    pass
                else:
                    selected_root, snapshot_id = resolve_published_root(
                        legacy_reference.parent,
                    )
                    if snapshot_id is not None:
                        snapshot_files = tuple(
                            sorted(path.name for path in configured_paths.values())
                        )
                        verify_snapshot_manifest(
                            selected_root, snapshot_id, required_files=snapshot_files,
                        )
                        pinned_reference = selected_root / "reference"
                        configured_paths = {
                            name: pinned_reference / path.name
                            for name, path in configured_paths.items()
                        }
                        immutable_snapshot = True
                        selected_snapshot_root = selected_root
                        selected_snapshot_id = snapshot_id

        return cls(
            **{name: str(path) for name, path in configured_paths.items()},
            benchmark_symbol=benchmark["symbol"],
            benchmark_start=benchmark["start_date"],
            min_listed_days=universe.get("min_listed_days", 252),
            immutable_snapshot=immutable_snapshot,
            snapshot_root=(str(selected_snapshot_root)
                           if selected_snapshot_root is not None else None),
            snapshot_id=selected_snapshot_id,
            snapshot_files=snapshot_files,
        )

    # ------------------------------------------------------------------
    # Bundle assembly
    # ------------------------------------------------------------------

    def load_bundle(self, end_date: str) -> DataBundle:
        self._verify_snapshot_integrity()
        self._field_quality = {}
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
            quality=self._quality(market, fundamentals, industry, benchmark),
            provenance={
                "universe": self._universe,
                "fundamental_exclusions": self._fundamental_exclusions,
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
        self._verify_snapshot_integrity()
        return bundle

    def _quality(self, market, fundamentals, industry, benchmark) -> DataQuality:
        """Checksum verification is integrity, not independent provider verification."""
        def record(frame, name, flag="unverified", reasons=("provider_not_verified",), pit=None):
            col = frame[name]
            count = int(col.is_finite().fill_null(False).sum()) if col.dtype.is_numeric() else int(col.is_not_null().sum())
            return QualityRecord(flag if count else "missing", count / len(frame) if len(frame) else 0.0,
                                 count, len(frame), reasons, pit)

        for name, dtype in MARKET_SCHEMA.items():
            if dtype == pl.Float64 and name not in self._field_quality:
                self._field_quality[name] = record(market.frame, name)
        for name, dtype in FUNDAMENTAL_SCHEMA.items():
            if dtype == pl.Float64:
                self._field_quality[name] = record(fundamentals.frame, name)
        for name, reasons in {
            "ebit": ("ebit_profit_total_plus_finance_expense",),
            "depreciation_amortization": ("depreciation_amortization_may_have_missing_components",),
            "dividend_per_share": ("annual_dividend_not_ttm_or_event_pit",),
        }.items():
            self._field_quality[name] = record(fundamentals.frame, name, "proxy", reasons, False if name == "dividend_per_share" else None)
        self._field_quality["available_date"] = record(
            fundamentals.frame, "available_date", "proxy",
            ("announcement_date_may_be_next_year_may_1", "announcement_date_origin_not_preserved"), False,
        )
        self._field_quality["industry"] = record(
            industry.frame, "industry", "proxy", ("current_industry_not_point_in_time",), False,
        )
        self._field_quality["benchmark_return"] = record(benchmark.frame, "daily_return")
        for name in ("analyst_rating_change", "analyst_eps_forecast_change", "analyst_earnings_revision"):
            self._field_quality[name] = QualityRecord("missing", 0.0, 0, len(market.codes), ("analyst_source_absent",), None)
        config = {"adapter_version": 2, "min_listed_days": self.min_listed_days,
                  "benchmark_symbol": self.benchmark_symbol, "benchmark_start": self.benchmark_start}
        # Legacy mutable assets have no publication ID: fingerprint content, not paths.
        digest = hashlib.sha256()
        if self._snapshot_id:
            digest.update(self._snapshot_id.encode())
        else:
            for path in (self.price_path, self.cap_snapshot_path, self.fundamentals_path,
                         self.industry_path, self.benchmark_cache_path):
                if Path(path).is_file():
                    with open(path, "rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            digest.update(chunk)
        return DataQuality(
            quality_flag="proxy", provider="sina_akshare_cached", provider_verified=False,
            coverage=(len(market.codes) / self._universe["count"] if self._universe["count"] else 0.0),
            point_in_time=False, source_version=digest.hexdigest(),
            config_version=hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
            reasons=("provider_not_verified", "historical_cap_from_current_snapshot", "current_industry_not_point_in_time"),
            field_records=dict(self._field_quality),
        )

    def _verify_snapshot_integrity(self) -> None:
        if self._snapshot_root is None or self._snapshot_id is None:
            return
        verify_snapshot_manifest(
            Path(self._snapshot_root), self._snapshot_id,
            required_files=self._snapshot_files,
        )

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
        original_codes = sorted(price["code"].unique().to_list())
        price = self._filter_min_listed(price)
        listed_codes = set(price["code"].unique().to_list())
        industry_codes = industry.frame.select("code")
        price = price.join(industry_codes, on="code", how="semi")
        kept_codes = set(price["code"].unique().to_list())
        self._universe = {
            "codes": original_codes, "count": len(original_codes),
            "exclusions": {
                **{code: "insufficient_listing_history" for code in original_codes if code not in listed_codes},
                **{code: "missing_industry" for code in listed_codes - kept_codes},
            },
        }

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
        for name, reasons in {
            "total_market_cap": ("historical_shares_from_current_cap_divided_by_current_price",),
            "float_market_cap": ("historical_shares_from_current_cap_divided_by_current_price", "float_cap_equals_total_cap"),
            "amount": ("traded_amount_origin_not_verified",),
            "turnover_rate": ("native_turnover_or_amount_divided_by_proxy_cap",),
        }.items():
            count = int(market[name].is_finite().fill_null(False).sum())
            self._field_quality[name] = QualityRecord(
                "proxy" if count else "missing", count / len(market) if len(market) else 0.0,
                count, len(market), reasons, False if "cap" in name or name == "turnover_rate" else None,
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
        self._fundamental_exclusions = bad.height
        if bad.height:
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
        if self._immutable_snapshot:
            frame = pl.read_parquet(self.benchmark_cache_path)
        elif self._benchmark_fetcher is not None:
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
