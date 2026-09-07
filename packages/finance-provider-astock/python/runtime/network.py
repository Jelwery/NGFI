from __future__ import annotations

import contextlib
import http.client
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from typing import Any

from .feature_registry import source_policies


class NetworkPolicyError(RuntimeError):
  def __init__(self, kind: str, code: str, message: str, retryable: bool = False):
    super().__init__(message)
    self.kind = kind
    self.code = code
    self.retryable = retryable


class NetworkGuard:
  def __init__(self) -> None:
    self.failure: NetworkPolicyError | None = None

  def remember(self, error: NetworkPolicyError) -> None:
    self.failure = error

  def raise_if_failed(self) -> None:
    if self.failure is not None:
      raise self.failure


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
  def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
    return None


def _allowed_hosts(source_ids: list[str]) -> set[str]:
  policies = source_policies()
  result: set[str] = set()
  for source_id in source_ids:
    policy = policies.get(source_id)
    if policy is None:
      raise NetworkPolicyError("invalid-request", "unsupported-source", "source is not allowlisted")
    result.update(str(host).lower() for host in policy.get("hosts", []))
  return result


def _validate_url(value: Any, hosts: set[str]) -> str:
  url = value.full_url if isinstance(value, urllib.request.Request) else str(value)
  try:
    parsed = urllib.parse.urlsplit(url)
    port = parsed.port
  except ValueError as exc:
    raise NetworkPolicyError("invalid-request", "invalid-request", "upstream target is invalid") from exc
  if (parsed.scheme != "https" or parsed.hostname not in hosts or port not in (None, 443)
      or parsed.username is not None or parsed.password is not None or parsed.fragment):
    raise NetworkPolicyError("invalid-request", "unsupported-source", "upstream target is outside the fixed HTTPS allowlist")
  return url


def _inspect(status: int, headers: Any, body: bytes, max_bytes: int) -> None:
  if len(body) > max_bytes:
    raise NetworkPolicyError("schema-drift", "output-limit", "upstream response exceeds configured output limit")
  if status == 403:
    raise NetworkPolicyError("insufficient-permission", "insufficient-permission", "upstream rejected anonymous access")
  if status == 429:
    raise NetworkPolicyError("rate-limited", "rate-limited", "upstream rate limit reached", True)
  if status < 200 or status >= 300:
    raise NetworkPolicyError("provider-error", "provider-error", f"upstream returned HTTP {status}", status >= 500)
  content_type = str(headers.get("Content-Type", "")).lower()
  if not body:
    raise NetworkPolicyError("provider-error", "provider-error", "upstream returned an unvalidated empty response")
  prefix = body[:8192].decode("utf-8", "ignore").lower()
  if any(marker in prefix for marker in ("captcha", "验证码", "访问验证", "安全验证", "geetest")):
    raise NetworkPolicyError("insufficient-permission", "insufficient-permission", "upstream returned an access challenge")
  if "text/html" in content_type and ("type=\"password\"" in prefix or "login-form" in prefix):
    raise NetworkPolicyError("unauthorized", "unauthorized", "upstream returned a login page")


@contextlib.contextmanager
def guarded_network(source_ids: list[str], timeout_ms: int, max_bytes: int) -> Iterator[NetworkGuard]:
  try:
    import requests
  except ImportError as exc:
    raise NetworkPolicyError(
      "provider-error", "provider-error",
      "the locked A-share runtime dependencies are not installed",
    ) from exc
  hosts = _allowed_hosts(source_ids)
  guard = NetworkGuard()
  original_request = requests.sessions.Session.request
  original_urlopen = urllib.request.urlopen
  timeout = max(0.1, min(timeout_ms / 1000, 30.0))

  def request(session: requests.Session, method: str, url: str, **kwargs: Any) -> requests.Response:
    _validate_url(url, hosts)
    kwargs["timeout"] = min(float(kwargs.get("timeout", timeout) if not isinstance(kwargs.get("timeout"), tuple) else max(kwargs["timeout"])), timeout)
    kwargs["allow_redirects"] = False
    response = original_request(session, method, url, **kwargs)
    try:
      _inspect(response.status_code, response.headers, response.content, max_bytes)
      return response
    except NetworkPolicyError as exc:
      guard.remember(exc)
      raise

  def urlopen(target: Any, data: Any = None, timeout: float = timeout, *_args: Any, **kwargs: Any) -> Any:
    _validate_url(target, hosts)
    context = kwargs.get("context")
    handlers: list[Any] = [_RejectRedirects()]
    if context is not None:
      handlers.append(urllib.request.HTTPSHandler(context=context))
    opener = urllib.request.build_opener(*handlers)
    try:
      response = opener.open(target, data=data, timeout=min(float(timeout), timeout_ms / 1000))
    except urllib.error.HTTPError as exc:
      body = exc.read(max_bytes + 1)
      try:
        _inspect(exc.code, exc.headers, body, max_bytes)
      except NetworkPolicyError as failure:
        guard.remember(failure)
        raise
      raise
    body = response.read(max_bytes + 1)
    try:
      _inspect(response.status, response.headers, body, max_bytes)
    except NetworkPolicyError as exc:
      guard.remember(exc)
      raise
    return _BufferedResponse(response, body)

  requests.sessions.Session.request = request
  urllib.request.urlopen = urlopen
  try:
    yield guard
  except NetworkPolicyError:
    raise
  except Exception as exc:
    if isinstance(exc, (requests.Timeout, TimeoutError, socket.timeout)):
      raise NetworkPolicyError("timeout", "timeout", "upstream request timed out", True) from exc
    if isinstance(exc, (requests.ConnectionError, urllib.error.URLError, http.client.HTTPException)):
      raise NetworkPolicyError("transport", "transport", "upstream network transport failed", True) from exc
    raise
  finally:
    requests.sessions.Session.request = original_request
    urllib.request.urlopen = original_urlopen


class _BufferedResponse:
  def __init__(self, response: Any, body: bytes):
    self._response = response
    self._body = body
    self._offset = 0
    self.status = response.status
    self.status_code = response.status
    self.headers = response.headers
    self.url = response.geturl()

  def read(self, amount: int = -1) -> bytes:
    if amount is None or amount < 0:
      value = self._body[self._offset:]
      self._offset = len(self._body)
      return value
    value = self._body[self._offset:self._offset + amount]
    self._offset += len(value)
    return value

  def __enter__(self) -> "_BufferedResponse":
    return self

  def __exit__(self, *_args: Any) -> None:
    self.close()

  def close(self) -> None:
    self._response.close()
