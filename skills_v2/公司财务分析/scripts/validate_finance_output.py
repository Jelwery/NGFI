#!/usr/bin/env python3
"""Fail closed when a finance deliverable violates V2 output guardrails."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from validate_state import validate as validate_state


BANNED_REPORT_PATTERNS = {
    "current price": r"当前股价|现价\s*[:：]|股价\s*[:：]\s*[¥￥]?\d",
    "target price": r"目标价|目标价格",
    "upside or discount": r"上行空间|下行空间|折价率|溢价率",
    "trade recommendation": r"建议.{0,6}(买入|卖出|清仓|加仓|减仓)|投资评级\s*[:：]",
}


def walk_keys(value: Any):
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key)
            yield from walk_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_keys(child)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--state", required=True)
    args = parser.parse_args()
    report_path = Path(args.report)
    state_path = Path(args.state)
    errors: list[str] = []

    try:
        report = report_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        errors.append(f"report not found: {report_path}")
        report = ""

    for label, pattern in BANNED_REPORT_PATTERNS.items():
        matches = re.findall(pattern, report, flags=re.I | re.S)
        if matches:
            errors.append(f"report contains banned {label}")

    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"state not found: {state_path}")
        state = None
    except json.JSONDecodeError as exc:
        errors.append(f"state is invalid JSON: {exc}")
        state = None

    if state is not None:
        errors.extend(f"state: {error}" for error in validate_state(state))
        banned_state_keys = {
            "current_price",
            "current_stock_price",
            "target_price",
            "upside",
            "upside_pct",
            "discount_to_price",
            "buy_rating",
        }
        for key in walk_keys(state):
            if key.lower() in banned_state_keys:
                errors.append(f"state contains banned key: {key}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("OK: finance report and state satisfy NGFI V2 guardrails")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
