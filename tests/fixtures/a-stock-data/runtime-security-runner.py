#!/usr/bin/env python3
"""Exercise the production runner's process and network trust boundaries offline."""

import importlib.util
import json
import os
import sys
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / "packages" / "finance-provider-astock" / "python" / "runner.py"
SPEC = importlib.util.spec_from_file_location("ngfi_astock_runner", RUNNER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

FORBIDDEN_ENVIRONMENT = frozenset({
  "ASTOCK_TEST_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "LLM_API_KEY",
  "NGFI_API_KEY",
  "NGFI_LLM_BASE_URL",
  "TUSHARE_TOKEN",
  "TUSHARE_MCP_URL",
  "TDX_DATA_KEY",
  "TDX_COMMUNITY_SERVERS",
  "IFIND_MCP_CREDENTIAL",
  "IFIND_MCP_URL",
  "IWENCAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "PYTHONPATH",
  "UV_INDEX_URL",
})
SECRET_MARKER = "fixture-secret-that-must-not-leak"
REDIRECT_TARGET = "https://attacker.invalid/collect?" + "token=" + SECRET_MARKER


def expect_provider_failure(action, label):
  try:
    action()
  except MODULE.ProviderFailure as exc:
    if SECRET_MARKER in str(exc):
      raise AssertionError(f"{label} exposed redirect credentials") from None
    return
  raise AssertionError(f"{label} was not rejected")


def exercise_urllib_policy():
  fixed_endpoints = [
    ("instrument-reference", MODULE.EASTMONEY_QUOTE_URL),
    ("quote", MODULE.EASTMONEY_QUOTE_URL),
    ("market-bars", MODULE.EASTMONEY_BARS_URL),
    ("fundamentals", MODULE.SINA_FINANCIAL_URL),
    ("disclosures", MODULE.CNINFO_STOCK_MAP_URL),
    ("disclosures", MODULE.CNINFO_ANNOUNCEMENT_URL),
    ("disclosures", MODULE.SZSE_ANNOUNCEMENT_URL),
    ("index", MODULE.CSI_INDEX_TEMPLATE.format(code="000300")),
    ("index", MODULE.CNI_INDEX_URL),
    ("trading-calendar", MODULE.SZSE_CALENDAR_URL),
  ]
  for capability, url in fixed_endpoints:
    parsed = MODULE.validate_public_url(url, capability)
    if parsed.scheme != "https":
      raise AssertionError(f"{capability} endpoint is not HTTPS")
  redirect_handler = MODULE.RejectRedirects()
  for location in (
    REDIRECT_TARGET,
    "http://push2.eastmoney.com/downgrade",
    "https://push2.eastmoney.com/other-path",
  ):
    if redirect_handler.redirect_request(None, None, 302, "Found", {}, location) is not None:
      raise AssertionError("public redirect handler accepted a redirect")

  opened = []

  class RedirectingOpener:
    def open(self, request, timeout):
      opened.append((request, timeout))
      raise urllib.error.HTTPError(
        request.full_url,
        302,
        "Found",
        {"Location": REDIRECT_TARGET},
        None,
      )

  def fake_build_opener(*handlers):
    redirect_blocked = any(
      isinstance(handler, urllib.request.HTTPRedirectHandler)
      and type(handler) is not urllib.request.HTTPRedirectHandler
      for handler in handlers
    )
    if not redirect_blocked:
      raise AssertionError("public request opener permits automatic redirects")
    return RedirectingOpener()

  MODULE.urllib.request.urlopen = lambda *_args, **_kwargs: (_ for _ in ()).throw(
    AssertionError("public request used the redirect-following global opener"),
  )
  MODULE.urllib.request.build_opener = fake_build_opener

  expect_provider_failure(
    lambda: MODULE.public_request(
      MODULE.EASTMONEY_QUOTE_URL, None, 1000, capability="disclosures",
    ),
    "capability host policy",
  )
  if opened:
    raise AssertionError("disallowed capability host reached the HTTP opener")

  expect_provider_failure(
    lambda: MODULE.public_request(
      MODULE.EASTMONEY_QUOTE_URL, None, 1000, capability="quote",
    ),
    "cross-host redirect",
  )
  if len(opened) != 1:
    raise AssertionError("redirect policy made more than one request")


def exercise_official_policy():
  calls = []

  class RedirectResponse:
    status_code = 302
    url = REDIRECT_TARGET

    def close(self):
      return None

  def fake_get(*args, **kwargs):
    calls.append((args, kwargs))
    if kwargs.get("allow_redirects") is not False:
      raise AssertionError("official request permits automatic redirects")
    return RedirectResponse()

  requests_module = type("RequestsModule", (), {"get": staticmethod(fake_get)})
  expect_provider_failure(
    lambda: MODULE.generated_official_get(
      requests_module, "index", MODULE.CSI_INDEX_TEMPLATE.format(code="000300"),
      timeout_ms=1000, max_bytes=4096,
    ),
    "official redirect",
  )
  if len(calls) != 1:
    raise AssertionError("official redirect policy made more than one request")

  calls.clear()
  expect_provider_failure(
    lambda: MODULE.generated_official_get(
      requests_module, "index", MODULE.SZSE_CALENDAR_URL,
      timeout_ms=1000, max_bytes=4096,
    ),
    "official capability host policy",
  )
  if calls:
    raise AssertionError("disallowed official capability host reached requests")


class IndexFrame:
  columns = [
    "date", "index_code", "code", "name", "exchange",
    "source", "source_url", "fetched_at",
  ]

  @staticmethod
  def to_dict(orientation):
    assert orientation == "records"
    return [{
      "date": "2026-08-28",
      "index_code": "000300",
      "code": "600519",
      "name": "贵州茅台",
      "exchange": "SH",
      "source": "csi",
      "source_url": "https://oss-ch.csindex.com.cn/static/index.xls?" + "token=" + SECRET_MARKER,
      "fetched_at": "2026-08-28T08:00:00Z",
    }]


class GeneratedOfficial:
  @staticmethod
  def index_constituents(index_code, provider="csi"):
    assert index_code == "000300" and provider == "csi"
    return IndexFrame()


def main():
  raw = sys.stdin.buffer.readline()
  request = json.loads(raw)
  request_id = request.get("id") if isinstance(request, dict) else None
  try:
    leaked = sorted(FORBIDDEN_ENVIRONMENT.intersection(os.environ))
    if leaked:
      raise AssertionError("forbidden environment names reached runner: " + ", ".join(leaked))
    if not MODULE.CNINFO_STOCK_MAP_URL.startswith("https://"):
      raise AssertionError("CNInfo stock map is not HTTPS")
    exercise_urllib_policy()
    exercise_official_policy()
    if request.get("source") == "public-web" and request.get("operation") == "index":
      MODULE.load_generated_official = lambda *_args, **_kwargs: GeneratedOfficial
    response, _max_output = MODULE.handle(request)
  except (AssertionError, TypeError) as exc:
    response = MODULE.failure(request_id, MODULE.ProviderFailure(
      "provider-error", "provider-error", str(exc), False,
    ))
  except MODULE.ProviderFailure as exc:
    response = MODULE.failure(request_id, exc)
  MODULE.emit(response)


if __name__ == "__main__":
  main()
