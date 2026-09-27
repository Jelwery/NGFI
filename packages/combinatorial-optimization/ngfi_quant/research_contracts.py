from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_serializer, model_validator
from pydantic.alias_generators import to_camel

from .contracts import instrument_from_key, require_date, require_timestamp
from .hashing import stable_hash

Positive = Annotated[FiniteFloat, Field(gt=0)]
Nonnegative = Annotated[FiniteFloat, Field(ge=0)]
Fraction = Annotated[FiniteFloat, Field(ge=0, le=1)]
Identifier = Annotated[str, Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")]
SHANGHAI = ZoneInfo("Asia/Shanghai")


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
        return instrument_from_key(f"{self.market}:{self.exchange}:{self.symbol}:{self.asset_type}").key


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
        if any(instant(value).astimezone(SHANGHAI).date().isoformat() != self.date
               for value in (self.open_at, self.close_at, self.decision_at)):
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
    suspended: bool
    limit_rate: Annotated[FiniteFloat, Field(gt=0, lt=1)]
    lot_size: int = Field(ge=1, le=10000)
    status_available_at: str
    features: dict[Identifier, FeatureObservation] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid(self):
        require_date(self.date, "bar.date")
        instant(self.available_at)
        instant(self.status_available_at)
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close):
            raise ValueError("invalid OHLC envelope")
        if len(self.features) > 64:
            raise ValueError("at most 64 external PIT features are supported")
        return self


class ResearchBenchmarkPoint(Contract):
    date: str
    value: Positive
    available_at: str


class ResearchBenchmark(Contract):
    instrument: Literal["CN:SSE:000300:index", "CN:SSE:000906:index"]
    convention: Literal["price", "total-return"]
    source_hash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    points: list[ResearchBenchmarkPoint] = Field(min_length=2, max_length=10000)


class ReturnAttributionObservation(Contract):
    date: str
    previous_date: str
    weights_available_at: str
    factor_returns_available_at: str
    model_hash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    source_hash: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    return_convention: Literal["close-to-close-total-return"] = "close-to-close-total-return"
    benchmark_weights: dict[str, Fraction]
    exposures: dict[str, dict[str, FiniteFloat]]
    factor_kinds: dict[str, Literal["country", "industry", "style"]]
    factor_returns: dict[str, FiniteFloat]
    specific_returns: dict[str, FiniteFloat]
    industries: dict[str, str]

    @model_validator(mode="after")
    def valid(self):
        from .contracts import AttributionDay
        AttributionDay(self.date, self.weights_available_at, self.benchmark_weights, self.exposures,
                       self.factor_kinds, self.factor_returns, self.factor_returns_available_at)
        require_date(self.previous_date, "previousDate")
        if self.previous_date >= self.date or not self.factor_kinds:
            raise ValueError("return attribution requires a prior date and factors")
        if set(self.specific_returns) != set(self.exposures) or set(self.industries) != set(self.exposures):
            raise ValueError("specific returns and industries must cover exactly the exposure universe")
        if not set(self.benchmark_weights) <= set(self.exposures) or any(not name.strip() for name in self.industries.values()):
            raise ValueError("benchmark coverage or industry classification is missing")
        return self


class ResearchDataset(Contract):
    schema_version: Literal["2", "3"] = "2"
    snapshot_id: str = Field(min_length=1, max_length=160)
    as_of: str
    provenance: str = Field(min_length=1, max_length=2000)
    synthetic: bool
    price_basis: Literal["raw-no-corporate-actions"]
    universe_policy: Literal["historical-membership", "explicit-research-universe"]
    calendar: list[Session] = Field(min_length=4, max_length=10000)
    bars: list[ResearchBar] = Field(min_length=4, max_length=200000)
    cne6_models: list[dict] = Field(default_factory=list, max_length=1000)
    benchmark: ResearchBenchmark | None = None
    return_attribution: list[ReturnAttributionObservation] = Field(default_factory=list, max_length=10000)

    @model_serializer(mode="wrap")
    def serialize_version(self, handler):
        value = handler(self)
        if self.schema_version == "2":
            for key in ("benchmark", "returnAttribution", "return_attribution"):
                value.pop(key, None)
        return value

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
            if instant(bar.status_available_at) > cutoff:
                raise ValueError("status availability exceeds dataset asOf")
        if instant(self.calendar[-1].decision_at) > cutoff:
            raise ValueError("dataset asOf must cover all decision times")
        securities = {bar.instrument.key for bar in self.bars}
        if len(securities) > 500 or len(seen) != len(dates) * len(securities):
            raise ValueError("require a dense calendar/security panel (maximum 500 securities)")
        by_key = {(bar.date, bar.instrument.key): bar for bar in self.bars}
        for security in securities:
            for left, right in zip(dates, dates[1:]):
                if abs(by_key[right, security].previous_close - by_key[left, security].close) > 0.011:
                    raise ValueError("unexplained previousClose discontinuity; corporate actions are not supported")
        if self.schema_version == "2" and (self.benchmark is not None or self.return_attribution):
            raise ValueError("benchmark and returnAttribution require dataset schemaVersion 3")
        if self.return_attribution and self.benchmark is None:
            raise ValueError("return attribution requires an actual benchmark")
        benchmark_dates = set()
        for point in self.benchmark.points if self.benchmark else []:
            if point.date not in sessions or point.date in benchmark_dates:
                raise ValueError("duplicate or out-of-calendar benchmark point")
            benchmark_dates.add(point.date)
            if not instant(sessions[point.date].close_at) <= instant(point.available_at) <= cutoff:
                raise ValueError("benchmark availability is invalid")
        attribution_dates = set()
        for row in self.return_attribution:
            if row.date not in sessions or row.date in attribution_dates or dates.index(row.date) == 0 or dates[dates.index(row.date) - 1] != row.previous_date:
                raise ValueError("attribution requires unique adjacent trading dates")
            attribution_dates.add(row.date)
            if instant(row.weights_available_at) > instant(sessions[row.previous_date].decision_at):
                raise ValueError("attribution beginning exposures/weights are future-available")
            if not instant(sessions[row.date].close_at) <= instant(row.factor_returns_available_at) <= cutoff:
                raise ValueError("attribution factor return availability is invalid")
            if not set(row.exposures) <= securities:
                raise ValueError("attribution universe is outside the price panel")
        self.bars = sorted(self.bars, key=lambda row: (row.date, row.instrument.key))
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
    id: Identifier
    version: str = Field(default="1", pattern=r"^[0-9]+(?:\.[0-9]+){0,2}$")
    semantics_version: Literal["2", "3"] = "2"
    field_units: dict[str, Literal["price", "shares", "currency", "dimensionless"]] = Field(default_factory=dict)
    description: str = ""
    inputs: dict[Identifier, str] = Field(min_length=1, max_length=16)
    nodes: list[FactorNode] = Field(max_length=64)
    output: str
    transforms: list[FactorTransform] = Field(default_factory=list, max_length=4)

    @model_validator(mode="after")
    def valid_semantics(self):
        if self.semantics_version == "2" and self.field_units:
            raise ValueError("fieldUnits requires factor semanticsVersion 3")
        return self

    @model_serializer(mode="wrap")
    def serialize_version(self, handler):
        value = handler(self)
        if self.semantics_version == "2":
            for key in ("semanticsVersion", "fieldUnits", "semantics_version", "field_units"):
                value.pop(key, None)
        return value


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


class RiskPolicy(Contract):
    source: Literal["cne6", "ledoit-wolf"]
    max_age_days: Annotated[FiniteFloat, Field(ge=0, le=366)] = 5
    allow_warnings: bool = False
    allowed_proxy_flags: list[str] = Field(default_factory=list)
    min_coverage: Fraction = 1.0
    max_condition_number: Annotated[FiniteFloat, Field(ge=1)] = 1_000_000


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
    max_participation: Annotated[FiniteFloat, Field(gt=0, le=1)] = 0.05
    commission_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.0003
    minimum_commission: Nonnegative = 5.0
    stamp_duty_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.0005
    transfer_fee_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.00001
    slippage_rate: Annotated[FiniteFloat, Field(ge=0, lt=0.1)] = 0.0005


class ModelExplanationSpec(Contract):
    groups: dict[Identifier, list[Identifier]] = Field(min_length=1, max_length=16)
    methods: list[Literal["within-date-permutation", "training-mean-ablation"]] = Field(min_length=1, max_length=2)
    repeats: int = Field(default=3, ge=1, le=10)
    seed: int = Field(default=0, ge=0, le=2147483647)

    @model_validator(mode="after")
    def valid(self):
        names = [name for group in self.groups.values() for name in group]
        if not names or any(not group for group in self.groups.values()) or len(names) != len(set(names)):
            raise ValueError("explanation groups must be nonempty and disjoint")
        if len(self.methods) != len(set(self.methods)):
            raise ValueError("duplicate explanation methods")
        return self


class ResearchSpec(Contract):
    schema_version: Literal["2", "3"] = "2"
    purpose: Literal["research-diagnostic"] = "research-diagnostic"
    start_date: str
    end_date: str
    factors: list[FactorDefinition] = Field(min_length=1, max_length=32)
    model: ModelSpec = Field(default_factory=ModelSpec)
    risk: RiskPolicy
    optimizer: OptimizerSpec = Field(default_factory=OptimizerSpec)
    execution: ExecutionSpec = Field(default_factory=ExecutionSpec)
    model_explanation: ModelExplanationSpec | None = None
    training_start_date: str | None = None
    model_features: list[Identifier] | None = Field(default=None, min_length=1, max_length=32)

    @property
    def feature_names(self) -> list[str]:
        return self.model_features if self.model_features is not None else [factor.id for factor in self.factors]

    @model_serializer(mode="wrap")
    def serialize_version(self, handler):
        value = handler(self)
        if self.schema_version == "2":
            value.pop("modelExplanation", None)
            value.pop("model_explanation", None)
            value.pop("trainingStartDate", None)
            value.pop("training_start_date", None)
            value.pop("modelFeatures", None)
            value.pop("model_features", None)
        return value

    @model_validator(mode="after")
    def valid(self):
        require_date(self.start_date, "startDate")
        require_date(self.end_date, "endDate")
        if self.end_date < self.start_date:
            raise ValueError("endDate must not precede startDate")
        if len({item.id for item in self.factors}) != len(self.factors):
            raise ValueError("duplicate factor names")
        if self.model_features is not None:
            if self.schema_version != "3":
                raise ValueError("modelFeatures requires schemaVersion 3")
            if len(set(self.model_features)) != len(self.model_features) or not set(self.model_features) <= {factor.id for factor in self.factors}:
                raise ValueError("modelFeatures must contain unique declared factor names")
        if self.training_start_date is not None:
            require_date(self.training_start_date, "trainingStartDate")
            if self.schema_version != "3" or self.training_start_date >= self.start_date:
                raise ValueError("trainingStartDate requires v3 and must precede startDate")
        if self.model_explanation:
            if self.schema_version != "3":
                raise ValueError("modelExplanation requires spec schemaVersion 3")
            if not {name for group in self.model_explanation.groups.values() for name in group} <= set(self.feature_names):
                raise ValueError("explanation group contains unknown factors")
        from .execution import money
        if money(self.execution.initial_capital) != self.execution.initial_capital:
            raise ValueError("initialCapital must have cent precision")
        return self
