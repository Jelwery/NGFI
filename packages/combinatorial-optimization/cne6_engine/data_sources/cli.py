"""One-command CNE6 data probing, rebuilding, and validation."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Sequence

from cne6_engine.data_sources.dev_fundamentals_probe import probe
from cne6_engine.data_sources.rebuild import (
    RebuildOptions,
    rebuild_all,
    validate_assets,
)

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATA_ROOT = PACKAGE_ROOT / "data"
DEFAULT_SMOKE_SYMBOLS = ["600519", "000001"]


def _symbols(values: list[str] | None) -> list[str] | None:
    if not values:
        return None
    result: list[str] = []
    for value in values:
        result.extend(part for part in value.replace(",", " ").split() if part)
    return result or None


def _add_network_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--workers", type=int, default=1, choices=range(1, 9), metavar="1..8",
        help="price download workers (default: 1; increase cautiously)",
    )
    parser.add_argument(
        "--attempts", type=int, default=5,
        help="attempts per upstream operation (default: 5)",
    )
    parser.add_argument(
        "--timeout", type=float, default=20.0,
        help="HTTP timeout in seconds (default: 20)",
    )
    parser.add_argument(
        "--request-delay", type=float, default=1.0,
        help="minimum spacing between request starts in seconds (default: 1.0)",
    )


def _rebuild_options(args: argparse.Namespace) -> RebuildOptions:
    return RebuildOptions(
        data_root=args.data_root, start_date=args.start_date,
        end_date=args.end_date, years=sorted(set(args.years)),
        symbols=_symbols(args.symbols), workers=args.workers,
        attempts=args.attempts, timeout=args.timeout,
        request_delay=args.request_delay, allow_partial=args.allow_partial,
        price_source=args.price_source,
    )


def build_parser(today: date | None = None) -> argparse.ArgumentParser:
    today = today or date.today()
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    probe_parser = commands.add_parser(
        "probe", help="print current East Money statement/dividend schemas",
    )
    probe_parser.set_defaults(handler=lambda _args: probe())

    rebuild = commands.add_parser(
        "rebuild", help="build, validate, and atomically publish all assets",
    )
    rebuild.add_argument(
        "--data-root", type=Path, default=DEFAULT_DATA_ROOT,
        help=f"data directory (default: {DEFAULT_DATA_ROOT})",
    )
    rebuild.add_argument(
        "--price-source", choices=["auto", "eastmoney", "sina"],
        default="auto", help="auto uses East Money qfq with Sina fallback",
    )
    rebuild.add_argument("--start-date", default="2016-01-01")
    rebuild.add_argument("--end-date", default=today.isoformat())
    rebuild.add_argument(
        "--years", nargs="+", type=int,
        default=list(range(2018, today.year)),
        help="annual-report years (default: 2018 through last completed year)",
    )
    rebuild.add_argument(
        "--symbols", nargs="+",
        help="optional bare/prefixed symbols; omit for the full A-share snapshot",
    )
    rebuild.add_argument(
        "--allow-partial", action="store_true",
        help="publish successful symbols if some price downloads still fail",
    )
    _add_network_options(rebuild)

    validate = commands.add_parser(
        "validate", help="validate already-published reference assets",
    )
    validate.add_argument("--data-root", type=Path, default=DEFAULT_DATA_ROOT)
    validate.add_argument("--symbols", nargs="+")

    smoke = commands.add_parser(
        "smoke", help="run a real, small end-to-end rebuild in an isolated root",
    )
    smoke.add_argument(
        "--data-root", type=Path, default=DEFAULT_DATA_ROOT / "smoke",
        help="isolated smoke output directory",
    )
    smoke.add_argument(
        "--start-date",
        default=(today - timedelta(days=60)).isoformat(),
    )
    smoke.add_argument("--end-date", default=today.isoformat())
    smoke.add_argument("--years", nargs="+", type=int, default=[today.year - 2])
    smoke.add_argument("--symbols", nargs="+", default=DEFAULT_SMOKE_SYMBOLS)
    smoke.add_argument("--allow-partial", action="store_true")
    smoke.add_argument(
        "--price-source", choices=["auto", "eastmoney", "sina"],
        default="auto", help="auto uses East Money qfq with Sina fallback",
    )
    _add_network_options(smoke)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            report = validate_assets(
                args.data_root.resolve(),
                expected_symbols=set(_symbols(args.symbols) or []),
            )
        elif args.command in {"rebuild", "smoke"}:
            options = _rebuild_options(args)
            print(
                f"CNE6 {args.command}: data_root={options.data_root.resolve()} "
                f"window={options.start_date}..{options.end_date} "
                f"symbols={options.symbols or 'all'} workers={options.workers} "
                f"request_delay={options.request_delay}s",
                flush=True,
            )
            report = rebuild_all(options)
        else:
            args.handler(args)
            return 0
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
