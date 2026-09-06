"""Fixed JSON bridge for the narrow DSH strategy tools; no command execution surface."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
import json
import sys
from typing import Any

from .contracts import (
    AShareBar, AShareCostModel, BacktestMetadata, BacktestRequest, CandidateSignal,
    Instrument, PortfolioConfig,
)
from .portfolio import run_research_backtest
from .promotion import PromotionThresholds, decide_promotion


def _instrument(value: dict[str, Any]) -> Instrument:
    return Instrument(value["market"], value["exchange"], value["symbol"], value.get("assetType", "equity"))


def _backtest_request(value: dict[str, Any]) -> BacktestRequest:
    cost = value["costModel"]
    portfolio = value["portfolio"]
    metadata = value["metadata"]
    return BacktestRequest(
        calendar=tuple(value["calendar"]),
        bars=tuple(AShareBar(
            row["date"], _instrument(row["instrument"]), row["availableAt"],
            row.get("open"), row.get("high"), row.get("low"), row.get("close"),
            row.get("previousClose"), row.get("suspended", False), row.get("limitRate", 0.10),
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
    )


def _camel(key: str) -> str:
    head, *tail = key.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _json_value(value: Any) -> Any:
    if is_dataclass(value):
        return _json_value(asdict(value))
    if isinstance(value, dict):
        return {_camel(str(key)): _json_value(item) for key, item in value.items()}
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


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"research-backtest", "promotion"}:
        raise ValueError("operation must be research-backtest or promotion")
    value = json.load(sys.stdin)
    result = run_research_backtest(_backtest_request(value)) if sys.argv[1] == "research-backtest" else _promotion(value)
    json.dump(_json_value(result), sys.stdout, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Deliberately omit tracebacks and local paths at the tool boundary.
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(2) from None
