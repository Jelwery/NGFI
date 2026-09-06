"""Small pytdx-compatible fake used to exercise the packaged runner."""

import os
from pathlib import Path


def trace(event):
  path = os.environ.get("TDX_FIXTURE_TRACE")
  if path:
    with Path(path).open("a", encoding="utf-8") as output:
      output.write(f"{event}\n")


class TdxHq_API:
  def __init__(self, heartbeat=False):
    self.host = None
    trace(f"init:{heartbeat}")

  def connect(self, host, port, time_out):
    self.host = host
    trace(f"connect:{host}:{port}:{time_out}")
    if host == "fail-one.example":
      return False
    if host == "error-two.example":
      raise OSError("sanitized fixture transport failure")
    return True

  def disconnect(self):
    trace(f"disconnect:{self.host}")

  def get_security_quotes(self, instruments):
    trace(f"quote:{instruments[0][0]}:{instruments[0][1]}")
    return [{
        "price": 12.34,
        "last_close": 12.0,
        "open": 12.1,
        "high": 12.5,
        "low": 11.9,
        "vol": 123456,
        "amount": 1523447.04,
        "bid1": 12.33,
        "ask1": 12.35,
    }]

  def get_security_bars(self, category, market, symbol, offset, count):
    trace(f"bars:{category}:{market}:{symbol}:{offset}:{count}")
    return [{
        "datetime": "2026-09-04 15:00",
        "open": 12.1,
        "high": 12.5,
        "low": 11.9,
        "close": 12.34,
        "vol": 123456,
        "amount": 1523447.04,
    }]

  def get_index_bars(self, category, market, symbol, offset, count):
    trace(f"index-bars:{category}:{market}:{symbol}:{offset}:{count}")
    return [{
        "datetime": "2026-09-04 15:00",
        "open": 4010.0,
        "high": 4030.0,
        "low": 4000.0,
        "close": 4020.0,
        "vol": 654321,
        "amount": 9876543.21,
    }]
