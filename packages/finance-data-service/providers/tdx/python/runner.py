#!/usr/bin/env python3
"""Bounded JSON protocol adapter for community TDX-compatible quote servers.

Only the allowlisted ``health``, ``quote`` and ``market-bars`` operations are
accepted. Protocol JSON is written to stdout; diagnostics go to stderr.
"""

from __future__ import annotations

import json
import math
import signal
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

VERSION = "1"
MAX_INPUT_BYTES = 64 * 1024
MAX_SERVERS = 16
MAX_SERVER_ATTEMPTS = 3
MAX_BAR_COUNT = 800
CHINA_TZ = timezone(timedelta(hours=8))

BAR_CATEGORIES = {
    "5m": 0,
    "15m": 1,
    "30m": 2,
    "1h": 3,
    "1d": 4,
    "1w": 5,
    "1mo": 6,
    "1m": 8,
}

QUOTE_FIELDS = (
    "price",
    "last_close",
    "open",
    "high",
    "low",
    "vol",
    "amount",
    "bid1",
    "ask1",
)
BAR_FIELDS = ("open", "high", "low", "close", "vol", "amount")


class RequestError(ValueError):
  """The caller supplied a request outside the curated protocol boundary."""


class NoDataError(RuntimeError):
  """The connected server returned no rows for an otherwise valid query."""


class TransportError(RuntimeError):
  """Every bounded server attempt failed."""


class SchemaDriftError(RuntimeError):
  """A connected server returned a payload outside the verified schema."""


def _handle_termination(_signum: int, _frame: Any) -> None:
  raise InterruptedError("runner terminated")


signal.signal(signal.SIGTERM, _handle_termination)


def is_plain_object(value: Any) -> bool:
  return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def finite_number(value: Any) -> int | float | None:
  if value is None:
    return None
  if isinstance(value, bool) or not isinstance(value, (int, float)):
    raise SchemaDriftError("TDX response contained a non-numeric market field")
  if isinstance(value, float) and not math.isfinite(value):
    return None
  return value


def validated_request() -> dict[str, Any]:
  raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
  if len(raw) > MAX_INPUT_BYTES:
    raise RequestError("request exceeded the input byte limit")
  try:
    request = json.loads(raw)
  except (UnicodeDecodeError, json.JSONDecodeError) as error:
    raise RequestError("request was not valid UTF-8 JSON") from error
  if not is_plain_object(request):
    raise RequestError("request must be a JSON object")
  allowed = {"version", "operation", "params", "servers", "maxServerAttempts", "connectTimeoutMs"}
  if set(request) - allowed:
    raise RequestError("request contained non-whitelisted fields")
  if request.get("version") != VERSION:
    raise RequestError("unsupported request version")
  if request.get("operation") not in {"health", "quote", "market-bars"}:
    raise RequestError("unsupported operation")
  if not is_plain_object(request.get("params")):
    raise RequestError("params must be an object")
  servers = request.get("servers")
  if not isinstance(servers, list) or not 1 <= len(servers) <= MAX_SERVERS:
    raise RequestError("servers must contain 1-16 entries")
  for server in servers:
    if not is_plain_object(server) or set(server) != {"host", "port"}:
      raise RequestError("each server must contain only host and port")
    if not isinstance(server["host"], str) or not server["host"]:
      raise RequestError("server host must be a non-empty string")
    if not isinstance(server["port"], int) or isinstance(server["port"], bool) \
        or not 1 <= server["port"] <= 65535:
      raise RequestError("server port must be between 1 and 65535")
  attempts = request.get("maxServerAttempts")
  if not isinstance(attempts, int) or isinstance(attempts, bool) or not 1 <= attempts <= MAX_SERVER_ATTEMPTS:
    raise RequestError("maxServerAttempts must be between 1 and 3")
  timeout_ms = request.get("connectTimeoutMs")
  if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 100 <= timeout_ms <= 30_000:
    raise RequestError("connectTimeoutMs must be between 100 and 30000")
  validate_params(request["operation"], request["params"])
  return request


def validate_params(operation: str, params: dict[str, Any]) -> None:
  if operation == "health":
    if params:
      raise RequestError("health does not accept parameters")
    return
  allowed = {"instrument"} if operation == "quote" else {"instrument", "interval", "offset", "count"}
  if set(params) != allowed:
    raise RequestError(f"{operation} parameters did not match the allowlist")
  instrument = params.get("instrument")
  if not is_plain_object(instrument) or set(instrument) != {"market", "exchange", "symbol", "assetType"}:
    raise RequestError("instrument did not match the protocol schema")
  if instrument["market"] not in (0, 1):
    raise RequestError("instrument market must be a TDX market number")
  if instrument["exchange"] not in ("SSE", "SZSE"):
    raise RequestError("instrument exchange has not been verified")
  if instrument["assetType"] not in ("equity", "index", "etf", "fund"):
    raise RequestError("instrument asset type has not been verified")
  symbol = instrument["symbol"]
  if not isinstance(symbol, str) or len(symbol) != 6 or not symbol.isdigit():
    raise RequestError("instrument symbol must contain six digits")
  if operation == "market-bars":
    if params["interval"] not in BAR_CATEGORIES:
      raise RequestError("market-bars interval is unsupported")
    if not isinstance(params["offset"], int) or isinstance(params["offset"], bool) \
        or not 0 <= params["offset"] <= 100_000:
      raise RequestError("market-bars offset is out of range")
    if not isinstance(params["count"], int) or isinstance(params["count"], bool) \
        or not 1 <= params["count"] <= MAX_BAR_COUNT:
      raise RequestError("market-bars count is out of range")


def observed_at(row: dict[str, Any]) -> str:
  raw = row.get("datetime")
  if isinstance(raw, str) and raw:
    normalized = raw.replace("/", "-")
    for pattern in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
      try:
        parsed = datetime.strptime(normalized, pattern).replace(tzinfo=CHINA_TZ)
        return parsed.isoformat()
      except ValueError:
        pass
  required = ("year", "month", "day")
  if all(isinstance(row.get(key), int) for key in required):
    parsed = datetime(
        row["year"], row["month"], row["day"],
        row.get("hour", 0), row.get("minute", 0), tzinfo=CHINA_TZ,
    )
    return parsed.isoformat()
  raise SchemaDriftError("TDX response omitted a valid market-bar timestamp")


def quote(api: Any, params: dict[str, Any]) -> dict[str, Any]:
  instrument = params["instrument"]
  rows = api.get_security_quotes([(instrument["market"], instrument["symbol"])])
  if not isinstance(rows, list) or not rows or not is_plain_object(rows[0]):
    raise NoDataError("TDX server returned no quote")
  row = rows[0]
  return {key: finite_number(row.get(key)) for key in QUOTE_FIELDS}


def market_bars(api: Any, params: dict[str, Any]) -> list[dict[str, Any]]:
  instrument = params["instrument"]
  fetch_bars = api.get_index_bars if instrument["assetType"] == "index" else api.get_security_bars
  rows = fetch_bars(
      BAR_CATEGORIES[params["interval"]],
      instrument["market"],
      instrument["symbol"],
      params["offset"],
      params["count"],
  )
  if not isinstance(rows, list) or not rows:
    raise NoDataError("TDX server returned no market bars")
  output = []
  for row in rows:
    if not is_plain_object(row):
      raise SchemaDriftError("TDX response contained a malformed market bar")
    output.append({
        "datetime": observed_at(row),
        **{key: finite_number(row.get(key)) for key in BAR_FIELDS},
    })
  return output


OPERATIONS: dict[str, Callable[[Any, dict[str, Any]], Any]] = {
    "health": lambda _api, _params: {"connected": True},
    "quote": quote,
    "market-bars": market_bars,
}


def execute(request: dict[str, Any]) -> tuple[Any, dict[str, int]]:
  # Imported only after the complete request boundary has been validated.
  from pytdx.hq import TdxHq_API

  servers = request["servers"][:request["maxServerAttempts"]]
  failures = 0
  for index, server in enumerate(servers):
    api = TdxHq_API(heartbeat=True)
    try:
      connected = api.connect(
          server["host"],
          server["port"],
          time_out=request["connectTimeoutMs"] / 1000,
      )
      if not connected:
        failures += 1
        continue
      data = OPERATIONS[request["operation"]](api, request["params"])
      return data, {"attempts": index + 1, "serverIndex": index}
    except NoDataError:
      raise
    except SchemaDriftError:
      raise
    except (InterruptedError, KeyboardInterrupt):
      raise
    except Exception as error:
      failures += 1
      print(f"tdx-community server attempt {index + 1} failed: {type(error).__name__}", file=sys.stderr)
    finally:
      try:
        api.disconnect()
      except Exception:
        pass
  raise TransportError(f"all configured TDX community servers failed after {failures} attempts")


def error_kind(error: Exception) -> tuple[str, bool]:
  if isinstance(error, RequestError):
    return "invalid-request", False
  if isinstance(error, NoDataError):
    return "no-data", False
  if isinstance(error, SchemaDriftError):
    return "schema-drift", False
  if isinstance(error, (InterruptedError, KeyboardInterrupt)):
    return "aborted", False
  if isinstance(error, TransportError):
    return "transport", True
  return "provider-error", False


def main() -> int:
  try:
    request = validated_request()
    data, meta = execute(request)
    json.dump(
        {"version": VERSION, "ok": True, "data": data, "meta": meta},
        sys.stdout, allow_nan=False, separators=(",", ":"),
    )
    return 0
  except Exception as error:
    kind, retryable = error_kind(error)
    message = str(error) or type(error).__name__
    json.dump({
        "version": VERSION,
        "ok": False,
        "error": {"kind": kind, "message": message, "retryable": retryable},
    }, sys.stdout, allow_nan=False, separators=(",", ":"))
    print(f"tdx-community runner: {type(error).__name__}: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
  raise SystemExit(main())
