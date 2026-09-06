#!/usr/bin/env python3
"""Sanitized deterministic v1 fixture captured on 2026-09-05.

Source schema: pytdx-compatible quote/bar response. No live endpoint, cookie, or
credential is present. Behavior is selected by the first documentation-only
server hostname so process failure paths remain deterministic and offline.
"""

import json
import os
import signal
import sys
import time

request = json.load(sys.stdin)
servers = request.get("servers") or []
first_host = servers[0]["host"] if servers else ""

if first_host == "hang.example":
  signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(143))
  while True:
    time.sleep(1)

if first_host == "output.example":
  sys.stdout.write("x" * 131072)
  raise SystemExit(0)

if first_host == "malformed.example":
  sys.stdout.write("not-json")
  raise SystemExit(0)

if first_host == "version.example":
  json.dump({"version": "2", "ok": True, "data": {}}, sys.stdout)
  raise SystemExit(0)

if request.get("version") != "1":
  json.dump({
      "version": "1",
      "ok": False,
      "error": {"kind": "invalid-request", "message": "bad version", "retryable": False},
  }, sys.stdout)
  raise SystemExit(1)

operation = request.get("operation")
if operation == "health":
  data = {"connected": True}
elif operation == "quote":
  host_tail = first_host.split(".")[-1]
  marker = int(host_tail) if host_tail.isdigit() else 7
  data = {
      "datetime": "2026-09-04T15:00:00+08:00",
      "price": float(marker),
      "last_close": 11.8,
      "open": 12.0,
      "high": 12.6,
      "low": 11.9,
      "vol": 123456,
      "amount": len(servers),
      "bid1": 12.33,
      "ask1": 12.35,
  }
elif operation == "market-bars":
  data = [
      {
          "datetime": "2026-09-03T15:00:00+08:00",
          "open": 11.5, "high": 12.1, "low": 11.4, "close": 12.0,
          "vol": 110000, "amount": 1320000,
      },
      {
          "datetime": "2026-09-04T15:00:00+08:00",
          "open": 12.0, "high": 12.6, "low": 11.9, "close": 12.34,
          "vol": 123456, "amount": 1523447.04,
      },
  ]
else:
  json.dump({
      "version": "1",
      "ok": False,
      "error": {"kind": "unsupported", "message": "unsupported fixture operation", "retryable": False},
  }, sys.stdout)
  raise SystemExit(1)

json.dump({
    "version": "1",
    "ok": True,
    "data": data,
    "meta": {"attempts": min(2, len(servers)), "serverIndex": 0},
}, sys.stdout, allow_nan=False, separators=(",", ":"))
if first_host == "nonzero.example":
  raise SystemExit(23)
