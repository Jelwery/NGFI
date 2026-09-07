#!/usr/bin/env python3
"""Runs the production adapter with a deterministic malformed public response."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / "packages" / "finance-provider-astock" / "python" / "runner.py"
SPEC = importlib.util.spec_from_file_location("ngfi_astock_runner", RUNNER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def malformed_public_json(_url, _query, _timeout_ms, **_kwargs):
  return {
    "rc": 0,
    "data": {
      "f57": "600519",
      "f58": "贵州茅台",
      "f43": 148250,
      "f44": 148880,
      "f45": 146001,
      "f46": 146800,
      "f47": 26543,
      "f48": 3928876543.0,
      "f59": 2
    }
  }


MODULE.public_json = malformed_public_json


class MalformedOfficial:
  @staticmethod
  def index_constituents(*_args, **_kwargs):
    raise ValueError("upstream returned an invalid date")

  @staticmethod
  def trading_calendar(*_args, **_kwargs):
    raise ValueError("upstream returned an invalid calendar date")


MODULE.load_generated_official = lambda _request, _capability: MalformedOfficial
MODULE.main()
