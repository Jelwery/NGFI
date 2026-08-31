#!/usr/bin/env python3
"""Versioned stdin/stdout adapter around yfinance. stdout is protocol JSON only."""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from typing import Any, Callable

import yfinance as yf

VERSION = "1"
PROVIDER = "yfinance"


def now_iso() -> str:
  return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def scalar(value: Any) -> Any:
  if value is None:
    return None
  if hasattr(value, "item"):
    try:
      value = value.item()
    except (ValueError, TypeError):
      pass
  if isinstance(value, float) and not math.isfinite(value):
    return None
  if isinstance(value, (str, bool, int, float)):
    return value
  if hasattr(value, "isoformat"):
    return value.isoformat()
  return None


def field(value: Any, *, status: str = "missing", note: str | None = None) -> dict[str, Any]:
  value = scalar(value)
  if value is not None:
    out = {"status": "available", "value": value}
    if note:
      out["note"] = note
    return out
  out: dict[str, Any] = {"status": status, "value": None}
  if note:
    out["note"] = note
  return out


def metadata(
    ticker: str,
    *,
    period_type: str,
    currency: str | None = None,
    observed_at: str | None = None,
    reported_at: str | None = None,
    fiscal_period: str | None = None,
) -> dict[str, Any]:
  out = {
      "provider": PROVIDER,
      "source": f"https://finance.yahoo.com/quote/{ticker}",
      "retrievedAt": now_iso(),
      "periodType": period_type,
  }
  optional = {
      "currency": currency,
      "observedAt": observed_at,
      "reportedAt": reported_at,
      "fiscalPeriod": fiscal_period,
      "unit": "raw",
  }
  out.update({key: value for key, value in optional.items() if value is not None})
  return out


def epoch_iso(value: Any) -> str | None:
  value = scalar(value)
  if not isinstance(value, (int, float)):
    return None
  try:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
  except (OverflowError, OSError, ValueError):
    return None


def info_for(ticker: str) -> dict[str, Any]:
  info = yf.Ticker(ticker).info
  if not isinstance(info, dict) or not info:
    raise ValueError(f"no data for ticker {ticker!r}")
  return info


def security_reference(params: dict[str, Any]) -> dict[str, Any]:
  ticker = str(params["ticker"]).upper()
  info = info_for(ticker)
  price = info.get("currentPrice", info.get("regularMarketPrice"))
  observed_at = epoch_iso(info.get("regularMarketTime"))
  return {
      "ticker": ticker,
      "observation": metadata(
          ticker,
          period_type="spot",
          currency=scalar(info.get("currency")),
          observed_at=observed_at,
      ),
      "fields": {
          "name": field(info.get("longName", info.get("shortName"))),
          "exchange": field(info.get("fullExchangeName", info.get("exchange"))),
          "country": field(info.get("country")),
          "sector": field(info.get("sector")),
          "industry": field(info.get("industry")),
          "quoteCurrency": field(info.get("currency")),
          "currentPrice": field(price),
          "sharesOutstanding": field(info.get("sharesOutstanding")),
          "marketCap": field(info.get("marketCap")),
          "beta": field(info.get("beta")),
          "fiftyTwoWeekLow": field(info.get("fiftyTwoWeekLow")),
          "fiftyTwoWeekHigh": field(info.get("fiftyTwoWeekHigh")),
      },
  }


TTM_FIELDS = {
    "revenue": "totalRevenue",
    "operatingIncome": "operatingIncome",
    "netIncome": "netIncomeToCommon",
    "ebitda": "ebitda",
    "operatingCashFlow": "operatingCashflow",
    "capitalExpenditure": "capitalExpenditures",
    "freeCashFlow": "freeCashflow",
    "cash": "totalCash",
    "debt": "totalDebt",
    "grossMargin": "grossMargins",
    "operatingMargin": "operatingMargins",
    "netMargin": "profitMargins",
    "revenueGrowth": "revenueGrowth",
    "earningsGrowth": "earningsGrowth",
    "returnOnEquity": "returnOnEquity",
    "trailingEps": "trailingEps",
    "forwardEps": "forwardEps",
}

STATEMENT_ROWS = {
    "revenue": ("Total Revenue",),
    "operatingIncome": ("Operating Income",),
    "netIncome": ("Net Income", "Net Income Common Stockholders"),
    "ebitda": ("EBITDA", "Normalized EBITDA"),
    "operatingCashFlow": ("Operating Cash Flow", "Total Cash From Operating Activities"),
    "capitalExpenditure": ("Capital Expenditure", "Capital Expenditures"),
    "freeCashFlow": ("Free Cash Flow",),
    "cash": ("Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"),
    "debt": ("Total Debt",),
}


def row_value(frames: list[Any], names: tuple[str, ...], column: Any) -> Any:
  for frame in frames:
    if frame is None or getattr(frame, "empty", True) or column not in frame.columns:
      continue
    for name in names:
      if name in frame.index:
        return scalar(frame.loc[name, column])
  return None


def statement_periods(
    ticker: str,
    frames: list[Any],
    period_type: str,
    currency: str | None,
) -> list[dict[str, Any]]:
  columns: list[Any] = []
  for frame in frames:
    if frame is not None and not getattr(frame, "empty", True):
      for column in frame.columns:
        if column not in columns:
          columns.append(column)
  columns.sort(reverse=True)
  periods = []
  for column in columns[:8]:
    period = column.date().isoformat() if hasattr(column, "date") else str(column)
    fields = {
        key: field(row_value(frames, names, column))
        for key, names in STATEMENT_ROWS.items()
    }
    periods.append({
        "observation": metadata(
            ticker,
            period_type=period_type,
            currency=currency,
            reported_at=period,
            fiscal_period=period,
        ),
        "fields": fields,
    })
  return periods


def fundamentals(params: dict[str, Any]) -> dict[str, Any]:
  ticker = str(params["ticker"]).upper()
  security = yf.Ticker(ticker)
  info = security.info
  if not isinstance(info, dict) or not info:
    raise ValueError(f"no fundamentals for ticker {ticker!r}")
  currency = scalar(info.get("financialCurrency", info.get("currency")))
  annual_frames = [security.income_stmt, security.cashflow, security.balance_sheet]
  quarterly_frames = [
      security.quarterly_income_stmt,
      security.quarterly_cashflow,
      security.quarterly_balance_sheet,
  ]
  return {
      "ticker": ticker,
      "ttm": {
          "observation": metadata(ticker, period_type="ttm", currency=currency),
          "fields": {key: field(info.get(source)) for key, source in TTM_FIELDS.items()},
      },
      "annual": statement_periods(ticker, annual_frames, "annual", currency),
      "quarterly": statement_periods(ticker, quarterly_frames, "quarterly", currency),
  }


def market_data(params: dict[str, Any]) -> dict[str, Any]:
  ticker = str(params["ticker"]).upper()
  period = str(params.get("period", "6mo"))
  interval = str(params.get("interval", "1d"))
  security = yf.Ticker(ticker)
  history = security.history(period=period, interval=interval, auto_adjust=False)
  if history is None or history.empty:
    raise ValueError(f"no market data for ticker {ticker!r}")
  bars = []
  for index, row in history.iterrows():
    bars.append({
        "observedAt": index.isoformat(),
        "open": scalar(row.get("Open")),
        "high": scalar(row.get("High")),
        "low": scalar(row.get("Low")),
        "close": scalar(row.get("Close")),
        "adjustedClose": scalar(row.get("Adj Close")),
        "volume": scalar(row.get("Volume")),
    })
  closes = [bar["adjustedClose"] or bar["close"] for bar in bars]
  closes = [value for value in closes if isinstance(value, (int, float))]
  total_return = closes[-1] / closes[0] - 1 if len(closes) >= 2 and closes[0] != 0 else None
  sma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else None
  info = security.info or {}
  return {
      "ticker": ticker,
      "observation": metadata(
          ticker,
          period_type="spot",
          currency=scalar(info.get("currency")),
          observed_at=bars[-1]["observedAt"],
      ),
      "interval": interval,
      "bars": bars,
      "derived": {
          "latestClose": field(closes[-1] if closes else None),
          "totalReturn": field(total_return),
          "simpleMovingAverage20": field(sma20),
      },
  }


def estimates(params: dict[str, Any]) -> dict[str, Any]:
  ticker = str(params["ticker"]).upper()
  security = yf.Ticker(ticker)
  info = security.info
  if not isinstance(info, dict) or not info:
    raise ValueError(f"no estimates for ticker {ticker!r}")

  def estimate_value(frame: Any, period: str, column: str) -> Any:
    try:
      if frame is None or getattr(frame, "empty", True) or period not in frame.index:
        return None
      return frame.loc[period, column] if column in frame.columns else None
    except (KeyError, TypeError, ValueError):
      return None

  try:
    revenue_estimate = security.revenue_estimate
  except Exception:
    revenue_estimate = None
  try:
    earnings_estimate = security.earnings_estimate
  except Exception:
    earnings_estimate = None
  try:
    price_targets = security.analyst_price_targets
    if not isinstance(price_targets, dict):
      price_targets = {}
  except Exception:
    price_targets = {}

  forward_revenue = estimate_value(revenue_estimate, "0y", "avg")
  forward_eps = estimate_value(earnings_estimate, "0y", "avg")
  analyst_counts = [
      estimate_value(revenue_estimate, "0y", "numberOfAnalysts"),
      estimate_value(earnings_estimate, "0y", "numberOfAnalysts"),
      info.get("numberOfAnalystOpinions"),
  ]
  analyst_counts = [scalar(value) for value in analyst_counts]
  analyst_counts = [value for value in analyst_counts if isinstance(value, (int, float))]
  fields = {
      "forwardEps": field(
          forward_eps if forward_eps is not None else info.get("forwardEps"),
          note="0y analyst EPS estimate when available; otherwise yfinance forwardEps",
      ),
      "forwardRevenue": field(
          forward_revenue,
          note="0y analyst average revenue estimate; coverage is best-effort",
      ),
      "targetLowPrice": field(price_targets.get("low", info.get("targetLowPrice"))),
      "targetMeanPrice": field(price_targets.get("mean", info.get("targetMeanPrice"))),
      "targetMedianPrice": field(price_targets.get("median", info.get("targetMedianPrice"))),
      "targetHighPrice": field(price_targets.get("high", info.get("targetHighPrice"))),
      "analystCount": field(max(analyst_counts) if analyst_counts else None),
      "recommendationMean": field(info.get("recommendationMean")),
      "recommendationKey": field(info.get("recommendationKey")),
  }
  return {
      "ticker": ticker,
      "observation": metadata(
          ticker,
          period_type="estimate",
          currency=scalar(info.get("currency")),
      ),
      "fields": fields,
  }


COMPARABLE_FIELDS = {
    "name": "shortName",
    "currentPrice": "currentPrice",
    "marketCap": "marketCap",
    "sharesOutstanding": "sharesOutstanding",
    "revenue": "totalRevenue",
    "ebitda": "ebitda",
    "eps": "trailingEps",
    "cash": "totalCash",
    "debt": "totalDebt",
    "pe": "trailingPE",
    "forwardPe": "forwardPE",
    "evEbitda": "enterpriseToEbitda",
    "evRevenue": "enterpriseToRevenue",
    "priceSales": "priceToSalesTrailing12Months",
    "grossMargin": "grossMargins",
    "operatingMargin": "operatingMargins",
    "netMargin": "profitMargins",
    "revenueGrowth": "revenueGrowth",
    "returnOnEquity": "returnOnEquity",
}


def comparables(params: dict[str, Any]) -> list[dict[str, Any]]:
  companies = []
  for raw in params["tickers"]:
    ticker = str(raw).upper()
    info = info_for(ticker)
    debt, cash = scalar(info.get("totalDebt")), scalar(info.get("totalCash"))
    fields = {key: field(info.get(source)) for key, source in COMPARABLE_FIELDS.items()}
    fields["netDebt"] = field(debt - cash if isinstance(debt, (int, float)) and isinstance(cash, (int, float)) else None)
    companies.append({
        "ticker": ticker,
        "observation": metadata(
            ticker,
            period_type="ttm",
            currency=scalar(info.get("currency")),
        ),
        "fields": fields,
    })
  return companies


OPERATIONS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "security-reference": security_reference,
    "fundamentals": fundamentals,
    "market-data": market_data,
    "estimates": estimates,
    "comparables": comparables,
}


def main() -> int:
  try:
    request = json.load(sys.stdin)
    if request.get("version") != VERSION:
      raise ValueError("unsupported request version")
    operation = request.get("operation")
    if operation not in OPERATIONS:
      raise ValueError(f"unsupported operation: {operation!r}")
    data = OPERATIONS[operation](request.get("params") or {})
    response = {"version": VERSION, "ok": True, "data": data}
    json.dump(response, sys.stdout, allow_nan=False, separators=(",", ":"))
    return 0
  except Exception as error:  # Protocol boundary: classify without leaking a traceback to stdout.
    name = type(error).__name__
    message = str(error) or name
    retryable = any(token in message.lower() for token in ("timeout", "429", "rate limit", "temporar"))
    json.dump({
        "version": VERSION,
        "ok": False,
        "error": {"kind": name, "message": message, "retryable": retryable},
    }, sys.stdout, allow_nan=False, separators=(",", ":"))
    print(f"yfinance runner: {name}: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
  raise SystemExit(main())
