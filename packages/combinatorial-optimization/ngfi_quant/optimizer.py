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
        row = _object(row, "instrument price priceAvailableAt quantity sellableQuantity industry advNotional advAvailableAt canBuy canSell statusAvailableAt previousClose limitRate", "score scoreAvailableAt evidenceRefs scoreReason lotSize", label="asset")
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
        # Effective-dated board lot: 100 is the current main-board default, but it
        # is supplied per asset so other boards/periods can declare their own lot.
        # Held odd shares (quantity not a multiple of lotSize) stay exact; only
        # trade increments must be a multiple of the lot.
        lot = row.get("lotSize", 100)
        if type(lot) is not int or lot <= 0:
            raise ValueError("lotSize must be a positive integer")
        _text(row["industry"], "industry")
        _boolean(row["canBuy"], "canBuy")
        _boolean(row["canSell"], "canSell")
        assets.append({**row, "key": instrument.key, "lotSize": lot})
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
    factors, factor_cov, x, s, coverage = validate_cne6_risk(data["riskSnapshot"], keys, as_of, domain_ages["risk"], policy)
    names = [factor["name"] for factor in factors]
    return _prepare_account(data, mandate, assets, keys, alpha, factors, names, factor_cov, x, s,
                            domain_ages, scored_indices, cost_aversion, tolerance, coverage, cash, as_of)


def validate_cne6_risk(value: Any, keys: list[str], as_of: datetime, max_age: float, policy: dict):
    n = len(keys)
    snapshot = _object(value, "schemaVersion model modelVersion asOf availableAt currency covariancePeriod factors securities factorCovariance quality sourceQuality", "stockCovariance coverage inputHash descriptorQuality dataQuality", "riskSnapshot")
    if snapshot["schemaVersion"] != "1" or snapshot["model"] != "CNE6" or snapshot["currency"] != "CNY" or snapshot["covariancePeriod"] != "daily":
        raise ValueError("riskSnapshot must be schema 1, daily CNE6 CNY")
    _text(snapshot["modelVersion"], "modelVersion")
    _pit(snapshot["availableAt"], as_of, max_age, "riskSnapshot.availableAt")
    # The existing CNE6 producer has a date-valued asOf; availability is separate.
    model_time = snapshot["asOf"]
    if isinstance(model_time, str) and len(model_time) == 10:
        model_time += "T00:00:00+08:00"
    _pit(model_time, as_of, max_age, "riskSnapshot.asOf")
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
    return factors, factor_cov, full_x[indices], full_s[indices], coverage


def _prepare_account(data, mandate, assets, keys, alpha, factors, names, factor_cov, x, s,
                     domain_ages, scored_indices, cost_aversion, tolerance, coverage, cash, as_of):
    n = len(keys)
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
                buy_rate=buy_rate, sell_rate=sell_rate, lots=np.array([row["lotSize"] for row in assets], dtype=np.int64),
                tolerance=tolerance, coverage={"assetCount": n, "coveredCount": n, "ratio": coverage, "missingKeys": []})


def half_turnover(weights, current):
    delta = weights - current
    return cp.norm1(delta) / 2 if isinstance(delta, cp.Expression) else float(np.abs(delta).sum() / 2)


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
    if "researchSpec" in context:
        spec = context["researchSpec"]
        turnover = 2 * spec.turnover_penalty * half_turnover(w, context["current"])
        if spec.method == "top-k":
            return float(np.sum((w - context["researchTarget"]) ** 2) + turnover)
        return float(spec.risk_aversion * w @ context["covariance"] @ w - context["alpha"] @ w + turnover)
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
        lot = int(context["lots"][i])
        bound(f"weight:{key}", w[i], context["lower"][i], context["upper"][i])
        bound(f"quantity:{key}", q[i], 0, 2**53 - 1, True)
        bound(f"sellable:{key}", max(0, -delta), 0, asset["sellableQuantity"], True)
        bound(f"participation:{key}", abs(delta) * asset["price"] / asset["advNotional"], 0, context["mandate"]["maxParticipation"])
        bound(f"boardLot:{key}", abs(delta) % lot, 0, 0, True)
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
    lots = context["lots"]
    desired_delta = continuous * context["nav"] / context["prices"] - current
    # Round trade increments to each asset's lot, not total quantities: frozen odd
    # or non-lot holdings stay exact.
    q = current + (np.trunc(desired_delta / lots)).astype(np.int64) * lots
    for i, row in enumerate(context["assets"]):
        lot = int(lots[i])
        if not context["can_buy"][i]:
            q[i] = min(q[i], current[i])
        if not context["can_sell"][i]:
            q[i] = max(q[i], current[i])
        q[i] = max(q[i], current[i] - row["sellableQuantity"] // lot * lot)
        max_trade = math.floor(row["advNotional"] * context["mandate"]["maxParticipation"] / row["price"] / lot) * lot
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
            lot = int(lots[i])
            for step in (-lot, lot):
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


def _lot_oracle(context: dict) -> dict | None:
    """Independent brute-force feasible-solution search on a small problem.

    Enumerates the lot-multiple trade grid for up to a handful of assets to report
    a feasible-solution discovery rate and utility gap versus the coordinate
    repair. This is a test/diagnostic oracle, not a production integer solver: it
    is only computed when the search space is provably small.
    """
    current = context["quantities"]
    lots = context["lots"]
    ranges = []
    total = 1
    for i, asset in enumerate(context["assets"]):
        lot = int(lots[i])
        max_trade = math.floor(asset["advNotional"] * context["mandate"]["maxParticipation"] / asset["price"] / lot)
        down = min(max_trade, asset["sellableQuantity"] // lot) if context["can_sell"][i] else 0
        up = max_trade if context["can_buy"][i] else 0
        total *= down + up + 1
        if total > 20000:
            return None
        ranges.append((i, lot, range(-down, up + 1)))
    best = None
    feasible = 0
    def recurse(index: int, q: np.ndarray) -> None:
        nonlocal best, feasible
        if index == len(ranges):
            diagnostics, _cash, _trades = _diagnostics(context, q)
            if all(row["satisfied"] for row in diagnostics):
                feasible += 1
                objective = _objective(context, q * context["prices"] / context["nav"])
                if best is None or objective < best:
                    best = objective
            return
        i, lot, steps = ranges[index]
        for step in steps:
            nxt = q.copy()
            nxt[i] = current[i] + step * lot
            if nxt[i] < 0:
                continue
            recurse(index + 1, nxt)
    recurse(0, current.copy())
    return {"evaluated": total, "feasibleCount": feasible, "bestObjective": best}


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
        turnover = half_turnover(w, context["current"])
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
        # Independent small-problem oracle: separates a genuine integer infeasibility
        # from a search miss. Only computed when the lot grid is provably small.
        oracle = _lot_oracle(context)
        if oracle is not None:
            result["lotOracle"] = {**oracle, "kind": "brute-force-enumeration"}
        failures = [row["constraint"] for row in diagnostics if not row["satisfied"]]
        if failures:
            # Distinguish "coordinate search found no feasible integer plan" from
            # "the oracle proved none exists". Never claim integer infeasibility
            # from a local-search miss alone.
            if oracle is not None and oracle["feasibleCount"] == 0:
                reason = "integer-infeasible (enumerated): no lot-multiple plan satisfies hard constraints"
            elif oracle is not None:
                reason = "discrete repair search miss: oracle found a feasible plan; failed constraints: " + ",".join(failures)
            else:
                reason = "discrete repair failed hard constraints (search space too large to enumerate): " + ",".join(failures)
            result["rejectionReasons"] = [reason]
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
                                  "lotSizes": dict(zip(context["keys"], context["lots"].tolist())),
                                  "costApproximation": {"surrogateWeight": surrogate_repaired, "settledWeight": settled_weight,
                                                        "settledCosts": costs, "gapWeight": settled_weight - surrogate_repaired,
                                                        "note": "surrogate omits fixed minimum commission and board-lot rounding"},
                                  "repairMethod": "deterministic-effective-lot-coordinate-repair", "integerOptimal": False}
            result["risk"] = _risk(context, repaired_w)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        result["rejectionReasons"].append(str(exc))
    result["hashes"]["result"] = stable_hash(result)
    return result


def research_covariance(panel, index: int, spec) -> tuple[np.ndarray, dict]:
    from .research_contracts import instant
    decision_at = panel.dataset.calendar[index].decision_at
    horizon = spec.model.horizon
    if spec.risk.source == "cne6":
        visible = [row for row in panel.dataset.cne6_models
                   if isinstance(row.get("availableAt"), str) and instant(row["availableAt"]) <= instant(decision_at)]
        if not visible:
            raise ValueError("no PIT-visible CNE6 snapshot; no silent risk fallback")
        snapshot = max(visible, key=lambda row: instant(row["availableAt"]))
        policy = {"allowWarnings": spec.risk.allow_warnings, "allowedProxyFlags": spec.risk.allowed_proxy_flags,
                  "minCoverage": spec.risk.min_coverage, "maxConditionNumber": spec.risk.max_condition_number,
                  "maxAsymmetry": 1e-10, "maxReconciliationError": 1e-10}
        _, factor, x, specific, _ = validate_cne6_risk(snapshot, panel.securities, instant(decision_at), spec.risk.max_age_days, policy)
        from .contracts import require_date
        require_date(snapshot["asOf"], "CNE6 asOf")
        if instant(snapshot["availableAt"]) < instant(snapshot["asOf"] + "T15:00:00+08:00"):
            raise ValueError("CNE6 publication must not precede final market close")
        covariance = (x @ factor @ x.T + np.diag(specific ** 2)) * horizon
        provenance = {"riskSource": "CNE6", "riskSnapshotHash": stable_hash(snapshot),
                      "sourceQuality": snapshot["sourceQuality"], "coverage": snapshot.get("coverage")}
    else:
        from sklearn.covariance import LedoitWolf
        close = panel.fields["close"].iloc[max(0, index - spec.optimizer.risk_lookback):index + 1]
        returns = close.pct_change(fill_method=None).iloc[1:].to_numpy()
        if returns.shape[0] < 5 or not np.isfinite(returns).all():
            raise ValueError("risk covariance requires at least five complete PIT return rows")
        covariance = LedoitWolf().fit(returns).covariance_ * horizon
        provenance = {"riskSource": "LedoitWolf", "riskSnapshotHash": stable_hash(returns.tolist())}
    return covariance, {**provenance, "horizonSessions": horizon, "purpose": "research-diagnostic",
                        "scaling": "daily variance times horizon; ignores cross-session covariance"}


def optimize_research_weights(securities, expected, covariance, current, eligible, industries, spec, *, frozen=None):
    size = len(securities)
    covariance = _matrix(np.asarray(covariance).tolist(), size, "covariance", 1e-10)
    if not size or len(set(securities)) != size or len(industries) != size:
        raise ValueError("invalid optimizer security/industry alignment")
    for label, vector in (("expected", expected), ("current", current), ("eligible", eligible)):
        if vector.shape != (size,) or not np.isfinite(vector).all():
            raise ValueError(f"invalid {label} vector")
    if (current < 0).any() or current.sum() > 1 + 1e-8:
        raise ValueError("current weights must be long-only with nonnegative cash")
    frozen = np.zeros(size, dtype=bool) if frozen is None else frozen
    if eligible.dtype != bool or frozen.dtype != bool or frozen.shape != (size,):
        raise ValueError("eligibility and frozen masks must be boolean and security-aligned")
    if set(spec.industry_caps) - set(industries):
        raise ValueError("industry caps name absent industries")
    w = cp.Variable(size)
    upper = np.where(eligible | frozen, spec.max_weight, 0.0)
    turnover = half_turnover(w, current)
    constraints = [w >= 0, w <= upper, cp.sum(w) <= 1 - spec.cash_reserve,
                   turnover <= spec.max_turnover / 2]
    if frozen.any():
        constraints.append(w[frozen] == current[frozen])
    for industry, cap in spec.industry_caps.items():
        constraints.append(cp.sum(w[[i for i, name in enumerate(industries) if name == industry]]) <= cap)
    selected = []
    if spec.method == "top-k":
        selected = sorted(np.flatnonzero(eligible & ~frozen), key=lambda i: (-expected[i], securities[i]))[:spec.top_k]
        outside = np.ones(size, dtype=bool)
        outside[selected] = False
        outside &= ~frozen
        if outside.any():
            constraints.append(w[outside] == 0)
        target = np.zeros(size)
        target[frozen] = current[frozen]
        if selected:
            target[selected] = min(spec.max_weight, max(0, 1 - spec.cash_reserve - current[frozen].sum()) / len(selected))
        objective = cp.Minimize(cp.sum_squares(w - target) + 2 * spec.turnover_penalty * turnover)
    else:
        objective = cp.Maximize(expected @ w - spec.risk_aversion * cp.quad_form(w, cp.psd_wrap(covariance))
                                - 2 * spec.turnover_penalty * turnover)
    problem = cp.Problem(objective, constraints)
    try:
        problem.solve(solver="CLARABEL", max_iter=200, tol_gap_abs=1e-9, tol_feas=1e-9, tol_gap_rel=1e-9)
    except cp.error.SolverError:
        return {"status": "failed", "reason": "solver-error", "weights": None}
    if problem.status != cp.OPTIMAL or w.value is None:
        return {"status": "failed", "reason": str(problem.status), "weights": None}
    value = np.asarray(w.value)
    violation = max(float(np.max(np.abs(constraint.violation()))) for constraint in constraints)
    if not np.isfinite(value).all() or violation > 1e-7:
        return {"status": "failed", "reason": "constraint-residual", "weights": None}
    value = np.maximum(0, value)
    return {"status": "complete", "weights": dict(zip(securities, value.tolist())),
            "cashWeight": float(1 - value.sum()), "turnover": 2 * half_turnover(value, current),
            "turnoverDefinition": "sum(abs(w-currentWeight))", "internalTurnoverLimit": spec.max_turnover / 2,
            "internalTurnoverPenalty": 2 * spec.turnover_penalty,
            "objectiveMode": "forecast-mean-variance" if spec.method == "mean-variance" else "constrained-top-k",
            "selectedCandidates": [securities[i] for i in selected], "expectedReturn": float(expected @ value),
            "variance": float(value @ covariance @ value), "covarianceHash": stable_hash(covariance.tolist()),
            "maximumViolation": violation, "solver": "CLARABEL", "objective": float(problem.value),
            "feasibilityScope": "continuous research target at decision time; not an A3 audited plan",
            "promotionEligible": False}


def plan_research_orders(panel, index: int, spec, account: dict, allocation: dict, expected, covariance) -> dict:
    day = panel.dates[index]
    keys = panel.securities
    assets = [panel.bars[day, key] for key in keys]
    quantities = np.array([account["quantities"].get(key, 0) for key in keys], dtype=np.int64)
    prices = np.array([row.close for row in assets])
    nav = account["nav"]
    cost = AShareCostModel(commission_rate=spec.execution.commission_rate, minimum_commission=spec.execution.minimum_commission,
                          stamp_duty_rate=spec.execution.stamp_duty_rate, transfer_fee_rate=spec.execution.transfer_fee_rate,
                          slippage_rate=spec.execution.slippage_rate)
    bars = [AShareBar(day, instrument_from_contract(row.instrument.json()), panel.dataset.calendar[index].decision_at,
                     row.close, None, None, row.close, row.previous_close, row.suspended, row.limit_rate,
                     row.status_available_at, row.eligible and not row.suspended, not row.suspended) for row in assets]
    permissions = [[fill_order(bar, 100, side, cost, decision_at=panel.dataset.calendar[index].decision_at,
                               require_status=True)[1] is None for bar in bars] for side in ("buy", "sell")]
    upper = np.array([spec.optimizer.max_weight if row.eligible or quantities[i] else 0 for i, row in enumerate(assets)])
    if spec.optimizer.method == "top-k":
        upper = np.array([upper[i] if key in allocation["selectedCandidates"] or not permissions[1][i] else 0
                          for i, key in enumerate(keys)])
    context = {"researchSpec": spec.optimizer, "researchTarget": np.array([allocation["weights"].get(key, 0) for key in keys]),
               "covariance": covariance, "alpha": expected, "keys": keys, "quantities": quantities,
               "current": quantities * prices / nav, "prices": prices, "nav": nav, "cash": account["cash"],
               "lots": np.array([row.lot_size for row in assets]), "bars": bars, "cost": cost,
               "data": {"asOf": panel.dataset.calendar[index].decision_at}, "can_buy": permissions[0], "can_sell": permissions[1],
               "lower": np.zeros(len(keys)), "upper": upper, "b": np.zeros(len(keys)), "tolerance": 1e-7,
               "mandate": {"cashMin": spec.optimizer.cash_reserve, "cashMax": 1,
                           "turnoverLimit": spec.optimizer.max_turnover / 2, "maxParticipation": spec.execution.max_participation},
               "assets": [{"instrument": row.instrument.json(), "quantity": int(quantities[i]),
                           "sellableQuantity": account["sellableNextDay"].get(keys[i], 0), "price": row.close,
                           "advNotional": max(row.volume * row.close, 1e-12)} for i, row in enumerate(assets)],
               "bands": [(f"industryCap.{industry}", np.array([float(row.industry == industry) for row in assets]), 0, cap)
                         for industry, cap in spec.optimizer.industry_caps.items()]}
    q, diagnostics, cash, trades = _repair(context, context["researchTarget"])
    failures = [row["constraint"] for row in diagnostics if not row["satisfied"]]
    oracle = _lot_oracle(context)
    if failures:
        reason = "integer-infeasible (enumerated)" if oracle and oracle["feasibleCount"] == 0 else (
            "discrete repair search miss" if oracle else "discrete repair failed; too large to enumerate")
        return {**allocation, "status": "failed", "reason": reason, "constraintDiagnostics": diagnostics, "lotOracle": oracle}
    return {**allocation, "quantities": dict(zip(keys, q.tolist())), "constraintDiagnostics": diagnostics, "lotOracle": oracle,
            "estimatedCash": cash, "estimatedTrades": trades, "accountSnapshotHash": stable_hash(account),
            "feasibilityScope": "research target and lot plan at decision prices; future fills are not guaranteed"}


def rebalance_plan(input: dict) -> dict:
    """Same validation/optimization/execution engine, never a live order endpoint."""
    result = optimize_portfolio(input)
    result["operation"] = "rebalance-plan"
    result["hashes"].pop("result", None)
    result["hashes"]["result"] = stable_hash(result)
    return result
