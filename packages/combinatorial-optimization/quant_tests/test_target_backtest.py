from copy import deepcopy
import unittest

from ngfi_quant.demo import demo_input
from ngfi_quant.experiment import replay_research
from ngfi_quant.factors.graph import build_panel
from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec


class TargetBacktestTest(unittest.TestCase):
    def inputs(self):
        raw, config = demo_input()
        raw["calendar"] = raw["calendar"][:5]
        raw["bars"] = raw["bars"][:40]
        for row in raw["bars"]:
            row.update(open=10.0, close=10.0, high=10.2, low=9.8, previousClose=10.0, volume=100000.0, amount=1000000.0)
        config.update(startDate=raw["calendar"][0]["date"], endDate=raw["calendar"][3]["date"])
        config["execution"].update(initialCapital=100000.0, rebalanceEvery=1, commissionRate=0.0,
                                   minimumCommission=0.0, stampDutyRate=0.0, transferFeeRate=0.0, slippageRate=0.0)
        return raw, config

    def replay(self, raw, config, policy=None):
        panel = build_panel(ResearchDataset.model_validate(raw))
        key = panel.securities[0]
        return replay_research(panel, ResearchSpec.model_validate(config), policy or (
            lambda index, account: {"status": "complete", "weights": {key: 0.5 if index == 0 else 0}}))

    def test_next_day_fixed_quantity_cash_and_actual_feedback(self):
        raw, config = self.inputs()
        accounts = []
        def policy(index, account):
            accounts.append(deepcopy(account))
            return {"status": "complete", "weights": {"CN:SSE:600000:equity": 0.5 if index == 0 else 0}}
        result = self.replay(raw, config, policy)
        self.assertEqual([row["side"] for row in result["fills"]], ["buy", "sell"])
        self.assertEqual(result["fills"][0]["quantity"], 5000)
        self.assertEqual(result["finalCash"], 100000)
        self.assertEqual(accounts[1]["quantities"]["CN:SSE:600000:equity"], 5000)
        self.assertEqual(result["metrics"]["returnObservations"], 4)

    def test_gap_does_not_resize_and_fees_are_cent_rounded(self):
        raw, config = self.inputs()
        raw["bars"][8].update(open=10.5, high=10.6)
        config["execution"]["minimumCommission"] = 10.0
        result = self.replay(raw, config)
        self.assertEqual(result["orders"][0]["requestedShares"], 5000)
        self.assertEqual(result["fills"][0]["quantity"], 5000)
        self.assertEqual(result["finalCash"], 97480)
        self.assertEqual(result["metrics"]["fees"], 20)

    def test_prior_capacity_partial_fill_and_expiry(self):
        raw, config = self.inputs()
        raw["bars"][0]["volume"] = 2000.0
        seen = []
        def policy(index, account):
            seen.append(account)
            return {"status": "complete", "weights": {"CN:SSE:600000:equity": 0.5}} if index == 0 else {"status": "failed", "reason": "infeasible"}
        result = self.replay(raw, config, policy)
        self.assertEqual(result["fills"][0]["quantity"], 100)
        self.assertEqual(result["orders"][0]["status"], "partial")
        self.assertEqual(len(result["orders"]), 1)
        self.assertEqual(seen[1]["quantities"]["CN:SSE:600000:equity"], 100)
        self.assertEqual(result["status"], "partial")

    def test_blocked_fills_and_slippage_follow_mainline(self):
        for reason in ("suspended", "limit-up", "slippage-outside-price-limit"):
            raw, config = self.inputs()
            if reason == "suspended":
                raw["bars"][8]["suspended"] = True
            elif reason == "limit-up":
                raw["bars"][8].update(open=11, high=11.2)
            else:
                raw["bars"][8].update(open=10.99, high=11)
                config["execution"]["slippageRate"] = 0.01
            with self.subTest(reason=reason):
                result = self.replay(raw, config)
                self.assertEqual(result["orders"][0]["reason"], reason)
                self.assertEqual(result["fills"], [])
                self.assertEqual(result["finalCash"], 100000)

    def test_non_rebalance_valuation_cannot_use_future_price(self):
        raw, config = self.inputs()
        config["execution"]["rebalanceEvery"] = 5
        raw["bars"][16]["availableAt"] = raw["calendar"][3]["openAt"]
        with self.assertRaisesRegex(ValueError, "valuation is not PIT-visible"):
            self.replay(raw, config)

    def test_per_asset_lots_and_zero_capacity(self):
        raw, config = self.inputs()
        for row in raw["bars"]:
            row["lotSize"] = 200
        raw["bars"][0]["volume"] = 1
        result = self.replay(raw, config)
        self.assertEqual(result["fills"], [])
        self.assertEqual(result["orders"][0]["filledShares"], 0)
