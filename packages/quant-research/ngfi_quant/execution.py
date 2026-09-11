"""A-share calendar, board-lot, fee, suspension and price-limit rules."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from .contracts import AShareBar, AShareCostModel

PRICE_TICK = Decimal("0.01")


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
        index[day] = position
        previous = day
    return index


def next_trading_day(calendar: tuple[str, ...], day: str, offset: int = 1) -> str | None:
    index = validate_calendar(calendar)
    if day not in index:
        raise ValueError(f"date is outside the trading calendar: {day}")
    target = index[day] + offset
    return calendar[target] if 0 <= target < len(calendar) else None


def price_limit(bar: AShareBar, side: Literal["buy", "sell"]) -> float | None:
    if bar.previous_close is None:
        return None
    rate = Decimal(str(bar.limit_rate))
    multiplier = Decimal(1) + rate if side == "buy" else Decimal(1) - rate
    return float((Decimal(str(bar.previous_close)) * multiplier).quantize(PRICE_TICK, rounding=ROUND_HALF_UP))


def is_price_limited(bar: AShareBar, side: Literal["buy", "sell"], tolerance: float = 1e-9) -> bool:
    if bar.open is None or bar.previous_close is None:
        return False
    boundary = price_limit(bar, side)
    assert boundary is not None
    return bar.open >= boundary - tolerance if side == "buy" else bar.open <= boundary + tolerance


def execution_block(bar: AShareBar | None, side: Literal["buy", "sell"]) -> str | None:
    if bar is None:
        return "missing-bar"
    if bar.suspended:
        return "suspended"
    if bar.open is None:
        return "missing-price"
    if is_price_limited(bar, side):
        return "limit-up" if side == "buy" else "limit-down"
    return None


def execution_price(
    raw_open: float,
    side: Literal["buy", "sell"],
    cost: AShareCostModel,
    *,
    limit_price: float | None = None,
) -> float:
    raw = Decimal(str(raw_open))
    rate = Decimal(str(cost.slippage_rate))
    multiplier = Decimal(1) + rate if side == "buy" else Decimal(1) - rate
    slipped = (raw * multiplier).quantize(PRICE_TICK, rounding=ROUND_HALF_UP)
    if limit_price is None:
        return float(slipped)
    boundary = Decimal(str(limit_price))
    bounded = min(slipped, boundary) if side == "buy" else max(slipped, boundary)
    return float(bounded)


def transaction_cost(notional: float, side: Literal["buy", "sell"], cost: AShareCostModel) -> float:
    commission = max(cost.minimum_commission, notional * cost.commission_rate)
    transfer = notional * cost.transfer_fee_rate
    stamp = notional * cost.stamp_duty_rate if side == "sell" else 0.0
    return commission + transfer + stamp


def affordable_board_lot(cash_budget: float, price: float, lot_size: int, cost: AShareCostModel) -> int:
    budget = Decimal(str(cash_budget))
    unit_price = Decimal(str(price))
    shares = int(budget / unit_price) // lot_size * lot_size
    while shares > 0:
        notional = Decimal(shares) * unit_price
        fee = Decimal(str(transaction_cost(float(notional), "buy", cost)))
        if notional + fee <= budget:
            return shares
        shares -= lot_size
    return 0
