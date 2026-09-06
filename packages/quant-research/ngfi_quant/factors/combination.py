"""Train-only factor-weight estimation and frozen test-period combination."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import math
from statistics import fmean
from typing import Literal, Sequence

from .analytics import _pearson, _ranks
from .contracts import FactorLineage, FactorSplit, FactorTable, FactorValue, ForwardReturn, split_factor_table


@dataclass(frozen=True)
class FactorWeights:
    method: Literal["equal", "ic", "minimum-correlation"]
    weights: tuple[tuple[str, float], ...]
    fitted_through: str
    train_sample_count: int
    train_coverage: float
    lineage: FactorLineage

    def __post_init__(self) -> None:
        if not self.weights:
            raise ValueError("factor weights must not be empty")
        if any(not math.isfinite(value) for _, value in self.weights):
            raise ValueError("factor weights must be finite")
        if abs(sum(value for _, value in self.weights) - 1) > 1e-10:
            raise ValueError("factor weights must sum to one")
        if not math.isfinite(self.train_coverage) or not 0 <= self.train_coverage <= 1:
            raise ValueError("train_coverage must be in [0, 1]")


def _normalize(raw: dict[str, float]) -> tuple[tuple[str, float], ...]:
    denominator = sum(raw.values())
    if abs(denominator) < 1e-12:
        raise ValueError("factor weight sum is zero")
    return tuple((factor, value / denominator) for factor, value in sorted(raw.items()))


def _aligned_factor_returns(table: FactorTable, forward: Sequence[ForwardReturn], horizon: int) -> dict[str, list[tuple[float, float]]]:
    target = {(row.factor_date, row.instrument.key, row.horizon): row.value for row in forward}
    result: dict[str, list[tuple[float, float]]] = {}
    for row in table.rows:
        outcome = target.get((row.date, row.instrument.key, horizon))
        if row.value is not None and outcome is not None:
            result.setdefault(row.factor, []).append((row.value, outcome))
    return result


def fit_factor_weights(
    table: FactorTable, forward: Sequence[ForwardReturn], *, split: FactorSplit, horizon: int,
    method: Literal["equal", "ic", "minimum-correlation"], lineage: FactorLineage,
) -> FactorWeights:
    train, _ = split_factor_table(table, split)
    factors = sorted({row.factor for row in train.rows})
    if not factors:
        raise ValueError("training factor table is empty")
    training_forward = [row for row in forward if split.train_start <= row.factor_date <= split.train_end]
    as_of = datetime.fromisoformat(split.as_of.replace("Z", "+00:00"))
    for row in training_forward:
        available_at = datetime.fromisoformat(row.available_at.replace("Z", "+00:00"))
        if available_at > as_of:
            raise ValueError(f"training outcome is future-available at split.as_of: {row.key}")
        if row.source_hash not in lineage.input_hashes:
            raise ValueError(f"training outcome source is absent from lineage: {row.key}")
    leaking = [row for row in training_forward if row.outcome_date > split.train_end]
    if leaking:
        raise ValueError(f"training outcome crosses train/test boundary: {leaking[0].key}")
    aligned = _aligned_factor_returns(train, training_forward, horizon)
    if method == "equal":
        raw = {factor: 1.0 for factor in factors}
        sample_count = len(train.rows)
    elif method == "ic":
        raw = {}
        sample_count = 0
        for factor in factors:
            pairs = aligned.get(factor, [])
            sample_count += len(pairs)
            correlation = _pearson([item[0] for item in pairs], [item[1] for item in pairs])
            raw[factor] = 0.0 if correlation is None else correlation
    elif method == "minimum-correlation":
        vectors = {
            factor: {(row.date, row.instrument.key): row.value for row in train.rows if row.factor == factor and row.value is not None}
            for factor in factors
        }
        raw = {}
        sample_count = len({key for vector in vectors.values() for key in vector})
        for factor in factors:
            correlations = []
            for other in factors:
                if other == factor:
                    continue
                keys = sorted(set(vectors[factor]) & set(vectors[other]))
                correlation = _pearson([vectors[factor][key] for key in keys], [vectors[other][key] for key in keys])
                if correlation is not None:
                    correlations.append(abs(correlation))
            raw[factor] = 1 / (1 + fmean(correlations)) if correlations else 1.0
    else:
        raise ValueError("unknown factor weighting method")
    usable = sum(row.value is not None for row in train.rows)
    coverage = usable / len(train.rows) if train.rows else 0
    return FactorWeights(method, _normalize(raw), split.train_end, sample_count, coverage, lineage)


def combine_test_factors(table: FactorTable, *, split: FactorSplit, weights: FactorWeights, lineage: FactorLineage) -> dict[str, object]:
    if weights.fitted_through > split.train_end:
        raise ValueError("factor weights were fitted beyond the declared training boundary")
    _, test = split_factor_table(table, split)
    weight_map = dict(weights.weights)
    expected = set(weight_map)
    grouped: dict[tuple[str, str], dict[str, float]] = {}
    for row in test.rows:
        if row.factor in expected and row.value is not None:
            grouped.setdefault((row.date, row.instrument.key), {})[row.factor] = row.value
    rows = []
    for (day, instrument), values in sorted(grouped.items()):
        available_weight = sum(weight_map[factor] for factor in values)
        if abs(available_weight) < 1e-12:
            score = None
            status = "insufficient"
        else:
            score = sum(weight_map[factor] * value for factor, value in values.items()) / available_weight
            status = "available"
        rows.append({"date": day, "instrument": instrument, "value": score, "status": status,
                     "sampleCount": len(values), "coverage": len(values) / len(expected)})
    return {"name": "factorCombination", "weights": weights, "rows": rows, "lineage": lineage}
