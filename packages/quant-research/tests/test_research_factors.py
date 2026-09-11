from copy import deepcopy
import unittest

import numpy as np
import pandas as pd

from ngfi_quant.research_cli import demo_input
from ngfi_quant.research_contracts import FactorDefinition, ResearchDataset, ResearchSpec
from ngfi_quant.research_factors import (
    build_panel, compute_factors, forward_labels, factor_diagnostics, factor_correlations, factor_catalog,
)


class ResearchFactorsTest(unittest.TestCase):
    def setUp(self):
        self.raw, config = demo_input()
        self.dataset = ResearchDataset.model_validate(self.raw)
        self.spec = ResearchSpec.model_validate(config)
        self.panel = build_panel(self.dataset)

    def test_native_factor_graph_matches_direct_pandas_math(self):
        factor = deepcopy(self.spec.factors[0].model_dump())
        factor["transforms"] = []
        result = compute_factors(self.panel, [FactorDefinition.model_validate(factor)])["momentum_5"]
        expected = self.panel.fields["close"] / self.panel.fields["close"].shift(5) - 1
        pd.testing.assert_frame_equal(result, expected)
        self.assertTrue(result.iloc[:5].isna().all().all())

    def test_labels_use_exact_calendar_and_next_open(self):
        labels, boundaries = forward_labels(self.panel, 5)
        key = self.panel.securities[0]
        expected = self.panel.bars[self.panel.dates[6], key].open / self.panel.bars[self.panel.dates[1], key].open - 1
        self.assertAlmostEqual(labels.iloc[0][key], expected)
        self.assertEqual(boundaries[self.panel.dates[0]][0], self.panel.dates[6])
        self.assertTrue(labels.iloc[-6:].isna().all().all())

    def test_nonvisible_values_and_future_changes_do_not_rewrite_history(self):
        raw = deepcopy(self.raw)
        first = raw["bars"][0]
        first["availableAt"] = raw["calendar"][1]["decisionAt"]
        panel = build_panel(ResearchDataset.model_validate(raw))
        self.assertTrue(np.isnan(panel.fields["close"].iloc[0, 0]))
        before = compute_factors(self.panel, self.spec.factors)
        for bar in raw["bars"]:
            if bar["date"] >= self.panel.dates[75]:
                for field in ("open", "high", "low", "close", "previousClose"):
                    bar[field] *= 1.1
        for stock in range(8):
            raw["bars"][75 * 8 + stock]["previousClose"] = raw["bars"][74 * 8 + stock]["close"]
        after = compute_factors(build_panel(ResearchDataset.model_validate(raw)), self.spec.factors)
        for name in before:
            pd.testing.assert_frame_equal(before[name].iloc[30:75], after[name].iloc[30:75])

    def test_rejects_dynamic_ops_cycles_negative_windows_and_unknown_params(self):
        base = self.spec.factors[0].model_dump()
        for name in ("operator", "cycle", "negative", "parameter"):
            with self.subTest(name=name):
                value = deepcopy(base)
                if name == "operator":
                    value["nodes"][0]["op"] = "__import__"
                elif name == "cycle":
                    value["nodes"][0]["inputs"] = ["r"]
                elif name == "negative":
                    value["nodes"][0]["params"]["window"] = -1
                else:
                    value["nodes"][0]["params"]["source"] = "code"
                with self.assertRaises(ValueError):
                    compute_factors(self.panel, [FactorDefinition.model_validate(value)])

    def test_factor_dependencies_and_diagnostics(self):
        second = FactorDefinition.model_validate({
            "id": "reverse", "inputs": {"x": "factor:momentum_5"},
            "nodes": [{"id": "n", "op": "NEGATE", "inputs": ["x"]}], "output": "n",
        })
        values = compute_factors(self.panel, [self.spec.factors[0], second])
        pd.testing.assert_frame_equal(values["reverse"], -values["momentum_5"])
        labels, _ = forward_labels(self.panel, 5)
        diagnostics = factor_diagnostics(self.panel, values, labels, self.spec.start_date, self.spec.end_date)
        self.assertEqual(diagnostics["reverse"]["coverage"], 1)
        self.assertEqual(len(diagnostics["reverse"]["daily"]), 39)
        self.assertTrue(-1 <= diagnostics["reverse"]["meanRankIc"] <= 1)
        correlations = factor_correlations(values, self.spec.start_date, self.spec.end_date)
        self.assertAlmostEqual(correlations[1]["meanCorrelation"], -1)

    def test_native_catalog_and_feature_visibility(self):
        catalog = factor_catalog()
        self.assertEqual(catalog["engine"], "ngfi-factor-graph")
        self.assertEqual(len(catalog["factors"]), 12)
        raw = deepcopy(self.raw)
        for index, row in enumerate(raw["bars"]):
            row["features"] = {"roe": {
                "value": 0.01 * (index % 8), "availableAt": row["availableAt"], "sourceHash": "sha256:" + "b" * 64,
            }}
        raw["bars"][0]["features"]["roe"]["availableAt"] = raw["calendar"][2]["decisionAt"]
        panel = build_panel(ResearchDataset.model_validate(raw))
        self.assertTrue(np.isnan(panel.fields["feature:roe"].iloc[0, 0]))
        self.assertTrue(np.isfinite(panel.fields["close"].iloc[0, 0]))
        value = compute_factors(panel, [FactorDefinition.model_validate({
            "id": "industry_roe", "inputs": {"x": "feature:roe"}, "nodes": [], "output": "x",
            "transforms": [{"op": "INDUSTRY_NEUTRALIZE"}],
        })])["industry_roe"]
        for day in panel.dates[1:]:
            for sector in (0, 1):
                self.assertAlmostEqual(value.loc[day].iloc[sector::2].mean(), 0, places=12)

    def test_all_operator_paths_match_scalar_and_rolling_calculations(self):
        x, y = self.panel.fields["close"], self.panel.fields["open"]
        cases = {
            "ADD": (["x", "y"], {}, x + y),
            "SUB": (["x", "y"], {}, x - y),
            "DIV": (["x", "y"], {}, x / y),
            "MUL_PANEL": (["x", "y"], {}, x * y),
            "ADD_CONST": (["x"], {"value": 2}, x + 2),
            "MUL": (["x"], {"value": 2}, x * 2),
            "ABS": (["x"], {}, x.abs()),
            "LOG": (["x"], {}, np.log(x)),
            "DELAY": (["x"], {"window": 3}, x.shift(3)),
            "STD": (["x"], {"window": 3}, x.rolling(3).std(ddof=0)),
            "TS_SUM": (["x"], {"window": 3}, x.rolling(3).sum()),
            "TS_MIN": (["x"], {"window": 3}, x.rolling(3).min()),
            "TS_MAX": (["x"], {"window": 3}, x.rolling(3).max()),
            "SMA": (["x"], {"window": 3}, x.rolling(3).mean()),
            "RANK": (["x"], {}, x.rank(axis=1, pct=True)),
        }
        for op, (inputs, params, expected) in cases.items():
            with self.subTest(op=op):
                definition = FactorDefinition.model_validate({
                    "id": "test", "inputs": {"x": "close", "y": "open"},
                    "nodes": [{"id": "n", "op": op, "inputs": inputs, "params": params}], "output": "n",
                })
                pd.testing.assert_frame_equal(compute_factors(self.panel, [definition])["test"], expected)
