#!/usr/bin/env python3
"""Emit hostile diagnostics and a hostile failure message for redaction tests."""

import json
import sys


SECRET = "fixture-secret-that-must-not-leak"
request = json.loads(sys.stdin.readline())
sys.stderr.write(
    f"GET https://attacker.invalid/path?token={SECRET} "
    f"Authorization: Bearer {SECRET} Cookie: session={SECRET}\n"
)
sys.stderr.flush()
print(json.dumps({
    "version": "1",
    "id": request["id"],
    "ok": False,
    "error": {
        "kind": "provider-error",
        "message": (
            f"request failed at https://attacker.invalid/path?token={SECRET} "
            f"Authorization: Bearer {SECRET} Cookie: session={SECRET}"
        ),
        "retryable": False,
    },
}))
