from __future__ import annotations

import math
import unittest

from ngfi_quant import (
    AShareBar, AShareCostModel, Instrument, affordable_board_lot, execution_block,
    next_trading_day, transaction_cost,
)


CN = Instrument("CN", "SSE", "600000")


def bar(**changes: object) -> AShareBar:
    values = {
        "date": "2026-01-06", "instrument": CN, "available_at": "2026-01-06T07:00:01+00:00",
        "open": 10.0, "high": 10.5, "low": 9.5, "close": 10.2, "previous_close": 10.0,
        "suspended": False, "limit_rate": 0.1,
    }
    values.update(changes)
    return AShareBar(**values)  # type: ignore[arg-type]


class ExecutionTest(unittest.TestCase):
    def test_calendar_is_explicit_and_strict(self) -> None:
        calendar = ("2026-01-05", "2026-01-06", "2026-01-08")
        self.assertEqual(next_trading_day(calendar, "2026-01-06"), "2026-01-08")
        self.assertIsNone(next_trading_day(calendar, "2026-01-08"))
        with self.assertRaisesRegex(ValueError, "strictly ordered"):
            next_trading_day(("2026-01-05", "2026-01-05"), "2026-01-05")

    def test_board_lot_and_a_share_costs_are_hand_computable(self) -> None:
        cost = AShareCostModel(commission_rate=0.0003, minimum_commission=5, stamp_duty_rate=0.0005, transfer_fee_rate=0.00001)
        self.assertEqual(affordable_board_lot(10_010, 10, 100, cost), 1000)
        self.assertEqual(affordable_board_lot(999, 10, 100, cost), 0)
        self.assertAlmostEqual(transaction_cost(10_000, "buy", cost), 5.1)
        self.assertAlmostEqual(transaction_cost(10_000, "sell", cost), 10.1)

    def test_suspension_missing_price_and_price_limits_are_distinct(self) -> None:
        self.assertEqual(execution_block(bar(suspended=True), "buy"), "suspended")
        self.assertEqual(execution_block(bar(open=None), "buy"), "missing-price")
        self.assertEqual(execution_block(bar(open=11, high=11, close=11), "buy"), "limit-up")
        self.assertEqual(execution_block(bar(open=9, low=9, close=9), "sell"), "limit-down")
        self.assertIsNone(execution_block(bar(open=10.5), "buy"))

    def test_invalid_prices_and_costs_are_rejected_not_coerced(self) -> None:
        with self.assertRaisesRegex(ValueError, "finite"):
            bar(open=math.nan)
        with self.assertRaisesRegex(ValueError, "nonnegative"):
            AShareCostModel(commission_rate=-0.1)


if __name__ == "__main__":
    unittest.main()
