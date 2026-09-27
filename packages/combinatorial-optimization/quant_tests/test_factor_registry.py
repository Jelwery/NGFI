from copy import deepcopy
import unittest

from ngfi_quant.factors.registry import catalog, factor_card
from ngfi_quant.research_contracts import FactorDefinition


class FactorRegistryTest(unittest.TestCase):
    def test_identity_history_and_semantics(self):
        raw = {"id": "first", "semanticsVersion": "3", "inputs": {"x": "close"},
               "nodes": [{"id": "d", "op": "DELAY", "inputs": ["x"], "params": {"window": 5}},
                         {"id": "m", "op": "SMA", "inputs": ["d"], "params": {"window": 20}}],
               "output": "m"}
        first = factor_card(FactorDefinition.model_validate(raw))
        self.assertEqual(first["lookbackSessions"], 24)
        renamed = deepcopy(raw)
        renamed.update(id="second", description="new label")
        renamed["nodes"][1]["id"] = renamed["output"] = "renamed"
        self.assertEqual(first["expressionHash"], factor_card(FactorDefinition.model_validate(renamed))["expressionHash"])
        renamed["nodes"][0]["params"]["window"] = 6
        self.assertNotEqual(first["expressionHash"], factor_card(FactorDefinition.model_validate(renamed))["expressionHash"])
        self.assertEqual(first["edges"][1], {"from": "d", "to": "m", "inputIndex": 0})

    def test_unit_contract_and_legacy_serialization(self):
        for op in ("ADD", "LOG"):
            with self.subTest(op=op):
                raw = {"id": "bad", "semanticsVersion": "3", "inputs": {"x": "close", "v": "volume"},
                       "nodes": [{"id": "r", "op": op, "inputs": ["x", "v"] if op == "ADD" else ["x"]}], "output": "r"}
                with self.assertRaisesRegex(ValueError, "units|dimensionless"):
                    factor_card(FactorDefinition.model_validate(raw))
        raw = {"id": "legacy", "inputs": {"x": "close"}, "nodes": [], "output": "x"}
        legacy = FactorDefinition.model_validate(raw)
        self.assertNotIn("semanticsVersion", legacy.json())
        self.assertNotIn("fieldUnits", legacy.model_dump())
        self.assertEqual(legacy.hash, FactorDefinition.model_validate(legacy.json()).hash)
        raw["nodes"] = [{"id": "s", "op": "SIGN", "inputs": ["x"]}]
        raw["output"] = "s"
        with self.assertRaisesRegex(ValueError, "semanticsVersion"):
            factor_card(FactorDefinition.model_validate(raw))

    def test_catalog_reverse_dependencies_and_commutation(self):
        result = catalog()
        self.assertEqual(len(result["factors"]), 12)
        self.assertGreater(len(result["operators"]), 17)
        self.assertTrue(result["reverseDependencies"]["RETURN"])
        raw = {"id": "sum", "semanticsVersion": "3", "inputs": {"x": "close", "y": "open"},
               "nodes": [{"id": "s", "op": "ADD", "inputs": ["x", "y"]}], "output": "s"}
        first = factor_card(FactorDefinition.model_validate(raw))
        raw["nodes"][0]["inputs"].reverse()
        self.assertEqual(first["expressionHash"], factor_card(FactorDefinition.model_validate(raw))["expressionHash"])
        raw["nodes"][0]["op"] = "SUB"
        first = factor_card(FactorDefinition.model_validate(raw))
        raw["nodes"][0]["inputs"].reverse()
        self.assertNotEqual(first["expressionHash"], factor_card(FactorDefinition.model_validate(raw))["expressionHash"])
