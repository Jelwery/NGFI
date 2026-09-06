"""Deterministic cross-sectional factor preprocessing."""

from __future__ import annotations

from dataclasses import dataclass, replace
import math
from statistics import fmean, median, pstdev
from typing import Literal

from .contracts import FactorLineage, FactorTable, FactorValue


@dataclass(frozen=True)
class TransformDiagnostic:
    date: str
    factor: str
    status: Literal["available", "insufficient"]
    input_count: int
    output_count: int
    coverage: float
    reason: str | None = None


@dataclass(frozen=True)
class FactorTransformResult:
    table: FactorTable
    diagnostics: tuple[TransformDiagnostic, ...]
    lineage: FactorLineage


def _groups(table: FactorTable) -> list[tuple[tuple[str, str], list[FactorValue]]]:
    grouped: dict[tuple[str, str], list[FactorValue]] = {}
    for row in table.rows:
        grouped.setdefault((row.date, row.factor), []).append(row)
    return [(key, sorted(rows, key=lambda item: item.instrument.key)) for key, rows in sorted(grouped.items())]


def _quantile(values: list[float], probability: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    location = (len(ordered) - 1) * probability
    lower = math.floor(location)
    upper = math.ceil(location)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (location - lower)


def winsorize(table: FactorTable, *, lineage: FactorLineage, lower: float = 0.01, upper: float = 0.99) -> FactorTransformResult:
    if not 0 <= lower < upper <= 1:
        raise ValueError("winsor limits must satisfy 0 <= lower < upper <= 1")
    output: list[FactorValue] = []
    diagnostics: list[TransformDiagnostic] = []
    for (day, factor), rows in _groups(table):
        values = [row.value for row in rows if row.value is not None]
        if not values:
            output.extend(rows)
            diagnostics.append(TransformDiagnostic(day, factor, "insufficient", len(rows), 0, 0, "cross-section is empty"))
            continue
        floor, ceiling = _quantile(values, lower), _quantile(values, upper)
        output.extend(replace(row, value=None if row.value is None else min(ceiling, max(floor, row.value))) for row in rows)
        diagnostics.append(TransformDiagnostic(day, factor, "available", len(rows), len(values), len(values) / len(rows)))
    return FactorTransformResult(FactorTable(tuple(output)), tuple(diagnostics), lineage)


def standardize(table: FactorTable, *, lineage: FactorLineage) -> FactorTransformResult:
    output: list[FactorValue] = []
    diagnostics: list[TransformDiagnostic] = []
    for (day, factor), rows in _groups(table):
        values = [row.value for row in rows if row.value is not None]
        deviation = pstdev(values) if len(values) >= 2 else 0.0
        if len(values) < 2 or deviation == 0:
            output.extend(replace(row, value=None) for row in rows)
            diagnostics.append(TransformDiagnostic(day, factor, "insufficient", len(rows), 0, 0, "constant or undersized cross-section"))
            continue
        center = fmean(values)
        output.extend(replace(row, value=None if row.value is None else (row.value - center) / deviation) for row in rows)
        diagnostics.append(TransformDiagnostic(day, factor, "available", len(rows), len(values), len(values) / len(rows)))
    return FactorTransformResult(FactorTable(tuple(output)), tuple(diagnostics), lineage)


def handle_missing(
    table: FactorTable, *, lineage: FactorLineage, method: Literal["keep", "drop", "median"] = "keep",
) -> FactorTransformResult:
    if method not in ("keep", "drop", "median"):
        raise ValueError("unknown missing-value method")
    output: list[FactorValue] = []
    diagnostics: list[TransformDiagnostic] = []
    for (day, factor), rows in _groups(table):
        values = [row.value for row in rows if row.value is not None]
        if method == "drop":
            transformed = [row for row in rows if row.value is not None]
        elif method == "median" and values:
            fill = median(values)
            transformed = [replace(row, value=fill if row.value is None else row.value) for row in rows]
        else:
            transformed = rows
        output.extend(transformed)
        available = sum(row.value is not None for row in transformed)
        status = "available" if available else "insufficient"
        reason = None if available else "cross-section is entirely missing"
        diagnostics.append(TransformDiagnostic(day, factor, status, len(rows), available, available / len(rows), reason))
    return FactorTransformResult(FactorTable(tuple(output)), tuple(diagnostics), lineage)


def _solve(matrix: list[list[float]], vector: list[float]) -> list[float] | None:
    size = len(vector)
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            return None
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            scale = augmented[row][column]
            augmented[row] = [left - scale * right for left, right in zip(augmented[row], augmented[column])]
    return [augmented[index][-1] for index in range(size)]


def neutralize(
    table: FactorTable, *, lineage: FactorLineage, industry: bool = True, market_cap: bool = True,
) -> FactorTransformResult:
    if not industry and not market_cap:
        raise ValueError("at least one neutralization exposure is required")
    output: list[FactorValue] = []
    diagnostics: list[TransformDiagnostic] = []
    for (day, factor), rows in _groups(table):
        usable = [row for row in rows if row.value is not None]
        industries = sorted({row.industry for row in usable if row.industry is not None})
        valid = [row for row in usable if (not industry or row.industry is not None) and (not market_cap or row.market_cap is not None)]
        feature_count = 1 + (max(0, len(industries) - 1) if industry else 0) + (1 if market_cap else 0)
        if len(valid) <= feature_count:
            output.extend(replace(row, value=None) for row in rows)
            diagnostics.append(TransformDiagnostic(day, factor, "insufficient", len(rows), 0, 0, "insufficient complete exposures"))
            continue
        baseline = industries[0] if industries else None
        design: list[list[float]] = []
        target: list[float] = []
        valid_keys = {row.key for row in valid}
        for row in valid:
            features = [1.0]
            if industry:
                features.extend(1.0 if row.industry == name else 0.0 for name in industries if name != baseline)
            if market_cap:
                features.append(math.log(row.market_cap))  # type: ignore[arg-type]
            design.append(features)
            target.append(row.value)  # type: ignore[arg-type]
        xtx = [[sum(left[col] * left[row] for left in design) for row in range(feature_count)] for col in range(feature_count)]
        xty = [sum(left[col] * value for left, value in zip(design, target)) for col in range(feature_count)]
        coefficients = _solve(xtx, xty)
        if coefficients is None:
            output.extend(replace(row, value=None) for row in rows)
            diagnostics.append(TransformDiagnostic(day, factor, "insufficient", len(rows), 0, 0, "neutralization design is singular"))
            continue
        residuals: dict[tuple[str, str, str], float] = {}
        for row, features, value in zip(valid, design, target):
            residuals[row.key] = value - sum(coefficient * feature for coefficient, feature in zip(coefficients, features))
        output.extend(replace(row, value=residuals.get(row.key)) for row in rows)
        diagnostics.append(TransformDiagnostic(day, factor, "available", len(rows), len(valid), len(valid) / len(rows)))
    return FactorTransformResult(FactorTable(tuple(output)), tuple(diagnostics), lineage)
