from __future__ import annotations

from importlib.metadata import version

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

from .hashing import stable_hash
from .research_contracts import ResearchSpec, instant
from .factors.graph import ResearchPanel, forward_labels


def rolling_predict(panel: ResearchPanel, factors: dict[str, pd.DataFrame], spec: ResearchSpec) -> dict:
    dates = panel.dates
    if spec.start_date not in dates or spec.end_date not in dates:
        raise ValueError("research date range must be in the trading calendar")
    start, end = dates.index(spec.start_date), dates.index(spec.end_date)
    config = spec.model
    if start < config.train_sessions + config.horizon + 1 + config.embargo_sessions:
        raise ValueError("insufficient pre-OOS history for trainSessions, horizon and embargoSessions")
    if end >= len(dates) - 1:
        raise ValueError("endDate must leave at least one next-session execution bar")
    if list(factors) != [factor.id for factor in spec.factors]:
        raise ValueError("factor matrices must match the registered definitions")
    names = spec.feature_names
    if any(list(frame.index) != dates or list(frame.columns) != panel.securities for frame in factors.values()):
        raise ValueError("factor matrices must align with calendar and securities")
    cube = np.stack([factors[name].to_numpy() for name in names], axis=2)
    labels, boundaries = forward_labels(panel, config.horizon)
    predictions, folds, contributions, group_diagnostics = {}, [], [], []
    explanation = spec.model_explanation
    if explanation and (end - start + 1) * len(explanation.groups) * sum(
            explanation.repeats if method == "within-date-permutation" else 1 for method in explanation.methods) > 200_000:
        raise ValueError("model explanation exceeds 200000 registered perturbation rows")
    evaluation_end = min(end + 1, len(dates) - 1)
    for first in range(start, end + 1, config.refit_every):
        last = min(end + 1, first + config.refit_every)
        cutoff = instant(panel.dataset.calendar[first - 1].decision_at)
        latest_outcome = first - 1 - config.embargo_sessions
        candidates = [index for index in range(first) if dates[index] in boundaries
                      and (spec.training_start_date is None or dates[index] >= spec.training_start_date)
                      and dates.index(boundaries[dates[index]][0]) <= latest_outcome
                      and instant(boundaries[dates[index]][1]) <= cutoff][-config.train_sessions:]
        x = cube[candidates].reshape(-1, len(names))
        y = labels.iloc[candidates].to_numpy().reshape(-1)
        valid = np.isfinite(x).all(axis=1) & np.isfinite(y)
        x, y = x[valid], y[valid]
        fold = {"predictStart": dates[first], "predictEnd": dates[last - 1],
                "trainStart": dates[candidates[0]] if candidates else None,
                "trainEnd": dates[candidates[-1]] if candidates else None,
                "maxLabelAvailableAt": max((boundaries[dates[i]][1] for i in candidates), key=instant, default=None),
                "fitAsOf": cutoff.isoformat(), "samples": len(x), "features": names,
                "model": config.json(), "sklearnVersion": version("scikit-learn")}
        if len(x) < config.minimum_samples or len(candidates) < config.train_sessions:
            folds.append({**fold, "status": "insufficient", "reason": "insufficient complete visible training samples"})
            continue
        train_hash = stable_hash({"x": x.tolist(), "y": y.tolist(), "dates": [dates[i] for i in candidates],
                                  "securities": panel.securities, "factorHashes": [factor.hash for factor in spec.factors]})
        lower, upper = np.quantile(x, [config.clip_quantile, 1 - config.clip_quantile], axis=0)
        scaler = StandardScaler()
        transformed = scaler.fit_transform(np.clip(x, lower, upper))
        model = Ridge(alpha=config.ridge_alpha, solver="svd") if config.kind == "ridge" else HistGradientBoostingRegressor(
            max_iter=config.max_iter, max_leaf_nodes=config.max_leaf_nodes, learning_rate=config.learning_rate,
            early_stopping=False, random_state=config.seed)
        with threadpool_limits(limits=1):
            model.fit(transformed, y)
        state = {"lower": lower.tolist(), "upper": upper.tolist(), "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
                 "coef": model.coef_.tolist() if config.kind == "ridge" else None,
                 "intercept": float(model.intercept_) if config.kind == "ridge" else None}
        model_id = stable_hash({"trainingHash": train_hash, "fold": fold, "state": state})
        folds.append({**fold, "status": "complete", "id": model_id, "trainingHash": train_hash, "state": state})
        for index in range(first, last):
            usable = np.isfinite(cube[index]).all(axis=1) & panel.eligible.iloc[index].to_numpy()
            if not usable.any():
                continue
            test = scaler.transform(np.clip(cube[index][usable], lower, upper))
            with threadpool_limits(limits=1):
                values = model.predict(test)
            if not np.isfinite(values).all():
                raise ValueError("model returned non-finite predictions")
            predictions[dates[index]] = {"modelId": model_id, "asOf": panel.dataset.calendar[index].decision_at,
                                        "horizon": config.horizon, "unit": "decimal-open-to-open-return",
                                        "values": dict(zip(np.array(panel.securities)[usable].tolist(), values.tolist()))}
            if spec.schema_version == "3" and config.kind == "ridge":
                parts = test * model.coef_
                for security, value, row in zip(np.array(panel.securities)[usable], values, parts):
                    error = float(value - model.intercept_ - row.sum())
                    if abs(error) > 1e-10:
                        raise ValueError("Ridge prediction contributions do not reconcile")
                    contributions.append({"date": dates[index], "instrument": str(security), "modelId": model_id,
                                          "prediction": float(value), "intercept": float(model.intercept_),
                                          "contributions": dict(zip(names, row.tolist())), "reconciliationError": error})
            if explanation:
                boundary = boundaries.get(dates[index])
                mature = boundary is not None and boundary[0] <= dates[evaluation_end] and instant(boundary[1]) <= instant(panel.dataset.calendar[evaluation_end].decision_at)
                outcomes = labels.iloc[index].to_numpy()[usable] if mature else np.full(len(values), np.nan)
                observed = np.isfinite(outcomes)
                baseline_mse = float(np.mean((values[observed] - outcomes[observed]) ** 2)) if observed.any() else None
                for group, members in explanation.groups.items():
                    columns = [names.index(name) for name in members]
                    for method in explanation.methods:
                        for repeat in range(explanation.repeats if method == "within-date-permutation" else 1):
                            perturbed = test.copy()
                            if method == "within-date-permutation":
                                rng = np.random.default_rng(np.random.SeedSequence([explanation.seed, first, index, repeat]))
                                perturbed[:, columns] = test[rng.permutation(len(test))][:, columns]
                            else:
                                perturbed[:, columns] = 0  # training mean in the fitted standardized space
                            with threadpool_limits(limits=1):
                                changed = model.predict(perturbed)
                            group_diagnostics.append({"date": dates[index], "modelId": model_id, "group": group,
                                "method": method, "repeat": repeat, "samples": len(values), "labelSamples": int(observed.sum()),
                                "predictionRmseChange": float(np.sqrt(np.mean((changed - values) ** 2))),
                                "baselineMse": baseline_mse,
                                "mseIncrease": float(np.mean((changed[observed] - outcomes[observed]) ** 2) - baseline_mse) if observed.any() else None})
    if not predictions:
        raise ValueError("no OOS predictions: insufficient visible training data or factor coverage")
    result = {"folds": folds, "predictions": predictions, "labelConvention": "open(t+1+h)/open(t+1)-1"}
    if spec.schema_version == "3":
        result["attribution"] = {"schemaVersion": "3", "promotionEligible": False, "kind": "model-prediction",
            "unit": "decimal-open-to-open-return", "method": "transformed-feature-times-coefficient" if config.kind == "ridge" else "registered-group-sensitivity",
            "status": "complete" if config.kind == "ridge" or explanation else "blocked",
            "rows": contributions, "groupDiagnostics": group_diagnostics,
            "registration": explanation.json() if explanation else None,
            "limitations": ["Group sensitivities are not additive contributions or realized returns.",
                           "Ablation replaces a group by its fitted training mean without retraining.",
                           "Permutation preserves dates and joint group rows; it does not establish causality."]}
    return result


def prediction_diagnostics(predictions: dict, labels: pd.DataFrame) -> dict:
    daily, squared_errors = [], []
    for day, prediction in predictions.items():
        values = pd.Series(prediction["values"], dtype=float)
        paired = pd.concat([values.rename("prediction"), labels.loc[day].rename("label")], axis=1).dropna()
        correlation = None
        if len(paired) >= 3 and paired["prediction"].nunique() > 1 and paired["label"].nunique() > 1:
            correlation = float(paired["prediction"].rank().corr(paired["label"].rank()))
        error = (paired["prediction"] - paired["label"]) ** 2
        squared_errors.extend(error.tolist())
        daily.append({"date": day, "samples": len(paired), "rankIc": correlation,
                      "rmse": float(np.sqrt(error.mean())) if len(error) else None})
    rank_ics = [item["rankIc"] for item in daily if item["rankIc"] is not None]
    return {"role": "out-of-sample-diagnostic-only", "samples": len(squared_errors),
            "rmse": float(np.sqrt(np.mean(squared_errors))) if squared_errors else None,
            "meanRankIc": float(np.mean(rank_ics)) if rank_ics else None, "daily": daily}
