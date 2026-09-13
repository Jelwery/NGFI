from copy import deepcopy
import unittest

from ngfi_quant.research_contracts import ResearchDataset, ResearchSpec, Session


def dataset_input():
    days = [f"2024-01-0{number}" for number in (2, 3, 4, 5)]
    return {
        "snapshotId": "contract-fixture", "asOf": f"{days[-1]}T17:00:00+08:00",
        "provenance": "Synthetic contract fixture", "synthetic": True,
        "priceBasis": "raw-no-corporate-actions", "universePolicy": "explicit-research-universe",
        "calendar": [{"date": day, "openAt": f"{day}T09:30:00+08:00",
                      "closeAt": f"{day}T15:00:00+08:00", "decisionAt": f"{day}T16:00:00+08:00"} for day in days],
        "bars": [{"date": day, "instrument": {"market": "CN", "exchange": "SSE", "symbol": "600000"},
                  "availableAt": f"{day}T15:05:00+08:00", "statusAvailableAt": f"{day}T09:00:00+08:00",
                  "open": 10, "high": 11, "low": 9, "close": 10, "previousClose": 10,
                  "volume": 10000, "amount": 100000, "eligible": True, "industry": "bank",
                  "suspended": False, "lotSize": 100, "limitRate": 0.1} for day in days],
    }


def spec_input():
    return {"startDate": "2024-01-04", "endDate": "2024-01-05", "risk": {"source": "ledoit-wolf"},
            "factors": [{"id": "close", "inputs": {"x": "close"}, "nodes": [], "output": "x"}]}


class ResearchContractsTest(unittest.TestCase):
    def test_round_trip_identity_and_order(self):
        raw = dataset_input()
        dataset = ResearchDataset.model_validate(raw)
        self.assertEqual(dataset.hash, ResearchDataset.model_validate(dataset.json()).hash)
        raw["bars"].reverse()
        self.assertEqual(dataset.hash, ResearchDataset.model_validate(raw).hash)
        raw["bars"][0]["volume"] += 1
        self.assertNotEqual(dataset.hash, ResearchDataset.model_validate(raw).hash)
        self.assertEqual(dataset.schema_version, "2")
        self.assertEqual(ResearchSpec.model_validate(spec_input()).purpose, "research-diagnostic")

    def test_session_uses_shanghai_business_day(self):
        session = {"date": "2024-01-02", "openAt": "2024-01-02T01:30:00Z",
                   "closeAt": "2024-01-02T07:00:00Z", "decisionAt": "2024-01-02T08:00:00Z"}
        self.assertEqual(Session.model_validate(session).date, "2024-01-02")
        session["decisionAt"] = "2024-01-02T17:00:00Z"
        with self.assertRaisesRegex(ValueError, "Shanghai business date"):
            Session.model_validate(session)

    def test_invalid_panels_and_unknown_rules_fail_closed(self):
        changes = [
            lambda x: x["bars"].append(deepcopy(x["bars"][0])),
            lambda x: x["bars"].pop(),
            lambda x: x["bars"][0].update(availableAt="2099-01-01T00:00:00Z"),
            lambda x: x["bars"][0].update(availableAt=x["calendar"][0]["openAt"]),
            lambda x: x["bars"][1].update(previousClose=5),
            lambda x: x["bars"][0].update(volume=float("inf")),
            lambda x: x["bars"][0].pop("suspended"),
            lambda x: x["bars"][0].pop("statusAvailableAt"),
            lambda x: x["bars"][0].update(lotSize=True),
            lambda x: x.update(schemaVersion="1"),
            lambda x: x.update(command="arbitrary"),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                raw = dataset_input()
                change(raw)
                with self.assertRaises(ValueError):
                    ResearchDataset.model_validate(raw)

    def test_spec_requires_explicit_risk_and_diagnostic_purpose(self):
        for change in (lambda x: x.pop("risk"), lambda x: x.update(purpose="strategy-validation"),
                       lambda x: x.update(endDate="2000-01-01"),
                       lambda x: x.update(model={"refitEvery": True}),
                       lambda x: x.update(execution={"initialCapital": 100.001}),
                       lambda x: x.update(execution={"lotSize": 100})):
            raw = spec_input()
            change(raw)
            with self.assertRaises(ValueError):
                ResearchSpec.model_validate(raw)

    def test_features_keep_independent_provenance_and_availability(self):
        raw = dataset_input()
        raw["bars"][0]["features"] = {"roe": 0.2}
        with self.assertRaises(ValueError):
            ResearchDataset.model_validate(raw)
        raw["bars"][0]["features"]["roe"] = {"value": 0.2, "availableAt": raw["calendar"][1]["decisionAt"],
                                             "sourceHash": "sha256:" + "a" * 64}
        self.assertEqual(ResearchDataset.model_validate(raw).bars[0].features["roe"].value, 0.2)
