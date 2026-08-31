# cne6_engine/algorithm/pipeline.py
"""CNE6 pipeline orchestration: exposure history → regression → covariance.

Daily flow for one ``end_date``:
  1. Load the DataBundle (layer 2 adapter).
  2. For each of the last ``lookback_days`` trade dates, build (or load from
     cache) the daily exposure matrix X_t = [country, industry, styles].
     Columns align to the end-date factor set; a style missing on a date
     yields NaN for every stock, which drops that date's regression.
  3. Stream daily WLS regressions → factor returns f and specific returns u.
  4. Factor covariance F (NW-EWMA ×2 + VRA + OBA) and specific risk σ.
  5. Σ = X · F · Xᵀ + diag(σ²), persisted as .npy.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass

import numpy as np
import polars as pl

from cne6_engine.algorithm.descriptors import compute_descriptors
from cne6_engine.algorithm.factor_cov import compute_factor_covariance
from cne6_engine.algorithm.factor_return import (
    daily_cross_sectional_regression_time_varying,
)
from cne6_engine.algorithm.specific_risk import compute_specific_risk
from cne6_engine.algorithm.synthesis import synthesize_styles

SCHEMA_VERSION = 1


@dataclass
class DailyExposure:
    date: str
    codes: list[str]
    X: np.ndarray            # (N, K)
    factor_names: list[str]
    market_cap: np.ndarray    # (N,)
    industry: list[str]
    style_names: list[str]


def _design_matrix(
    industries: list[str], S: np.ndarray | None, style_names: list[str] | None,
    canonical_industries: list[str], canonical_styles: list[str],
) -> tuple[np.ndarray, list[str]]:
    n = len(industries)
    dummy = np.zeros((n, len(canonical_industries)))
    for i, ind in enumerate(industries):
        if ind in canonical_industries:
            dummy[i, canonical_industries.index(ind)] = 1.0
        else:
            dummy[i, :] = np.nan

    style_block = np.full((n, len(canonical_styles)), np.nan)
    if S is not None and style_names:
        for j, name in enumerate(style_names):
            if name in canonical_styles:
                style_block[:, canonical_styles.index(name)] = S[:, j]

    X = np.column_stack([np.ones(n), dummy, style_block])
    factor_names = ["COUNTRY"] + canonical_industries + canonical_styles
    return X, factor_names


def build_daily_exposure(
    bundle,
    date: str,
    cache_dir: str | None = None,
    canonical_industries: list[str] | None = None,
    canonical_styles: list[str] | None = None,
    verbose: bool = False,
) -> DailyExposure:
    """Compute (or load cached) exposures for one date.

    Canonical column sets keep K identical across dates; pass None to use
    this date's own sets (used for the end date, which defines them).
    """
    cache_path = (
        os.path.join(cache_dir, f"exposures_{date}.parquet")
        if cache_dir else None
    )

    codes: list[str] | None = None
    industries: list[str] | None = None
    caps: np.ndarray | None = None
    S: np.ndarray | None = None
    style_names: list[str] | None = None

    if cache_path and os.path.exists(cache_path):
        cached = pl.read_parquet(cache_path)
        if cached["schema_version"][0] == SCHEMA_VERSION:
            codes = cached["code"].to_list()
            industries = cached["industry"].to_list()
            caps = cached["market_cap"].to_numpy().astype(float)
            style_cols = [c for c in cached.columns if c.startswith("style_")]
            style_names = [c.removeprefix("style_") for c in style_cols]
            S = cached.select(style_cols).to_numpy().astype(float)

    if codes is None:
        t0 = time.perf_counter()
        frame, meta = compute_descriptors(bundle, date)
        last = (
            bundle.market.frame
            .filter(pl.col("date") == date)
            .select("code", "float_market_cap")
        )
        caps_map = dict(zip(
            last["code"].to_list(), last["float_market_cap"].to_list(),
        ))
        codes = frame["code"].to_list()
        caps = np.array(
            [caps_map.get(c, np.nan) for c in codes], dtype=float,
        )

        industry_map = bundle.industry.mapping()
        S, style_names, smeta = synthesize_styles(
            frame, industry_map, caps,
        )
        valid = smeta["valid_mask"]
        if not valid.all():
            codes = [c for c, v in zip(codes, valid) if v]
            caps = caps[valid]
            S = S[valid]
            frame = frame.filter(pl.Series(valid))
        industries = [industry_map.get(c, "未知") for c in codes]

        if verbose:
            print(f"  exposure {date}: {len(codes)} stocks "
                  f"({time.perf_counter() - t0:.1f}s)")

        if cache_path:
            os.makedirs(cache_dir, exist_ok=True)
            out = frame.select("code").with_columns(
                pl.Series("industry", industries),
                pl.Series("market_cap", caps),
                pl.lit(SCHEMA_VERSION).alias("schema_version"),
                *[
                    pl.Series(f"style_{name}", S[:, j])
                    for j, name in enumerate(style_names)
                ],
            )
            out.write_parquet(cache_path, compression="zstd")

    if canonical_industries is None:
        canonical_industries = sorted(set(industries))
    if canonical_styles is None:
        canonical_styles = list(style_names)

    X, factor_names = _design_matrix(
        industries, S, style_names, canonical_industries, canonical_styles,
    )
    return DailyExposure(
        date, codes, X, factor_names, caps, industries, list(style_names),
    )


def _pivot_returns(bundle, dates: list[str], codes: list[str]) -> np.ndarray:
    frame = bundle.market.frame.filter(
        pl.col("date").is_in(dates) & pl.col("code").is_in(codes)
    )
    pivot = frame.pivot(index="date", on="code", values="daily_return")
    pivot = pivot.sort("date")
    pivot = pivot.select(["date"] + codes)
    mat = pivot.drop("date").to_numpy().astype(float)
    date_rows = pivot["date"].to_list()
    if date_rows != dates:
        raise ValueError("return panel dates misaligned with exposure dates")
    return mat


def compute_covariance(
    end_date: str,
    *,
    adapter=None,
    lookback_days: int = 252,
    cache_dir: str | None = None,
    output_dir: str | None = None,
    factor_cov_kwargs: dict | None = None,
    specific_risk_kwargs: dict | None = None,
    verbose: bool = True,
) -> dict:
    """Run the full pipeline for one end date.

    Returns dict with keys: sigma_stock (Σ), exposures (X), factor_cov (F),
    specific_risk, codes, factor_names, meta.
    """
    if adapter is None:
        from cne6_engine.interfaces.sina_adapter import SinaAdapter
        adapter = SinaAdapter.from_config()
    if cache_dir is None:
        pkg_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cache_dir = os.path.join(
            os.path.normpath(os.path.join(pkg_root, "..")),
            "data", "exposure_history",
        )

    t0 = time.perf_counter()
    bundle = adapter.load_bundle(end_date)
    if verbose:
        print(f"[1/4] bundle loaded ({time.perf_counter() - t0:.1f}s)")

    all_dates = bundle.market.dates
    dates = [d for d in all_dates if d <= end_date][-lookback_days:]
    if len(dates) < 30:
        raise ValueError(
            f"only {len(dates)} trade dates available; need >= 30"
        )

    # ---- exposures + streaming regression ----
    t0 = time.perf_counter()
    end_exp = build_daily_exposure(
        bundle, end_date, cache_dir=cache_dir, verbose=verbose,
    )
    canonical_industries = sorted(set(end_exp.industry))
    canonical_styles = end_exp.style_names

    codes = end_exp.codes
    code_idx = {c: i for i, c in enumerate(codes)}
    N = len(codes)
    K = len(end_exp.factor_names)
    n_ind = len(canonical_industries)

    returns = _pivot_returns(bundle, dates, codes)

    n_days = len(dates)
    factor_returns = np.full((n_days, K), np.nan)
    specific_returns = np.full((n_days, N), np.nan)
    caps_cube = np.full((n_days, N), np.nan)

    for t, d in enumerate(dates):
        if d == end_date:
            day = end_exp
        else:
            day = build_daily_exposure(
                bundle, d, cache_dir=cache_dir,
                canonical_industries=canonical_industries,
                canonical_styles=canonical_styles, verbose=False,
            )
        X_t = np.full((N, K), np.nan)
        caps_t = np.full(N, np.nan)
        if day.X.shape[1] == K:
            for j, c in enumerate(day.codes):
                i = code_idx.get(c)
                if i is not None:
                    X_t[i] = day.X[j]
                    caps_t[i] = day.market_cap[j]
        caps_cube[t] = caps_t
        f_t, u_t = daily_cross_sectional_regression_time_varying(
            returns[t:t + 1], X_t[np.newaxis, :, :],
            caps_t[np.newaxis, :], industry_count=n_ind,
        )
        factor_returns[t] = f_t[0]
        specific_returns[t] = u_t[0]

    valid_days = np.isfinite(factor_returns).all(axis=1)
    if verbose:
        print(f"[2/4] regressions done: {int(valid_days.sum())}/{n_days} days "
              f"({time.perf_counter() - t0:.1f}s)")

    f_valid = factor_returns[valid_days]
    u_valid = specific_returns[valid_days]

    # ---- factor covariance ----
    t0 = time.perf_counter()
    cov_kwargs = dict(
        vol_half_life=84, vol_nw_lags=5,
        corr_half_life=504, corr_nw_lags=2,
        vra_half_life=42, oba_method="monte_carlo",
        n_simulations=100, seed=42,
    )
    cov_kwargs.update(factor_cov_kwargs or {})
    F = compute_factor_covariance(f_valid, **cov_kwargs)

    sr_kwargs = dict(
        vol_half_life=21, nw_lags=5, nw_half_life=252,
        bayesian_q=0.25, vra_half_life=42,
    )
    sr_kwargs.update(specific_risk_kwargs or {})
    end_caps = caps_cube[valid_days][-1]
    sigma = compute_specific_risk(u_valid, end_caps, **sr_kwargs)
    if verbose:
        print(f"[3/4] F and sigma estimated ({time.perf_counter() - t0:.1f}s)")

    # ---- assemble stock covariance ----
    X_end = end_exp.X
    sigma_stock = X_end @ F @ X_end.T
    sigma_stock[np.diag_indices(N)] += sigma ** 2

    result = {
        "sigma_stock": sigma_stock,
        "exposures": X_end,
        "factor_cov": F,
        "specific_risk": sigma,
        "codes": codes,
        "factor_names": end_exp.factor_names,
        "meta": {
            "end_date": end_date,
            "n_days": int(valid_days.sum()),
            "lookback_days": lookback_days,
            "n_stocks": N,
            "n_factors": K,
            "factor_cov_kwargs": cov_kwargs,
            "specific_risk_kwargs": sr_kwargs,
            "provenance": bundle.provenance,
        },
    }

    if output_dir:
        _save_outputs(result, output_dir)
        if verbose:
            print(f"[4/4] outputs saved to {output_dir}")

    return result


def _save_outputs(result: dict, output_dir: str) -> None:
    os.makedirs(output_dir, exist_ok=True)
    end = result["meta"]["end_date"]
    np.save(os.path.join(output_dir, f"exposures_{end}.npy"), result["exposures"])
    np.save(os.path.join(output_dir, f"factor_cov_{end}.npy"), result["factor_cov"])
    np.save(
        os.path.join(output_dir, f"specific_risk_{end}.npy"),
        result["specific_risk"],
    )
    np.save(
        os.path.join(output_dir, f"stock_cov_{end}.npy"),
        result["sigma_stock"],
    )
    with open(os.path.join(output_dir, f"codes_{end}.json"), "w") as f:
        json.dump(result["codes"], f)
    with open(os.path.join(output_dir, f"factor_names_{end}.json"), "w", encoding="utf-8") as f:
        json.dump(result["factor_names"], f, ensure_ascii=False)
    with open(os.path.join(output_dir, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(result["meta"], f, ensure_ascii=False, indent=2, default=str)
