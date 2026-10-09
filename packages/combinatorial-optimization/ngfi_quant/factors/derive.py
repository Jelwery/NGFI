"""Finite, deterministic generators. Every proposal, including duplicates, is counted."""
from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator

from ..hashing import stable_hash
from ..research_contracts import Contract, FactorDefinition, Identifier
from .registry import FIELD_UNITS, factor_card


class Mutation(Contract):
    kind: Literal["window", "aggregate", "input", "neutralize", "interaction"]
    node: str | None = None
    window: int = Field(default=5, ge=1, le=1000)
    operator: Literal["SMA", "DECAY_LINEAR", "DELTA"] = "SMA"
    input_name: str | None = None
    field: str | None = None
    other: Identifier | None = None


class DerivationRequest(Contract):
    schema_version: Literal["3"] = "3"
    generator: Literal["reversal-volume-v1", "mutations-v1"]
    hypothesis: str = Field(min_length=1, max_length=2000)
    evidence_refs: list[str] = Field(default_factory=list, max_length=32)
    budget: int = Field(default=32, ge=1, le=128)
    parents: list[FactorDefinition] = Field(default_factory=list, max_length=32)
    parent: Identifier | None = None
    mutations: list[Mutation] = Field(default_factory=list, max_length=128)

    @model_validator(mode="after")
    def valid(self):
        if self.generator == "reversal-volume-v1" and (self.parents or self.parent or self.mutations):
            raise ValueError("pilot generator has fixed definitions")
        if self.generator == "mutations-v1" and (not self.parents or not self.mutations or self.parent not in {p.id for p in self.parents}):
            raise ValueError("mutations require parents and a declared parent")
        if len({p.id for p in self.parents}) != len(self.parents):
            raise ValueError("duplicate parents")
        return self


def _pilot() -> tuple[list[FactorDefinition], list[dict]]:
    definitions, lineage = [], []
    for window in (5, 10, 20):
        definitions.append({"id": f"reversal_{window}", "semanticsVersion": "3", "inputs": {"x": "close"},
                            "nodes": [{"id": "r", "op": "RETURN", "inputs": ["x"], "params": {"window": window}},
                                      {"id": "n", "op": "NEGATE", "inputs": ["r"]}],
                            "output": "n", "transforms": [{"op": "ZSCORE"}]})
    for window in (10, 20):
        definitions.append({"id": f"volume_{window}", "semanticsVersion": "3", "inputs": {"x": "volume"},
                            "nodes": [{"id": "m", "op": "SMA", "inputs": ["x"], "params": {"window": window}},
                                      {"id": "r", "op": "DIV", "inputs": ["x", "m"]},
                                      {"id": "l", "op": "LOG", "inputs": ["r"]}],
                            "output": "l", "transforms": [{"op": "ZSCORE"}]})
    lineage.extend({"factor": d["id"], "parents": [], "kind": "control"} for d in definitions)
    for w in (5, 10, 20):
        for v in (10, 20):
            for neutral in (False, True):
                name = f"reversal_volume_{w}_{v}" + ("_industry" if neutral else "")
                parents = [f"reversal_{w}", f"volume_{v}"]
                definitions.append({"id": name, "semanticsVersion": "3",
                                    "inputs": {"r": f"factor:{parents[0]}", "v": f"factor:{parents[1]}"},
                                    "nodes": [{"id": "interaction", "op": "MUL_PANEL", "inputs": ["r", "v"]}],
                                    "output": "interaction", "transforms": [{"op": "INDUSTRY_NEUTRALIZE"}] if neutral else []})
                lineage.append({"factor": name, "parents": parents, "kind": "interaction",
                                "params": {"reversalWindow": w, "volumeWindow": v, "industryNeutral": neutral}})
    return [FactorDefinition.model_validate(d) for d in definitions], lineage


def derive_factors(request: DerivationRequest) -> dict:
    if request.generator == "reversal-volume-v1":
        definitions, lineage = _pilot()
        proposals = len(definitions)
    else:
        definitions = list(request.parents)
        parent = next(p for p in request.parents if p.id == request.parent)
        lineage = [{"factor": p.id, "parents": [], "kind": "parent"} for p in definitions]
        proposals = len(request.mutations)
        for index, mutation in enumerate(request.mutations):
            raw = parent.json()
            raw.update(id=f"derived_{index:03d}", semanticsVersion="3")
            if raw["id"] in {d.id for d in definitions}:
                raise ValueError("generated alias collides with parent")
            if mutation.kind == "window":
                node = next((n for n in raw["nodes"] if n["id"] == mutation.node), None)
                if node is None or "window" not in node["params"]:
                    raise ValueError("window mutation requires a window node")
                node["params"]["window"] = mutation.window
            elif mutation.kind == "input":
                old = raw["inputs"].get(mutation.input_name)
                units = {**FIELD_UNITS, **parent.field_units}
                if not old or old not in units or units.get(mutation.field) != units[old]:
                    raise ValueError("input substitution requires declared compatible field units")
                raw["inputs"][mutation.input_name] = mutation.field
                raw["fieldUnits"] = {field: unit for field, unit in parent.field_units.items() if field in raw["inputs"].values()}
            else:
                # Consume the complete parent, including its ordered postprocessing.
                raw.update(inputs={"x": f"factor:{parent.id}"}, fieldUnits={}, nodes=[], output="x", transforms=[])
                if mutation.kind == "aggregate":
                    raw.update(nodes=[{"id": "a", "op": mutation.operator, "inputs": ["x"], "params": {"window": mutation.window}}], output="a")
                elif mutation.kind == "neutralize":
                    raw["transforms"] = [{"op": "INDUSTRY_NEUTRALIZE"}]
                else:
                    if mutation.other not in {d.id for d in request.parents}:
                        raise ValueError("interaction requires a declared other parent")
                    raw["inputs"]["y"] = f"factor:{mutation.other}"
                    raw.update(nodes=[{"id": "a", "op": "MUL_PANEL", "inputs": ["x", "y"]}], output="a")
            definition = FactorDefinition.model_validate(raw)
            definitions.append(definition)
            lineage.append({"factor": definition.id, "parents": [parent.id] + ([mutation.other] if mutation.kind == "interaction" else []),
                            "kind": mutation.kind, "params": mutation.json()})
    if proposals > request.budget or len(definitions) > 128:
        raise ValueError("candidate proposal budget exceeded")
    cards, first = {}, {}
    for definition, link in zip(definitions, lineage):
        card = factor_card(definition, cards)
        cards[definition.id] = card
        link.update(factorVersionId=card["factorVersionId"],
                    parentVersionIds=[cards[name]["factorVersionId"] for name in link["parents"]],
                    duplicateOf=first.get(card["expressionHash"]))
        first.setdefault(card["expressionHash"], definition.id)
    return {"schemaVersion": "3", "familyId": stable_hash(request.json()), "generatorVersion": request.generator,
            "hypothesis": request.hypothesis, "evidenceRefs": request.evidence_refs,
            "proposalCount": proposals, "budget": request.budget, "uniqueCount": len(first),
            "definitions": [d.json() for d in definitions], "cards": list(cards.values()), "lineage": lineage,
            "promotionEligible": False}
