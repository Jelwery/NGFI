#!/usr/bin/env python3
"""Deterministic protocol fixture for provider contract tests."""

import json
import sys

request = json.load(sys.stdin)
if request.get("version") != "1" or request.get("operation") != "security-reference":
  json.dump({
      "version": "1",
      "ok": False,
      "error": {"kind": "fixture-error", "message": "unsupported fixture call", "retryable": False},
  }, sys.stdout)
  raise SystemExit(1)

ticker = request["params"]["ticker"]
available = lambda value: {"status": "available", "value": value}
missing = {"status": "missing", "value": None}
json.dump({
    "version": "1",
    "ok": True,
    "data": {
        "ticker": ticker,
        "observation": {
            "provider": "yfinance",
            "source": f"https://finance.yahoo.com/quote/{ticker}",
            "retrievedAt": "2026-08-30T00:00:00Z",
            "observedAt": "2026-08-29T20:00:00Z",
            "periodType": "spot",
            "currency": "USD",
            "unit": "raw",
        },
        "fields": {
            "name": available("Fixture Corp"),
            "exchange": available("NASDAQ"),
            "country": available("United States"),
            "sector": missing,
            "industry": missing,
            "quoteCurrency": available("USD"),
            "currentPrice": available(123.45),
            "sharesOutstanding": missing,
            "marketCap": missing,
            "beta": missing,
            "fiftyTwoWeekLow": missing,
            "fiftyTwoWeekHigh": missing,
        },
    },
}, sys.stdout, allow_nan=False)
