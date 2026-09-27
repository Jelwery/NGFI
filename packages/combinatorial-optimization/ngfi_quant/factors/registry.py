"""Versioned native operators and content-addressed factor cards."""
from __future__ import annotations

from typing import Literal

from pydantic import Field

from ..hashing import stable_hash
from ..research_contracts import Contract, FactorDefinition


class FactorRegistration(Contract):
    schema_version: Literal["3"] = "3"
    factors: list[FactorDefinition] = Field(min_length=1, max_length=128)
    hypothesis: str = Field(min_length=1, max_length=2000)
    evidence_refs: list[str] = Field(default_factory=list, max_length=32)
    source: str = Field(default="native-user-definition", min_length=1, max_length=2000)


def register_factors(request: FactorRegistration) -> dict:
    cards = {}
    for definition in request.factors:
        if definition.id in cards:
            raise ValueError("duplicate factor alias")
        cards[definition.id] = factor_card(definition, cards)
    return {"schemaVersion": "3", "assetId": request.hash, "hypothesis": request.hypothesis,
            "source": request.source, "evidenceRefs": request.evidence_refs,
            "definitions": [d.json() for d in request.factors], "cards": list(cards.values()),
            "promotionEligible": False}

EXTRA_ARITY = {
    "DELTA": 1, "TS_RANK": 1, "CORRELATION": 2, "COVARIANCE": 2,
    "DECAY_LINEAR": 1, "TS_QUANTILE": 1, "TS_ARGMAX": 1, "TS_ARGMIN": 1,
    "SIGN": 1, "GT": 2, "LT": 2, "SELECT": 3, "ZSCORE": 1,
}
EXTRA_ROLLING = {"TS_RANK", "CORRELATION", "COVARIANCE", "DECAY_LINEAR",
                 "TS_QUANTILE", "TS_ARGMAX", "TS_ARGMIN"}
FIELD_UNITS = {**{name: "price" for name in ("open", "high", "low", "close", "previous_close")},
               "volume": "shares", "amount": "currency"}
POLICY = {
    "missing": "propagate; complete rolling windows; no fill",
    "stdDof": 0, "rankTies": "average", "divisionEpsilon": 1e-12,
    "crossSection": "historical eligible at decision",
    "time": "historical observations visible at their decision only",
}


def operator_catalog() -> list[dict]:
    from .graph import OPERATOR_ARITY, PARAMETERS, ROLLING
    return [{
        "opId": name, "version": "3" if name in EXTRA_ARITY else "2",
        "arity": arity, "parameters": sorted(PARAMETERS[name]),
        "category": "time-series" if name in ROLLING | {"RETURN", "DELAY", "DELTA"} else
                    "cross-section" if name in {"RANK", "ZSCORE"} else "elementwise",
        "inputType": "numeric-panel", "outputType": "boolean-panel" if name in {"GT", "LT"} else "numeric-panel",
        "unitRule": "checked-by-factor-card-v3", "policy": POLICY,
        "history": "window" if name in {"RETURN", "DELAY", "DELTA"} else
                   "window-1" if name in ROLLING else "0",
        "implementation": f"ngfi_quant.factors.graph:{name}", "status": "implemented",
    } for name, arity in OPERATOR_ARITY.items()]


def factor_card(definition: FactorDefinition, previous: dict[str, dict] | None = None) -> dict:
    from .graph import validate_factor, ROLLING, _window
    previous = previous or {}
    fields = {value for value in definition.inputs.values() if not value.startswith("factor:")}
    validate_factor(definition, fields, set(previous), check_units=False)
    strict = definition.semantics_version == "3"
    if set(definition.field_units) - set(definition.inputs.values()):
        raise ValueError("fieldUnits must describe declared inputs")
    if any(field in FIELD_UNITS and FIELD_UNITS[field] != unit for field, unit in definition.field_units.items()):
        raise ValueError("native input units cannot be overridden")
    refs, units, history, expressions = {}, {}, {}, {}
    for name, field in definition.inputs.items():
        if field.startswith("factor:"):
            parent = previous[field[7:]]
            refs[name] = {"factorExpression": parent["expressionHash"]}
            units[name], history[name] = parent["outputUnit"], parent["lookbackSessions"]
        else:
            unit = FIELD_UNITS.get(field, definition.field_units.get(field, "unknown"))
            if strict and unit == "unknown":
                raise ValueError(f"external input requires fieldUnits: {field}")
            refs[name] = {"field": field, "unit": unit}
            units[name], history[name] = unit, 0
        expressions[name] = refs[name]
    nodes, edges = [], []
    for node in definition.nodes:
        operands = [units[ref] for ref in node.inputs]
        op = node.op
        unit = operands[0]
        if strict:
            if op != "SELECT" and "boolean" in operands:
                raise ValueError("boolean panels are only accepted by SELECT")
            if op in {"ADD", "SUB", "GT", "LT", "CORRELATION", "COVARIANCE"} and len(set(operands)) != 1:
                raise ValueError(f"incompatible units for {op}")
            if op in {"LOG", "ADD_CONST"} and unit != "dimensionless":
                raise ValueError(f"{op} requires a dimensionless input")
            if op == "SELECT" and (operands[0] != "boolean" or operands[1] != operands[2]):
                raise ValueError("SELECT requires boolean condition and compatible branches")
        if op in {"RETURN", "RANK", "ZSCORE", "SIGN", "TS_RANK", "TS_ARGMAX", "TS_ARGMIN", "CORRELATION"}:
            unit = "dimensionless"
        elif op in {"GT", "LT"}:
            unit = "boolean"
        elif op == "SELECT":
            unit = operands[1]
        elif op == "DIV":
            unit = "dimensionless" if operands[0] == operands[1] else f"({operands[0]}/{operands[1]})"
        elif op in {"MUL_PANEL", "COVARIANCE"}:
            unit = operands[1] if operands[0] == "dimensionless" else operands[0] if operands[1] == "dimensionless" else f"({operands[0]}*{operands[1]})"
        lookback = max(history[ref] for ref in node.inputs)
        if op in {"RETURN", "DELAY", "DELTA"}:
            lookback += _window(node.params)
        elif op in ROLLING:
            lookback += _window(node.params) - 1
        params = dict(node.params)
        if op in ROLLING | {"RETURN", "DELAY", "DELTA"}:
            params["window"] = _window(params)
        if op == "RANK":
            params["percentile"] = True
        if op == "TS_QUANTILE":
            params.setdefault("q", 0.5)
        args = [expressions[ref] for ref in node.inputs]
        # Only commutation, never association/distribution of floating point operations.
        if op in {"ADD", "MUL_PANEL"}:
            args = sorted(args, key=stable_hash)
        expression = {"op": op, "version": "3" if op in EXTRA_ARITY else "2", "params": params, "inputs": args}
        # Store child hashes to keep a shared DAG from expanding exponentially.
        expressions[node.id] = {"expression": stable_hash(expression)}
        refs[node.id], units[node.id], history[node.id] = expression, unit, lookback
        nodes.append({"nodeId": node.id, **expression, "unit": unit, "lookbackSessions": lookback})
        edges.extend({"from": ref, "to": node.id, "inputIndex": index} for index, ref in enumerate(node.inputs))
    unit = units[definition.output]
    transforms = []
    for step in definition.transforms:
        params = dict(step.params)
        if step.op == "WINSORIZE":
            params = {"method": "mad", "n": params.get("n", 3)}
        elif step.op == "ZSCORE":
            params = {"method": "zscore"}
        transforms.append({"op": step.op, "version": "2", "params": params})
        if step.op in {"RANK", "ZSCORE"}:
            unit = "dimensionless"
    expression_hash = stable_hash({"semantics": definition.semantics_version, "policy": POLICY,
                                   "output": expressions[definition.output], "transforms": transforms})
    return {"schemaVersion": "3", "factorVersionId": stable_hash({"expressionHash": expression_hash, "version": definition.version}),
            "expressionHash": expression_hash, "alias": definition.id, "description": definition.description,
            "definition": definition.json(), "nodes": nodes, "edges": edges,
            "operators": sorted({node.op for node in definition.nodes} | {step.op for step in definition.transforms}),
            "inputs": sorted(definition.inputs.values()), "outputUnit": unit,
            "lookbackSessions": history[definition.output], "nodeCount": len(nodes),
            "interpretation": "structure-only; no realized-return contribution"}


def catalog() -> dict:
    from .graph import factor_catalog
    legacy = factor_catalog()
    cards = [factor_card(FactorDefinition.model_validate(value)) for value in legacy["factors"]]
    return {"schemaVersion": "3", "operators": operator_catalog(), "factors": cards,
            "reverseDependencies": {op["opId"]: [card["factorVersionId"] for card in cards if op["opId"] in card["operators"]]
                                    for op in operator_catalog()},
            "limits": {**legacy["limits"], "candidateBudget": 128, "factorCells": 2_000_000},
            "promotionEligible": False}
