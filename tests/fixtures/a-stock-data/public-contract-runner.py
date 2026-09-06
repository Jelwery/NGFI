#!/usr/bin/env python3
"""Executes production public handlers against recorded upstream-shaped payloads."""

import importlib.util
from pathlib import Path
from urllib.parse import parse_qs

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / "packages" / "finance-provider-astock" / "python" / "runner.py"
SPEC = importlib.util.spec_from_file_location("ngfi_astock_runner", RUNNER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GeneratedOfficial:
  @staticmethod
  def index_constituents(index_code, provider="csi"):
    assert index_code == "000300" and provider == "csi"
    return pd.DataFrame([{
      "date": "2026-08-28", "index_code": "000300", "code": "600519",
      "name": "贵州茅台", "exchange": "SH", "source": "csi",
      "source_url": "https://oss-ch.csindex.com.cn/fixed-fixture.xls",
      "fetched_at": "2026-08-28T08:00:00Z",
    }])

  @staticmethod
  def trading_calendar(year, month):
    assert (year, month) == (2026, 8)
    return pd.DataFrame([{
      "date": "2026-08-28", "is_open": True, "source": "szse",
      "source_url": "https://www.szse.cn/fixed-fixture",
      "fetched_at": "2026-08-28T08:00:00Z",
    }])


def public_json(url, query, _timeout_ms, *, capability, body=None, headers=None, max_bytes=None):
  del headers, max_bytes
  if url == MODULE.EASTMONEY_QUOTE_URL:
    assert capability == "quote"
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
        "f59": 2,
        "f60": 146500,
        "f86": 1787850000,
      },
    }
  if url == MODULE.SINA_FINANCIAL_URL:
    assert capability == "fundamentals"
    return {
      "result": {"data": {"report_list": {
        "20251231": {
          "publish_date": "2026-03-30",
          "data": [
            {"item_title": "营业收入", "item_value": "181200000000"},
            {"item_title": "净利润", "item_value": "90300000000"},
          ],
        },
      }}}
    }
  if url == MODULE.CNINFO_STOCK_MAP_URL:
    assert capability == "disclosures"
    return {"stockList": [{"code": "600519", "orgId": "gssh0600519"}]}
  if url == MODULE.CNINFO_ANNOUNCEMENT_URL:
    assert capability == "disclosures"
    form = parse_qs(body.decode("utf-8"))
    assert form["stock"] == ["600519,gssh0600519"]
    return {"announcements": [{
      "announcementId": "official-001",
      "announcementTitle": "2025年年度报告",
      "announcementTypeName": "年度报告",
      "announcementTime": 1774828800000,
    }]}
  raise AssertionError(f"unexpected fixed public URL {url}")


MODULE.public_json = public_json
MODULE.load_generated_official = lambda _request, _capability: GeneratedOfficial
MODULE.main()
