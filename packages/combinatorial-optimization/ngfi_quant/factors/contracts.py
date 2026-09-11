"""Long-table factor contracts with explicit point-in-time lineage."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import math
from typing import Any, Literal

from ..contracts import Instrument, require_date, require_hash, require_timestamp
from ..hashing import stable_hash


@dataclass(frozen=True)
class FactorValue:
    date: str
    instrument: Instrument
    factor: str
    value: float | None
    available_at: str
    source_hash: str
    industry: str | None = None
    market_cap: float | None = None

    def __post_init__(self) -> None:
        require_date(self.date, "factor.date")
        require_timestamp(self.available_at, "factor.available_at")
        require_hash(self.source_hash, "factor.source_hash")
        if not self.factor.strip():
            raise ValueError("factor name must be non-empty")
        if self.value is not None and (isinstance(self.value, bool) or not math.isfinite(self.value)):
            raise ValueError("factor value must be finite or null")
        if self.market_cap is not None and (
            isinstance(self.market_cap, bool) or not math.isfinite(self.market_cap) or self.market_cap <= 0
        ):
            raise ValueError("market_cap must be positive finite or null")
        if self.industry is not None and not self.industry.strip():
            raise ValueError("industry must be non-empty or null")

    @property
    def key(self) -> tuple[str, str, str]:
        return self.date, self.instrument.key, self.factor


@dataclass(frozen=True)
class PriceValue:
    date: str
    instrument: Instrument
    close: float | None
    available_at: str
    source_hash: str

    def __post_init__(self) -> None:
        require_date(self.date, "price.date")
        require_timestamp(self.available_at, "price.available_at")
        require_hash(self.source_hash, "price.source_hash")
        if self.close is not None and (
            isinstance(self.close, bool) or not math.isfinite(self.close) or self.close <= 0
        ):
            raise ValueError("price close must be positive finite or null")


@dataclass(frozen=True)
class ForwardReturn:
    factor_date: str
    outcome_date: str
    instrument: Instrument
    horizon: int
    value: float | None
    available_at: str
    source_hash: str

    def __post_init__(self) -> None:
        require_date(self.factor_date, "forward_return.factor_date")
        require_date(self.outcome_date, "forward_return.outcome_date")
        require_timestamp(self.available_at, "forward_return.available_at")
        require_hash(self.source_hash, "forward_return.source_hash")
        if self.outcome_date <= self.factor_date:
            raise ValueError("outcome_date must follow factor_date")
        if not isinstance(self.horizon, int) or isinstance(self.horizon, bool) or self.horizon < 1:
            raise ValueError("forward return horizon must be positive")
        if self.value is not None and (isinstance(self.value, bool) or not math.isfinite(self.value)):
            raise ValueError("forward return must be finite or null")

    @property
    def key(self) -> tuple[str, str, int]:
        return self.factor_date, self.instrument.key, self.horizon


@dataclass(frozen=True)
class FactorTable:
    rows: tuple[FactorValue, ...]

    def __post_init__(self) -> None:
        seen: set[tuple[str, str, str]] = set()
        for row in self.rows:
            if row.key in seen:
                raise ValueError(f"duplicate factor key: {row.key}")
            seen.add(row.key)

    @property
    def hash(self) -> str:
        return stable_hash([
            {
                "date": row.date, "instrument": row.instrument.key, "factor": row.factor, "value": row.value,
                "availableAt": row.available_at, "sourceHash": row.source_hash,
                "industry": row.industry, "marketCap": row.market_cap,
            }
            for row in sorted(self.rows, key=lambda item: item.key)
        ])


@dataclass(frozen=True)
class FactorSplit:
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    as_of: str

    def __post_init__(self) -> None:
        for label, value in (("train_start", self.train_start), ("train_end", self.train_end),
                             ("test_start", self.test_start), ("test_end", self.test_end)):
            require_date(value, label)
        require_timestamp(self.as_of, "split.as_of")
        if not self.train_start <= self.train_end < self.test_start <= self.test_end:
            raise ValueError("factor split requires a strict chronological train/test boundary")


@dataclass(frozen=True)
class FactorLineage:
    algorithm: str
    algorithm_version: str
    dataset_hash: str
    config_hash: str
    input_hashes: tuple[str, ...]
    split: FactorSplit
    created_at: str

    def __post_init__(self) -> None:
        if not self.algorithm or not self.algorithm_version:
            raise ValueError("lineage algorithm and version are required")
        require_hash(self.dataset_hash, "lineage.dataset_hash")
        require_hash(self.config_hash, "lineage.config_hash")
        if not self.input_hashes:
            raise ValueError("lineage input_hashes must not be empty")
        for item in self.input_hashes:
            require_hash(item, "lineage.input_hash")
        require_timestamp(self.created_at, "lineage.created_at")

    @property
    def hash(self) -> str:
        return stable_hash(self)


MetricStatus = Literal["available", "insufficient", "not-meaningful"]


@dataclass(frozen=True)
class FactorMetric:
    status: MetricStatus
    value: float | None
    sample_count: int
    coverage: float
    reason: str | None = None

    def __post_init__(self) -> None:
        if self.sample_count < 0:
            raise ValueError("sample_count must be nonnegative")
        if not math.isfinite(self.coverage) or not 0 <= self.coverage <= 1:
            raise ValueError("coverage must be in [0, 1]")
        if self.status == "available":
            if self.value is None or not math.isfinite(self.value) or self.reason is not None:
                raise ValueError("available metric must have a finite value and no reason")
        elif self.value is not None or not self.reason:
            raise ValueError("unavailable metric must have null value and a reason")


@dataclass(frozen=True)
class FactorMetricResult:
    name: str
    metrics: tuple[dict[str, Any], ...]
    lineage: FactorLineage


def make_lineage(
    *, algorithm: str, version: str, table: FactorTable, config: dict[str, Any], split: FactorSplit,
    created_at: str, additional_hashes: tuple[str, ...] = (),
) -> FactorLineage:
    as_of = datetime.fromisoformat(split.as_of.replace("Z", "+00:00"))
    for row in table.rows:
        available = datetime.fromisoformat(row.available_at.replace("Z", "+00:00"))
        if available > as_of:
            raise ValueError(f"factor row is future-available at split.as_of: {row.key}")
    return FactorLineage(
        algorithm, version, table.hash, stable_hash(config),
        tuple(sorted({*(row.source_hash for row in table.rows), *additional_hashes})), split, created_at,
    )


def split_factor_table(table: FactorTable, split: FactorSplit) -> tuple[FactorTable, FactorTable]:
    train = tuple(row for row in table.rows if split.train_start <= row.date <= split.train_end)
    test = tuple(row for row in table.rows if split.test_start <= row.date <= split.test_end)
    outside = [row.key for row in table.rows if row not in train and row not in test]
    if outside:
        raise ValueError(f"factor rows fall outside declared train/test ranges: {outside[0]}")
    return FactorTable(train), FactorTable(test)
