"""One deterministic raw-price execution/fee engine for plans and backtests."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from .contracts import AShareBar, AShareCostModel, require_finite

CENT = Decimal("0.01")


def money(value: float | Decimal) -> float:
    return float(Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP))


def validate_calendar(calendar: tuple[str, ...]) -> dict[str, int]:
    from .contracts import require_date
    if not calendar:
        raise ValueError("trading calendar must not be empty")
    index: dict[str, int] = {}
    previous = ""
    for position, day in enumerate(calendar):
        require_date(day, f"calendar[{position}]")
        if day <= previous:
            raise ValueError("trading calendar must be strictly ordered without duplicates")
        index[day], previous = position, day
    return index


def next_trading_day(calendar: tuple[str, ...], day: str, offset: int = 1) -> str | None:
    index = validate_calendar(calendar)
    if day not in index:
        raise ValueError(f"date is outside the trading calendar: {day}")
    target = index[day] + offset
    return calendar[target] if 0 <= target < len(calendar) else None


def limit_price(previous_close: float, limit_rate: float, side: str) -> float:
    direction = Decimal(1) if side == "buy" else Decimal(-1)
    return money(Decimal(str(previous_close)) * (1 + direction * Decimal(str(limit_rate))))


def is_price_limited(bar: AShareBar, side: Literal["buy", "sell"], tolerance: float = 1e-9) -> bool:
    if bar.open is None or bar.previous_close is None:
        return False
    boundary = limit_price(bar.previous_close, bar.limit_rate, side)
    return bar.open >= boundary - tolerance if side == "buy" else bar.open <= boundary + tolerance


def execution_block(bar: AShareBar | None, side: Literal["buy", "sell"], *,
                    decision_at: str | None = None, require_status: bool = False) -> str | None:
    if bar is None:
        return "missing-bar"
    if bar.price_basis != "raw":
        return "adjusted-price"
    permission = bar.can_buy if side == "buy" else bar.can_sell
    if require_status and (permission is None or bar.status_available_at is None):
        return "missing-status"
    if decision_at is not None and bar.status_available_at is not None:
        if datetime.fromisoformat(bar.status_available_at.replace("Z", "+00:00")) > datetime.fromisoformat(decision_at.replace("Z", "+00:00")):
            return "future-status"
    if bar.suspended:
        return "suspended"
    if permission is False:
        return "buy-disabled" if side == "buy" else "sell-disabled"
    if bar.open is None:
        return "missing-price"
    if require_status and bar.previous_close is None:
        return "missing-previous-close"
    if is_price_limited(bar, side):
        return "limit-up" if side == "buy" else "limit-down"
    return None


def execution_price(raw_open: float, side: Literal["buy", "sell"], cost: AShareCostModel) -> float:
    require_finite(raw_open, "raw price", positive=True)
    if side not in ("buy", "sell"):
        raise ValueError("side must be buy or sell")
    sign = Decimal(1) if side == "buy" else Decimal(-1)
    price = money(Decimal(str(raw_open)) * (1 + sign * Decimal(str(cost.slippage_rate))))
    if price <= 0:
        raise ValueError("execution price must be positive")
    return price


def fee_ledger(notional: float, side: Literal["buy", "sell"], cost: AShareCostModel) -> dict[str, float]:
    require_finite(notional, "notional", nonnegative=True)
    if side not in ("buy", "sell"):
        raise ValueError("side must be buy or sell")
    value = Decimal(str(notional))
    if notional == 0:
        return {"commission": 0.0, "transferFee": 0.0, "stampDuty": 0.0, "total": 0.0}
    commission = money(max(Decimal(str(cost.minimum_commission)), value * Decimal(str(cost.commission_rate))))
    transfer = money(value * Decimal(str(cost.transfer_fee_rate)))
    stamp = money(value * Decimal(str(cost.stamp_duty_rate))) if side == "sell" else 0.0
    return {"commission": commission, "transferFee": transfer, "stampDuty": stamp,
            "total": money(Decimal(str(commission)) + Decimal(str(transfer)) + Decimal(str(stamp)))}


def transaction_cost(notional: float, side: Literal["buy", "sell"], cost: AShareCostModel) -> float:
    return fee_ledger(notional, side, cost)["total"]


@dataclass(frozen=True)
class Fill:
    side: str
    quantity: int
    price: float
    notional: float
    fees: dict[str, float]
    slippage: float
    cash_delta: float


def quote_fill(raw_price: float, quantity: int, side: Literal["buy", "sell"], cost: AShareCostModel) -> Fill:
    """Cent-rounded price, each fee component and cash; zero quantity has no fee."""
    if type(quantity) is not int or quantity < 0:
        raise ValueError("quantity must be a nonnegative integer")
    price = execution_price(raw_price, side, cost)
    notional = money(Decimal(str(price)) * quantity)
    fees = fee_ledger(notional, side, cost)
    delta = -Decimal(str(notional)) - Decimal(str(fees["total"])) if side == "buy" else Decimal(str(notional)) - Decimal(str(fees["total"]))
    slippage = money(abs(Decimal(str(price)) - Decimal(str(raw_price))) * quantity)
    return Fill(side, quantity, price, notional, fees, slippage, money(delta))


def fill_order(bar: AShareBar | None, quantity: int, side: Literal["buy", "sell"], cost: AShareCostModel,
               *, decision_at: str | None = None, require_status: bool = False) -> tuple[Fill | None, str | None]:
    blocked = execution_block(bar, side, decision_at=decision_at, require_status=require_status)
    if blocked:
        return None, blocked
    assert bar is not None and bar.open is not None
    fill = quote_fill(bar.open, quantity, side, cost)
    if bar.previous_close is not None:
        lower = limit_price(bar.previous_close, bar.limit_rate, "sell")
        upper = limit_price(bar.previous_close, bar.limit_rate, "buy")
        if not lower <= fill.price <= upper:
            return None, "slippage-outside-price-limit"
    return fill, None


def affordable_board_lot(cash_budget: float, price: float, lot_size: int, cost: AShareCostModel) -> int:
    """price is already the cent-rounded execution price (legacy public API)."""
    require_finite(cash_budget, "cash budget", nonnegative=True)
    require_finite(price, "price", positive=True)
    if type(lot_size) is not int or lot_size <= 0:
        raise ValueError("lot_size must be a positive integer")
    shares = int(cash_budget / price) // lot_size * lot_size
    while shares > 0:
        notional = money(Decimal(str(price)) * shares)
        if money(Decimal(str(notional)) + Decimal(str(transaction_cost(notional, "buy", cost)))) <= cash_budget:
            return shares
        shares -= lot_size
    return 0
