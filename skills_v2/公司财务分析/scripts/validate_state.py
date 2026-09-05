#!/usr/bin/env python3
"""Validate the stable V2 state.json contract without third-party packages."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


TOP_LEVEL = {
    "metadata": dict,
    "stage1": dict,
    "stage2_4_summary": dict,
    "risk_models": dict,
    "last_valuation": dict,
    "data_snapshots": dict,
}
RESULT_KEYS = ("pessimistic", "neutral", "optimistic", "recommended")
BANNED_KEYS = {
    "meta",
    "current_price",
    "current_stock_price",
    "target_price",
    "upside",
    "upside_pct",
    "discount_to_price",
    "buy_rating",
}


def walk_keys(value: Any, prefix: str = ""):
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            yield path, str(key)
            yield from walk_keys(child, path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_keys(child, f"{prefix}[{index}]")


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be an object"]

    for key, expected_type in TOP_LEVEL.items():
        if key not in payload:
            errors.append(f"missing top-level key: {key}")
        elif not isinstance(payload[key], expected_type):
            errors.append(f"{key} must be {expected_type.__name__}")

    for path, key in walk_keys(payload):
        if key.lower() in BANNED_KEYS:
            errors.append(f"banned key at {path}")

    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        for key in ("code", "name", "last_period"):
            if not isinstance(metadata.get(key), str) or not metadata[key].strip():
                errors.append(f"metadata.{key} must be a non-empty string")

    valuation = payload.get("last_valuation")
    if isinstance(valuation, dict):
        if valuation.get("status") == "unavailable":
            if not isinstance(valuation.get("reason"), str) or not valuation["reason"].strip():
                errors.append("unavailable last_valuation requires reason")
        else:
            if not isinstance(valuation.get("method"), str) or not valuation["method"].strip():
                errors.append("last_valuation.method must be a non-empty string")
            if not isinstance(valuation.get("scenario"), dict) or not valuation["scenario"]:
                errors.append("last_valuation.scenario must be a non-empty object")
            results = valuation.get("results")
            if not isinstance(results, dict):
                errors.append("last_valuation.results must be an object")
            else:
                for key in RESULT_KEYS:
                    if key not in results:
                        errors.append(f"missing last_valuation.results.{key}")
                    elif not finite_number(results[key]):
                        errors.append(f"last_valuation.results.{key} must be a finite number")

    snapshots = payload.get("data_snapshots")
    if isinstance(snapshots, dict) and len(snapshots) < 1:
        errors.append("data_snapshots must contain at least one period")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("state")
    args = parser.parse_args()
    path = Path(args.state)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"ERROR: state file not found: {path}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"ERROR: invalid JSON: {exc}", file=sys.stderr)
        return 2

    errors = validate(payload)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("OK: state.json satisfies NGFI V2 contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
