# CNE6/run_pipeline.py
"""CNE6 pipeline entry point.

Usage:
    python run_pipeline.py                 # full lookback (default 252 days)
    python run_pipeline.py 2026-07-25      # specific end date
    python run_pipeline.py --lookback 60   # reduced lookback (dev/backfill)
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cne6_engine.algorithm.pipeline import compute_covariance


def main() -> None:
    parser = argparse.ArgumentParser(description="CNE6 covariance pipeline")
    parser.add_argument("date", nargs="?", default=None,
                        help="end date YYYY-MM-DD (default: latest cached)")
    parser.add_argument("--lookback", type=int, default=252,
                        help="regression lookback in trade days")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    end_date = args.date
    if end_date is None:
        from cne6_engine.interfaces.sina_adapter import SinaAdapter
        adapter = SinaAdapter.from_config()
        import polars as pl
        price_path = adapter.price_path
        end_date = pl.read_parquet(price_path).select(
            pl.col("date").max()
        ).item()
        print(f"Using latest cached price date: {end_date}")

    project_root = os.path.dirname(os.path.abspath(__file__))
    t0 = time.perf_counter()
    result = compute_covariance(
        end_date,
        lookback_days=args.lookback,
        output_dir=os.path.join(project_root, "data", "output"),
        verbose=not args.quiet,
    )
    meta = result["meta"]
    print(
        f"\nDone in {(time.perf_counter() - t0) / 60:.1f} min: "
        f"{meta['n_stocks']} stocks × {meta['n_factors']} factors, "
        f"{meta['n_days']} regression days"
    )


if __name__ == "__main__":
    main()
