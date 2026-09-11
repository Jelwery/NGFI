"""Native NGFI factor graphs and diagnostics on point-in-time daily panels."""

from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
import pandas as pd

from .research_contracts import FactorDefinition, ResearchDataset, instant

OPERATOR_ARITY = {
    "ADD": 2, "SUB": 2, "DIV": 2, "MUL_PANEL": 2, "ADD_CONST": 1, "MUL": 1,
    "NEGATE": 1, "ABS": 1, "LOG": 1, "RETURN": 1, "DELAY": 1,
    "SMA": 1, "STD": 1, "TS_SUM": 1, "TS_MIN": 1, "TS_MAX": 1, "RANK": 1,
}
ROLLING = {"SMA", "STD", "TS_SUM", "TS_MIN", "TS_MAX"}
PARAMETERS = {name: set() for name in OPERATOR_ARITY}
PARAMETERS.update({name: {"window"} for name in ROLLING | {"RETURN", "DELAY"}})
PARAMETERS.update({"ADD_CONST": {"value"}, "MUL": {"value"}, "RANK": {"percentile"}})


@dataclass
class ResearchPanel:
    dataset: ResearchDataset
    dates: list[str]
    securities: list[str]
    bars: dict
    fields: dict[str, pd.DataFrame]
    eligible: pd.DataFrame


def build_panel(dataset: ResearchDataset) -> ResearchPanel:
    dates = [day.date for day in dataset.calendar]
    securities = sorted({bar.instrument.key for bar in dataset.bars})
    bars = {(bar.date, bar.instrument.key): bar for bar in dataset.bars}
    names = {"open", "high", "low", "close", "volume", "amount", "previous_close"}
    external = {f"feature:{name}" for bar in dataset.bars for name in bar.features}
    fields = {name: pd.DataFrame(np.nan, index=dates, columns=securities) for name in names | external}
    eligible = pd.DataFrame(False, index=dates, columns=securities)
    for session in dataset.calendar:
        for security in securities:
            bar = bars[session.date, security]
            visible = instant(bar.available_at) <= instant(session.decision_at)
            eligible.loc[session.date, security] = visible and bar.eligible and not bar.suspended
            if visible:
                for name in names:
                    fields[name].loc[session.date, security] = getattr(bar, name)
                for name, observation in bar.features.items():
                    if instant(observation.available_at) <= instant(session.decision_at):
                        fields[f"feature:{name}"].loc[session.date, security] = (
                            np.nan if observation.value is None else observation.value
                        )
    return ResearchPanel(dataset, dates, securities, bars, fields, eligible)


def _window(params: dict) -> int:
    value = params.get("window", 1)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not 1 <= value <= 1000:
        raise ValueError("window must be an integer in [1, 1000]; future shifts are forbidden")
    return int(value)


def validate_factor(definition: FactorDefinition, fields: set[str], previous: set[str]) -> None:
    refs: set[str] = set()
    for name, field in definition.inputs.items():
        if field.startswith("factor:"):
            if field[7:] not in previous:
                raise ValueError("factor dependency must be declared before its consumer")
        elif field not in fields:
            raise ValueError(f"missing factor input field: {field}")
        refs.add(name)
    for node in definition.nodes:
        if node.id in refs or any(ref not in refs for ref in node.inputs):
            raise ValueError("duplicate, cyclic, or unknown factor reference")
        if node.op not in OPERATOR_ARITY or len(node.inputs) != OPERATOR_ARITY[node.op]:
            raise ValueError(f"unsupported operator or arity: {node.op}")
        if set(node.params) - PARAMETERS[node.op]:
            raise ValueError(f"unsupported parameters for {node.op}")
        if node.op in ROLLING | {"RETURN", "DELAY"}:
            _window(node.params)
        if node.op in {"ADD_CONST", "MUL"}:
            value = node.params.get("value")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError("scalar operator requires a finite value")
        if node.op == "RANK" and node.params.get("percentile", True) is not True:
            raise ValueError("only percentile rank is supported")
        refs.add(node.id)
    if definition.output not in refs:
        raise ValueError("unknown factor output")
    for step in definition.transforms:
        if step.op == "WINSORIZE":
            if set(step.params) - {"method", "n"} or step.params.get("method", "mad") != "mad":
                raise ValueError("WINSORIZE supports only MAD and n")
            n = step.params.get("n", 3)
            if isinstance(n, bool) or not isinstance(n, (float, int)) or not 0 < n <= 20:
                raise ValueError("MAD n must be in (0, 20]")
        elif step.op == "ZSCORE":
            if set(step.params) - {"method"} or step.params.get("method", "zscore") != "zscore":
                raise ValueError("unsupported ZSCORE parameters")
        elif step.params:
            raise ValueError(f"{step.op} transform takes no parameters")


def _evaluate(op: str, inputs: list[pd.DataFrame], params: dict, eligible: pd.DataFrame) -> pd.DataFrame:
    x = inputs[0]
    if op == "ADD":
        return x + inputs[1]
    if op == "SUB":
        return x - inputs[1]
    if op == "MUL_PANEL":
        return x * inputs[1]
    if op == "DIV":
        return x / inputs[1].where(inputs[1].abs() > 1e-12)
    if op == "ADD_CONST":
        return x + params["value"]
    if op == "MUL":
        return x * params["value"]
    if op == "NEGATE":
        return -x
    if op == "ABS":
        return x.abs()
    if op == "LOG":
        return np.log(x.where(x > 0))
    if op == "RANK":
        return x.where(eligible).rank(axis=1, method="average", pct=True)
    window = _window(params)
    if op == "DELAY":
        return x.shift(window)
    if op == "RETURN":
        return x / x.shift(window).where(x.shift(window).abs() > 1e-12) - 1
    rolling = x.rolling(window, min_periods=window)
    if op == "STD":
        return rolling.std(ddof=0)
    return getattr(rolling, {"SMA": "mean", "TS_SUM": "sum", "TS_MIN": "min", "TS_MAX": "max"}[op])()


def compute_factors(panel: ResearchPanel, definitions: list[FactorDefinition]) -> dict[str, pd.DataFrame]:
    result: dict[str, pd.DataFrame] = {}
    for definition in definitions:
        if definition.id in result:
            raise ValueError("duplicate factor name")
        validate_factor(definition, set(panel.fields), set(result))
        refs = {}
        for name, field in definition.inputs.items():
            refs[name] = result[field[7:]] if field.startswith("factor:") else panel.fields[field]
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            for node in definition.nodes:
                value = _evaluate(node.op, [refs[ref] for ref in node.inputs], node.params, panel.eligible)
                refs[node.id] = value.replace([np.inf, -np.inf], np.nan)
        value = refs[definition.output].where(panel.eligible)
        for step in definition.transforms:
            if step.op == "WINSORIZE":
                center = value.median(axis=1)
                mad = value.sub(center, axis=0).abs().median(axis=1)
                n = step.params.get("n", 3)
                value = value.clip(center - n * mad, center + n * mad, axis=0)
            elif step.op == "ZSCORE":
                value = value.sub(value.mean(axis=1), axis=0).div(value.std(axis=1, ddof=0).replace(0, np.nan), axis=0)
            elif step.op == "INDUSTRY_NEUTRALIZE":
                value = value.copy()
                for day in panel.dates:
                    industry = pd.Series({key: panel.bars[day, key].industry for key in panel.securities})
                    counts = value.loc[day].groupby(industry).transform("count")
                    centered = value.loc[day] - value.loc[day].groupby(industry).transform("mean")
                    value.loc[day] = centered.where(counts >= 2)
            else:
                value = value.rank(axis=1, method="average", pct=True)
        result[definition.id] = value.replace([np.inf, -np.inf], np.nan)
    return result


def forward_labels(panel: ResearchPanel, horizon: int) -> tuple[pd.DataFrame, dict[str, tuple[str, str]]]:
    """Open(t+1) -> open(t+1+h), using calendar positions, never sparse row offsets."""
    if type(horizon) is not int or not 1 <= horizon <= 60:
        raise ValueError("horizon must be an integer in [1, 60]")
    labels = pd.DataFrame(np.nan, index=panel.dates, columns=panel.securities)
    boundaries = {}
    for index, day in enumerate(panel.dates):
        exit_index = index + 1 + horizon
        if exit_index >= len(panel.dates):
            continue
        entry, end = panel.dates[index + 1], panel.dates[exit_index]
        for security in panel.securities:
            first, last = panel.bars[entry, security], panel.bars[end, security]
            if first.suspended or last.suspended:
                continue
            labels.loc[day, security] = last.open / first.open - 1
        available = max(instant(panel.bars[date, key].available_at)
                        for date in (entry, end) for key in panel.securities).isoformat()
        boundaries[day] = (end, available)
    return labels, boundaries


def factor_diagnostics(panel: ResearchPanel, factors: dict[str, pd.DataFrame], labels: pd.DataFrame,
                       start: str, end: str) -> dict:
    output = {}
    for name, matrix in factors.items():
        daily = []
        values = []
        previous_top = None
        for day in panel.dates:
            if not start <= day <= end:
                continue
            valid = matrix.loc[day].notna() & labels.loc[day].notna() & panel.eligible.loc[day]
            x, y = matrix.loc[day, valid], labels.loc[day, valid]
            ic = None
            if len(x) >= 3 and x.nunique() > 1 and y.nunique() > 1:
                ic = float(x.rank().corr(y.rank()))
                values.append(ic)
            groups = None
            if len(x) >= 5:
                ordered = y.loc[x.sort_values(kind="stable").index]
                groups = [float(bucket.mean()) for bucket in np.array_split(ordered.to_numpy(), 5)]
            observed = matrix.loc[day].dropna().sort_values(ascending=False, kind="stable")
            top = set(observed.index[:max(1, math.ceil(len(observed) / 5))])
            turnover = None if not previous_top else 1 - len(top & previous_top) / len(previous_top)
            previous_top = top
            daily.append({"date": day, "samples": len(x), "rankIc": ic, "quintileReturns": groups,
                          "topQuintileTurnover": turnover})
        total = int(panel.eligible.loc[start:end].to_numpy().sum())
        available = int(matrix.loc[start:end].notna().to_numpy().sum())
        output[name] = {
            "coverage": available / total if total else 0, "samples": available,
            "meanRankIc": float(np.mean(values)) if values else None,
            "icir": float(np.mean(values) / np.std(values, ddof=1)) if len(values) > 1 and np.std(values, ddof=1) > 1e-12 else None,
            "daily": daily, "role": "out-of-sample-diagnostic-only",
        }
    return output


def factor_correlations(factors: dict[str, pd.DataFrame], start: str, end: str) -> list[dict]:
    result = []
    names = list(factors)
    for index, left in enumerate(names):
        for right in names[index:]:
            # Demeaned cross-sectional factors should be compared within each date, not pooled across time.
            daily = factors[left].loc[start:end].corrwith(factors[right].loc[start:end], axis=1).dropna()
            result.append({"left": left, "right": right, "days": len(daily),
                           "meanCorrelation": float(daily.mean()) if len(daily) else None})
    return result


def factor_catalog() -> dict:
    def momentum(window: int) -> dict:
        return {
            "id": f"momentum_{window}", "version": "1", "description": f"{window}-session close return",
            "inputs": {"close": "close"},
            "nodes": [{"id": "r", "op": "RETURN", "inputs": ["close"], "params": {"window": window}}],
            "output": "r", "transforms": [{"op": "ZSCORE"}],
        }
    factors = [momentum(window) for window in (5, 10, 20, 60)]
    factors.extend([
        {"id": "reversal_5", "inputs": {"x": "close"},
         "nodes": [{"id": "r", "op": "RETURN", "inputs": ["x"], "params": {"window": 5}},
                   {"id": "n", "op": "NEGATE", "inputs": ["r"]}],
         "output": "n", "transforms": [{"op": "ZSCORE"}]},
        {"id": "low_volatility_20", "inputs": {"x": "close"},
         "nodes": [{"id": "r", "op": "RETURN", "inputs": ["x"], "params": {"window": 1}},
                   {"id": "s", "op": "STD", "inputs": ["r"], "params": {"window": 20}},
                   {"id": "n", "op": "NEGATE", "inputs": ["s"]}],
         "output": "n", "transforms": [{"op": "ZSCORE"}]},
        {"id": "volume_ratio_20", "inputs": {"x": "volume"},
         "nodes": [{"id": "s", "op": "SMA", "inputs": ["x"], "params": {"window": 20}},
                   {"id": "r", "op": "DIV", "inputs": ["x", "s"]}],
         "output": "r", "transforms": [{"op": "ZSCORE"}]},
        {"id": "intraday_return", "inputs": {"o": "open", "c": "close"},
         "nodes": [{"id": "r", "op": "DIV", "inputs": ["c", "o"]},
                   {"id": "n", "op": "ADD_CONST", "inputs": ["r"], "params": {"value": -1}}],
         "output": "n", "transforms": [{"op": "ZSCORE"}]},
    ])
    for name in ("book_to_price", "earnings_yield", "roe", "revenue_growth"):
        factors.append({"id": name, "inputs": {"x": f"feature:{name}"}, "nodes": [], "output": "x",
                        "transforms": [{"op": "WINSORIZE", "params": {"n": 3}}, {"op": "ZSCORE"}]})
    return {
        "engine": "ngfi-factor-graph", "version": "1",
        "operators": [{"name": name, "arity": arity, "parameters": sorted(PARAMETERS[name])} for name, arity in OPERATOR_ARITY.items()],
        "factors": [FactorDefinition.model_validate(value).json() for value in factors],
        "models": ["ridge", "hist-gradient-boosting"], "optimizers": ["mean-variance", "top-k"],
        "limits": {"factorCount": 32, "nodesPerFactor": 64, "maxWindow": 1000},
        "safety": "NGFI native JSON graph; unknown operators/transforms fail; no source execution or native JIT",
    }
