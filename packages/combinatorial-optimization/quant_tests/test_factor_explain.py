import unittest

from ngfi_quant.demo import demo_input
from ngfi_quant.factors.explain import StyleExplanation, explain_style
from ngfi_quant.research_contracts import ResearchDataset


class FactorExplanationTest(unittest.TestCase):
    def fixture(self):
        raw, _ = demo_input()
        for bar in raw["bars"]:
            value = 2.0 if bar["industry"] == "sector-0" else 4.0
            bar["features"] = {name: {"value": value, "availableAt": bar["availableAt"],
                                      "sourceHash": "sha256:" + "a" * 64} for name in ("signal", "copy")}
        config = {"factors": [{"id": "industry_signal", "semanticsVersion": "3",
                               "inputs": {"x": "feature:signal"}, "fieldUnits": {"feature:signal": "dimensionless"},
                               "nodes": [], "output": "x"}],
                  "factor": "industry_signal", "partition": {"start": raw["calendar"][0]["date"], "end": raw["calendar"][20]["date"]},
                  "controls": ["industry"], "horizon": 1}
        return raw, config

    def test_pure_industry_exposure_has_zero_residual_and_no_residual_ic(self):
        raw, config = self.fixture()
        result = explain_style(ResearchDataset.model_validate(raw), StyleExplanation.model_validate(config))
        self.assertEqual(result["status"], "complete")
        self.assertAlmostEqual(result["days"][0]["rSquared"], 1)
        self.assertAlmostEqual(result["days"][0]["coefficients"]["country"], 2)
        self.assertAlmostEqual(result["days"][0]["coefficients"]["industry_sector-1"], 2)
        self.assertEqual(result["days"][0]["rank"], 2)
        self.assertIsNone(result["diagnostics"]["residual"]["meanRankIc"])
        self.assertTrue(all(value == 0 for row in result["residuals"] for value in row["values"].values()))

    def test_missing_and_rank_deficient_controls_are_explicit(self):
        raw, config = self.fixture()
        for controls, expected in [(["log-market-cap"], "missing-control"),
                                   (["feature:signal", "feature:copy"], "rank-deficient")]:
            with self.subTest(controls=controls):
                result = explain_style(ResearchDataset.model_validate(raw),
                                       StyleExplanation.model_validate({**config, "controls": controls}))
                self.assertEqual(result["status"], "partial")
                self.assertIn(expected, result["days"][0]["reason"])
                self.assertTrue(all(value is None for value in result["residuals"][0]["values"].values()))

    def test_future_industry_does_not_enter_past_projection(self):
        raw, config = self.fixture()
        raw["bars"][0]["statusAvailableAt"] = raw["calendar"][10]["decisionAt"]
        before = explain_style(ResearchDataset.model_validate(raw), StyleExplanation.model_validate(config))
        raw["bars"][0]["industry"] = "unseen-future-sector"
        after = explain_style(ResearchDataset.model_validate(raw), StyleExplanation.model_validate(config))
        self.assertEqual(before["days"][0], after["days"][0])
        self.assertEqual(before["residuals"][0], after["residuals"][0])

    def test_explanation_accepts_the_full_registered_candidate_budget(self):
        raw, config = self.fixture()
        config["factors"] = [{**config["factors"][0], "id": f"candidate_{index}"} for index in range(33)]
        config["factor"] = "candidate_32"
        result = explain_style(ResearchDataset.model_validate(raw), StyleExplanation.model_validate(config))
        self.assertEqual(result["status"], "complete")
        self.assertAlmostEqual(result["days"][0]["rSquared"], 1)
        with self.assertRaises(ValueError):
            StyleExplanation.model_validate({**config, "factors": config["factors"] * 4})
