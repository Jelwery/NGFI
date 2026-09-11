"""Fixed JSON bridge for the narrow DSH strategy tools; no command execution surface."""

from __future__ import annotations

from dataclasses import fields, is_dataclass
import json
import sys
from typing import Any

from .contracts import (
    AShareBar, AShareCostModel, BacktestMetadata, BacktestRequest, CandidateSignal,
    Instrument, PortfolioConfig, TargetSchedule, CorporateAction, BenchmarkPoint, AttributionDay, strict_object,
)
from .portfolio import run_research_backtest
from .promotion import PromotionThresholds, decide_promotion


def _instrument(value: dict[str, Any]) -> Instrument:
    strict_object(value, {"market", "exchange", "symbol"}, {"assetType"}, "instrument")
    from .contracts import instrument_from_key
    return instrument_from_key(f"{value['market']}:{value['exchange']}:{value['symbol']}:{value.get('assetType', 'equity')}")


def _backtest_request(value: dict[str, Any]) -> BacktestRequest:
    strict_object(value, {"calendar", "bars", "signals", "costModel", "portfolio", "metadata"},
                  {"artifactPrefix", "targetSchedules", "corporateActions", "benchmarkSeries", "attribution", "maxParticipation", "costSchedule", "benchmarkConvention"}, "backtest")
    cost = value["costModel"]
    portfolio = value["portfolio"]
    metadata = value["metadata"]
    strict_object(cost, set(), {"id", "version", "commissionRate", "minimumCommission", "stampDutyRate", "transferFeeRate", "slippageRate"}, "costModel")
    strict_object(portfolio, {"initialCapital", "maxPositions", "allocationFraction", "holdingDays"}, {"lotSize"}, "portfolio")
    strict_object(metadata, {"datasetSnapshotId", "datasetHash", "datasetAsOf", "strategyHash", "configHash", "executionHash", "startedAt", "completedAt"},
                  {"benchmarkInstrument", "benchmarkDatasetHash", "engineVersion"}, "metadata")
    for row in value["bars"]:
        strict_object(row, {"date", "instrument", "availableAt"}, {"open", "high", "low", "close", "previousClose", "suspended", "limitRate", "statusAvailableAt", "canBuy", "canSell", "priceBasis", "advNotional", "advAvailableAt"}, "bar")
    for row in value["signals"]:
        strict_object(row, {"observationId", "instrument", "signalDate"}, set(), "signal")
    for row in value.get("targetSchedules", []):
        strict_object(row, {"date", "availableAt", "weights"}, set(), "targetSchedule")
    for row in value.get("corporateActions", []):
        strict_object(row, {"id", "date", "instrument", "availableAt"}, {"splitRatio", "cashDividend", "payDate"}, "corporateAction")
    for row in value.get("benchmarkSeries", []):
        strict_object(row, {"date", "value", "availableAt"}, set(), "benchmarkPoint")
    for row in value.get("attribution", []):
        strict_object(row, {"date", "weightsAvailableAt", "benchmarkWeights", "exposures", "factorKinds", "factorReturns", "factorReturnsAvailableAt"}, set(), "attribution")
    return BacktestRequest(
        calendar=tuple(value["calendar"]),
        bars=tuple(AShareBar(
            row["date"], _instrument(row["instrument"]), row["availableAt"],
            row.get("open"), row.get("high"), row.get("low"), row.get("close"),
            row.get("previousClose"), row.get("suspended", False), row.get("limitRate", 0.10),
            row.get("statusAvailableAt"), row.get("canBuy"), row.get("canSell"), row.get("priceBasis", "raw"),
            row.get("advNotional"), row.get("advAvailableAt"),
        ) for row in value["bars"]),
        signals=tuple(CandidateSignal(
            row["observationId"], _instrument(row["instrument"]), row["signalDate"],
        ) for row in value["signals"]),
        cost_model=AShareCostModel(
            cost.get("id", "cn-equity-standard"), cost.get("version", "1.0.0"),
            cost.get("commissionRate", 0.0003), cost.get("minimumCommission", 5.0),
            cost.get("stampDutyRate", 0.0005), cost.get("transferFeeRate", 0.00001),
            cost.get("slippageRate", 0.0),
        ),
        portfolio=PortfolioConfig(
            portfolio["initialCapital"], portfolio["maxPositions"], portfolio["allocationFraction"],
            portfolio["holdingDays"], portfolio.get("lotSize", 100),
        ),
        metadata=BacktestMetadata(
            metadata["datasetSnapshotId"], metadata["datasetHash"], metadata["datasetAsOf"],
            metadata["strategyHash"], metadata["configHash"], metadata["executionHash"],
            None if metadata.get("benchmarkInstrument") is None else _instrument(metadata["benchmarkInstrument"]),
            metadata.get("benchmarkDatasetHash"), metadata["startedAt"], metadata["completedAt"],
            metadata.get("engineVersion", "1.0.0"),
        ),
        artifact_prefix=value.get("artifactPrefix", "memory:quant-research"),
        target_schedules=tuple(TargetSchedule(row["date"], row["availableAt"], row["weights"]) for row in value.get("targetSchedules", [])),
        corporate_actions=tuple(CorporateAction(row["id"], row["date"], _instrument(row["instrument"]), row["availableAt"], row.get("splitRatio", 1.0), row.get("cashDividend", 0.0), row.get("payDate")) for row in value.get("corporateActions", [])),
        benchmark_series=tuple(BenchmarkPoint(row["date"], row["value"], row["availableAt"]) for row in value.get("benchmarkSeries", [])),
        attribution=tuple(AttributionDay(row["date"], row["weightsAvailableAt"], row["benchmarkWeights"], row["exposures"], row["factorKinds"], row["factorReturns"], row["factorReturnsAvailableAt"]) for row in value.get("attribution", [])),
        max_participation=value.get("maxParticipation"),
        cost_schedule=tuple(_dated_cost(row) for row in value.get("costSchedule", [])),
        benchmark_convention=value.get("benchmarkConvention", "price"),
    )


def _dated_cost(row: dict) -> tuple[str, AShareCostModel]:
    strict_object(row, {"effectiveDate", "costModel"}, set(), "costSchedule")
    cost = row["costModel"]
    strict_object(cost, {"id", "version", "commissionRate", "minimumCommission", "stampDutyRate", "transferFeeRate", "slippageRate"}, set(), "datedCostModel")
    return row["effectiveDate"], AShareCostModel(cost["id"], cost["version"], cost["commissionRate"], cost["minimumCommission"], cost["stampDutyRate"], cost["transferFeeRate"], cost["slippageRate"])


def _camel(key: str) -> str:
    head, *tail = key.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _json_value(value: Any) -> Any:
    if is_dataclass(value):
        return {_camel(field.name): _json_value(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    return value


def _promotion(value: dict[str, Any]) -> dict[str, Any]:
    research_run = value["researchRun"]
    if research_run.get("engineTier") != "research":
        raise ValueError("promotion evidence requires a research-tier backtest; smoke is never eligible")
    thresholds = value["thresholds"]
    decision = decide_promotion(
        thresholds=PromotionThresholds(
            thresholds["minimumOosScore"], thresholds["minimumWalkForwardScore"],
            thresholds["maximumPbo"], thresholds["minimumDeflatedSharpeProbability"],
            thresholds["minimumTrackRecordObservations"], thresholds["maximumCostStressDegradation"],
        ),
        is_oos=value["isOos"], walk_forward=value["walkForward"], pbo=value["cscvPbo"],
        deflated_sharpe_result=value["deflatedSharpe"],
        minimum_track_record_result=value["minimumTrackRecord"],
        actual_track_record_observations=value["actualTrackRecordObservations"],
        base_return=value.get("baseReturn"), stressed_return=value.get("stressedReturn"),
    )
    return {**decision, "researchRun": research_run}


def dispatch(operation: str, value: dict[str, Any]) -> Any:
    if operation == "research-backtest":
        return run_research_backtest(_backtest_request(value))
    if operation == "promotion":
        return _promotion(value)
    if operation == "walk-forward":
        from .validation import run_registered_walk_forward
        return run_registered_walk_forward(value)
    if operation in {"portfolio-optimize", "rebalance-plan"}:
        from .optimizer import optimize_portfolio, rebalance_plan
        return optimize_portfolio(value) if operation == "portfolio-optimize" else rebalance_plan(value)
    raise ValueError("operation must be research-backtest, promotion, portfolio-optimize or rebalance-plan")


def _unique_object(pairs: list) -> dict:
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def main() -> None:
    if len(sys.argv) != 2:
        raise ValueError("exactly one fixed operation is required")
    value = json.load(sys.stdin, object_pairs_hook=_unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"non-finite JSON: {value}")))
    result = dispatch(sys.argv[1], value)
    json.dump(_json_value(result), sys.stdout, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Deliberately omit tracebacks and local paths at the tool boundary.
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(2) from None
