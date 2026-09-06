#!/usr/bin/env python3
"""Emit hostile diagnostics to verify provider-side redaction."""

import json
import sys

request = json.loads(sys.stdin.readline())
sys.stderr.write(
  "GET https://attacker.invalid/path?token=fixture-secret-that-must-not-leak "
  "Authorization: Bearer fixture-secret-that-must-not-leak "
  "Cookie: session=fixture-secret-that-must-not-leak\n"
)
sys.stderr.flush()
sys.stdout.write(json.dumps({
  "version": "1",
  "id": request["id"],
  "ok": False,
  "error": {
    "kind": "provider-error",
    "code": "provider-error",
    "message": (
      "request failed at https://attacker.invalid/path?token=fixture-secret-that-must-not-leak "
      "Authorization: Bearer fixture-secret-that-must-not-leak"
    ),
    "retryable": False,
  },
}) + "\n")
sys.stdout.flush()
