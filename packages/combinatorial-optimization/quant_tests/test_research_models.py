from copy import deepcopy
import unittest

import pandas as pd

from ngfi_quant.demo import demo_input
from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec, instant
from ngfi_quant.factors.graph import build_panel, compute_factors
from ngfi_quant.research_models import prediction_diagnostics, rolling_predict


class ResearchModelsTest(unittest.TestCase):
    def run_model(self, raw, config):
        panel = build_panel(ResearchDataset.model_validate(raw))
        spec = ResearchSpec.model_validate(config)
        return rolling_predict(panel, compute_factors(panel, spec.factors), spec)

    def test_ridge_folds_are_purged_and_reproducible(self):
        raw, config = demo_input()
        first = self.run_model(raw, config)
        self.assertEqual(first, self.run_model(raw, config))
        self.assertEqual(len(first["folds"]), 4)
        self.assertEqual(len(first["predictions"]), 39)
        for fold in first["folds"]:
            self.assertLess(fold["trainEnd"], fold["predictStart"])
            self.assertLessEqual(instant(fold["maxLabelAvailableAt"]), instant(fold["fitAsOf"]))
            self.assertEqual(len(fold["state"]["coef"]), 3)
            self.assertEqual(fold["status"], "complete")

    def test_future_prices_do_not_change_prior_folds_or_predictions(self):
        raw, config = demo_input()
        before = self.run_model(raw, config)
        changed = deepcopy(raw)
        boundary = raw["calendar"][75]["date"]
        for bar in changed["bars"]:
            if bar["date"] >= boundary:
                for key in ("open", "close", "high", "low", "previousClose"):
                    bar[key] *= 1.2
        for stock in range(8):
            changed["bars"][75 * 8 + stock]["previousClose"] = changed["bars"][74 * 8 + stock]["close"]
        after = self.run_model(changed, config)
        for day, values in before["predictions"].items():
            if day < boundary:
                self.assertEqual(values, after["predictions"][day])
        self.assertEqual(before["folds"][:2], after["folds"][:2])

    def test_hgb_uses_fixed_seed_without_random_validation(self):
        raw, config = demo_input()
        config["model"].update(kind="hist-gradient-boosting", maxIter=5)
        result = self.run_model(raw, config)
        self.assertEqual(result, self.run_model(raw, config))
        self.assertEqual(result["folds"][0]["model"]["kind"], "hist-gradient-boosting")

    def test_insufficient_history_and_misaligned_factors_fail(self):
        raw, config = demo_input()
        config["model"]["minimumSamples"] = 10000
        with self.assertRaisesRegex(ValueError, "no OOS predictions"):
            self.run_model(raw, config)
        config["startDate"] = raw["calendar"][4]["date"]
        with self.assertRaisesRegex(ValueError, "insufficient pre-OOS history"):
            self.run_model(raw, config)
        raw, config = demo_input()
        panel = build_panel(ResearchDataset.model_validate(raw))
        spec = ResearchSpec.model_validate(config)
        factors = compute_factors(panel, spec.factors)
        factors[spec.factors[0].id] = factors[spec.factors[0].id].iloc[:, ::-1]
        with self.assertRaisesRegex(ValueError, "align"):
            rolling_predict(panel, factors, spec)

    def test_metrics_use_only_available_pairs(self):
        labels = pd.DataFrame([[0.01, 0.02, 0.03], [None, None, None]], index=["d1", "d2"], columns=["a", "b", "c"])
        predictions = {"d1": {"values": {"a": 0.01, "b": 0.02, "c": 0.03}},
                       "d2": {"values": {"a": 1.0, "b": 2.0, "c": 3.0}}}
        result = prediction_diagnostics(predictions, labels)
        self.assertEqual(result["samples"], 3)
        self.assertEqual(result["rmse"], 0)
        self.assertEqual(result["meanRankIc"], 1)
        self.assertIsNone(result["daily"][1]["rankIc"])

    def test_v3_ridge_contributions_reconcile_after_preprocessing(self):
        raw, config = demo_input()
        config["schemaVersion"] = "3"
        result = self.run_model(raw, config)
        self.assertTrue(result["attribution"]["rows"])
        for row in result["attribution"]["rows"]:
            with self.subTest(date=row["date"], instrument=row["instrument"]):
                prediction = result["predictions"][row["date"]]["values"][row["instrument"]]
                self.assertAlmostEqual(row["intercept"] + sum(row["contributions"].values()), prediction, places=12)
                self.assertLess(abs(row["reconciliationError"]), 1e-10)

    def test_v3_model_features_exclude_computational_dependencies(self):
        raw, config = demo_input()
        parent = config["factors"][0]
        child = {"id": "child", "inputs": {"x": f"factor:{parent['id']}"},
                 "nodes": [{"id": "n", "op": "NEGATE", "inputs": ["x"]}], "output": "n"}
        config.update(schemaVersion="3", factors=[parent, child], modelFeatures=["child"])
        result = self.run_model(raw, config)
        self.assertTrue(all(fold["features"] == ["child"] for fold in result["folds"]))
        self.assertTrue(all(set(row["contributions"]) == {"child"} for row in result["attribution"]["rows"]))
        self.assertEqual(result, self.run_model(raw, config))
        for features in ([], ["child", "child"], ["absent"]):
            with self.subTest(features=features), self.assertRaises(ValueError):
                ResearchSpec.model_validate({**config, "modelFeatures": features})
        with self.assertRaisesRegex(ValueError, "schemaVersion 3"):
            ResearchSpec.model_validate({**config, "schemaVersion": "2"})
        with self.assertRaisesRegex(ValueError, "unknown factors"):
            ResearchSpec.model_validate({**config, "modelExplanation": {
                "groups": {"dependency": [parent["id"]]}, "methods": ["training-mean-ablation"]}})
        legacy = ResearchSpec.model_validate(demo_input()[1]).json()
        self.assertNotIn("modelFeatures", legacy)

    def test_v3_group_diagnostics_are_registered_and_label_mature(self):
        raw, config = demo_input()
        config.update(schemaVersion="3", modelExplanation={
            "groups": {"all": [factor["id"] for factor in config["factors"]]},
            "methods": ["within-date-permutation", "training-mean-ablation"], "repeats": 2, "seed": 17})
        config["model"].update(kind="hist-gradient-boosting", maxIter=3)
        result = self.run_model(raw, config)
        self.assertEqual(result, self.run_model(raw, config))
        rows = result["attribution"]["groupDiagnostics"]
        self.assertTrue(any(row["predictionRmseChange"] > 0 for row in rows))
        for row in rows:
            with self.subTest(date=row["date"], method=row["method"]):
                self.assertIsNotNone(row["modelId"])
                if row["date"] == config["endDate"]:
                    self.assertEqual(row["labelSamples"], 0)
                    self.assertIsNone(row["mseIncrease"])
        bad = deepcopy(config)
        bad["modelExplanation"]["groups"]["unknown"] = ["absent"]
        with self.assertRaisesRegex(ValueError, "unknown factors"):
            ResearchSpec.model_validate(bad)
        bad = deepcopy(config)
        bad["schemaVersion"] = "2"
        with self.assertRaisesRegex(ValueError, "schemaVersion 3"):
            ResearchSpec.model_validate(bad)
