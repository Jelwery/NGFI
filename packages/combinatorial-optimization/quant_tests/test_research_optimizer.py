from copy import deepcopy
import unittest

import numpy as np

from ngfi_quant.demo import demo_input
from ngfi_quant.factors.graph import build_panel
from ngfi_quant.optimizer import optimize_portfolio, optimize_research_weights, plan_research_orders, research_covariance, validate_cne6_risk
from ngfi_quant.hashing import stable_hash
from ngfi_quant.research_contracts import OptimizerSpec, ResearchDataset, ResearchSpec, instant
from test_optimizer import example_input


class ResearchOptimizerTest(unittest.TestCase):
    def solve(self, **changes):
        spec = OptimizerSpec.model_validate({"maxWeight": 0.6, "cashReserve": 0.1, **changes})
        return optimize_research_weights(["a", "b"], np.array([0.03, 0.01]), np.eye(2) * 0.01,
                                        np.zeros(2), np.ones(2, dtype=bool), ["bank", "bank"], spec)

    def test_large_liquidity_grid_does_not_allocate_oracle_ranges(self):
        payload = example_input()
        for asset in payload["assets"]:
            asset["advNotional"] = 1e18
        payload["inputHash"] = stable_hash({key: value for key, value in payload.items() if key != "inputHash"})
        result = optimize_portfolio(payload)
        self.assertEqual(result["status"], "ok", result["rejectionReasons"])
        self.assertNotIn("lotOracle", result)

    def test_mean_variance_and_turnover_units(self):
        result = self.solve(maxTurnover=0.4, turnoverPenalty=0.003)
        self.assertEqual(result["status"], "complete")
        self.assertLessEqual(sum(result["weights"].values()), 0.4 + 1e-7)
        self.assertEqual(result["internalTurnoverLimit"], 0.2)
        self.assertEqual(result["internalTurnoverPenalty"], 0.006)
        self.assertEqual(result["objectiveMode"], "forecast-mean-variance")
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(result["solver"], "CLARABEL")

    def test_top_k_retains_frozen_holdings_and_separate_candidate_count(self):
        spec = OptimizerSpec.model_validate({"method": "top-k", "topK": 1, "maxWeight": 0.6, "cashReserve": 0.1})
        result = optimize_research_weights(["a", "b", "c"], np.array([0.3, 0.2, 0.1]), np.eye(3) * 0.01,
                                          np.array([0, 0, 0.2]), np.ones(3, dtype=bool), ["bank"] * 3,
                                          spec, frozen=np.array([False, False, True]))
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["selectedCandidates"], ["a"])
        self.assertAlmostEqual(result["weights"]["c"], 0.2)
        self.assertLess(result["weights"]["b"], 1e-7)
        result = optimize_research_weights(["a"], np.array([0.3]), np.eye(1), np.array([0.9]),
                                          np.array([True]), ["bank"], spec, frozen=np.array([True]))
        self.assertEqual(result["status"], "failed")
        self.assertIn("infeasible", result["reason"])

    def test_invalid_covariance_and_masks_reject(self):
        spec = OptimizerSpec()
        for covariance, eligible in ((np.array([[1, 2], [2, 1]]), np.ones(2, dtype=bool)),
                                     (np.eye(2), np.ones(2))):
            with self.assertRaises(ValueError):
                optimize_research_weights(["a", "b"], np.zeros(2), covariance, np.zeros(2), eligible, ["bank"] * 2, spec)

    def test_cne6_reuses_a3_quality_and_horizon_variance(self):
        payload = example_input()
        policy = payload["mandate"]["qualityPolicy"]
        snapshot = payload["riskSnapshot"]
        keys = [f"{row['instrument']['market']}:{row['instrument']['exchange']}:{row['instrument']['symbol']}:equity" for row in snapshot["securities"]]
        _, f, x, specific, coverage = validate_cne6_risk(snapshot, keys, instant(payload["asOf"]), 5, policy)
        self.assertEqual(coverage, 1)
        np.testing.assert_allclose(x @ f @ x.T + np.diag(specific ** 2), snapshot["stockCovariance"], atol=1e-12)
        invalid = deepcopy(snapshot)
        invalid["sourceQuality"]["proxyFlags"] = ["future-industry"]
        with self.assertRaisesRegex(ValueError, "proxy"):
            validate_cne6_risk(invalid, keys, instant(payload["asOf"]), 5, policy)

    def test_native_plan_uses_shared_lots_and_cash_diagnostics(self):
        raw, config = demo_input()
        panel = build_panel(ResearchDataset.model_validate(raw))
        spec = ResearchSpec.model_validate(config)
        expected = np.linspace(0.01, 0.08, 8)
        covariance, _ = research_covariance(panel, 55, spec)
        result = optimize_research_weights(panel.securities, expected, covariance, np.zeros(8),
                                          np.ones(8, dtype=bool), [panel.bars[panel.dates[55], key].industry for key in panel.securities], spec.optimizer)
        plan = plan_research_orders(panel, 55, spec, {"cash": 1_000_000, "nav": 1_000_000, "quantities": {}, "sellableNextDay": {}},
                                    result, expected, covariance)
        self.assertEqual(plan["status"], "complete", plan.get("reason"))
        self.assertTrue(all(value % 100 == 0 for value in plan["quantities"].values()))
        self.assertTrue(all(row["satisfied"] for row in plan["constraintDiagnostics"]))
        self.assertGreaterEqual(plan["estimatedCash"], 0)

    def test_explicit_risk_source_never_falls_back(self):
        raw, config = demo_input()
        panel = build_panel(ResearchDataset.model_validate(raw))
        one = ResearchSpec.model_validate(config)
        covariance, lineage = research_covariance(panel, 55, one)
        config["model"]["horizon"] = 10
        double, _ = research_covariance(panel, 55, ResearchSpec.model_validate(config))
        np.testing.assert_allclose(double, covariance * 2)
        self.assertEqual(lineage["riskSource"], "LedoitWolf")
        config["risk"]["source"] = "cne6"
        with self.assertRaisesRegex(ValueError, "no silent risk fallback"):
            research_covariance(panel, 55, ResearchSpec.model_validate(config))
