from __future__ import annotations

from dataclasses import replace
import unittest

from ngfi_quant import (
    AShareBar, AShareCostModel, BacktestMetadata, BacktestRequest, CandidateSignal, Instrument,
    PortfolioConfig, compare_candidate_to_benchmark, run_research_backtest, stable_hash,
)


CALENDAR = ("2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09")
A = Instrument("CN", "SSE", "600000")
B = Instrument("CN", "SZSE", "000001")
ZERO_COST = AShareCostModel("zero-cost", "1.0.0", 0, 0, 0, 0, 0)


def bars(instruments: tuple[Instrument, ...] = (A, B)) -> tuple[AShareBar, ...]:
    prices = [9.8, 10.0, 10.5, 11.0, 11.2]
    return tuple(
        AShareBar(day, instrument, f"{day}T07:00:01+00:00", price, price + 0.2, price - 0.2, price,
                  prices[index - 1] if index else 9.5)
        for instrument in instruments
        for index, (day, price) in enumerate(zip(CALENDAR, prices))
    )


def signal(number: int, instrument: Instrument = A, day: str = "2026-01-05") -> CandidateSignal:
    return CandidateSignal(stable_hash({"signal": number}), instrument, day)


def request(
    signals: tuple[CandidateSignal, ...], *, portfolio: PortfolioConfig | None = None,
    rows: tuple[AShareBar, ...] | None = None, cost: AShareCostModel = ZERO_COST, strategy: str = "candidate",
) -> BacktestRequest:
    return BacktestRequest(
        CALENDAR, rows or bars(), signals, cost, portfolio or PortfolioConfig(100_000, 2, 0.5, 2),
        BacktestMetadata(
            "snapshot:portfolio", stable_hash({"dataset": 1}), "2026-01-10T00:00:00+00:00",
            stable_hash({"strategy": strategy}), stable_hash({"config": 1}), stable_hash({"execution": 1}),
            Instrument("CN", "SSE", "000300", "index"), stable_hash({"benchmark": 1}),
            "2026-02-01T00:00:00+00:00", "2026-02-01T00:00:01+00:00",
        ),
    )


class PortfolioTest(unittest.TestCase):
    def test_hand_computed_portfolio_and_backtest_run_contract(self) -> None:
        result = run_research_backtest(request((signal(1),)))
        self.assertEqual(len(result.trades), 1)
        trade = result.trades[0]
        self.assertEqual((trade.entry_date, trade.exit_date, trade.shares), ("2026-01-06", "2026-01-08", 5000))
        self.assertAlmostEqual(trade.pnl, 5000)
        self.assertAlmostEqual(result.run["metrics"]["totalReturn"]["value"], 0.05)
        self.assertEqual(result.run["engineTier"], "research")
        self.assertEqual(result.run["dataset"]["hash"], stable_hash({"dataset": 1}))
        self.assertEqual(result.run["strategyHash"], stable_hash({"strategy": "candidate"}))
        self.assertEqual(result.run["configHash"], stable_hash({"config": 1}))
        self.assertEqual(result.run["costModel"]["hash"], ZERO_COST.hash)
        self.assertEqual(result.run["benchmark"]["datasetHash"], stable_hash({"benchmark": 1}))
        identity = {key: value for key, value in result.run.items() if key not in ("id", "startedAt", "completedAt")}
        identity["artifacts"] = [{"kind": item["kind"], "hash": item["hash"]} for item in result.run["artifacts"]]
        self.assertEqual(result.run["id"], stable_hash(identity))

    def test_overlapping_signals_capacity_and_cash_have_explicit_rejections(self) -> None:
        overlap = run_research_backtest(request((signal(1), signal(2, day="2026-01-06"))))
        self.assertIn("overlapping-position", [item.reason for item in overlap.rejections])
        capacity = run_research_backtest(request(
            (signal(1), signal(2, B)), portfolio=PortfolioConfig(100_000, 1, 0.5, 2),
        ))
        self.assertIn("position-capacity", [item.reason for item in capacity.rejections])
        cash = run_research_backtest(request((signal(1),), portfolio=PortfolioConfig(500, 1, 1, 2)))
        self.assertIn("insufficient-cash", [item.reason for item in cash.rejections])

    def test_suspension_limit_and_missing_bar_reject_without_zero_return(self) -> None:
        scenarios = [
            (replace(next(row for row in bars() if row.instrument == A and row.date == "2026-01-06"), suspended=True), "suspended"),
            (replace(next(row for row in bars() if row.instrument == A and row.date == "2026-01-06"), open=10.78, high=10.78, close=10.78), "limit-up"),
        ]
        for replacement, expected in scenarios:
            with self.subTest(expected):
                rows = tuple(replacement if row.instrument == A and row.date == "2026-01-06" else row for row in bars())
                result = run_research_backtest(request((signal(1),), rows=rows))
                self.assertIn(expected, [item.reason for item in result.rejections])
                self.assertEqual(result.trades, ())
        missing_rows = tuple(row for row in bars() if not (row.instrument == A and row.date == "2026-01-06"))
        result = run_research_backtest(request((signal(1),), rows=missing_rows))
        self.assertIn("missing-bar", [item.reason for item in result.rejections])
        self.assertIsNone(result.run["metrics"]["winRate"]["value"])

    def test_candidate_and_benchmark_require_same_dates_universe_dataset_and_cost(self) -> None:
        candidate = request((signal(1),), strategy="candidate")
        benchmark = request((), strategy="benchmark")
        comparison = compare_candidate_to_benchmark(candidate, benchmark)
        self.assertAlmostEqual(comparison["excessReturn"]["value"], 0.05)
        with self.assertRaisesRegex(ValueError, "same cost model"):
            compare_candidate_to_benchmark(candidate, replace(benchmark, cost_model=AShareCostModel()))
        with self.assertRaisesRegex(ValueError, "same universe"):
            compare_candidate_to_benchmark(candidate, replace(benchmark, bars=bars((A,))))

    def test_duplicate_keys_future_availability_and_replay_are_fail_closed(self) -> None:
        base = request((signal(1),))
        self.assertEqual(run_research_backtest(base), run_research_backtest(base))
        with self.assertRaisesRegex(ValueError, "duplicate bar key"):
            run_research_backtest(replace(base, bars=base.bars + (base.bars[0],)))
        future = replace(base.bars[0], available_at="2027-01-01T00:00:00+00:00")
        with self.assertRaisesRegex(ValueError, "future-available"):
            run_research_backtest(replace(base, bars=(future,) + base.bars[1:]))
        with self.assertRaisesRegex(ValueError, "duplicate signal"):
            run_research_backtest(replace(base, signals=(signal(1), signal(1))))


if __name__ == "__main__":
    unittest.main()
