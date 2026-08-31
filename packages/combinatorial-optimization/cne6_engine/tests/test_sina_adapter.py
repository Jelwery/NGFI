# cne6_engine/tests/test_sina_adapter.py
"""SinaAdapter tests against synthetic package-style assets on disk."""
from pathlib import Path
import polars as pl

from cne6_engine.interfaces.sina_adapter import SinaAdapter

DATES = [f"2026-01-{d:02d}" for d in range(5, 17)]  # 10 trading days


def test_default_config_uses_package_owned_assets():
    adapter = SinaAdapter.from_config()
    package_root = Path(__file__).resolve().parents[2]
    assert Path(adapter.price_path).is_relative_to(package_root)
    assert "CNE5" not in Path(adapter.price_path).parts


def _write_assets(tmp_path):
    root = tmp_path

    # Price history: 3 stocks; one suspended day; one short-history stock.
    rows = []
    for code, start in [("sz.000001", 10.0), ("sh.600519", 100.0), ("sz.300750", 50.0)]:
        price = start
        for i, d in enumerate(DATES):
            prev = price
            price = price * (1.0 + 0.01 * ((i % 3) - 1))
            suspended = code == "sh.600519" and i == 4
            rows.append({
                "code": code, "date": d,
                "open": prev, "high": price * 1.02, "low": prev * 0.98,
                "close": price, "preclose": prev,
                "volume": 0.0 if suspended else 1e6,
                "amount": 0.0 if suspended else price * 1e6,
                "turn": None,
                "daily_return": None if suspended else price / prev - 1.0,
            })
    # Short-history stock (fails min_listed_days=5).
    for i, d in enumerate(DATES[:3]):
        rows.append({
            "code": "bj.430047", "date": d,
            "open": 5.0, "high": 5.2, "low": 4.9, "close": 5.1,
            "preclose": 5.0, "volume": 1e5, "amount": 5.1e5,
            "turn": None, "daily_return": 0.02,
        })
    pl.DataFrame(rows).write_parquet(root / "price.parquet")

    # Market cap snapshot: close 10/100/50, caps imply shares.
    pl.DataFrame({
        "code": ["sz.000001", "sh.600519", "sz.300750", "bj.430047"],
        "close": [10.0, 100.0, 50.0, 5.0],
        "total_market_cap": [1e9, 2e10, 5e10, 5e8],
    }).write_parquet(root / "cap_snapshot.parquet")

    # Fundamentals: annual, PIT-safe available dates.
    fund_rows = {
        "code": ["sz.000001", "sz.000001", "sh.600519"],
        "report_date": ["2024-12-31", "2025-12-31", "2024-12-31"],
        "available_date": ["2025-04-30", "2026-04-25", "2025-04-02"],
        "year": [2024, 2025, 2024],
        "revenue": [1e10, 1.1e10, 5e10],
        "net_income": [1e9, 1.2e9, 2e10],
        "eps": [1.0, 1.2, 16.0],
        "equity": [5e9, 5.5e9, 8e10],
        "operating_cashflow": [8e8, 9e8, 1.5e10],
        "total_assets": [1.2e10, 1.3e10, 1e11],
        "total_liabilities": [7e9, 7.5e9, 2e10],
        "long_term_debt": [None, None, None],
    }
    pl.DataFrame(fund_rows).write_parquet(root / "fundamentals.parquet")

    # Industry: covers the two long-history stocks only.
    pl.DataFrame({
        "code": ["sz.000001", "sh.600519", "bj.430047"],
        "industry": ["银行", "白酒", "计算机"],
    }).write_parquet(root / "industry.parquet")

    # Benchmark cache covering end_date.
    bench_rows = {
        "date": DATES,
        "close": [3900.0 + 10 * i for i in range(len(DATES))],
        "daily_return": [0.01] * len(DATES),
    }
    pl.DataFrame(bench_rows).write_parquet(root / "benchmark.parquet")

    return root


def _adapter(root, min_listed_days=5):
    return SinaAdapter(
        price_path=str(root / "price.parquet"),
        cap_snapshot_path=str(root / "cap_snapshot.parquet"),
        fundamentals_path=str(root / "fundamentals.parquet"),
        industry_path=str(root / "industry.parquet"),
        benchmark_cache_path=str(root / "benchmark.parquet"),
        min_listed_days=min_listed_days,
        benchmark_fetcher=lambda *a, **k: pl.read_parquet(str(root / "benchmark.parquet")),
    )


def test_bundle_validates(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    bundle.validate()


def test_universe_filtered(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    codes = set(bundle.market.codes)
    # Short-history bj.430047 dropped by min_listed_days.
    assert codes == {"sz.000001", "sh.600519"}


def test_end_date_truncates(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-10")
    assert max(bundle.market.dates) == "2026-01-10"
    assert max(bundle.benchmark.frame["date"].to_list()) == "2026-01-10"


def test_suspension_return_is_null(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    suspended = bundle.market.frame.filter(
        (pl.col("code") == "sh.600519") & (pl.col("date") == "2026-01-09")
    )
    assert suspended.height == 1
    assert suspended["daily_return"][0] is None


def test_turnover_approximation(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    row = bundle.market.frame.filter(
        (pl.col("code") == "sz.000001") & (pl.col("date") == DATES[0])
    )
    cap = row["total_market_cap"][0]
    assert row["turnover_rate"][0] == row["amount"][0] / cap
    # caps derived from snapshot shares: 1e9 / 10 = 1e8 shares
    assert cap == row["close"][0] * 1e8


def test_native_turnover_takes_precedence(tmp_path):
    root = _write_assets(tmp_path)
    price = pl.read_parquet(root / "price.parquet").with_columns(
        pl.when(
            (pl.col("code") == "sz.000001") & (pl.col("date") == DATES[0])
        ).then(0.123).otherwise(pl.col("turn")).alias("turn")
    )
    price.write_parquet(root / "price.parquet")

    bundle = _adapter(root).load_bundle("2026-01-16")
    row = bundle.market.frame.filter(
        (pl.col("code") == "sz.000001") & (pl.col("date") == DATES[0])
    )

    assert row["turnover_rate"][0] == 0.123


def test_suspended_day_turnover_zero(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    row = bundle.market.frame.filter(
        (pl.col("code") == "sh.600519") & (pl.col("date") == "2026-01-09")
    )
    # amount=0 on suspension → true zero turnover, not null
    assert row["turnover_rate"][0] == 0.0


def test_fundamentals_asof_pit(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    asof = bundle.fundamentals.asof("2026-01-16")
    # 2025 annual (available 2026-04-25) not yet visible.
    assert asof["report_date"].to_list() == ["2024-12-31", "2024-12-31"]


def test_lookahead_rows_dropped(tmp_path):
    root = _write_assets(tmp_path)
    bad = pl.read_parquet(root / "fundamentals.parquet")
    bad = pl.concat([bad, pl.DataFrame({
        "code": ["sz.300750"], "report_date": ["2025-12-31"],
        "available_date": ["2025-01-01"], "year": [2025],
        "revenue": [1.0], "net_income": [1.0], "eps": [1.0],
        "equity": [1.0], "operating_cashflow": [1.0],
        "total_assets": [1.0], "total_liabilities": [1.0],
        "long_term_debt": [None],
    })]).sort(["code", "report_date"])
    bad.write_parquet(root / "fundamentals.parquet")
    bundle = _adapter(root).load_bundle("2026-01-16")
    codes = bundle.fundamentals.frame["code"].unique().to_list()
    assert "sz.300750" not in codes


def test_provenance_documents_approximations(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    assert bundle.provenance["adapter"] == "sina"
    assert "turnover_rate" in bundle.provenance
    assert "fundamental_available_date" in bundle.provenance


def test_industry_mapping(tmp_path):
    root = _write_assets(tmp_path)
    bundle = _adapter(root).load_bundle("2026-01-16")
    mapping = bundle.industry.mapping()
    assert mapping["sh.600519"] == "白酒"
    assert set(bundle.industry.industries) == {"银行", "白酒", "计算机"}
