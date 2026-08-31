# cne6_engine/data_sources/sina_kline.py
"""Layer 1: Sina Finance async K-line fetcher via SOCKS5 proxy pool.

Ported from CNE5 covariance_engine.sina_loader — one HTTP GET per stock,
aiohttp-socks + MiniRacer JS decoding. This module only fetches raw data;
all schema mapping happens in the layer-2 adapters.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from typing import Optional

import aiohttp
import polars as pl
from aiohttp_socks import ProxyConnector
from py_mini_racer import MiniRacer
from akshare.stock.cons import hk_js_decode

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

KL_URL = "https://finance.sina.com.cn/realstock/company/{}/hisdata_klc2/klc_kl.js"

SCHEMA = {
    "code": pl.Utf8, "date": pl.Utf8,
    "open": pl.Float64, "high": pl.Float64, "low": pl.Float64,
    "close": pl.Float64, "preclose": pl.Float64,
    "volume": pl.Float64, "amount": pl.Float64, "turn": pl.Float64,
}


def load_proxies(scores_path: str) -> list[str]:
    with open(scores_path) as f:
        raw = json.load(f)
    return sorted(raw, key=lambda u: -raw[u]["general"])


def _miniracer_decode(raw_js: str) -> list:
    js = MiniRacer()
    js.eval(hk_js_decode)
    return js.call("d", raw_js)


async def _decode_kl_text(text: str) -> list[dict]:
    raw = text.split("=", 1)[1].rsplit(";", 1)[0].strip().strip('"')
    return await asyncio.to_thread(_miniracer_decode, raw)


async def _test_one_proxy(proxy_url: str) -> Optional[str]:
    conn = ProxyConnector.from_url(proxy_url)
    timeout = aiohttp.ClientTimeout(total=8, connect=5)
    try:
        async with aiohttp.ClientSession(connector=conn, timeout=timeout) as s:
            async with s.get(KL_URL.format("sh600519")) as r:
                if r.status == 200 and len(await r.text()) > 5000:
                    return proxy_url
    except Exception:
        pass
    return None


async def _test_proxies(proxies: list[str], concurrency: int = 50) -> list[str]:
    sem = asyncio.Semaphore(concurrency)

    async def _test(p):
        async with sem:
            return await _test_one_proxy(p)

    results = await asyncio.gather(*[_test(p) for p in proxies])
    return [p for p in results if p is not None]


async def _fetch_one(code: str, session: aiohttp.ClientSession) -> list[dict]:
    sina_code = code.replace(".", "")
    try:
        async with session.get(KL_URL.format(sina_code)) as r:
            if r.status != 200:
                return []
            text = await r.text()
            if len(text) < 100:
                return []

        data = await _decode_kl_text(text)
        data_sorted = sorted(data, key=lambda e: e.get("date", ""))

        rows = []
        prev_close = None
        for e in data_sorted:
            try:
                c = float(e["close"])
                if prev_close is not None:
                    pc = prev_close
                elif "prevclose" in e:
                    pc = float(e["prevclose"])
                else:
                    pc = float(e["open"])
                rows.append({
                    "code": code,
                    "date": e["date"][:10],
                    "open": float(e["open"]),
                    "high": float(e["high"]),
                    "low": float(e["low"]),
                    "close": c,
                    "preclose": pc,
                    "volume": float(e["volume"]),
                    "amount": float(e.get("amount", 0)),
                    "turn": None,
                })
                prev_close = c
            except (ValueError, KeyError, TypeError):
                continue
        return rows
    except Exception:
        return []


async def fetch_sina_kline_direct(code: str) -> pl.DataFrame:
    """Fetch one ticker directly from Sina for diagnostics and live smoke tests.

    Full-universe reconstruction should still use ``fetch_sina_klines`` and a
    tested proxy pool. This helper intentionally keeps the blast radius to one
    upstream request.
    """
    timeout = aiohttp.ClientTimeout(total=45, connect=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        rows = await _fetch_one(code, session)
    if not rows:
        raise RuntimeError(f"Sina returned no K-line rows for {code}")
    return pl.DataFrame(rows, schema=SCHEMA).sort(["code", "date"])


async def _fetch_all(
    codes: list[str],
    proxies: list[str],
    concurrency: int = 15,
) -> list[dict]:
    sem = asyncio.Semaphore(concurrency)
    n_px = len(proxies)

    sessions: dict[str, aiohttp.ClientSession] = {}
    for px in proxies:
        conn = ProxyConnector.from_url(px)
        timeout = aiohttp.ClientTimeout(total=25, connect=10)
        sessions[px] = aiohttp.ClientSession(connector=conn, timeout=timeout)

    try:
        async def _worker(i: int, code: str):
            async with sem:
                for attempt in range(3):
                    px = proxies[(i + attempt) % n_px]
                    result = await _fetch_one(code, sessions[px])
                    if result:
                        return result
                return []

        tasks = [asyncio.create_task(_worker(i, c)) for i, c in enumerate(codes)]
        all_rows = []
        done = 0
        t0 = time.perf_counter()

        for coro in asyncio.as_completed(tasks):
            rows = await coro
            if rows:
                all_rows.extend(rows)
            done += 1
            if done % 500 == 0:
                elapsed = time.perf_counter() - t0
                eta = elapsed / done * (len(codes) - done)
                print(f"  {done}/{len(codes)} ({done / len(codes) * 100:.0f}%)  "
                      f"ETA {eta / 60:.1f}min")

        return all_rows
    finally:
        for s in sessions.values():
            await s.close()


def fetch_sina_klines(
    codes: list[str],
    scores_path: str,
    concurrency: int = 15,
    min_proxies: int = 5,
) -> pl.DataFrame:
    """Fetch raw Sina K-lines for all codes. Returns SCHEMA frame (turn null)."""
    t0 = time.perf_counter()
    proxies = load_proxies(scores_path)
    print(f"Loaded {len(proxies)} proxies")

    print("Testing proxies...")
    working = asyncio.run(_test_proxies(proxies))
    print(f"  {len(working)} working ({time.perf_counter() - t0:.1f}s)")

    if len(working) < min_proxies:
        raise RuntimeError(f"Need {min_proxies} working proxies, got {len(working)}")

    print(f"Fetching {len(codes)} stocks...")
    rows = asyncio.run(_fetch_all(codes, working, concurrency))

    done_codes = {r["code"] for r in rows}
    failed = [c for c in codes if c not in done_codes]
    if failed:
        print(f"Pass 2: retrying {len(failed)} failed stocks...")
        rows.extend(asyncio.run(_fetch_all(failed, working, concurrency)))

    print(f"  {len(rows)} rows, {len(done_codes)} stocks "
          f"({time.perf_counter() - t0:.1f}s total)")

    if not rows:
        return pl.DataFrame(schema=SCHEMA)
    return pl.DataFrame(rows, schema=SCHEMA).sort(["code", "date"])
