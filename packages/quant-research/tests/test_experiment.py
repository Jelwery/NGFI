from copy import deepcopy
import unittest

from ngfi_quant.experiment import equal_weight_baseline, run_experiment
from ngfi_quant.hashing import stable_hash
from ngfi_quant.research_cli import demo_input
from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec


class ExperimentTest(unittest.TestCase):
    def test_equal_weight_baseline_reserves_budget_for_frozen_positions(self):
        result = equal_weight_baseline(
            ["a", "b", "c"],
            current=[0.30, 0.0, 0.0],
            eligible=[False, True, True],
            frozen=[True, False, False],
            cash_reserve=0.02,
        )
        self.assertEqual(result["status"], "complete")
        self.assertAlmostEqual(result["weights"]["a"], 0.30)
        self.assertAlmostEqual(result["weights"]["b"], 0.34)
        self.assertAlmostEqual(result["weights"]["c"], 0.34)
        self.assertAlmostEqual(sum(result["weights"].values()), 0.98)

        infeasible = equal_weight_baseline(
            ["a"],
            current=[0.99],
            eligible=[False],
            frozen=[True],
            cash_reserve=0.02,
        )
        self.assertEqual(infeasible["status"], "failed")

    def test_full_workflow_has_verified_artifact_hashes_and_a_fair_execution_benchmark(self):
        raw, config = demo_input()
        result = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config))
        self.assertEqual(result["status"], "complete")
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(len(result["models"]), 4)
        self.assertGreater(result["modelDiagnostics"]["samples"], 0)
        self.assertEqual(len(result["correlations"]), 6)
        self.assertEqual(len(result["summary"]["factorDefinitions"]), 3)
        self.assertGreater(result["backtest"]["metrics"]["fillCount"], 0)
        self.assertEqual([point["date"] for point in result["backtest"]["equity"]],
                         [point["date"] for point in result["benchmark"]["equity"]])
        for name, identity in result["artifactHashes"].items():
            self.assertEqual(stable_hash(result[name]), identity)
        repeat = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config))
        self.assertEqual(result, repeat)

    def test_failed_cne6_risk_does_not_silently_fallback(self):
        raw, config = demo_input()
        raw["cne6Models"] = [{"availableAt": "2099-01-01T00:00:00+00:00"}]
        result = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["backtest"]["metrics"]["fillCount"], 0)
        self.assertTrue(all("CNE6" in item["reason"] for item in result["backtest"]["decisions"]))

    def test_higher_costs_reduce_fixed_target_portfolio_returns(self):
        raw, config = demo_input()
        config["optimizer"].update(method="top-k", topK=3, turnoverPenalty=0.0)
        normal = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config))
        stressed = deepcopy(config)
        stressed["execution"].update(commissionRate=0.01, minimumCommission=100.0)
        costly = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(stressed))
        self.assertLess(costly["backtest"]["metrics"]["totalReturn"], normal["backtest"]["metrics"]["totalReturn"])
        self.assertNotEqual(normal["id"], costly["id"])
