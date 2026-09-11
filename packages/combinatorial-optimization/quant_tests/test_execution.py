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


    def test_cents_slippage_and_rounded_limits(self):
        from ngfi_quant.execution import quote_fill, limit_price, fill_order
        cost = AShareCostModel(commission_rate=0.0003, minimum_commission=5, stamp_duty_rate=0.0005,
                               transfer_fee_rate=0.00001, slippage_rate=0.001)
        fill = quote_fill(10.01, 100, "sell", cost)
        self.assertEqual(fill.price, 10.0)
        self.assertEqual(fill.notional, 1000)
        self.assertEqual(fill.fees, {"commission": 5.0, "transferFee": 0.01, "stampDuty": 0.5, "total": 5.51})
        self.assertEqual(fill.cash_delta, 994.49)
        self.assertEqual(fill.slippage, 1)
        self.assertEqual(quote_fill(10, 0, "buy", cost).fees["total"], 0)
        self.assertEqual(limit_price(10.05, 0.1, "buy"), 11.06)
        limited = bar(open=11.06, high=11.06, close=11.06, previous_close=10.05)
        self.assertEqual(execution_block(limited, "buy"), "limit-up")
        _, reason = fill_order(bar(open=10.99, high=10.99), 100, "buy", AShareCostModel(slippage_rate=0.01))
        self.assertEqual(reason, "slippage-outside-price-limit")


if __name__ == "__main__":
    unittest.main()
