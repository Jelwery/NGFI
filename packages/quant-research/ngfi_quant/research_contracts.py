"""Validated, JSON-only contracts for the daily cross-sectional research pipeline."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, TypeAlias
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator
from pydantic.alias_generators import to_camel

from .contracts import Instrument, require_date, require_timestamp
from .hashing import stable_hash

Positive: TypeAlias = Annotated[FiniteFloat, Field(gt=0)]
Nonnegative: TypeAlias = Annotated[FiniteFloat, Field(ge=0)]
Fraction: TypeAlias = Annotated[FiniteFloat, Field(ge=0, le=1)]
Identifier: TypeAlias = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")]
SHANGHAI_TIMEZONE = ZoneInfo("Asia/Shanghai")


def instant(value: str) -> datetime:
    require_timestamp(value, "timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True, strict=True)

    def json(self) -> dict:
        return self.model_dump(mode="json", by_alias=True)

    @property
    def hash(self) -> str:
        return stable_hash(self.json())


class Security(Contract):
    market: Literal["CN"]
    exchange: Literal["SSE", "SZSE", "BSE"]
    symbol: str = Field(pattern=r"^[0-9]{6}$")
    asset_type: Literal["equity"] = "equity"

    @property
    def key(self) -> str:
        return Instrument(self.market, self.exchange, self.symbol, self.asset_type).key


class Session(Contract):
    date: str
    open_at: str
    close_at: str
    decision_at: str

    @model_validator(mode="after")
    def valid(self):
        require_date(self.date, "session.date")
        if not instant(self.open_at) < instant(self.close_at) <= instant(self.decision_at):
            raise ValueError("session requires openAt < closeAt <= decisionAt")
        if not all(
            instant(value).astimezone(SHANGHAI_TIMEZONE).date().isoformat() == self.date
            for value in (self.open_at, self.close_at, self.decision_at)
        ):
            raise ValueError("session timestamps must use the Shanghai business date")
        return self


class FeatureObservation(Contract):
    value: FiniteFloat | None
    available_at: str
    source_hash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")

    @model_validator(mode="after")
    def valid(self):
        instant(self.available_at)
        return self


class ResearchBar(Contract):
    date: str
    instrument: Security
    available_at: str
    open: Positive
    high: Positive
    low: Positive
    close: Positive
    previous_close: Positive
    volume: Nonnegative
    amount: Nonnegative
    eligible: bool
    industry: str = Field(min_length=1, max_length=100)
    suspended: bool = False
    limit_rate: Annotated[FiniteFloat, Field(gt=0, lt=1)] = 0.1
    features: dict[Identifier, FeatureObservation] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid(self):
        require_date(self.date, "bar.date")
        instant(self.available_at)
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close):
            raise ValueError("invalid OHLC envelope")
        if len(self.features) > 64:
            raise ValueError("at most 64 external PIT features are supported")
        return self


class ResearchDataset(Contract):
    schema_version: Literal["1"] = "1"
    snapshot_id: str = Field(min_length=1, max_length=160)
    as_of: str
    provenance: str = Field(min_length=1, max_length=2000)
    # This first engine rejects adjustment discontinuities instead of inventing cash actions.
    price_basis: Literal["raw-no-corporate-actions"]
    universe_policy: Literal["historical-membership", "explicit-research-universe"]
    calendar: list[Session] = Field(min_length=4, max_length=10000)
    bars: list[ResearchBar] = Field(min_length=4, max_length=200000)
    cne6_models: list[dict] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def valid(self):
        cutoff = instant(self.as_of)
        sessions = {day.date: day for day in self.calendar}
        dates = [day.date for day in self.calendar]
        if dates != sorted(set(dates)):
            raise ValueError("calendar must be strictly ordered without duplicates")
        for left, right in zip(self.calendar, self.calendar[1:]):
            if instant(left.decision_at) >= instant(right.open_at):
                raise ValueError("decisions must precede the next trading open")
        seen = set()
        for bar in self.bars:
            key = (bar.date, bar.instrument.key)
            if key in seen or bar.date not in sessions:
                raise ValueError("duplicate bar or date outside calendar")
            seen.add(key)
            if not instant(sessions[bar.date].close_at) <= instant(bar.available_at) <= cutoff:
                raise ValueError("bar availability must follow its close and precede dataset asOf")
        if instant(self.calendar[-1].decision_at) > cutoff:
            raise ValueError("dataset asOf must cover all decision times")
        securities = {bar.instrument.key for bar in self.bars}
        if len(securities) > 500 or len(seen) != len(dates) * len(securities):
            raise ValueError("require a dense calendar/security panel (maximum 500 securities); never skip missing sessions")
        by_key = {(bar.date, bar.instrument.key): bar for bar in self.bars}
        for security in securities:
            for left, right in zip(dates, dates[1:]):
                previous, current = by_key[left, security], by_key[right, security]
                if abs(current.previous_close - previous.close) > 0.011:
                    raise ValueError("unexplained previousClose discontinuity; corporate actions are not supported")
        self.bars.sort(key=lambda row: (row.date, row.instrument.key))
        return self


class FactorNode(Contract):
    id: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
    op: str
    inputs: list[str] = Field(max_length=3)
    params: dict[str, FiniteFloat | str | bool] = Field(default_factory=dict)


class FactorTransform(Contract):
    op: Literal["WINSORIZE", "ZSCORE", "RANK", "INDUSTRY_NEUTRALIZE"]
    params: dict[str, FiniteFloat | str | bool] = Field(default_factory=dict)


class FactorDefinition(Contract):
    """Versioned NGFI factor graph; inputs bind aliases to market/feature/factor fields."""

    id: Identifier
    version: str = Field(default="1", pattern=r"^[0-9]+(?:\.[0-9]+){0,2}$")
    description: str = ""
    inputs: dict[Identifier, str] = Field(min_length=1, max_length=16)
    nodes: list[FactorNode] = Field(max_length=64)
    output: str
    transforms: list[FactorTransform] = Field(default_factory=list, max_length=4)


class ModelSpec(Contract):
    kind: Literal["ridge", "hist-gradient-boosting"] = "ridge"
    train_sessions: int = Field(default=120, ge=10, le=2500)
    refit_every: int = Field(default=20, ge=1, le=252)
    horizon: int = Field(default=5, ge=1, le=60)
    embargo_sessions: int = Field(default=1, ge=0, le=60)
    minimum_samples: int = Field(default=60, ge=10, le=200000)
    ridge_alpha: Positive = 1.0
    max_iter: int = Field(default=80, ge=1, le=300)
    max_leaf_nodes: int = Field(default=15, ge=2, le=63)
    learning_rate: Annotated[FiniteFloat, Field(gt=0, le=1)] = 0.05
    clip_quantile: Annotated[FiniteFloat, Field(ge=0, lt=0.5)] = 0.01
    seed: int = Field(default=0, ge=0, le=2147483647)


class OptimizerSpec(Contract):
    method: Literal["mean-variance", "top-k"] = "mean-variance"
    top_k: int = Field(default=20, ge=1, le=500)
    max_weight: Annotated[FiniteFloat, Field(gt=0, le=1)] = 0.1
    cash_reserve: Annotated[FiniteFloat, Field(ge=0, lt=1)] = 0.02
    risk_aversion: Positive = 5.0
    turnover_penalty: Nonnegative = 0.001
    max_turnover: Annotated[FiniteFloat, Field(gt=0, le=2)] = 2.0
    risk_lookback: int = Field(default=60, ge=5, le=1000)
    industry_caps: dict[str, Fraction] = Field(default_factory=dict)


class ExecutionSpec(Contract):
    initial_capital: Positive = 1_000_000.0
    rebalance_every: int = Field(default=5, ge=1, le=252)
    lot_size: int = Field(default=100, ge=1, le=1000)
    max_participation: Annotated[FiniteFloat, Field(gt=0, le=1)] = 0.05
    commission_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.0003
    minimum_commission: Nonnegative = 5.0
    stamp_duty_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.0005
    transfer_fee_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.00001
    slippage_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.0005


class ResearchSpec(Contract):
    schema_version: Literal["1"] = "1"
    start_date: str
    end_date: str
    factors: list[FactorDefinition] = Field(min_length=1, max_length=32)
    model: ModelSpec = Field(default_factory=ModelSpec)
    optimizer: OptimizerSpec = Field(default_factory=OptimizerSpec)
    execution: ExecutionSpec = Field(default_factory=ExecutionSpec)

    @model_validator(mode="after")
    def valid(self):
        require_date(self.start_date, "startDate")
        require_date(self.end_date, "endDate")
        if self.end_date < self.start_date:
            raise ValueError("endDate must not precede startDate")
        names = [item.id for item in self.factors]
        if len(set(names)) != len(names):
            raise ValueError("duplicate factor names")
        return self
