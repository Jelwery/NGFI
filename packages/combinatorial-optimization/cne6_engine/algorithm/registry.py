# cne6_engine/algorithm/registry.py
"""Factor registry: 46 descriptors → 20+ level-2 factors → 9 level-1 styles.

The hierarchy and descriptor parameters follow the CNE6 reference materials
(调研报告 + barra_cne6_factor_reference.py).  Level-2 partitioning is an
approximation of the unpublished official mapping; weights are configurable.

Availability: a descriptor activates only when its required contract fields
have enough coverage in the current DataBundle.  Absent fields yield nulls
(excluded from synthesis), never zeros.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DescriptorSpec:
    name: str
    level2: str
    level1: str
    required: tuple[str, ...]
    params: dict | None = None
    note: str = ""


def _d(name, level2, level1, required, params=None, note=""):
    return DescriptorSpec(name, level2, level1, tuple(required), params or {}, note)


DESCRIPTORS: dict[str, DescriptorSpec] = {
    # --- Size → Size ---
    "LNCAP": _d("LNCAP", "Size", "Size", ["float_market_cap"]),
    "MIDCAP": _d("MIDCAP", "NonLinearSize", "Size", ["float_market_cap"]),
    # --- Volatility ---
    "HBETA": _d("HBETA", "Beta", "Volatility",
                ["daily_return", "benchmark_return"],
                {"window": 504, "half_life": 252}),
    "HSIGMA": _d("HSIGMA", "ResidualVolatility", "Volatility",
                 ["daily_return", "benchmark_return"],
                 {"window": 504, "half_life": 252}),
    "DASTD": _d("DASTD", "Volatility", "Volatility", ["daily_return"],
                {"window": 252, "half_life": 42}),
    "CMRA": _d("CMRA", "Volatility", "Volatility", ["daily_return"],
               {"months": 12, "days_per_month": 21}),
    # --- Liquidity ---
    "STOM": _d("STOM", "Liquidity", "Liquidity", ["turnover_rate"],
               {"window": 21, "periods": 1}),
    "STOQ": _d("STOQ", "Liquidity", "Liquidity", ["turnover_rate"],
               {"window": 63, "periods": 3}),
    "STOA": _d("STOA", "Liquidity", "Liquidity", ["turnover_rate"],
               {"window": 252, "periods": 12}),
    "ATVR": _d("ATVR", "Liquidity", "Liquidity", ["turnover_rate"],
               {"window": 252, "half_life": 63}),
    # --- Momentum ---
    "STREV": _d("STREV", "ShortTermReversal", "Momentum", ["daily_return"],
                {"window": 21, "half_life": 5}),
    "SEASON": _d("SEASON", "Seasonality", "Momentum", ["close"],
                 {"years": 5, "shift": 231}),
    "INDMOM": _d("INDMOM", "IndustryMomentum", "Momentum",
                 ["daily_return", "float_market_cap", "industry"],
                 {"window": 126, "half_life": 21}),
    "RSTR": _d("RSTR", "Momentum", "Momentum",
               ["daily_return", "benchmark_return"],
               {"window": 252, "half_life": 126, "sma": 11}),
    "HALPHA": _d("HALPHA", "Momentum", "Momentum",
                 ["daily_return", "benchmark_return"],
                 {"window": 504, "half_life": 252}),
    # --- Quality → Leverage ---
    "MLEV": _d("MLEV", "Leverage", "Quality",
               ["non_current_liabilities", "preferred_equity",
                "total_market_cap"],
               note="ME 为 T−1 市值; LD=非流动负债合计"),
    "BLEV": _d("BLEV", "Leverage", "Quality",
               ["non_current_liabilities", "preferred_equity", "equity"],
               note="LD=非流动负债合计"),
    "DTOA": _d("DTOA", "Leverage", "Quality",
               ["total_liabilities", "total_assets"]),
    # --- Quality → Earnings Variability ---
    "VSAL": _d("VSAL", "EarningsVariability", "Quality", ["revenue"],
               {"years": 5}, "annual LYR history"),
    "VERN": _d("VERN", "EarningsVariability", "Quality", ["net_income"],
               {"years": 5}, "annual LYR history"),
    "VFLO": _d("VFLO", "EarningsVariability", "Quality", ["operating_cashflow"],
               {"years": 5}, "annual LYR history"),
    # --- Quality → Earnings Quality ---
    "ABS": _d("ABS", "EarningsQuality", "Quality",
              ["total_assets", "total_liabilities", "cash",
               "long_term_debt", "short_term_debt", "capex",
               "depreciation_amortization"],
              note="LYR proxies MRQ; IBD≈LTD+STD"),
    "ACF": _d("ACF", "EarningsQuality", "Quality",
              ["net_income", "operating_cashflow", "investment_cashflow",
               "depreciation_amortization", "total_assets"]),
    # --- Quality → Profitability ---
    "ATO": _d("ATO", "Profitability", "Quality", ["revenue", "total_assets"],
              note="LYR approximates TTM"),
    "GP": _d("GP", "Profitability", "Quality", ["revenue", "cogs", "total_assets"]),
    "GPM": _d("GPM", "Profitability", "Quality", ["revenue", "cogs"]),
    "ROA": _d("ROA", "Profitability", "Quality", ["net_income", "total_assets"],
              note="LYR approximates TTM"),
    # --- Quality → Investment Quality ---
    "AGRO": _d("AGRO", "InvestmentQuality", "Quality", ["total_assets"],
               {"years": 5}, "annual LYR history"),
    "IGRO": _d("IGRO", "InvestmentQuality", "Quality", ["total_shares"],
               {"years": 5}),
    "CXGRO": _d("CXGRO", "InvestmentQuality", "Quality", ["capex"],
                {"years": 5}),
    # --- Value ---
    "BTOP": _d("BTOP", "Value", "Value",
               ["parent_equity", "total_market_cap"],
               note="归母权益; LYR approximates MRQ"),
    "ETOP": _d("ETOP", "EarningsYield", "Value", ["net_income", "total_market_cap"],
               note="LYR approximates TTM"),
    "CETOP": _d("CETOP", "EarningsYield", "Value",
                ["operating_cashflow", "total_market_cap"],
                note="LYR approximates TTM"),
    "EM": _d("EM", "EarningsYield", "Value",
             ["ebit", "total_market_cap", "long_term_debt",
              "short_term_debt", "cash"],
             note="EBIT≈利润总额+财务费用; IBD≈LTD+STD"),
    "LTRSTR": _d("LTRSTR", "LongTermReversal", "Value",
                 ["daily_return", "benchmark_return"],
                 {"window": 1040, "half_life": 260, "skip": 273, "sma": 11}),
    "LTHALPHA": _d("LTHALPHA", "LongTermReversal", "Value",
                   ["daily_return", "benchmark_return"],
                   {"window": 1040, "half_life": 260, "skip": 273, "sma": 11}),
    # --- Growth ---
    "EGRO": _d("EGRO", "Growth", "Growth", ["eps"],
               {"years": 5}, "annual LYR history"),
    "SGRO": _d("SGRO", "Growth", "Growth", ["revenue", "total_shares"],
               {"years": 5}, "constant-share approximation"),
    # --- Sentiment (no public data source) ---
    "RRIBS": _d("RRIBS", "AnalystSentiment", "Sentiment",
                ["analyst_rating_change"]),
    "EPIBSC": _d("EPIBSC", "AnalystSentiment", "Sentiment",
                 ["analyst_eps_forecast_change"]),
    "EARNC": _d("EARNC", "AnalystSentiment", "Sentiment",
                ["analyst_earnings_revision"]),
    # --- DividendYield ---
    "DTOP": _d("DTOP", "DividendYield", "DividendYield",
               ["dividend_per_share", "close"]),
}

# Synthesized fields produced by the algorithm layer from contract fields.
_SYNTHETIC_FIELDS = {
    "benchmark_return": "benchmark",
    "industry": "industry",
    "close": "close",
    "daily_return": "daily_return",
    "turnover_rate": "turnover_rate",
    "float_market_cap": "float_market_cap",
    "total_market_cap": "total_market_cap",
}

# Fundamental contract fields (checked against PIT asof coverage).
_FUNDAMENTAL_FIELDS = {
    "revenue", "net_income", "eps", "equity", "operating_cashflow",
    "total_assets", "total_liabilities", "long_term_debt", "preferred_equity",
    "cogs", "capex", "depreciation_amortization", "ebit",
    "dividend_per_share", "total_shares",
    "cash", "short_term_debt", "investment_cashflow",
    "non_current_liabilities", "parent_equity",
}

# Analyst fields: contract-defined (ANALYST_SCHEMA) but no Layer-1 fetcher yet.
# Their descriptors stay excluded until a source delivers the fields.
_UNAVAILABLE_FIELDS = {
    "analyst_rating_change", "analyst_eps_forecast_change",
    "analyst_earnings_revision",
}


def level1_names() -> list[str]:
    """Distinct level-1 style groups in registry order."""
    seen: list[str] = []
    for spec in DESCRIPTORS.values():
        if spec.level1 not in seen:
            seen.append(spec.level1)
    return seen


def level2_names(level1: str | None = None) -> list[str]:
    seen: list[str] = []
    for spec in DESCRIPTORS.values():
        if level1 is not None and spec.level1 != level1:
            continue
        if spec.level2 not in seen:
            seen.append(spec.level2)
    return seen


def descriptors_in_level2(level2: str) -> list[str]:
    return [n for n, s in DESCRIPTORS.items() if s.level2 == level2]


def descriptor_fields() -> dict[str, tuple[str, ...]]:
    """Map contract field name → descriptors requiring it."""
    out: dict[str, list[str]] = {}
    for name, spec in DESCRIPTORS.items():
        for field in spec.required:
            out.setdefault(field, []).append(name)
    return {k: tuple(v) for k, v in out.items()}
