from copy import deepcopy
import unittest

import pandas as pd

from ngfi_quant.research_cli import demo_input
from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec, instant
from ngfi_quant.research_factors import build_panel, compute_factors
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

    def test_future_features_and_returns_cannot_change_prior_models_or_predictions(self):
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

    def test_hgb_uses_a_fixed_seed_without_random_validation_split(self):
        raw, config = demo_input()
        config["model"].update(kind="hist-gradient-boosting", maxIter=5)
        result = self.run_model(raw, config)
        self.assertEqual(result, self.run_model(raw, config))
        self.assertEqual(result["folds"][0]["model"]["kind"], "hist-gradient-boosting")

    def test_missing_training_history_is_not_reported_as_a_successful_model(self):
        raw, config = demo_input()
        config["model"]["minimumSamples"] = 10000
        with self.assertRaisesRegex(ValueError, "no OOS predictions"):
            self.run_model(raw, config)
        config["startDate"] = raw["calendar"][4]["date"]
        with self.assertRaisesRegex(ValueError, "insufficient pre-OOS history"):
            self.run_model(raw, config)

    def test_prediction_metrics_use_only_available_pairs(self):
        labels = pd.DataFrame([[0.01, 0.02, 0.03], [None, None, None]], index=["d1", "d2"], columns=["a", "b", "c"])
        predictions = {
            "d1": {"values": {"a": 0.01, "b": 0.02, "c": 0.03}},
            "d2": {"values": {"a": 1.0, "b": 2.0, "c": 3.0}},
        }
        result = prediction_diagnostics(predictions, labels)
        self.assertEqual(result["samples"], 3)
        self.assertEqual(result["rmse"], 0)
        self.assertEqual(result["meanRankIc"], 1)
        self.assertIsNone(result["daily"][1]["rankIc"])
