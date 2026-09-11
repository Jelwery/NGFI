from datetime import date
import json

import pytest

from cne6_engine.data_sources.sample import calendar_check, daily_index, digest, load_artifact, normalize_day


def test_calendar_check_rejects_missing_or_duplicate_days():
    rows = [{"exchange": "SSE", "cal_date": "20260909", "is_open": 1},
            {"exchange": "SSE", "cal_date": "20260910", "is_open": 1}]
    assert calendar_check(rows, "SSE", date(2026, 9, 9), date(2026, 9, 10)) == ["20260909", "20260910"]
    for invalid in (rows[:1], rows + rows[:1], [{**row, "exchange": "BSE"} for row in rows], [{**row, "is_open": None} for row in rows]):
        with pytest.raises(ValueError, match="calendar"):
            calendar_check(invalid, "SSE", date(2026, 9, 9), date(2026, 9, 10))


@pytest.mark.parametrize("change", ["identity", "date", "duplicate"])
def test_daily_index_rejects_invalid_keys(change):
    row = {"ts_code": "600000.SH", "trade_date": "20260909"}
    assert daily_index([row], "600000.SH", "daily") == {"20260909": row}
    invalid = [{**row, "ts_code": "000001.SZ"}] if change == "identity" else [{**row, "trade_date": "20260230"}] if change == "date" else [row, row]
    with pytest.raises(ValueError, match="wrong security, invalid date or duplicate"):
        daily_index(invalid, "600000.SH", "daily")


def normalized(bar=None, suspension=None, names=None, calendar="source-reported"):
    return normalize_day("600000.SH", "20260909", bar,
                         {"total_share": 10, "float_share": 8, "total_mv": 100, "circ_mv": 80, "turnover_rate": 1},
                         {"adj_factor": 2}, {"up_limit": 11, "down_limit": 9}, suspension or [], names or [],
                         "2026-09-10T00:00:00Z", calendar)


def test_normalize_day_preserves_units_and_unknown_availability():
    row = normalized({"open": 10, "high": 11, "low": 9, "close": 10.5, "pre_close": 10, "vol": 20, "amount": 21})
    assert row["volume_shares"] == 2000
    assert row["amount_cny"] == 21000
    assert row["total_shares"] == 100000 and row["float_shares"] == 80000
    assert row["turnover_rate"] == .01
    assert row["source_available_at"] is None and row["quality_flag"] == "unverified"
    assert row["adjustment"] == "none"


@pytest.mark.parametrize("scenario", ["missing", "suspended", "intraday", "conflict"])
def test_normalize_day_distinguishes_statuses(scenario):
    suspension = [] if scenario == "missing" else [{"suspend_type": "S", "suspend_timing": "09:30-10:30" if scenario == "intraday" else None}]
    bar = {"open": 10, "high": 11, "low": 9, "close": 10, "vol": 100, "amount": 100} if scenario == "conflict" else None
    row = normalized(bar, suspension)
    expected = {"missing": "missing-unexplained", "suspended": "source-suspended", "intraday": "missing-unexplained", "conflict": "conflict"}[scenario]
    assert row["trading_status"] == expected
    if scenario != "conflict":
        assert row["close"] is None
    else:
        assert "trade-versus-full-suspension-conflict" in row["reasons"]


def test_normalize_day_name_and_calendar_uncertainty_remains_visible():
    names = [{"name": "*ST样本", "start_date": "20260901", "end_date": None, "ann_date": None}]
    row = normalized(names=names, calendar="provider-convention-proxy")
    assert row["st_from_name"] is True
    assert "name-availability-unverified" in row["reasons"]
    assert "BSE-calendar-shared-by-provider-convention" in row["reasons"]
    assert normalized(names=names + names)["st_from_name"] is None


def test_load_artifact_checks_hash_and_preserves_raw_values(tmp_path):
    request = {"tool": "daily", "arguments": {"ts_code": "600000.SH", "trade_date": "20260909"}}
    rows = [{"ts_code": "600000.SH", "trade_date": "20260909", "close": 1e-7}]
    value = {"request": request, "raw": rows, "rows": rows, "rawHash": digest(rows), "contractHash": "a" * 64}
    value["artifactHash"] = digest(value)
    directory = tmp_path / "requests"
    directory.mkdir()
    path = directory / f"{digest(request)}.json"
    path.write_text(json.dumps(value))
    assert load_artifact(tmp_path, request, "a" * 64)["rows"] == rows
    value["rows"] = []
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="integrity"):
        load_artifact(tmp_path, request, "a" * 64)
