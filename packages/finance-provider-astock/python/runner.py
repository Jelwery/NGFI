#!/usr/bin/env python3
"""Isolated, versioned NDJSON runner for curated mainland-China market data.

Only the operations and sources declared below are reachable.  Recorded fixtures
provide deterministic offline coverage.  The public-web source uses fixed East
Money endpoints and rejects response schema drift before mapping any values.
"""

from __future__ import annotations

import json
import http.client
import math
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

VERSION = "1"
PROVIDER_ID = "a-stock-public"
MAX_REQUEST_BYTES = 256 * 1024
HARD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
HARD_MAX_RECORDS = 10_000
HARD_MAX_DATE_SPAN_DAYS = 3_660
HARD_MAX_NETWORK_TIMEOUT_MS = 30_000
FIXTURE_SCHEMA_VERSION = "ngfi-a-stock-fixture-1"
SHANGHAI_TIMEZONE = ZoneInfo("Asia/Shanghai")
ALLOWED_OPERATIONS = frozenset({
  "instrument-reference", "quote", "market-bars", "fundamentals",
  "disclosures", "index", "trading-calendar",
})
PUBLIC_OPERATIONS = ALLOWED_OPERATIONS
ALLOWED_SOURCES = frozenset({"fixture", "public-web"})
SOURCE_KINDS = frozenset({"official", "licensed", "community", "public-web", "derived", "user"})
REQUEST_KEYS = frozenset({"version", "id", "operation", "source", "params", "limits", "fixtureRoot"})
LIMIT_KEYS = frozenset({"maxRecords", "maxDateSpanDays", "maxOutputBytes", "networkTimeoutMs"})
INSTRUMENT_KEYS = frozenset({"market", "exchange", "symbol", "assetType"})
PARAM_KEYS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
  "instrument-reference": (frozenset({"instrument"}), frozenset({"instrument"})),
  "quote": (frozenset({"instrument"}), frozenset({"instrument"})),
  "market-bars": (
    frozenset({"instrument", "startDate", "endDate", "adjustment", "interval", "limit", "asOf"}),
    frozenset({"instrument", "startDate", "endDate", "adjustment", "interval", "limit"}),
  ),
  "fundamentals": (frozenset({"instrument", "limit", "statement", "asOf"}), frozenset({"instrument", "limit", "statement"})),
  "disclosures": (
    frozenset({"instrument", "startDate", "endDate", "limit", "asOf"}),
    frozenset({"instrument", "startDate", "endDate", "limit"}),
  ),
  "index": (frozenset({"instrument", "limit", "officialProvider", "asOf"}), frozenset({"instrument", "limit", "officialProvider"})),
  "trading-calendar": (
    frozenset({"exchange", "startDate", "endDate", "limit", "asOf"}),
    frozenset({"exchange", "startDate", "endDate", "limit"}),
  ),
}

EASTMONEY_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
EASTMONEY_BARS_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
SINA_FINANCIAL_URL = "https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022"
CNINFO_ANNOUNCEMENT_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_STOCK_MAP_URL = "https://www.cninfo.com.cn/new/data/szse_stock.json"
SZSE_ANNOUNCEMENT_URL = "https://www.szse.cn/api/disc/announcement/annList"
SZSE_CALENDAR_URL = "https://www.szse.cn/api/report/exchange/onepersistenthour/monthList"
CSI_INDEX_TEMPLATE = (
  "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
  "autofile/cons/{code}cons.xls"
)
CNI_INDEX_URL = "https://www.cnindex.com.cn/sample-detail/download-history"
PUBLIC_HTTPS_HOSTS: dict[str, frozenset[str]] = {
  "instrument-reference": frozenset({"push2.eastmoney.com"}),
  "quote": frozenset({"push2.eastmoney.com"}),
  "market-bars": frozenset({"push2his.eastmoney.com"}),
  "fundamentals": frozenset({"quotes.sina.cn"}),
  "disclosures": frozenset({"www.cninfo.com.cn", "www.szse.cn"}),
  "index": frozenset({"oss-ch.csindex.com.cn", "www.cnindex.com.cn"}),
  "trading-calendar": frozenset({"www.szse.cn"}),
}


class ProviderFailure(Exception):
  def __init__(self, kind: str, code: str, message: str, retryable: bool = False):
    super().__init__(message)
    self.kind = kind
    self.code = code
    self.retryable = retryable


def fail(condition: bool, kind: str, code: str, message: str, retryable: bool = False) -> None:
  if condition:
    raise ProviderFailure(kind, code, message, retryable)


def exact_keys(value: Any, keys: frozenset[str], label: str) -> dict[str, Any]:
  fail(not isinstance(value, dict), "schema-drift", "fixture-schema", f"{label} must be an object")
  actual = set(value)
  fail(actual != keys, "schema-drift", "fixture-schema",
       f"{label} fields changed: missing={sorted(keys - actual)} extra={sorted(actual - keys)}")
  return value


def strict_json(raw: bytes, label: str) -> Any:
  try:
    return json.loads(
      raw.decode("utf-8"),
      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"invalid number {value}")),
    )
  except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
    code = "invalid-request" if label == "request" else "schema-drift"
    raise ProviderFailure(
      "invalid-request" if label == "request" else "schema-drift",
      code,
      f"{label} is not strict JSON: {exc}",
    ) from exc


def iso_date(value: Any, label: str) -> str:
  fail(not isinstance(value, str), "schema-drift", "fixture-schema", f"{label} must be YYYY-MM-DD")
  try:
    parsed = date.fromisoformat(value)
  except ValueError as exc:
    raise ProviderFailure("schema-drift", "fixture-schema", f"{label} must be YYYY-MM-DD") from exc
  fail(parsed.isoformat() != value, "schema-drift", "fixture-schema", f"{label} must be canonical YYYY-MM-DD")
  return value


def iso_timestamp(value: Any, label: str) -> str:
  fail(not isinstance(value, str), "schema-drift", "fixture-schema", f"{label} must be an ISO timestamp")
  try:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
  except ValueError as exc:
    raise ProviderFailure("schema-drift", "fixture-schema", f"{label} must be an ISO timestamp") from exc
  fail(parsed.tzinfo is None or parsed.utcoffset() is None, "schema-drift", "fixture-schema",
       f"{label} must include a timezone offset")
  return value


def disclosure_cutoff(value: str | None) -> datetime | None:
  if value is None:
    return None
  if len(value) == 10:
    return datetime.combine(date.fromisoformat(value), time.max, SHANGHAI_TIMEZONE)
  parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
  fail(parsed.tzinfo is None or parsed.utcoffset() is None, "invalid-request", "invalid-request",
       "params.asOf timestamp must include a timezone offset")
  return parsed


def validate_request_as_of(value: Any) -> str:
  fail(not isinstance(value, str), "invalid-request", "invalid-request",
       "params.asOf must be an ISO date or timestamp")
  if len(value) == 10:
    try:
      parsed_date = date.fromisoformat(value)
    except ValueError as exc:
      raise ProviderFailure(
        "invalid-request", "invalid-request", "params.asOf must be an ISO date or timestamp",
      ) from exc
    fail(parsed_date.isoformat() != value, "invalid-request", "invalid-request",
         "params.asOf must be an ISO date or timestamp")
    return value
  fail(len(value) < 20 or value[10] != "T", "invalid-request", "invalid-request",
       "params.asOf timestamp must use ISO T notation and include a timezone offset")
  try:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
  except ValueError as exc:
    raise ProviderFailure(
      "invalid-request", "invalid-request", "params.asOf must be an ISO date or timestamp",
    ) from exc
  fail(parsed.tzinfo is None or parsed.utcoffset() is None, "invalid-request", "invalid-request",
       "params.asOf timestamp must include a timezone offset")
  return value


def as_of_shanghai_date(value: str | None, fallback: str, *, daily_close: bool = False) -> str:
  cutoff = disclosure_cutoff(value)
  if cutoff is None:
    return fallback
  localized = cutoff.astimezone(SHANGHAI_TIMEZONE)
  visible_date = localized.date()
  if daily_close and len(value or '') != 10 and localized.time() < time(15, 0):
    visible_date -= timedelta(days=1)
  return visible_date.isoformat()


def timestamp_instant(value: str, label: str, assume_shanghai: bool = False) -> datetime:
  parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
  if parsed.tzinfo is None or parsed.utcoffset() is None:
    fail(not assume_shanghai, "schema-drift", "schema-drift",
         f"{label} must include a timezone offset")
    parsed = parsed.replace(tzinfo=SHANGHAI_TIMEZONE)
  return parsed


def finite_number(value: Any, label: str, nullable: bool = True) -> float | int | None:
  if value is None and nullable:
    return None
  fail(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value),
       "schema-drift", "fixture-schema", f"{label} must be a finite number")
  return value


def non_empty_string(value: Any, label: str) -> str:
  fail(not isinstance(value, str) or not value.strip(), "schema-drift", "fixture-schema",
       f"{label} must be a non-empty string")
  return value


def validate_instrument(value: Any, label: str = "instrument") -> dict[str, str]:
  instrument = exact_keys(value, INSTRUMENT_KEYS, label)
  fail(instrument["market"] != "CN", "invalid-request", "invalid-request",
       f"{label}.market must be CN")
  fail(instrument["exchange"] not in {"SSE", "SZSE", "BSE"},
       "invalid-request", "invalid-request", f"{label}.exchange is unsupported")
  symbol = instrument["symbol"]
  fail(not isinstance(symbol, str) or len(symbol) != 6 or not symbol.isdigit(),
       "invalid-request", "invalid-request", f"{label}.symbol must be six digits")
  fail(instrument["assetType"] not in {"equity", "index", "etf", "fund", "bond"},
       "invalid-request", "invalid-request", f"{label}.assetType is unsupported")
  return instrument  # type: ignore[return-value]


def canonical(instrument: dict[str, str]) -> str:
  return f"{instrument['market']}:{instrument['exchange']}:{instrument['symbol']}:{instrument['assetType'].upper()}"


def available(value: Any) -> dict[str, Any]:
  return {"status": "available", "value": value}


def missing(note: str | None = None) -> dict[str, Any]:
  value: dict[str, Any] = {"status": "missing", "value": None}
  if note is not None:
    value["note"] = note
  return value


def observed(value: Any, note: str | None = None) -> dict[str, Any]:
  if value is None:
    return missing(note)
  result = available(value)
  if note is not None:
    result["note"] = note
  return result


def provenance(
  source: str,
  fetched_at: str,
  upstream_source: str,
  source_kind: str,
  **optional: Any,
) -> dict[str, Any]:
  result = {
    "actualProvider": PROVIDER_ID,
    "provider": PROVIDER_ID,
    "upstreamSource": upstream_source,
    "sourceKind": source_kind,
    "fetchedAt": fetched_at,
    "fallbackChain": [],
  }
  if source == "fixture":
    result["upstreamVersion"] = FIXTURE_SCHEMA_VERSION
  result.update({key: value for key, value in optional.items() if value is not None})
  return result


def success(data: dict[str, Any], metadata: dict[str, str], **provenance_values: Any) -> dict[str, Any]:
  return {
    "status": "available",
    "data": data,
    "provenance": provenance(
      provenance_values.pop("source"),
      metadata["capturedAt"],
      metadata["upstreamSource"],
      metadata["sourceKind"],
      **provenance_values,
    ),
    "warnings": [],
  }


def secure_fixture_file(root_value: Any, operation: str) -> Path:
  fail(not isinstance(root_value, str) or not root_value, "invalid-request", "invalid-request",
       "fixtureRoot is required for fixture source")
  root_path = Path(root_value)
  fail(not root_path.is_absolute(), "invalid-request", "invalid-request", "fixtureRoot must be absolute")
  fail(root_path.is_symlink(), "invalid-request", "invalid-request", "fixtureRoot cannot be a symlink")
  try:
    root = root_path.resolve(strict=True)
  except OSError as exc:
    raise ProviderFailure("schema-drift", "fixture-schema", "fixtureRoot is unavailable") from exc
  fail(not root.is_dir(), "schema-drift", "fixture-schema", "fixtureRoot is not a directory")
  filename = f"{operation}.json"
  raw_path = root / filename
  fail(raw_path.is_symlink(), "schema-drift", "fixture-schema", "fixture file cannot be a symlink")
  try:
    path = raw_path.resolve(strict=True)
    path.relative_to(root)
  except (OSError, ValueError) as exc:
    raise ProviderFailure("schema-drift", "fixture-schema", f"fixture {filename} is missing") from exc
  fail(path.parent != root or not path.is_file(), "schema-drift", "fixture-schema",
       "fixture file must be a direct regular child of fixtureRoot")
  return path


def load_fixture(request: dict[str, Any]) -> tuple[dict[str, str], list[Any]]:
  path = secure_fixture_file(request.get("fixtureRoot"), request["operation"])
  try:
    payload = path.read_bytes()
  except OSError as exc:
    raise ProviderFailure("schema-drift", "fixture-schema", f"cannot read fixture {path.name}") from exc
  fail(len(payload) > request["limits"]["maxOutputBytes"], "schema-drift", "output-limit",
       "fixture input exceeds configured output budget")
  document = strict_json(payload, "fixture")
  envelope = exact_keys(
    document,
    frozenset({"schemaVersion", "capturedAt", "upstreamSource", "sourceKind", "records"}),
    path.name,
  )
  fail(envelope["schemaVersion"] != FIXTURE_SCHEMA_VERSION, "schema-drift", "fixture-schema",
       f"{path.name} has unsupported schemaVersion")
  captured_at = iso_timestamp(envelope["capturedAt"], f"{path.name}.capturedAt")
  upstream_source = non_empty_string(envelope["upstreamSource"], f"{path.name}.upstreamSource")
  source_kind = envelope["sourceKind"]
  fail(source_kind not in SOURCE_KINDS, "schema-drift", "fixture-schema",
       f"{path.name}.sourceKind is unsupported")
  records = envelope["records"]
  fail(not isinstance(records, list), "schema-drift", "fixture-schema",
       f"{path.name}.records must be an array")
  fail(len(records) > HARD_MAX_RECORDS, "schema-drift", "output-limit",
       f"{path.name}.records exceeds hard limit")
  return {
    "capturedAt": captured_at,
    "upstreamSource": upstream_source,
    "sourceKind": source_kind,
  }, records


def record_instrument(record: Any, keys: frozenset[str], label: str) -> tuple[dict[str, Any], dict[str, str]]:
  value = exact_keys(record, keys, label)
  return value, validate_instrument(value["instrument"], f"{label}.instrument")


def find_record(records: list[Any], target: dict[str, str], keys: frozenset[str]) -> dict[str, Any]:
  matched: list[dict[str, Any]] = []
  for index, raw in enumerate(records):
    record, instrument = record_instrument(raw, keys, f"records[{index}]")
    if instrument == target:
      matched.append(record)
  fail(len(matched) == 0, "no-data", "no-data", f"fixture has no data for {canonical(target)}")
  fail(len(matched) > 1, "schema-drift", "fixture-schema",
       f"fixture has duplicate records for {canonical(target)}")
  return matched[0]


def fixture_instrument(request: dict[str, Any]) -> dict[str, Any]:
  metadata, records = load_fixture(request)
  target = validate_instrument(request["params"]["instrument"], "params.instrument")
  keys = frozenset({"instrument", "name", "providerSymbols"})
  record = find_record(records, target, keys)
  name = non_empty_string(record["name"], "instrument.name")
  symbols = record["providerSymbols"]
  fail(not isinstance(symbols, dict) or not symbols
       or any(not isinstance(key, str) or not isinstance(value, str) or not value for key, value in symbols.items()),
       "schema-drift", "fixture-schema", "instrument.providerSymbols is invalid")
  data = {
    "id": target,
    "canonical": canonical(target),
    "name": available(name),
    "quoteCurrency": available("CNY"),
    "providerSymbols": symbols,
  }
  return success(data, metadata, source="fixture", currency="CNY", timezone="Asia/Shanghai")


QUOTE_KEYS = frozenset({
  "instrument", "name", "tradingDate", "observedAt", "open", "high", "low",
  "last", "previousClose", "volume", "turnover",
})


def map_quote(record: dict[str, Any], target: dict[str, str]) -> dict[str, Any]:
  name = non_empty_string(record["name"], "quote.name")
  trading_date = iso_date(record["tradingDate"], "quote.tradingDate")
  observed_at = iso_timestamp(record["observedAt"], "quote.observedAt")
  numeric = {
    key: finite_number(record[key], f"quote.{key}")
    for key in ("open", "high", "low", "last", "previousClose", "volume", "turnover")
  }
  return {
    "instrument": target,
    "tradingDate": trading_date,
    "observedAt": observed_at,
    "currency": "CNY",
    "fields": {"name": available(name), **{key: observed(value) for key, value in numeric.items()}},
  }


def fixture_quote(request: dict[str, Any]) -> dict[str, Any]:
  metadata, records = load_fixture(request)
  target = validate_instrument(request["params"]["instrument"], "params.instrument")
  record = find_record(records, target, QUOTE_KEYS)
  data = map_quote(record, target)
  return success(
    data, metadata, source="fixture", observedAt=data["observedAt"], currency="CNY",
    unit="price:CNY;volume:lot;turnover:CNY", adjustment="none", timezone="Asia/Shanghai",
  )


BAR_KEYS = frozenset({"date", "open", "high", "low", "close", "volume", "turnover"})
BARS_RECORD_KEYS = frozenset({"instrument", "interval", "adjustment", "bars"})


def validate_bar(raw: Any, index: int) -> dict[str, Any]:
  bar = exact_keys(raw, BAR_KEYS, f"bars[{index}]")
  return {
    "date": iso_date(bar["date"], f"bars[{index}].date"),
    **{key: finite_number(bar[key], f"bars[{index}].{key}")
       for key in ("open", "high", "low", "close", "volume", "turnover")},
  }


def slice_rows(rows: list[dict[str, Any]], limit: int) -> tuple[list[dict[str, Any]], bool]:
  return rows[:limit], len(rows) > limit


def fixture_bars(request: dict[str, Any]) -> dict[str, Any]:
  metadata, records = load_fixture(request)
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  record = find_record(records, target, BARS_RECORD_KEYS)
  fail(record["interval"] != params["interval"] or record["adjustment"] != params["adjustment"],
       "no-data", "no-data", "fixture has no bars for the requested interval/adjustment")
  fail(not isinstance(record["bars"], list), "schema-drift", "fixture-schema", "bars must be an array")
  rows = [validate_bar(raw, index) for index, raw in enumerate(record["bars"])]
  fail(len({row["date"] for row in rows}) != len(rows), "schema-drift", "fixture-schema",
       "bars contain duplicate dates")
  fail(rows != sorted(rows, key=lambda row: row["date"]), "schema-drift", "fixture-schema",
       "bars must be sorted by date")
  effective_end = min(
    params["endDate"],
    as_of_shanghai_date(params.get("asOf"), params["endDate"], daily_close=True),
  )
  fail(effective_end < params["startDate"], "no-data", "no-data",
       "requested as-of time precedes the bars date range")
  rows = [row for row in rows if params["startDate"] <= row["date"] <= effective_end]
  fail(not rows, "no-data", "no-data", "fixture has no bars in requested date range")
  rows, truncated = slice_rows(rows, params["limit"])
  data = {
    "instrument": target, "interval": params["interval"], "adjustment": params["adjustment"],
    "startDate": rows[0]["date"], "endDate": rows[-1]["date"], "bars": rows,
    "returned": len(rows), "truncated": truncated,
  }
  return success(
    data, metadata, source="fixture", observedAt=rows[-1]["date"], currency="CNY",
    unit="price:CNY;volume:lot;turnover:CNY", adjustment=params["adjustment"], timezone="Asia/Shanghai",
  )


FUNDAMENTAL_KEYS = frozenset({"fiscalPeriod", "publishedAt", "availableAt", "currency", "unit", "scope", "fields"})
FUNDAMENTALS_RECORD_KEYS = frozenset({"instrument", "periods"})


def fixture_fundamentals(request: dict[str, Any]) -> dict[str, Any]:
  metadata, records = load_fixture(request)
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  record = find_record(records, target, FUNDAMENTALS_RECORD_KEYS)
  fail(not isinstance(record["periods"], list), "schema-drift", "fixture-schema", "periods must be an array")
  periods: list[dict[str, Any]] = []
  for index, raw in enumerate(record["periods"]):
    period = exact_keys(raw, FUNDAMENTAL_KEYS, f"periods[{index}]")
    fiscal = iso_date(period["fiscalPeriod"], f"periods[{index}].fiscalPeriod")
    published = iso_date(period["publishedAt"], f"periods[{index}].publishedAt")
    available_at = iso_date(period["availableAt"], f"periods[{index}].availableAt")
    fail(available_at < published or published < fiscal, "schema-drift", "fixture-schema",
         "fundamental dates violate fiscal <= published <= available")
    fail(period["currency"] != "CNY" or not isinstance(period["unit"], str)
         or period["scope"] not in {"consolidated", "parent"},
         "schema-drift", "fixture-schema", "fundamental metadata is invalid")
    fields = period["fields"]
    fail(not isinstance(fields, dict) or not fields, "schema-drift", "fixture-schema",
         "fundamental fields must be a non-empty object")
    mapped_fields = {key: observed(finite_number(value, f"periods[{index}].fields.{key}"))
                     for key, value in fields.items()}
    periods.append({
      "fiscalPeriod": fiscal, "publishedAt": published, "availableAt": available_at,
      "currency": "CNY", "unit": period["unit"], "scope": period["scope"],
      "fields": mapped_fields,
    })
  fail(len({item["fiscalPeriod"] for item in periods}) != len(periods), "schema-drift", "fixture-schema",
       "fundamentals contain duplicate fiscal periods")
  periods.sort(key=lambda item: item["fiscalPeriod"], reverse=True)
  if params.get("asOf") is not None:
    as_of = as_of_shanghai_date(params["asOf"], params["asOf"])
    periods = [item for item in periods if item["availableAt"] <= as_of]
  fail(not periods, "no-data", "no-data", "no fundamentals are available at requested as-of time")
  periods, truncated = slice_rows(periods, params["limit"])
  data = {
    "instrument": target, "periods": periods, "returned": len(periods),
    "truncated": truncated, "pitSafe": True,
  }
  newest = periods[0]
  return success(
    data, metadata, source="fixture", fiscalPeriod=newest["fiscalPeriod"],
    publishedAt=newest["publishedAt"], availableAt=newest["availableAt"],
    currency="CNY", unit=newest["unit"], timezone="Asia/Shanghai",
  )


DISCLOSURE_KEYS = frozenset({"id", "title", "category", "publishedAt", "documentRef"})
DISCLOSURES_RECORD_KEYS = frozenset({"instrument", "items"})
PUBLIC_DISCLOSURE_PAGE_SIZE = 30


def fixture_disclosures(request: dict[str, Any]) -> dict[str, Any]:
  metadata, records = load_fixture(request)
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  record = find_record(records, target, DISCLOSURES_RECORD_KEYS)
  fail(not isinstance(record["items"], list), "schema-drift", "fixture-schema", "items must be an array")
  items: list[dict[str, str]] = []
  for index, raw in enumerate(record["items"]):
    item = exact_keys(raw, DISCLOSURE_KEYS, f"items[{index}]")
    mapped = {key: non_empty_string(item[key], f"items[{index}].{key}")
              for key in ("id", "title", "category", "documentRef")}
    mapped["publishedAt"] = iso_timestamp(item["publishedAt"], f"items[{index}].publishedAt")
    items.append(mapped)
  fail(len({item["id"] for item in items}) != len(items), "schema-drift", "fixture-schema",
       "disclosures contain duplicate ids")
  cutoff = disclosure_cutoff(params.get("asOf"))
  instants = [(item, timestamp_instant(item["publishedAt"], "fixture disclosure publishedAt")) for item in items]
  instants = [
    (item, published_at) for item, published_at in instants
    if params["startDate"] <= published_at.astimezone(SHANGHAI_TIMEZONE).date().isoformat() <= params["endDate"]
    and (cutoff is None or published_at <= cutoff)
  ]
  instants.sort(key=lambda entry: entry[1], reverse=True)
  items = [item for item, _ in instants]
  fail(not items, "no-data", "no-data", "fixture has no disclosures available in requested range")
  items, truncated = slice_rows(items, params["limit"])
  data = {"instrument": target, "items": items, "returned": len(items), "truncated": truncated}
  return success(data, metadata, source="fixture", publishedAt=items[0]["publishedAt"], timezone="Asia/Shanghai")


CONSTITUENT_KEYS = frozenset({"instrument", "name", "weight"})
INDEX_RECORD_KEYS = frozenset({"instrument", "asOf", "constituents"})


def fixture_index(request: dict[str, Any]) -> dict[str, Any]:
  metadata, records = load_fixture(request)
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  record = find_record(records, target, INDEX_RECORD_KEYS)
  as_of = iso_date(record["asOf"], "index.asOf")
  fail(params.get("asOf") is not None
       and as_of > as_of_shanghai_date(params["asOf"], params["asOf"]),
       "no-data", "no-data", "index fixture is newer than requested as-of time")
  fail(not isinstance(record["constituents"], list), "schema-drift", "fixture-schema",
       "constituents must be an array")
  constituents: list[dict[str, Any]] = []
  seen: set[str] = set()
  for index, raw in enumerate(record["constituents"]):
    item = exact_keys(raw, CONSTITUENT_KEYS, f"constituents[{index}]")
    instrument = validate_instrument(item["instrument"], f"constituents[{index}].instrument")
    key = canonical(instrument)
    fail(key in seen, "schema-drift", "fixture-schema", "index constituents contain duplicates")
    seen.add(key)
    constituents.append({
      "instrument": instrument,
      "name": non_empty_string(item["name"], f"constituents[{index}].name"),
      "weight": observed(finite_number(item["weight"], f"constituents[{index}].weight")),
    })
  fail(not constituents, "no-data", "no-data", "index fixture has no constituents")
  constituents, truncated = slice_rows(constituents, params["limit"])
  data = {
    "instrument": target, "asOf": as_of, "constituents": constituents,
    "returned": len(constituents), "truncated": truncated,
  }
  return success(data, metadata, source="fixture", observedAt=as_of, currency="CNY", unit="weight:percent", timezone="Asia/Shanghai")


DAY_KEYS = frozenset({"date", "isTradingDay", "session"})
CALENDAR_RECORD_KEYS = frozenset({"exchange", "startDate", "endDate", "days"})


def fixture_calendar(request: dict[str, Any]) -> dict[str, Any]:
  metadata, records = load_fixture(request)
  params = request["params"]
  matches: list[dict[str, Any]] = []
  for index, raw in enumerate(records):
    record = exact_keys(raw, CALENDAR_RECORD_KEYS, f"records[{index}]")
    fail(record["exchange"] not in {"SSE", "SZSE", "BSE"}, "schema-drift", "fixture-schema",
         f"records[{index}].exchange is invalid")
    iso_date(record["startDate"], f"records[{index}].startDate")
    iso_date(record["endDate"], f"records[{index}].endDate")
    if record["exchange"] == params["exchange"]:
      matches.append(record)
  fail(len(matches) == 0, "no-data", "no-data", "fixture has no calendar for requested exchange")
  fail(len(matches) > 1, "schema-drift", "fixture-schema", "fixture has duplicate exchange calendars")
  record = matches[0]
  fail(not isinstance(record["days"], list), "schema-drift", "fixture-schema", "days must be an array")
  days: list[dict[str, Any]] = []
  for index, raw in enumerate(record["days"]):
    day = exact_keys(raw, DAY_KEYS, f"days[{index}]")
    mapped_date = iso_date(day["date"], f"days[{index}].date")
    fail(not isinstance(day["isTradingDay"], bool), "schema-drift", "fixture-schema",
         f"days[{index}].isTradingDay must be boolean")
    fail(day["session"] is not None and not isinstance(day["session"], str),
         "schema-drift", "fixture-schema", f"days[{index}].session must be string or null")
    days.append({"date": mapped_date, "isTradingDay": day["isTradingDay"], "session": day["session"]})
  fail(len({day["date"] for day in days}) != len(days), "schema-drift", "fixture-schema",
       "calendar contains duplicate dates")
  fail(days != sorted(days, key=lambda item: item["date"]), "schema-drift", "fixture-schema",
       "calendar days must be sorted")
  effective_end = min(
    params["endDate"], as_of_shanghai_date(params.get("asOf"), params["endDate"]),
  )
  fail(effective_end < params["startDate"], "no-data", "no-data",
       "requested as-of time precedes the calendar date range")
  days = [day for day in days if params["startDate"] <= day["date"] <= effective_end]
  fail(not days, "no-data", "no-data", "fixture has no calendar days in requested date range")
  days, truncated = slice_rows(days, params["limit"])
  data = {
    "exchange": params["exchange"], "startDate": days[0]["date"], "endDate": days[-1]["date"],
    "days": days, "returned": len(days), "truncated": truncated,
  }
  return success(data, metadata, source="fixture", observedAt=days[-1]["date"], timezone="Asia/Shanghai")


FIXTURE_HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
  "instrument-reference": fixture_instrument,
  "quote": fixture_quote,
  "market-bars": fixture_bars,
  "fundamentals": fixture_fundamentals,
  "disclosures": fixture_disclosures,
  "index": fixture_index,
  "trading-calendar": fixture_calendar,
}


def eastmoney_secid(instrument: dict[str, str]) -> str:
  return f"{'1' if instrument['exchange'] == 'SSE' else '0'}.{instrument['symbol']}"


class RejectRedirects(urllib.request.HTTPRedirectHandler):
  def redirect_request(
    self, request: Any, file_pointer: Any, code: int, message: str,
    headers: Any, new_url: str,
  ) -> None:
    del request, file_pointer, code, message, headers, new_url
    return None


def validate_public_url(url: Any, capability: str) -> urllib.parse.SplitResult:
  fail(not isinstance(url, str) or not url, "invalid-request", "invalid-request",
       "public request target must be a non-empty URL")
  fail(capability not in PUBLIC_HTTPS_HOSTS, "invalid-request", "invalid-request",
       "public request capability is not allowed")
  try:
    parsed = urllib.parse.urlsplit(url)
    port = parsed.port
  except ValueError as exc:
    raise ProviderFailure(
      "invalid-request", "invalid-request", "public request target is invalid", False,
    ) from exc
  fail(parsed.scheme != "https" or parsed.hostname not in PUBLIC_HTTPS_HOSTS[capability]
       or port not in (None, 443) or parsed.username is not None or parsed.password is not None
       or bool(parsed.fragment),
       "invalid-request", "invalid-request",
       "public request target is outside the capability HTTPS host policy")
  return parsed


def canonical_public_url(url: Any, capability: str) -> str:
  parsed = validate_public_url(url, capability)
  return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def public_request(
  url: str,
  query: dict[str, str] | None,
  timeout_ms: int,
  *,
  capability: str,
  body: bytes | None = None,
  headers: dict[str, str] | None = None,
  max_bytes: int = HARD_MAX_OUTPUT_BYTES,
) -> tuple[bytes, str]:
  canonical_url = canonical_public_url(url, capability)
  target = canonical_url if query is None else f"{canonical_url}?{urllib.parse.urlencode(query)}"
  request = urllib.request.Request(
    target,
    data=body,
    headers={
      "Accept": "application/json",
      "User-Agent": "NGFI-AStockProvider/0.1",
      **(headers or {}),
    },
    method="POST" if body is not None else "GET",
  )
  opener = urllib.request.build_opener(RejectRedirects())
  try:
    with opener.open(request, timeout=timeout_ms / 1000) as response:
      status = response.status
      raw = response.read(max_bytes + 1)
  except urllib.error.HTTPError as exc:
    if 300 <= exc.code < 400:
      raise ProviderFailure(
        "provider-error", "provider-error", "public source redirect is not allowed", False,
      ) from exc
    if exc.code == 401:
      raise ProviderFailure("unauthorized", "unauthorized", "public source returned HTTP 401") from exc
    if exc.code == 403:
      raise ProviderFailure("insufficient-permission", "insufficient-permission",
                            "public source returned HTTP 403") from exc
    if exc.code == 429:
      raise ProviderFailure("rate-limited", "rate-limited", "public source returned HTTP 429", True) from exc
    raise ProviderFailure("provider-error", "provider-error",
                          f"public source returned HTTP {exc.code}", exc.code >= 500) from exc
  except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, socket.timeout) as exc:
    reason = getattr(exc, "reason", exc)
    kind = "timeout" if isinstance(reason, (TimeoutError, socket.timeout)) else "transport"
    raise ProviderFailure(kind, kind, f"public source {kind}", True) from exc
  fail(status != 200, "provider-error", "provider-error", f"public source returned HTTP {status}")
  fail(len(raw) > max_bytes, "schema-drift", "output-limit", "public response exceeds byte limit")
  return raw, canonical_url


def public_json(
  url: str,
  query: dict[str, str] | None,
  timeout_ms: int,
  *,
  capability: str,
  body: bytes | None = None,
  headers: dict[str, str] | None = None,
  max_bytes: int = HARD_MAX_OUTPUT_BYTES,
) -> Any:
  raw, _ = public_request(
    url, query, timeout_ms, capability=capability, body=body, headers=headers, max_bytes=max_bytes,
  )
  return strict_json(raw, "public response")


def eastmoney_payload(document: Any, required: frozenset[str], label: str) -> dict[str, Any]:
  fail(not isinstance(document, dict), "schema-drift", "schema-drift", f"{label} response must be an object")
  fail(document.get("rc") != 0, "provider-error", "provider-error", f"{label} returned rc={document.get('rc')!r}")
  data = document.get("data")
  fail(not isinstance(data, dict), "schema-drift", "schema-drift", f"{label}.data must be an object")
  missing_keys = required - set(data)
  fail(bool(missing_keys), "schema-drift", "schema-drift",
       f"{label}.data is missing required fields {sorted(missing_keys)}")
  return data


def public_quote_document(
  instrument: dict[str, str], timeout_ms: int, capability: str,
) -> tuple[dict[str, Any], str]:
  document = public_json(EASTMONEY_QUOTE_URL, {
    "secid": eastmoney_secid(instrument),
    "fields": "f57,f58,f43,f44,f45,f46,f47,f48,f59,f60,f86",
  }, timeout_ms, capability=capability)
  data = eastmoney_payload(document, frozenset({"f57", "f58", "f43", "f44", "f45", "f46", "f47", "f48", "f59", "f60", "f86"}), "East Money quote")
  fail(data["f57"] != instrument["symbol"], "schema-drift", "schema-drift",
       "East Money returned a different symbol")
  non_empty_string(data["f58"], "East Money quote name")
  decimals = data["f59"]
  fail(not isinstance(decimals, int) or isinstance(decimals, bool) or decimals < 0 or decimals > 6,
       "schema-drift", "schema-drift", "East Money quote decimal field is invalid")
  for field in ("f43", "f44", "f45", "f46", "f47", "f48", "f60", "f86"):
    fail(data[field] is not None and (isinstance(data[field], bool) or not isinstance(data[field], (int, float))
         or not math.isfinite(data[field])), "schema-drift", "schema-drift",
         f"East Money quote field {field} is invalid")
  fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
  return data, fetched_at


def epoch_timestamp(value: Any, fallback: str) -> str:
  if not isinstance(value, (int, float)) or isinstance(value, bool):
    return fallback
  try:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
  except (OSError, OverflowError, ValueError):
    raise ProviderFailure("schema-drift", "schema-drift", "East Money quote timestamp is invalid")


def eastmoney_price(value: Any, decimals: int) -> float | None:
  if value is None or value == "-":
    return None
  fail(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value),
       "schema-drift", "schema-drift", "East Money price field is invalid")
  return value / (10 ** decimals)


def public_quote(request: dict[str, Any]) -> dict[str, Any]:
  target = validate_instrument(request["params"]["instrument"], "params.instrument")
  raw, fetched_at = public_quote_document(target, request["limits"]["networkTimeoutMs"], "quote")
  observed_at = epoch_timestamp(raw["f86"], fetched_at)
  record = {
    "name": raw["f58"],
    "tradingDate": timestamp_instant(observed_at, "East Money quote timestamp")
      .astimezone(SHANGHAI_TIMEZONE).date().isoformat(),
    "observedAt": observed_at,
    "open": eastmoney_price(raw["f46"], raw["f59"]),
    "high": eastmoney_price(raw["f44"], raw["f59"]),
    "low": eastmoney_price(raw["f45"], raw["f59"]),
    "last": eastmoney_price(raw["f43"], raw["f59"]),
    "previousClose": eastmoney_price(raw["f60"], raw["f59"]),
    "volume": raw["f47"], "turnover": raw["f48"],
  }
  data = map_quote(record, target)
  metadata = {"capturedAt": fetched_at, "upstreamSource": "eastmoney-public-web", "sourceKind": "public-web"}
  result = success(
    data, metadata, source="public-web", sourceUrl=EASTMONEY_QUOTE_URL, observedAt=observed_at,
    currency="CNY", unit="price:CNY;volume:lot;turnover:CNY",
    adjustment="none", timezone="Asia/Shanghai",
  )
  result["warnings"].append("Public-web source has no availability SLA; values use East Money field scaling.")
  return result


def public_instrument(request: dict[str, Any]) -> dict[str, Any]:
  target = validate_instrument(request["params"]["instrument"], "params.instrument")
  raw, fetched_at = public_quote_document(
    target, request["limits"]["networkTimeoutMs"], "instrument-reference",
  )
  data = {
    "id": target, "canonical": canonical(target), "name": available(raw["f58"]),
    "quoteCurrency": available("CNY"), "providerSymbols": {"eastmoney": eastmoney_secid(target)},
  }
  metadata = {"capturedAt": fetched_at, "upstreamSource": "eastmoney-public-web", "sourceKind": "public-web"}
  result = success(data, metadata, source="public-web", sourceUrl=EASTMONEY_QUOTE_URL, currency="CNY", timezone="Asia/Shanghai")
  result["warnings"].append("Public-web source has no availability SLA.")
  return result


def public_bars(request: dict[str, Any]) -> dict[str, Any]:
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  adjustment = {"none": "0", "qfq": "1", "hfq": "2"}[params["adjustment"]]
  effective_end = min(
    params["endDate"],
    as_of_shanghai_date(params.get("asOf"), params["endDate"], daily_close=True),
  )
  fail(effective_end < params["startDate"], "no-data", "no-data",
       "requested as-of time precedes the bars date range")
  document = public_json(EASTMONEY_BARS_URL, {
    "secid": eastmoney_secid(target), "klt": "101", "fqt": adjustment,
    "beg": params["startDate"].replace("-", ""), "end": effective_end.replace("-", ""),
    "lmt": str(params["limit"]), "fields1": "f1,f2,f3,f4,f5,f6",
    "fields2": "f51,f52,f53,f54,f55,f56,f57",
  }, request["limits"]["networkTimeoutMs"], capability="market-bars")
  raw = eastmoney_payload(document, frozenset({"code", "name", "klines"}), "East Money bars")
  fail(raw["code"] != target["symbol"] or not isinstance(raw["name"], str),
       "schema-drift", "schema-drift", "East Money bars identity is invalid")
  fail(not isinstance(raw["klines"], list), "schema-drift", "schema-drift",
       "East Money bars klines must be an array")
  bars: list[dict[str, Any]] = []
  for index, row in enumerate(raw["klines"]):
    fail(not isinstance(row, str), "schema-drift", "schema-drift",
         f"East Money bars row {index} must be a string")
    columns = row.split(",")
    fail(len(columns) != 7, "schema-drift", "schema-drift",
         f"East Money bars row {index} expected 7 columns, got {len(columns)}")
    try:
      values = [float(value) for value in columns[1:]]
    except ValueError as exc:
      raise ProviderFailure("schema-drift", "schema-drift",
                            f"East Money bars row {index} has a non-numeric field") from exc
    fail(not all(math.isfinite(value) for value in values), "schema-drift", "schema-drift",
         f"East Money bars row {index} has a non-finite field")
    bars.append({
      "date": iso_date(columns[0], f"East Money bars row {index} date"),
      "open": values[0], "close": values[1], "high": values[2], "low": values[3],
      "volume": values[4], "turnover": values[5],
    })
  fail(not bars, "no-data", "no-data", "East Money returned no bars in requested date range")
  fail(any(bar["date"] < params["startDate"] or bar["date"] > effective_end for bar in bars),
       "schema-drift", "schema-drift",
       "East Money returned bars outside the requested or as-of date range")
  fail(len({bar["date"] for bar in bars}) != len(bars)
       or bars != sorted(bars, key=lambda item: item["date"]),
       "schema-drift", "schema-drift", "East Money bars are duplicated or unsorted")
  fail(len(bars) > params["limit"], "schema-drift", "schema-drift",
       "East Money returned more records than requested")
  fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
  data = {
    "instrument": target, "interval": "1d", "adjustment": params["adjustment"],
    "startDate": bars[0]["date"], "endDate": bars[-1]["date"], "bars": bars,
    "returned": len(bars), "truncated": len(bars) == params["limit"],
  }
  metadata = {"capturedAt": fetched_at, "upstreamSource": "eastmoney-public-web", "sourceKind": "public-web"}
  result = success(
    data, metadata, source="public-web", sourceUrl=EASTMONEY_BARS_URL, observedAt=bars[-1]["date"],
    currency="CNY", unit="price:CNY;volume:lot;turnover:CNY",
    adjustment=params["adjustment"], timezone="Asia/Shanghai",
  )
  result["warnings"].append("Public-web source has no availability SLA; truncated may require a narrower date range.")
  return result


def public_fundamentals(request: dict[str, Any]) -> dict[str, Any]:
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  document = public_json(SINA_FINANCIAL_URL, {
    "paperCode": ("sh" if target["exchange"] == "SSE" else
                  "bj" if target["exchange"] == "BSE" else "sz") + target["symbol"],
    "source": "lrb", "type": "0", "page": "1", "num": str(params["limit"]),
  }, request["limits"]["networkTimeoutMs"], capability="fundamentals")
  fail(not isinstance(document, dict) or not isinstance(document.get("result"), dict),
       "schema-drift", "schema-drift", "Sina fundamentals result schema changed")
  result_data = document["result"].get("data")
  fail(not isinstance(result_data, dict), "schema-drift", "schema-drift",
       "Sina fundamentals result.data schema changed")
  report_list = result_data.get("report_list")
  fail(not isinstance(report_list, dict), "schema-drift", "schema-drift",
       "Sina fundamentals report_list schema changed")
  periods: list[dict[str, Any]] = []
  for raw_period in sorted(report_list, reverse=True):
    fail(not isinstance(raw_period, str) or len(raw_period) != 8 or not raw_period.isdigit(),
         "schema-drift", "schema-drift", "Sina fundamentals period key is invalid")
    obj = report_list[raw_period]
    fail(not isinstance(obj, dict) or not isinstance(obj.get("data"), list),
         "schema-drift", "schema-drift", "Sina fundamentals period data schema changed")
    fiscal = iso_date(f"{raw_period[:4]}-{raw_period[4:6]}-{raw_period[6:]}", "Sina fiscal period")
    published_raw = (obj.get("publish_date") or obj.get("notice_date")
                     or obj.get("announcement_date"))
    published = None
    if isinstance(published_raw, str) and len(published_raw) >= 10:
      published = iso_date(published_raw[:10], "Sina publication date")
      fail(published < fiscal, "schema-drift", "schema-drift",
           "Sina publication date precedes the fiscal period")
    fields: dict[str, Any] = {}
    for item_index, item in enumerate(obj["data"]):
      fail(not isinstance(item, dict)
           or not {"item_title", "item_value"}.issubset(item),
           "schema-drift", "schema-drift",
           f"Sina fundamentals line {item_index} schema changed")
      title = item["item_title"]
      fail(not isinstance(title, str), "schema-drift", "schema-drift",
           f"Sina fundamentals line {item_index} title is invalid")
      if not title or item["item_value"] in (None, "", "--", "-"):
        continue
      try:
        number = float(str(item["item_value"]).replace(",", ""))
      except ValueError as exc:
        raise ProviderFailure("schema-drift", "schema-drift",
                              f"Sina fundamentals field {title} is non-numeric") from exc
      fail(not math.isfinite(number), "schema-drift", "schema-drift",
           f"Sina fundamentals field {title} is non-finite")
      fields[title] = available(number)
    fail(not fields, "schema-drift", "schema-drift", "Sina fundamentals period has no numeric fields")
    periods.append({
      "fiscalPeriod": fiscal, "publishedAt": published, "availableAt": published,
      "currency": "CNY", "unit": "raw-source-unit", "scope": "consolidated",
      "fields": fields,
    })
  if params.get("asOf") is not None:
    fail(any(period["availableAt"] is None for period in periods),
         "schema-drift", "schema-drift",
         "Sina response lacks publication dates; PIT-safe as-of filtering is impossible")
    as_of = as_of_shanghai_date(params["asOf"], params["asOf"])
    periods = [period for period in periods if period["availableAt"] <= as_of]
  fail(not periods, "no-data", "no-data", "Sina returned no fundamentals available at requested as-of time")
  periods, truncated = slice_rows(periods, params["limit"])
  fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
  newest = periods[0]
  pit_safe = all(period["availableAt"] is not None for period in periods)
  data = {
    "instrument": target, "periods": periods, "returned": len(periods),
    "truncated": truncated, "pitSafe": pit_safe,
  }
  metadata = {"capturedAt": fetched_at, "upstreamSource": "sina-public-web-finance", "sourceKind": "public-web"}
  optional_provenance = {} if not pit_safe else {
    "publishedAt": newest["publishedAt"], "availableAt": newest["availableAt"],
  }
  result = success(
    data, metadata, source="public-web", sourceUrl=SINA_FINANCIAL_URL,
    fiscalPeriod=newest["fiscalPeriod"], currency="CNY", unit="raw-source-unit",
    timezone="Asia/Shanghai", **optional_provenance,
  )
  result["warnings"].append(
    "Sina statement labels and raw units are retained; cross-period arithmetic requires field-level unit review.",
  )
  if not data["pitSafe"]:
    result["status"] = "partial"
    result["warnings"].append(
      "Sina did not publish an announcement date; the result is not safe for historical as-of use.",
    )
  return result


def cninfo_org_id(code: str, timeout_ms: int) -> str:
  document = public_json(CNINFO_STOCK_MAP_URL, None, timeout_ms, capability="disclosures")
  fail(not isinstance(document, dict) or not isinstance(document.get("stockList"), list),
       "schema-drift", "schema-drift", "CNInfo stock map schema changed")
  matches = []
  for index, row in enumerate(document["stockList"]):
    fail(not isinstance(row, dict) or not {"code", "orgId"}.issubset(row),
         "schema-drift", "schema-drift", f"CNInfo stock map row {index} schema changed")
    if row["code"] == code:
      matches.append(row["orgId"])
  fail(len(matches) == 0, "no-data", "no-data", "CNInfo stock map has no matching instrument")
  fail(len(matches) > 1 or not isinstance(matches[0], str) or not matches[0],
       "schema-drift", "schema-drift", "CNInfo stock map has duplicate or invalid orgId")
  return matches[0]


def normalize_disclosure_rows(
  rows: Any,
  start_date: str,
  end_date: str,
  cutoff: datetime | None,
  source: str,
) -> list[dict[str, str]]:
  fail(not isinstance(rows, list), "schema-drift", "schema-drift",
       f"{source} disclosure rows must be an array")
  items: list[dict[str, str]] = []
  for index, row in enumerate(rows):
    fail(not isinstance(row, dict), "schema-drift", "schema-drift",
         f"{source} disclosure row {index} must be an object")
    if source == "cninfo":
      required = {"announcementId", "announcementTitle", "announcementTypeName", "announcementTime"}
      fail(not required.issubset(row), "schema-drift", "schema-drift",
           f"CNInfo disclosure row {index} fields changed")
      published_value = row["announcementTime"]
      fail(isinstance(published_value, bool) or not isinstance(published_value, (int, float)),
           "schema-drift", "schema-drift", "CNInfo announcementTime is invalid")
      published_at = datetime.fromtimestamp(published_value / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
      item = {
        "id": non_empty_string(row["announcementId"], "CNInfo announcementId"),
        "title": non_empty_string(row["announcementTitle"], "CNInfo announcementTitle"),
        "category": non_empty_string(row["announcementTypeName"], "CNInfo announcementTypeName"),
        "publishedAt": published_at,
        "documentRef": f"https://www.cninfo.com.cn/new/disclosure/detail?annoId={urllib.parse.quote(str(row['announcementId']))}",
      }
    elif source == "szse":
      required = {"id", "title", "publishTime", "attachPath"}
      fail(not required.issubset(row), "schema-drift", "schema-drift",
           f"SZSE disclosure row {index} fields changed")
      published_value = str(row["publishTime"])
      published_instant = timestamp_instant(
        published_value, "SZSE publishTime", assume_shanghai=True,
      )
      published_at = published_instant.isoformat().replace("+00:00", "Z")
      item = {
        "id": non_empty_string(row["id"], "SZSE disclosure id"),
        "title": non_empty_string(row["title"], "SZSE disclosure title"),
        "category": str(row.get("bigCategoryName") or "announcement"),
        "publishedAt": published_at,
        "documentRef": "https://disc.static.szse.cn/download" + non_empty_string(row["attachPath"], "SZSE attachPath"),
      }
    else:
      required = {"art_code", "title", "notice_date"}
      fail(not required.issubset(row), "schema-drift", "schema-drift",
           f"East Money disclosure row {index} fields changed")
      item = {
        "id": non_empty_string(row["art_code"], "East Money art_code"),
        "title": non_empty_string(row["title"], "East Money disclosure title"),
        "category": str(row.get("columns") or "announcement"),
        "publishedAt": iso_timestamp(str(row["notice_date"]), "East Money notice_date"),
        "documentRef": f"https://pdf.dfcfw.com/pdf/H2_{urllib.parse.quote(str(row['art_code']))}_1.pdf",
      }
    published_instant = timestamp_instant(
      item["publishedAt"], f"{source} disclosure publishedAt", assume_shanghai=source == "szse",
    )
    published_date = published_instant.astimezone(SHANGHAI_TIMEZONE).date().isoformat()
    if start_date <= published_date <= end_date and (cutoff is None or published_instant <= cutoff):
      items.append(item)
  fail(len({item["id"] for item in items}) != len(items), "schema-drift", "schema-drift",
       "public disclosures contain duplicate ids")
  items.sort(
    key=lambda item: timestamp_instant(
      item["publishedAt"], f"{source} disclosure publishedAt", assume_shanghai=source == "szse",
    ),
    reverse=True,
  )
  return items


def collect_disclosure_pages(
  fetch_page: Callable[[int, int], Any],
  start_date: str,
  end_date: str,
  cutoff: datetime | None,
  limit: int,
  source: str,
) -> list[dict[str, str]]:
  rows: list[Any] = []
  max_pages = (HARD_MAX_RECORDS + PUBLIC_DISCLOSURE_PAGE_SIZE - 1) // PUBLIC_DISCLOSURE_PAGE_SIZE
  for page_number in range(1, max_pages + 1):
    page = fetch_page(page_number, PUBLIC_DISCLOSURE_PAGE_SIZE)
    fail(not isinstance(page, list), "schema-drift", "schema-drift",
         f"{source} disclosure rows must be an array")
    fail(len(page) > PUBLIC_DISCLOSURE_PAGE_SIZE, "schema-drift", "schema-drift",
         f"{source} disclosure page exceeded requested page size")
    fail(len(rows) + len(page) > HARD_MAX_RECORDS, "schema-drift", "output-limit",
         f"{source} disclosure scan exceeded hard record limit")
    rows.extend(page)
    items = normalize_disclosure_rows(rows, start_date, end_date, cutoff, source)
    if len(items) > limit:
      return items
    if len(page) < PUBLIC_DISCLOSURE_PAGE_SIZE:
      return items
  raise ProviderFailure(
    "schema-drift", "output-limit",
    f"{source} disclosure scan reached hard record limit before exhaustion", False,
  )


def public_disclosures(request: dict[str, Any]) -> dict[str, Any]:
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  timeout_ms = request["limits"]["networkTimeoutMs"]
  cutoff = disclosure_cutoff(params.get("asOf"))
  upstream_end_date = min(
    params["endDate"],
    cutoff.astimezone(SHANGHAI_TIMEZONE).date().isoformat() if cutoff is not None else params["endDate"],
  )
  fail(upstream_end_date < params["startDate"], "no-data", "no-data",
       "requested as-of time precedes the disclosure date range")
  source_url: str
  if target["exchange"] == "SZSE":
    def fetch_szse_page(page_number: int, page_size: int) -> Any:
      body = json.dumps({
        "channelCode": ["listedNotice_disc"], "pageSize": page_size,
        "pageNum": page_number, "stock": [target["symbol"]],
        "seDate": [params["startDate"], upstream_end_date],
      }).encode("utf-8")
      document = public_json(
        SZSE_ANNOUNCEMENT_URL, None, timeout_ms, capability="disclosures", body=body, headers={
        "Content-Type": "application/json",
        "Referer": "https://www.szse.cn/disclosure/listed/notice/index.html",
        },
      )
      fail(not isinstance(document, dict) or not isinstance(document.get("data"), list),
           "schema-drift", "schema-drift", "SZSE disclosure response schema changed")
      return document["data"]

    items = collect_disclosure_pages(
      fetch_szse_page, params["startDate"], upstream_end_date, cutoff, params["limit"], "szse",
    )
    upstream_source, source_url = "szse-official-disclosures", SZSE_ANNOUNCEMENT_URL
    source_kind = "official"
  else:
    org_id = cninfo_org_id(target["symbol"], timeout_ms)
    def fetch_cninfo_page(page_number: int, page_size: int) -> Any:
      body = urllib.parse.urlencode({
        "stock": f"{target['symbol']},{org_id}", "tabName": "fulltext",
        "pageSize": str(page_size), "pageNum": str(page_number), "column": "",
        "category": "", "plate": "", "seDate": f"{params['startDate']}~{upstream_end_date}",
        "searchkey": "", "secid": "", "sortName": "", "sortType": "", "isHLtitle": "true",
      }).encode("utf-8")
      document = public_json(
        CNINFO_ANNOUNCEMENT_URL, None, timeout_ms, capability="disclosures", body=body, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://www.cninfo.com.cn/new/disclosure",
        "Origin": "https://www.cninfo.com.cn",
        },
      )
      fail(not isinstance(document, dict) or not isinstance(document.get("announcements"), list),
           "schema-drift", "schema-drift", "CNInfo disclosure response schema changed")
      return document["announcements"]

    items = collect_disclosure_pages(
      fetch_cninfo_page, params["startDate"], upstream_end_date, cutoff, params["limit"], "cninfo",
    )
    upstream_source, source_url, source_kind = "cninfo-public-disclosures", CNINFO_ANNOUNCEMENT_URL, "public-web"
  fail(not items, "no-data", "no-data", "public disclosure source returned no documents in range")
  items, truncated = slice_rows(items, params["limit"])
  fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
  data = {"instrument": target, "items": items, "returned": len(items), "truncated": truncated}
  metadata = {"capturedAt": fetched_at, "upstreamSource": upstream_source, "sourceKind": source_kind}
  return success(data, metadata, source="public-web", sourceUrl=source_url, publishedAt=items[0]["publishedAt"], timezone="Asia/Shanghai")


def load_generated_official(request: dict[str, Any], capability: str) -> Any:
  try:
    from generated import astock_upstream  # type: ignore[import-not-found]
  except (ImportError, ModuleNotFoundError) as exc:
    raise ProviderFailure(
      "provider-error", "provider-error",
      "generated official a-stock module is unavailable; run the pinned upstream extractor", False,
    ) from exc
  # The vendored module is immutable audit/generated code, but its HTTP helper
  # must still obey the runtime's fixed-host, HTTPS-only network boundary.
  astock_upstream._official_get = lambda url, params=None, referer=None: generated_official_get(
    astock_upstream.requests, capability, url, params, referer,
    timeout_ms=request["limits"]["networkTimeoutMs"],
    max_bytes=request["limits"]["maxOutputBytes"],
  )
  return astock_upstream


def generated_official_get(
  requests_module: Any,
  capability: str,
  url: str,
  params: dict[str, Any] | None = None,
  referer: str | None = None,
  *,
  timeout_ms: int,
  max_bytes: int,
) -> Any:
  canonical_url = canonical_public_url(url, capability)
  if referer is not None:
    validate_public_url(referer, capability)
  response = requests_module.get(
    canonical_url,
    params=params,
    headers={"User-Agent": "Mozilla/5.0", "Referer": referer or canonical_url},
    timeout=(timeout_ms / 1000, timeout_ms / 1000),
    allow_redirects=False,
    stream=True,
  )
  try:
    status = response.status_code
    fail(300 <= status < 400, "provider-error", "provider-error",
         "official source redirect is not allowed")
    response.raise_for_status()
    raw = bytearray()
    for chunk in response.iter_content(chunk_size=min(64 * 1024, max_bytes + 1)):
      if not chunk:
        continue
      raw.extend(chunk)
      fail(len(raw) > max_bytes, "schema-drift", "output-limit",
           "official response exceeds byte limit")
    response._content = bytes(raw)
    response._content_consumed = True
    response.url = canonical_url
    return response
  finally:
    response.close()


def public_index(request: dict[str, Any]) -> dict[str, Any]:
  params = request["params"]
  target = validate_instrument(params["instrument"], "params.instrument")
  fail(target["assetType"] != "index", "invalid-request", "invalid-request",
       "index capability requires an index instrument")
  upstream = load_generated_official(request, "index")
  try:
    frame = upstream.index_constituents(target["symbol"], provider=params["officialProvider"])
  except ValueError as exc:
    raise ProviderFailure("schema-drift", "schema-drift",
                          "official index source returned invalid data", False) from exc
  except (RuntimeError, OSError) as exc:
    raise ProviderFailure("provider-error", "provider-error",
                          "official index source request failed", True) from exc
  fail(not hasattr(frame, "to_dict") or not hasattr(frame, "columns"),
       "schema-drift", "schema-drift", "official index adapter did not return a table")
  columns = set(str(column) for column in frame.columns)
  expected = {"date", "index_code", "code", "name", "exchange", "source", "source_url", "fetched_at"}
  fail(columns != expected, "schema-drift", "schema-drift",
       f"official index columns changed: missing={sorted(expected-columns)} extra={sorted(columns-expected)}")
  rows = frame.to_dict("records")
  fail(not isinstance(rows, list) or not rows, "no-data", "no-data", "official index source returned no constituents")
  constituents: list[dict[str, Any]] = []
  snapshot_dates: set[str] = set()
  for index, row in enumerate(rows):
    fail(not isinstance(row, dict) or set(row) != expected, "schema-drift", "schema-drift",
         f"official index row {index} schema changed")
    fail(str(row["index_code"]).zfill(6) != target["symbol"], "schema-drift", "schema-drift",
         "official index source returned a different index")
    snapshot = iso_date(str(row["date"]), f"official index row {index} date")
    snapshot_dates.add(snapshot)
    exchange = {"SH": "SSE", "SZ": "SZSE", "BJ": "BSE"}.get(str(row["exchange"]))
    fail(exchange is None, "schema-drift", "schema-drift", "official index exchange is unsupported")
    symbol = str(row["code"]).zfill(6)
    fail(len(symbol) != 6 or not symbol.isdigit(), "schema-drift", "schema-drift",
         "official index constituent code is invalid")
    non_empty_string(row["source_url"], "official index source_url")
    constituents.append({
      "instrument": {"market": "CN", "exchange": exchange, "symbol": symbol, "assetType": "equity"},
      "name": non_empty_string(row["name"], f"official index row {index} name"),
      "weight": missing("Constituent membership endpoint does not include weights."),
    })
  fail(len(snapshot_dates) != 1, "schema-drift", "schema-drift",
       "official index response mixed snapshot dates")
  snapshot = next(iter(snapshot_dates))
  fail(params.get("asOf") is not None
       and snapshot > as_of_shanghai_date(params["asOf"], params["asOf"]),
       "no-data", "no-data", "official index snapshot is newer than requested as-of time")
  fail(len({canonical(item["instrument"]) for item in constituents}) != len(constituents),
       "schema-drift", "schema-drift", "official index constituents contain duplicates")
  constituents, truncated = slice_rows(constituents, params["limit"])
  data = {
    "instrument": target, "asOf": snapshot, "constituents": constituents,
    "returned": len(constituents), "truncated": truncated,
  }
  fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
  provider = params["officialProvider"]
  metadata = {"capturedAt": fetched_at, "upstreamSource": f"{provider}-official-index", "sourceKind": "official"}
  source_url = (CSI_INDEX_TEMPLATE.format(code=target["symbol"])
                if provider == "csi" else CNI_INDEX_URL)
  return success(data, metadata, source="public-web", sourceUrl=source_url, observedAt=snapshot, currency="CNY", unit="membership", timezone="Asia/Shanghai")


def public_calendar(request: dict[str, Any]) -> dict[str, Any]:
  params = request["params"]
  start = date.fromisoformat(params["startDate"])
  effective_end = min(
    params["endDate"], as_of_shanghai_date(params.get("asOf"), params["endDate"]),
  )
  fail(effective_end < params["startDate"], "no-data", "no-data",
       "requested as-of time precedes the calendar date range")
  end = date.fromisoformat(effective_end)
  months: list[tuple[int, int]] = []
  year, month = start.year, start.month
  while (year, month) <= (end.year, end.month):
    months.append((year, month))
    month += 1
    if month == 13:
      year, month = year + 1, 1
  upstream = load_generated_official(request, "trading-calendar")
  days: list[dict[str, Any]] = []
  source_urls: set[str] = set()
  for year, month in months:
    try:
      frame = upstream.trading_calendar(year, month)
    except ValueError as exc:
      raise ProviderFailure("schema-drift", "schema-drift",
                            "official calendar source returned invalid data", False) from exc
    except (RuntimeError, OSError) as exc:
      raise ProviderFailure("provider-error", "provider-error",
                            "official trading calendar request failed", True) from exc
    fail(not hasattr(frame, "to_dict") or not hasattr(frame, "columns"),
         "schema-drift", "schema-drift", "official calendar adapter did not return a table")
    columns = set(str(column) for column in frame.columns)
    expected = {"date", "is_open", "source", "source_url", "fetched_at"}
    fail(columns != expected, "schema-drift", "schema-drift",
         f"official calendar columns changed: missing={sorted(expected-columns)} extra={sorted(columns-expected)}")
    for index, row in enumerate(frame.to_dict("records")):
      fail(not isinstance(row, dict) or set(row) != expected, "schema-drift", "schema-drift",
           f"official calendar row {index} schema changed")
      mapped_date = iso_date(str(row["date"]), f"official calendar row {index} date")
      fail(type(row["is_open"]) is not bool, "schema-drift", "schema-drift",
           f"official calendar row {index} is_open must be boolean")
      source_urls.add(non_empty_string(row["source_url"], "official calendar source_url"))
      if params["startDate"] <= mapped_date <= effective_end:
        days.append({
          "date": mapped_date, "isTradingDay": row["is_open"],
          "session": "09:30-11:30,13:00-15:00 Asia/Shanghai" if row["is_open"] else None,
        })
  fail(not days, "no-data", "no-data", "official calendar returned no days in requested range")
  fail(len({item["date"] for item in days}) != len(days), "schema-drift", "schema-drift",
       "official calendar returned duplicate dates")
  days.sort(key=lambda item: item["date"])
  days, truncated = slice_rows(days, params["limit"])
  data = {
    "exchange": params["exchange"], "startDate": days[0]["date"], "endDate": days[-1]["date"],
    "days": days, "returned": len(days), "truncated": truncated,
  }
  fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
  metadata = {"capturedAt": fetched_at, "upstreamSource": "szse-official-calendar", "sourceKind": "official"}
  result = success(data, metadata, source="public-web", sourceUrl=SZSE_CALENDAR_URL, observedAt=days[-1]["date"], timezone="Asia/Shanghai")
  if params["exchange"] != "SZSE":
    result["warnings"].append(
      "Mainland exchanges normally share trading dates; calendar source is SZSE official and the requested exchange is reported explicitly.",
    )
  return result


PUBLIC_HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
  "instrument-reference": public_instrument,
  "quote": public_quote,
  "market-bars": public_bars,
  "fundamentals": public_fundamentals,
  "disclosures": public_disclosures,
  "index": public_index,
  "trading-calendar": public_calendar,
}


def validate_limits(value: Any) -> dict[str, int]:
  limits = exact_keys(value, LIMIT_KEYS, "limits")
  maxima = {
    "maxRecords": HARD_MAX_RECORDS,
    "maxDateSpanDays": HARD_MAX_DATE_SPAN_DAYS,
    "maxOutputBytes": HARD_MAX_OUTPUT_BYTES,
    "networkTimeoutMs": HARD_MAX_NETWORK_TIMEOUT_MS,
  }
  for key, maximum in maxima.items():
    candidate = limits[key]
    fail(not isinstance(candidate, int) or isinstance(candidate, bool) or candidate < 1 or candidate > maximum,
         "invalid-request", "invalid-request", f"limits.{key} must be from 1 through {maximum}")
  return limits  # type: ignore[return-value]


def validate_date_span(params: dict[str, Any], limits: dict[str, int]) -> None:
  if "startDate" not in params and "endDate" not in params:
    return
  start = date.fromisoformat(iso_date(params.get("startDate"), "params.startDate"))
  end = date.fromisoformat(iso_date(params.get("endDate"), "params.endDate"))
  fail(start > end, "invalid-request", "invalid-request", "startDate must not be after endDate")
  fail((end - start).days + 1 > limits["maxDateSpanDays"], "invalid-request", "input-limit",
       "date span exceeds configured limit")


def validate_params(operation: str, params: dict[str, Any], limits: dict[str, int]) -> None:
  allowed, required = PARAM_KEYS[operation]
  actual = set(params)
  fail(bool(actual - allowed) or bool(required - actual), "invalid-request", "invalid-request",
       f"{operation} params fields are invalid: missing={sorted(required - actual)} extra={sorted(actual - allowed)}")
  if "instrument" in params:
    validate_instrument(params["instrument"], "params.instrument")
  if operation == "trading-calendar":
    fail(params["exchange"] not in {"SSE", "SZSE", "BSE"},
         "invalid-request", "invalid-request", "params.exchange is unsupported")
  if "asOf" in params:
    validate_request_as_of(params["asOf"])
  if operation == "market-bars":
    fail(params["adjustment"] not in {"none", "qfq", "hfq"}
         or params["interval"] != "1d", "invalid-request", "invalid-request",
         "market-bars adjustment or interval is unsupported")
  if operation == "fundamentals":
    fail(params["statement"] != "income", "invalid-request", "invalid-request",
         "only income statement is currently supported")
  if operation == "index":
    fail(params["officialProvider"] not in {"csi", "cni"},
         "invalid-request", "invalid-request", "officialProvider must be csi or cni")
  validate_date_span(params, limits)
  if "limit" in params:
    limit = params["limit"]
    fail(not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > limits["maxRecords"],
         "invalid-request", "input-limit", "params.limit exceeds configured record limit")


def handle(request: Any) -> tuple[dict[str, Any], int]:
  value = exact_keys(request, REQUEST_KEYS if isinstance(request, dict) and "fixtureRoot" in request
                     else REQUEST_KEYS - {"fixtureRoot"}, "request")
  fail(value["version"] != VERSION, "invalid-request", "invalid-request",
       "unsupported A-stock protocol version")
  request_id = value["id"]
  fail(not isinstance(request_id, str) or not request_id, "invalid-request", "invalid-request",
       "request id must be a non-empty string")
  operation = value["operation"]
  fail(operation not in ALLOWED_OPERATIONS, "unsupported", "unsupported-operation",
       "operation is not allowed")
  source = value["source"]
  fail(source not in ALLOWED_SOURCES, "invalid-request", "unsupported-source", "source is not allowed")
  fail(source == "fixture" and "fixtureRoot" not in value, "invalid-request", "invalid-request",
       "fixtureRoot is required for fixture source")
  fail(source == "public-web" and "fixtureRoot" in value, "invalid-request", "invalid-request",
       "fixtureRoot is forbidden for public-web source")
  params = value["params"]
  fail(not isinstance(params, dict), "invalid-request", "invalid-request", "params must be an object")
  limits = validate_limits(value["limits"])
  value["limits"] = limits
  validate_params(operation, params, limits)
  if source == "public-web":
    fail(operation not in PUBLIC_OPERATIONS, "unsupported", "unsupported-operation",
         f"public-web does not implement {operation}")
    result = PUBLIC_HANDLERS[operation](value)
  else:
    result = FIXTURE_HANDLERS[operation](value)
  return {"version": VERSION, "id": request_id, "ok": True, "data": result}, limits["maxOutputBytes"]


def json_safe(value: Any) -> Any:
  if value is None or isinstance(value, (str, bool, int)):
    return value
  if isinstance(value, float):
    fail(not math.isfinite(value), "schema-drift", "protocol-error", "result contains a non-finite number")
    return value
  if isinstance(value, dict):
    return {str(key): json_safe(child) for key, child in value.items()}
  if isinstance(value, (list, tuple)):
    return [json_safe(child) for child in value]
  raise ProviderFailure("schema-drift", "protocol-error",
                        f"result contains unsupported value {type(value).__name__}")


def encode(value: dict[str, Any]) -> bytes:
  return (json.dumps(json_safe(value), ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def failure(request_id: str | None, error: ProviderFailure) -> dict[str, Any]:
  return {
    "version": VERSION, "id": request_id, "ok": False,
    "error": {"kind": error.kind, "code": error.code, "message": str(error), "retryable": error.retryable},
  }


def emit(value: dict[str, Any]) -> None:
  sys.stdout.buffer.write(encode(value))
  sys.stdout.buffer.flush()


def main() -> None:
  for raw_line in sys.stdin.buffer:
    request_id: str | None = None
    try:
      fail(len(raw_line) > MAX_REQUEST_BYTES, "invalid-request", "input-limit",
           "request exceeds hard input limit")
      request = strict_json(raw_line, "request")
      if isinstance(request, dict) and isinstance(request.get("id"), str):
        request_id = request["id"]
      response, max_output = handle(request)
      payload = encode(response)
      if len(payload) > max_output:
        response = failure(request_id, ProviderFailure(
          "schema-drift", "output-limit", "response exceeds configured output limit", False,
        ))
      emit(response)
    except ProviderFailure as exc:
      emit(failure(request_id, exc))
    except Exception:
      emit(failure(request_id, ProviderFailure(
        "provider-error", "provider-error", "A-stock runner encountered an internal error", False,
      )))


if __name__ == "__main__":
  main()
