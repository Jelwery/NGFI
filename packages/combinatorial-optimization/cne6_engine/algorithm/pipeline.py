# cne6_engine/algorithm/pipeline.py
"""CNE6 pipeline orchestration: exposure history → regression → covariance.

Daily flow for one ``end_date``:
  1. Load the DataBundle (layer 2 adapter).
  2. For each of the last ``lookback_days`` trade dates, build (or load from
     cache) the daily exposure matrix X_t = [country, industry, styles].
     Columns align to the declared factor dictionary; a style missing on a date
     yields NaN for every stock, which drops that date's regression.
  3. Stream daily WLS regressions → factor returns f and specific returns u.
  4. Factor covariance F (NW-EWMA ×2 + VRA + OBA) and specific risk σ.
  5. Σ = X · F · Xᵀ + diag(σ²), persisted as .npy.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field

import numpy as np
import polars as pl

from cne6_engine.algorithm.descriptors import compute_descriptors
from cne6_engine.algorithm.factor_cov import compute_factor_covariance
from cne6_engine.algorithm.factor_return import (
    daily_cross_sectional_regression_time_varying,
)
from cne6_engine.algorithm.registry import level1_names
from cne6_engine.algorithm.specific_risk import compute_specific_risk
from cne6_engine.algorithm.synthesis import synthesize_styles

SCHEMA_VERSION = 2
EXPOSURE_CONFIG_VERSION = "vintage-pit-v3"


def _json_safe(value):
    if isinstance(value, np.ndarray):
        return _json_safe(value.tolist())
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_safe(v) for v in value]
    if isinstance(value, np.generic):
        return _json_safe(value.item())
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def _exposure_identity(bundle) -> str:
    digest = hashlib.sha256(json.dumps(_json_safe({
        "schema": SCHEMA_VERSION, "config": EXPOSURE_CONFIG_VERSION,
        "quality": bundle.quality.to_dict(), "provenance": bundle.provenance,
    }), sort_keys=True).encode())
    # Hash actual contract contents too: callers may change an in-memory bundle
    # while retaining its original source/version tag.
    for contract in (bundle.market, bundle.benchmark, bundle.fundamentals, bundle.industry, bundle.analyst):
        if contract is not None:
            digest.update(str(contract.frame.schema).encode())
            digest.update(contract.frame.hash_rows(seed=0).to_numpy().tobytes())
    return digest.hexdigest()


@dataclass
class DailyExposure:
    date: str
    codes: list[str]
    X: np.ndarray            # (N, K)
    factor_names: list[str]
    market_cap: np.ndarray    # (N,)
    industry: list[str]
    style_names: list[str]
    metadata: dict = field(default_factory=dict)


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
    cache_identity: str | None = None,
) -> DailyExposure:
    """Compute (or load cached) exposures for one date.

    Canonical column sets keep K identical across dates; pass None to use
    this date's own sets (used for the end date, which defines them).
    """
    identity = cache_identity or _exposure_identity(bundle)
    metadata: dict = {}
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
        if (len(cached) and "cache_identity" in cached.columns and "quality_metadata" in cached.columns
                and cached["schema_version"][0] == SCHEMA_VERSION
                and cached["cache_identity"][0] == identity):
            metadata = json.loads(cached["quality_metadata"][0])
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
        # Never resurrect a delisted/missing end-date security via median fill.
        current_codes = set(last["code"].to_list())
        valid = smeta["valid_mask"] & np.array([c in current_codes for c in codes])
        exclusions = dict(bundle.provenance.get("universe", {}).get("exclusions", {}))
        exclusions.update({c: "missing_current_market_row" if c not in current_codes else "invalid_style_exposure"
                           for c, keep in zip(codes, valid) if not keep})
        descriptor_quality = meta["descriptor_quality"]
        for name, fill_mask in smeta["fill_masks"].items():
            record = descriptor_quality[name]
            imputed_codes = {c for c, filled in zip(codes, fill_mask) if filled}
            record["imputed_mask"] = [c in imputed_codes for c in meta["original_universe"]["codes"]]
            record["post_synthesis_quality_mask"] = ["imputed" if c in imputed_codes else q
                for c, q in zip(meta["original_universe"]["codes"], record["quality_mask"])]
        metadata = _json_safe({
            "descriptors": meta, "synthesis": smeta, "exclusions": exclusions,
            "original_universe": meta["original_universe"],
            "coverage": {"numerator": int(valid.sum()), "denominator": meta["original_universe"]["count"],
                         "coverage": float(valid.sum() / meta["original_universe"]["count"]) if meta["original_universe"]["count"] else 0.0},
            "cache_identity": identity,
        })
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
                pl.lit(identity).alias("cache_identity"),
                pl.lit(json.dumps(metadata, allow_nan=False, sort_keys=True)).alias("quality_metadata"),
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
        date, codes, X, factor_names, caps, industries, list(style_names), metadata,
    )


def _pivot_returns(bundle, dates: list[str], codes: list[str]) -> np.ndarray:
    frame = bundle.market.frame.filter(pl.col("date").is_in(dates) & pl.col("code").is_in(codes))
    mat = np.full((len(dates), len(codes)), np.nan)
    date_idx = {d: i for i, d in enumerate(dates)}
    code_idx = {c: i for i, c in enumerate(codes)}
    for code, date, value in frame.select("code", "date", "daily_return").iter_rows():
        mat[date_idx[date], code_idx[code]] = np.nan if value is None else value
    return mat


def compute_covariance(
    end_date: str,
    *,
    factor_dictionary: dict,
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
    cache_identity = getattr(adapter, "cache_identity", None)
    if cache_identity:
        cache_dir = os.path.join(cache_dir, f"snapshot-{cache_identity}")

    t0 = time.perf_counter()
    bundle = adapter.load_bundle(end_date)
    exposure_identity = _exposure_identity(bundle)
    if verbose:
        print(f"[1/4] bundle loaded ({time.perf_counter() - t0:.1f}s)")

    all_dates = bundle.market.dates
    dates = [d for d in all_dates if d <= end_date][-lookback_days:]
    if len(dates) < 30:
        raise ValueError(
            f"only {len(dates)} trade dates available; need >= 30"
        )

    if (not isinstance(factor_dictionary, dict) or set(factor_dictionary) != {"version", "validFrom", "validThrough", "industries", "styles"}
            or not isinstance(factor_dictionary["version"], str) or not factor_dictionary["version"]):
        raise ValueError("a versioned factor dictionary is required")
    from datetime import date as calendar_date
    valid_from = calendar_date.fromisoformat(factor_dictionary["validFrom"])
    valid_through = calendar_date.fromisoformat(factor_dictionary["validThrough"])
    first_index = all_dates.index(dates[0])
    first_exposure = all_dates[max(0, first_index - 1)]
    if not valid_from <= calendar_date.fromisoformat(first_exposure) <= calendar_date.fromisoformat(end_date) <= valid_through:
        raise ValueError("factor dictionary must cover all lagged exposures and the end date")
    canonical_industries = factor_dictionary["industries"]
    canonical_styles = factor_dictionary["styles"]
    for names in (canonical_industries, canonical_styles):
        if not isinstance(names, list) or not names or any(not isinstance(name, str) or not name for name in names) or len(names) != len(set(names)):
            raise ValueError("factor dictionary columns must be non-empty unique names")
    if set(canonical_styles) - set(level1_names()) or set(canonical_industries) & (set(canonical_styles) | {"COUNTRY"}):
        raise ValueError("invalid or colliding factor dictionary columns")
    factor_dictionary = json.loads(json.dumps(factor_dictionary))
    dictionary_hash = hashlib.sha256(json.dumps(factor_dictionary, sort_keys=True).encode()).hexdigest()

    t0 = time.perf_counter()
    end_exp = build_daily_exposure(
        bundle, end_date, cache_dir=cache_dir, verbose=verbose,
        cache_identity=exposure_identity,
        canonical_industries=canonical_industries, canonical_styles=canonical_styles,
    )

    codes = end_exp.codes
    code_idx = {c: i for i, c in enumerate(codes)}
    N = len(codes)
    K = len(end_exp.factor_names)
    n_ind = len(canonical_industries)

    # Regress on the historical universe, not only surviving end-date codes.
    # Residuals are projected back to final codes only AFTER each regression.
    history_codes = bundle.market.codes
    history_idx = {c: i for i, c in enumerate(history_codes)}
    returns = _pivot_returns(bundle, dates, history_codes)
    previous_dates = {d: all_dates[i - 1] if i else None for i, d in enumerate(all_dates)}
    n_days = len(dates)
    factor_returns = np.full((n_days, K), np.nan)
    specific_returns = np.full((n_days, N), np.nan)
    regression_quality = []

    for t, d in enumerate(dates):
        exposure_date = previous_dates[d]
        diagnostic = {"date": d, "exposure_date": exposure_date, "quality_flag": "missing",
                      "numerator": 0, "denominator": int(np.isfinite(returns[t]).sum()), "coverage": 0.0}
        regression_quality.append(diagnostic)
        if exposure_date is None:
            diagnostic["reason"] = "no_prior_trading_date"
            continue
        day = build_daily_exposure(
            bundle, exposure_date, cache_dir=cache_dir,
            canonical_industries=canonical_industries,
            canonical_styles=canonical_styles, verbose=False, cache_identity=exposure_identity,
        )
        y_t = np.array([returns[t, history_idx[c]] for c in day.codes])
        valid = np.isfinite(y_t) & np.isfinite(day.X).all(axis=1) & np.isfinite(day.market_cap) & (day.market_cap > 0)
        diagnostic.update({"codes": [c for c, keep in zip(day.codes, valid) if keep],
                           "numerator": int(valid.sum()),
                           "coverage": float(valid.sum() / diagnostic["denominator"]) if diagnostic["denominator"] else 0.0,
                           "descriptor_quality": {name: {key: record[key] for key in ("quality_flag", "coverage", "numerator", "denominator", "reasons")}
                                                  for name, record in day.metadata["descriptors"]["descriptor_quality"].items()},
                           "exclusions": day.metadata["exclusions"]})
        f_t, u_t = daily_cross_sectional_regression_time_varying(
            y_t[np.newaxis, :], day.X[np.newaxis, :, :],
            day.market_cap[np.newaxis, :], industry_count=n_ind,
        )
        factor_returns[t] = f_t[0]
        diagnostic["quality_flag"] = "unverified" if np.isfinite(f_t[0]).all() else "missing"
        for j, c in enumerate(day.codes):
            if c in code_idx:
                specific_returns[t, code_idx[c]] = u_t[0, j]

    valid_days = np.isfinite(factor_returns).all(axis=1)
    if verbose:
        print(f"[2/4] regressions done: {int(valid_days.sum())}/{n_days} days "
              f"({time.perf_counter() - t0:.1f}s)")

    if valid_days.sum() < 2:
        raise ValueError("need at least two valid lagged cross-sectional regressions")
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
    numerical_diagnostics: dict = {}
    F = compute_factor_covariance(f_valid, diagnostics=numerical_diagnostics, **cov_kwargs)

    sr_kwargs = dict(
        vol_half_life=21, nw_lags=5, nw_half_life=252,
        bayesian_q=0.25, vra_half_life=42,
    )
    sr_kwargs.update(specific_risk_kwargs or {})
    end_caps = end_exp.market_cap
    sigma = compute_specific_risk(u_valid, end_caps, **sr_kwargs)
    finite_exposure = np.isfinite(end_exp.X).all(axis=1)
    valid_risk = np.isfinite(sigma) & (sigma > 0) & finite_exposure
    risk_exclusions = {c: "missing_declared_factor_exposure" if not exposed else "insufficient_specific_return_history"
                       for c, keep, exposed in zip(codes, valid_risk, finite_exposure) if not keep}
    if not valid_risk.any():
        raise ValueError("no securities have finite positive specific risk")
    codes = [c for c, keep in zip(codes, valid_risk) if keep]
    sigma = sigma[valid_risk]
    N = len(codes)
    if verbose:
        print(f"[3/4] F and sigma estimated ({time.perf_counter() - t0:.1f}s)")

    # ---- assemble stock covariance ----
    X_end = end_exp.X[valid_risk]
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
            "factor_dictionary": factor_dictionary, "factor_dictionary_hash": dictionary_hash,
            "specific_risk_kwargs": sr_kwargs,
            "provenance": bundle.provenance,
            "available_at": bundle.provenance.get("model_available_at"),
            "data_quality": {
                "source_quality": _json_safe(bundle.quality.to_dict()),
                "descriptor_quality": end_exp.metadata["descriptors"]["descriptor_quality"],
                "descriptor_exclusions": end_exp.metadata["descriptors"]["excluded"],
                "synthesis": end_exp.metadata["synthesis"],
                "original_universe": end_exp.metadata["original_universe"],
                "exclusions": {**end_exp.metadata["exclusions"], **risk_exclusions},
                "coverage": {"numerator": N, "denominator": end_exp.metadata["original_universe"]["count"],
                             "coverage": N / end_exp.metadata["original_universe"]["count"]},
                "factor_returns": {"exposure_timing": "previous_trading_day", "universe": "time_varying",
                                   "point_in_time": bundle.quality.point_in_time is True, "quality_flag": "unverified",
                                   "coverage": float(valid_days.mean()), "numerator": int(valid_days.sum()), "denominator": n_days,
                                   "factor_dictionary_hash": dictionary_hash,
                                   "reasons": ["provider_pit_not_verified"] if bundle.quality.point_in_time is not True else [],
                                   "days": regression_quality},
                "specific_returns": {"codes": end_exp.codes, "numerator": np.isfinite(u_valid).sum(axis=0).tolist(),
                                     "denominator": len(u_valid), "coverage": np.isfinite(u_valid).mean(axis=0).tolist()},
                "numerical_diagnostics": numerical_diagnostics,
                "cache_identity": exposure_identity,
            },
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
