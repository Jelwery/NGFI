"""Version 3 return attribution: independent ledger identities, no residual plug."""
from __future__ import annotations

import math

from .contracts import instrument_from_contract


def carino_link(rows: list[dict]) -> dict:
    if not rows or any(row.get("status") != "available" for row in rows):
        return {"status": "blocked", "reason": "complete reconciled daily attribution is required"}
    names = set(rows[0]["components"])
    if any(set(row["components"]) != names for row in rows):
        raise ValueError("linked contribution keys must agree")

    def coefficient(p, b):
        if not math.isfinite(p) or not math.isfinite(b) or p <= -1 or b <= -1:
            raise ValueError("Carino requires finite returns greater than -1")
        difference = p - b
        return math.log1p(difference / (1 + b)) / difference if difference else 1 / (1 + b)

    daily = [coefficient(row["portfolioReturn"], row["benchmarkReturn"]) for row in rows]
    portfolio = math.expm1(sum(math.log1p(row["portfolioReturn"]) for row in rows))
    benchmark = math.expm1(sum(math.log1p(row["benchmarkReturn"]) for row in rows))
    scale = coefficient(portfolio, benchmark)
    components = {name: sum(row["components"][name] * weight / scale for row, weight in zip(rows, daily)) for name in sorted(names)}
    error = portfolio - benchmark - sum(components.values())
    tolerance = sum(row.get("tolerance", 1e-10) * abs(weight / scale) for row, weight in zip(rows, daily)) + 1e-10
    return {"status": "available" if abs(error) <= tolerance else "unreconciled",
            "method": "carino-v1", "portfolioReturn": portfolio, "benchmarkReturn": benchmark,
            "activeReturn": portfolio - benchmark, "components": components, "reconciliationError": error, "tolerance": tolerance}


def brinson(weights: dict, benchmark_weights: dict, returns: dict, industries: dict, cash_weight: float) -> dict:
    """Brinson-Fachler, including a zero-return cash group; zero group weights use zero returns."""
    benchmark_return = sum(weight * returns[key] for key, weight in benchmark_weights.items())
    groups = []
    for group in sorted(set(industries.values())):
        members = [key for key in returns if industries[key] == group]
        wp = sum(weights.get(key, 0) for key in members)
        wb = sum(benchmark_weights.get(key, 0) for key in members)
        rp = sum(weights.get(key, 0) * returns[key] for key in members) / wp if wp else 0
        rb = sum(benchmark_weights.get(key, 0) * returns[key] for key in members) / wb if wb else 0
        groups.append({"group": group, "portfolioWeight": wp, "benchmarkWeight": wb,
                       "allocation": (wp - wb) * (rb - benchmark_return),
                       "selection": wb * (rp - rb), "interaction": (wp - wb) * (rp - rb)})
    groups.append({"group": "__cash__", "portfolioWeight": cash_weight, "benchmarkWeight": 0,
                   "allocation": -cash_weight * benchmark_return, "selection": 0.0, "interaction": 0.0})
    components = {name: sum(row[name] for row in groups) for name in ("allocation", "selection", "interaction")}
    active = sum(weight * returns[key] for key, weight in weights.items()) - benchmark_return
    return {"method": "brinson-fachler-v1", "groups": groups, "components": components,
            "staticActiveReturn": active, "reconciliationError": active - sum(components.values())}


def ledger_attribution(*, day, previous_day, previous_nav, nav, starting_cash, quantities, bars,
                       actions, benchmark, data, fills) -> dict:
    base = {"schemaVersion": "3", "date": day, "unit": "decimal-return",
            "method": "beginning-holdings-and-actual-fills-v1"}
    if previous_nav is None or nav is None or previous_nav <= 0:
        return {**base, "status": "missing", "reason": "missing account valuation"}
    if day not in benchmark or (previous_day is not None and previous_day not in benchmark):
        return {**base, "status": "missing", "reason": "missing adjacent actual benchmark"}
    rp = nav / previous_nav - 1
    rb = benchmark[day].value / benchmark[previous_day].value - 1 if previous_day else 0.0
    base.update(portfolioReturn=rp, benchmarkReturn=rb, activeReturn=rp - rb)
    parts = {key: 0.0 for key in ("country", "industry", "style", "specific", "cash", "fees", "tradingTiming", "benchmarkReplication")}
    stock_details, weights, stock_returns = [], {}, {}
    if previous_day is not None:
        if data is None or data.previous_date != previous_day:
            return {**base, "status": "missing", "reason": "missing registered return observations"}
        universe = set(quantities) | set(data.benchmark_weights)
        action_map = {action.instrument.key: action for action in actions}
        for key in sorted(universe):
            previous, current = bars.get((previous_day, key)), bars.get((day, key))
            if previous is None or current is None or previous.close is None or current.close is None or key not in data.exposures or key not in data.specific_returns:
                return {**base, "status": "missing", "reason": "missing beginning marks, exposures or specific returns"}
            action = action_map.get(key)
            split, dividend = (action.split_ratio, action.cash_dividend) if action else (1.0, 0.0)
            stock_return = (current.close * split + dividend) / previous.close - 1
            weights[key] = quantities.get(key, 0) * previous.close / previous_nav
            stock_returns[key] = stock_return
            active_weight = weights[key] - data.benchmark_weights.get(key, 0)
            explained = 0.0
            for factor, kind in data.factor_kinds.items():
                value = data.exposures[key][factor] * data.factor_returns[factor]
                explained += value
                parts[kind] += active_weight * value
            residual = stock_return - explained - data.specific_returns[key]
            stock_details.append({"instrument": key, "beginningWeight": weights[key], "activeWeight": active_weight,
                                  "stockReturn": stock_return, "specificReturn": data.specific_returns[key], "reconciliationError": residual})
            parts["specific"] += active_weight * data.specific_returns[key]
        replicated = sum(weight * stock_returns[key] for key, weight in data.benchmark_weights.items())
        parts["benchmarkReplication"] = replicated - rb
        # Center the specific component by benchmark return, then show cash drag separately.
        # This is an exact reclassification, not an additional charge on active stock weights.
        parts["cash"] = -starting_cash / previous_nav * rb
        parts["specific"] -= parts["cash"]
        base["brinson"] = brinson(weights, data.benchmark_weights, stock_returns, data.industries, starting_cash / previous_nav)
        base["sourceHash"], base["modelHash"] = data.source_hash, data.model_hash
    for fill in fills:
        key = instrument_from_contract(fill["instrument"]).key
        bar = bars.get((day, key))
        if bar is None or bar.close is None:
            return {**base, "status": "missing", "reason": "missing fill end mark"}
        signed = fill["quantity"] * (1 if fill["side"] == "buy" else -1)
        parts["tradingTiming"] += signed * (bar.close - fill["price"]) / previous_nav
        parts["fees"] -= fill["fees"]["total"] / previous_nav
    error = rp - rb - sum(parts.values())
    tolerance = 0.011 * (len(fills) + len(quantities) + len(actions) + 2) / previous_nav + 1e-10
    stock_error = max((abs(row["reconciliationError"]) for row in stock_details), default=0)
    brinson_error = abs(base.get("brinson", {}).get("reconciliationError", 0))
    return {**base, "status": "available" if abs(error) <= tolerance and stock_error <= 1e-8 and brinson_error <= tolerance else "unreconciled",
            "components": parts, "stocks": stock_details, "reconciliationError": error, "tolerance": tolerance,
            "maximumStockReconciliationError": stock_error,
            "cashConvention": "specific centered by actual benchmark; cash includes dividend receivables, earns zero interest",
            "slippageConvention": "included once in actual fill prices inside tradingTiming"}
