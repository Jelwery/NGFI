"""Audited, dry-run-only CNE6 active-risk optimization and board-lot planning.

All weights and L1/2 turnover use pre-trade marked NAV. Fees reduce NAV and are
reported separately; no post-fee renormalization silently changes the mandate.
Alpha is the supplied rank preference in [-1, 1], scale exactly one, not a return
forecast. The integer repair is deterministic and is NOT an integer optimum.
"""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
import math
from typing import Any

import cvxpy as cp
import numpy as np
import osqp

from .contracts import (AShareBar, AShareCostModel, instrument_from_contract,
                        instrument_from_key, require_finite, require_hash,
                        require_timestamp, strict_object)
from .execution import execution_block, fill_order, money
from .hashing import stable_hash

SCHEMA_VERSION = "1"
ENGINE_VERSION = "1.0.0"


def _object(value: Any, required: str, optional: str = "", label: str = "input") -> dict:
    return strict_object(value, set(required.split()), set(optional.split()), label)


def _number(value: Any, label: str, minimum: float | None = None, maximum: float | None = None) -> float:
    require_finite(value, label)
    if minimum is not None and value < minimum or maximum is not None and value > maximum:
        raise ValueError(f"{label} outside [{minimum}, {maximum}]")
    return float(value)


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def _strings(value: Any, label: str, nonempty: bool = False) -> list[str]:
    if not isinstance(value, list) or (nonempty and not value):
        raise ValueError(f"{label} must be a string list")
    result = [_text(item, label) for item in value]
    if len(set(result)) != len(result):
        raise ValueError(f"{label} must be unique")
    return result


def _boolean(value: Any, label: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"{label} must be boolean")
    return value


def _time(value: Any, label: str) -> datetime:
    require_timestamp(value, label)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _pit(value: Any, as_of: datetime, max_age: float, label: str) -> None:
    stamp = _time(value, label)
    age = (as_of - stamp).total_seconds() / 86400
    if age < 0 or age > max_age:
        raise ValueError(f"{label} is future-available or stale")


def _matrix(value: Any, size: int, label: str, tolerance: float) -> np.ndarray:
    if not isinstance(value, list) or len(value) != size or any(not isinstance(row, list) or len(row) != size for row in value):
        raise ValueError(f"{label} shape must be {size}x{size}")
    for row in value:
        for item in row:
            _number(item, label)
    matrix = np.array(value, dtype=float)
    if np.max(np.abs(matrix - matrix.T)) > tolerance:
        raise ValueError(f"{label} is not symmetric")
    if np.linalg.eigvalsh(matrix).min() < -1e-12:
        raise ValueError(f"{label} is not positive semidefinite")
    return matrix


def _cost(value: Any) -> AShareCostModel:
    row = _object(value, "id version commissionRate minimumCommission stampDutyRate transferFeeRate slippageRate", label="costModel")
    _text(row["id"], "costModel.id")
    _text(row["version"], "costModel.version")
    return AShareCostModel(row["id"], row["version"], row["commissionRate"], row["minimumCommission"],
                          row["stampDutyRate"], row["transferFeeRate"], row["slippageRate"])


def _prepare(value: Any) -> dict:
    data = _object(value, "schemaVersion asOf inputHash assets cash cashAvailableAt holdingsAvailableAt riskSnapshot benchmark mandate costModel", "dryRun")
    if data["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("unsupported schemaVersion")
    if data.get("dryRun", True) is not True:
        raise ValueError("dryRun must be true; execution is not supported")
    require_hash(data["inputHash"], "inputHash")
    if stable_hash({key: item for key, item in data.items() if key != "inputHash"}) != data["inputHash"]:
        raise ValueError("inputHash does not match canonical input content")
    as_of = _time(data["asOf"], "asOf")
    mandate = _object(data["mandate"], "schemaVersion id version minWeight maxWeight weightBounds cashMin cashMax riskAversion turnoverPenalty turnoverLimit maxParticipation industryBands styleBands qualityPolicy tolerance", "costAversion", label="mandate")
    if mandate["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("unsupported mandate.schemaVersion")
    _text(mandate["id"], "mandate.id")
    _text(mandate["version"], "mandate.version")
    for name in ("minWeight", "maxWeight", "cashMin", "cashMax", "turnoverLimit", "maxParticipation"):
        _number(mandate[name], f"mandate.{name}", 0, 1)
    if mandate["minWeight"] > mandate["maxWeight"] or mandate["cashMin"] > mandate["cashMax"]:
        raise ValueError("mandate lower bound exceeds upper bound")
    _number(mandate["riskAversion"], "riskAversion", 0)
    _number(mandate["turnoverPenalty"], "turnoverPenalty", 0)
    # The continuous transaction-cost surrogate is a convex approximation whose
    # scale is a calibrated preference weight, not a claim that a rank point pays
    # a fixed number of basis points. It defaults to 0 (no objective change).
    cost_aversion = _number(mandate.get("costAversion", 0), "costAversion", 0)
    tolerance = _number(mandate["tolerance"], "tolerance", 1e-10, 1e-4)
    policy = _object(mandate["qualityPolicy"], "maxAgeDays minCoverage maxConditionNumber maxAsymmetry maxReconciliationError allowedProxyFlags allowWarnings", "maxAgeDaysByDomain", label="qualityPolicy")
    age = _number(policy["maxAgeDays"], "maxAgeDays", 0, 366)
    # Domain-specific freshness: prices/trading status are timed to the trade
    # session, risk to the model publication date, research to the score validity,
    # holdings/cash to the account snapshot, benchmark to its own publication. A
    # single window must not force an annual report and a daily bar to share one
    # threshold. Unspecified domains fall back to the global maxAgeDays.
    DOMAINS = ("price", "tradingStatus", "risk", "research", "holdings", "benchmark")
    domain_ages = {domain: age for domain in DOMAINS}
    if "maxAgeDaysByDomain" in policy:
        by_domain = _object(policy["maxAgeDaysByDomain"], "", " ".join(DOMAINS), "maxAgeDaysByDomain")
        for domain, value in by_domain.items():
            domain_ages[domain] = _number(value, f"maxAgeDaysByDomain.{domain}", 0, 366)
    _number(policy["minCoverage"], "minCoverage", 0, 1)
    _number(policy["maxConditionNumber"], "maxConditionNumber", 1)
    _number(policy["maxAsymmetry"], "maxAsymmetry", 0, 1e-6)
    _number(policy["maxReconciliationError"], "maxReconciliationError", 0, 1e-6)
    _strings(policy["allowedProxyFlags"], "allowedProxyFlags")
    _boolean(policy["allowWarnings"], "allowWarnings")
    cash = _number(data["cash"], "cash", 0)
    if money(cash) != cash:
        raise ValueError("cash must have cent precision")
    _pit(data["cashAvailableAt"], as_of, domain_ages["holdings"], "cashAvailableAt")
    _pit(data["holdingsAvailableAt"], as_of, domain_ages["holdings"], "holdingsAvailableAt")
    rows = data["assets"]
    if not isinstance(rows, list) or not rows:
        raise ValueError("assets must be a nonempty list")
    assets = []
    for row in rows:
        row = _object(row, "instrument price priceAvailableAt quantity sellableQuantity industry advNotional advAvailableAt canBuy canSell statusAvailableAt previousClose limitRate", "score scoreAvailableAt evidenceRefs scoreReason", label="asset")
        instrument = instrument_from_contract(row["instrument"])
        if instrument.asset_type != "equity":
            raise ValueError("assets must be A-share equities")
        # Research eligibility is separate from holding and tradability. A scored
        # asset joins the ranking cross-section; an unscored asset carries an
        # explicit reason, keeps alpha 0 and never changes other assets' ranks. A
        # missing score is not an instruction to sell or to abandon a held/benchmark
        # name; the account and benchmark still constrain the solution.
        scored = "score" in row
        if scored:
            if "scoreReason" in row:
                raise ValueError("asset must not carry both score and scoreReason")
            if "scoreAvailableAt" not in row or "evidenceRefs" not in row:
                raise ValueError("scored asset requires scoreAvailableAt and evidenceRefs")
            _number(row["score"], "score")
            _strings(row["evidenceRefs"], "evidenceRefs", True)
            _pit(row["scoreAvailableAt"], as_of, domain_ages["research"], "scoreAvailableAt")
        else:
            if "scoreAvailableAt" in row or "evidenceRefs" in row:
                raise ValueError("unscored asset must omit scoreAvailableAt and evidenceRefs")
            if "scoreReason" not in row:
                raise ValueError("unscored asset requires a scoreReason")
            _text(row["scoreReason"], "scoreReason")
        for label, domain in (("priceAvailableAt", "price"),
                              ("advAvailableAt", "price"), ("statusAvailableAt", "tradingStatus")):
            _pit(row[label], as_of, domain_ages[domain], label)
        for label in ("price", "previousClose", "advNotional"):
            if _number(row[label], label, 0) == 0:
                raise ValueError(f"{label} must be positive")
        if money(row["price"]) != row["price"]:
            raise ValueError("price must be a raw cent-precision price")
        _number(row["limitRate"], "limitRate", 0.000001, 0.999)
        for label in ("quantity", "sellableQuantity"):
            if type(row[label]) is not int or row[label] < 0:
                raise ValueError(f"{label} must be a nonnegative integer")
        if row["sellableQuantity"] > row["quantity"]:
            raise ValueError("sellableQuantity exceeds quantity")
        _text(row["industry"], "industry")
        _boolean(row["canBuy"], "canBuy")
        _boolean(row["canSell"], "canSell")
        assets.append({**row, "key": instrument.key})
    assets.sort(key=lambda item: item["key"])
    keys = [row["key"] for row in assets]
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate asset instrument")
    n = len(assets)
    scored_indices = [i for i, row in enumerate(assets) if "score" in row]
    if len(scored_indices) < 2:
        raise ValueError("insufficient cross-section: at least two scored assets are required")
    # Ranks are computed only within the declared scoring pool; unscored held or
    # benchmark names keep alpha 0 and do not shift the ranks of scored assets.
    scores = np.array([assets[i]["score"] for i in scored_indices], dtype=float)
    m = len(scored_indices)
    pool_ranks = np.empty(m, dtype=float)
    order = np.argsort(scores, kind="stable")
    start = 0
    while start < m:
        end = start + 1
        while end < m and scores[order[end]] == scores[order[start]]:
            end += 1
        pool_ranks[order[start:end]] = (start + 1 + end) / 2
        start = end
    pool_alpha = 2 * (pool_ranks - 1) / (m - 1) - 1
    alpha = np.zeros(n, dtype=float)
    for slot, i in enumerate(scored_indices):
        alpha[i] = pool_alpha[slot]
    snapshot = _object(data["riskSnapshot"], "schemaVersion model modelVersion asOf availableAt currency covariancePeriod factors securities factorCovariance quality sourceQuality", "stockCovariance coverage inputHash descriptorQuality dataQuality", "riskSnapshot")
    if snapshot["schemaVersion"] != "1" or snapshot["model"] != "CNE6" or snapshot["currency"] != "CNY" or snapshot["covariancePeriod"] != "daily":
        raise ValueError("riskSnapshot must be schema 1, daily CNE6 CNY")
    _text(snapshot["modelVersion"], "modelVersion")
    _pit(snapshot["availableAt"], as_of, domain_ages["risk"], "riskSnapshot.availableAt")
    # The existing CNE6 producer has a date-valued asOf; availability is separate.
    model_time = snapshot["asOf"]
    if isinstance(model_time, str) and len(model_time) == 10:
        model_time += "T00:00:00+08:00"
    _pit(model_time, as_of, domain_ages["risk"], "riskSnapshot.asOf")
    if "inputHash" in snapshot:
        require_hash(snapshot["inputHash"], "riskSnapshot.inputHash")
    quality = _object(snapshot["quality"], "status symmetric positiveSemidefinite maxAsymmetry minEigenvalue maxEigenvalue conditionNumber stockReconciliationMaxError issues", label="riskSnapshot.quality")
    source = _object(snapshot["sourceQuality"], "status proxyFlags", "provenanceHash quality_flag coverage provider provider_verified point_in_time source_version config_version reasons field_records", "sourceQuality")
    for component in (quality, source):
        if component["status"] not in ("ok", "warning", "invalid"):
            raise ValueError("invalid quality status")
        if component["status"] == "invalid" or component["status"] == "warning" and not policy["allowWarnings"]:
            raise ValueError("quality policy rejects snapshot/source status")
    flags = _strings(source["proxyFlags"], "sourceQuality.proxyFlags")
    if set(flags) - set(policy["allowedProxyFlags"]):
        raise ValueError("quality policy rejects proxy flags")
    if "provenanceHash" in source:
        require_hash(source["provenanceHash"], "provenanceHash")
    _strings(quality["issues"], "quality.issues")
    if quality["symmetric"] is not True or quality["positiveSemidefinite"] is not True:
        raise ValueError("covariance quality must be symmetric and positive semidefinite")
    for label in ("maxAsymmetry", "minEigenvalue", "maxEigenvalue", "stockReconciliationMaxError"):
        _number(quality[label], f"quality.{label}")
    if quality["maxAsymmetry"] < 0 or quality["stockReconciliationMaxError"] < 0 or quality["minEigenvalue"] < -1e-12:
        raise ValueError("invalid numerical quality")
    if quality["maxAsymmetry"] > policy["maxAsymmetry"] or quality["stockReconciliationMaxError"] > policy["maxReconciliationError"]:
        raise ValueError("numerical quality threshold exceeded")
    _number(quality["conditionNumber"], "quality.conditionNumber", 1, policy["maxConditionNumber"])
    factors = snapshot["factors"]
    if not isinstance(factors, list) or not factors:
        raise ValueError("factors must be a nonempty list")
    for factor in factors:
        _object(factor, "name kind", label="factor")
        _text(factor["name"], "factor.name")
        if factor["kind"] not in ("industry", "style", "country"):
            raise ValueError("unsupported factor kind")
    names = [row["name"] for row in factors]
    if len(set(names)) != len(names):
        raise ValueError("duplicate factor name")
    factor_cov = _matrix(snapshot["factorCovariance"], len(factors), "factorCovariance", policy["maxAsymmetry"])
    eig = np.linalg.eigvalsh(factor_cov)
    if eig.min() <= 0 or eig.max() / eig.min() > policy["maxConditionNumber"]:
        raise ValueError("factor covariance singular/ill-conditioned under quality policy")
    securities = snapshot["securities"]
    if not isinstance(securities, list) or not securities:
        raise ValueError("securities must be a nonempty list")
    security_keys, exposures, specific = [], [], []
    for security in securities:
        _object(security, "instrument exposures specificRisk", "modelCode", "security")
        security_key = instrument_from_contract(security["instrument"]).key
        security_keys.append(security_key)
        if "modelCode" in security:
            expected_code = {"SSE": "sh", "SZSE": "sz", "BSE": "bj"}[security["instrument"]["exchange"]] + "." + security["instrument"]["symbol"]
            if security["modelCode"] != expected_code:
                raise ValueError("modelCode does not match canonical instrument")
        if not isinstance(security["exposures"], list) or len(security["exposures"]) != len(factors):
            raise ValueError("security exposures must align with factors")
        exposures.append([_number(item, "exposure") for item in security["exposures"]])
        risk = _number(security["specificRisk"], "specificRisk", 0)
        if risk == 0:
            raise ValueError("specificRisk must be positive daily standard deviation")
        specific.append(risk)
    if len(set(security_keys)) != len(security_keys):
        raise ValueError("duplicate risk security")
    if "coverage" in snapshot:
        coverage_row = _object(snapshot["coverage"], "universeCount exposureCount specificRiskCount", "numerator denominator coverage exclusions", "coverage")
        counts = [coverage_row[key] for key in ("universeCount", "exposureCount", "specificRiskCount")]
        if any(type(count) is not int for count in counts) or counts[0] < len(securities) or counts[1:] != [len(securities), len(securities)]:
            raise ValueError("snapshot coverage counts do not match validated rows")
        actual_coverage = len(securities) / counts[0]
        if "coverage" in coverage_row and abs(coverage_row["coverage"] - actual_coverage) > 1e-12:
            raise ValueError("snapshot coverage ratio disagrees with original universe")
        if actual_coverage < policy["minCoverage"]:
            raise ValueError("original universe risk coverage below quality threshold")
    full_x, full_s = np.array(exposures), np.array(specific)
    if "stockCovariance" in snapshot:
        dense = _matrix(snapshot["stockCovariance"], len(securities), "stockCovariance", policy["maxAsymmetry"])
        rebuilt = full_x @ factor_cov @ full_x.T + np.diag(full_s ** 2)
        if np.max(np.abs(dense - rebuilt)) > policy["maxReconciliationError"]:
            raise ValueError("stockCovariance does not reconcile to factor form")
    missing = sorted(set(keys) - set(security_keys))
    coverage = (n - len(missing)) / n
    if coverage < policy["minCoverage"]:
        raise ValueError(f"risk coverage below quality threshold; missing {missing}")
    if missing:
        # No proxying or dropping held/buyable securities: every decision variable needs risk.
        raise ValueError(f"missing risk for assets (held risk cannot be omitted): {missing}")
    indices = [security_keys.index(key) for key in keys]
    x, s = full_x[indices], full_s[indices]
    benchmark = _object(data["benchmark"], "instrument weights availableAt", label="benchmark")
    benchmark_instrument = instrument_from_contract(benchmark["instrument"])
    if benchmark_instrument.key not in ("CN:SSE:000300:index", "CN:SSE:000906:index"):
        raise ValueError("benchmark must be CSI300 or CSI800")
    _pit(benchmark["availableAt"], as_of, domain_ages["benchmark"], "benchmark.availableAt")
    weights = benchmark["weights"]
    if not isinstance(weights, dict) or set(weights) - set(keys):
        raise ValueError("benchmark weights must use asset canonical keys")
    for key, weight in weights.items():
        instrument_from_key(key)
        _number(weight, "benchmark weight", 0, 1)
    if abs(sum(weights.values()) - 1) > 1e-8:
        raise ValueError("benchmark weights must sum to one")
    b = np.array([weights.get(key, 0) for key in keys])
    lower, upper = np.full(n, mandate["minWeight"], dtype=float), np.full(n, mandate["maxWeight"], dtype=float)
    bounds = mandate["weightBounds"]
    if not isinstance(bounds, dict) or set(bounds) - set(keys):
        raise ValueError("weightBounds must use asset canonical keys")
    for key, bounds_row in bounds.items():
        _object(bounds_row, "min max", label="weightBounds entry")
        lo = _number(bounds_row["min"], "weightBounds.min", 0, 1)
        hi = _number(bounds_row["max"], "weightBounds.max", 0, 1)
        if lo > hi:
            raise ValueError("weightBounds min exceeds max")
        i = keys.index(key)
        lower[i], upper[i] = max(lower[i], lo), min(upper[i], hi)
    bands = []
    for label, kind in (("industryBands", "industry"), ("styleBands", "style")):
        rows = mandate[label]
        if not isinstance(rows, dict):
            raise ValueError(f"{label} must be an object")
        for name, band in sorted(rows.items()):
            _object(band, "min max", label=label)
            lo, hi = _number(band["min"], label), _number(band["max"], label)
            if lo > hi:
                raise ValueError(f"{label} min exceeds max")
            if kind == "industry":
                vector = np.array([float(asset["industry"] == name) for asset in assets])
                if not np.any(vector):
                    raise ValueError(f"unknown industry band {name}")
            else:
                if name not in names or factors[names.index(name)]["kind"] != "style":
                    raise ValueError(f"unknown style band {name}")
                vector = x[:, names.index(name)]
            bands.append((f"{label}.{name}", vector, lo, hi))
    prices = np.array([row["price"] for row in assets])
    quantities = np.array([row["quantity"] for row in assets], dtype=np.int64)
    nav = cash + float(prices @ quantities)
    if nav <= 0:
        raise ValueError("pretrade NAV must be positive")
    cost = _cost(data["costModel"])
    # Convex per-unit surrogate rates for a fraction-of-NAV weight change, split
    # by side because stamp duty applies to sells only. The fixed minimum
    # commission and board-lot/integer effects are deliberately excluded here
    # (non-convex); the execution kernel settles them exactly and the reported
    # approximation gap makes the difference explicit.
    buy_rate = cost.commission_rate + cost.transfer_fee_rate + cost.slippage_rate
    sell_rate = cost.commission_rate + cost.transfer_fee_rate + cost.stamp_duty_rate + cost.slippage_rate
    trade_bars = [AShareBar(as_of.astimezone(timezone.utc).date().isoformat(), instrument_from_contract(row["instrument"]), data["asOf"],
                            row["price"], None, None, row["price"], row["previousClose"], False, row["limitRate"],
                            row["statusAvailableAt"], row["canBuy"], row["canSell"]) for row in assets]
    can_buy, can_sell = [], []
    for bar in trade_bars:
        buy, buy_block = fill_order(bar, 100, "buy", cost, decision_at=data["asOf"], require_status=True)
        sell, sell_block = fill_order(bar, 100, "sell", cost, decision_at=data["asOf"], require_status=True)
        can_buy.append(buy_block is None)
        can_sell.append(sell_block is None)
    return dict(data=data, mandate=mandate, assets=assets, keys=keys, alpha=alpha, x=x, s=s, f=factor_cov,
                factors=factors, b=b, lower=lower, upper=upper, bands=bands, prices=prices,
                quantities=quantities, current=prices * quantities / nav, nav=nav, cash=cash,
                cost=cost, bars=trade_bars, can_buy=can_buy, can_sell=can_sell, domain_ages=domain_ages,
                scored_indices=scored_indices, cost_aversion=cost_aversion,
                buy_rate=buy_rate, sell_rate=sell_rate,
                tolerance=tolerance, coverage={"assetCount": n, "coveredCount": n, "ratio": coverage, "missingKeys": []})


def _risk(context: dict, w: np.ndarray) -> dict:
    active = w - context["b"]
    exposure = context["x"].T @ active
    marginal = context["f"] @ exposure
    factor = float(exposure @ marginal)
    specific = float(np.sum((context["s"] * active) ** 2))
    contributions = {row["name"]: float(exposure[i] * marginal[i]) for i, row in enumerate(context["factors"])}
    return {"period": "daily", "factorVariance": factor, "specificVariance": specific,
            "activeVariance": factor + specific, "trackingError": math.sqrt(max(0, factor + specific)),
            "factorContributions": contributions,
            "factorKindContributions": {kind: sum(contributions[row["name"]] for row in context["factors"] if row["kind"] == kind)
                                        for kind in ("country", "industry", "style")}}


def _cost_surrogate(context: dict, w: np.ndarray) -> float:
    # Convex piecewise-linear proportional cost on the weight change: buys and
    # sells carry different rates. Excludes the fixed minimum commission and
    # board-lot rounding, which the execution kernel settles exactly.
    delta = w - context["current"]
    buys = np.clip(delta, 0, None)
    sells = np.clip(-delta, 0, None)
    return float(context["buy_rate"] * buys.sum() + context["sell_rate"] * sells.sum())


def _objective(context: dict, w: np.ndarray) -> float:
    mandate = context["mandate"]
    alpha = context["alpha"]
    return float(mandate["riskAversion"] * _risk(context, w)["activeVariance"] - alpha @ w
                 + mandate["turnoverPenalty"] * np.abs(w - context["current"]).sum() / 2
                 + context["cost_aversion"] * _cost_surrogate(context, w))


def _ledger(context: dict, q: np.ndarray) -> tuple[float, list[dict], list[str]]:
    cash, trades, errors = context["cash"], [], []
    for side in ("sell", "buy"):
        for i, key in enumerate(context["keys"]):
            delta = int(q[i] - context["quantities"][i])
            if delta == 0 or (delta > 0) != (side == "buy"):
                continue
            fill, reason = fill_order(context["bars"][i], abs(delta), side, context["cost"],
                                      decision_at=context["data"]["asOf"], require_status=True)
            if reason:
                errors.append(f"{key}:{reason}")
                continue
            assert fill is not None
            cash = money(cash + fill.cash_delta)
            if cash < 0:
                errors.append(f"{key}:insufficient-cash")
            trade = asdict(fill)
            trade["cashDelta"] = trade.pop("cash_delta")
            trades.append({"instrument": context["assets"][i]["instrument"], "key": key, **trade})
    return cash, trades, errors


def _diagnostics(context: dict, q: np.ndarray) -> tuple[list[dict], float, list[dict]]:
    cash, trades, errors = _ledger(context, q)
    w = q * context["prices"] / context["nav"]
    diagnostics = []
    tol = context["tolerance"]
    def bound(name: str, value: float, lo: float, hi: float, exact: bool = False) -> None:
        violation = max(0.0, lo - value, value - hi)
        diagnostics.append({"constraint": name, "value": float(value), "min": float(lo), "max": float(hi),
                            "violation": float(violation), "satisfied": bool(violation <= (0 if exact else tol))})
    for i, key in enumerate(context["keys"]):
        asset = context["assets"][i]
        delta = int(q[i] - asset["quantity"])
        bound(f"weight:{key}", w[i], context["lower"][i], context["upper"][i])
        bound(f"quantity:{key}", q[i], 0, 2**53 - 1, True)
        bound(f"sellable:{key}", max(0, -delta), 0, asset["sellableQuantity"], True)
        bound(f"participation:{key}", abs(delta) * asset["price"] / asset["advNotional"], 0, context["mandate"]["maxParticipation"])
        bound(f"boardLot:{key}", abs(delta) % 100, 0, 0, True)
        if not context["can_buy"][i]:
            bound(f"noBuy:{key}", delta, -2**53, 0, True)
        if not context["can_sell"][i]:
            bound(f"noSell:{key}", delta, 0, 2**53, True)
    bound("cash", cash / context["nav"], context["mandate"]["cashMin"], context["mandate"]["cashMax"])
    bound("nonnegativeCash", cash, 0, context["nav"], True)
    bound("turnoverL1Half", np.abs(w - context["current"]).sum() / 2, 0, context["mandate"]["turnoverLimit"])
    for name, vector, lo, hi in context["bands"]:
        bound(name, vector @ (w - context["b"]), lo, hi)
    for error in errors:
        diagnostics.append({"constraint": error, "violation": 1.0, "satisfied": False})
    return diagnostics, cash, trades


def _repair(context: dict, continuous: np.ndarray) -> tuple[np.ndarray, list[dict], float, list[dict]]:
    current = context["quantities"]
    desired_delta = continuous * context["nav"] / context["prices"] - current
    # Round trade increments, not total quantities: frozen odd-share holdings stay exact.
    q = current + np.trunc(desired_delta / 100).astype(np.int64) * 100
    for i, row in enumerate(context["assets"]):
        if not context["can_buy"][i]:
            q[i] = min(q[i], current[i])
        if not context["can_sell"][i]:
            q[i] = max(q[i], current[i])
        q[i] = max(q[i], current[i] - row["sellableQuantity"] // 100 * 100)
        max_trade = math.floor(row["advNotional"] * context["mandate"]["maxParticipation"] / row["price"] / 100) * 100
        q[i] = np.clip(q[i], max(0, current[i] - max_trade), current[i] + max_trade)
    def evaluate(candidate: np.ndarray):
        diagnostics, cash, trades = _diagnostics(context, candidate)
        failures = [row for row in diagnostics if not row["satisfied"]]
        # Monetary/integer violations must not dominate dimensionless constraints.
        score = sum(min(1.0, row["violation"]) ** 2 for row in failures)
        return (len(failures) > 0, score, _objective(context, candidate * context["prices"] / context["nav"])), diagnostics, cash, trades
    rank, diagnostics, cash, trades = evaluate(q)
    # Bounded coordinate repair; failure is explicit, never a mandate relaxation.
    visited = {tuple(q)}
    for _ in range(min(2000, len(q) * 200 + 20)):
        if not rank[0]:
            break
        best = None
        for i in range(len(q)):
            for step in (-100, 100):
                candidate = q.copy()
                candidate[i] += step
                if tuple(candidate) in visited or candidate[i] < 0:
                    continue
                delta = candidate[i] - current[i]
                asset = context["assets"][i]
                if delta > 0 and not context["can_buy"][i] or delta < 0 and not context["can_sell"][i]:
                    continue
                if -delta > asset["sellableQuantity"] or abs(delta) * asset["price"] > asset["advNotional"] * context["mandate"]["maxParticipation"] + 1e-8:
                    continue
                result = evaluate(candidate)
                candidate_rank = (*result[0], i, step)
                if result[0][:2] < rank[:2] and (best is None or candidate_rank < best[0]):
                    best = (candidate_rank, candidate, result)
        if best is None:
            break
        _, q, (rank, diagnostics, cash, trades) = best
        visited.add(tuple(q))
    return q, diagnostics, cash, trades


def optimize_portfolio(input: dict) -> dict:
    """Validate, solve the continuous QP, repair board lots and recheck every hard constraint."""
    result = {"schemaVersion": SCHEMA_VERSION, "status": "rejected", "dryRun": True,
              "operation": "portfolio-optimize", "engineVersion": ENGINE_VERSION,
              "relaxations": [], "rejectionReasons": [], "coverage": None, "freshnessPolicy": None,
              "solver": {"name": "OSQP", "cvxpyVersion": cp.__version__, "version": osqp.__version__,
                         "status": "not-run", "continuousOnly": True, "integerOptimal": False,
                         "duals": None}, "continuous": None, "repaired": None,
              "constraintDiagnostics": [], "risk": None, "hashes": {}}
    try:
        context = _prepare(input)
        result["coverage"] = context["coverage"]
        result["freshnessPolicy"] = {"maxAgeDays": context["mandate"]["qualityPolicy"]["maxAgeDays"],
                                     "maxAgeDaysByDomain": context["domain_ages"]}
        result["hashes"] = {"input": input["inputHash"], "riskSnapshot": stable_hash(input["riskSnapshot"]),
                            "mandate": stable_hash(input["mandate"]), "costModel": context["cost"].hash,
                            "codeVersion": stable_hash({"engine": ENGINE_VERSION, "cvxpy": cp.__version__, "osqp": osqp.__version__})}
        n = len(context["keys"])
        w = cp.Variable(n)
        constraints, constraint_names = [], []
        def add(name, constraint):
            constraint_names.append(name)
            constraints.append(constraint)
        add("minWeight", w >= context["lower"])
        add("maxWeight", w <= context["upper"])
        add("cashMin", 1 - cp.sum(w) >= context["mandate"]["cashMin"])
        add("cashMax", 1 - cp.sum(w) <= context["mandate"]["cashMax"])
        delta = w - context["current"]
        turnover = cp.norm1(delta) / 2
        add("turnoverL1Half", turnover <= context["mandate"]["turnoverLimit"])
        for i, row in enumerate(context["assets"]):
            key = context["keys"][i]
            if not context["can_buy"][i]:
                add(f"noBuy:{key}", w[i] <= context["current"][i])
            if not context["can_sell"][i]:
                add(f"noSell:{key}", w[i] >= context["current"][i])
            add(f"sellable:{key}", delta[i] >= -row["sellableQuantity"] * row["price"] / context["nav"])
            participation = row["advNotional"] * context["mandate"]["maxParticipation"] / context["nav"]
            add(f"participationMax:{key}", delta[i] <= participation)
            add(f"participationMin:{key}", delta[i] >= -participation)
        for name, vector, lo, hi in context["bands"]:
            exposure = vector @ (w - context["b"])
            add(f"{name}:min", exposure >= lo)
            add(f"{name}:max", exposure <= hi)
        active = w - context["b"]
        # Factor form avoids constructing an N x N covariance in the solver.
        risk = cp.quad_form(context["x"].T @ active, cp.psd_wrap(context["f"])) + cp.sum_squares(cp.multiply(context["s"], active))
        alpha = context["alpha"]
        # Convex continuous cost surrogate: pos(delta) is buys, pos(-delta) sells.
        cost_surrogate = context["buy_rate"] * cp.sum(cp.pos(delta)) + context["sell_rate"] * cp.sum(cp.pos(-delta))
        objective = (context["mandate"]["riskAversion"] * risk - alpha @ w
                     + context["mandate"]["turnoverPenalty"] * turnover
                     + context["cost_aversion"] * cost_surrogate)
        problem = cp.Problem(cp.Minimize(objective), constraints)
        try:
            problem.solve(solver=cp.OSQP, eps_abs=min(1e-8, context["tolerance"] / 10), eps_rel=min(1e-8, context["tolerance"] / 10),
                          max_iter=100000, polishing=True, adaptive_rho=False, warm_start=False, verbose=False)
        except cp.error.SolverError as exc:
            result["solver"]["status"] = "error"
            raise ValueError(f"solver failed: {exc}") from exc
        result["solver"]["status"] = problem.status
        result["solver"]["iterations"] = problem.solver_stats.num_iters
        info = getattr(problem.solver_stats.extra_stats, "info", None)
        result["solver"]["primalResidual"] = float(info.prim_res) if info is not None and np.isfinite(info.prim_res) else None
        result["solver"]["dualResidual"] = float(info.dual_res) if info is not None and np.isfinite(info.dual_res) else None
        if problem.status != cp.OPTIMAL or w.value is None or not np.isfinite(w.value).all():
            raise ValueError(f"continuous solver did not return optimal: {problem.status}")
        # Do not expose duals/solutions before validating solver primal feasibility.
        if any(np.max(np.abs(constraint.violation())) > context["tolerance"] for constraint in constraints):
            raise ValueError("continuous solver primal residual exceeds tolerance")
        continuous = np.asarray(w.value).reshape(-1)
        result["solver"]["duals"] = {name: np.asarray(constraint.dual_value).tolist() for name, constraint in zip(constraint_names, constraints)}
        scored_keys = [context["keys"][i] for i in context["scored_indices"]]
        unscored = {context["keys"][i]: context["assets"][i]["scoreReason"]
                    for i in range(len(context["keys"])) if i not in set(context["scored_indices"])}
        result["continuous"] = {"weights": dict(zip(context["keys"], continuous.tolist())),
                                "cashWeightBeforeFees": float(1 - continuous.sum()), "objective": _objective(context, continuous),
                                "alphaConvention": "average-tied-rank[-1,1];scale=1;not-expected-return;pool=scored-only",
                                "alpha": dict(zip(context["keys"], context["alpha"].tolist())),
                                "scoringPool": scored_keys, "unscoredReasons": unscored,
                                "weightBasis": "pretrade-nav", "turnoverDefinition": "0.5*sum(abs(w-currentWeight))",
                                "costModel": {"aversion": context["cost_aversion"],
                                              "buyRate": context["buy_rate"], "sellRate": context["sell_rate"],
                                              "surrogateCostWeight": _cost_surrogate(context, continuous),
                                              "surrogateExcludes": "fixed-minimum-commission;board-lot-rounding"},
                                "risk": _risk(context, continuous)}
        q, diagnostics, cash, trades = _repair(context, continuous)
        result["constraintDiagnostics"] = diagnostics
        failures = [row["constraint"] for row in diagnostics if not row["satisfied"]]
        if failures:
            result["rejectionReasons"] = ["discrete repair failed hard constraints: " + ",".join(failures)]
        else:
            repaired_w = q * context["prices"] / context["nav"]
            costs = money(sum(trade["fees"]["total"] + trade["slippage"] for trade in trades))
            # Make the convex-approximation gap explicit: surrogate cost weight vs
            # settled fees+slippage as a fraction of NAV. The surrogate omits the
            # fixed minimum commission and integer effects by construction.
            surrogate_repaired = _cost_surrogate(context, repaired_w)
            settled_weight = costs / context["nav"]
            result["status"] = "ok"
            result["repaired"] = {"quantities": dict(zip(context["keys"], q.tolist())), "weights": dict(zip(context["keys"], repaired_w.tolist())),
                                  "trades": trades, "cash": cash, "cashWeight": cash / context["nav"],
                                  "pretradeNav": context["nav"], "posttradeNav": money(cash + float(q @ context["prices"])),
                                  "totalCosts": costs, "turnover": float(np.abs(repaired_w - context["current"]).sum() / 2),
                                  "costApproximation": {"surrogateWeight": surrogate_repaired, "settledWeight": settled_weight,
                                                        "settledCosts": costs, "gapWeight": settled_weight - surrogate_repaired,
                                                        "note": "surrogate omits fixed minimum commission and board-lot rounding"},
                                  "repairMethod": "deterministic-100-share-coordinate-repair", "integerOptimal": False}
            result["risk"] = _risk(context, repaired_w)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        result["rejectionReasons"].append(str(exc))
    result["hashes"]["result"] = stable_hash(result)
    return result


def rebalance_plan(input: dict) -> dict:
    """Same validation/optimization/execution engine, never a live order endpoint."""
    result = optimize_portfolio(input)
    result["operation"] = "rebalance-plan"
    result["hashes"].pop("result", None)
    result["hashes"]["result"] = stable_hash(result)
    return result
