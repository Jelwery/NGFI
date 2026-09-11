from __future__ import annotations

from dataclasses import replace
import math
import unittest

from ngfi_quant import (
    CandidateReturn, DateFold, NestedFold, PromotionThresholds, cscv_pbo, decide_promotion,
    deflated_sharpe, minimum_track_record, nested_walk_forward, run_cost_stress, run_is_oos,
    run_experiment, stable_hash,
)
from test_portfolio import ZERO_COST, request, signal


def returns() -> tuple[CandidateReturn, ...]:
    rows = []
    for day, a, b in [
        ("2026-01-01", 0.03, 0.01), ("2026-01-02", 0.02, 0.00),
        ("2026-01-03", 0.01, 0.04), ("2026-01-04", 0.00, 0.03),
        ("2026-01-05", -0.01, 0.02), ("2026-01-06", -0.02, 0.01),
        ("2026-01-07", 0.01, 0.02), ("2026-01-08", 0.02, 0.01),
    ]:
        rows.extend((CandidateReturn(day, "a", a), CandidateReturn(day, "b", b)))
    return tuple(rows)


class ResearchValidationTest(unittest.TestCase):
    def test_is_oos_selects_only_on_train_and_evaluates_the_frozen_candidate(self) -> None:
        fold = DateFold("2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04")
        result = run_is_oos(returns(), fold, 2)
        self.assertEqual(result["selectedCandidate"], "a")
        self.assertAlmostEqual(result["trainScore"], 0.025)
        self.assertAlmostEqual(result["testScore"], 0.005)
        changed_oos = tuple(
            replace(row, value=1.0) if row.date >= "2026-01-03" and row.candidate_id == "b" else row
            for row in returns()
        )
        self.assertEqual(run_is_oos(changed_oos, fold, 2)["selectedCandidate"], "a")
        self.assertEqual(run_is_oos((), fold)["status"], "insufficient")

    def test_nested_walk_forward_keeps_inner_folds_inside_outer_training(self) -> None:
        nested = NestedFold(
            DateFold("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-06"),
            (DateFold("2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"),),
        )
        result = nested_walk_forward(returns(), (nested,), 2)
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["folds"][0]["selectedCandidate"], "a")
        self.assertAlmostEqual(result["meanOuterTestScore"], -0.015)
        with self.assertRaisesRegex(ValueError, "contained"):
            NestedFold(nested.outer, (DateFold("2026-01-01", "2026-01-03", "2026-01-04", "2026-01-05"),))

    def test_cost_stress_replays_with_a_new_cost_hash_and_worse_return(self) -> None:
        base = request((signal(1),), cost=replace(ZERO_COST, commission_rate=0.0003, minimum_commission=1))
        normal, doubled = run_cost_stress(base, (1, 2))
        self.assertNotEqual(normal.run["costModel"]["hash"], doubled.run["costModel"]["hash"])
        self.assertLess(doubled.run["metrics"]["totalReturn"]["value"], normal.run["metrics"]["totalReturn"]["value"])
        self.assertEqual(run_cost_stress(base, (2,))[0], doubled)

    def test_cscv_pbo_is_deterministic_and_insufficient_is_null(self) -> None:
        matrix = (
            (0.04, 0.01, 0.02), (0.03, 0.01, 0.02),
            (-0.04, 0.02, 0.01), (-0.03, 0.02, 0.01),
            (0.05, 0.00, 0.01), (0.04, 0.00, 0.01),
            (-0.05, 0.01, 0.02), (-0.04, 0.01, 0.02),
        )
        first = cscv_pbo(matrix, 4)
        self.assertEqual(first, cscv_pbo(matrix, 4))
        self.assertEqual(first["status"], "available")
        self.assertTrue(0 <= first["pbo"] <= 1)
        self.assertIsNone(cscv_pbo(((0.1, 0.2),), 4)["pbo"])
        with self.assertRaisesRegex(ValueError, "finite"):
            cscv_pbo(((0.1, math.nan), (0.2, 0.1)), 2)

    def test_deflated_sharpe_and_minimum_track_record_are_explicit_for_small_or_constant_samples(self) -> None:
        self.assertEqual(deflated_sharpe((0.01, 0.02), 5)["status"], "insufficient")
        self.assertEqual(deflated_sharpe((0.01, 0.01, 0.01), 5)["status"], "not-meaningful")
        dsr = deflated_sharpe((0.01, -0.005, 0.02, 0.0, 0.015, -0.002), 3)
        self.assertEqual(dsr["status"], "available")
        self.assertTrue(0 <= dsr["probability"] <= 1)
        self.assertIsNone(minimum_track_record(0.5, 0.5)["minimumObservations"])
        self.assertGreater(minimum_track_record(1.0, 0.0)["minimumObservations"], 1)

    def test_promotion_is_evidence_only_and_fails_closed_on_insufficient_inputs(self) -> None:
        thresholds = PromotionThresholds(0, 0, 0.5, 0.8, 10, 0.05)
        evidence = {
            "is_oos": {"status": "available", "testScore": 0.1},
            "walk_forward": {"status": "available", "meanOuterTestScore": 0.08},
            "pbo": {"status": "available", "pbo": 0.2},
            "deflated_sharpe_result": {"status": "available", "probability": 0.9},
            "minimum_track_record_result": {"status": "available", "minimumObservations": 8},
            "actual_track_record_observations": 20, "base_return": 0.12, "stressed_return": 0.09,
        }
        decision = decide_promotion(thresholds=thresholds, **evidence)
        self.assertEqual(decision["decision"], "promote-to-shadow")
        self.assertEqual(decision["targetStatus"], "shadow")
        self.assertNotIn("apply", decision)
        insufficient = decide_promotion(
            thresholds=thresholds, **{**evidence, "pbo": {"status": "insufficient", "pbo": None}},
        )
        self.assertEqual(insufficient["decision"], "insufficient")
        self.assertIsNone(insufficient["targetStatus"])


    def test_purge_overlap_and_duplicate_sample_boundaries(self):
        fold = DateFold("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-08", purge_days=1, label_horizon_days=1)
        result = run_is_oos(returns(), fold)
        self.assertEqual(result["trainRange"], ["2026-01-01", "2026-01-02"])
        self.assertEqual(result["selectedCandidate"], "a")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            run_is_oos(returns() + (returns()[0],), fold)
        nested = NestedFold(DateFold("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-06"),
                            (DateFold("2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"),))
        with self.assertRaisesRegex(ValueError, "nonoverlapping"):
            nested_walk_forward(returns(), (nested, nested))

    def test_experiment_train_only_frozen_parameters_and_test_once(self):
        fold = DateFold("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-08", purge_days=1, label_horizon_days=1)
        calls = []
        def fit(rows, seed):
            self.assertEqual(max(row.date for row in rows), "2026-01-02")
            self.assertEqual(seed, 7)
            calls.append("fit")
            return {"candidate": "a", "nested": {"weights": [1, 2]}}
        def tester(rows, params):
            self.assertEqual(min(row.date for row in rows), "2026-01-05")
            with self.assertRaises(TypeError):
                params["candidate"] = "b"
            with self.assertRaises(TypeError):
                params["nested"]["weights"][0] = 100
            calls.append("test")
            return {"score": sum(row.value for row in rows if row.candidate_id == params["candidate"])}
        rows = tuple(sorted(returns(), key=lambda row: (row.date, row.candidate_id)))
        args = dict(data_hash=stable_hash(rows), code_hash=stable_hash({"code": 1}), seed=7, fit=fit, tester=tester)
        result = run_experiment(rows, (fold,), **args)
        self.assertEqual(calls, ["fit", "test"])
        self.assertEqual(result["results"][0]["testerCalls"], 1)
        self.assertEqual(result, run_experiment(rows, (fold,), **args))
        with self.assertRaisesRegex(ValueError, "data_hash"):
            run_experiment(rows, (fold,), **{**args, "data_hash": stable_hash({"wrong": 1})})
        with self.assertRaisesRegex(ValueError, "nonoverlapping"):
            run_experiment(rows, (fold, fold), **args)


if __name__ == "__main__":
    unittest.main()
