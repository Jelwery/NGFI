"""Stable tests for the dev-only AKShare/East Money field adapter."""
from __future__ import annotations

from datetime import date

import pandas as pd

from cne6_engine.data_sources.dev_fundamentals_probe import (
    _FIELDS,
    _combine,
    _find,
    _rows_from,
)


def test_current_east_money_column_names_map_to_contract_fields():
    income = pd.DataFrame([{
        "股票代码": "600519",
        "营业总收入": 174_144_069_958.25,
        "净利润": 86_228_146_421.62,
        "营业总支出-营业支出": 13_789_482_367.98,
        "利润总额": 119_638_578_194.46,
        "营业总支出-财务费用": -1_470_219_863.34,
        "公告日期": date(2025, 4, 3),
    }])
    balance = pd.DataFrame([{
        "股票代码": "600519",
        "资产-货币资金": 59_295_822_956.89,
        "资产-总资产": 298_944_579_918.7,
        "负债-总负债": 56_933_264_798.1,
        "股东权益合计": 242_011_315_120.6,
        "公告日期": date(2025, 4, 3),
    }])
    cashflow = pd.DataFrame([{
        "股票代码": "600519",
        "经营性现金流-现金流量净额": 92_463_692_168.43,
        "投资性现金流-现金流量净额": -1_785_202_630.71,
        "公告日期": date(2025, 4, 3),
    }])

    merged = _combine(
        _rows_from(income, 2024, _FIELDS["income"]),
        _rows_from(balance, 2024, _FIELDS["balance"]),
        _rows_from(cashflow, 2024, _FIELDS["cashflow"]),
    )
    row = merged.row(0, named=True)
    assert row["code"] == "sh.600519"
    assert row["revenue"] == 174_144_069_958.25
    assert row["net_income"] == 86_228_146_421.62
    assert row["operating_cashflow"] == 92_463_692_168.43
    assert row["investment_cashflow"] == -1_785_202_630.71
    assert row["available_date"] == "2025-04-03"


def test_current_dividend_code_column_is_detected():
    assert _find(["代码", "现金分红-现金分红比例"], "股票代码", "代码") == "代码"
