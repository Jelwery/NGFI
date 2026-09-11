from copy import deepcopy
import unittest

from ngfi_quant.research_cli import demo_input
from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec
from ngfi_quant.research_factors import build_panel
from ngfi_quant.target_backtest import replay_targets


class TargetBacktestTest(unittest.TestCase):
    def inputs(self):
        raw, config = demo_input()
        raw["calendar"] = raw["calendar"][:5]
        raw["bars"] = raw["bars"][:40]
        for row in raw["bars"]:
            row.update(open=10.0, close=10.0, high=10.2, low=9.8, previousClose=10.0,
                       volume=100000.0, amount=1000000.0)
        config.update(startDate=raw["calendar"][0]["date"], endDate=raw["calendar"][3]["date"])
        config["execution"].update(initialCapital=100000.0, rebalanceEvery=1,
                                   commissionRate=0.0, minimumCommission=0.0, stampDutyRate=0.0,
                                   transferFeeRate=0.0, slippageRate=0.0)
        return raw, config

    def test_next_day_fills_and_t_plus_one_cash_reconciliation(self):
        raw, config = self.inputs()
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        result = replay_targets(panel, ResearchSpec.model_validate(config),
                                lambda index, current: {"status": "complete", "weights": {key: 0.5 if index == 0 else 0.0}})
        self.assertEqual([fill["side"] for fill in result["fills"]], ["buy", "sell"])
        self.assertEqual([fill["date"] for fill in result["fills"]], panel.dates[1:3])
        self.assertEqual(result["fills"][0]["shares"], 5000)
        self.assertEqual(result["finalCash"], 100000)
        self.assertEqual(result["metrics"]["totalReturn"], 0)
        for point in result["equity"]:
            self.assertAlmostEqual(point["nav"], point["cash"] + point["holdingsValue"])
        self.assertEqual(result["decisions"][1]["currentWeights"][key], 0.5)

    def test_suspension_and_price_limit_rejections_preserve_actual_cash(self):
        raw, config = self.inputs()
        for reason in ("suspended", "limit-up"):
            with self.subTest(reason=reason):
                data = deepcopy(raw)
                bar = data["bars"][8]
                if reason == "suspended":
                    bar["suspended"] = True
                else:
                    bar["open"] = 11.0
                    bar["high"] = 11.2
                panel = build_panel(ResearchDataset.model_validate(data))
                key = panel.securities[0]
                result = replay_targets(panel, ResearchSpec.model_validate(config),
                                        lambda index, current: {"status": "complete", "weights": {key: 0.5 if index == 0 else 0.0}})
                self.assertEqual(result["orders"][0]["reason"], reason)
                self.assertEqual(result["fills"], [])
                self.assertEqual(result["finalCash"], 100000)

    def test_prior_volume_capacity_and_failed_decisions_do_not_fabricate_fills(self):
        raw, config = self.inputs()
        raw["bars"][0]["volume"] = 2000.0
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        result = replay_targets(panel, ResearchSpec.model_validate(config),
                                lambda index, current: {"status": "complete", "weights": {key: 0.5}}
                                if index == 0 else {"status": "failed", "reason": "infeasible"})
        self.assertEqual(result["fills"][0]["shares"], 100)
        self.assertEqual(result["orders"][0]["status"], "partial")
        self.assertEqual(result["decisions"][1]["currentWeights"][key], 0.01)
        self.assertEqual(result["finalPositions"][key], 100)
        self.assertEqual(result["status"], "partial")

    def test_fees_and_initial_drawdown_include_the_first_trade(self):
        raw, config = self.inputs()
        config["execution"]["minimumCommission"] = 10.0
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        result = replay_targets(panel, ResearchSpec.model_validate(config),
                                lambda index, current: {"status": "complete", "weights": {key: 0.5 if index == 0 else 0.0}})
        self.assertEqual(result["finalCash"], 99980)
        self.assertEqual(result["metrics"]["fees"], 20)
        self.assertAlmostEqual(result["metrics"]["maxDrawdown"], -0.0002)

    def test_overnight_gap_does_not_resize_the_submitted_order(self):
        raw, config = self.inputs()
        raw["bars"][8].update(open=10.5, high=10.6)
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        result = replay_targets(panel, ResearchSpec.model_validate(config),
                                lambda index, current: {"status": "complete", "weights": {key: 0.5 if index == 0 else 0.0}})
        self.assertEqual(result["orders"][0]["requestedShares"], 5000)
        self.assertEqual(result["fills"][0]["shares"], 5000)
        self.assertEqual(result["fills"][0]["price"], 10.5)
        self.assertEqual(result["finalCash"], 97500)
        self.assertEqual(result["metrics"]["returnObservations"], 4)
        self.assertAlmostEqual(result["metrics"]["annualizedReturn"], 0.975 ** (252 / 4) - 1)

    def test_slippage_cannot_cross_the_execution_day_price_limit(self):
        raw, config = self.inputs()
        raw["bars"][8].update(open=10.99, high=11.0)
        config["execution"]["slippageRate"] = 0.01
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        result = replay_targets(
            panel,
            ResearchSpec.model_validate(config),
            lambda index, current: {
                "status": "complete",
                "weights": {key: 0.5 if index == 0 else 0.0},
            },
        )
        self.assertEqual(result["fills"][0]["price"], 11.0)

    def test_held_security_close_must_be_visible_before_daily_valuation(self):
        raw, config = self.inputs()
        raw["bars"][16]["availableAt"] = raw["calendar"][3]["openAt"]
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        with self.assertRaisesRegex(ValueError, "valuation is not PIT-visible"):
            replay_targets(
                panel,
                ResearchSpec.model_validate(config),
                lambda index, current: {
                    "status": "complete",
                    "weights": {key: 0.5},
                },
            )

    def test_turnover_uses_each_equity_observation_once(self):
        raw, config = self.inputs()
        raw["bars"][16].update(open=12.0, close=12.0, high=12.2, previousClose=10.0)
        raw["bars"][24]["previousClose"] = 12.0
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        result = replay_targets(
            panel,
            ResearchSpec.model_validate(config),
            lambda index, current: {
                "status": "complete",
                "weights": {key: 0.5 if index == 0 else 0.0},
            },
        )
        average_nav = sum(point["nav"] for point in result["equity"]) / len(result["equity"])
        self.assertAlmostEqual(
            result["metrics"]["turnover"],
            result["metrics"]["tradedNotional"] / average_nav,
        )
