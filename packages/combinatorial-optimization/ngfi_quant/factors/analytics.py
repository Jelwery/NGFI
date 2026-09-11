"""Factor IC, portfolio sorting, turnover, coverage and correlation diagnostics."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import datetime
import math
from statistics import fmean, stdev
from typing import Any, Literal, Sequence

from ..hashing import stable_hash
from .contracts import FactorLineage, FactorMetric, FactorTable, ForwardReturn, PriceValue


def compute_forward_returns(
    prices: Sequence[PriceValue], *, horizon: int, lineage: FactorLineage,
) -> dict[str, Any]:
    if not isinstance(horizon, int) or isinstance(horizon, bool) or horizon < 1:
        raise ValueError("forward return horizon must be positive")
    seen: set[tuple[str, str]] = set()
    grouped: dict[str, list[PriceValue]] = defaultdict(list)
    as_of = datetime.fromisoformat(lineage.split.as_of.replace("Z", "+00:00"))
    for row in prices:
        key = row.date, row.instrument.key
        if key in seen:
            raise ValueError(f"duplicate price key: {key}")
        seen.add(key)
        available_at = datetime.fromisoformat(row.available_at.replace("Z", "+00:00"))
        if available_at > as_of:
            raise ValueError(f"price is future-available at split.as_of: {key}")
        grouped[row.instrument.key].append(row)
    output: list[ForwardReturn] = []
    eligible = 0
    available = 0
    for rows in grouped.values():
        ordered = sorted(rows, key=lambda row: row.date)
        for index, start in enumerate(ordered):
            target_index = index + horizon
            if target_index >= len(ordered):
                continue
            eligible += 1
            end = ordered[target_index]
            value = None if start.close is None or end.close is None else end.close / start.close - 1
            available += value is not None
            output.append(ForwardReturn(
                start.date, end.date, start.instrument, horizon, value, end.available_at,
                stable_hash({"start": start.source_hash, "end": end.source_hash, "horizon": horizon}),
            ))
    derived_lineage = replace(
        lineage,
        input_hashes=tuple(sorted({*lineage.input_hashes, *(row.source_hash for row in prices)})),
    )
    return {
        "name": "forwardReturns", "rows": tuple(output), "sampleCount": available,
        "coverage": available / eligible if eligible else 0, "lineage": derived_lineage,
    }


def _pearson(left: Sequence[float], right: Sequence[float]) -> float | None:
    if len(left) != len(right) or len(left) < 2:
        return None
    left_mean, right_mean = fmean(left), fmean(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    left_sum = sum((value - left_mean) ** 2 for value in left)
    right_sum = sum((value - right_mean) ** 2 for value in right)
    denominator = math.sqrt(left_sum * right_sum)
    return None if denominator == 0 else numerator / denominator


def _ranks(values: Sequence[float]) -> list[float]:
    indexed = sorted(enumerate(values), key=lambda item: (item[1], item[0]))
    ranks = [0.0] * len(values)
    cursor = 0
    while cursor < len(indexed):
        end = cursor + 1
        while end < len(indexed) and indexed[end][1] == indexed[cursor][1]:
            end += 1
        average_rank = (cursor + 1 + end) / 2
        for position in range(cursor, end):
            ranks[indexed[position][0]] = average_rank
        cursor = end
    return ranks


def _metric(value: float | None, samples: int, coverage: float, reason: str) -> FactorMetric:
    return FactorMetric("available", value, samples, coverage) if value is not None else FactorMetric(
        "not-meaningful" if samples >= 2 else "insufficient", None, samples, coverage, reason,
    )


def _forward_map(
    forward: Sequence[ForwardReturn], *, lineage: FactorLineage,
) -> dict[tuple[str, str, int], ForwardReturn]:
    result: dict[tuple[str, str, int], ForwardReturn] = {}
    as_of_time = datetime.fromisoformat(lineage.split.as_of.replace("Z", "+00:00"))
    for row in forward:
        if row.key in result:
            raise ValueError(f"duplicate forward return key: {row.key}")
        available_at = datetime.fromisoformat(row.available_at.replace("Z", "+00:00"))
        if available_at > as_of_time:
            raise ValueError(f"forward return is future-available at as_of: {row.key}")
        if row.source_hash not in lineage.input_hashes:
            raise ValueError(f"forward return source is absent from lineage: {row.key}")
        result[row.key] = row
    return result


def _assert_role(table: FactorTable, lineage: FactorLineage, role: Literal["train", "test"]) -> None:
    start, end = (
        (lineage.split.train_start, lineage.split.train_end)
        if role == "train"
        else (lineage.split.test_start, lineage.split.test_end)
    )
    outside = [row.key for row in table.rows if not start <= row.date <= end]
    if outside:
        raise ValueError(f"factor rows cross the declared {role} boundary: {outside[0]}")


def _assert_outcome_boundary(
    returns: dict[tuple[str, str, int], ForwardReturn], lineage: FactorLineage,
    role: Literal["train", "test"],
) -> None:
    end = lineage.split.train_end if role == "train" else lineage.split.test_end
    leaking = [row.key for row in returns.values() if row.outcome_date > end]
    if leaking:
        raise ValueError(f"forward outcome crosses the declared {role} boundary: {leaking[0]}")


def information_coefficient(
    table: FactorTable, forward: Sequence[ForwardReturn], *, horizon: int, method: Literal["pearson", "spearman"],
    lineage: FactorLineage, role: Literal["train", "test"],
) -> dict[str, Any]:
    if method not in ("pearson", "spearman"):
        raise ValueError("IC method must be pearson or spearman")
    _assert_role(table, lineage, role)
    returns = _forward_map(forward, lineage=lineage)
    _assert_outcome_boundary(returns, lineage, role)
    by_date_factor: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    expected: dict[tuple[str, str], int] = defaultdict(int)
    for row in table.rows:
        expected[(row.date, row.factor)] += 1
        target = returns.get((row.date, row.instrument.key, horizon))
        if row.value is not None and target is not None and target.value is not None:
            by_date_factor[(row.date, row.factor)].append((row.value, target.value))
    daily = []
    for key in sorted(expected):
        pairs = by_date_factor.get(key, [])
        left, right = [item[0] for item in pairs], [item[1] for item in pairs]
        if method == "spearman":
            left, right = _ranks(left), _ranks(right)
        correlation = _pearson(left, right)
        coverage = len(pairs) / expected[key]
        metric = _metric(correlation, len(pairs), coverage, "constant, empty, or undersized cross-section")
        daily.append({"date": key[0], "factor": key[1], "metric": metric})
    available = [item["metric"].value for item in daily if item["metric"].status == "available"]
    mean_ic = fmean(available) if available else None
    icir = None if len(available) < 2 or stdev(available) <= 1e-12 else mean_ic / stdev(available)
    return {
        "name": "rankIC" if method == "spearman" else "IC", "daily": daily,
        "mean": _metric(mean_ic, len(available), len(available) / len(daily) if daily else 0, "no available daily IC"),
        "icir": _metric(icir, len(available), len(available) / len(daily) if daily else 0, "ICIR needs at least two varying daily IC values"),
        "lineage": lineage,
    }


def grouped_returns(
    table: FactorTable, forward: Sequence[ForwardReturn], *, horizon: int, groups: int, lineage: FactorLineage,
    role: Literal["train", "test"],
) -> dict[str, Any]:
    if groups < 2:
        raise ValueError("groups must be at least two")
    _assert_role(table, lineage, role)
    returns = _forward_map(forward, lineage=lineage)
    _assert_outcome_boundary(returns, lineage, role)
    cross_sections: dict[tuple[str, str], list[tuple[str, float, float]]] = defaultdict(list)
    expected: dict[tuple[str, str], int] = defaultdict(int)
    for row in table.rows:
        expected[(row.date, row.factor)] += 1
        target = returns.get((row.date, row.instrument.key, horizon))
        if row.value is not None and target is not None and target.value is not None:
            cross_sections[(row.date, row.factor)].append((row.instrument.key, row.value, target.value))
    results = []
    for key in sorted(expected):
        rows = sorted(cross_sections.get(key, []), key=lambda item: (item[1], item[0]))
        if len(rows) < groups:
            results.append({"date": key[0], "factor": key[1], "groups": None, "longShort": None,
                            "sampleCount": len(rows), "coverage": len(rows) / expected[key], "status": "insufficient"})
            continue
        buckets: list[list[float]] = [[] for _ in range(groups)]
        for index, row in enumerate(rows):
            bucket = min(groups - 1, index * groups // len(rows))
            buckets[bucket].append(row[2])
        values = [fmean(bucket) if bucket else None for bucket in buckets]
        long_short = None if values[0] is None or values[-1] is None else values[-1] - values[0]
        results.append({"date": key[0], "factor": key[1], "groups": values, "longShort": long_short,
                        "sampleCount": len(rows), "coverage": len(rows) / expected[key], "status": "available"})
    return {"name": "groupedReturns", "periods": results, "lineage": lineage}


def factor_turnover(
    table: FactorTable, *, quantile_fraction: float = 0.2, lineage: FactorLineage,
    role: Literal["train", "test"],
) -> dict[str, Any]:
    if not 0 < quantile_fraction <= 0.5:
        raise ValueError("quantile_fraction must be in (0, 0.5]")
    _assert_role(table, lineage, role)
    by_factor_date: dict[tuple[str, str], list[tuple[str, float]]] = defaultdict(list)
    for row in table.rows:
        if row.value is not None:
            by_factor_date[(row.factor, row.date)].append((row.instrument.key, row.value))
    periods = []
    for factor in sorted({key[0] for key in by_factor_date}):
        previous: set[str] | None = None
        for _, day in sorted(key for key in by_factor_date if key[0] == factor):
            ranked = sorted(by_factor_date[(factor, day)], key=lambda item: (-item[1], item[0]))
            count = max(1, math.ceil(len(ranked) * quantile_fraction)) if ranked else 0
            current = {item[0] for item in ranked[:count]}
            value = None if previous is None or not previous else 1 - len(previous & current) / len(previous)
            periods.append({"date": day, "factor": factor, "value": value, "sampleCount": len(current),
                            "coverage": 1.0 if ranked else 0.0,
                            "status": "insufficient" if value is None else "available"})
            previous = current
    return {"name": "turnover", "periods": periods, "lineage": lineage}


def factor_coverage(
    table: FactorTable, *, lineage: FactorLineage, role: Literal["train", "test"],
) -> dict[str, Any]:
    _assert_role(table, lineage, role)
    periods = []
    grouped: dict[tuple[str, str], list[float | None]] = defaultdict(list)
    for row in table.rows:
        grouped[(row.date, row.factor)].append(row.value)
    for (day, factor), values in sorted(grouped.items()):
        available = sum(value is not None for value in values)
        periods.append({"date": day, "factor": factor, "value": available / len(values),
                        "sampleCount": available, "coverage": available / len(values), "status": "available"})
    return {"name": "coverage", "periods": periods, "lineage": lineage}


def correlation_matrix(
    table: FactorTable, *, method: Literal["pearson", "spearman"], lineage: FactorLineage,
    role: Literal["train", "test"],
) -> dict[str, Any]:
    if method not in ("pearson", "spearman"):
        raise ValueError("correlation method must be pearson or spearman")
    _assert_role(table, lineage, role)
    factors = sorted({row.factor for row in table.rows})
    values = {(row.date, row.instrument.key, row.factor): row.value for row in table.rows}
    observations = sorted({(row.date, row.instrument.key) for row in table.rows})
    matrix = []
    for left_factor in factors:
        row_results = []
        for right_factor in factors:
            pairs = [
                (values[(day, instrument, left_factor)], values[(day, instrument, right_factor)])
                for day, instrument in observations
                if (day, instrument, left_factor) in values and (day, instrument, right_factor) in values
                and values[(day, instrument, left_factor)] is not None and values[(day, instrument, right_factor)] is not None
            ]
            left, right = [item[0] for item in pairs], [item[1] for item in pairs]
            if method == "spearman":
                left, right = _ranks(left), _ranks(right)
            correlation = _pearson(left, right)  # type: ignore[arg-type]
            total = len(observations)
            row_results.append({"left": left_factor, "right": right_factor,
                                "metric": _metric(correlation, len(pairs), len(pairs) / total if total else 0,
                                                  "constant, empty, or undersized paired sample")})
        matrix.extend(row_results)
    return {"name": f"{method}Correlation", "factors": factors, "cells": matrix, "lineage": lineage}
