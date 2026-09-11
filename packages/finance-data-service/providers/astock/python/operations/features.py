from __future__ import annotations

import io
import json
import os
import ssl
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ngfi_overrides.tdx import client as tdx_client
from runtime.feature_registry import RegistryError, feature, source_policies, variant
from runtime.network import NetworkPolicyError, guarded_network
from runtime.snapshot_loader import load_block, resolve_callable


class FeatureFailure(RuntimeError):
  def __init__(self, kind: str, code: str, message: str, retryable: bool = False):
    super().__init__(message)
    self.kind = kind
    self.code = code
    self.retryable = retryable


def _symbol(params: dict[str, Any]) -> str:
  instrument = params.get("instrument")
  if not isinstance(instrument, dict) or not isinstance(instrument.get("symbol"), str):
    raise FeatureFailure("invalid-request", "invalid-request", "feature requires a canonical instrument")
  return instrument["symbol"]


def _date(params: dict[str, Any], key: str = "tradeDate", compact: bool = False) -> str:
  value = params.get(key) or params.get("asOf") or date.today().isoformat()
  if not isinstance(value, str) or len(value) < 10:
    raise FeatureFailure("invalid-request", "invalid-request", f"{key} must be an ISO date")
  selected = value[:10]
  try:
    parsed = date.fromisoformat(selected)
  except ValueError as exc:
    raise FeatureFailure("invalid-request", "invalid-request", f"{key} must be an ISO date") from exc
  return parsed.strftime("%Y%m%d") if compact else parsed.isoformat()


def _positive_int(params: dict[str, Any], key: str, default: int, maximum: int) -> int:
  value = params.get(key, default)
  if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > maximum:
    raise FeatureFailure("invalid-request", "input-limit", f"{key} must be from 1 through {maximum}")
  return value


def _prepare_namespace(selected: dict[str, Any]) -> dict[str, Any]:
  runtime = selected["runtime"]
  if runtime["kind"] == "generated-module":
    return {}
  namespace = load_block(runtime["block"])
  namespace["em_get"] = lambda url, params=None, headers=None, timeout=15, **kwargs: namespace["requests"].get(
    url, params=params, headers=headers, timeout=timeout, **kwargs,
  )
  namespace["IWENCAI_BASE"] = "https://openapi.iwencai.com"
  namespace["IWENCAI_KEY"] = os.environ.get("IWENCAI_API_KEY", "")
  namespace["_ctx"] = ssl.create_default_context()
  return namespace


def _callable(selected: dict[str, Any]) -> Callable[..., Any]:
  runtime = selected["runtime"]
  if runtime["symbol"].startswith("tdx_client."):
    return getattr(tdx_client(), runtime["symbol"].split(".", 1)[1])
  namespace = _prepare_namespace(selected)
  if namespace:
    value = namespace.get(runtime["symbol"])
    if not callable(value):
      raise FeatureFailure("provider-error", "provider-error", "locked upstream callable is unavailable")
    return value
  return resolve_callable(runtime)


def _invoke(capability_id: str, selected: dict[str, Any], params: dict[str, Any], limit: int) -> Any:
  call = _callable(selected)
  symbol = _symbol(params) if isinstance(params.get("instrument"), dict) else None
  variant_id = selected["id"]
  if capability_id == "capability-001":
    if variant_id == "bars":
      frequencies = {"1m": 8, "5m": 0, "15m": 1, "30m": 2, "60m": 3, "1d": 9, "1wk": 5, "1mo": 6}
      return call(symbol=symbol, frequency=frequencies.get(params.get("interval", "1d"), 9), offset=limit)
    if variant_id == "order-book":
      return call(symbol=[symbol])
    return call(symbol=symbol, date=_date(params, compact=True))
  if capability_id == "capability-002": return call([symbol])
  if capability_id == "capability-003": return call(symbol, params.get("startDate", "").replace("-", ""))
  if capability_id == "capability-004":
    kind = params.get("adjustment", "qfq")
    factors = call(symbol, kind) if variant_id == "factor" else None
    if variant_id == "factor": return factors
    upstream = _prepare_namespace(selected)
    factor_call = upstream.get("sina_adjust_factor")
    if not callable(factor_call): raise FeatureFailure("provider-error", "provider-error", "adjustment factor callable is unavailable")
    bars = tdx_client().bars(symbol=symbol, frequency=9, offset=limit)
    return call(bars, factor_call(symbol, kind), kind)
  if capability_id == "capability-005":
    return call(params.get("industryCode", "*"), max_pages=min(5, max(1, (limit + 99) // 100))) if variant_id == "industry" else call(symbol, max_pages=min(5, max(1, (limit + 99) // 100)))
  if capability_id == "capability-006":
    reports = load_block("block-009.py")
    reports["em_get"] = _prepare_namespace(selected)["em_get"]
    rows = reports["eastmoney_reports"](symbol, 1)
    if not rows: raise FeatureFailure("provider-error", "provider-error", "research list was empty before document selection")
    target = Path(os.environ.get("TMPDIR", "/tmp")) / "ngfi-a-stock-documents"
    return [{"documentRef": call(rows[0], str(target)), "infoCode": rows[0].get("infoCode")} ]
  if capability_id == "capability-007": return call(symbol)
  if capability_id == "capability-008":
    search = params.get("searchText")
    if not isinstance(search, str) or not search.strip(): raise FeatureFailure("invalid-request", "invalid-request", "searchText is required")
    return call(search, page=_positive_int(params, "page", 1, 200), limit=limit) if variant_id == "query" else call(search, params.get("channel", "report"), limit)
  if capability_id == "capability-009": return call(_date(params))
  if capability_id == "capability-010": return call()
  if capability_id in {"capability-011", "capability-012", "capability-022", "capability-024", "capability-029", "capability-032", "capability-035", "capability-051"}: return call(symbol)
  if capability_id == "capability-013": return call(symbol, _date(params), _positive_int(params, "lookbackDays", 30, 3650))
  if capability_id == "capability-014": return call(symbol, _date(params), _positive_int(params, "forwardDays", 90, 3660))
  if capability_id == "capability-015": return call(limit)
  if capability_id == "capability-016": return call(params.get("boardType", "industry"), params.get("period", "today"), limit)
  if capability_id == "capability-017": return call(_date(params), None)
  if capability_id in {"capability-018", "capability-019", "capability-020", "capability-021"}: return call(symbol, limit)
  if capability_id == "capability-023":
    bars = tdx_client().bars(symbol=symbol, frequency=9, offset=max(30, limit))
    return call(bars)
  if capability_id in {"capability-025", "capability-026"}: return call(limit)
  if capability_id == "capability-027": return call(symbol=symbol)
  if capability_id in {"capability-028", "capability-035"}: return call(symbol=symbol, name=params.get("category", "最新提示"))
  if capability_id == "capability-030": return call(symbol, params.get("statement", "lrb"), limit)
  if capability_id == "capability-031": return call(symbol, params.get("startDate", "2010-01-01"), params.get("endDate", date.today().isoformat()))
  if capability_id == "capability-033":
    history = call() if variant_id == "history" else load_block("block-038.py")["sw_industry_history"]()
    return history if variant_id == "history" else call(history, symbol, params.get("asOf", date.today().isoformat())[:10])
  if capability_id == "capability-034": return call(symbol, limit)
  if capability_id in {"capability-036", "capability-037", "capability-038", "capability-039", "capability-040", "capability-041"}: return call(_date(params, compact=True))
  if capability_id == "capability-042": return call(True)
  if capability_id == "capability-043": return call(limit, 1)
  if capability_id == "capability-044": return call(limit, 1)
  if capability_id == "capability-045": return call(params.get("underlying", symbol or "510050"), params.get("optionType", "call") == "call")
  if capability_id in {"capability-046", "capability-047"}:
    option_code = params.get("optionCode")
    if not isinstance(option_code, str) or not option_code.isdigit(): raise FeatureFailure("invalid-request", "invalid-request", "optionCode is required")
    return call(option_code)
  if capability_id == "capability-048": return call(symbol, limit, _positive_int(params, "page", 1, 200))
  if capability_id == "capability-049": return call(params.get("period", "hour"))
  if capability_id == "capability-050": return call(limit)
  if capability_id == "capability-052": return call(params.get("year"))
  if capability_id == "capability-053": return call()
  if capability_id in {"capability-054", "capability-055"}: return call(symbol, params.get("officialProvider", "csi"))
  if capability_id == "capability-056": return call(symbol)
  if capability_id == "capability-057":
    selected = date.fromisoformat(params.get("startDate", date.today().isoformat()))
    return call(selected.year, selected.month)
  if capability_id == "capability-058": return call(_date(params), "SH" if params["instrument"]["exchange"] == "SSE" else "SZ", symbol)
  if capability_id == "capability-059": return call(_date(params), symbol)
  if capability_id == "capability-060":
    if variant_id == "dragon-tiger": return call(_date(params))
    if variant_id == "fund-flow": return call(symbol, min(limit, 120))
    return call(symbol, limit)
  raise FeatureFailure("unsupported", "unsupported-operation", "feature has no curated invocation")


def _scalar(value: Any) -> str | int | float | bool | None:
  if value is None or isinstance(value, (str, bool)):
    return value
  if isinstance(value, int):
    return value
  if isinstance(value, float):
    if value != value or value in (float("inf"), float("-inf")):
      return None
    return value
  if hasattr(value, "item"):
    try: return _scalar(value.item())
    except (TypeError, ValueError): pass
  return json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _jsonable(value: Any) -> Any:
  if value is None or isinstance(value, (str, int, float, bool)):
    return _scalar(value)
  if isinstance(value, dict): return {str(key): _jsonable(child) for key, child in value.items()}
  if isinstance(value, (list, tuple, set)): return [_jsonable(child) for child in value]
  if hasattr(value, "to_dict"):
    try: return _jsonable(value.to_dict(orient="records"))
    except TypeError: return _jsonable(value.to_dict())
  return str(value)


def _records(value: Any) -> list[dict[str, Any]]:
  normalized = _jsonable(value)
  if isinstance(normalized, list):
    return [{str(key): _scalar(child) for key, child in item.items()} if isinstance(item, dict) else {"value": _scalar(item)} for item in normalized]
  if isinstance(normalized, dict):
    for key in ("records", "rows", "items", "stocks", "data"):
      nested = normalized.get(key)
      if isinstance(nested, list):
        return [{str(k): _scalar(v) for k, v in item.items()} if isinstance(item, dict) else {"value": _scalar(item)} for item in nested]
    return [{str(key): _scalar(child) for key, child in normalized.items()}]
  return [{"value": _scalar(normalized)}]


class _ConsoleDiagnostics(io.TextIOBase):
  emitted = False

  def write(self, text: str) -> int:
    self.emitted = self.emitted or bool(text)
    return len(text)


def execute_feature(params: dict[str, Any], limits: dict[str, int]) -> dict[str, Any]:
  try:
    entry = feature(params.get("featureId", ""))
    selected = variant(entry, params.get("variant"))
  except RegistryError as exc:
    raise FeatureFailure("invalid-request", "unsupported-operation", str(exc)) from exc
  if entry["auth"] == "api-key" and not os.environ.get("IWENCAI_API_KEY"):
    raise FeatureFailure("unauthorized", "unauthorized", "IWENCAI_API_KEY is required for this feature")
  limit = _positive_int(params, "limit", entry["defaultLimit"], min(entry["maxLimit"], limits["maxRecords"]))
  diagnostics = _ConsoleDiagnostics()
  try:
    with redirect_stdout(diagnostics), guarded_network(entry["sources"], limits["networkTimeoutMs"], limits["maxOutputBytes"]) as network:
      raw = _invoke(entry["upstreamCapabilityId"], selected, params, limit)
      network.raise_if_failed()
  except NetworkPolicyError as exc:
    raise FeatureFailure(exc.kind, exc.code, str(exc), exc.retryable) from exc
  except FeatureFailure:
    raise
  except (ValueError, TypeError) as exc:
    raise FeatureFailure("invalid-request", "invalid-request", "feature parameters were rejected") from exc
  except Exception as exc:
    raise FeatureFailure("provider-error", "provider-error", "upstream feature call failed", True) from exc
  records = _records(raw)
  if not records:
    raise FeatureFailure("provider-error", "provider-error", "upstream returned an unvalidated empty dataset")
  truncated = len(records) > limit
  records = records[:limit]
  fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
  source_id = entry["sources"][0]
  policy = source_policies()[source_id]
  data = {
    "featureId": entry["featureId"], "schemaVersion": 1, "scope": entry["scope"],
    **({"instrument": params["instrument"]} if isinstance(params.get("instrument"), dict) else {}),
    **({"asOf": params["asOf"]} if isinstance(params.get("asOf"), str) else {}),
    **({"startDate": params["startDate"]} if isinstance(params.get("startDate"), str) else {}),
    **({"endDate": params["endDate"]} if isinstance(params.get("endDate"), str) else {}),
    "records": records, "returned": len(records), "truncated": truncated,
    "fieldUnits": entry["fieldUnits"], "limitations": entry["limitations"],
  }
  return {
    "status": "available", "data": data,
    "provenance": {
      "actualProvider": "a-stock-public", "provider": "a-stock-public",
      "upstreamSource": source_id, "sourceKind": policy["kind"], "fetchedAt": fetched_at,
      "observedAt": params.get("asOf", fetched_at), "timezone": "Asia/Shanghai",
      "unit": "declared-in-fieldUnits", "fallbackChain": [],
      "upstreamVersion": "v3.8.0", "upstreamCommit": "2012ce7cd0e75d379c5e6cbd3115514f300f3bc8",
    },
    "warnings": list(entry["limitations"]) + (["Upstream emitted console diagnostics; text withheld from the data protocol."] if diagnostics.emitted else []),
  }
