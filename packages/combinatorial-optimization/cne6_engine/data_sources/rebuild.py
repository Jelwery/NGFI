"""Resumable builders for the package-owned CNE6 data assets.

The public East Money endpoints are rate-limited and occasionally disconnect.
This module therefore treats retry, backoff, checkpointing and fail-closed
publication as part of the data contract rather than optional conveniences.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import asyncio
import json
import math
import os
import random
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import numpy as np
import polars as pl
import requests

from cne6_engine.data_sources.akshare_index import fetch_index_daily
from cne6_engine.data_sources.dev_fundamentals_probe import fetch_year
from cne6_engine.interfaces.contracts import (
    BENCHMARK_SCHEMA,
    FUNDAMENTAL_SCHEMA,
    INDUSTRY_SCHEMA,
    BenchmarkSeries,
    FundamentalHistory,
    IndustryMembership,
)

PRICE_ASSET_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8, "date": pl.Utf8,
    "open": pl.Float64, "high": pl.Float64, "low": pl.Float64,
    "close": pl.Float64, "preclose": pl.Float64,
    "volume": pl.Float64, "amount": pl.Float64,
    "turn": pl.Float64, "daily_return": pl.Float64,
}
CAP_SNAPSHOT_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8, "close": pl.Float64,
    "total_market_cap": pl.Float64,
}
DIVIDEND_SCHEMA: dict[str, pl.DataType] = {
    "code": pl.Utf8, "report_date": pl.Utf8,
    "dividend_per_share": pl.Float64, "pay_date": pl.Utf8,
}

_SPOT_URL = "https://82.push2.eastmoney.com/api/qt/clist/get"
_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
_SINA_QUOTE_URL = "https://hq.sinajs.cn/list={}"
_SW_COMPONENT_URL = (
    "https://www.swsresearch.com/institute-sw/api/index_publish/"
    "details/component_stocks/"
)
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
)
_PUBLISHED_FILES = (
    "price_history.parquet",
    "market_cap_snapshot.parquet",
    "historical_fundamentals.parquet",
    "sw_industry.parquet",
    "benchmark_sh000300.parquet",
    "dividends.parquet",
)


def normalize_symbol(value: str) -> str:
    """Return a bare six-digit A-share symbol."""
    raw = str(value).strip().lower()
    for prefix in ("sh.", "sz.", "bj.", "sh", "sz", "bj"):
        if raw.startswith(prefix):
            raw = raw.removeprefix(prefix)
            break
    raw = raw.split(".")[0]
    if not raw.isdigit() or len(raw) > 6:
        raise ValueError(f"invalid A-share symbol: {value!r}")
    return raw.zfill(6)


def prefixed_symbol(value: str) -> str:
    symbol = normalize_symbol(value)
    if symbol.startswith(("4", "8", "9")):
        return f"bj.{symbol}"
    if symbol.startswith(("5", "6")):
        return f"sh.{symbol}"
    return f"sz.{symbol}"


def retry_call(
    operation: str,
    func: Callable[[], Any],
    *,
    attempts: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 20.0,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
) -> Any:
    """Retry one upstream operation with exponential backoff and jitter."""
    if attempts < 1:
        raise ValueError("attempts must be >= 1")
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            return func()
        except (requests.RequestException, TimeoutError, ConnectionError,
                ValueError, KeyError, RuntimeError) as exc:
            last = exc
            if attempt + 1 == attempts:
                break
            delay = min(max_delay, base_delay * (2 ** attempt))
            sleep(delay * (0.75 + 0.5 * rand()))
    raise RuntimeError(
        f"{operation} failed after {attempts} attempts: "
        f"{type(last).__name__}: {last}"
    ) from last


class RequestLimiter:
    """Serialize request starts with a minimum spacing.

    The public data sources do not publish a dependable concurrency quota.
    Even when callers opt into multiple price workers, this limiter prevents
    them from starting a burst of requests at the same instant.
    """

    def __init__(
        self, interval: float, *, sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if interval < 0:
            raise ValueError("request interval must be >= 0")
        self.interval = interval
        self._sleep = sleep
        self._clock = clock
        self._next_start = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = self._clock()
            if now < self._next_start:
                self._sleep(self._next_start - now)
            self._next_start = self._clock() + self.interval


def atomic_write_parquet(frame: pl.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp",
                                     dir=path.parent)
    os.close(fd)
    tmp = Path(temporary)
    try:
        frame.write_parquet(tmp, compression="zstd")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def atomic_write_json(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp",
                                     dir=path.parent)
    os.close(fd)
    tmp = Path(temporary)
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
                       encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _asset_manifest(paths: dict[str, Path]) -> dict[str, dict[str, Any]]:
    return {
        name: {"file": path.name, "bytes": path.stat().st_size,
               "sha256": _file_sha256(path)}
        for name, path in paths.items()
    }


def _empty(schema: dict[str, pl.DataType]) -> pl.DataFrame:
    return pl.DataFrame(schema=schema)


def _cast(frame: pl.DataFrame, schema: dict[str, pl.DataType]) -> pl.DataFrame:
    if frame.is_empty():
        return _empty(schema)
    return frame.select([pl.col(name).cast(dtype, strict=False).alias(name)
                         for name, dtype in schema.items()])


def normalize_price_history(raw: Any, symbol: str) -> pl.DataFrame:
    frame = pl.DataFrame(raw)
    if frame.is_empty():
        return _empty(PRICE_ASSET_SCHEMA)
    aliases = {
        "日期": "date", "开盘": "open", "收盘": "close",
        "最高": "high", "最低": "low", "成交量": "volume",
        "成交额": "amount", "换手率": "turn",
    }
    missing = set(aliases) - set(frame.columns)
    if missing:
        raise ValueError(f"East Money history schema missing {sorted(missing)}")
    frame = frame.rename(aliases).sort("date").with_columns(
        pl.lit(prefixed_symbol(symbol)).alias("code"),
        pl.col("date").cast(pl.Utf8).str.slice(0, 10),
        pl.col("turn").cast(pl.Float64, strict=False) / 100.0,
    ).with_columns(
        pl.col("close").cast(pl.Float64, strict=False).shift(1).alias("preclose")
    ).with_columns(
        (pl.col("close").cast(pl.Float64, strict=False) / pl.col("preclose") - 1.0)
        .alias("daily_return")
    ).drop_nulls(["date", "close", "preclose"])
    return _cast(frame, PRICE_ASSET_SCHEMA).sort(["code", "date"])


def normalize_market_snapshot(raw: Any) -> pl.DataFrame:
    frame = pl.DataFrame(raw)
    if frame.is_empty():
        return _empty(CAP_SNAPSHOT_SCHEMA)
    required = {"代码", "最新价", "总市值"}
    if not required.issubset(frame.columns):
        raise ValueError(f"East Money spot schema missing {sorted(required-set(frame.columns))}")
    rows = []
    for item in frame.iter_rows(named=True):
        try:
            code = prefixed_symbol(item["代码"])
            close = float(item["最新价"]); cap = float(item["总市值"])
        except (TypeError, ValueError):
            continue
        if np.isfinite(close) and close > 0 and np.isfinite(cap) and cap > 0:
            rows.append({"code": code, "close": close,
                         "total_market_cap": cap})
    return pl.DataFrame(rows, schema=CAP_SNAPSHOT_SCHEMA, orient="row").sort("code")


def _eastmoney_secid(symbol: str) -> str:
    bare = normalize_symbol(symbol)
    return f"1.{bare}" if bare.startswith(("5", "6")) else f"0.{bare}"


def _request_symbol_snapshot(symbol: str, timeout: float) -> dict[str, Any]:
    response = requests.get(
        _QUOTE_URL,
        params={
            "secid": _eastmoney_secid(symbol),
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "invt": "2", "fltt": "2", "fields": "f43,f57,f58,f116",
        },
        headers={
            "User-Agent": _USER_AGENT,
            "Referer": "https://quote.eastmoney.com/",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    row = response.json().get("data") or {}
    if not row or row.get("f57") is None:
        raise RuntimeError(f"East Money quote returned no row for {symbol}")
    return {
        "代码": row.get("f57"), "名称": row.get("f58"),
        "最新价": row.get("f43"), "总市值": row.get("f116"),
    }


def _request_sina_quote(symbol: str, timeout: float) -> float:
    code = prefixed_symbol(symbol).replace(".", "")
    response = requests.get(
        _SINA_QUOTE_URL.format(code),
        headers={"User-Agent": _USER_AGENT, "Referer": "https://finance.sina.com.cn/"},
        timeout=timeout,
    )
    response.raise_for_status()
    response.encoding = "gb18030"
    try:
        close = float(response.text.split('="', 1)[1].split(",")[3])
    except (IndexError, ValueError) as exc:
        raise RuntimeError(f"Sina quote schema changed for {symbol}") from exc
    if not np.isfinite(close) or close <= 0:
        raise RuntimeError(f"Sina quote returned invalid close for {symbol}")
    return close


def _fallback_symbol_snapshot(
    symbol: str, *, attempts: int, timeout: float, limiter: RequestLimiter | None,
) -> dict[str, Any]:
    """Build the same snapshot from Sina close × East Money share history."""
    import akshare as ak
    bare = normalize_symbol(symbol)
    em_code = prefixed_symbol(bare).split(".")[1].upper()
    em_suffix = prefixed_symbol(bare).split(".")[0].upper()

    def shares_query() -> Any:
        if limiter is not None:
            limiter.wait()
        return ak.stock_zh_a_gbjg_em(symbol=f"{em_code}.{em_suffix}")

    shares_raw = retry_call(
        f"share structure {bare}", shares_query, attempts=attempts,
    )
    shares = pl.DataFrame(shares_raw)
    if not {"变更日期", "总股本"}.issubset(shares.columns):
        raise ValueError(f"East Money share-structure schema changed for {bare}")
    latest = (
        shares.with_columns(
            pl.col("变更日期").cast(pl.Utf8),
            pl.col("总股本").cast(pl.Float64, strict=False),
        )
        .drop_nulls("总股本").sort("变更日期", descending=True)
    )
    if latest.is_empty() or latest["总股本"][0] <= 0:
        raise RuntimeError(f"no valid share structure for {bare}")

    def quote_query() -> float:
        if limiter is not None:
            limiter.wait()
        return _request_sina_quote(bare, timeout)

    close = retry_call(f"Sina quote {bare}", quote_query, attempts=attempts)
    return {
        "代码": bare, "名称": None, "最新价": close,
        "总市值": close * latest["总股本"][0],
    }


def _request_market_snapshot(timeout: float) -> Any:
    """Use one large page to avoid AKShare's multi-page request burst."""
    params = {
        "pn": "1", "pz": "10000", "po": "1", "np": "1",
        "ut": "bd1d9ddb04089700cf9c27f6f7426281", "fltt": "2",
        "invt": "2", "fid": "f12",
        "fs": "m:0 t:6,m:0 t:80,m:1 t:2,m:1 t:23,m:0 t:81 s:2048",
        "fields": "f2,f12,f14,f20",
    }
    response = requests.get(_SPOT_URL, params=params,
                            headers={"User-Agent": _USER_AGENT,
                                     "Referer": "https://quote.eastmoney.com/"},
                            timeout=timeout)
    response.raise_for_status()
    payload = response.json().get("data") or {}
    rows = payload.get("diff") or []
    if not rows:
        raise RuntimeError("East Money spot returned no rows")
    return [{"代码": row.get("f12"), "名称": row.get("f14"),
             "最新价": row.get("f2"), "总市值": row.get("f20")}
            for row in rows]


def _request_sina_market_count(timeout: float) -> int:
    from akshare.stock.cons import zh_sina_a_stock_count_url

    response = requests.get(zh_sina_a_stock_count_url, timeout=timeout)
    response.raise_for_status()
    try:
        count = int(response.json())
    except (requests.JSONDecodeError, TypeError, ValueError) as exc:
        raise RuntimeError("Sina market count schema changed") from exc
    if count < 1:
        raise RuntimeError("Sina market count returned zero")
    return count


def _request_sina_market_page(page: int, timeout: float) -> list[dict[str, Any]]:
    from akshare.stock.cons import zh_sina_a_stock_payload, zh_sina_a_stock_url

    params = {**zh_sina_a_stock_payload, "page": str(page)}
    response = requests.get(zh_sina_a_stock_url, params=params, timeout=timeout)
    response.raise_for_status()
    try:
        rows = response.json()
    except requests.JSONDecodeError as exc:
        raise RuntimeError(f"Sina market page {page} is not JSON") from exc
    if not isinstance(rows, list):
        raise RuntimeError(f"Sina market page {page} schema changed")
    return [
        {
            "代码": row.get("symbol") or row.get("code"),
            "名称": row.get("name"), "最新价": row.get("trade"),
            # Sina's mktcap field is expressed in CNY 10,000.
            "总市值": (float(row["mktcap"]) * 10_000
                     if row.get("mktcap") not in (None, "") else None),
        }
        for row in rows
    ]


def fetch_sina_market_snapshot_resumable(
    staging: Path, *, attempts: int, timeout: float, limiter: RequestLimiter,
) -> pl.DataFrame:
    """Fallback full-market snapshot with one checkpoint per Sina page."""
    page_root = staging / "checkpoints" / "market-cap" / date.today().isoformat()
    page_root.mkdir(parents=True, exist_ok=True)

    def count_query() -> int:
        limiter.wait()
        return _request_sina_market_count(timeout)

    count = retry_call("Sina A-share count", count_query, attempts=attempts)
    pages = math.ceil(count / 80)
    for page in range(1, pages + 1):
        path = page_root / f"{page:04d}.parquet"
        if path.exists():
            try:
                cached = pl.read_parquet(path)
                if dict(cached.schema) == CAP_SNAPSHOT_SCHEMA:
                    continue
            except (OSError, pl.exceptions.PolarsError):
                pass

        def page_query(page: int = page) -> list[dict[str, Any]]:
            limiter.wait()
            return _request_sina_market_page(page, timeout)

        rows = retry_call(
            f"Sina market snapshot page {page}/{pages}", page_query,
            attempts=attempts,
        )
        frame = normalize_market_snapshot(rows)
        if frame.is_empty():
            raise RuntimeError(f"Sina market snapshot page {page} is empty")
        atomic_write_parquet(frame, path)
        if page == 1 or page == pages or page % max(1, pages // 20) == 0:
            print(f"  market-cap checkpoints: {page}/{pages} pages complete")

    frames = [pl.read_parquet(page_root / f"{page:04d}.parquet")
              for page in range(1, pages + 1)]
    snapshot = pl.concat(frames, how="vertical_relaxed").unique(
        "code", keep="last",
    ).sort("code")
    if snapshot.is_empty():
        raise RuntimeError("Sina full-market snapshot returned no valid rows")
    return snapshot


def fetch_market_snapshot(
    *, attempts: int, timeout: float, limiter: RequestLimiter | None = None,
    symbols: list[str] | None = None, staging: Path | None = None,
) -> tuple[pl.DataFrame, dict[str, int]]:
    if symbols:
        rows = []
        counts = {"eastmoney-live-quote": 0,
                  "sina-quote-eastmoney-shares": 0}
        for symbol in dict.fromkeys(normalize_symbol(s) for s in symbols):
            def query_one(symbol: str = symbol) -> dict[str, Any]:
                if limiter is not None:
                    limiter.wait()
                return _request_symbol_snapshot(symbol, timeout)

            try:
                rows.append(retry_call(
                    f"market snapshot {symbol}", query_one, attempts=attempts,
                ))
                counts["eastmoney-live-quote"] += 1
            except RuntimeError as exc:
                print(f"  {exc}; falling back to Sina quote × East Money shares")
                rows.append(_fallback_symbol_snapshot(
                    symbol, attempts=attempts, timeout=timeout, limiter=limiter,
                ))
                counts["sina-quote-eastmoney-shares"] += 1
        return normalize_market_snapshot(rows), counts

    def query() -> Any:
        if limiter is not None:
            limiter.wait()
        return _request_market_snapshot(timeout)

    try:
        raw = retry_call("market snapshot", query, attempts=attempts)
        return (normalize_market_snapshot(raw),
                {"eastmoney-market-snapshot": len(raw)})
    except RuntimeError as exc:
        if staging is None:
            raise
        print(f"  {exc}; falling back to checkpointed Sina market pages")
        fallback_limiter = limiter or RequestLimiter(1.0)
        snapshot = fetch_sina_market_snapshot_resumable(
            staging, attempts=attempts, timeout=timeout, limiter=fallback_limiter,
        )
        return snapshot, {"sina-market-center-snapshot": snapshot.height}


def fetch_one_price(
    symbol: str, start_date: str, end_date: str, *, attempts: int, timeout: float,
    limiter: RequestLimiter | None = None, price_source: str = "auto",
) -> pl.DataFrame:
    bare = normalize_symbol(symbol)
    query_start = (date.fromisoformat(start_date) - timedelta(days=10)).strftime("%Y%m%d")
    if price_source not in {"auto", "eastmoney", "sina"}:
        raise ValueError(f"unsupported price source: {price_source}")

    def eastmoney_query() -> Any:
        import akshare as ak
        if limiter is not None:
            limiter.wait()
        return ak.stock_zh_a_hist(
            symbol=bare, period="daily", start_date=query_start,
            end_date=end_date.replace("-", ""), adjust="qfq", timeout=timeout,
        )

    frame: pl.DataFrame | None = None
    if price_source in {"auto", "eastmoney"}:
        try:
            raw = retry_call(
                f"East Money price {bare}", eastmoney_query, attempts=attempts,
            )
            frame = normalize_price_history(raw, bare)
        except RuntimeError as exc:
            if price_source == "eastmoney":
                raise
            print(f"  {exc}; falling back to Sina unadjusted K-line")

    if frame is None:
        from cne6_engine.data_sources.sina_kline import fetch_sina_kline_direct

        def sina_query() -> pl.DataFrame:
            if limiter is not None:
                limiter.wait()
            return asyncio.run(fetch_sina_kline_direct(prefixed_symbol(bare)))

        sina = retry_call(
            f"Sina price {bare}", sina_query, attempts=attempts,
        )
        frame = sina.with_columns(
            (pl.col("close") / pl.col("preclose") - 1.0).alias("daily_return")
        ).select(list(PRICE_ASSET_SCHEMA))

    frame = frame.filter(
        pl.col("date").is_between(
            pl.lit(start_date), pl.lit(end_date), closed="both",
        )
    )
    if frame.is_empty():
        raise RuntimeError(f"no price rows for {bare}")
    return frame


def _checkpoint_key(start_date: str, end_date: str, price_source: str) -> str:
    return (f"{start_date.replace('-', '')}_{end_date.replace('-', '')}_daily_"
            f"{price_source}")


def _read_price_checkpoint(
    path: Path, symbol: str, start_date: str, end_date: str,
) -> pl.DataFrame | None:
    try:
        frame = pl.read_parquet(path)
        if dict(frame.schema) != PRICE_ASSET_SCHEMA or frame.is_empty():
            return None
        expected = prefixed_symbol(symbol)
        if set(frame["code"].unique().to_list()) != {expected}:
            return None
        if frame["date"].min() < start_date or frame["date"].max() > end_date:
            return None
        return frame
    except (OSError, pl.exceptions.PolarsError):
        return None


def _price_frame_source(frame: pl.DataFrame) -> str:
    return ("sina" if frame["turn"].null_count() == frame.height
            else "eastmoney")


def fetch_prices_resumable(
    symbols: list[str], start_date: str, end_date: str, *, staging: Path,
    workers: int, attempts: int, timeout: float, request_delay: float,
    price_source: str = "auto",
) -> tuple[pl.DataFrame, list[str], dict[str, int]]:
    if not 1 <= workers <= 8:
        raise ValueError("workers must be between 1 and 8")
    parts = staging / "checkpoints" / "prices" / _checkpoint_key(
        start_date, end_date, price_source,
    )
    parts.mkdir(parents=True, exist_ok=True)
    normalized = list(dict.fromkeys(normalize_symbol(s) for s in symbols))
    cached = {
        symbol: _read_price_checkpoint(
            parts / f"{symbol}.parquet", symbol, start_date, end_date,
        )
        for symbol in normalized
    }
    pending = [symbol for symbol, frame in cached.items() if frame is None]
    failures: list[str] = []
    limiter = RequestLimiter(request_delay)
    effective_source = price_source

    # Auto-probe once per run. If East Money's history host is unavailable,
    # use Sina for the remaining symbols instead of paying all retries for
    # every ticker. A resumed run also learns this from existing checkpoints.
    if price_source == "auto":
        cached_sources = {
            _price_frame_source(frame) for frame in cached.values()
            if frame is not None
        }
        if "sina" in cached_sources:
            effective_source = "sina"
        elif pending:
            probe_symbol = pending.pop(0)
            try:
                probe_frame = fetch_one_price(
                    probe_symbol, start_date, end_date, attempts=attempts,
                    timeout=timeout, limiter=limiter, price_source="auto",
                )
                atomic_write_parquet(
                    probe_frame, parts / f"{probe_symbol}.parquet",
                )
                effective_source = _price_frame_source(probe_frame)
                print(f"  price auto selected {effective_source} for remaining symbols")
            except Exception as exc:
                failures.append(probe_symbol)
                print(f"  price failed {probe_symbol}: {exc}")

    def task(symbol: str) -> tuple[str, pl.DataFrame]:
        return symbol, fetch_one_price(symbol, start_date, end_date,
                                       attempts=attempts, timeout=timeout,
                                       limiter=limiter, price_source=effective_source)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(task, symbol): symbol for symbol in pending}
        progress_step = max(1, len(futures) // 20)
        completed = 0
        for future in concurrent.futures.as_completed(futures):
            symbol = futures[future]
            try:
                _, frame = future.result()
                atomic_write_parquet(frame, parts / f"{symbol}.parquet")
            except Exception as exc:
                failures.append(symbol)
                print(f"  price failed {symbol}: {exc}")
            completed += 1
            if completed == 1 or completed == len(futures) or completed % progress_step == 0:
                print(f"  price checkpoints: {completed}/{len(futures)} requests complete")
    if not pending and normalized:
        print(f"  price checkpoints: reused {len(normalized)}/{len(normalized)}")

    frames = [
        frame for symbol in normalized
        if (frame := _read_price_checkpoint(
            parts / f"{symbol}.parquet", symbol, start_date, end_date,
        )) is not None
    ]
    if not frames:
        return _empty(PRICE_ASSET_SCHEMA), failures, {}
    sources = {
        "eastmoney-qfq": sum(_price_frame_source(frame) == "eastmoney" for frame in frames),
        "sina-unadjusted": sum(_price_frame_source(frame) == "sina" for frame in frames),
    }
    frame = pl.concat(frames, how="vertical_relaxed").unique(
        ["code", "date"], keep="last"
    )
    return (_cast(frame, PRICE_ASSET_SCHEMA).sort(["code", "date"]),
            failures, sources)


def _request_sw_components(index_code: str, timeout: float) -> list[dict[str, Any]]:
    response = requests.get(
        _SW_COMPONENT_URL,
        params={"swindexcode": index_code.split(".")[0],
                "page": "1", "page_size": "10000"},
        headers={"User-Agent": _USER_AGENT}, timeout=timeout, verify=False,
    )
    response.raise_for_status()
    rows = ((response.json().get("data") or {}).get("results") or [])
    if not rows:
        raise RuntimeError(f"SW components returned no rows for {index_code}")
    return rows


def fetch_industry_membership(
    symbols: set[str] | None, *, attempts: int, timeout: float, request_delay: float,
) -> pl.DataFrame:
    import akshare as ak
    limiter = RequestLimiter(request_delay)

    def list_industries() -> Any:
        limiter.wait()
        return ak.sw_index_first_info()

    listing = retry_call("SW level-1 list", list_industries, attempts=attempts)
    list_frame = pl.DataFrame(listing)
    if not {"行业代码", "行业名称"}.issubset(list_frame.columns):
        raise ValueError("SW level-1 schema changed")
    wanted = {normalize_symbol(s) for s in symbols} if symbols else None
    mapping: dict[str, str] = {}
    for i, item in enumerate(list_frame.iter_rows(named=True)):
        code = str(item["行业代码"]); name = str(item["行业名称"])

        def components(code: str = code) -> list[dict[str, Any]]:
            limiter.wait()
            return _request_sw_components(code, timeout)

        rows = retry_call(
            f"SW components {code}",
            components,
            attempts=attempts,
        )
        for row in rows:
            raw = row.get("stockcode") or row.get("证券代码")
            if raw is None:
                continue
            bare = normalize_symbol(raw)
            if wanted is None or bare in wanted:
                mapping[prefixed_symbol(bare)] = name
        if wanted is not None and wanted.issubset({normalize_symbol(c) for c in mapping}):
            break
    frame = pl.DataFrame(
        [{"code": code, "industry": industry}
         for code, industry in sorted(mapping.items())],
        schema=INDUSTRY_SCHEMA, orient="row",
    )
    if frame.is_empty():
        raise RuntimeError("no SW industry mappings were fetched")
    return frame


def fetch_benchmark(
    start_date: str, *, attempts: int, limiter: RequestLimiter | None = None,
) -> pl.DataFrame:
    def query() -> pl.DataFrame:
        if limiter is not None:
            limiter.wait()
        return fetch_index_daily("sh000300", start_date)

    frame = retry_call("CSI 300 benchmark",
                       query, attempts=attempts)
    frame = _cast(frame, BENCHMARK_SCHEMA).sort("date")
    BenchmarkSeries(frame).validate()
    return frame


def fetch_fundamentals(
    years: list[int], symbols: set[str] | None, *, attempts: int,
    request_delay: float = 0.75,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    frames: list[pl.DataFrame] = []; dividends: list[pl.DataFrame] = []
    limiter = RequestLimiter(request_delay)
    for year in years:
        frame, div = retry_call(
            f"fundamentals {year}",
            lambda year=year: fetch_year(
                year, symbols, before_request=limiter.wait, strict_dividends=True,
            ),
            attempts=attempts, base_delay=2.0, max_delay=30.0,
        )
        frames.append(frame); dividends.append(div)
    fundamental = (pl.concat(frames, how="vertical_relaxed")
                   if frames else _empty(FUNDAMENTAL_SCHEMA))
    div = (pl.concat(dividends, how="vertical_relaxed")
           if dividends else _empty(DIVIDEND_SCHEMA))
    return _cast(fundamental, FUNDAMENTAL_SCHEMA).sort(["code", "report_date"]), _cast(div, DIVIDEND_SCHEMA)


def attach_dividends(fundamentals: pl.DataFrame, dividends: pl.DataFrame) -> pl.DataFrame:
    """Attach observed annual cash distributions to matching annual reports.

    This is an annual proxy, not a point-in-time rolling TTM series. The report
    and validator label the approximation explicitly.
    """
    if dividends.is_empty():
        return fundamentals
    grouped = dividends.group_by(["code", "report_date"]).agg(
        pl.col("dividend_per_share").sum()
    )
    return fundamentals.drop("dividend_per_share").join(
        grouped, on=["code", "report_date"], how="left"
    ).select(list(FUNDAMENTAL_SCHEMA)).sort(["code", "report_date"])


def validate_assets(root: Path, *, expected_symbols: set[str] | None = None) -> dict[str, Any]:
    reference = root / "reference"
    paths = {
        "prices": reference / "price_history.parquet",
        "caps": reference / "market_cap_snapshot.parquet",
        "fundamentals": reference / "historical_fundamentals.parquet",
        "industry": reference / "sw_industry.parquet",
        "benchmark": reference / "benchmark_sh000300.parquet",
        "dividends": reference / "dividends.parquet",
    }
    missing = [name for name, path in paths.items() if not path.exists()]
    if missing:
        raise FileNotFoundError(f"missing assets: {missing}")
    expected_schemas = {
        "prices": PRICE_ASSET_SCHEMA, "caps": CAP_SNAPSHOT_SCHEMA,
        "fundamentals": FUNDAMENTAL_SCHEMA, "industry": INDUSTRY_SCHEMA,
        "benchmark": BENCHMARK_SCHEMA, "dividends": DIVIDEND_SCHEMA,
    }
    frames: dict[str, pl.DataFrame] = {}
    for name, path in paths.items():
        frame = pl.read_parquet(path)
        if dict(frame.schema) != expected_schemas[name]:
            raise ValueError(
                f"{name} schema mismatch: expected={expected_schemas[name]} "
                f"actual={dict(frame.schema)}"
            )
        frames[name] = frame
    price = frames["prices"]; caps = frames["caps"]
    fundamental = frames["fundamentals"]; industry = frames["industry"]
    benchmark = frames["benchmark"]; dividends = frames["dividends"]
    if price.is_empty() or caps.is_empty() or fundamental.is_empty() or industry.is_empty() or benchmark.is_empty():
        raise ValueError("published assets must be non-empty")
    if price.select(pl.struct(["code", "date"]).n_unique()).item() != price.height:
        raise ValueError("duplicate price keys")
    FundamentalHistory(fundamental).validate()
    IndustryMembership(industry).validate()
    BenchmarkSeries(benchmark).validate()
    if caps.select(pl.col("code").n_unique()).item() != caps.height:
        raise ValueError("duplicate market-cap codes")
    if caps.filter((pl.col("close") <= 0) | (pl.col("total_market_cap") <= 0)).height:
        raise ValueError("market-cap snapshot contains non-positive values")
    if price.filter((pl.col("close") <= 0) | (pl.col("preclose") <= 0)).height:
        raise ValueError("price history contains non-positive prices")
    price_codes = set(price["code"].unique().to_list())
    coverage = {
        "market_cap": len(price_codes & set(caps["code"].to_list())) / len(price_codes),
        "industry": len(price_codes & set(industry["code"].to_list())) / len(price_codes),
        "fundamentals": len(price_codes & set(fundamental["code"].unique().to_list())) / len(price_codes),
    }
    if expected_symbols:
        expected = {prefixed_symbol(s) for s in expected_symbols}
        absent = expected - price_codes
        if absent:
            raise ValueError(f"missing expected price symbols: {sorted(absent)}")
    report = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "rows": {"prices": price.height, "marketCap": caps.height,
                 "fundamentals": fundamental.height, "industry": industry.height,
                 "benchmark": benchmark.height, "dividends": dividends.height},
        "symbols": len(price_codes), "priceStart": price["date"].min(),
        "priceEnd": price["date"].max(), "coverage": coverage,
        "sources": {"prices": "unknown; run rebuild to record actual source",
                    "marketCap": "unknown; run rebuild to record actual source",
                    "industry": "SWS Research level-1 current snapshot",
                    "benchmark": "AKShare/Sina CSI 300",
                    "fundamentals": "AKShare/East Money annual statements",
                    "dividend": "annual report cash dividend proxy (not rolling PIT TTM)"},
        "assets": _asset_manifest(paths),
    }
    recorded = _read_json(root / "quality-report.json")
    if recorded.get("assets") == report["assets"]:
        for key in ("sources", "build", "partial", "failedSymbols",
                    "requestedSymbols"):
            if key in recorded:
                report[key] = recorded[key]
    return report


@dataclass(frozen=True)
class RebuildOptions:
    data_root: Path
    start_date: str
    end_date: str
    years: list[int]
    symbols: list[str] | None = None
    workers: int = 1
    attempts: int = 5
    timeout: float = 20.0
    request_delay: float = 1.0
    allow_partial: bool = False
    price_source: str = "auto"

    def __post_init__(self) -> None:
        start = date.fromisoformat(self.start_date)
        end = date.fromisoformat(self.end_date)
        if start > end:
            raise ValueError("start_date must not be after end_date")
        if not self.years:
            raise ValueError("at least one fundamentals year is required")
        if not 1 <= self.workers <= 8:
            raise ValueError("workers must be between 1 and 8")
        if self.attempts < 1:
            raise ValueError("attempts must be >= 1")
        if self.timeout <= 0 or self.request_delay < 0:
            raise ValueError("timeout must be positive and request_delay non-negative")
        if self.price_source not in {"auto", "eastmoney", "sina"}:
            raise ValueError("price_source must be auto, eastmoney, or sina")


def _run_key(options: RebuildOptions, symbols: list[str] | None) -> str:
    payload = {
        "startDate": options.start_date, "endDate": options.end_date,
        "years": sorted(set(options.years)),
        "symbols": sorted(set(symbols)) if symbols else "all",
        "priceSource": options.price_source,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:12]


def _publish_staged(staged_reference: Path, reference: Path) -> None:
    """Publish validated files with per-file atomic replace and rollback."""
    reference.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="publish-backup-", dir=staged_reference.parent,
    ) as temporary:
        backup = Path(temporary)
        replaced: list[tuple[str, bool]] = []
        try:
            for name in _PUBLISHED_FILES:
                target = reference / name
                existed = target.exists()
                if existed:
                    atomic_write_parquet(pl.read_parquet(target), backup / name)
                atomic_write_parquet(pl.read_parquet(staged_reference / name), target)
                replaced.append((name, existed))
        except Exception:
            for name, existed in reversed(replaced):
                target = reference / name
                if existed:
                    atomic_write_parquet(pl.read_parquet(backup / name), target)
                else:
                    target.unlink(missing_ok=True)
            raise


def rebuild_all(options: RebuildOptions) -> dict[str, Any]:
    root = options.data_root.resolve(); staging = root / "staging"
    reference = root / "reference"; staging.mkdir(parents=True, exist_ok=True)
    explicit = (list(dict.fromkeys(normalize_symbol(s) for s in options.symbols))
                if options.symbols else None)
    run_root = staging / "runs" / _run_key(options, explicit)
    staged_reference = run_root / "reference"
    staged_reference.mkdir(parents=True, exist_ok=True)
    limiter = RequestLimiter(options.request_delay)

    snapshot_path = staged_reference / "market_cap_snapshot.parquet"
    state_path = run_root / "build-state.json"
    state = _read_json(state_path)
    snapshot: pl.DataFrame | None = None
    if snapshot_path.exists():
        try:
            candidate = pl.read_parquet(snapshot_path)
            if dict(candidate.schema) == CAP_SNAPSHOT_SCHEMA and not candidate.is_empty():
                expected = {prefixed_symbol(s) for s in explicit or []}
                if not expected or expected.issubset(set(candidate["code"].to_list())):
                    snapshot = candidate
                    print(f"  market-cap checkpoint: reused {snapshot.height} rows")
        except (OSError, pl.exceptions.PolarsError):
            pass
    if snapshot is None:
        snapshot, cap_sources = fetch_market_snapshot(
            attempts=options.attempts, timeout=options.timeout, limiter=limiter,
            symbols=explicit, staging=run_root,
        )
        atomic_write_parquet(snapshot, snapshot_path)
        state["marketCapSources"] = cap_sources
        atomic_write_json(state, state_path)
    else:
        cap_sources = state.get("marketCapSources") or {
            "checkpoint-without-source-metadata": snapshot.height,
        }
    if explicit:
        wanted = {prefixed_symbol(s) for s in explicit}
        snapshot = snapshot.filter(pl.col("code").is_in(wanted))
        symbols = explicit
    else:
        symbols = [normalize_symbol(c) for c in snapshot["code"].to_list()]
    if snapshot.is_empty():
        raise RuntimeError("market snapshot did not cover the requested symbols")
    atomic_write_parquet(snapshot, snapshot_path)

    prices, failures, price_sources = fetch_prices_resumable(
        symbols, options.start_date, options.end_date, staging=staging,
        workers=options.workers, attempts=options.attempts, timeout=options.timeout,
        request_delay=options.request_delay,
        price_source=options.price_source,
    )
    if failures and not options.allow_partial:
        raise RuntimeError(f"{len(failures)} price symbols failed; rerun resumes from checkpoints")
    if prices.is_empty():
        raise RuntimeError("no price symbols succeeded; nothing can be published")
    atomic_write_parquet(prices, staged_reference / "price_history.parquet")
    successful_symbols = {normalize_symbol(c) for c in prices["code"].unique().to_list()}

    industry = fetch_industry_membership(
        successful_symbols, attempts=options.attempts, timeout=options.timeout,
        request_delay=options.request_delay,
    )
    atomic_write_parquet(industry, staged_reference / "sw_industry.parquet")
    benchmark_start = (date.fromisoformat(options.start_date) - timedelta(days=10)).isoformat()
    benchmark = fetch_benchmark(
        benchmark_start, attempts=options.attempts, limiter=limiter,
    ).filter(
        pl.col("date") <= options.end_date
    )
    atomic_write_parquet(benchmark, staged_reference / "benchmark_sh000300.parquet")
    fundamental, dividends = fetch_fundamentals(
        options.years, successful_symbols, attempts=options.attempts,
        request_delay=options.request_delay,
    )
    fundamental = attach_dividends(fundamental, dividends)
    atomic_write_parquet(fundamental, staged_reference / "historical_fundamentals.parquet")
    atomic_write_parquet(dividends, staged_reference / "dividends.parquet")

    # Publish only after every staged asset exists and can be validated.
    staged_report = validate_assets(run_root, expected_symbols=successful_symbols)
    actual_sources = {
        **staged_report["sources"],
        "prices": price_sources,
        "marketCap": cap_sources,
    }
    staged_report["sources"] = actual_sources
    _publish_staged(staged_reference, reference)
    report = validate_assets(root, expected_symbols=successful_symbols)
    report["sources"] = actual_sources
    report.update({"partial": bool(failures), "failedSymbols": failures,
                   "requestedSymbols": symbols,
                   "build": {"startDate": options.start_date,
                             "endDate": options.end_date,
                             "years": sorted(set(options.years)),
                             "workers": options.workers,
                             "attempts": options.attempts,
                             "requestDelaySeconds": options.request_delay,
                             "priceSourcePolicy": options.price_source,
                             "priceSourceCounts": price_sources,
                             "runKey": run_root.name},
                   "stagedValidation": staged_report})
    atomic_write_json(report, root / "quality-report.json")
    return report
