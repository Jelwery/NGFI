# cne6_engine/tests/test_analyst_descriptors.py
"""Sentiment descriptor tests — synthetic AnalystData, hand-computed."""
import numpy as np
import polars as pl

from cne6_engine.algorithm.descriptors.analyst_descriptors import (
    compute_analyst_descriptors,
)
from cne6_engine.interfaces.contracts import ANALYST_SCHEMA, AnalystData

DATE = "2026-07-30"   # window: (2026-05-01, 2026-07-30]
CODES = ["sz.000001", "sh.600519", "sh.688001"]


def _frame() -> pl.DataFrame:
    rows = [
        # outside the window (2026-04-20 must not count)
        ("sz.000001", "2026-04-20", 1.0, 0.5, -1.0),
        ("sz.000001", "2026-06-01", 1.0, 1.0, 1.0),
        ("sz.000001", "2026-07-01", -1.0, 1.25, -1.0),
        ("sh.600519", "2026-06-05", 1.0, 2.0, -1.0),
        ("sh.600519", "2026-07-10", 1.0, 1.8, -1.0),
        # single EPS snapshot in window: EPIBSC = 0; no rating events.
        ("sh.688001", "2026-06-01", None, 3.0, None),
    ]
    return pl.DataFrame(
        rows,
        schema=list(ANALYST_SCHEMA),
        orient="row",
    ).sort(["code", "date"])


def test_validate_passes():
    AnalystData(frame=_frame()).validate()


def test_no_data_returns_empty():
    assert compute_analyst_descriptors(None, DATE, CODES) == {}


def test_empty_window_all_nan():
    frame = pl.DataFrame(
        [("sz.000001", "2025-06-01", 1.0, 1.0, 1.0)],
        schema=list(ANALYST_SCHEMA),
        orient="row",
    )
    out = compute_analyst_descriptors(
        AnalystData(frame=frame), DATE, CODES,
    )
    assert set(out) == {"RRIBS", "EPIBSC", "EARNC"}
    for name in out:
        assert out[name].shape == (len(CODES),)
        assert np.isnan(out[name]).all()


def test_hand_computed_events():
    out = compute_analyst_descriptors(
        AnalystData(frame=_frame()), DATE, CODES,
    )
    idx = {c: i for i, c in enumerate(CODES)}
    # RRIBS: (up − down)/(up + down) over the 90d window only.
    assert np.isclose(out["RRIBS"][idx["sz.000001"]], 0.0)
    assert np.isclose(out["RRIBS"][idx["sh.600519"]], 1.0)
    assert np.isnan(out["RRIBS"][idx["sh.688001"]])
    # EPIBSC: (last − first)/|first| of consensus-EPS level snapshots.
    assert np.isclose(out["EPIBSC"][idx["sz.000001"]], 0.25)
    assert np.isclose(out["EPIBSC"][idx["sh.600519"]], -0.1)
    assert np.isclose(out["EPIBSC"][idx["sh.688001"]], 0.0)
    # EARNC: same spread over revision events.
    assert np.isclose(out["EARNC"][idx["sz.000001"]], 0.0)
    assert np.isclose(out["EARNC"][idx["sh.600519"]], -1.0)
