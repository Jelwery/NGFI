"""Purged rolling OOS models. Preprocessing is fitted only on visible training rows."""

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
from .research_factors import ResearchPanel, forward_labels


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
    names = list(factors)
    cube = np.stack([factors[name].to_numpy() for name in names], axis=2)
    labels, boundaries = forward_labels(panel, config.horizon)
    predictions = {}
    folds = []
    for first in range(start, end + 1, config.refit_every):
        last = min(end + 1, first + config.refit_every)
        # Training is frozen before the first prediction date, even in after-close runs.
        cutoff = instant(panel.dataset.calendar[first - 1].decision_at)
        latest_outcome = first - 1 - config.embargo_sessions
        candidates = [
            index for index in range(first)
            if dates[index] in boundaries
            and dates.index(boundaries[dates[index]][0]) <= latest_outcome
            and instant(boundaries[dates[index]][1]) <= cutoff
        ][-config.train_sessions:]
        x = cube[candidates].reshape(-1, len(names))
        y = labels.iloc[candidates].to_numpy().reshape(-1)
        valid = np.isfinite(x).all(axis=1) & np.isfinite(y)
        x, y = x[valid], y[valid]
        fold = {
            "predictStart": dates[first], "predictEnd": dates[last - 1],
            "trainStart": dates[candidates[0]] if candidates else None,
            "trainEnd": dates[candidates[-1]] if candidates else None,
            "maxLabelAvailableAt": max((boundaries[dates[i]][1] for i in candidates), key=instant, default=None),
            "fitAsOf": cutoff.isoformat(), "samples": len(x), "features": names,
            "model": config.json(), "sklearnVersion": version("scikit-learn"),
        }
        if len(x) < config.minimum_samples or len(candidates) < config.train_sessions:
            folds.append({**fold, "status": "insufficient", "reason": "insufficient complete visible training samples"})
            continue
        train_hash = stable_hash({"x": x.tolist(), "y": y.tolist(), "dates": [dates[i] for i in candidates],
                                  "securities": panel.securities, "factorHashes": [factor.hash for factor in spec.factors]})
        lower, upper = np.quantile(x, [config.clip_quantile, 1 - config.clip_quantile], axis=0)
        scaler = StandardScaler()
        transformed = scaler.fit_transform(np.clip(x, lower, upper))
        if config.kind == "ridge":
            model = Ridge(alpha=config.ridge_alpha, solver="svd")
        else:
            model = HistGradientBoostingRegressor(
                max_iter=config.max_iter, max_leaf_nodes=config.max_leaf_nodes,
                learning_rate=config.learning_rate, early_stopping=False, random_state=config.seed,
            )
        with threadpool_limits(limits=1):
            model.fit(transformed, y)
        state = {
            "lower": lower.tolist(), "upper": upper.tolist(),
            "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
            "coef": model.coef_.tolist() if config.kind == "ridge" else None,
            "intercept": float(model.intercept_) if config.kind == "ridge" else None,
        }
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
            predictions[dates[index]] = {
                "modelId": model_id, "asOf": panel.dataset.calendar[index].decision_at,
                "horizon": config.horizon, "unit": "decimal-open-to-open-return",
                "values": dict(zip(np.array(panel.securities)[usable].tolist(), values.tolist())),
            }
    if not predictions:
        raise ValueError("no OOS predictions: insufficient visible training data or factor coverage")
    return {"folds": folds, "predictions": predictions, "labelConvention": "open(t+1+h)/open(t+1)-1"}


def prediction_diagnostics(predictions: dict, labels: pd.DataFrame) -> dict:
    daily = []
    squared_errors = []
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
    return {
        "role": "out-of-sample-diagnostic-only", "samples": len(squared_errors),
        "rmse": float(np.sqrt(np.mean(squared_errors))) if squared_errors else None,
        "meanRankIc": float(np.mean(rank_ics)) if rank_ics else None, "daily": daily,
    }
