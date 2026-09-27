from copy import deepcopy
import unittest

from ngfi_quant.demo import demo_input
from ngfi_quant.experiment import equal_weight_baseline, run_experiment
from ngfi_quant.hashing import stable_hash
from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec


class ExperimentTest(unittest.TestCase):
    def test_frozen_baseline_reserves_budget(self):
        result = equal_weight_baseline(["a", "b", "c"], [0.3, 0, 0], [False, True, True], [True, False, False], 0.02)
        self.assertAlmostEqual(result["weights"]["a"], 0.3)
        self.assertAlmostEqual(result["weights"]["b"], 0.34)
        self.assertEqual(equal_weight_baseline(["a"], [0.99], [False], [True], 0.02)["status"], "failed")

    def test_workflow_is_reproducible_and_artifacts_reconcile(self):
        raw, config = demo_input()
        result = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config))
        self.assertEqual(result["status"], "complete", result["backtest"]["decisions"])
        self.assertTrue(result["summary"]["synthetic"])
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(result["summary"]["strategyValidationStatus"], "blocked")
        self.assertEqual(len(result["models"]), 4)
        self.assertGreater(result["modelDiagnostics"]["samples"], 0)
        self.assertGreater(len(result["backtest"]["fills"]), 0)
        self.assertEqual([row["date"] for row in result["backtest"]["equity"]], [row["date"] for row in result["benchmark"]["equity"]])
        for name, digest in result["artifactHashes"].items():
            self.assertEqual(stable_hash(result[name]), digest)
        self.assertEqual(result, run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config)))

    def test_cne6_failure_does_not_fallback(self):
        raw, config = demo_input()
        config["risk"]["source"] = "cne6"
        raw["cne6Models"] = [{"availableAt": "2099-01-01T00:00:00Z"}]
        result = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["backtest"]["fills"], [])
        self.assertTrue(all("CNE6" in row["reason"] for row in result["backtest"]["decisions"]))

    def test_top_k_and_cost_change_produce_distinct_evidence(self):
        raw, config = demo_input()
        config["optimizer"].update(method="top-k", topK=3, turnoverPenalty=0)
        normal = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(config))
        changed = deepcopy(config)
        changed["execution"].update(commissionRate=0.01, minimumCommission=100)
        costly = run_experiment(ResearchDataset.model_validate(raw), ResearchSpec.model_validate(changed))
        self.assertEqual(normal["status"], "complete")
        self.assertNotEqual(normal["id"], costly["id"])
        self.assertGreater(costly["backtest"]["metrics"]["fees"], normal["backtest"]["metrics"]["fees"])

    def test_v3_actual_benchmark_and_return_observations_reach_the_ledger(self):
        raw, config = demo_input()
        legacy = ResearchDataset.model_validate(raw).json()
        self.assertNotIn("benchmark", legacy)
        self.assertNotIn("modelExplanation", ResearchSpec.model_validate(config).json())
        raw["schemaVersion"] = config["schemaVersion"] = "3"
        raw["benchmark"] = {"instrument": "CN:SSE:000300:index", "convention": "price",
            "sourceHash": stable_hash("fixture-index"), "points": [
                {"date": row["date"], "value": 100.0, "availableAt": row["decisionAt"]} for row in raw["calendar"]]}
        prices = {}
        for bar in raw["bars"]:
            instrument = bar["instrument"]
            key = f'{instrument["market"]}:{instrument["exchange"]}:{instrument["symbol"]}:equity'
            prices[bar["date"], key] = bar["close"]
        securities = sorted({key for _, key in prices})
        raw["returnAttribution"] = [
            {"date": day["date"], "previousDate": previous["date"],
             "weightsAvailableAt": previous["decisionAt"], "factorReturnsAvailableAt": day["decisionAt"],
             "modelHash": stable_hash("fixture-model"), "sourceHash": stable_hash("fixture-returns"),
             "benchmarkWeights": {key: 1 / len(securities) for key in securities},
             "exposures": {key: {"COUNTRY": 1.0} for key in securities}, "factorKinds": {"COUNTRY": "country"},
             "factorReturns": {"COUNTRY": 0.0}, "industries": {key: "fixture" for key in securities},
             "specificReturns": {key: prices[day["date"], key] / prices[previous["date"], key] - 1 for key in securities}}
            for previous, day in zip(raw["calendar"], raw["calendar"][1:])]
        dataset = ResearchDataset.model_validate(raw)
        result = run_experiment(dataset, ResearchSpec.model_validate(config))
        self.assertEqual(result["summary"]["actualBenchmarkStatus"], "available")
        self.assertEqual(result["summary"]["returnAttributionStatus"], "complete")
        self.assertEqual(result["returnAttribution"]["linked"]["status"], "available")
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(result["summary"]["strategyValidationStatus"], "blocked")
        for name, digest in result["artifactHashes"].items():
            self.assertEqual(stable_hash(result[name]), digest)
        bad = deepcopy(raw)
        bad["returnAttribution"][0]["weightsAvailableAt"] = bad["calendar"][1]["decisionAt"]
        with self.assertRaisesRegex(ValueError, "future-available"):
            ResearchDataset.model_validate(bad)
        bad = deepcopy(raw)
        bad["schemaVersion"] = "2"
        with self.assertRaisesRegex(ValueError, "schemaVersion 3"):
            ResearchDataset.model_validate(bad)
