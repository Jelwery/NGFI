from copy import deepcopy
import unittest

from ngfi_quant.demo import demo_input
from ngfi_quant.factors.evaluation import EvaluationRegistration, evaluate_factors, validate_registration
from ngfi_quant.research_contracts import ResearchDataset
from ngfi_quant.factors.graph import factor_resource_estimate


def fixture():
    raw, spec = demo_input()
    dates = [day["date"] for day in raw["calendar"]]
    factor = spec["factors"][0]
    inverse = {"id": "inverse", "inputs": {"x": f"factor:{factor['id']}"},
               "nodes": [{"id": "n", "op": "NEGATE", "inputs": ["x"]}], "output": "n"}
    config = {"hypothesis": "test isolation", "factors": [factor, inverse],
              "train": {"start": dates[0], "end": dates[39]},
              "validation": {"start": dates[40], "end": dates[69]},
              "test": {"start": dates[70], "end": dates[99]},
              "horizons": [1], "minimumRankIc": -1.0, "minimumIcDays": 2}
    return raw, config


class FactorEvaluationTest(unittest.TestCase):
    def test_development_purges_labels_freezes_directions_and_prunes_signed_duplicates(self):
        raw, config = fixture()
        registration = EvaluationRegistration.model_validate(config)
        dataset = ResearchDataset.model_validate(raw)
        result = evaluate_factors(dataset, registration)
        self.assertEqual(result["testState"], "unseen")
        self.assertEqual(len(result["selection"]["selected"]), 1)
        self.assertEqual(sum(row["status"] == "rejected" for row in result["decisions"]), 1)
        self.assertAlmostEqual(result["correlations"][0]["spearman"], -1.0)
        daily = result["train"]["1"]["momentum_5"]["daily"]
        self.assertTrue(all(day["samples"] == 0 for day in daily[-3:]))
        with self.assertRaisesRegex(ValueError, "frozen"):
            evaluate_factors(dataset, registration, "test")
        test = evaluate_factors(dataset, registration, "test", result["selection"])
        self.assertEqual(test["testState"], "consumed")
        self.assertFalse(test["promotionEligible"])
        self.assertEqual(set(test["diagnostics"]["1"]), set(result["selection"]["selected"]))

    def test_future_price_changes_do_not_change_development_selection(self):
        raw, config = fixture()
        registration = EvaluationRegistration.model_validate(config)
        before = evaluate_factors(ResearchDataset.model_validate(raw), registration)
        changed = deepcopy(raw)
        for index, bar in enumerate(changed["bars"]):
            if index >= 70 * 8:
                for key in ("open", "high", "low", "close", "previousClose"):
                    bar[key] *= 1.2
                if index < 71 * 8:
                    bar["previousClose"] = raw["bars"][index]["previousClose"]
        after = evaluate_factors(ResearchDataset.model_validate(changed), registration)
        self.assertEqual(before["decisions"], after["decisions"])
        self.assertEqual(before["train"], after["train"])
        self.assertEqual(before["validation"], after["validation"])

    def test_invalid_splits_budget_and_missing_features(self):
        raw, config = fixture()
        for patch in ({"candidateBudget": 1}, {"test": config["validation"]}, {"horizons": [0]}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                EvaluationRegistration.model_validate({**config, **patch})
        config["factors"] = [{"id": "missing", "semanticsVersion": "3",
                              "inputs": {"x": "feature:roe"}, "fieldUnits": {"feature:roe": "dimensionless"},
                              "nodes": [], "output": "x"}]
        registration = EvaluationRegistration.model_validate(config)
        dataset = ResearchDataset.model_validate(raw)
        validated = validate_registration(dataset, registration)
        self.assertEqual(validated["trialCount"], 1)
        result = evaluate_factors(dataset, registration)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["missingFields"], ["feature:roe"])
        self.assertEqual(result["decisions"][0]["status"], "blocked")

    def test_registered_experiment_and_resource_budgets_fail_before_computation(self):
        raw, config = fixture()
        _, spec = demo_input()
        dates = [row["date"] for row in raw["calendar"]]
        spec.update(schemaVersion="3", factors=[config["factors"][0]], trainingStartDate=dates[0],
                    startDate=dates[70], endDate=dates[98])
        config["experimentSpec"] = spec
        config["styleControls"] = [{"controls": ["industry"], "horizon": 1}]
        registration = EvaluationRegistration.model_validate(config)
        with self.assertRaisesRegex(ValueError, "v3 dataset"):
            validate_registration(ResearchDataset.model_validate(raw), registration)
        raw["schemaVersion"] = "3"
        estimate = validate_registration(ResearchDataset.model_validate(raw), registration)["resources"]
        self.assertEqual(estimate["outputCells"], len(raw["bars"]) * len(config["factors"]))
        for patch in ({"trainingStartDate": dates[40]}, {"endDate": dates[99]}, {"schemaVersion": "2"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                EvaluationRegistration.model_validate({**config, "experimentSpec": {**spec, **patch}})
        panel = ResearchDataset.model_validate(raw)
        large = panel.model_copy(update={"bars": panel.bars * 300})
        # The estimator uses calendar x securities, not repeated input rows.
        self.assertEqual(factor_resource_estimate(large, registration.factors)["panelCells"], 800)
        large = panel.model_copy(update={"calendar": panel.calendar * 300})
        with self.assertRaisesRegex(ValueError, "working set"):
            factor_resource_estimate(large, [registration.factors[0].model_copy(update={"nodes": registration.factors[0].nodes * 30})])
        with self.assertRaisesRegex(ValueError, "two million"):
            factor_resource_estimate(large, registration.factors * 10)
