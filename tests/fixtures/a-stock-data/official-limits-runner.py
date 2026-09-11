#!/usr/bin/env python3
"""Assert generated official HTTP calls receive request-scoped limits."""

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNNER = ROOT / "packages" / "finance-data-service" / "providers" / "astock" / "python" / "runner.py"
SPEC = importlib.util.spec_from_file_location("ngfi_astock_runner_limits", RUNNER)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LargeResponse:
  status_code = 200
  url = MODULE.CSI_INDEX_TEMPLATE.format(code="000300")
  headers = {}

  def raise_for_status(self):
    return None

  def iter_content(self, chunk_size):
    del chunk_size
    yield b"x" * 4097

  def close(self):
    return None


def main():
  request = json.loads(sys.stdin.buffer.readline())
  calls = []

  def fake_get(*args, **kwargs):
    calls.append((args, kwargs))
    if kwargs.get("allow_redirects") is not False:
      raise AssertionError("redirects must be disabled")
    if kwargs.get("stream") is not True:
      raise AssertionError("official response must be streamed")
    expected = request["limits"]["networkTimeoutMs"] / 1000
    if kwargs.get("timeout") != (expected, expected):
      raise AssertionError("official request ignored networkTimeoutMs")
    return LargeResponse()

  requests_module = type("RequestsModule", (), {"get": staticmethod(fake_get)})
  try:
    try:
      MODULE.generated_official_get(
        requests_module, "index", MODULE.CSI_INDEX_TEMPLATE.format(code="000300"),
        timeout_ms=request["limits"]["networkTimeoutMs"],
        max_bytes=request["limits"]["maxOutputBytes"],
      )
      raise AssertionError("oversized official response was accepted")
    except MODULE.ProviderFailure as exc:
      if exc.code != "output-limit":
        raise
  except (AssertionError, TypeError) as exc:
    MODULE.emit(MODULE.failure(request.get("id"), MODULE.ProviderFailure(
      "provider-error", "provider-error", str(exc), False,
    )))
    return

  fixture = ROOT / "tests" / "fixtures" / "a-stock-data" / "index.json"
  request["source"] = "fixture"
  request["fixtureRoot"] = str(fixture.parent)
  response, _ = MODULE.handle(request)
  MODULE.emit(response)


if __name__ == "__main__":
  main()
