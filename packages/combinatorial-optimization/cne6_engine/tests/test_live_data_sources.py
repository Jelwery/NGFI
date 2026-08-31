"""Opt-in checks against the upstreams documented by the CNE6 handoff."""
from __future__ import annotations

import asyncio
import os

import pytest

if os.environ.get("CNE6_LIVE") != "1":
    pytest.skip("set CNE6_LIVE=1 to access real data sources", allow_module_level=True)

pytestmark = pytest.mark.live


def test_real_sina_kline_for_maotai():
    from cne6_engine.data_sources.sina_kline import fetch_sina_kline_direct

    frame = asyncio.run(fetch_sina_kline_direct("sh.600519"))
    assert frame.height > 1_000
    assert frame["code"].unique().to_list() == ["sh.600519"]
    assert frame["close"][-1] > 0


def test_real_csi300_benchmark_via_akshare_sina():
    from cne6_engine.data_sources.akshare_index import fetch_index_daily

    frame = fetch_index_daily("sh000300", "2026-08-01")
    assert frame.height >= 10
    assert frame["close"][-1] > 0
    assert frame["daily_return"].null_count() == 0


def test_real_annual_fundamentals_and_dividend_via_akshare_east_money():
    from cne6_engine.data_sources.dev_fundamentals_probe import fetch_year

    fundamentals, dividends = fetch_year(2024, {"600519"})
    assert fundamentals.height == 1
    row = fundamentals.row(0, named=True)
    assert row["code"] == "sh.600519"
    assert row["revenue"] is not None and row["revenue"] > 0
    assert row["net_income"] is not None and row["net_income"] > 0
    assert row["total_assets"] is not None and row["total_assets"] > 0
    assert row["operating_cashflow"] is not None
    assert row["available_date"] >= row["report_date"]
    assert dividends.height >= 1
    assert dividends["dividend_per_share"][0] > 0
