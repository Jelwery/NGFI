from __future__ import annotations

from dataclasses import replace
import unittest

from ngfi_quant import (
    AShareBar, AShareCostModel, BacktestMetadata, BacktestRequest, CandidateSignal, Instrument,
    PortfolioConfig, compare_candidate_to_benchmark, run_research_backtest, stable_hash,
    TargetSchedule, CorporateAction, BenchmarkPoint, AttributionDay,
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


class DailyPortfolioTest(unittest.TestCase):
    def scheduled_request(self):
        rows = tuple(replace(row, open=10, high=10, low=10, close=10, previous_close=10,
                             can_buy=True, can_sell=True, status_available_at=f"{row.date}T09:00:00+08:00",
                             adv_notional=1_000_000, adv_available_at=f"{row.date}T09:00:00+08:00") for row in bars())
        schedules = (TargetSchedule(CALENDAR[0], f"{CALENDAR[0]}T09:00:00+08:00", {A.key: 0.5}),
                     TargetSchedule(CALENDAR[1], f"{CALENDAR[1]}T09:00:00+08:00", {B.key: 0.5}),
                     TargetSchedule(CALENDAR[2], f"{CALENDAR[2]}T09:00:00+08:00", {}))
        return replace(request((), rows=rows), target_schedules=schedules, max_participation=0.1)

    def test_daily_targets_sell_before_buy_and_exact_cash(self):
        result = run_research_backtest(self.scheduled_request())
        self.assertEqual(result.daily_ledger[0]["quantities"], {A.key: 5000})
        self.assertEqual([row["side"] for row in result.daily_ledger[1]["fills"]], ["sell", "buy"])
        self.assertEqual(result.daily_ledger[1]["quantities"], {B.key: 5000})
        self.assertEqual(result.daily_ledger[2]["quantities"], {})
        self.assertEqual(result.final_cash, 100000)
        self.assertEqual(len(result.trades), 2)
        self.assertEqual(result, run_research_backtest(self.scheduled_request()))

    def test_new_schedule_requires_pit_status_adv_and_raw_prices(self):
        base = self.scheduled_request()
        scenarios = [(dict(can_buy=None), "missing-status"),
                     (dict(status_available_at="2027-01-01T09:00:00+08:00"), "future-status"),
                     (dict(adv_notional=None), "missing-adv"),
                     (dict(adv_available_at="2027-01-01T09:00:00+08:00"), "future-adv")]
        for changes, expected in scenarios:
            with self.subTest(expected):
                result = run_research_backtest(replace(base, bars=tuple(replace(row, **changes) for row in base.bars)))
                self.assertIn(expected, [row.reason for row in result.rejections])
                self.assertEqual(result.final_cash, 100000)
        with self.assertRaisesRegex(ValueError, "raw prices"):
            run_research_backtest(replace(base, bars=tuple(replace(row, price_basis="adjusted") for row in base.bars)))
        with self.assertRaisesRegex(ValueError, "future-available"):
            run_research_backtest(replace(base, target_schedules=(TargetSchedule(CALENDAR[0], "2026-01-05T10:00:00+08:00", {A.key: 0.5}),)))

    def test_sparse_valuation_keeps_missing_dates_and_final_missing_is_not_stale_return(self):
        base = request((signal(1),), portfolio=PortfolioConfig(100000, 1, 0.5, 10))
        rows = tuple(replace(row, close=None) if row.instrument == A and row.date in (CALENDAR[2], CALENDAR[-1]) else row for row in base.bars)
        result = run_research_backtest(replace(base, bars=rows))
        self.assertEqual(result.equity[2].status, "missing")
        self.assertIsNone(result.equity[2].value)
        self.assertEqual(result.equity[-1].status, "missing")
        self.assertIsNone(result.run["metrics"]["totalReturn"]["value"])
        self.assertIsNone(result.run["metrics"]["sharpe"]["value"])
        self.assertEqual(result.run["status"], "partial")

    def test_splits_and_dividends_book_once_with_raw_fills(self):
        base = self.scheduled_request()
        action = CorporateAction("split-dividend", CALENDAR[1], A, f"{CALENDAR[1]}T08:00:00+08:00", 2, 0.1)
        rows = tuple(replace(row, open=5, high=5, low=5, close=5, previous_close=5)
                     if row.instrument == A and row.date >= CALENDAR[1] else row for row in base.bars)
        schedules = (base.target_schedules[0], TargetSchedule(CALENDAR[2], f"{CALENDAR[2]}T08:00:00+08:00", {}))
        result = run_research_backtest(replace(base, bars=rows, corporate_actions=(action,), target_schedules=schedules))
        self.assertEqual(result.daily_ledger[1]["quantities"], {A.key: 10000})
        self.assertEqual(result.daily_ledger[1]["cash"], 50500)
        self.assertEqual(result.final_cash, 100500)
        self.assertEqual(result.trades[0].pnl, 500)
        self.assertEqual(result.trades[0].shares, 10000)
        self.assertEqual(sum(len(row["corporateActions"]) for row in result.daily_ledger), 1)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            run_research_backtest(replace(base, corporate_actions=(action, action)))

    def test_effective_dated_costs_do_not_rewrite_earlier_trades(self):
        base = self.scheduled_request()
        changed = AShareCostModel("new-fees", "1", 0, 0, 0.01, 0, 0)
        result = run_research_backtest(replace(base, cost_schedule=((CALENDAR[1], changed),)))
        self.assertEqual(result.daily_ledger[0]["costs"], 0)
        self.assertEqual(result.daily_ledger[1]["fills"][0]["fees"]["stampDuty"], 500)
        self.assertEqual(result.daily_ledger[1]["costModelHash"], changed.hash)
        with self.assertRaisesRegex(ValueError, "strictly ordered"):
            run_research_backtest(replace(base, cost_schedule=((CALENDAR[1], changed), (CALENDAR[0], ZERO_COST))))

    def test_dividend_receivable_is_not_spendable_until_pay_date(self):
        base = self.scheduled_request()
        schedules = (base.target_schedules[0],)
        action = CorporateAction("dividend", CALENDAR[1], A, f"{CALENDAR[1]}T08:00:00+08:00", 1, 0.1, CALENDAR[3])
        result = run_research_backtest(replace(base, target_schedules=schedules, corporate_actions=(action,)))
        self.assertEqual(result.daily_ledger[1]["cash"], 50000)
        self.assertEqual(result.daily_ledger[1]["receivableDividends"], 500)
        self.assertEqual(result.daily_ledger[3]["cash"], 50500)
        self.assertEqual(result.daily_ledger[3]["receivableDividends"], 0)
        self.assertEqual(result.equity[1].value, result.equity[3].value)

    def test_benchmark_requires_values_and_attribution_reconciles(self):
        base = self.scheduled_request()
        metadata_only = run_research_backtest(base)
        self.assertEqual(metadata_only.run["benchmark"]["status"], "missing")
        self.assertEqual(metadata_only.run["status"], "partial")
        points = tuple(BenchmarkPoint(day, 100 + index, f"{day}T16:00:00+08:00") for index, day in enumerate(CALENDAR))
        attributes = tuple(AttributionDay(day, f"{day}T08:00:00+08:00", {A.key: 0.5, B.key: 0.5},
                                         {A.key: {"BANK": 1, "SIZE": 1}, B.key: {"BANK": 1, "SIZE": -1}},
                                         {"BANK": "industry", "SIZE": "style"}, {"BANK": 0.001, "SIZE": 0.002},
                                         f"{day}T16:00:00+08:00") for day in CALENDAR[1:])
        result = run_research_backtest(replace(base, benchmark_series=points, attribution=attributes))
        self.assertEqual(result.run["benchmark"]["status"], "available")
        self.assertAlmostEqual(result.run["metrics"]["activeReturn"]["value"], -0.04)
        self.assertAlmostEqual(result.daily_ledger[-1]["linkedAttribution"]["activeReturn"], -0.04)
        self.assertAlmostEqual(result.daily_ledger[-1]["linkedAttribution"]["reconciliationError"], 0)
        for row in result.attribution:
            self.assertEqual(row["status"], "available", row)
            self.assertAlmostEqual(sum(row["components"].values()), row["activeReturn"])
            self.assertEqual(set(row["components"]), {"industry", "style", "residualSelection", "cash", "cost", "tradingTimingResidual"})
        with self.assertRaisesRegex(ValueError, "actual benchmark"):
            run_research_backtest(replace(base, attribution=attributes))
        with self.assertRaisesRegex(ValueError, "future-available"):
            bad = replace(attributes[0], weights_available_at="2027-01-01T00:00:00Z")
            run_research_backtest(replace(base, benchmark_series=points, attribution=(bad,)))


if __name__ == "__main__":
    unittest.main()
