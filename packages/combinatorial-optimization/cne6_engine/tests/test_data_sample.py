from datetime import date
import json

import pytest

from cne6_engine.data_sources.sample import (
    _pit_industry_lookup,
    calendar_check,
    daily_index,
    digest,
    load_artifact,
    normalize_day,
    risk_model_probe,
)


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


def _industry(code, name, in_date, out_date=None):
    return {"security_id": code, "industry_name": name, "in_date": in_date, "out_date": out_date}


def test_pit_industry_lookup_resolves_by_effective_interval():
    rows = [_industry("000004.SZ", "房地产", "19891223", "20081230"),
            _industry("000004.SZ", "医药生物", "20081231", "20210610"),
            _industry("000004.SZ", "计算机", "20210611", None)]
    lookup = _pit_industry_lookup(rows)
    assert lookup("000004.SZ", "20200101") == "医药生物"
    assert lookup("000004.SZ", "20260101") == "计算机"
    assert lookup("000004.SZ", "19700101") is None  # before first membership
    assert lookup("999999.SZ", "20260101") is None  # unknown code


def test_pit_industry_lookup_treats_overlap_as_missing():
    rows = [_industry("000010.SZ", "综合", "20070702", "20150630"),
            _industry("000010.SZ", "建筑装饰", "20150101", None)]  # overlapping interval
    lookup = _pit_industry_lookup(rows)
    # 2015-03-01 falls in both intervals; ambiguous PIT class resolves to None,
    # never silently backfilling one of them.
    assert lookup("000010.SZ", "20150301") is None
    # unambiguous dates still resolve
    assert lookup("000010.SZ", "20100101") == "综合"


def _panel_row(code, date, status):
    return {"security_id": code, "date": date, "trading_status": status}


def test_risk_model_probe_flags_rank_deficient_sample():
    # Two industries, three tradable stocks on one day -> K far exceeds N for a
    # country+industry+8-style model, so the CNE6 cross-section is infeasible.
    rows = [_panel_row("A", "2016-01-04", "observed-traded"),
            _panel_row("B", "2016-01-04", "observed-traded"),
            _panel_row("C", "2016-01-04", "observed-traded"),
            _panel_row("D", "2015-06-01", "observed-traded")]  # before evaluation start, ignored
    industry = [_industry("A", "银行", "20100101"), _industry("B", "白酒", "20100101"),
                _industry("C", "银行", "20100101")]
    result = risk_model_probe(rows, industry, "2016-01-01", date(2016, 1, 4))
    assert result["status"] == "blocked"
    assert result["observedTradedDays"] == 1  # pre-window day excluded
    assert result["maxCrossSectionSize"] == 3
    assert result["feasibleFullRankDays"]["no_analyst_sentiment"] == 0
    assert result["maxRankMarginByStyleSet"]["no_analyst_sentiment"] < 0


def test_risk_model_probe_passes_only_when_every_day_full_rank():
    # A wide cross-section on the single evaluation day: N greatly exceeds K.
    rows = [_panel_row(f"S{i}", "2016-01-04", "observed-traded") for i in range(40)]
    industry = [_industry(f"S{i}", "银行" if i % 2 else "白酒", "20100101") for i in range(40)]
    result = risk_model_probe(rows, industry, "2016-01-01", date(2016, 1, 4))
    assert result["status"] == "pass"
    assert result["feasibleFullRankDays"]["no_analyst_sentiment"] == result["observedTradedDays"] == 1


def test_risk_model_probe_ignores_non_traded_and_empty_window():
    rows = [_panel_row("A", "2016-01-04", "source-suspended"),
            _panel_row("B", "2016-01-04", "conflict")]
    industry = [_industry("A", "银行", "20100101"), _industry("B", "白酒", "20100101")]
    result = risk_model_probe(rows, industry, "2016-01-01", date(2016, 1, 4))
    assert result["observedTradedDays"] == 0
    assert result["maxCrossSectionSize"] == 0
    assert result["status"] == "blocked"  # no feasible days when there are no traded days
