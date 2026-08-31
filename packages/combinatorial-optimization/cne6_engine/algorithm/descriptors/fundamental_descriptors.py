# cne6_engine/algorithm/descriptors/fundamental_descriptors.py
"""Fundamental-based CNE6 descriptors (LYR, point-in-time).

Uses the latest annual report visible at the computation date for ratios,
and the last five visible annual reports for variability/growth descriptors.
All values are raw descriptor outputs; the synthesis layer applies winsorize /
z-score normalization.

Documented approximations: ABS uses LYR (MRQ in Barra); EBIT≈利润总额+财务费用;
IBD≈LTD+STD (excludes bonds / current portion); preferred equity defaults to 0
in the data layer (only a few A-share banks issue it).
"""
from __future__ import annotations

import numpy as np
import polars as pl

_MIN_YEARS = 3
_N_YEARS = 5


def visible_annuals(
    fundamentals, date: str, n_years: int = _N_YEARS,
) -> pl.DataFrame:
    """Last `n_years` annual reports observable at `date`, per code.

    Columns carry a `_rn` rank: 1 = most recent visible report.
    """
    vis = fundamentals.frame.filter(
        (pl.col("available_date") <= date)
        & (pl.col("report_date").str.slice(5, 5) == "12-31")
    )
    if vis.is_empty():
        return vis.head(0)
    return (
        vis.sort(["code", "report_date"])
        .with_columns(
            pl.col("report_date")
            .rank("ordinal", descending=True)
            .over("code")
            .alias("_rn")
        )
        .filter(pl.col("_rn") <= n_years)
    )


def _ranked_values(
    annuals: pl.DataFrame, fields: list[str], rank: int,
) -> dict[str, dict[str, float | None]]:
    """Field → {code: value} from the `rank`-th most recent visible report."""
    latest = annuals.filter(pl.col("_rn") == rank)
    out: dict[str, dict[str, float | None]] = {}
    for field in fields:
        sub = latest.select("code", field)
        out[field] = dict(zip(sub["code"].to_list(), sub[field].to_list()))
    return out


def _latest_values(
    annuals: pl.DataFrame, fields: list[str],
) -> dict[str, dict[str, float | None]]:
    """Field → {code: value} from the most recent visible report."""
    return _ranked_values(annuals, fields, 1)


def _series_matrix(
    annuals: pl.DataFrame, field: str, codes: list[str],
) -> tuple[np.ndarray, np.ndarray]:
    """(N, n_years) value matrix oldest→newest and validity counts."""
    n = len(codes)
    if annuals.is_empty():
        return np.full((n, 0), np.nan), np.zeros(n, dtype=np.int64)
    sub = annuals.filter(pl.col("code").is_in(codes))
    max_rn = int(sub["_rn"].max())
    matrix = np.full((n, max_rn), np.nan)
    if sub.is_empty():
        return matrix, np.zeros(n, dtype=np.int64)
    enc = sub.with_columns(
        pl.col("code").replace_strict(
            {c: i for i, c in enumerate(codes)},
            return_dtype=pl.UInt32,
        ).alias("_ci"),
    ).select("_ci", "_rn", field)
    ci = enc["_ci"].to_numpy().astype(np.int64)
    rn = enc["_rn"].to_numpy().astype(np.int64)
    vals = enc[field].to_numpy()
    finite = np.isfinite(vals)
    matrix[ci[finite], (max_rn - rn)[finite]] = vals[finite]
    counts = np.sum(np.isfinite(matrix), axis=1)
    return matrix, counts


def _ratio(numer: np.ndarray, denom: np.ndarray) -> np.ndarray:
    with np.errstate(invalid="ignore", divide="ignore"):
        out = numer / denom
    return np.where(np.isfinite(out), out, np.nan)


def _growth_slope(matrix: np.ndarray) -> np.ndarray:
    """OLS slope / mean over rows (years on x), NaN-aware (vectorized)."""
    n, t = matrix.shape
    out = np.full(n, np.nan)
    if t == 0:
        return out
    ok = np.isfinite(matrix)
    cnt = ok.sum(axis=1)
    valid = cnt >= _MIN_YEARS
    if not valid.any():
        return out
    x = np.arange(1.0, t + 1.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        xm = np.where(ok, x, 0.0).sum(axis=1) / np.maximum(cnt, 1)
        dx = np.where(ok, x - xm[:, None], 0.0)
        denom = (dx * dx).sum(axis=1)
        ym = np.where(ok, matrix, 0.0).sum(axis=1) / np.maximum(cnt, 1)
        numer = (dx * np.where(ok, matrix, 0.0)).sum(axis=1)
        slope = np.where(denom > 0, numer / denom, np.nan)
        ratio = slope / ym
    out[valid] = np.where(ym[valid] != 0, ratio[valid], np.nan)
    return out


def _variability(matrix: np.ndarray) -> np.ndarray:
    """std / |mean| over each row, NaN-aware (vectorized)."""
    n = matrix.shape[0]
    out = np.full(n, np.nan)
    if matrix.shape[1] == 0:
        return out
    ok = np.isfinite(matrix)
    cnt = ok.sum(axis=1)
    valid = cnt >= _MIN_YEARS
    if not valid.any():
        return out
    with np.errstate(invalid="ignore", divide="ignore"):
        msum = np.where(ok, matrix, 0.0).sum(axis=1)
        mean = np.where(cnt > 0, msum / np.maximum(cnt, 1), np.nan)
        diff = np.where(ok, matrix - mean[:, None], 0.0)
        sq = np.where(ok, diff * diff, 0.0)
        std = np.sqrt(
            np.where(cnt >= 2, sq.sum(axis=1) / np.maximum(cnt - 1, 1), np.nan)
        )
        ratio = std / mean
    out[valid] = np.where(mean[valid] != 0, ratio[valid], np.nan)
    return out


def fundamental_field_coverage(
    fundamentals, date: str, codes: list[str], fields: list[str],
) -> dict[str, float]:
    """Per-field non-null coverage of the latest visible annual report."""
    coverage = {field: 0.0 for field in fields}
    annuals = visible_annuals(fundamentals, date, n_years=1)
    if annuals.is_empty():
        return coverage
    latest = annuals.filter(pl.col("_rn") == 1).filter(
        pl.col("code").is_in(codes)
    )
    n = len(codes)
    for field in fields:
        col = latest.select(field).to_series()
        non_null = col.len() - col.null_count()
        coverage[field] = float(non_null) / n if n else 0.0
    return coverage


def compute_fundamental_descriptors(
    fundamentals, date: str, codes: list[str],
    total_cap: np.ndarray,
    close: np.ndarray,           # close of the previous calendar month (DTOP)
    total_cap_prev: np.ndarray | None = None,
) -> dict[str, np.ndarray]:
    """All fundamental descriptors for one date. Returns name → (N,) array.

    ``close`` follows the DTOP convention (previous-month-end close).
    ``total_cap_prev`` is the T−1 market cap (MLEV convention); falls back to
    the current cap when None.
    """
    n = len(codes)
    result: dict[str, np.ndarray] = {}
    annuals = visible_annuals(fundamentals, date)
    if annuals.is_empty():
        return result

    latest = _latest_values(
        annuals, ["equity", "net_income", "operating_cashflow",
                  "total_assets", "total_liabilities", "revenue",
                  "preferred_equity", "long_term_debt", "short_term_debt",
                  "cash", "cogs", "depreciation_amortization", "ebit",
                  "investment_cashflow", "dividend_per_share",
                  "parent_equity", "non_current_liabilities"],
    )
    previous = _ranked_values(
        annuals, ["total_assets", "total_liabilities", "cash",
                  "long_term_debt", "short_term_debt"], 2,
    )

    def col(field: str) -> np.ndarray:
        mapping = latest[field]
        return np.array(
            [mapping.get(c, np.nan) for c in codes], dtype=np.float64,
        )

    def prev(field: str) -> np.ndarray:
        mapping = previous[field]
        return np.array(
            [mapping.get(c, np.nan) for c in codes], dtype=np.float64,
        )

    equity = col("equity")
    parent_equity = col("parent_equity")
    net_income = col("net_income")
    ocf = col("operating_cashflow")
    total_assets = col("total_assets")
    total_liab = col("total_liabilities")
    revenue = col("revenue")
    preferred = col("preferred_equity")
    ncl = col("non_current_liabilities")
    ltd = col("long_term_debt")
    std = col("short_term_debt")
    cash = col("cash")
    cogs = col("cogs")
    da = col("depreciation_amortization")
    ebit = col("ebit")
    cfi = col("investment_cashflow")
    dps = col("dividend_per_share")

    me_prev = total_cap if total_cap_prev is None else total_cap_prev

    # Ratios from the latest visible annual report.
    result["BTOP"] = _ratio(parent_equity, total_cap)
    result["ETOP"] = _ratio(net_income, total_cap)
    result["CETOP"] = _ratio(ocf, total_cap)
    result["DTOA"] = _ratio(total_liab, total_assets)
    result["ATO"] = _ratio(revenue, total_assets)
    result["ROA"] = _ratio(net_income, total_assets)

    # Leverage (Barra: LD=非流动负债合计, PE=优先股, ME 为 T−1 市值).
    result["MLEV"] = _ratio(me_prev + preferred + ncl, me_prev)
    result["BLEV"] = _ratio(equity + preferred + ncl, equity)

    # Earnings yield / profitability.
    result["EM"] = _ratio(ebit, total_cap + ltd + std - cash)
    result["GP"] = _ratio(revenue - cogs, total_assets)
    result["GPM"] = _ratio(revenue - cogs, revenue)

    # Earnings quality.
    result["ACF"] = _ratio(
        -(net_income - (ocf + cfi) + da), total_assets,
    )
    noa0 = (total_assets - cash) - (total_liab - (ltd + std))
    noa1 = (prev("total_assets") - prev("cash")) - (
        prev("total_liabilities") - (prev("long_term_debt") + prev("short_term_debt"))
    )
    result["ABS"] = _ratio(-((noa0 - noa1) - da), total_assets)

    # Dividend yield (TTM per-share dividends / close as of compute date).
    result["DTOP"] = _ratio(dps, close)

    # 5-year variability and growth.
    for name, field in [
        ("VSAL", "revenue"),
        ("VERN", "net_income"),
        ("VFLO", "operating_cashflow"),
        ("AGRO", "total_assets"),
        ("EGRO", "eps"),
        ("IGRO", "total_shares"),
        ("CXGRO", "capex"),
    ]:
        matrix, _ = _series_matrix(annuals, field, codes)
        if name in ("VSAL", "VERN", "VFLO"):
            result[name] = _variability(matrix)
        else:
            result[name] = _growth_slope(matrix)

    # SGRO: growth of revenue per share (revenue / total shares per year).
    mat_rev, _ = _series_matrix(annuals, "revenue", codes)
    mat_sh, _ = _series_matrix(annuals, "total_shares", codes)
    with np.errstate(invalid="ignore", divide="ignore"):
        per_share = mat_rev / mat_sh
    result["SGRO"] = _growth_slope(per_share)

    return result
