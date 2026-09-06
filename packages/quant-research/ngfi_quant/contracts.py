"""Frozen, provider-neutral inputs for research-grade portfolio accounting."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, datetime
import math
import re
from typing import Any, Literal

from .hashing import stable_hash

HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


def require_hash(value: str, label: str) -> None:
    if not HASH_PATTERN.fullmatch(value):
        raise ValueError(f"{label} must be a sha256 hash")


def require_date(value: str, label: str) -> None:
    try:
        parsed = date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be an ISO date") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{label} must be an ISO date")


def require_timestamp(value: str, label: str) -> None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone")


def require_finite(value: float, label: str, *, positive: bool = False, nonnegative: bool = False) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be finite")
    if positive and value <= 0:
        raise ValueError(f"{label} must be positive")
    if nonnegative and value < 0:
        raise ValueError(f"{label} must be nonnegative")


@dataclass(frozen=True, order=True)
class Instrument:
    market: str
    exchange: str
    symbol: str
    asset_type: str = "equity"

    def __post_init__(self) -> None:
        if not all(isinstance(item, str) and item.strip() for item in (self.market, self.exchange, self.symbol, self.asset_type)):
            raise ValueError("instrument fields must be non-empty strings")

    @property
    def key(self) -> str:
        return f"{self.market}:{self.exchange}:{self.symbol}:{self.asset_type}"

    def to_contract(self) -> dict[str, str]:
        return {"market": self.market, "exchange": self.exchange, "symbol": self.symbol, "assetType": self.asset_type}


@dataclass(frozen=True)
class AShareBar:
    date: str
    instrument: Instrument
    available_at: str
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    previous_close: float | None
    suspended: bool = False
    limit_rate: float = 0.10

    def __post_init__(self) -> None:
        require_date(self.date, "bar.date")
        require_timestamp(self.available_at, "bar.available_at")
        for label, value in (("open", self.open), ("high", self.high), ("low", self.low),
                             ("close", self.close), ("previous_close", self.previous_close)):
            if value is not None:
                require_finite(value, f"bar.{label}", positive=True)
        require_finite(self.limit_rate, "bar.limit_rate", positive=True)
        if self.limit_rate >= 1:
            raise ValueError("bar.limit_rate must be below one")
        if self.high is not None and self.low is not None and self.high < self.low:
            raise ValueError("bar high must not be below low")
        for label, value in (("open", self.open), ("close", self.close)):
            if value is not None and self.high is not None and value > self.high:
                raise ValueError(f"bar {label} must not exceed high")
            if value is not None and self.low is not None and value < self.low:
                raise ValueError(f"bar {label} must not be below low")


@dataclass(frozen=True)
class CandidateSignal:
    observation_id: str
    instrument: Instrument
    signal_date: str

    def __post_init__(self) -> None:
        require_hash(self.observation_id, "observation_id")
        require_date(self.signal_date, "signal_date")


@dataclass(frozen=True)
class AShareCostModel:
    id: str = "cn-equity-standard"
    version: str = "1.0.0"
    commission_rate: float = 0.0003
    minimum_commission: float = 5.0
    stamp_duty_rate: float = 0.0005
    transfer_fee_rate: float = 0.00001
    slippage_rate: float = 0.0

    def __post_init__(self) -> None:
        if not self.id or not self.version:
            raise ValueError("cost model id and version are required")
        for label, value in self.parameters().items():
            require_finite(value, f"cost.{label}", nonnegative=True)
        if self.commission_rate >= 1 or self.stamp_duty_rate >= 1 or self.transfer_fee_rate >= 1 or self.slippage_rate >= 1:
            raise ValueError("cost rates must be below one")

    def parameters(self) -> dict[str, float]:
        return {
            "commissionRate": self.commission_rate, "minimumCommission": self.minimum_commission,
            "stampDutyRate": self.stamp_duty_rate, "transferFeeRate": self.transfer_fee_rate,
            "slippageRate": self.slippage_rate,
        }

    @property
    def hash(self) -> str:
        return stable_hash({"id": self.id, "version": self.version, "parameters": self.parameters()})

    def stressed(self, multiplier: float) -> "AShareCostModel":
        require_finite(multiplier, "cost multiplier", positive=True)
        return replace(
            self, id=f"{self.id}-stress-{multiplier:g}x",
            commission_rate=self.commission_rate * multiplier, minimum_commission=self.minimum_commission * multiplier,
            stamp_duty_rate=self.stamp_duty_rate * multiplier, transfer_fee_rate=self.transfer_fee_rate * multiplier,
            slippage_rate=self.slippage_rate * multiplier,
        )


@dataclass(frozen=True)
class PortfolioConfig:
    initial_capital: float
    max_positions: int
    allocation_fraction: float
    holding_days: int
    lot_size: int = 100

    def __post_init__(self) -> None:
        require_finite(self.initial_capital, "initial_capital", positive=True)
        require_finite(self.allocation_fraction, "allocation_fraction", positive=True)
        if self.allocation_fraction > 1:
            raise ValueError("allocation_fraction must not exceed one")
        if not isinstance(self.max_positions, int) or isinstance(self.max_positions, bool) or self.max_positions < 1:
            raise ValueError("max_positions must be a positive integer")
        if not isinstance(self.holding_days, int) or isinstance(self.holding_days, bool) or self.holding_days < 1:
            raise ValueError("holding_days must be a positive integer")
        if not isinstance(self.lot_size, int) or isinstance(self.lot_size, bool) or self.lot_size < 1:
            raise ValueError("lot_size must be a positive integer")

    @property
    def hash(self) -> str:
        return stable_hash({
            "initialCapital": self.initial_capital, "maxPositions": self.max_positions,
            "allocationFraction": self.allocation_fraction, "holdingDays": self.holding_days, "lotSize": self.lot_size,
        })


@dataclass(frozen=True)
class BacktestMetadata:
    dataset_snapshot_id: str
    dataset_hash: str
    dataset_as_of: str
    strategy_hash: str
    config_hash: str
    execution_hash: str
    benchmark_instrument: Instrument | None
    benchmark_dataset_hash: str | None
    started_at: str
    completed_at: str
    engine_version: str = "1.0.0"

    def __post_init__(self) -> None:
        if not self.dataset_snapshot_id:
            raise ValueError("dataset_snapshot_id is required")
        for label, value in (("dataset_hash", self.dataset_hash), ("strategy_hash", self.strategy_hash),
                             ("config_hash", self.config_hash), ("execution_hash", self.execution_hash)):
            require_hash(value, label)
        require_timestamp(self.dataset_as_of, "dataset_as_of")
        require_timestamp(self.started_at, "started_at")
        require_timestamp(self.completed_at, "completed_at")
        if datetime.fromisoformat(self.completed_at.replace("Z", "+00:00")) < datetime.fromisoformat(self.started_at.replace("Z", "+00:00")):
            raise ValueError("completed_at must not precede started_at")
        if (self.benchmark_instrument is None) != (self.benchmark_dataset_hash is None):
            raise ValueError("benchmark instrument and dataset hash must be supplied together")
        if self.benchmark_dataset_hash is not None:
            require_hash(self.benchmark_dataset_hash, "benchmark_dataset_hash")


@dataclass(frozen=True)
class BacktestRequest:
    calendar: tuple[str, ...]
    bars: tuple[AShareBar, ...]
    signals: tuple[CandidateSignal, ...]
    cost_model: AShareCostModel
    portfolio: PortfolioConfig
    metadata: BacktestMetadata
    artifact_prefix: str = "memory:quant-research"


RejectionReason = Literal[
    "no-next-trading-day", "missing-bar", "suspended", "limit-up", "limit-down",
    "missing-price", "overlapping-position", "position-capacity", "insufficient-cash", "dataset-ended",
]


@dataclass(frozen=True)
class Rejection:
    observation_id: str
    instrument: Instrument
    date: str | None
    side: Literal["buy", "sell"]
    reason: RejectionReason


@dataclass(frozen=True)
class Trade:
    observation_id: str
    instrument: Instrument
    entry_date: str
    exit_date: str
    shares: int
    entry_price: float
    exit_price: float
    entry_cost: float
    exit_cost: float
    pnl: float
    return_ratio: float


@dataclass(frozen=True)
class EquityPoint:
    date: str
    value: float | None
    status: Literal["available", "missing"]
    reason: str | None = None


@dataclass(frozen=True)
class BacktestResult:
    run: dict[str, Any]
    trades: tuple[Trade, ...]
    rejections: tuple[Rejection, ...]
    equity: tuple[EquityPoint, ...]
    final_cash: float
    open_positions: tuple[str, ...]
