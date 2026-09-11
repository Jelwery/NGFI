from copy import deepcopy
import json
from pathlib import Path
import unittest

import ngfi_quant

from ngfi_quant.research_cli import demo_input
from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec, Session


class ResearchContractsTest(unittest.TestCase):
    def test_session_date_uses_shanghai_business_day(self):
        session = Session.model_validate({
            "date": "2024-01-02",
            "openAt": "2024-01-02T01:30:00Z",
            "closeAt": "2024-01-02T07:00:00Z",
            "decisionAt": "2024-01-02T07:30:00Z",
        })
        self.assertEqual(session.date, "2024-01-02")

        with self.assertRaisesRegex(ValueError, "Shanghai business date"):
            Session.model_validate({
                "date": "2024-01-02",
                "openAt": "2024-01-02T16:30:00Z",
                "closeAt": "2024-01-02T17:00:00Z",
                "decisionAt": "2024-01-02T17:30:00Z",
            })

    def test_native_research_manifest_exports_are_available_from_package_root(self):
        root = Path(__file__).resolve().parents[3]
        manifest = json.loads((root / "docs/capabilities/manifest.json").read_text())
        capability = next(
            item for item in manifest["capabilities"]
            if item["id"] == "quant.native-research-pipeline"
        )
        missing = [
            name for name in capability["publicExports"]
            if not hasattr(ngfi_quant, name)
        ]
        self.assertEqual(missing, [])

    def test_round_trip_and_content_identity(self):
        raw, config = demo_input()
        dataset = ResearchDataset.model_validate(raw)
        self.assertEqual(dataset.hash, ResearchDataset.model_validate(dataset.json()).hash)
        self.assertEqual(ResearchSpec.model_validate(config).model.kind, "ridge")
        changed = deepcopy(raw)
        changed["bars"][0]["volume"] += 1
        self.assertNotEqual(dataset.hash, ResearchDataset.model_validate(changed).hash)
        reordered = deepcopy(raw)
        reordered["bars"].reverse()
        self.assertEqual(dataset.hash, ResearchDataset.model_validate(reordered).hash)

    def test_invalid_market_panels_fail_closed(self):
        raw, _ = demo_input()
        for name in ("duplicate", "gap", "future", "before-close", "corporate-action", "non-finite", "unknown"):
            with self.subTest(name=name):
                value = deepcopy(raw)
                if name == "duplicate":
                    value["bars"].append(value["bars"][0])
                elif name == "gap":
                    value["bars"].pop(9)
                elif name == "future":
                    value["bars"][0]["availableAt"] = "2099-01-01T00:00:00+08:00"
                elif name == "before-close":
                    value["bars"][0]["availableAt"] = value["calendar"][0]["openAt"]
                elif name == "corporate-action":
                    value["bars"][8]["previousClose"] *= 0.5
                elif name == "non-finite":
                    value["bars"][0]["volume"] = float("inf")
                else:
                    value["command"] = "ignored"
                with self.assertRaises(ValueError):
                    ResearchDataset.model_validate(value)

    def test_model_and_date_boundaries_are_explicit(self):
        _, raw = demo_input()
        for field, value in (("trainSessions", 0), ("horizon", -1), ("refitEvery", True), ("kind", "arbitrary-code")):
            config = deepcopy(raw)
            config["model"][field] = value
            with self.assertRaises(ValueError):
                ResearchSpec.model_validate(config)
        raw["endDate"] = "2000-01-01"
        with self.assertRaises(ValueError):
            ResearchSpec.model_validate(raw)

    def test_external_features_require_independent_provenance_and_time(self):
        raw, _ = demo_input()
        raw["bars"][0]["features"] = {"roe": 0.2}
        with self.assertRaises(ValueError):
            ResearchDataset.model_validate(raw)
        raw["bars"][0]["features"]["roe"] = {
            "value": 0.2, "availableAt": raw["calendar"][1]["decisionAt"], "sourceHash": "sha256:" + "a" * 64,
        }
        dataset = ResearchDataset.model_validate(raw)
        self.assertEqual(dataset.bars[0].features["roe"].value, 0.2)
