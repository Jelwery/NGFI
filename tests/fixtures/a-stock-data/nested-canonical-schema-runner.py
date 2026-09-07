#!/usr/bin/env python3
"""Emit a valid protocol envelope containing an invalid nested quote field."""

import json
import sys

request = json.loads(sys.stdin.readline())
instrument = request["params"]["instrument"]
response = {
  "version": "1",
  "id": request["id"],
  "ok": True,
  "data": {
    "status": "available",
    "data": {
      "instrument": instrument,
      "tradingDate": "2026-08-28",
      "observedAt": "2026-08-28T07:00:00Z",
      "currency": "CNY",
      "fields": {
        "name": {"status": "available", "value": "贵州茅台"},
        "open": {"status": "available", "value": 1468.0},
        "high": {"status": "available", "value": 1488.8},
        "low": {"status": "available", "value": 1460.01},
        "last": {"status": "available", "value": "1482.5"},
        "previousClose": {"status": "available", "value": 1469.2},
        "volume": {"status": "available", "value": 26543},
        "turnover": {"status": "available", "value": 3928876543.0}
      }
    },
    "provenance": {
      "actualProvider": "a-stock-public",
      "provider": "a-stock-public",
      "upstreamSource": "malformed-canonical-fixture",
      "sourceKind": "user",
      "fetchedAt": "2026-08-28T08:00:00Z",
      "fallbackChain": []
    },
    "warnings": []
  }
}
sys.stdout.write(json.dumps(response) + "\n")
sys.stdout.flush()
