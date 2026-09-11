from __future__ import annotations

import socket
from typing import Any

TDX_SERVERS: tuple[tuple[str, int], ...] = (
  ("119.97.185.59", 7709), ("124.70.133.119", 7709),
  ("116.205.183.150", 7709), ("123.60.73.44", 7709),
  ("116.205.163.254", 7709), ("121.36.225.169", 7709),
  ("123.60.70.228", 7709), ("124.71.9.153", 7709),
  ("110.41.147.114", 7709), ("124.71.187.122", 7709),
)


def client(timeout: float = 2.0) -> Any:
  from mootdx.quotes import Quotes
  for host, port in TDX_SERVERS:
    try:
      with socket.create_connection((host, port), timeout=timeout):
        pass
      selected = Quotes.factory(market="std", server=(host, port))
      probe = selected.quotes(symbol=["000001"])
      if probe is not None and not getattr(probe, "empty", False):
        return selected
    except Exception:
      continue
  raise RuntimeError("fixed TDX community server allowlist is unavailable")
