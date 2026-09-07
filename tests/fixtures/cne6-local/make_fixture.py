#!/usr/bin/env python3
"""Generate a tiny committed CNE6 artifact for provider contract tests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import polars as pl


def sha256(path: Path) -> str:
  return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("root", type=Path)
  parser.add_argument("--without-available-date", action="store_true")
  parser.add_argument("--partial", action=argparse.BooleanOptionalAction, default=True)
  parser.add_argument("--mixed-price-sources", action="store_true")
  parser.add_argument("--without-units", action="store_true")
  parser.add_argument("--invalid-units", action="store_true")
  args = parser.parse_args()
  reference = args.root / "reference"
  reference.mkdir(parents=True, exist_ok=True)

  frames = {
    "prices": ("price_history.parquet", pl.DataFrame({
      "code": ["sh.600519", "sh.600519", "sz.000001"],
      "date": ["2026-01-02", "2026-01-05", "2026-01-05"],
      "open": [100.0, 101.0, 10.0],
      "high": [102.0, 103.0, 10.5],
      "low": [99.0, 100.0, 9.8],
      "close": [101.0, 102.0, 10.2],
      "preclose": [100.0, 101.0, 10.0],
      "volume": [10.0, 11.0, 20.0],
      "amount": [1000.0, 1100.0, 200.0],
      "turn": [1.0, 1.1, 0.5],
      "daily_return": [0.01, 0.0099, 0.02],
    })),
    "caps": ("market_cap_snapshot.parquet", pl.DataFrame({
      "code": ["sh.600519", "sz.000001"],
      "close": [102.0, 10.2],
      "total_market_cap": [100_000.0, 50_000.0],
    })),
    "fundamentals": ("historical_fundamentals.parquet", pl.DataFrame({
      "code": ["sh.600519", "sh.600519", "sz.000001"],
      "report_date": ["2023-12-31", "2024-12-31", "2024-12-31"],
      **({} if args.without_available_date else {
        "available_date": ["2024-04-01", "2025-04-01", "2025-03-20"],
      }),
      "revenue": [80.0, 100.0, 50.0],
      "net_income": [30.0, 40.0, 20.0],
      "eps": [0.8, 1.0, 0.5],
      "equity": [70.0, 80.0, 45.0],
      "operating_cashflow": [40.0, 50.0, 25.0],
      "total_assets": [180.0, 200.0, 100.0],
      "total_liabilities": [110.0, 120.0, 55.0],
      "long_term_debt": [9.0, 10.0, 5.0],
      "preferred_equity": [None, None, None],
      "cogs": [18.0, 20.0, 10.0],
      "capex": [4.0, 5.0, 2.0],
      "depreciation_amortization": [2.8, 3.0, 1.5],
      "ebit": [35.0, 45.0, 22.0],
      "dividend_per_share": [0.4, 0.5, 0.2],
      "total_shares": [1000.0, 1000.0, 500.0],
      "cash": [25.0, 30.0, 15.0],
      "short_term_debt": [1.5, 2.0, 1.0],
      "investment_cashflow": [-4.0, -5.0, -2.0],
      "non_current_liabilities": [19.0, 20.0, 10.0],
      "parent_equity": [65.0, 75.0, 40.0],
    })),
    "industry": ("sw_industry.parquet", pl.DataFrame({
      "code": ["sh.600519", "sz.000001"],
      "industry": ["食品饮料", "银行"],
    })),
    "benchmark": ("benchmark_sh000300.parquet", pl.DataFrame({
      "date": ["2026-01-02", "2026-01-05", "2026-01-06"],
      "close": [4000.0, 4020.0, 4010.0],
      "daily_return": [0.0, 0.005, -0.0025],
    })),
    "dividends": ("dividends.parquet", pl.DataFrame({
      "code": ["sh.600519"],
      "report_date": ["2024-12-31"],
      "dividend_per_share": [0.5],
      "pay_date": ["2025-06-01"],
    })),
  }

  assets: dict[str, dict[str, object]] = {}
  rows: dict[str, int] = {}
  row_names = {"caps": "marketCap"}
  for name, (filename, frame) in frames.items():
    path = reference / filename
    frame.write_parquet(path)
    assets[name] = {"file": filename, "bytes": path.stat().st_size, "sha256": sha256(path)}
    rows[row_names.get(name, name)] = frame.height

  report = {
    "generatedAt": "2026-01-07T00:00:00Z",
    "rows": rows,
    "symbols": 2,
    "priceStart": "2026-01-02",
    "priceEnd": "2026-01-06",
    "coverage": {"market_cap": 1.0, "industry": 1.0, "fundamentals": 0.5},
    "sources": {
      "prices": ({"eastmoney-qfq": 1, "sina-unadjusted": 1}
                 if args.mixed_price_sources else {"sina-unadjusted": 2}),
      "marketCap": {"fixture": 2},
      "fundamentals": "fixture",
      "industry": "current fixture snapshot",
      "benchmark": "fixture",
      "dividend": "fixture annual proxy",
    },
    "assets": assets,
    "build": {"startDate": "2026-01-01", "endDate": "2026-01-07", "runKey": "fixture"},
    "partial": args.partial,
    "failedSymbols": ["000002"] if args.partial else [],
    "requestedSymbols": ["600519", "000001", "000002"],
  }
  if not args.without_units:
    report["units"] = (
      {"price": "CNY", "volume": "lot", "turnover": "CNY"}
      if args.invalid_units
      else {"price": "CNY", "volume": "share", "turnover": "CNY"}
    )
  (args.root / "quality-report.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
  )


if __name__ == "__main__":
  main()
