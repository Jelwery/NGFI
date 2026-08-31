from __future__ import annotations

from datetime import date
from pathlib import Path

import polars as pl
import pytest

from cne6_engine.data_sources import rebuild
from cne6_engine.data_sources.cli import build_parser
from cne6_engine.interfaces.contracts import (
    BENCHMARK_SCHEMA,
    FUNDAMENTAL_SCHEMA,
    INDUSTRY_SCHEMA,
)


def _price(code: str = "sh.600519") -> pl.DataFrame:
    return pl.DataFrame(
        [{
            "code": code, "date": "2026-08-03",
            "open": 100.0, "high": 102.0, "low": 99.0,
            "close": 101.0, "preclose": 100.0,
            "volume": 1000.0, "amount": 101000.0,
            "turn": 0.01, "daily_return": 0.01,
        }],
        schema=rebuild.PRICE_ASSET_SCHEMA, orient="row",
    )


def _fundamental(code: str = "sh.600519") -> pl.DataFrame:
    values = {name: None for name in FUNDAMENTAL_SCHEMA}
    values.update({
        "code": code, "report_date": "2024-12-31",
        "available_date": "2025-03-31", "revenue": 1.0,
    })
    return pl.DataFrame([values], schema=FUNDAMENTAL_SCHEMA, orient="row")


def _benchmark() -> pl.DataFrame:
    return pl.DataFrame(
        [{"date": "2026-08-03", "close": 4000.0,
          "daily_return": 0.01}],
        schema=BENCHMARK_SCHEMA, orient="row",
    )


def _industry(code: str = "sh.600519") -> pl.DataFrame:
    return pl.DataFrame(
        [{"code": code, "industry": "食品饮料"}],
        schema=INDUSTRY_SCHEMA, orient="row",
    )


def _caps(code: str = "sh.600519") -> pl.DataFrame:
    return pl.DataFrame(
        [{"code": code, "close": 101.0,
          "total_market_cap": 2.0e12}],
        schema=rebuild.CAP_SNAPSHOT_SCHEMA, orient="row",
    )


def _dividends(code: str = "sh.600519") -> pl.DataFrame:
    return pl.DataFrame(
        [{"code": code, "report_date": "2024-12-31",
          "dividend_per_share": 2.0, "pay_date": "2025-06-27"}],
        schema=rebuild.DIVIDEND_SCHEMA, orient="row",
    )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("600519", "sh.600519"), ("sz000001", "sz.000001"),
     ("bj920000", "bj.920000")],
)
def test_symbol_normalization_preserves_a_share_exchange(raw: str, expected: str) -> None:
    assert rebuild.prefixed_symbol(raw) == expected


def _write_asset_set(root: Path, *, malformed_prices: bool = False) -> None:
    reference = root / "reference"
    reference.mkdir(parents=True)
    price = _price()
    if malformed_prices:
        price = price.drop("turn")
    price.write_parquet(reference / "price_history.parquet")
    _caps().write_parquet(reference / "market_cap_snapshot.parquet")
    _fundamental().write_parquet(reference / "historical_fundamentals.parquet")
    _industry().write_parquet(reference / "sw_industry.parquet")
    _benchmark().write_parquet(reference / "benchmark_sh000300.parquet")
    _dividends().write_parquet(reference / "dividends.parquet")


def test_retry_call_uses_backoff_and_eventually_succeeds() -> None:
    calls = 0
    sleeps: list[float] = []

    def flaky() -> str:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ConnectionError("temporary disconnect")
        return "ok"

    result = rebuild.retry_call(
        "flaky", flaky, attempts=4, base_delay=2, max_delay=10,
        sleep=sleeps.append, rand=lambda: 0.5,
    )

    assert result == "ok"
    assert calls == 3
    assert sleeps == [2.0, 4.0]


def test_price_checkpoints_resume_and_are_scoped_by_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, str]] = []

    def fake_fetch(
        symbol: str, start_date: str, end_date: str, **_kwargs,
    ) -> pl.DataFrame:
        calls.append((symbol, start_date, end_date))
        return _price(rebuild.prefixed_symbol(symbol))

    monkeypatch.setattr(rebuild, "fetch_one_price", fake_fetch)
    kwargs = dict(
        symbols=["600519"], start_date="2026-08-01",
        end_date="2026-08-10", staging=tmp_path, workers=1,
        attempts=1, timeout=1.0, request_delay=0.0,
    )
    first, failures, _ = rebuild.fetch_prices_resumable(**kwargs)
    second, _, _ = rebuild.fetch_prices_resumable(**kwargs)
    rebuild.fetch_prices_resumable(**{**kwargs, "end_date": "2026-08-11"})

    assert failures == []
    assert first.equals(second)
    assert calls == [
        ("600519", "2026-08-01", "2026-08-10"),
        ("600519", "2026-08-01", "2026-08-11"),
    ]


def test_validate_assets_fails_closed_on_schema_change(tmp_path: Path) -> None:
    _write_asset_set(tmp_path, malformed_prices=True)

    with pytest.raises(ValueError, match="prices schema mismatch"):
        rebuild.validate_assets(tmp_path)


def test_rebuild_stages_validates_and_publishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rebuild, "fetch_market_snapshot",
        lambda **_kwargs: (_caps(), {"eastmoney-live-quote": 1}),
    )
    monkeypatch.setattr(
        rebuild, "fetch_prices_resumable",
        lambda *_args, **_kwargs: (_price(), [], {"eastmoney-qfq": 1}),
    )
    monkeypatch.setattr(
        rebuild, "fetch_industry_membership", lambda *_args, **_kwargs: _industry(),
    )
    monkeypatch.setattr(
        rebuild, "fetch_benchmark", lambda *_args, **_kwargs: _benchmark(),
    )
    monkeypatch.setattr(
        rebuild, "fetch_fundamentals",
        lambda *_args, **_kwargs: (_fundamental(), _dividends()),
    )

    report = rebuild.rebuild_all(rebuild.RebuildOptions(
        data_root=tmp_path, start_date="2026-08-01",
        end_date="2026-08-10", years=[2024], symbols=["600519"],
        attempts=1, request_delay=0,
    ))

    assert report["symbols"] == 1
    assert report["partial"] is False
    assert report["coverage"] == {
        "market_cap": 1.0, "industry": 1.0, "fundamentals": 1.0,
    }
    assert (tmp_path / "quality-report.json").exists()
    assert all(
        (tmp_path / "reference" / name).exists()
        for name in rebuild._PUBLISHED_FILES
    )


def test_rebuild_does_not_publish_when_staged_validation_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rebuild, "fetch_market_snapshot",
        lambda **_kwargs: (_caps(), {"eastmoney-live-quote": 1}),
    )
    monkeypatch.setattr(
        rebuild, "fetch_prices_resumable",
        lambda *_args, **_kwargs: (_price(), [], {"eastmoney-qfq": 1}),
    )
    monkeypatch.setattr(
        rebuild, "fetch_industry_membership",
        lambda *_args, **_kwargs: pl.DataFrame(schema=INDUSTRY_SCHEMA),
    )
    monkeypatch.setattr(
        rebuild, "fetch_benchmark", lambda *_args, **_kwargs: _benchmark(),
    )
    monkeypatch.setattr(
        rebuild, "fetch_fundamentals",
        lambda *_args, **_kwargs: (_fundamental(), _dividends()),
    )

    with pytest.raises(ValueError, match="published assets must be non-empty"):
        rebuild.rebuild_all(rebuild.RebuildOptions(
            data_root=tmp_path, start_date="2026-08-01",
            end_date="2026-08-10", years=[2024], symbols=["600519"],
            attempts=1, request_delay=0,
        ))

    assert not (tmp_path / "reference").exists()


def test_publish_rolls_back_if_a_replace_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    old_root = tmp_path / "old"
    staged_root = tmp_path / "staged"
    _write_asset_set(old_root)
    _write_asset_set(staged_root)
    staged_reference = staged_root / "reference"
    reference = old_root / "reference"
    staged_price = _price().with_columns(pl.lit(202.0).alias("close"))
    staged_price.write_parquet(staged_reference / "price_history.parquet")
    original_write = rebuild.atomic_write_parquet
    failed = False

    def fail_once(frame: pl.DataFrame, path: Path) -> None:
        nonlocal failed
        if path == reference / "market_cap_snapshot.parquet" and not failed:
            failed = True
            raise OSError("simulated disk failure")
        original_write(frame, path)

    monkeypatch.setattr(rebuild, "atomic_write_parquet", fail_once)

    with pytest.raises(OSError, match="simulated"):
        rebuild._publish_staged(staged_reference, reference)

    assert pl.read_parquet(reference / "price_history.parquet")["close"][0] == 101.0


def test_cli_smoke_defaults_are_isolated_and_serial() -> None:
    args = build_parser(date(2026, 8, 30)).parse_args(["smoke"])

    assert args.workers == 1
    assert args.request_delay == 1.0
    assert args.data_root.name == "smoke"
    assert args.symbols == ["600519", "000001"]


def test_full_market_sina_snapshot_is_page_checkpointed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[int] = []
    monkeypatch.setattr(rebuild, "_request_sina_market_count", lambda _timeout: 81)

    def page(page: int, _timeout: float):
        calls.append(page)
        code = "600519" if page == 1 else "000001"
        return [{"代码": code, "最新价": 100.0, "总市值": 1e10}]

    monkeypatch.setattr(rebuild, "_request_sina_market_page", page)
    limiter = rebuild.RequestLimiter(0)
    first = rebuild.fetch_sina_market_snapshot_resumable(
        tmp_path, attempts=1, timeout=1, limiter=limiter,
    )
    second = rebuild.fetch_sina_market_snapshot_resumable(
        tmp_path, attempts=1, timeout=1, limiter=limiter,
    )

    assert first.height == 2
    assert first.equals(second)
    assert calls == [1, 2]
