"""Deterministic long-only portfolio accounting and BacktestRun projection."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
import math
from statistics import fmean, stdev
from typing import Any

from .contracts import (
    AShareBar, BacktestRequest, BacktestResult, CandidateSignal, EquityPoint, Instrument, Rejection, Trade,
)
from .execution import affordable_board_lot, execution_block, execution_price, transaction_cost, validate_calendar
from .hashing import stable_hash


@dataclass
class _Position:
    signal: CandidateSignal
    shares: int
    entry_date: str
    entry_price: float
    entry_cost: float
    due_index: int


def _metric(value: float | None, unit: str, reason: str = "insufficient samples") -> dict[str, Any]:
    if value is None:
        return {"status": "insufficient", "value": None, "reason": reason}
    if not math.isfinite(value):
        return {"status": "not-meaningful", "value": None, "reason": "metric is not finite"}
    return {"status": "available", "value": value, "unit": unit}


def _metrics(equity: list[EquityPoint], trades: list[Trade], initial_capital: float) -> dict[str, dict[str, Any]]:
    available = [point.value for point in equity if point.value is not None]
    final = available[-1] if available else None
    total_return = None if final is None else final / initial_capital - 1
    daily_returns = [right / left - 1 for left, right in zip(available, available[1:]) if left is not None and right is not None and left > 0]
    sharpe = None
    if len(daily_returns) >= 2 and stdev(daily_returns) > 0:
        sharpe = fmean(daily_returns) / stdev(daily_returns) * math.sqrt(252)
    peak = None
    drawdown = None
    for value in available:
        peak = value if peak is None else max(peak, value)
        candidate = value / peak - 1
        drawdown = candidate if drawdown is None else min(drawdown, candidate)
    wins = [trade for trade in trades if trade.pnl > 0]
    win_rate = len(wins) / len(trades) if trades else None
    gross_profit = sum(max(0.0, trade.pnl) for trade in trades)
    gross_loss = -sum(min(0.0, trade.pnl) for trade in trades)
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None
    return {
        "totalReturn": _metric(total_return, "ratio"),
        "sharpe": _metric(sharpe, "annualized-ratio"),
        "maxDrawdown": _metric(drawdown, "ratio"),
        "winRate": _metric(win_rate, "ratio"),
        "profitFactor": _metric(profit_factor, "ratio", "no losing closed trade"),
        "tradeCount": _metric(float(len(trades)), "count"),
    }


def _bar_map(request: BacktestRequest) -> dict[tuple[str, str], AShareBar]:
    result: dict[tuple[str, str], AShareBar] = {}
    calendar_index = validate_calendar(request.calendar)
    for bar in request.bars:
        if bar.date not in calendar_index:
            raise ValueError(f"bar date is outside trading calendar: {bar.date}")
        available_at = datetime.fromisoformat(bar.available_at.replace("Z", "+00:00"))
        dataset_as_of = datetime.fromisoformat(request.metadata.dataset_as_of.replace("Z", "+00:00"))
        if available_at > dataset_as_of:
            raise ValueError(f"bar is future-available relative to dataset_as_of: {bar.date}/{bar.instrument.key}")
        key = (bar.date, bar.instrument.key)
        if key in result:
            raise ValueError(f"duplicate bar key: {key}")
        result[key] = bar
    return result


def _instrument_dict(instrument: Instrument) -> dict[str, str]:
    return instrument.to_contract()


def _serialize(value: Any) -> Any:
    if isinstance(value, Instrument):
        return value.to_contract()
    if hasattr(value, "__dataclass_fields__"):
        return {
            ({"observation_id": "observationId", "entry_date": "entryDate", "exit_date": "exitDate",
              "entry_price": "entryPrice", "exit_price": "exitPrice", "entry_cost": "entryCost",
              "exit_cost": "exitCost", "return_ratio": "returnRatio"}.get(key, key)): _serialize(item)
            for key, item in asdict(value).items()
        }
    if isinstance(value, tuple):
        return [_serialize(item) for item in value]
    if isinstance(value, dict):
        return {key: _serialize(item) for key, item in value.items()}
    return value


def run_research_backtest(request: BacktestRequest) -> BacktestResult:
    calendar_index = validate_calendar(request.calendar)
    bars = _bar_map(request)
    signals_by_entry: dict[str, list[CandidateSignal]] = {}
    rejections: list[Rejection] = []
    seen_signal_ids: set[str] = set()
    for signal in sorted(request.signals, key=lambda item: (item.signal_date, item.observation_id)):
        if signal.observation_id in seen_signal_ids:
            raise ValueError(f"duplicate signal observation id: {signal.observation_id}")
        seen_signal_ids.add(signal.observation_id)
        if signal.signal_date not in calendar_index:
            raise ValueError(f"signal date is outside trading calendar: {signal.signal_date}")
        next_index = calendar_index[signal.signal_date] + 1
        if next_index >= len(request.calendar):
            rejections.append(Rejection(signal.observation_id, signal.instrument, None, "buy", "no-next-trading-day"))
        else:
            signals_by_entry.setdefault(request.calendar[next_index], []).append(signal)

    cash = request.portfolio.initial_capital
    positions: dict[str, _Position] = {}
    trades: list[Trade] = []
    equity: list[EquityPoint] = []
    last_close: dict[str, float] = {}

    for day_index, day in enumerate(request.calendar):
        for key in sorted(list(positions)):
            position = positions[key]
            if day_index < position.due_index:
                continue
            bar = bars.get((day, key))
            blocked = execution_block(bar, "sell")
            if blocked is not None:
                rejections.append(Rejection(position.signal.observation_id, position.signal.instrument, day, "sell", blocked))
                continue
            assert bar is not None and bar.open is not None
            price = execution_price(bar.open, "sell", request.cost_model)
            notional = position.shares * price
            exit_cost = transaction_cost(notional, "sell", request.cost_model)
            proceeds = notional - exit_cost
            cash += proceeds
            invested = position.shares * position.entry_price + position.entry_cost
            pnl = proceeds - invested
            trades.append(Trade(
                position.signal.observation_id, position.signal.instrument, position.entry_date, day, position.shares,
                position.entry_price, price, position.entry_cost, exit_cost, pnl, pnl / invested,
            ))
            del positions[key]

        for signal in sorted(signals_by_entry.get(day, []), key=lambda item: item.observation_id):
            key = signal.instrument.key
            if key in positions:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", "overlapping-position"))
                continue
            if len(positions) >= request.portfolio.max_positions:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", "position-capacity"))
                continue
            bar = bars.get((day, key))
            blocked = execution_block(bar, "buy")
            if blocked is not None:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", blocked))
                continue
            assert bar is not None and bar.open is not None
            price = execution_price(bar.open, "buy", request.cost_model)
            budget = min(cash, request.portfolio.initial_capital * request.portfolio.allocation_fraction)
            shares = affordable_board_lot(budget, price, request.portfolio.lot_size, request.cost_model)
            if shares == 0:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", "insufficient-cash"))
                continue
            notional = shares * price
            entry_cost = transaction_cost(notional, "buy", request.cost_model)
            cash -= notional + entry_cost
            positions[key] = _Position(signal, shares, day, price, entry_cost, day_index + request.portfolio.holding_days)

        marked = cash
        missing: list[str] = []
        for key, position in positions.items():
            close = bars.get((day, key)).close if bars.get((day, key)) is not None else None
            if close is None:
                close = last_close.get(key)
            if close is None:
                missing.append(key)
            else:
                last_close[key] = close
                marked += position.shares * close
        if missing:
            equity.append(EquityPoint(day, None, "missing", f"missing valuation for {','.join(sorted(missing))}"))
        else:
            equity.append(EquityPoint(day, marked, "available"))

    for position in positions.values():
        rejections.append(Rejection(
            position.signal.observation_id, position.signal.instrument, request.calendar[-1], "sell", "dataset-ended",
        ))

    metrics = _metrics(equity, trades, request.portfolio.initial_capital)
    serialized_trades = _serialize(tuple(trades))
    serialized_rejections = _serialize(tuple(rejections))
    serialized_equity = _serialize(tuple(equity))
    artifacts = [
        {"kind": "trade-records", "ref": f"{request.artifact_prefix}:trades", "hash": stable_hash(serialized_trades)},
        {"kind": "rejections", "ref": f"{request.artifact_prefix}:rejections", "hash": stable_hash(serialized_rejections)},
        {"kind": "equity-curve", "ref": f"{request.artifact_prefix}:equity", "hash": stable_hash(serialized_equity)},
    ]
    benchmark = (
        {"status": "available", "instrument": _instrument_dict(request.metadata.benchmark_instrument),
         "datasetHash": request.metadata.benchmark_dataset_hash}
        if request.metadata.benchmark_instrument is not None and request.metadata.benchmark_dataset_hash is not None
        else {"status": "missing", "reason": "benchmark was not supplied"}
    )
    warnings = []
    if positions:
        warnings.append("Open positions remain at the dataset boundary; final equity is mark-to-market.")
    if any(point.status == "missing" for point in equity):
        warnings.append("At least one equity point is unavailable because a position could not be valued.")
    run_without_id = {
        "engine": "ngfi-quant-research", "engineVersion": request.metadata.engine_version, "engineTier": "research",
        "dataset": {"snapshotId": request.metadata.dataset_snapshot_id, "hash": request.metadata.dataset_hash,
                     "asOf": request.metadata.dataset_as_of},
        "strategyHash": request.metadata.strategy_hash, "configHash": request.metadata.config_hash,
        "executionHash": request.metadata.execution_hash,
        "costModel": {"id": request.cost_model.id, "version": request.cost_model.version,
                      "hash": request.cost_model.hash, "parameters": request.cost_model.parameters()},
        "benchmark": benchmark, "metrics": metrics, "artifacts": artifacts,
        "status": "partial" if any(point.status == "missing" for point in equity) else "complete",
        "warnings": warnings, "startedAt": request.metadata.started_at, "completedAt": request.metadata.completed_at,
    }
    run_identity = {key: value for key, value in run_without_id.items() if key not in ("startedAt", "completedAt")}
    run_identity["artifacts"] = [{"kind": item["kind"], "hash": item["hash"]} for item in artifacts]
    run = {"id": stable_hash(run_identity), **run_without_id}
    return BacktestResult(run, tuple(trades), tuple(rejections), tuple(equity), cash, tuple(sorted(positions)))


def compare_candidate_to_benchmark(candidate: BacktestRequest, benchmark: BacktestRequest) -> dict[str, Any]:
    if candidate.calendar != benchmark.calendar:
        raise ValueError("candidate and benchmark must use identical trading dates")
    candidate_universe = {bar.instrument.key for bar in candidate.bars}
    benchmark_universe = {bar.instrument.key for bar in benchmark.bars}
    if candidate_universe != benchmark_universe:
        raise ValueError("candidate and benchmark must use the same universe")
    if candidate.metadata.dataset_hash != benchmark.metadata.dataset_hash:
        raise ValueError("candidate and benchmark must use the same dataset hash")
    if candidate.cost_model != benchmark.cost_model:
        raise ValueError("candidate and benchmark must use the same cost model")
    candidate_result = run_research_backtest(candidate)
    benchmark_result = run_research_backtest(benchmark)
    candidate_metric = candidate_result.run["metrics"]["totalReturn"]
    benchmark_metric = benchmark_result.run["metrics"]["totalReturn"]
    excess = None
    if candidate_metric["status"] == benchmark_metric["status"] == "available":
        excess = candidate_metric["value"] - benchmark_metric["value"]
    return {
        "candidate": candidate_result, "benchmark": benchmark_result,
        "excessReturn": _metric(excess, "ratio", "candidate or benchmark return is unavailable"),
    }
