"""Factor -> rolling model -> constrained portfolio -> execution -> evidence."""

from __future__ import annotations

from importlib.metadata import version
from pathlib import Path

import numpy as np

from .hashing import stable_hash
from .research_contracts import ResearchDataset, ResearchSpec, instant
from .research_factors import build_panel, compute_factors, factor_correlations, factor_diagnostics, forward_labels
from .research_models import prediction_diagnostics, rolling_predict
from .research_optimizer import cne6_covariance, covariance_at, optimize_weights
from .target_backtest import replay_targets


def engine_identity() -> dict:
    files = ["research_contracts.py", "research_factors.py", "research_models.py", "research_optimizer.py",
             "target_backtest.py", "experiment.py", "execution.py", "hashing.py", "contracts.py"]
    return {
        "name": "ngfi-cross-sectional-research", "version": "1.0.0",
        "sourceHash": stable_hash({name: Path(__file__).with_name(name).read_text() for name in files}),
        "dependencies": {name: version(name) for name in ("numpy", "pandas", "scikit-learn", "cvxpy", "clarabel")},
    }


def equal_weight_baseline(
    securities: list[str],
    current: list[float] | np.ndarray,
    eligible: list[bool] | np.ndarray,
    frozen: list[bool] | np.ndarray,
    cash_reserve: float,
) -> dict:
    current_weights = np.asarray(current, dtype=float)
    eligible_mask = np.asarray(eligible, dtype=bool)
    frozen_mask = np.asarray(frozen, dtype=bool)
    if current_weights.shape != eligible_mask.shape or current_weights.shape != frozen_mask.shape:
        raise ValueError("baseline arrays must have matching shapes")
    if current_weights.shape != (len(securities),):
        raise ValueError("baseline arrays must match securities")
    investable = 1 - cash_reserve
    frozen_weight = float(current_weights[frozen_mask].sum())
    if frozen_weight > investable + 1e-7:
        return {"status": "failed", "reason": "frozen baseline positions exceed investable budget"}
    weights = np.zeros(len(securities))
    weights[frozen_mask] = current_weights[frozen_mask]
    tradable = eligible_mask & ~frozen_mask
    if tradable.any():
        weights[tradable] = max(0.0, investable - frozen_weight) / int(tradable.sum())
    return {
        "status": "complete",
        "weights": dict(zip(securities, weights.tolist())),
    }


def run_experiment(dataset: ResearchDataset, spec: ResearchSpec) -> dict:
    panel = build_panel(dataset)
    factors = compute_factors(panel, spec.factors)
    models = rolling_predict(panel, factors, spec)

    def policy(index, current):
        day = panel.dates[index]
        prediction = models["predictions"].get(day)
        if prediction is None:
            return {"status": "failed", "reason": "no OOS prediction"}
        values = prediction["values"]
        eligible = np.array([key in values and panel.eligible.loc[day, key] for key in panel.securities])
        expected = np.array([values.get(key, 0.0) for key in panel.securities])
        try:
            if dataset.cne6_models:
                cutoff = dataset.calendar[index].decision_at
                visible = [item for item in dataset.cne6_models
                           if item.get("availableAt") and instant(item["availableAt"]) <= instant(cutoff)]
                if not visible:
                    raise ValueError("no PIT-visible CNE6 snapshot; no silent risk fallback")
                risk = cne6_covariance(max(visible, key=lambda item: instant(item["availableAt"])),
                                      panel.securities, cutoff, spec.model.horizon)
            else:
                risk = covariance_at(panel, index, spec.optimizer.risk_lookback, spec.model.horizon)
            result = optimize_weights(
                panel.securities, expected, risk, current, eligible,
                [panel.bars[day, key].industry for key in panel.securities], spec.optimizer,
                frozen=np.array([panel.bars[day, key].suspended for key in panel.securities]),
            )
            return {**result, "modelId": prediction["modelId"],
                    "riskSource": "CNE6" if dataset.cne6_models else "LedoitWolf",
                    "predictionHash": stable_hash(prediction)}
        except (ValueError, KeyError, TypeError) as error:
            return {"status": "failed", "reason": str(error), "modelId": prediction["modelId"]}

    backtest = replay_targets(panel, spec, policy)

    def baseline(index, current):
        day = panel.dates[index]
        return equal_weight_baseline(
            panel.securities,
            current,
            [panel.eligible.loc[day, key] for key in panel.securities],
            [panel.bars[day, key].suspended for key in panel.securities],
            spec.optimizer.cash_reserve,
        )

    benchmark = replay_targets(panel, spec, baseline)
    labels, boundaries = forward_labels(panel, spec.model.horizon)
    evaluation_end = panel.dates[panel.dates.index(spec.end_date) + 1]
    for day, (outcome, _) in boundaries.items():
        if outcome > evaluation_end:
            labels.loc[day] = np.nan
    diagnostics = factor_diagnostics(panel, factors, labels, spec.start_date, spec.end_date)
    correlations = factor_correlations(factors, spec.start_date, spec.end_date)
    model_diagnostics = prediction_diagnostics(models["predictions"], labels)
    predictions = [{"date": day, **prediction} for day, prediction in models["predictions"].items()]
    available = sum(item["status"] == "complete" for item in models["folds"])
    status = "complete" if backtest["status"] == "complete" and available == len(models["folds"]) else "partial"
    engine = engine_identity()
    identity = {"datasetHash": dataset.hash, "specHash": spec.hash, "engine": engine}
    factor_rows = [
        {"date": day, "instrument": key, "factor": name,
         "value": float(matrix.loc[day, key]) if np.isfinite(matrix.loc[day, key]) else None}
        for name, matrix in factors.items() for day in panel.dates if spec.start_date <= day <= spec.end_date
        for key in panel.securities
    ]
    artifacts = {
        "models": models["folds"], "predictions": predictions, "factors": factor_rows,
        "diagnostics": diagnostics, "correlations": correlations, "modelDiagnostics": model_diagnostics,
        "backtest": backtest, "benchmark": benchmark,
    }
    return {
        "id": stable_hash(identity), **identity, "status": status, "promotionEligible": False,
        "spec": spec.json(), **artifacts,
        "artifactHashes": {name: stable_hash(value) for name, value in artifacts.items()},
        "summary": {
            "status": status, "datasetSnapshotId": dataset.snapshot_id,
            "predictionDays": len(predictions), "completeFolds": available,
            "modelKind": spec.model.kind, "optimizerMethod": spec.optimizer.method,
            "modelMetrics": {key: value for key, value in model_diagnostics.items() if key != "daily"},
            "factorDefinitions": [{"id": factor.id, "version": factor.version, "hash": factor.hash}
                                  for factor in spec.factors],
            "metrics": backtest["metrics"], "benchmarkMetrics": benchmark["metrics"],
            "excessTotalReturn": backtest["metrics"]["totalReturn"] - benchmark["metrics"]["totalReturn"],
            "benchmark": "equal-weight eligible universe; identical dates/costs/execution; no alpha/risk constraints",
            "promotionEligible": False,
            "warnings": [
                "Research evidence only: no live orders, automatic strategy promotion, or guaranteed returns.",
                "Corporate actions and missing raw-price sessions are rejected; no accounting is inferred.",
                "The caller attests historical universe and PIT feature availability; source truth is not independently verified.",
                "Single fixed configuration. OOS diagnostics must not be reused to tune this same test window.",
                "HGB models are reproducible by refitting frozen input; no pickle or arbitrary model deserialization.",
            ],
        },
    }
