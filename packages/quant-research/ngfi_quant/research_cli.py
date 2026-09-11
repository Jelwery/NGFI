"""Local file import/run CLI. The Agent uses IDs, never arbitrary file paths."""

from __future__ import annotations

import argparse
from datetime import date, timedelta
import json
from pathlib import Path
import sys

import numpy as np

from .experiment_store import dispatch_research
from .research_factors import factor_catalog


def demo_input() -> tuple[dict, dict]:
    """Synthetic, deterministic integration dataset; never presented as market evidence."""
    dates = []
    day = date(2024, 1, 2)
    while len(dates) < 100:
        if day.weekday() < 5:
            dates.append(day.isoformat())
        day += timedelta(days=1)
    rng = np.random.default_rng(17)
    prices = np.linspace(10, 30, 8)
    bars = []
    for day in dates:
        for stock in range(8):
            previous = float(prices[stock])
            opened = previous * (1 + rng.normal(0, 0.003))
            close = opened * (1 + rng.normal(0.0002 + stock * 0.0001, 0.007))
            prices[stock] = close
            bars.append({
                "date": day, "instrument": {"market": "CN", "exchange": "SSE", "symbol": str(600000 + stock)},
                "availableAt": f"{day}T15:05:00+08:00",
                "open": opened, "high": max(opened, close) * 1.01, "low": min(opened, close) * 0.99,
                "close": close, "previousClose": previous, "volume": 1_000_000.0,
                "amount": close * 1_000_000, "eligible": True, "industry": f"sector-{stock % 2}",
            })
    dataset = {
        "snapshotId": "synthetic-demo-v1", "asOf": f"{dates[-1]}T17:00:00+08:00",
        "provenance": "Generated synthetic prices for integration verification; not real A-share market data.",
        "priceBasis": "raw-no-corporate-actions", "universePolicy": "explicit-research-universe",
        "calendar": [{"date": day, "openAt": f"{day}T09:30:00+08:00", "closeAt": f"{day}T15:00:00+08:00",
                      "decisionAt": f"{day}T16:00:00+08:00"} for day in dates], "bars": bars,
    }
    spec = {
        "startDate": dates[55], "endDate": dates[93], "factors": factor_catalog()["factors"][:3],
        "model": {"trainSessions": 30, "refitEvery": 10, "horizon": 5, "minimumSamples": 30},
        "optimizer": {"maxWeight": 0.2, "riskLookback": 20, "industryCaps": {"sector-0": 0.6, "sector-1": 0.6}},
        "execution": {"rebalanceEvery": 5},
    }
    return dataset, spec


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", required=True, help="Trusted operator-selected local research store")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("catalog")
    commands.add_parser("schema", help="Print native NGFI dataset and experiment JSON schemas")
    commands.add_parser("demo", help="Run an explicitly synthetic end-to-end example")
    commands.add_parser("list")
    importer = commands.add_parser("import")
    importer.add_argument("file", type=Path)
    runner = commands.add_parser("run")
    runner.add_argument("--dataset-id", required=True)
    runner.add_argument("--spec", required=True, type=Path)
    getter = commands.add_parser("get")
    getter.add_argument("run_id")
    getter.add_argument("--section", default="summary")
    getter.add_argument("--offset", type=int, default=0)
    getter.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()
    if args.command == "demo":
        dataset, spec = demo_input()
        imported = dispatch_research(args.store, {"action": "import", "dataset": dataset})
        result = dispatch_research(args.store, {"action": "run", "datasetId": imported["datasetId"], "spec": spec})
        result["synthetic"] = True
    else:
        request = {"action": args.command}
        if args.command == "import":
            request["dataset"] = json.loads(args.file.read_text())
        elif args.command == "run":
            request.update(datasetId=args.dataset_id, spec=json.loads(args.spec.read_text()))
        elif args.command == "get":
            request.update(runId=args.run_id, section=args.section, offset=args.offset, limit=args.limit)
        result = dispatch_research(args.store, request)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2, allow_nan=False)
    print()


if __name__ == "__main__":
    main()
