"""IS/OOS, nested walk-forward, cost stress and multiple-testing diagnostics."""

from __future__ import annotations

from dataclasses import dataclass, replace
from itertools import combinations
import math
from statistics import NormalDist, fmean, stdev
from typing import Any, Iterable, Sequence

from .contracts import BacktestRequest, BacktestResult, require_date
from .portfolio import run_research_backtest


@dataclass(frozen=True)
class CandidateReturn:
    date: str
    candidate_id: str
    value: float

    def __post_init__(self) -> None:
        require_date(self.date, "candidate return date")
        if not self.candidate_id:
            raise ValueError("candidate_id is required")
        if not math.isfinite(self.value):
            raise ValueError("candidate return must be finite")


@dataclass(frozen=True)
class DateFold:
    train_start: str
    train_end: str
    test_start: str
    test_end: str

    def __post_init__(self) -> None:
        for label, value in (("train_start", self.train_start), ("train_end", self.train_end),
                             ("test_start", self.test_start), ("test_end", self.test_end)):
            require_date(value, label)
        if not self.train_start <= self.train_end < self.test_start <= self.test_end:
            raise ValueError("fold requires a strict chronological train/test boundary")


@dataclass(frozen=True)
class NestedFold:
    outer: DateFold
    inner: tuple[DateFold, ...]

    def __post_init__(self) -> None:
        if not self.inner:
            raise ValueError("nested fold requires at least one inner fold")
        for fold in self.inner:
            if fold.train_start < self.outer.train_start or fold.test_end > self.outer.train_end:
                raise ValueError("inner folds must be contained entirely within outer training data")


def _means(rows: Iterable[CandidateReturn]) -> dict[str, float]:
    grouped: dict[str, list[float]] = {}
    for row in rows:
        grouped.setdefault(row.candidate_id, []).append(row.value)
    return {candidate: fmean(values) for candidate, values in grouped.items() if values}


def run_is_oos(rows: Sequence[CandidateReturn], fold: DateFold, minimum_test_samples: int = 1) -> dict[str, Any]:
    if minimum_test_samples < 1:
        raise ValueError("minimum_test_samples must be positive")
    train = [row for row in rows if fold.train_start <= row.date <= fold.train_end]
    test = [row for row in rows if fold.test_start <= row.date <= fold.test_end]
    train_scores = _means(train)
    if not train_scores:
        return {"status": "insufficient", "selectedCandidate": None, "reason": "empty training sample"}
    selected = min(train_scores, key=lambda candidate: (-train_scores[candidate], candidate))
    selected_test = [row.value for row in test if row.candidate_id == selected]
    if len(selected_test) < minimum_test_samples:
        return {
            "status": "insufficient", "selectedCandidate": selected, "trainScore": train_scores[selected],
            "testScore": None, "testSampleCount": len(selected_test), "reason": "insufficient frozen-candidate test sample",
        }
    return {
        "status": "available", "selectedCandidate": selected, "trainScore": train_scores[selected],
        "testScore": fmean(selected_test), "testSampleCount": len(selected_test),
        "trainRange": [fold.train_start, fold.train_end], "testRange": [fold.test_start, fold.test_end],
    }


def nested_walk_forward(
    rows: Sequence[CandidateReturn], folds: Sequence[NestedFold], minimum_outer_test_samples: int = 1,
) -> dict[str, Any]:
    if not folds:
        return {"status": "insufficient", "folds": [], "reason": "no walk-forward folds"}
    results: list[dict[str, Any]] = []
    for number, nested in enumerate(folds, 1):
        inner_results = [run_is_oos(rows, fold) for fold in nested.inner]
        eligible = [item for item in inner_results if item["status"] == "available"]
        if not eligible:
            results.append({"fold": number, "status": "insufficient", "reason": "inner selection is insufficient"})
            continue
        candidate_scores: dict[str, list[float]] = {}
        for item in eligible:
            candidate_scores.setdefault(item["selectedCandidate"], []).append(item["testScore"])
        selected = min(candidate_scores, key=lambda candidate: (-fmean(candidate_scores[candidate]), candidate))
        outer_test = [
            row.value for row in rows
            if nested.outer.test_start <= row.date <= nested.outer.test_end and row.candidate_id == selected
        ]
        if len(outer_test) < minimum_outer_test_samples:
            results.append({"fold": number, "status": "insufficient", "selectedCandidate": selected,
                            "testScore": None, "testSampleCount": len(outer_test)})
        else:
            results.append({"fold": number, "status": "available", "selectedCandidate": selected,
                            "testScore": fmean(outer_test), "testSampleCount": len(outer_test)})
    available = [item["testScore"] for item in results if item["status"] == "available"]
    return {
        "status": "available" if available else "insufficient", "folds": results,
        "meanOuterTestScore": fmean(available) if available else None, "availableFoldCount": len(available),
    }


def run_cost_stress(request: BacktestRequest, multipliers: Sequence[float]) -> tuple[BacktestResult, ...]:
    if not multipliers:
        raise ValueError("at least one cost multiplier is required")
    results = []
    for multiplier in multipliers:
        cost = request.cost_model.stressed(multiplier)
        results.append(run_research_backtest(replace(request, cost_model=cost)))
    return tuple(results)


def cscv_pbo(return_matrix: Sequence[Sequence[float]], partitions: int = 4) -> dict[str, Any]:
    if partitions < 2 or partitions % 2 != 0:
        raise ValueError("partitions must be an even integer of at least two")
    rows = [tuple(row) for row in return_matrix]
    if len(rows) < partitions or len(rows) % partitions != 0 or not rows:
        return {"status": "insufficient", "pbo": None, "splitCount": 0, "reason": "rows must divide into equal partitions"}
    width = len(rows[0])
    if width < 2 or any(len(row) != width for row in rows):
        return {"status": "insufficient", "pbo": None, "splitCount": 0, "reason": "at least two rectangular candidates are required"}
    if any(not math.isfinite(value) for row in rows for value in row):
        raise ValueError("CSCV returns must be finite")
    block = len(rows) // partitions
    partition_rows = [rows[index * block:(index + 1) * block] for index in range(partitions)]
    logits: list[float] = []
    for train_parts in combinations(range(partitions), partitions // 2):
        test_parts = tuple(index for index in range(partitions) if index not in train_parts)
        if train_parts > test_parts:
            continue
        train = [row for index in train_parts for row in partition_rows[index]]
        test = [row for index in test_parts for row in partition_rows[index]]
        train_scores = [fmean(row[column] for row in train) for column in range(width)]
        winner = min(range(width), key=lambda column: (-train_scores[column], column))
        test_scores = [fmean(row[column] for row in test) for column in range(width)]
        ascending = sorted(range(width), key=lambda column: (test_scores[column], column))
        rank = ascending.index(winner) + 1
        omega = rank / (width + 1)
        logits.append(math.log(omega / (1 - omega)))
    if not logits:
        return {"status": "insufficient", "pbo": None, "splitCount": 0, "reason": "no valid CSCV splits"}
    return {"status": "available", "pbo": sum(value <= 0 for value in logits) / len(logits),
            "splitCount": len(logits), "logits": logits}


def _moments(values: Sequence[float]) -> tuple[float, float, float, float]:
    if any(not math.isfinite(value) for value in values):
        raise ValueError("returns must be finite")
    mean = fmean(values)
    sigma = stdev(values)
    if sigma == 0:
        return mean, sigma, 0.0, 3.0
    centered = [(value - mean) / sigma for value in values]
    return mean, sigma, fmean(value ** 3 for value in centered), fmean(value ** 4 for value in centered)


def deflated_sharpe(returns: Sequence[float], trials: int, periods_per_year: int = 252) -> dict[str, Any]:
    if trials < 1 or periods_per_year < 1:
        raise ValueError("trials and periods_per_year must be positive")
    if len(returns) < 3:
        return {"status": "insufficient", "probability": None, "reason": "at least three returns are required"}
    mean, sigma, skewness, kurtosis = _moments(returns)
    if sigma == 0:
        return {"status": "not-meaningful", "probability": None, "reason": "return variance is zero"}
    observed_daily = mean / sigma
    observed = observed_daily * math.sqrt(periods_per_year)
    normal = NormalDist()
    euler_gamma = 0.5772156649015329
    if trials == 1:
        expected_max_daily = 0.0
    else:
        expected_max_daily = (1 - euler_gamma) * normal.inv_cdf(1 - 1 / trials) + euler_gamma * normal.inv_cdf(1 - 1 / (trials * math.e))
        expected_max_daily /= math.sqrt(len(returns))
    variance = (1 - skewness * observed_daily + ((kurtosis - 1) / 4) * observed_daily ** 2) / (len(returns) - 1)
    if variance <= 0:
        return {"status": "not-meaningful", "probability": None, "reason": "Sharpe variance estimate is non-positive"}
    statistic = (observed_daily - expected_max_daily) / math.sqrt(variance)
    return {
        "status": "available", "probability": normal.cdf(statistic), "observedSharpe": observed,
        "expectedMaximumSharpe": expected_max_daily * math.sqrt(periods_per_year), "sampleCount": len(returns),
        "trials": trials, "skewness": skewness, "kurtosis": kurtosis,
    }


def minimum_track_record(
    observed_sharpe: float, target_sharpe: float, confidence: float = 0.95,
    skewness: float = 0.0, kurtosis: float = 3.0,
) -> dict[str, Any]:
    for label, value in (("observed_sharpe", observed_sharpe), ("target_sharpe", target_sharpe),
                         ("skewness", skewness), ("kurtosis", kurtosis)):
        if not math.isfinite(value):
            raise ValueError(f"{label} must be finite")
    if not 0.5 < confidence < 1:
        raise ValueError("confidence must be between 0.5 and 1")
    difference = observed_sharpe - target_sharpe
    if difference <= 0:
        return {"status": "not-meaningful", "minimumObservations": None,
                "reason": "observed Sharpe must exceed target Sharpe"}
    adjustment = 1 - skewness * observed_sharpe + ((kurtosis - 1) / 4) * observed_sharpe ** 2
    if adjustment <= 0:
        return {"status": "not-meaningful", "minimumObservations": None,
                "reason": "moment adjustment is non-positive"}
    z_score = NormalDist().inv_cdf(confidence)
    observations = 1 + adjustment * (z_score / difference) ** 2
    return {"status": "available", "minimumObservations": math.ceil(observations), "confidence": confidence}
