#!/usr/bin/env python3
"""Read-only NDJSON adapter for committed CNE6 Parquet artifacts.

The runner deliberately does not import the CNE6 builder or expose arbitrary
paths. Every request validates the complete published manifest before reading.
"""

from __future__ import annotations

import hashlib
import errno
import json
import math
import os
import re
import stat
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, BinaryIO

import polars as pl

VERSION = "1"
PROVIDER_ID = "cne6-local"
MAX_REQUEST_BYTES = 256 * 1024
MAX_QUALITY_REPORT_BYTES = 8 * 1024 * 1024
HARD_MAX_ROWS = 100_000
DISALLOWED_PATH_PARTS = frozenset({"staging", "checkpoint", "checkpoints"})
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CODE_RE = re.compile(r"^(?:sh|sz|bj)\.\d{6}$")
BARE_CODE_RE = re.compile(r"^\d{6}$")
EXPECTED_UNITS = {"price": "CNY", "volume": "share", "turnover": "CNY"}


@dataclass(frozen=True)
class DatasetSpec:
  manifest_key: str
  filename: str
  row_key: str
  columns: tuple[str, ...]
  optional_columns: frozenset[str] = frozenset()
  supports_codes: bool = True


DATASETS: dict[str, DatasetSpec] = {
  "prices": DatasetSpec(
    "prices", "price_history.parquet", "prices",
    ("code", "date", "open", "high", "low", "close", "preclose",
     "volume", "amount", "turn", "daily_return"),
  ),
  "market-cap": DatasetSpec(
    "caps", "market_cap_snapshot.parquet", "marketCap",
    ("code", "close", "total_market_cap"),
  ),
  "fundamentals": DatasetSpec(
    "fundamentals", "historical_fundamentals.parquet", "fundamentals",
    (
      "code", "report_date", "available_date", "revenue", "net_income",
      "eps", "equity", "operating_cashflow", "total_assets",
      "total_liabilities", "long_term_debt", "preferred_equity", "cogs",
      "capex", "depreciation_amortization", "ebit", "dividend_per_share",
      "total_shares", "cash", "short_term_debt", "investment_cashflow",
      "non_current_liabilities", "parent_equity",
    ),
    frozenset({"available_date"}),
  ),
  "industry": DatasetSpec(
    "industry", "sw_industry.parquet", "industry",
    ("code", "industry"),
  ),
  "benchmark": DatasetSpec(
    "benchmark", "benchmark_sh000300.parquet", "benchmark",
    ("date", "close", "daily_return"), supports_codes=False,
  ),
  "dividends": DatasetSpec(
    "dividends", "dividends.parquet", "dividends",
    ("code", "report_date", "dividend_per_share", "pay_date"),
  ),
}

OPERATIONS = frozenset({"inspect", "query"})
REQUEST_KEYS = frozenset({"version", "id", "operation", "dataRoot", "params", "limits"})
QUERY_KEYS = frozenset({
  "dataset", "columns", "limit", "codes", "as_of", "start_date", "end_date",
})


class ProviderFailure(Exception):
  def __init__(self, kind: str, message: str, retryable: bool = False):
    super().__init__(message)
    self.kind = kind
    self.retryable = retryable


@dataclass(frozen=True)
class ArtifactContext:
  report: dict[str, Any]
  assets: dict[str, dict[str, Any]]
  handles: dict[str, BinaryIO]
  provenance: dict[str, Any]

  def close(self) -> None:
    for handle in self.handles.values():
      handle.close()


def fail(condition: bool, kind: str, message: str) -> None:
  if condition:
    raise ProviderFailure(kind, message)


def parse_json(raw: bytes, label: str) -> Any:
  try:
    return json.loads(
      raw.decode("utf-8"),
      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"invalid number {value}")),
    )
  except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
    raise ProviderFailure("invalid-report" if label == "quality report" else "invalid-request",
                          f"{label} is not strict JSON: {exc}") from exc


def _open_at(name: str, flags: int, directory_fd: int, label: str) -> int:
  try:
    return os.open(name, flags, dir_fd=directory_fd)
  except OSError as exc:
    kind = "unsafe-path" if exc.errno in {errno.ELOOP, errno.ENOTDIR} else "artifact-missing"
    raise ProviderFailure(kind, f"cannot securely open {label}: {exc}") from exc


def _read_current(root_fd: int, flags: int) -> str | None:
  current_fd: int | None = None
  try:
    try:
      current_fd = os.open(
        "CURRENT", flags | getattr(os, "O_NONBLOCK", 0), dir_fd=root_fd,
      )
    except FileNotFoundError:
      return None
    except OSError as exc:
      kind = "unsafe-path" if exc.errno in {errno.ELOOP, errno.ENOTDIR} else "artifact-missing"
      raise ProviderFailure(kind, f"cannot securely open CURRENT: {exc}") from exc
    fail(not stat.S_ISREG(os.fstat(current_fd).st_mode), "unsafe-path",
         "CURRENT must be a regular file")
    payload = os.read(current_fd, 66)
    fail(re.fullmatch(rb"[0-9a-f]{64}\n", payload) is None, "unsafe-path",
         "CURRENT must contain one lowercase 64-hex id and a newline")
    return payload[:-1].decode("ascii")
  finally:
    if current_fd is not None:
      os.close(current_fd)


def open_published_root(raw_value: Any) -> tuple[BinaryIO, int, str | None]:
  fail(not isinstance(raw_value, str) or not raw_value, "unsafe-path",
       "dataRoot must be a non-empty absolute path")
  raw_root = Path(raw_value)
  fail(not raw_root.is_absolute(), "unsafe-path", "dataRoot must be absolute")
  fail(any(part.lower() in DISALLOWED_PATH_PARTS for part in raw_root.parts),
       "unsafe-path", "staging and checkpoint data roots are forbidden")
  fail(raw_root.is_symlink(), "unsafe-path", "published data root cannot be a symlink")
  try:
    root = raw_root.resolve(strict=True)
  except OSError as exc:
    raise ProviderFailure("artifact-missing", f"published data root is unavailable: {exc}") from exc
  fail(not root.is_dir(), "artifact-missing", "published data root is not a directory")
  fail(any(part.lower() in DISALLOWED_PATH_PARTS for part in root.parts),
       "unsafe-path", "resolved data root points into staging or checkpoints")

  flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
  directory_flags = flags | getattr(os, "O_DIRECTORY", 0)
  root_fd: int | None = None
  snapshots_fd: int | None = None
  snapshot_fd: int | None = None
  report_fd: int | None = None
  reference_fd: int | None = None
  try:
    root_fd = os.open(root, directory_flags)
    fail(not stat.S_ISDIR(os.fstat(root_fd).st_mode), "artifact-missing",
         "published data root is not a directory")
    snapshot_id = _read_current(root_fd, flags)
    published_fd = root_fd
    if snapshot_id is not None:
      snapshots_fd = _open_at(
        "snapshots", directory_flags, root_fd, "snapshots directory",
      )
      fail(not stat.S_ISDIR(os.fstat(snapshots_fd).st_mode), "unsafe-path",
           "snapshots must be a directory")
      snapshot_fd = _open_at(
        snapshot_id, directory_flags, snapshots_fd, "CURRENT snapshot",
      )
      fail(not stat.S_ISDIR(os.fstat(snapshot_fd).st_mode), "unsafe-path",
           "CURRENT snapshot must be a directory")
      published_fd = snapshot_fd
    report_fd = _open_at(
      "quality-report.json", flags, published_fd, "published quality report",
    )
    reference_fd = _open_at(
      "reference", directory_flags, published_fd, "published reference directory",
    )
    fail(not stat.S_ISDIR(os.fstat(reference_fd).st_mode), "artifact-missing",
         "reference is not a directory")
  except Exception:
    if report_fd is not None:
      os.close(report_fd)
    if reference_fd is not None:
      os.close(reference_fd)
    raise
  finally:
    if snapshot_fd is not None:
      os.close(snapshot_fd)
    if snapshots_fd is not None:
      os.close(snapshots_fd)
    if root_fd is not None:
      os.close(root_fd)
  assert report_fd is not None and reference_fd is not None
  return os.fdopen(report_fd, "rb", closefd=True), reference_fd, snapshot_id


def sha256_handle(handle: BinaryIO) -> str:
  digest = hashlib.sha256()
  try:
    handle.seek(0)
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
      digest.update(chunk)
    handle.seek(0)
  except OSError as exc:
    raise ProviderFailure("artifact-missing", f"cannot read published asset: {exc}") from exc
  return digest.hexdigest()


def read_report(handle: BinaryIO) -> tuple[dict[str, Any], str]:
  try:
    metadata = os.fstat(handle.fileno())
    fail(not stat.S_ISREG(metadata.st_mode), "unsafe-path",
         "quality-report.json must be a regular file")
    handle.seek(0)
    payload = handle.read(MAX_QUALITY_REPORT_BYTES + 1)
    fail(len(payload) > MAX_QUALITY_REPORT_BYTES, "invalid-report",
         "quality report exceeds size limit")
  except OSError as exc:
    raise ProviderFailure("artifact-missing", f"cannot read quality report: {exc}") from exc
  value = parse_json(payload, "quality report")
  fail(not isinstance(value, dict), "invalid-report", "quality report must be an object")
  return value, hashlib.sha256(payload).hexdigest()


def validate_pit(handle: BinaryIO, columns: list[str]) -> tuple[str, str]:
  if "available_date" not in columns:
    return "unsafe", "fundamentals lacks available_date; no PIT-safe claim is possible"
  try:
    handle.seek(0)
    frame = pl.read_parquet(handle, columns=["report_date", "available_date"])
  except (OSError, pl.exceptions.PolarsError) as exc:
    raise ProviderFailure("parquet-error", f"cannot inspect fundamentals PIT fields: {exc}") from exc
  if frame.is_empty():
    return "unsafe", "fundamentals is empty; available_date cannot be verified"
  parsed = frame.with_columns(
    pl.col("available_date").cast(pl.String).str.strptime(pl.Date, "%Y-%m-%d", strict=False).alias("_available"),
    pl.col("report_date").cast(pl.String).str.strptime(pl.Date, "%Y-%m-%d", strict=False).alias("_report"),
  )
  bad = parsed.filter(
    pl.col("_available").is_null()
    | pl.col("_report").is_null()
    | (pl.col("_available") < pl.col("_report"))
  ).height
  if bad:
    return "unsafe", f"fundamentals has {bad} missing, invalid, or pre-report available_date values"
  return "partial", (
    "fundamentals has valid available_date, but current industry/market-cap and dividend proxies "
    "prevent an artifact-wide PIT-safe claim"
  )


def validate_artifacts(data_root: Any) -> ArtifactContext:
  report_handle, reference_fd, snapshot_id = open_published_root(data_root)
  assets: dict[str, dict[str, Any]] = {}
  handles: dict[str, BinaryIO] = {}
  aggregate = hashlib.sha256()
  try:
    report, report_hash = read_report(report_handle)
    fail(snapshot_id is not None and report_hash != snapshot_id, "integrity-error",
         "CURRENT snapshot id does not match quality-report.json")
    manifest = report.get("assets")
    fail(not isinstance(manifest, dict), "invalid-report", "quality report assets must be an object")
    expected_keys = {spec.manifest_key for spec in DATASETS.values()}
    actual_keys = set(manifest)
    fail(actual_keys != expected_keys, "invalid-report",
         f"quality report assets must be exactly {sorted(expected_keys)}")
    rows_report = report.get("rows")
    fail(not isinstance(rows_report, dict), "invalid-report", "quality report rows must be an object")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    for dataset, spec in DATASETS.items():
      entry = manifest.get(spec.manifest_key)
      fail(not isinstance(entry, dict), "invalid-report", f"asset {spec.manifest_key} is invalid")
      fail(set(entry) != {"file", "bytes", "sha256"}, "invalid-report",
           f"asset {spec.manifest_key} must contain only file, bytes, and sha256")
      filename = entry.get("file")
      expected_bytes = entry.get("bytes")
      expected_hash = entry.get("sha256")
      fail(filename != spec.filename, "unsafe-path",
           f"asset {spec.manifest_key} must use {spec.filename}")
      fail(not isinstance(expected_bytes, int) or isinstance(expected_bytes, bool) or expected_bytes < 0,
           "invalid-report", f"asset {spec.manifest_key} has invalid bytes")
      fail(not isinstance(expected_hash, str) or SHA256_RE.fullmatch(expected_hash) is None,
           "invalid-report", f"asset {spec.manifest_key} has invalid sha256")

      try:
        fd = os.open(spec.filename, flags, dir_fd=reference_fd)
      except OSError as exc:
        kind = "unsafe-path" if exc.errno == errno.ELOOP else "artifact-missing"
        raise ProviderFailure(kind, f"cannot securely open asset {spec.filename}: {exc}") from exc
      handle = os.fdopen(fd, "rb", closefd=True)
      handles[dataset] = handle
      metadata = os.fstat(handle.fileno())
      fail(not stat.S_ISREG(metadata.st_mode), "unsafe-path",
           f"asset {spec.filename} must be a regular file")
      actual_bytes = metadata.st_size
      fail(actual_bytes != expected_bytes, "integrity-error",
           f"asset {spec.filename} size mismatch: expected {expected_bytes}, got {actual_bytes}")
      actual_hash = sha256_handle(handle)
      fail(actual_hash != expected_hash, "integrity-error",
           f"asset {spec.filename} sha256 mismatch")

      try:
        handle.seek(0)
        schema = pl.read_parquet_schema(handle)
        columns = list(schema.names())
        unknown_columns = set(columns) - set(spec.columns)
        missing_columns = set(spec.columns) - spec.optional_columns - set(columns)
        fail(bool(unknown_columns), "parquet-error",
             f"asset {spec.filename} has unsupported columns {sorted(unknown_columns)}")
        fail(bool(missing_columns), "parquet-error",
             f"asset {spec.filename} lacks required columns {sorted(missing_columns)}")
        handle.seek(0)
        row_count = pl.scan_parquet(handle).select(pl.len()).collect().item()
      except ProviderFailure:
        raise
      except (OSError, pl.exceptions.PolarsError) as exc:
        raise ProviderFailure("parquet-error", f"cannot read asset {spec.filename}: {exc}") from exc
      expected_rows = rows_report.get(spec.row_key)
      fail(not isinstance(expected_rows, int) or isinstance(expected_rows, bool) or expected_rows < 0,
           "invalid-report", f"quality report rows.{spec.row_key} is invalid")
      fail(row_count != expected_rows, "integrity-error",
           f"asset {spec.filename} row count mismatch: expected {expected_rows}, got {row_count}")
      fail(sha256_handle(handle) != expected_hash, "integrity-error",
           f"asset {spec.filename} changed during validation")

      assets[dataset] = {
        "manifestKey": spec.manifest_key, "file": spec.filename, "bytes": actual_bytes,
        "sha256": actual_hash, "rows": row_count, "columns": columns,
      }
      aggregate.update(f"{spec.manifest_key}\0{spec.filename}\0{actual_bytes}\0{actual_hash}\n".encode())

    pit_grade, pit_reason = validate_pit(handles["fundamentals"], assets["fundamentals"]["columns"])
    fail(sha256_handle(handles["fundamentals"]) != assets["fundamentals"]["sha256"],
         "integrity-error", "fundamentals changed during PIT validation")
  except Exception:
    for handle in handles.values():
      handle.close()
    raise
  finally:
    report_handle.close()
    os.close(reference_fd)
  build = report.get("build") if isinstance(report.get("build"), dict) else None
  sources = report.get("sources") if isinstance(report.get("sources"), dict) else {}
  coverage = report.get("coverage") if isinstance(report.get("coverage"), dict) else {}
  partial_value = report.get("partial")
  fail(not isinstance(partial_value, bool), "invalid-report",
       "quality report partial must be a boolean")
  partial = partial_value
  requested_value = report.get("requestedSymbols")
  failed_value = report.get("failedSymbols")
  fail(not isinstance(requested_value, list) or not requested_value, "invalid-report",
       "quality report requestedSymbols must be a non-empty array")
  fail(any(not isinstance(item, str) or BARE_CODE_RE.fullmatch(item) is None
           for item in requested_value), "invalid-report",
       "quality report requestedSymbols must contain six-digit symbols")
  fail(len(set(requested_value)) != len(requested_value), "invalid-report",
       "quality report requestedSymbols must not contain duplicates")
  fail(not isinstance(failed_value, list), "invalid-report",
       "quality report failedSymbols must be an array")
  fail(any(not isinstance(item, str) or BARE_CODE_RE.fullmatch(item) is None
           for item in failed_value), "invalid-report",
       "quality report failedSymbols must contain six-digit symbols")
  fail(len(set(failed_value)) != len(failed_value), "invalid-report",
       "quality report failedSymbols must not contain duplicates")
  requested = list(requested_value)
  failed = list(failed_value)
  fail(not set(failed).issubset(requested), "invalid-report",
       "quality report failedSymbols must be a subset of requestedSymbols")
  fail(partial != bool(failed), "invalid-report",
       "quality report partial must match failedSymbols")
  units = report.get("units")
  fail(units != EXPECTED_UNITS, "invalid-report",
       "quality report units must declare CNY prices, share volume, and CNY turnover")
  asset_hashes = {dataset: asset["sha256"] for dataset, asset in assets.items()}
  provenance = {
    "build": build,
    "source": sources,
    "coverage": coverage,
    "partial": partial,
    "failed": failed,
    "requested": requested,
    "units": dict(EXPECTED_UNITS),
    "hash": asset_hashes,
    "aggregateHash": aggregate.hexdigest(),
    "reportHash": report_hash,
    "pitGrade": pit_grade,
    "pitReason": pit_reason,
  }
  return ArtifactContext(report=report, assets=assets, handles=handles, provenance=provenance)


def verify_open_assets(context: ArtifactContext) -> None:
  for dataset, handle in context.handles.items():
    if sha256_handle(handle) != context.assets[dataset]["sha256"]:
      raise ProviderFailure("integrity-error", f"asset {dataset} changed during request")


def inspect_artifacts(context: ArtifactContext) -> dict[str, Any]:
  verify_open_assets(context)
  partial = context.provenance["partial"]
  status = "ready" if partial is False and context.provenance["pitGrade"] != "unsafe" else "degraded"
  generated_at = context.report.get("generatedAt")
  return {
    "providerId": PROVIDER_ID,
    "status": status,
    "generatedAt": generated_at if isinstance(generated_at, str) else None,
    "assets": context.assets,
    **context.provenance,
  }


def strict_date(value: Any, name: str) -> date:
  fail(not isinstance(value, str) or ISO_DATE_RE.fullmatch(value) is None, "invalid-request",
       f"{name} must be YYYY-MM-DD")
  try:
    return date.fromisoformat(value)
  except ValueError as exc:
    raise ProviderFailure("invalid-request", f"{name} must be a real calendar date") from exc


def query_artifact(context: ArtifactContext, params: Any, max_rows: int) -> dict[str, Any]:
  fail(not isinstance(params, dict), "invalid-request", "query params must be an object")
  unknown = set(params) - QUERY_KEYS
  fail(bool(unknown), "invalid-request", f"query has unsupported fields {sorted(unknown)}")
  dataset = params.get("dataset")
  fail(dataset not in DATASETS, "invalid-request", "query dataset is not supported")
  spec = DATASETS[dataset]
  asset = context.assets[dataset]
  actual_columns = asset["columns"]

  requested_columns = params.get("columns", actual_columns)
  fail(not isinstance(requested_columns, list) or not requested_columns or len(requested_columns) > 32,
       "invalid-request", "columns requires 1-32 entries")
  fail(any(not isinstance(column, str) for column in requested_columns),
       "invalid-request", "columns must contain strings")
  fail(len(set(requested_columns)) != len(requested_columns),
       "invalid-request", "columns must not contain duplicates")
  invalid_columns = set(requested_columns) - set(spec.columns)
  missing_columns = set(requested_columns) - set(actual_columns)
  fail(bool(invalid_columns), "invalid-request",
       f"columns are not allowed for {dataset}: {sorted(invalid_columns)}")
  fail(bool(missing_columns), "invalid-request",
       f"columns are absent from the published asset: {sorted(missing_columns)}")

  limit = params.get("limit")
  fail(not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > max_rows,
       "invalid-request", f"limit must be from 1 through {max_rows}")
  codes = params.get("codes")
  if codes is not None:
    fail(not spec.supports_codes, "invalid-request", f"{dataset} does not support code filtering")
    fail(not isinstance(codes, list) or not codes or len(codes) > 1000,
         "invalid-request", "codes requires 1-1000 entries")
    fail(any(not isinstance(code, str) or CODE_RE.fullmatch(code) is None for code in codes),
         "invalid-request", "codes contain an invalid CNE6 security code")

  start_value = params.get("start_date")
  end_value = params.get("end_date")
  start_date = strict_date(start_value, "start_date") if start_value is not None else None
  end_date = strict_date(end_value, "end_date") if end_value is not None else None
  if start_date is not None or end_date is not None:
    fail(dataset not in {"prices", "benchmark"}, "invalid-request",
         "start/end date filters are only supported for prices and benchmark")
    fail(start_date is not None and end_date is not None and start_date > end_date,
         "invalid-request", "start_date must not be after end_date")

  as_of_value = params.get("as_of")
  as_of: date | None = None
  if as_of_value is not None:
    fail(dataset not in {"fundamentals", "prices", "benchmark"}, "pit-unsafe",
         f"{dataset} does not support historical as_of queries")
    as_of = strict_date(as_of_value, "as_of")
    if dataset == "fundamentals":
      fail(context.provenance["pitGrade"] == "unsafe", "pit-unsafe",
           "fundamentals available_date is incomplete or invalid; no PIT-safe claim is possible")

  try:
    handle = context.handles[dataset]
    handle.seek(0)
    query = pl.scan_parquet(handle)
    if codes is not None:
      query = query.filter(pl.col("code").is_in(codes))
    if dataset in {"prices", "benchmark"}:
      observed = pl.col("date").cast(pl.String).str.strptime(pl.Date, "%Y-%m-%d", strict=False)
      if start_date is not None:
        query = query.filter(observed >= pl.lit(start_date))
      if end_date is not None:
        query = query.filter(observed <= pl.lit(end_date))
      if as_of is not None:
        query = query.filter(observed <= pl.lit(as_of))
    elif as_of is not None:
      available = pl.col("available_date").cast(pl.String).str.strptime(
        pl.Date, "%Y-%m-%d", strict=False,
      )
      query = (
        query.filter(
          (available <= pl.lit(as_of))
          & pl.col("report_date").cast(pl.String).str.ends_with("-12-31")
        )
        .sort(["code", "report_date", "available_date"], descending=[False, True, True])
        .unique(subset=["code"], keep="first", maintain_order=True)
      )
    matched_codes = (
      sorted({str(code).split(".", 1)[-1] for code in
              query.select("code").unique().collect()["code"].to_list()})
      if codes is not None else []
    )
    frame = query.select(requested_columns).limit(limit + 1).collect()
    verify_open_assets(context)
  except (OSError, pl.exceptions.PolarsError) as exc:
    raise ProviderFailure("parquet-error", f"query failed for {dataset}: {exc}") from exc
  truncated = frame.height > limit
  if truncated:
    frame = frame.head(limit)
  if dataset == "fundamentals" and as_of is not None:
    pit_grade = "safe"
    pit_reason = "rows were filtered exclusively by validated fundamentals.available_date"
  elif dataset in {"prices", "benchmark"}:
    pit_grade = "market-history"
    pit_reason = (
      "rows are observation-date market history; this does not assert PIT safety for "
      "market-cap, industry, fundamentals, or dividends"
    )
  else:
    pit_grade = context.provenance["pitGrade"]
    pit_reason = context.provenance["pitReason"]
  return {
    "providerId": PROVIDER_ID,
    "dataset": dataset,
    "columns": requested_columns,
    "rows": json_safe(frame.to_dicts()),
    "matchedCodes": matched_codes,
    "returned": frame.height,
    "truncated": truncated,
    "asOf": as_of_value if as_of is not None else None,
    "startDate": start_value if start_date is not None else None,
    "endDate": end_value if end_date is not None else None,
    **context.provenance,
    "pitGrade": pit_grade,
    "pitReason": pit_reason,
  }


def json_safe(value: Any) -> Any:
  if value is None or isinstance(value, (str, bool, int)):
    return value
  if isinstance(value, float):
    return value if math.isfinite(value) else None
  if isinstance(value, (date, datetime)):
    return value.isoformat()
  if isinstance(value, dict):
    return {str(key): json_safe(item) for key, item in value.items()}
  if isinstance(value, (list, tuple)):
    return [json_safe(item) for item in value]
  if hasattr(value, "item"):
    return json_safe(value.item())
  raise ProviderFailure("protocol-error", f"result contains unsupported value {type(value).__name__}")


def handle(request: Any) -> dict[str, Any]:
  fail(not isinstance(request, dict), "invalid-request", "request must be an object")
  unknown = set(request) - REQUEST_KEYS
  fail(bool(unknown), "invalid-request", f"request has unsupported fields {sorted(unknown)}")
  fail(request.get("version") != VERSION, "unsupported-version",
       "unsupported CNE6 local protocol version")
  operation = request.get("operation")
  fail(operation not in OPERATIONS, "unsupported-operation", "operation is not allowed")
  request_id = request.get("id")
  fail(not isinstance(request_id, str) or not request_id, "invalid-request",
       "request id must be a non-empty string")
  limits = request.get("limits")
  fail(not isinstance(limits, dict) or set(limits) != {"maxRows"}, "invalid-request",
       "limits must contain only maxRows")
  max_rows = limits.get("maxRows")
  fail(not isinstance(max_rows, int) or isinstance(max_rows, bool) or max_rows < 1
       or max_rows > HARD_MAX_ROWS, "invalid-request",
       f"maxRows must be from 1 through {HARD_MAX_ROWS}")
  params = request.get("params")
  context = validate_artifacts(request.get("dataRoot"))
  try:
    data = inspect_artifacts(context) if operation == "inspect" else query_artifact(context, params, max_rows)
    return {"version": VERSION, "id": request_id, "ok": True, "data": data}
  finally:
    context.close()


def emit(value: dict[str, Any]) -> None:
  sys.stdout.write(json.dumps(json_safe(value), ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
  sys.stdout.flush()


def main() -> None:
  for raw_line in sys.stdin.buffer:
    request_id: str | None = None
    try:
      if len(raw_line) > MAX_REQUEST_BYTES:
        raise ProviderFailure("invalid-request", "request exceeds size limit")
      request = parse_json(raw_line, "request")
      if isinstance(request, dict) and isinstance(request.get("id"), str):
        request_id = request["id"]
      emit(handle(request))
    except ProviderFailure as exc:
      emit({
        "version": VERSION,
        "id": request_id,
        "ok": False,
        "error": {"kind": exc.kind, "message": str(exc), "retryable": exc.retryable},
      })
    except Exception as exc:  # keep tracebacks and implementation details off stdout
      emit({
        "version": VERSION,
        "id": request_id,
        "ok": False,
        "error": {"kind": "internal-error", "message": str(exc), "retryable": False},
      })


if __name__ == "__main__":
  main()
