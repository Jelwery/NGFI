"""Stable JSON identities shared by deterministic research artifacts."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from hashlib import sha256
import json
import math
from typing import Any


def _json_value(value: Any) -> Any:
    if is_dataclass(value):
        return _json_value(asdict(value))
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical JSON rejects non-finite numbers")
        if value == 0:
            return 0
        return int(value) if value.is_integer() else value
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("canonical JSON object keys must be strings")
        return {key: _json_value(value[key]) for key in sorted(value)}
    raise TypeError(f"canonical JSON rejects {type(value).__name__}")


def canonical_json(value: Any) -> str:
    def encode(item):
        if isinstance(item, float):
            text = repr(item).lower()
            if "e" in text:
                mantissa, exponent = text.split("e")
                exponent = int(exponent)
                if -6 <= exponent < 21:
                    from decimal import Decimal
                    return format(Decimal(text), "f")
                return mantissa.removesuffix(".0") + "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))
            return text
        if isinstance(item, int) and not isinstance(item, bool) and abs(item) >= 10 ** 21:
            return encode(float(item))
        if isinstance(item, list):
            return "[" + ",".join(encode(child) for child in item) + "]"
        if isinstance(item, dict):
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + encode(child) for key, child in item.items()) + "}"
        return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
    return encode(_json_value(value))


def stable_hash(value: Any) -> str:
    return f"sha256:{sha256(canonical_json(value).encode('utf-8')).hexdigest()}"
