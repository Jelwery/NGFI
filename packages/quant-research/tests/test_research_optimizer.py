from copy import deepcopy
import unittest

import numpy as np

from ngfi_quant.research_cli import demo_input
from ngfi_quant.research_contracts import OptimizerSpec, ResearchDataset
from ngfi_quant.research_factors import build_panel
from ngfi_quant.research_optimizer import optimize_weights, covariance_at, cne6_covariance


class ResearchOptimizerTest(unittest.TestCase):
    def solve(self, spec=None, current=None, covariance=None):
        return optimize_weights(
            ["a", "b", "c"], np.array([0.06, 0.04, 0.02]),
            np.eye(3) * 0.001 if covariance is None else covariance,
            np.zeros(3) if current is None else current, np.array([True, True, True]),
            ["x", "x", "y"], spec or OptimizerSpec(max_weight=0.4, industry_caps={"x": 0.5}),
        )

    def test_mean_variance_solution_respects_caps_cash_and_turnover(self):
        result = self.solve()
        self.assertEqual(result["status"], "complete")
        weights = result["weights"]
        self.assertGreater(weights["a"], weights["c"])
        self.assertLessEqual(max(weights.values()), 0.4000001)
        self.assertLessEqual(weights["a"] + weights["b"], 0.5000001)
        self.assertGreaterEqual(result["cashWeight"], 0.02 - 1e-7)
        self.assertLessEqual(result["maximumViolation"], 1e-7)

    def test_infeasible_turnover_does_not_relax_the_constraints(self):
        result = self.solve(OptimizerSpec(max_weight=0.1, max_turnover=0.1), current=np.array([0.8, 0.1, 0.0]))
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["weights"])

    def test_non_psd_covariance_is_rejected_and_top_k_is_deterministic(self):
        with self.assertRaisesRegex(ValueError, "positive semidefinite"):
            self.solve(covariance=np.array([[1., 2., 0.], [2., 1., 0.], [0., 0., 1.]]))
        result = self.solve(OptimizerSpec(method="top-k", top_k=1, max_weight=0.9, turnover_penalty=0.0))
        self.assertEqual(result["status"], "complete")
        self.assertGreater(result["weights"]["a"], 0.89)
        self.assertLess(result["weights"]["b"], 1e-5)

    def test_top_k_is_a_hard_holding_constraint(self):
        result = optimize_weights(
            ["a", "b"],
            np.array([1.0, 0.0]),
            np.eye(2) * 0.01,
            np.array([0.0, 0.5]),
            np.array([True, True]),
            ["x", "x"],
            OptimizerSpec(
                method="top-k",
                top_k=1,
                max_weight=1.0,
                cash_reserve=0.0,
                turnover_penalty=100.0,
                max_turnover=2.0,
            ),
        )
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["weights"]["b"], 0.0)

    def test_covariance_only_uses_history_and_horizon_units(self):
        raw, _ = demo_input()
        panel = build_panel(ResearchDataset.model_validate(raw))
        short = covariance_at(panel, 50, 20, 1)
        np.testing.assert_allclose(covariance_at(panel, 50, 20, 5), short * 5)
        np.testing.assert_allclose(short, short.T)
        self.assertGreaterEqual(np.linalg.eigvalsh(short).min(), -1e-12)

    def test_cne6_reconciles_exposures_and_checks_availability(self):
        security = {"market": "CN", "exchange": "SSE", "symbol": "600000", "assetType": "equity"}
        snapshot = {
            "model": "CNE6", "currency": "CNY", "covariancePeriod": "daily",
            "asOf": "2024-01-02", "availableAt": "2024-01-02T16:00:00+08:00",
            "factors": [{"name": "market", "kind": "country"}], "factorCovariance": [[0.01]],
            "securities": [{"instrument": security, "exposures": [2.0], "specificRisk": 0.1}],
            "stockCovariance": [[0.05]],
        }
        result = cne6_covariance(snapshot, ["CN:SSE:600000:equity"], "2024-01-03T16:00:00+08:00", 5)
        np.testing.assert_allclose(result, [[0.25]])
        with self.assertRaisesRegex(ValueError, "non-future"):
            cne6_covariance(snapshot, ["CN:SSE:600000:equity"], "2024-01-02T15:00:00+08:00", 1)
        wrong = deepcopy(snapshot)
        wrong["stockCovariance"] = [[0.06]]
        with self.assertRaisesRegex(ValueError, "does not reconcile"):
            cne6_covariance(wrong, ["CN:SSE:600000:equity"], "2024-01-03T16:00:00+08:00", 1)

    def test_cne6_compares_model_date_in_shanghai_time(self):
        security = {"market": "CN", "exchange": "SSE", "symbol": "600000", "assetType": "equity"}
        snapshot = {
            "model": "CNE6", "currency": "CNY", "covariancePeriod": "daily",
            "asOf": "2024-01-02", "availableAt": "2024-01-01T23:30:00-12:00",
            "factors": [{"name": "market", "kind": "country"}], "factorCovariance": [[0.01]],
            "securities": [{"instrument": security, "exposures": [2.0], "specificRisk": 0.1}],
            "stockCovariance": [[0.05]],
        }
        result = cne6_covariance(
            snapshot,
            ["CN:SSE:600000:equity"],
            "2024-01-02T20:00:00+08:00",
            1,
        )
        np.testing.assert_allclose(result, [[0.05]])

    def test_cne6_rejects_invalid_availability_type_and_zero_specific_risk(self):
        security = {"market": "CN", "exchange": "SSE", "symbol": "600000", "assetType": "equity"}
        snapshot = {
            "model": "CNE6", "currency": "CNY", "covariancePeriod": "daily",
            "asOf": "2024-01-02", "availableAt": "2024-01-02T16:00:00+08:00",
            "factors": [{"name": "market", "kind": "country"}], "factorCovariance": [[0.01]],
            "securities": [{"instrument": security, "exposures": [2.0], "specificRisk": 0.1}],
            "stockCovariance": [[0.05]],
        }
        invalid_time = deepcopy(snapshot)
        invalid_time["availableAt"] = 1
        with self.assertRaisesRegex(ValueError, "availableAt"):
            cne6_covariance(invalid_time, ["CN:SSE:600000:equity"], "2024-01-03T16:00:00+08:00", 1)

        zero_risk = deepcopy(snapshot)
        zero_risk["securities"][0]["specificRisk"] = 0.0
        zero_risk["stockCovariance"] = [[0.04]]
        with self.assertRaisesRegex(ValueError, "specific risk"):
            cne6_covariance(zero_risk, ["CN:SSE:600000:equity"], "2024-01-03T16:00:00+08:00", 1)

    def test_cne6_accepts_a_structurally_valid_warning_snapshot(self):
        security = {"market": "CN", "exchange": "SSE", "symbol": "600000", "assetType": "equity"}
        snapshot = {
            "model": "CNE6", "currency": "CNY", "covariancePeriod": "daily",
            "asOf": "2024-01-02", "availableAt": "2024-01-02T16:00:00+08:00",
            "factors": [{"name": "market", "kind": "country"}], "factorCovariance": [[0.01]],
            "securities": [{"instrument": security, "exposures": [2.0], "specificRisk": 0.1}],
            "stockCovariance": [[0.05]],
            "quality": {
                "status": "warning", "symmetric": True, "positiveSemidefinite": True,
                "issues": ["factor covariance condition number exceeds the warning threshold"],
            },
        }
        result = cne6_covariance(snapshot, ["CN:SSE:600000:equity"], "2024-01-03T16:00:00+08:00", 1)
        np.testing.assert_allclose(result, [[0.05]])

    def test_frozen_positions_remain_fixed_or_make_constraints_infeasible(self):
        current = np.array([0.3, 0.0])
        for cap in (0.4, 0.1):
            with self.subTest(cap=cap):
                result = optimize_weights(
                    ["a", "b"], np.array([-1.0, 0.1]), np.eye(2) * 0.01, current,
                    np.array([False, True]), ["x", "y"], OptimizerSpec(max_weight=cap),
                    frozen=np.array([True, False]),
                )
                if cap > 0.3:
                    self.assertEqual(result["status"], "complete")
                    self.assertAlmostEqual(result["weights"]["a"], 0.3, places=7)
                else:
                    self.assertEqual(result["status"], "failed")
