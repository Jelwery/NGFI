# cne6_engine/tests/test_panel_grid_real.py
"""Grid-based MarketPanel must reproduce the old pivot construction exactly
on full package-owned cached assets (skips until those assets are rebuilt)."""
import numpy as np
import polars as pl
import pytest

from cne6_engine.algorithm.descriptors.price_descriptors import MarketPanel
from cne6_engine.interfaces.sina_adapter import SinaAdapter


def _assets_available() -> bool:
    try:
        SinaAdapter.from_config().load_bundle("2026-07-30")
        return True
    except Exception:
        return False


@pytest.fixture(scope="module")
def bundle():
    return SinaAdapter.from_config().load_bundle("2026-07-30")


def _pivot_reference(frame, dates, codes):
    f = frame.filter(pl.col("date").is_in(dates))
    out = {}
    for col in ["daily_return", "close", "turnover_rate",
                "float_market_cap", "total_market_cap"]:
        p = f.pivot(index="date", on="code", values=col).sort("date")
        cols = sorted(c for c in p.columns if c != "date")
        out[col] = p.select(cols).to_numpy().T.copy()
    return out


@pytest.mark.skipif(not _assets_available(), reason="full package data assets missing")
def test_panel_matches_pivot_reference(bundle):
    panel = MarketPanel.from_bundle(bundle, "2026-07-30")
    frame = bundle.market.frame.filter(pl.col("date") <= "2026-07-30")
    dates = frame["date"].unique().sort().to_list()[-1400:]
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
