"""Independent registered diagnostics with disjoint, purged sample roles."""
from __future__ import annotations

from typing import Literal

import numpy as np
import pandas as pd
from pydantic import Field, model_validator

from ..contracts import require_date
from ..hashing import stable_hash
from ..research_contracts import Contract, FactorDefinition, ResearchDataset, ResearchSpec, instant
from .graph import build_panel, compute_factors, factor_diagnostics, forward_labels, factor_resource_estimate
from .registry import FIELD_UNITS, factor_card


class Partition(Contract):
    start: str
    end: str

    @model_validator(mode="after")
    def valid(self):
        require_date(self.start, "partition.start")
        require_date(self.end, "partition.end")
        if self.end < self.start:
            raise ValueError("partition end precedes start")
        return self


class StyleControlPlan(Contract):
    controls: list[str] = Field(default_factory=lambda: ["industry"], max_length=16)
    weighting: Literal["uniform", "sqrt-market-cap"] = "uniform"
    horizon: int = Field(default=5, ge=1, le=60)
    maximum_condition: float = Field(default=1_000_000, ge=1, le=1e12)

    @model_validator(mode="after")
    def valid_controls(self):
        if len(set(self.controls)) != len(self.controls):
            raise ValueError("duplicate controls")
        if any(control not in {"industry", "log-market-cap"} and not control.startswith("feature:") for control in self.controls):
            raise ValueError("controls must be PIT industry, log-market-cap or declared features")
        return self


class EvaluationRegistration(Contract):
    schema_version: Literal["3"] = "3"
    hypothesis: str = Field(min_length=1, max_length=2000)
    family_id: str | None = None
    factors: list[FactorDefinition] = Field(min_length=1, max_length=128)
    candidate_budget: int = Field(default=32, ge=1, le=128)
    train: Partition
    validation: Partition
    test: Partition
    horizons: list[int] = Field(default_factory=lambda: [5], min_length=1, max_length=4)
    embargo_sessions: int = Field(default=1, ge=0, le=60)
    minimum_coverage: float = Field(default=0.8, ge=0, le=1)
    minimum_rank_ic: float = Field(default=0, ge=-1, le=1)
    minimum_ic_days: int = Field(default=5, ge=2, le=10000)
    maximum_selected: int = Field(default=5, ge=1, le=32)
    duplicate_correlation: float = Field(default=0.98, gt=0, le=1)
    direction_rule: Literal["train-sign", "positive"] = "train-sign"
    seed: int = Field(default=0, ge=0, le=2147483647)
    style_controls: list[StyleControlPlan] = Field(default_factory=list, max_length=8)
    experiment_spec: ResearchSpec | None = None

    @model_validator(mode="after")
    def valid(self):
        if not self.train.end < self.validation.start or not self.validation.end < self.test.start:
            raise ValueError("train, validation and locked test must be disjoint and ordered")
        if len(self.factors) > self.candidate_budget:
            raise ValueError("registered candidate budget exceeded")
        if len({f.id for f in self.factors}) != len(self.factors):
            raise ValueError("duplicate factor aliases")
        if len(set(self.horizons)) != len(self.horizons) or any(type(h) is not int or not 1 <= h <= 60 for h in self.horizons):
            raise ValueError("horizons must be unique integers in [1, 60]")
        if self.experiment_spec:
            spec = self.experiment_spec
            definitions = {factor.id: factor.hash for factor in self.factors}
            if spec.schema_version != "3" or any(definitions.get(factor.id) != factor.hash for factor in spec.factors):
                raise ValueError("experimentSpec must use v3 and registered factor definitions")
            if not spec.training_start_date or spec.training_start_date < self.train.start or spec.training_start_date > self.train.end:
                raise ValueError("experimentSpec trainingStartDate must lie within registered train")
            if not self.test.start <= spec.start_date <= spec.end_date < self.test.end:
                raise ValueError("experimentSpec must fit within test, leaving a final execution session")
        return self


def validate_registration(dataset: ResearchDataset, registration: EvaluationRegistration) -> dict:
    dates = [session.date for session in dataset.calendar]
    for split in (registration.train, registration.validation, registration.test):
        if split.start not in dates or split.end not in dates:
            raise ValueError("partition bounds must be trading sessions")
        if dates.index(split.end) - dates.index(split.start) <= max(registration.horizons) + registration.embargo_sessions:
            raise ValueError("partition too short for label purge and embargo")
    resources = factor_resource_estimate(dataset, registration.factors)
    if registration.experiment_spec and dataset.schema_version != "3":
        raise ValueError("registered experimentSpec requires a v3 dataset")
    cards = {}
    for definition in registration.factors:
        if any(field not in FIELD_UNITS and not field.startswith(("factor:", "feature:")) for field in definition.inputs.values()):
            raise ValueError("unknown native factor input")
        cards[definition.id] = factor_card(definition, cards)
    return {"registration": registration.json(), "registrationId": registration.hash,
            "datasetId": dataset.hash, "factorVersions": [card["factorVersionId"] for card in cards.values()],
            "partition": {"market": "CN", "securities": sorted({bar.instrument.key for bar in dataset.bars}),
                          "start": registration.test.start, "end": registration.test.end,
                          "labelConvention": "open(t+1+h)/open(t+1)-1"},
            "estimatedCells": resources["outputCells"], "resources": resources,
            "trialCount": len(registration.factors) * len(registration.horizons),
            "promotionEligible": False}


def _diagnostics(panel, factors, registration, split):
    by_horizon = {}
    for horizon in registration.horizons:
        labels, boundaries = forward_labels(panel, horizon)
        cutoff_index = panel.dates.index(split.end) - registration.embargo_sessions
        cutoff = panel.dates[cutoff_index]
        as_of = panel.dataset.calendar[cutoff_index].decision_at
        for day in panel.dates:
            boundary = boundaries.get(day)
            if not split.start <= day <= split.end or not boundary or boundary[0] > cutoff or instant(boundary[1]) > instant(as_of):
                labels.loc[day] = np.nan
        metrics = factor_diagnostics(panel, factors, labels, split.start, split.end)
        for name, item in metrics.items():
            frame = factors[name].loc[split.start:split.end]
            eligible = panel.eligible.loc[split.start:split.end]
            item["role"] = "registered-partition-diagnostic"
            item["validIcDays"] = sum(row["rankIc"] is not None for row in item["daily"])
            item["constantDays"] = int((frame.nunique(axis=1) <= 1).sum())
            item["eligibleCells"] = int(eligible.to_numpy().sum())
            item["labelConvention"] = "open(t+1+h)/open(t+1)-1"
            item["inference"] = "descriptive; overlapping labels are not independent significance tests"
        by_horizon[str(horizon)] = metrics
    return by_horizon


def _similarity(factors, registration):
    names, pairs = list(factors), []
    for i, left in enumerate(names):
        for right in names[i + 1:]:
            pearson, spearman = [], []
            for day in factors[left].loc[registration.train.start:registration.train.end].index:
                pair = pd.concat([factors[left].loc[day], factors[right].loc[day]], axis=1).dropna()
                if len(pair) >= 3 and all(pair.iloc[:, j].nunique() > 1 for j in (0, 1)):
                    pearson.append(float(pair.iloc[:, 0].corr(pair.iloc[:, 1])))
                    spearman.append(float(pair.iloc[:, 0].rank().corr(pair.iloc[:, 1].rank())))
            pairs.append({"left": left, "right": right, "days": len(pearson),
                          "pearson": float(np.mean(pearson)) if pearson else None,
                          "spearman": float(np.mean(spearman)) if spearman else None})
    return pairs


def evaluate_factors(dataset: ResearchDataset, registration: EvaluationRegistration,
                     stage: str = "development", frozen: dict | None = None) -> dict:
    validated = validate_registration(dataset, registration)
    if stage not in {"development", "test"}:
        raise ValueError("unknown evaluation stage")
    if stage == "test":
        if not frozen or set(frozen) != {"registrationId", "datasetId", "selected", "directions"}:
            raise ValueError("locked test requires a frozen selection")
        if frozen["registrationId"] != registration.hash or frozen["datasetId"] != dataset.hash:
            raise ValueError("frozen selection identity mismatch")
        names = frozen["selected"]
        if not isinstance(names, list) or not names or len(names) > registration.maximum_selected or len(set(names)) != len(names):
            raise ValueError("invalid frozen selection")
        if not set(names) <= {f.id for f in registration.factors} or set(frozen["directions"]) != set(names):
            raise ValueError("frozen selection contains undeclared candidates")
        if any(type(v) not in (int, float) or v not in (-1, 1) for v in frozen["directions"].values()):
            raise ValueError("frozen direction must be -1 or 1")
    panel = build_panel(dataset)
    missing_fields = sorted({field for definition in registration.factors for field in definition.inputs.values()
                             if field.startswith("feature:") and field not in panel.fields})
    for field in missing_fields:
        panel.fields[field] = pd.DataFrame(np.nan, index=panel.dates, columns=panel.securities)
    factors = compute_factors(panel, registration.factors)
    identity = {"schemaVersion": "3", "registrationId": registration.hash, "datasetId": dataset.hash,
                "stage": stage, "synthetic": dataset.synthetic, "promotionEligible": False, "missingFields": missing_fields}
    if stage == "test":
        selected = {name: factors[name] * frozen["directions"][name] for name in frozen["selected"]}
        diagnostics = _diagnostics(panel, selected, registration, registration.test)
        complete = all(item["validIcDays"] >= registration.minimum_ic_days and item["coverage"] >= registration.minimum_coverage
                       for horizon in diagnostics.values() for item in horizon.values())
        return {**identity, "status": "complete" if complete else "partial", "selection": frozen,
                "diagnostics": diagnostics,
                "selectionHash": stable_hash(frozen), "testState": "consumed"}
    train = _diagnostics(panel, factors, registration, registration.train)
    validation = _diagnostics(panel, factors, registration, registration.validation)
    correlations = _similarity(factors, registration)
    primary = str(registration.horizons[0])
    directions, ranked, decisions = {}, [], {}
    for name in factors:
        training, valid = train[primary][name], validation[primary][name]
        direction = -1 if registration.direction_rule == "train-sign" and (training["meanRankIc"] or 0) < 0 else 1
        directions[name] = direction
        score = None if valid["meanRankIc"] is None else direction * valid["meanRankIc"]
        reasons = []
        if min(training["coverage"], valid["coverage"]) < registration.minimum_coverage:
            reasons.append("insufficient-coverage")
        if min(training["validIcDays"], valid["validIcDays"]) < registration.minimum_ic_days:
            reasons.append("insufficient-nonconstant-ic-days")
        if score is None or score < registration.minimum_rank_ic:
            reasons.append("validation-score-below-registered-minimum")
        decisions[name] = {"factor": name, "direction": direction, "validationScore": score,
                           "status": "blocked" if reasons else "eligible", "reasons": reasons}
        if not reasons:
            ranked.append((name, score))
    selected = []
    for name, score in sorted(ranked, key=lambda row: (-row[1], row[0])):
        duplicate = next((pair for pair in correlations if name in (pair["left"], pair["right"])
                          and (pair["right"] if pair["left"] == name else pair["left"]) in selected
                          and pair["days"] >= registration.minimum_ic_days
                          and pair["spearman"] is not None and abs(pair["spearman"]) >= registration.duplicate_correlation), None)
        if duplicate:
            decisions[name].update(status="rejected", reasons=["train-similarity"], duplicateEvidence=duplicate)
        elif len(selected) >= registration.maximum_selected:
            decisions[name].update(status="rejected", reasons=["selection-budget"])
        else:
            selected.append(name)
            decisions[name].update(status="selected")
    frozen = {"registrationId": registration.hash, "datasetId": dataset.hash,
              "selected": selected, "directions": {name: directions[name] for name in selected}}
    return {**identity, "status": "complete" if selected else "blocked", "train": train, "validation": validation,
            "correlations": correlations, "decisions": list(decisions.values()), "selection": frozen,
            "selectionHash": stable_hash(frozen), "testState": "unseen", "trialCount": validated["trialCount"],
            "portfolioIncrementStatus": "not-run; diagnostic scores and turnover proxies are not net portfolio returns"}
