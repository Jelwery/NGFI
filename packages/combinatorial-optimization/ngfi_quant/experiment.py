from __future__ import annotations

from hashlib import sha256
from importlib.metadata import version
from pathlib import Path
import math

import numpy as np

from .contracts import AShareBar, AShareCostModel, BacktestMetadata, BacktestRequest, PortfolioConfig, instrument_from_contract
from .execution import money
from .factors.graph import build_panel, compute_factors, factor_correlations, factor_diagnostics, forward_labels
from .hashing import stable_hash
from .optimizer import optimize_research_weights, plan_research_orders, research_covariance
from .portfolio import run_research_backtest
from .research_contracts import ResearchDataset, ResearchSpec, instant
from .research_models import prediction_diagnostics, rolling_predict


def engine_identity() -> dict:
    root = Path(__file__).parent
    return {"name": "ngfi-cross-sectional-research", "version": "2.0.0",
            "sourceHash": stable_hash({path.relative_to(root).as_posix(): path.read_text() for path in sorted(root.rglob("*.py"))}),
            "dependencyLockHash": "sha256:" + sha256((root.parent / "uv.lock").read_bytes()).hexdigest(),
            "dependencies": {name: version(name) for name in ("numpy", "pandas", "scikit-learn", "cvxpy", "clarabel", "osqp")}}


def equal_weight_baseline(securities, current, eligible, frozen, cash_reserve):
    current = np.asarray(current, dtype=float)
    eligible, frozen = np.asarray(eligible, dtype=bool), np.asarray(frozen, dtype=bool)
    if current.shape != (len(securities),) or eligible.shape != current.shape or frozen.shape != current.shape:
        raise ValueError("baseline arrays must align with securities")
    budget = 1 - cash_reserve - current[frozen].sum()
    if budget < -1e-7:
        return {"status": "failed", "reason": "frozen baseline positions exceed investable budget"}
    weights = np.zeros(len(securities))
    weights[frozen] = current[frozen]
    tradable = eligible & ~frozen
    if tradable.any():
        weights[tradable] = max(0, budget) / int(tradable.sum())
    return {"status": "complete", "weights": dict(zip(securities, weights.tolist()))}


def replay_research(panel, spec: ResearchSpec, policy) -> dict:
    start, end = panel.dates.index(spec.start_date), panel.dates.index(spec.end_date)
    if end >= len(panel.dates) - 1:
        raise ValueError("endDate must leave one execution session")
    dates = panel.dates[start:end + 2]
    calendar = panel.dataset.calendar[start:end + 2]
    cost = AShareCostModel(commission_rate=spec.execution.commission_rate, minimum_commission=spec.execution.minimum_commission,
                          stamp_duty_rate=spec.execution.stamp_duty_rate, transfer_fee_rate=spec.execution.transfer_fee_rate,
                          slippage_rate=spec.execution.slippage_rate)
    request = BacktestRequest(
        calendar=tuple(dates),
        bars=tuple(AShareBar(row.date, instrument_from_contract(row.instrument.json()), row.available_at,
                            row.open, row.high, row.low, row.close, row.previous_close, row.suspended, row.limit_rate,
                            row.status_available_at, row.eligible and not row.suspended, not row.suspended)
                   for row in panel.dataset.bars if row.date in dates),
        signals=(), cost_model=cost, portfolio=PortfolioConfig(spec.execution.initial_capital, len(panel.securities), 1, len(dates)),
        metadata=BacktestMetadata(panel.dataset.snapshot_id, panel.dataset.hash, panel.dataset.as_of, spec.hash, spec.hash,
                                  cost.hash, None, None, panel.dataset.as_of, panel.dataset.as_of, "2.0.0"))

    def decide(day, account):
        index = panel.dates.index(day)
        if index > end or (index - start) % spec.execution.rebalance_every:
            return None
        decision = policy(index, account)
        if decision.get("status") != "complete":
            return decision
        rows = [panel.bars[day, key] for key in panel.securities]
        if any(instant(row.available_at) > instant(calendar[index - start].decision_at) or
               instant(row.status_available_at) > instant(calendar[index - start].decision_at) for row in rows):
            return {"status": "failed", "reason": "non-visible decision price or trading status"}
        if "quantities" not in decision:
            quantities = {}
            for row in rows:
                key = row.instrument.key
                current = account["quantities"].get(key, 0)
                desired = decision["weights"].get(key, 0) * account["nav"] / row.close
                quantities[key] = current + math.trunc((desired - current) / row.lot_size) * row.lot_size
            decision = {**decision, "quantities": quantities}
        return {**decision, "accountSnapshotHash": stable_hash(account),
                "lotSizes": {row.instrument.key: row.lot_size for row in rows},
                "capacity": {row.instrument.key: math.floor(row.volume * spec.execution.max_participation / row.lot_size) * row.lot_size for row in rows}}

    result = run_research_backtest(request, policy=decide,
                                  decision_times={row.date: row.decision_at for row in calendar},
                                  open_times={row.date: row.open_at for row in calendar})
    equity, orders, fills, decisions = [], [], [], []
    previous = spec.execution.initial_capital
    for point, ledger in zip(result.equity, result.daily_ledger):
        nav = point.value
        equity.append({"date": point.date, "nav": nav, "cash": ledger["cash"], "return": nav / previous - 1,
                       "positions": ledger["quantities"], "receivableDividends": ledger["receivableDividends"]})
        previous = nav
        orders.extend(ledger.get("orders", []))
        fills.extend({"date": point.date, **fill} for fill in ledger["fills"])
        if "decision" in ledger:
            decisions.append({"date": point.date, **ledger["decision"]})
    returns = np.array([point["return"] for point in equity[1:]])
    navs = np.array([point["nav"] for point in equity])
    total = navs[-1] / spec.execution.initial_capital - 1
    deviation = np.std(returns, ddof=1) if len(returns) > 1 else 0
    annualized = float(np.expm1(np.log1p(total) * 252 / len(returns)))
    failed = sum(row["status"] != "complete" for row in decisions)
    return {"status": "partial" if failed else "complete", "run": result.run,
            "equity": equity, "orders": orders, "fills": fills, "decisions": decisions,
            "dailyLedger": list(result.daily_ledger), "finalCash": result.final_cash,
            "finalPositions": result.daily_ledger[-1]["quantities"],
            "metrics": {"totalReturn": float(total), "annualizedReturn": annualized if math.isfinite(annualized) else None,
                        "sharpe": float(np.mean(returns) / deviation * math.sqrt(252)) if deviation > 1e-12 else None,
                        "maxDrawdown": float(np.min(navs / np.maximum.accumulate(navs) - 1)),
                        "fees": money(sum(fill["fees"]["total"] for fill in fills)),
                        "tradedNotional": money(sum(fill["notional"] for fill in fills)),
                        "turnover": float(sum(fill["notional"] for fill in fills) / np.mean(navs)),
                        "fillCount": len(fills), "failedDecisions": failed, "returnObservations": len(returns),
                        "rejectedOrders": sum(row["status"] == "rejected" for row in orders),
                        "partialOrders": sum(row["status"] == "partial" for row in orders)}}


def run_experiment(dataset: ResearchDataset, spec: ResearchSpec) -> dict:
    panel = build_panel(dataset)
    factors = compute_factors(panel, spec.factors)
    models = rolling_predict(panel, factors, spec)

    def policy(index, account):
        day = panel.dates[index]
        prediction = models["predictions"].get(day)
        if prediction is None:
            return {"status": "failed", "reason": "no OOS prediction"}
        rows = [panel.bars[day, key] for key in panel.securities]
        current = np.array([account["quantities"].get(key, 0) * row.close / account["nav"] for key, row in zip(panel.securities, rows)])
        expected = np.array([prediction["values"].get(key, 0) for key in panel.securities])
        eligible = np.array([key in prediction["values"] and panel.eligible.loc[day, key] for key in panel.securities])
        try:
            covariance, risk = research_covariance(panel, index, spec)
            allocation = optimize_research_weights(panel.securities, expected, covariance, current, eligible,
                                                  [row.industry for row in rows], spec.optimizer,
                                                  frozen=np.array([row.suspended for row in rows]))
            if allocation["status"] == "complete":
                allocation = plan_research_orders(panel, index, spec, account, allocation, expected, covariance)
            return {**allocation, **risk, "modelId": prediction["modelId"], "predictionHash": stable_hash(prediction)}
        except (ValueError, KeyError, TypeError) as error:
            return {"status": "failed", "reason": str(error), "modelId": prediction["modelId"]}

    backtest = replay_research(panel, spec, policy)

    def baseline(index, account):
        day = panel.dates[index]
        rows = [panel.bars[day, key] for key in panel.securities]
        return equal_weight_baseline(panel.securities,
            [account["quantities"].get(key, 0) * row.close / account["nav"] for key, row in zip(panel.securities, rows)],
            [panel.eligible.loc[day, key] for key in panel.securities], [row.suspended for row in rows], spec.optimizer.cash_reserve)

    benchmark = replay_research(panel, spec, baseline)
    labels, boundaries = forward_labels(panel, spec.model.horizon)
    evaluation_end = panel.dates[panel.dates.index(spec.end_date) + 1]
    evaluation_at = panel.dataset.calendar[panel.dates.index(evaluation_end)].decision_at
    for day, (outcome, available_at) in boundaries.items():
        if outcome > evaluation_end or instant(available_at) > instant(evaluation_at):
            labels.loc[day] = np.nan
    diagnostics = factor_diagnostics(panel, factors, labels, spec.start_date, spec.end_date)
    model_diagnostics = prediction_diagnostics(models["predictions"], labels)
    available = sum(fold["status"] == "complete" for fold in models["folds"])
    status = "complete" if backtest["status"] == benchmark["status"] == "complete" and available == len(models["folds"]) else "partial"
    identity = {"datasetHash": dataset.hash, "specHash": spec.hash, "engine": engine_identity()}
    artifacts = {"models": models["folds"], "predictions": [{"date": day, **row} for day, row in models["predictions"].items()],
                 "factors": [{"date": day, "instrument": key, "factor": name,
                              "value": float(matrix.loc[day, key]) if np.isfinite(matrix.loc[day, key]) else None}
                             for name, matrix in factors.items() for day in panel.dates if spec.start_date <= day <= spec.end_date for key in panel.securities],
                 "diagnostics": diagnostics, "correlations": factor_correlations(factors, spec.start_date, spec.end_date),
                 "modelDiagnostics": model_diagnostics, "backtest": backtest, "benchmark": benchmark}
    summary = {"status": status, "synthetic": dataset.synthetic, "datasetSnapshotId": dataset.snapshot_id,
               "predictionDays": len(models["predictions"]), "completeFolds": available, "modelKind": spec.model.kind,
               "optimizerMethod": spec.optimizer.method, "purpose": spec.purpose, "promotionEligible": False,
               "metrics": backtest["metrics"], "benchmarkMetrics": benchmark["metrics"],
               "excessTotalReturn": backtest["metrics"]["totalReturn"] - benchmark["metrics"]["totalReturn"],
               "benchmark": "experimental equal-weight eligible universe; not CSI300/CSI800",
               "actualBenchmarkStatus": "missing", "strategyValidationStatus": "blocked",
               "warnings": ["Research targets are not confirmed-account A3 plans or live orders.",
                            "Source truth and historical membership are caller supplied, not independently accepted.",
                            "No corporate-action ledger is inferred for raw-no-corporate-actions datasets.",
                            "OOS diagnostics do not establish an unused holdout or permit automatic promotion."]}
    return {"id": stable_hash(identity), **identity, "status": status, "promotionEligible": False, "spec": spec.json(),
            **artifacts, "artifactHashes": {name: stable_hash(value) for name, value in artifacts.items()}, "summary": summary}
