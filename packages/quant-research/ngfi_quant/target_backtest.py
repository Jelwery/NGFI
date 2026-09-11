"""Daily target-weight replay with explicit orders, fills, cash and holdings."""

from __future__ import annotations

from collections.abc import Callable
import math

import numpy as np

from .contracts import AShareBar, AShareCostModel, Instrument
from .execution import affordable_board_lot, execution_block, execution_price, price_limit, transaction_cost
from .research_contracts import ResearchSpec, instant
from .research_factors import ResearchPanel


def replay_targets(panel: ResearchPanel, spec: ResearchSpec, policy: Callable[[int, np.ndarray], dict]) -> dict:
    execution = spec.execution
    cost = AShareCostModel(
        commission_rate=execution.commission_rate, minimum_commission=execution.minimum_commission,
        stamp_duty_rate=execution.stamp_duty_rate, transfer_fee_rate=execution.transfer_fee_rate,
        slippage_rate=execution.slippage_rate,
    )
    securities = panel.securities
    cash = execution.initial_capital
    positions = dict.fromkeys(securities, 0)
    acquired = {}
    pending = None
    orders, fills, equity, decisions = [], [], [], []
    start = panel.dates.index(spec.start_date)
    end = panel.dates.index(spec.end_date)
    if end >= len(panel.dates) - 1:
        raise ValueError("endDate must leave one execution session")
    previous_nav = cash
    for index in range(start, end + 2):
        day = panel.dates[index]
        if pending is not None:
            quantities, signal_index = pending
            for side in ("sell", "buy"):
                for security in securities:
                    row = panel.bars[day, security]
                    desired = quantities[security]
                    delta = desired - positions[security]
                    quantity = -delta if side == "sell" else delta
                    if quantity <= 0:
                        continue
                    bar = AShareBar(
                        row.date, Instrument(row.instrument.market, row.instrument.exchange, row.instrument.symbol),
                        row.available_at, row.open, row.high, row.low, row.close, row.previous_close,
                        row.suspended, row.limit_rate,
                    )
                    blocked = execution_block(bar, side)
                    if side == "sell" and acquired.get(security) == day:
                        blocked = "t-plus-one"
                    if side == "buy" and not panel.bars[panel.dates[signal_index], security].eligible:
                        blocked = "outside-universe"
                    order = {"date": day, "decisionDate": panel.dates[signal_index], "instrument": security,
                             "side": side, "requestedShares": quantity}
                    if blocked:
                        orders.append({**order, "filledShares": 0, "status": "rejected", "reason": blocked})
                        continue
                    # Capacity uses yesterday's visible volume, not the full future execution-day volume.
                    prior = panel.bars[panel.dates[signal_index], security]
                    capacity = math.floor(prior.volume * execution.max_participation / execution.lot_size) * execution.lot_size
                    shares = min(quantity, capacity)
                    price = execution_price(
                        row.open,
                        side,
                        cost,
                        limit_price=price_limit(bar, side),
                    )
                    if side == "buy":
                        shares = min(shares, affordable_board_lot(cash, price, execution.lot_size, cost))
                    else:
                        shares = min(shares, positions[security])
                    if shares <= 0:
                        orders.append({**order, "filledShares": 0, "status": "rejected",
                                       "reason": "participation-limit" if capacity == 0 else "insufficient-cash"})
                        continue
                    notional = shares * price
                    fee = transaction_cost(notional, side, cost)
                    cash += notional - fee if side == "sell" else -(notional + fee)
                    positions[security] += -shares if side == "sell" else shares
                    if side == "buy":
                        acquired[security] = day
                    if cash < -1e-7 or positions[security] < 0:
                        raise ValueError("execution ledger produced negative cash or inventory")
                    fills.append({**order, "shares": shares, "price": price, "fees": fee, "notional": notional,
                                  "cashAfter": cash, "positionAfter": positions[security]})
                    orders.append({**order, "filledShares": shares,
                                   "status": "filled" if shares == quantity else "partial",
                                   "reason": None if shares == quantity else "capacity-or-cash"})
            pending = None
        decision_at = panel.dataset.calendar[index].decision_at
        if any(
            shares and instant(panel.bars[day, security].available_at) > instant(decision_at)
            for security, shares in positions.items()
        ):
            raise ValueError("held security valuation is not PIT-visible")
        marked = {security: shares * panel.bars[day, security].close for security, shares in positions.items()}
        nav = cash + sum(marked.values())
        if not math.isfinite(nav) or nav <= 0:
            raise ValueError("portfolio NAV is non-positive or non-finite")
        equity.append({
            "date": day, "nav": nav, "cash": cash, "holdingsValue": sum(marked.values()),
            "return": nav / previous_nav - 1,
            "positions": {security: {"shares": positions[security], "marketValue": value}
                          for security, value in marked.items() if positions[security]},
        })
        previous_nav = nav
        if index <= end and (index - start) % execution.rebalance_every == 0:
            current = np.array([marked[security] / nav for security in securities])
            decision = policy(index, current)
            decisions.append({"date": day, "currentWeights": dict(zip(securities, current.tolist())), **decision})
            if decision.get("status") == "complete":
                target = decision["weights"]
                if set(target) - set(securities):
                    raise ValueError("target contains unknown securities")
                if any(not math.isfinite(value) or value < 0 for value in target.values()) or sum(target.values()) > 1 + 1e-7:
                    raise ValueError("invalid target weights")
                for security, weight in target.items():
                    if weight > 0 and not panel.eligible.loc[day, security] and not positions[security]:
                        raise ValueError("target includes a non-visible or ineligible security")
                quantities = {
                    security: math.floor(target.get(security, 0) * nav / panel.bars[day, security].close
                                         / execution.lot_size) * execution.lot_size
                    for security in securities
                }
                pending = (quantities, index)
    returns = np.array([point["return"] for point in equity[1:]])
    navs = np.array([point["nav"] for point in equity])
    deviation = np.std(returns, ddof=1) if len(returns) > 1 else 0
    total = navs[-1] / execution.initial_capital - 1
    failed = sum(item["status"] != "complete" for item in decisions)
    annualized = float(np.expm1(np.log1p(total) * 252 / len(returns)))
    return {
        "status": "partial" if failed else "complete",
        "metrics": {
            "totalReturn": float(total), "annualizedReturn": annualized if math.isfinite(annualized) else None,
            "sharpe": float(np.mean(returns) / deviation * math.sqrt(252)) if deviation > 1e-12 else None,
            "maxDrawdown": float(np.min(navs / np.maximum.accumulate(navs) - 1)),
            "fees": float(sum(fill["fees"] for fill in fills)),
            "tradedNotional": float(sum(fill["notional"] for fill in fills)),
            "turnover": float(sum(fill["notional"] for fill in fills) / float(np.mean(navs))),
            "fillCount": len(fills), "failedDecisions": failed, "returnObservations": len(returns),
            "rejectedOrders": sum(order["status"] == "rejected" for order in orders),
            "partialOrders": sum(order["status"] == "partial" for order in orders),
        },
        "equity": equity, "orders": orders, "fills": fills, "decisions": decisions,
        "finalCash": cash, "finalPositions": {key: value for key, value in positions.items() if value},
        "execution": "decision-close sizing; next-session-open fill; T+1; board-lot; prior-volume participation; unfilled orders expire",
        "warnings": [
            "Open positions are marked to market, not forcibly liquidated at the dataset boundary.",
            "Daily open fills are an approximation; intraday queue position is not modeled.",
            "Rates are constant over this run; choose a period with the same fee/tax regime.",
        ],
    }
