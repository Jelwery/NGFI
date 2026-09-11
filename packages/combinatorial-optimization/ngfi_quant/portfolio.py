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
from .execution import affordable_board_lot, execution_block, execution_price, fill_order, money, validate_calendar
from .hashing import stable_hash


@dataclass
class _Position:
    signal: CandidateSignal
    shares: int
    entry_date: str
    entry_price: float
    entry_cost: float
    due_index: int
    dividend_income: float = 0.0


def _metric(value: float | None, unit: str, reason: str = "insufficient samples") -> dict[str, Any]:
    if value is None:
        return {"status": "insufficient", "value": None, "reason": reason}
    if not math.isfinite(value):
        return {"status": "not-meaningful", "value": None, "reason": "metric is not finite"}
    return {"status": "available", "value": value, "unit": unit}


def _metrics(equity: list[EquityPoint], trades: list[Trade], initial_capital: float) -> dict[str, dict[str, Any]]:
    available = [point.value for point in equity if point.value is not None]
    final = equity[-1].value if equity else None
    total_return = None if final is None else final / initial_capital - 1
    # Missing dates remain holes; never reinterpret a multi-day return as daily.
    daily_returns = [right.value / left.value - 1 for left, right in zip(equity, equity[1:])
                     if left.value is not None and right.value is not None and left.value > 0]
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


def _stamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _daily_inputs(request: BacktestRequest, calendar_index: dict) -> tuple[dict, dict, dict, dict]:
    if request.target_schedules and request.signals:
        raise ValueError("target schedules and legacy signals are mutually exclusive")
    schedules, actions, benchmark, attribution = {}, {}, {}, {}
    universe = {bar.instrument.key for bar in request.bars}
    cutoff = _stamp(request.metadata.dataset_as_of)
    for schedule in request.target_schedules:
        if schedule.date not in calendar_index or schedule.date in schedules:
            raise ValueError("duplicate or out-of-calendar target schedule")
        if _stamp(schedule.available_at) > _stamp(f"{schedule.date}T09:30:00+08:00"):
            raise ValueError("target schedule is future-available at execution")
        if set(schedule.weights) - universe:
            raise ValueError("target schedule contains unknown instruments")
        schedules[schedule.date] = schedule
    ids = set()
    action_keys = set()
    for action in request.corporate_actions:
        key = (action.date, action.instrument.key)
        if action.id in ids or key in action_keys or action.date not in calendar_index or action.instrument.key not in universe:
            raise ValueError("duplicate or out-of-calendar corporate action")
        if _stamp(action.available_at) > _stamp(f"{action.date}T09:30:00+08:00"):
            raise ValueError("corporate action is future-available")
        ids.add(action.id)
        action_keys.add(key)
        actions.setdefault(action.date, []).append(action)
    for point in request.benchmark_series:
        if point.date not in calendar_index or point.date in benchmark:
            raise ValueError("duplicate or out-of-calendar benchmark point")
        if _stamp(point.available_at) > cutoff or _stamp(point.available_at) < _stamp(f"{point.date}T15:00:00+08:00"):
            raise ValueError("benchmark point availability is invalid")
        benchmark[point.date] = point
    if benchmark:
        if request.metadata.benchmark_instrument is None or request.metadata.benchmark_instrument.key not in ("CN:SSE:000300:index", "CN:SSE:000906:index"):
            raise ValueError("actual benchmark must be CSI300 or CSI800")
    for row in request.attribution:
        if row.date not in calendar_index or row.date in attribution:
            raise ValueError("duplicate or out-of-calendar attribution row")
        if _stamp(row.weights_available_at) > _stamp(f"{row.date}T09:30:00+08:00"):
            raise ValueError("attribution weights/exposures are future-available")
        if _stamp(row.factor_returns_available_at) > cutoff or _stamp(row.factor_returns_available_at) < _stamp(f"{row.date}T15:00:00+08:00"):
            raise ValueError("factor return availability is invalid")
        attribution[row.date] = row
    if attribution and not benchmark:
        raise ValueError("attribution requires an actual benchmark series")
    if request.max_participation is not None:
        from .contracts import require_finite
        require_finite(request.max_participation, "max_participation", positive=True)
        if request.max_participation > 1:
            raise ValueError("max_participation must not exceed one")
    if money(request.portfolio.initial_capital) != request.portfolio.initial_capital:
        raise ValueError("initial capital must have cent precision")
    return schedules, actions, benchmark, attribution


def _attribution(day: str, previous_day: str, previous_nav: float | None, nav: float | None,
                 starting_cash: float, quantities: dict, bars: dict, actions: list,
                 benchmark: dict, data: Any, costs: float) -> dict:
    if previous_nav is None or nav is None or previous_nav <= 0 or previous_day not in benchmark or day not in benchmark:
        return {"date": day, "status": "missing", "reason": "missing adjacent valuation or benchmark point"}
    benchmark_return = benchmark[day].value / benchmark[previous_day].value - 1
    portfolio_return = nav / previous_nav - 1
    active_return = portfolio_return - benchmark_return
    if data is None:
        return {"date": day, "status": "missing", "portfolioReturn": portfolio_return,
                "benchmarkReturn": benchmark_return, "activeReturn": active_return,
                "reason": "PIT weights, exposures and factor returns were not supplied"}
    universe = set(quantities) | set(data.benchmark_weights)
    action_map = {action.instrument.key: action for action in actions}
    weights, stock_returns = {}, {}
    for key in universe:
        previous, current = bars.get((previous_day, key)), bars.get((day, key))
        if previous is None or previous.close is None or current is None or current.close is None or key not in data.exposures:
            return {"date": day, "status": "missing", "reason": "missing stock mark or factor exposure"}
        weights[key] = quantities.get(key, 0) * previous.close / previous_nav
        action = action_map.get(key)
        split, dividend = (action.split_ratio, action.cash_dividend) if action else (1.0, 0.0)
        stock_returns[key] = (current.close * split + dividend) / previous.close - 1
    components = {"industry": 0.0, "style": 0.0, "residualSelection": 0.0}
    for key in sorted(universe):
        active_weight = weights[key] - data.benchmark_weights.get(key, 0)
        factor_explained = 0.0
        for factor, kind in data.factor_kinds.items():
            contribution = data.exposures[key][factor] * data.factor_returns[factor]
            # Country and unexplained stock return are explicitly in residual selection.
            if kind in ("industry", "style"):
                components[kind] += active_weight * contribution
                factor_explained += contribution
        components["residualSelection"] += active_weight * (stock_returns[key] - factor_explained)
    components["cash"] = -starting_cash / previous_nav * benchmark_return
    # Neutralize the benchmark return already embedded in active stock contributions.
    components["residualSelection"] -= components["cash"]
    components["cost"] = -costs / previous_nav
    components["tradingTimingResidual"] = active_return - sum(components.values())
    return {"date": day, "status": "available", "portfolioReturn": portfolio_return,
            "benchmarkReturn": benchmark_return, "activeReturn": active_return, "components": components,
            "reconciliationError": active_return - sum(components.values()),
            "method": "beginning-weight arithmetic active attribution; timing residual includes benchmark replication"}


def run_research_backtest(request: BacktestRequest) -> BacktestResult:
    calendar_index = validate_calendar(request.calendar)
    bars = _bar_map(request)
    if any(bar.price_basis != "raw" for bar in request.bars):
        raise ValueError("backtest requires raw prices; adjusted prices cannot be fills or marks")
    schedules, actions, benchmark_points, attribution_inputs = _daily_inputs(request, calendar_index)
    strict_status = bool(request.target_schedules)
    if request.benchmark_convention not in ("price", "total-return"):
        raise ValueError("benchmark convention must be price or total-return")
    from .contracts import require_date
    effective_dates = [date for date, _ in request.cost_schedule]
    for effective_date in effective_dates:
        require_date(effective_date, "cost effective date")
    if effective_dates != sorted(set(effective_dates)):
        raise ValueError("cost schedule must be strictly ordered and unique")
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
    cash = money(request.portfolio.initial_capital)
    positions: dict[str, list[_Position]] = {}
    trades: list[Trade] = []
    equity: list[EquityPoint] = []
    daily_ledger, attribution_rows = [], []
    receivables: list[tuple[str, float]] = []
    instruments = {bar.instrument.key: bar.instrument for bar in request.bars}

    for day_index, day in enumerate(request.calendar):
        decision_at = f"{day}T09:30:00+08:00"
        applicable_costs = [model for effective_date, model in request.cost_schedule if effective_date <= day]
        cost_model = applicable_costs[-1] if applicable_costs else request.cost_model
        starting_cash = cash + sum(amount for _, amount in receivables)
        cash = money(cash + sum(amount for pay_date, amount in receivables if pay_date <= day))
        receivables = [(pay_date, amount) for pay_date, amount in receivables if pay_date > day]
        starting_quantities = {key: sum(lot.shares for lot in lots) for key, lots in positions.items()}
        fills, booked_actions = [], []
        day_costs = 0.0
        for action in sorted(actions.get(day, []), key=lambda row: row.id):
            lots = positions.get(action.instrument.key, [])
            dividend_total = 0.0
            for lot in lots:
                new_shares = lot.shares * action.split_ratio
                if abs(new_shares - round(new_shares)) > 1e-8:
                    raise ValueError("fractional corporate-action shares require an explicit cash-in-lieu policy")
                dividend = money(lot.shares * action.cash_dividend)
                dividend_total = money(dividend_total + dividend)
                lot.dividend_income = money(lot.dividend_income + dividend)
                lot.shares = round(new_shares)
                lot.entry_price /= action.split_ratio
            pay_date = action.pay_date or action.date
            if pay_date > day:
                receivables.append((pay_date, dividend_total))
            else:
                cash = money(cash + dividend_total)
            booked_actions.append({"id": action.id, "instrument": action.instrument.to_contract(), "dividendEntitlement": dividend_total,
                                   "payDate": pay_date, "quality_flag": "proxy" if action.cash_dividend and action.pay_date is None else "good", "splitRatio": action.split_ratio})
        target = schedules.get(day)
        targets: dict[str, int] = {}
        target_nav = cash + sum(amount for _, amount in receivables)
        missing_open = False
        if target:
            for key, lots in positions.items():
                bar = bars.get((day, key))
                if bar is None or bar.open is None:
                    missing_open = True
                    break
                target_nav += sum(lot.shares for lot in lots) * bar.open
            if not missing_open:
                for key in sorted(set(positions) | set(target.weights)):
                    bar = bars.get((day, key))
                    if target.weights.get(key, 0) == 0:
                        targets[key] = 0
                    elif bar is not None and bar.open is not None:
                        targets[key] = int(target_nav * target.weights[key] / bar.open) // request.portfolio.lot_size * request.portfolio.lot_size
                    else:
                        rejections.append(Rejection(stable_hash({"schedule": day, "key": key}), instruments[key], day, "buy", "missing-price"))
            else:
                for key in sorted(set(positions) | set(target.weights)):
                    rejections.append(Rejection(stable_hash({"schedule": day, "key": key}), instruments[key], day, "buy", "missing-price"))
        # Both legacy exits and target deltas are converted to orders in this loop.
        for key in sorted(list(positions)):
            lots = positions[key]
            total = sum(lot.shares for lot in lots)
            eligible = [lot for lot in lots if lot.entry_date < day and (target is not None or lot.due_index <= day_index)]
            wanted = max(0, total - targets.get(key, total)) if target else sum(lot.shares for lot in eligible)
            sellable = sum(lot.shares for lot in eligible)
            quantity = min(wanted, sellable)
            if wanted > sellable:
                rejections.append(Rejection(lots[0].signal.observation_id, lots[0].signal.instrument, day, "sell", "t-plus-one"))
            if not quantity:
                continue
            bar = bars.get((day, key))
            reason = _participation_block(bar, quantity, request.max_participation, decision_at)
            fill, blocked = fill_order(bar, quantity, "sell", cost_model, decision_at=decision_at, require_status=strict_status)
            reason = reason or blocked
            if reason:
                rejections.append(Rejection(lots[0].signal.observation_id, lots[0].signal.instrument, day, "sell", reason))
                continue
            assert fill is not None
            cash = money(cash + fill.cash_delta)
            day_costs = money(day_costs + fill.fees["total"] + fill.slippage)
            fills.append({"instrument": instruments[key].to_contract(), **asdict(fill)})
            remaining, fee_remaining = quantity, fill.fees["total"]
            for lot in eligible:
                sold = min(remaining, lot.shares)
                if sold == 0:
                    continue
                fraction = sold / lot.shares
                entry_cost = money(lot.entry_cost * fraction)
                dividend_income = money(lot.dividend_income * fraction)
                exit_cost = fee_remaining if sold == remaining else money(fill.fees["total"] * sold / quantity)
                fee_remaining = money(fee_remaining - exit_cost)
                invested = money(sold * lot.entry_price + entry_cost)
                pnl = money(sold * fill.price - exit_cost + dividend_income - invested)
                trades.append(Trade(lot.signal.observation_id, lot.signal.instrument, lot.entry_date, day, sold,
                                    lot.entry_price, fill.price, entry_cost, exit_cost, pnl, pnl / invested))
                lot.shares -= sold
                lot.entry_cost = money(lot.entry_cost - entry_cost)
                lot.dividend_income = money(lot.dividend_income - dividend_income)
                remaining -= sold
            positions[key] = [lot for lot in lots if lot.shares]
            if not positions[key]:
                del positions[key]
        buys = []
        if target and not missing_open:
            for key in sorted(targets):
                delta = targets[key] - sum(lot.shares for lot in positions.get(key, []))
                if delta > 0:
                    buys.append((CandidateSignal(stable_hash({"schedule": day, "key": key}), instruments[key], day), delta))
        else:
            buys = [(signal, None) for signal in sorted(signals_by_entry.get(day, []), key=lambda row: row.observation_id)]
        for signal, desired in buys:
            key = signal.instrument.key
            if target is None and key in positions:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", "overlapping-position"))
                continue
            if key not in positions and len(positions) >= request.portfolio.max_positions:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", "position-capacity"))
                continue
            bar = bars.get((day, key))
            blocked = execution_block(bar, "buy", decision_at=decision_at, require_status=strict_status)
            if blocked:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", blocked))
                continue
            assert bar is not None and bar.open is not None
            budget = cash if target else min(cash, request.portfolio.initial_capital * request.portfolio.allocation_fraction)
            quantity = affordable_board_lot(budget, execution_price(bar.open, "buy", cost_model), request.portfolio.lot_size, cost_model)
            if desired is not None:
                quantity = min(quantity, desired // request.portfolio.lot_size * request.portfolio.lot_size)
            if quantity == 0:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", "insufficient-cash"))
                continue
            reason = _participation_block(bar, quantity, request.max_participation, decision_at)
            fill, blocked = fill_order(bar, quantity, "buy", cost_model, decision_at=decision_at, require_status=strict_status)
            reason = reason or blocked
            if reason:
                rejections.append(Rejection(signal.observation_id, signal.instrument, day, "buy", reason))
                continue
            assert fill is not None
            cash = money(cash + fill.cash_delta)
            day_costs = money(day_costs + fill.fees["total"] + fill.slippage)
            fills.append({"instrument": signal.instrument.to_contract(), **asdict(fill)})
            positions.setdefault(key, []).append(_Position(signal, quantity, day, fill.price, fill.fees["total"],
                                                           len(request.calendar) if target else day_index + request.portfolio.holding_days))
        marked, missing = cash + sum(amount for _, amount in receivables), []
        for key, lots in positions.items():
            bar = bars.get((day, key))
            if bar is None or bar.close is None:
                missing.append(key)
            else:
                marked += sum(lot.shares for lot in lots) * bar.close
        point = EquityPoint(day, None, "missing", f"missing valuation for {','.join(sorted(missing))}") if missing else EquityPoint(day, money(marked), "available")
        equity.append(point)
        daily_ledger.append({"date": day, "cash": cash, "receivableDividends": money(sum(amount for _, amount in receivables)), "quantities": {key: sum(lot.shares for lot in lots) for key, lots in sorted(positions.items())},
                             "sellableNextDay": {key: sum(lot.shares for lot in lots) for key, lots in sorted(positions.items())},
                             "fills": fills, "corporateActions": booked_actions, "costs": day_costs, "costModelHash": cost_model.hash,
                             "benchmarkConvention": request.benchmark_convention,
                             "targetStatus": "unavailable" if missing_open else ("processed" if target else "none"),
                             "targetQuantities": targets, "unfilledTargetDeltas": {key: quantity - sum(lot.shares for lot in positions.get(key, [])) for key, quantity in targets.items() if quantity != sum(lot.shares for lot in positions.get(key, []))}})
        if day_index:
            attribution_rows.append(_attribution(day, request.calendar[day_index - 1], equity[-2].value, point.value,
                                                  starting_cash, starting_quantities, bars, actions.get(day, []),
                                                  benchmark_points, attribution_inputs.get(day), day_costs))
        elif day in benchmark_points and point.value is not None:
            initial_return = point.value / request.portfolio.initial_capital - 1
            cost_return = -day_costs / request.portfolio.initial_capital
            attribution_rows.append({"date": day, "status": "available", "portfolioReturn": initial_return,
                "benchmarkReturn": 0.0, "activeReturn": initial_return,
                "components": {"industry": 0.0, "style": 0.0, "residualSelection": 0.0, "cash": 0.0,
                               "cost": cost_return, "tradingTimingResidual": initial_return - cost_return},
                "reconciliationError": 0.0, "method": "initial-cash inception; benchmark rebased at first close"})
    if attribution_rows and all(row["status"] == "available" for row in attribution_rows):
        linked = {name: 0.0 for name in attribution_rows[0]["components"]}
        portfolio_growth = benchmark_growth = 1.0
        for row in attribution_rows:
            for name, contribution in row["components"].items():
                linked[name] = linked[name] * (1 + row["benchmarkReturn"]) + portfolio_growth * contribution
            portfolio_growth *= 1 + row["portfolioReturn"]
            benchmark_growth *= 1 + row["benchmarkReturn"]
        daily_ledger[-1]["linkedAttribution"] = {"components": linked, "activeReturn": portfolio_growth - benchmark_growth,
                                                  "reconciliationError": portfolio_growth - benchmark_growth - sum(linked.values())}
    for lots in positions.values():
        for position in lots:
            rejections.append(Rejection(position.signal.observation_id, position.signal.instrument, request.calendar[-1], "sell", "dataset-ended"))
    metrics = _metrics(equity, trades, request.portfolio.initial_capital)
    artifacts = [
        {"kind": kind, "ref": f"{request.artifact_prefix}:{ref}", "hash": stable_hash(_serialize(value))}
        for kind, ref, value in (("trade-records", "trades", tuple(trades)), ("rejections", "rejections", tuple(rejections)),
                                 ("equity-curve", "equity", tuple(equity)), ("daily-ledger", "daily", daily_ledger), ("attribution", "attribution", attribution_rows))
    ]
    benchmark = {"status": "missing", "reason": "actual benchmark series was not supplied"}
    if request.metadata.benchmark_instrument:
        benchmark.update(instrument=request.metadata.benchmark_instrument.to_contract(), datasetHash=request.metadata.benchmark_dataset_hash)
    if benchmark_points:
        benchmark.update(status="available" if len(benchmark_points) == len(request.calendar) else "partial",
                         seriesHash=stable_hash(request.benchmark_series), pointCount=len(benchmark_points))
        benchmark.pop("reason", None)
        first, last = benchmark_points.get(request.calendar[0]), benchmark_points.get(request.calendar[-1])
        benchmark_return = last.value / first.value - 1 if first and last else None
        benchmark["totalReturn"] = _metric(benchmark_return, "ratio")
        total = metrics["totalReturn"]["value"]
        metrics["activeReturn"] = _metric(total - benchmark_return if total is not None and benchmark_return is not None else None, "ratio")
    warnings = []
    incomplete = any(point.status == "missing" for point in equity)
    if strict_status and (len(benchmark_points) != len(request.calendar) or any(row["status"] != "available" for row in attribution_rows)):
        incomplete = True
        warnings.append("Daily portfolio evaluation lacks complete actual benchmark or attribution coverage.")
    if any(action.cash_dividend and action.pay_date is None for action in request.corporate_actions):
        incomplete = True
        warnings.append("Dividend pay date missing: same-day payment is an explicit proxy, not verified settlement history.")
    if not strict_status:
        warnings.append("Legacy signal mode uses explicit historical bar defaults for trading status; target schedules require PIT status.")
    if positions:
        warnings.append("Open positions remain at the dataset boundary; final equity is mark-to-market.")
    if any(point.status == "missing" for point in equity):
        warnings.append("Missing valuation dates remain unavailable; returns are not compressed across gaps.")
    run_without_id = {
        "engine": "ngfi-quant-research", "engineVersion": request.metadata.engine_version, "engineTier": "research",
        "dataset": {"snapshotId": request.metadata.dataset_snapshot_id, "hash": request.metadata.dataset_hash, "asOf": request.metadata.dataset_as_of},
        "strategyHash": request.metadata.strategy_hash, "configHash": request.metadata.config_hash, "executionHash": request.metadata.execution_hash,
        "inputContentHash": stable_hash({"calendar": request.calendar, "bars": request.bars, "signals": request.signals, "schedules": request.target_schedules,
                                          "actions": request.corporate_actions, "benchmark": request.benchmark_series, "attribution": request.attribution,
                                          "portfolio": request.portfolio, "maxParticipation": request.max_participation,
                                          "costSchedule": request.cost_schedule, "benchmarkConvention": request.benchmark_convention}),
        "costModel": {"id": request.cost_model.id, "version": request.cost_model.version, "hash": request.cost_model.hash, "parameters": request.cost_model.parameters()},
        "benchmark": benchmark, "metrics": metrics, "artifacts": artifacts,
        "status": "partial" if incomplete else "complete",
        "warnings": warnings, "startedAt": request.metadata.started_at, "completedAt": request.metadata.completed_at,
    }
    run_identity = {key: value for key, value in run_without_id.items() if key not in ("startedAt", "completedAt")}
    run_identity["artifacts"] = [{"kind": item["kind"], "hash": item["hash"]} for item in artifacts]
    run = {"id": stable_hash(run_identity), **run_without_id}
    return BacktestResult(run, tuple(trades), tuple(rejections), tuple(equity), cash, tuple(sorted(positions)), tuple(daily_ledger), tuple(attribution_rows))


def _participation_block(bar: AShareBar | None, quantity: int, limit: float | None, decision_at: str) -> str | None:
    if limit is None:
        return None
    if bar is None or bar.adv_notional is None or bar.adv_available_at is None:
        return "missing-adv"
    if _stamp(bar.adv_available_at) > _stamp(decision_at):
        return "future-adv"
    if bar.open is not None and quantity * bar.open > limit * bar.adv_notional + 1e-8:
        return "participation-limit"
    return None


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
