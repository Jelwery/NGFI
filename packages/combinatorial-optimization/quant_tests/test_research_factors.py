from copy import deepcopy
import unittest

import numpy as np
import pandas as pd

from ngfi_quant.demo import demo_input
from ngfi_quant.research_contracts import FactorDefinition, ResearchDataset, ResearchSpec
from ngfi_quant.factors.graph import build_panel, compute_factors, forward_labels, factor_diagnostics, factor_correlations, factor_catalog


class ResearchFactorsTest(unittest.TestCase):
    def setUp(self):
        self.raw, config = demo_input()
        self.spec = ResearchSpec.model_validate(config)
        self.panel = build_panel(ResearchDataset.model_validate(self.raw))

    def test_graph_operators_match_direct_math(self):
        x, y = self.panel.fields["close"], self.panel.fields["open"]
        cases = {
            "ADD": (["x", "y"], {}, x + y), "SUB": (["x", "y"], {}, x - y),
            "DIV": (["x", "y"], {}, x / y), "MUL_PANEL": (["x", "y"], {}, x * y),
            "ADD_CONST": (["x"], {"value": 2}, x + 2), "MUL": (["x"], {"value": 2}, x * 2),
            "NEGATE": (["x"], {}, -x), "ABS": (["x"], {}, x.abs()), "LOG": (["x"], {}, np.log(x)),
            "DELAY": (["x"], {"window": 3}, x.shift(3)), "RETURN": (["x"], {"window": 3}, x / x.shift(3) - 1),
            "STD": (["x"], {"window": 3}, x.rolling(3).std(ddof=0)),
            "TS_SUM": (["x"], {"window": 3}, x.rolling(3).sum()), "TS_MIN": (["x"], {"window": 3}, x.rolling(3).min()),
            "TS_MAX": (["x"], {"window": 3}, x.rolling(3).max()), "SMA": (["x"], {"window": 3}, x.rolling(3).mean()),
            "RANK": (["x"], {}, x.rank(axis=1, pct=True)),
        }
        for op, (inputs, params, expected) in cases.items():
            with self.subTest(op=op):
                definition = FactorDefinition.model_validate({"id": "test", "inputs": {"x": "close", "y": "open"},
                    "nodes": [{"id": "n", "op": op, "inputs": inputs, "params": params}], "output": "n"})
                pd.testing.assert_frame_equal(compute_factors(self.panel, [definition])["test"], expected)

    def test_labels_use_calendar_next_open_and_status_maturity(self):
        labels, boundaries = forward_labels(self.panel, 5)
        key = self.panel.securities[0]
        self.assertAlmostEqual(labels.iloc[0][key], self.panel.bars[self.panel.dates[6], key].open / self.panel.bars[self.panel.dates[1], key].open - 1)
        self.assertEqual(boundaries[self.panel.dates[0]][0], self.panel.dates[6])
        self.assertTrue(labels.iloc[-6:].isna().all().all())
        self.raw["bars"][6 * 8]["statusAvailableAt"] = self.raw["calendar"][9]["decisionAt"]
        _, changed = forward_labels(build_panel(ResearchDataset.model_validate(self.raw)), 5)
        self.assertIn(self.panel.dates[9], changed[self.panel.dates[0]][1])

    def test_pit_prices_features_and_status_remain_unavailable(self):
        self.raw["bars"][0]["availableAt"] = self.raw["calendar"][1]["decisionAt"]
        self.raw["bars"][1]["statusAvailableAt"] = self.raw["calendar"][1]["decisionAt"]
        self.raw["bars"][2]["features"] = {"roe": {"value": 0.2, "availableAt": self.raw["calendar"][1]["decisionAt"], "sourceHash": "sha256:" + "b" * 64}}
        panel = build_panel(ResearchDataset.model_validate(self.raw))
        self.assertTrue(np.isnan(panel.fields["close"].iloc[0, 0]))
        self.assertFalse(panel.eligible.iloc[0, 1])
        self.assertTrue(np.isnan(panel.fields["feature:roe"].iloc[0, 2]))
        self.assertTrue(np.isfinite(panel.fields["close"].iloc[0, 2]))

    def test_invalid_graphs_reject_code_cycles_and_future_windows(self):
        for name in ("operator", "cycle", "negative", "parameter", "transform"):
            value = self.spec.factors[0].model_dump()
            if name == "operator":
                value["nodes"][0]["op"] = "__import__"
            elif name == "cycle":
                value["nodes"][0]["inputs"] = ["r"]
            elif name == "negative":
                value["nodes"][0]["params"]["window"] = -1
            elif name == "parameter":
                value["nodes"][0]["params"]["source"] = "code"
            else:
                value["transforms"] = [{"op": "WINSORIZE", "params": {"method": "unknown"}}]
            with self.subTest(name=name), self.assertRaises(ValueError):
                compute_factors(self.panel, [FactorDefinition.model_validate(value)])

    def test_dependencies_daily_diagnostics_and_catalog(self):
        second = FactorDefinition.model_validate({"id": "reverse", "inputs": {"x": "factor:momentum_5"},
            "nodes": [{"id": "n", "op": "NEGATE", "inputs": ["x"]}], "output": "n"})
        values = compute_factors(self.panel, [self.spec.factors[0], second])
        pd.testing.assert_frame_equal(values["reverse"], -values["momentum_5"])
        labels, _ = forward_labels(self.panel, 5)
        diagnostics = factor_diagnostics(self.panel, values, labels, self.spec.start_date, self.spec.end_date)
        self.assertEqual(diagnostics["reverse"]["coverage"], 1)
        self.assertEqual(len(diagnostics["reverse"]["daily"]), 39)
        self.assertAlmostEqual(factor_correlations(values, self.spec.start_date, self.spec.end_date)[1]["meanCorrelation"], -1)
        self.assertEqual(len(factor_catalog()["factors"]), 12)
        self.assertEqual(len(factor_catalog()["operators"]), 17)

    def test_transforms_and_future_changes_preserve_history(self):
        definition = FactorDefinition.model_validate({"id": "test", "inputs": {"x": "close"}, "nodes": [], "output": "x",
            "transforms": [{"op": "WINSORIZE", "params": {"n": 2}}, {"op": "ZSCORE"}, {"op": "INDUSTRY_NEUTRALIZE"}]})
        before = compute_factors(self.panel, [definition])["test"]
        for sector in (0, 1):
            self.assertTrue(np.allclose(before.iloc[:, sector::2].mean(axis=1), 0, atol=1e-12))
        changed = deepcopy(self.raw)
        for row in changed["bars"]:
            if row["date"] >= self.panel.dates[75]:
                for field in ("open", "high", "low", "close", "previousClose"):
                    row[field] *= 1.2
        for stock in range(8):
            changed["bars"][75 * 8 + stock]["previousClose"] = changed["bars"][74 * 8 + stock]["close"]
        after = compute_factors(build_panel(ResearchDataset.model_validate(changed)), [definition])["test"]
        pd.testing.assert_frame_equal(before.iloc[:75], after.iloc[:75])
