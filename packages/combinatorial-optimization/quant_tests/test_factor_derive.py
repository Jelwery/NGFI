import math
import unittest

from ngfi_quant.demo import demo_input
from ngfi_quant.factors.derive import DerivationRequest, derive_factors
from ngfi_quant.factors.graph import build_panel, compute_factors
from ngfi_quant.research_contracts import FactorDefinition, ResearchDataset


class FactorDerivationTest(unittest.TestCase):
    def test_pilot_is_seventeen_registered_reproducible_expressions(self):
        request = DerivationRequest(generator="reversal-volume-v1", hypothesis="volume conditioned reversal")
        result = derive_factors(request)
        self.assertEqual(result, derive_factors(request))
        self.assertEqual(result["proposalCount"], 17)
        self.assertEqual(result["uniqueCount"], 17)
        self.assertEqual(sum(link["kind"] == "control" for link in result["lineage"]), 5)
        raw = demo_input()[0]
        panel = build_panel(ResearchDataset.model_validate(raw))
        factors = compute_factors(panel, [FactorDefinition.model_validate(d) for d in result["definitions"]])
        self.assertTrue(factors["volume_10"].isna().all().all())
        for index, bar in enumerate(raw["bars"]):
            bar["volume"] *= 1 + 0.2 * math.sin((index // 8) * (index % 8 + 1))
        panel = build_panel(ResearchDataset.model_validate(raw))
        factors = compute_factors(panel, [FactorDefinition.model_validate(d) for d in result["definitions"]])
        self.assertEqual(len(factors), 17)
        self.assertTrue(all(frame.iloc[25:].notna().all().all() for frame in factors.values()))
        self.assertEqual(result["lineage"][-1]["parents"], ["reversal_20", "volume_20"])
        with self.assertRaisesRegex(ValueError, "budget"):
            derive_factors(request.model_copy(update={"budget": 16}))

    def test_all_five_mutations_are_bounded_and_keep_lineage(self):
        parent = {"id": "parent", "semanticsVersion": "3", "inputs": {"x": "volume"},
                  "nodes": [{"id": "m", "op": "SMA", "inputs": ["x"], "params": {"window": 5}}],
                  "output": "m", "transforms": [{"op": "ZSCORE"}]}
        request = DerivationRequest.model_validate({
            "generator": "mutations-v1", "hypothesis": "stability", "parents": [parent], "parent": "parent",
            "mutations": [{"kind": "window", "node": "m", "window": 10},
                          {"kind": "aggregate", "operator": "DECAY_LINEAR", "window": 3},
                          {"kind": "input", "inputName": "x", "field": "volume"},
                          {"kind": "neutralize"}, {"kind": "interaction", "other": "parent"}]})
        result = derive_factors(request)
        self.assertEqual(result["proposalCount"], 5)
        self.assertEqual(len(result["definitions"]), 6)
        self.assertEqual(result["lineage"][3]["duplicateOf"], "parent")
        self.assertTrue(all(link["parentVersionIds"] for link in result["lineage"][1:]))
        raw = request.json()
        raw["mutations"] = [{"kind": "input", "inputName": "x", "field": "close"}]
        with self.assertRaisesRegex(ValueError, "compatible"):
            derive_factors(DerivationRequest.model_validate(raw))
        raw["mutations"] = [{"kind": "window", "node": "m", "window": -1}]
        with self.assertRaises(ValueError):
            DerivationRequest.model_validate(raw)
