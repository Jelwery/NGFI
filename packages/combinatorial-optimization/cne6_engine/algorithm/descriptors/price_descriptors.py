# cne6_engine/algorithm/descriptors/price_descriptors.py
"""Price-based CNE6 descriptors computed from the market panel.

Every function takes a MarketPanel and returns a (N,) array aligned to
panel.codes.  All follow the CNE6 parameter set from the reference
(barra_cne6_factor_reference.py, VERSION=6).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

from cne6_engine.algorithm.rolling import (
    _ewma_std_last,
    _ewma_sum_at,
    _ewma_sum_at_sliding,
    _trailing_sum,
    _wls_at_targets,
    _wls_at_targets_sliding,
    cmra_range,
    monthly_returns,
)


_MARKET_GRID_COLS = (
    "daily_return", "close", "turnover_rate",
    "float_market_cap", "total_market_cap",
)


@dataclass
class MarketPanel:
    """Pivoted market matrices for one computation date, oldest date first."""

    codes: list[str]
    dates: list[str]
    returns: np.ndarray        # (N, T)
    close: np.ndarray          # (N, T)
    turnover: np.ndarray       # (N, T)
    float_cap: np.ndarray      # (N, T)
    total_cap: np.ndarray      # (N, T)
    benchmark: np.ndarray      # (T,)
    industry: list[str]        # (N,) industry label per stock

    @classmethod
    def from_bundle(
        cls, bundle, date: str, max_dates: int = 1400,
    ) -> "MarketPanel":
        frame = bundle.market.frame.filter(pl.col("date") <= date)
        dates = frame["date"].unique().sort().to_list()
        if max_dates and len(dates) > max_dates:
            dates = dates[-max_dates:]
            frame = frame.filter(pl.col("date").is_in(dates))
        if not dates:
            raise ValueError(f"no market dates at or before {date}")

        industry_map = bundle.industry.mapping()
        codes = sorted(frame["code"].unique().to_list())

        # Grid fill via integer indexing beats 5× polars pivot on ~7M rows.
        enc = frame.with_columns([
            pl.col("code").replace_strict(
                {c: i for i, c in enumerate(codes)},
                return_dtype=pl.UInt32,
            ).alias("_ci"),
            pl.col("date").replace_strict(
                {d: j for j, d in enumerate(dates)},
                return_dtype=pl.UInt32,
            ).alias("_di"),
        ])
        ci = enc["_ci"].to_numpy().astype(np.int64)
        di = enc["_di"].to_numpy().astype(np.int64)

        grids: dict[str, np.ndarray] = {}
        for name in _MARKET_GRID_COLS:
            grid = np.full((len(codes), len(dates)), np.nan)
            grid[ci, di] = enc[name].to_numpy()
            grids[name] = grid

        bench_map = bundle.benchmark.returns
        benchmark = np.array(
            [bench_map.get(d, np.nan) for d in dates], dtype=np.float64
        )

        return cls(
            codes=codes,
            dates=dates,
            returns=grids["daily_return"],
            close=grids["close"],
            turnover=grids["turnover_rate"],
            float_cap=grids["float_market_cap"],
            total_cap=grids["total_market_cap"],
            benchmark=benchmark,
            industry=[industry_map.get(c, "未知") for c in codes],
        )

    @property
    def n(self) -> int:
        return len(self.codes)

    @property
    def t(self) -> int:
        return len(self.dates)


def _last_targets(t: int, count: int) -> np.ndarray:
    return np.arange(t - count, t, dtype=np.int64)


# ---------------------------------------------------------------------------
# Size
# ---------------------------------------------------------------------------

def lncap(panel: MarketPanel) -> np.ndarray:
    return np.log(panel.float_cap[:, -1])


def midcap(panel: MarketPanel) -> np.ndarray:
    x = np.log(panel.float_cap[:, -1])
    valid = np.isfinite(x)
    y = np.where(valid, x, 0.0) ** 3
    resid = np.full_like(x, np.nan)
    if valid.sum() < 3:
        return resid
    X = np.column_stack([np.ones(valid.sum()), x[valid]])
    coef, *_ = np.linalg.lstsq(X, y[valid], rcond=None)
    resid[valid] = y[valid] - X @ coef
    return resid


# ---------------------------------------------------------------------------
# Volatility
# ---------------------------------------------------------------------------

def _capm(panel: MarketPanel, window: int, half_life: int, targets: np.ndarray):
    first_valid = np.argmax(np.isfinite(panel.returns), axis=1)
    return _wls_at_targets(
        panel.returns, panel.benchmark, window, half_life, targets, first_valid,
    )


def hbeta(panel: MarketPanel) -> np.ndarray:
    return _capm(panel, 504, 252, _last_targets(panel.t, 1))[:, 0, 0]


def hsigma(panel: MarketPanel) -> np.ndarray:
    return _capm(panel, 504, 252, _last_targets(panel.t, 1))[:, 0, 2]


def halpha(panel: MarketPanel) -> np.ndarray:
    return _capm(panel, 504, 252, _last_targets(panel.t, 1))[:, 0, 1]


def dastd(panel: MarketPanel) -> np.ndarray:
    return _ewma_std_last(panel.returns, 252, 42)


def cmra(panel: MarketPanel) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        log_ret = np.log1p(panel.returns)
    return cmra_range(log_ret, months=12, days_per_month=21)


# ---------------------------------------------------------------------------
# Liquidity
# ---------------------------------------------------------------------------

def _stox(panel: MarketPanel, window: int, periods: int) -> np.ndarray:
    total = _trailing_sum(panel.turnover, window)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.log(total / periods)
    return np.where(np.isfinite(out) & (total > 0), out, np.nan)


def stom(panel: MarketPanel) -> np.ndarray:
    return _stox(panel, 21, 1)


def stoq(panel: MarketPanel) -> np.ndarray:
    return _stox(panel, 63, 3)


def stoa(panel: MarketPanel) -> np.ndarray:
    return _stox(panel, 252, 12)


def atvr(panel: MarketPanel) -> np.ndarray:
    return _ewma_sum_at(
        panel.turnover, 252, 63, _last_targets(panel.t, 1),
    )[:, 0]


# ---------------------------------------------------------------------------
# Momentum
# ---------------------------------------------------------------------------

def strev(panel: MarketPanel) -> np.ndarray:
    return _ewma_sum_at(
        panel.returns, 21, 5, _last_targets(panel.t, 1),
    )[:, 0]


def season(panel: MarketPanel, years: int = 5) -> np.ndarray:
    m = monthly_returns(panel.close, lag=21)
    t = panel.t
    out = np.full(panel.n, np.nan)
    vals = []
    for i in range(1, years + 1):
        shift = i * 252 - 21
        idx = t - 1 - shift
        if idx >= 21:
            vals.append(m[:, idx])
        else:
            vals.append(np.full(panel.n, np.nan))
    stacked = np.vstack(vals)
    with np.errstate(invalid="ignore"):
        out = np.nanmean(stacked, axis=0)
    return out


def indmom(panel: MarketPanel) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        log_ret = np.log1p(panel.returns)
    rs = _ewma_sum_at(
        log_ret, 126, 21, _last_targets(panel.t, 1),
    )[:, 0]

    cap = panel.float_cap[:, -1]
    weight = np.sqrt(np.where(cap > 0, cap, np.nan))

    industries = {}
    for i, ind in enumerate(panel.industry):
        industries.setdefault(ind, []).append(i)

    out = np.full(panel.n, np.nan)
    for idx_list in industries.values():
        idx = np.array(idx_list)
        w = weight[idx]
        r = rs[idx]
        ok = np.isfinite(w) & np.isfinite(r)
        if ok.sum() < 2:
            continue
        w_v = w[ok]
        r_v = r[ok]
        w_total = w_v.sum()
        rs_ind = (w_v * r_v).sum() / w_total
        # Peer momentum: industry aggregate minus own contribution.
        out[idx[ok]] = rs_ind - r_v * (w_v / w_total)
    return out


def _log_excess(panel: MarketPanel) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        stock = np.log1p(panel.returns)
        bench = np.log1p(panel.benchmark)
    return stock - bench[np.newaxis, :]


def rstr(panel: MarketPanel) -> np.ndarray:
    excess = _log_excess(panel)
    series = _ewma_sum_at_sliding(excess, 252, 126, _last_targets(panel.t, 11))
    return np.nanmean(series, axis=1)


def ltrstr(panel: MarketPanel) -> np.ndarray:
    excess = _log_excess(panel)
    t = panel.t
    end = t - 1 - 273
    if end - 10 < 0:
        return np.full(panel.n, np.nan)
    targets = np.arange(end - 10, end + 1, dtype=np.int64)
    series = _ewma_sum_at_sliding(excess, 1040, 260, targets)
    return -np.nanmean(series, axis=1)


def lthalpha(panel: MarketPanel) -> np.ndarray:
    t = panel.t
    end = t - 1 - 273
    if end - 10 < 0:
        return np.full(panel.n, np.nan)
    targets = np.arange(end - 10, end + 1, dtype=np.int64)
    first_valid = np.argmax(np.isfinite(panel.returns), axis=1)
    alphas = _wls_at_targets_sliding(
        panel.returns, panel.benchmark, 1040, 260, targets, first_valid,
    )[:, :, 1]
    return -np.nanmean(alphas, axis=1)


PRICE_DESCRIPTORS = {
    "LNCAP": lncap,
    "MIDCAP": midcap,
    "HBETA": hbeta,
    "HSIGMA": hsigma,
    "HALPHA": halpha,
    "DASTD": dastd,
    "CMRA": cmra,
    "STOM": stom,
    "STOQ": stoq,
    "STOA": stoa,
    "ATVR": atvr,
    "STREV": strev,
    "SEASON": season,
    "INDMOM": indmom,
    "RSTR": rstr,
    "LTRSTR": ltrstr,
    "LTHALPHA": lthalpha,
}
