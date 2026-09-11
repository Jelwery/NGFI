from __future__ import annotations

from copy import deepcopy
import unittest

from ngfi_quant import optimize_portfolio, rebalance_plan, stable_hash

A = {"market": "CN", "exchange": "SSE", "symbol": "600000", "assetType": "equity"}
B = {"market": "CN", "exchange": "SZSE", "symbol": "000001", "assetType": "equity"}
AK, BK = "CN:SSE:600000:equity", "CN:SZSE:000001:equity"
AT = "2026-01-06T09:00:00+08:00"


def seal(payload: dict) -> dict:
    payload["inputHash"] = stable_hash({key: value for key, value in payload.items() if key != "inputHash"})
    return payload


def example_input() -> dict:
    """Executable self-contained camelCase contract fixture for the TS tool bridge."""
    return seal({
        "schemaVersion": "1", "dryRun": True, "asOf": "2026-01-06T09:30:00+08:00",
        "cash": 100000, "cashAvailableAt": AT, "holdingsAvailableAt": AT,
        "assets": [{"instrument": instrument, "score": score, "scoreAvailableAt": AT,
                    "evidenceRefs": ["fixture:explicit-alpha"], "price": 10,
                    "priceAvailableAt": AT, "quantity": 0, "sellableQuantity": 0,
                    "industry": "bank", "advNotional": 10000000, "advAvailableAt": AT,
                    "canBuy": True, "canSell": True, "statusAvailableAt": AT,
                    "previousClose": 10, "limitRate": 0.1} for instrument, score in ((A, 1), (B, -1))],
        "riskSnapshot": {
            "schemaVersion": "1", "model": "CNE6", "modelVersion": "fixture-v1",
            "asOf": "2026-01-05", "availableAt": AT, "currency": "CNY", "covariancePeriod": "daily",
            "factors": [{"name": "COUNTRY", "kind": "country"}, {"name": "SIZE", "kind": "style"}],
            "securities": [{"instrument": A, "exposures": [1, 1], "specificRisk": 0.01},
                           {"instrument": B, "exposures": [1, -1], "specificRisk": 0.01}],
            "factorCovariance": [[0.0001, 0], [0, 0.0001]],
            "stockCovariance": [[0.0003, 0], [0, 0.0003]],
            "quality": {"status": "ok", "symmetric": True, "positiveSemidefinite": True,
                        "maxAsymmetry": 0, "minEigenvalue": 0.0001, "maxEigenvalue": 0.0003,
                        "conditionNumber": 1, "stockReconciliationMaxError": 0, "issues": []},
            "sourceQuality": {"status": "ok", "proxyFlags": []}},
        "benchmark": {"instrument": {"market": "CN", "exchange": "SSE", "symbol": "000300", "assetType": "index"},
                      "weights": {AK: 0.5, BK: 0.5}, "availableAt": AT},
        "mandate": {"schemaVersion": "1", "id": "fixture-mandate", "version": "1",
                    "minWeight": 0, "maxWeight": 0.6, "weightBounds": {}, "cashMin": 0.1, "cashMax": 0.9,
                    "riskAversion": 10, "turnoverPenalty": 0.01, "turnoverLimit": 0.5,
                    "maxParticipation": 0.1, "industryBands": {"bank": {"min": -1, "max": 0}},
                    "styleBands": {"SIZE": {"min": -1, "max": 1}},
                    "qualityPolicy": {"maxAgeDays": 5, "minCoverage": 1, "maxConditionNumber": 1000000,
                                      "maxAsymmetry": 1e-10, "maxReconciliationError": 1e-10,
                                      "allowedProxyFlags": [], "allowWarnings": False}, "tolerance": 1e-7},
        "costModel": {"id": "cn", "version": "1", "commissionRate": 0.0003, "minimumCommission": 5,
                      "stampDutyRate": 0.0005, "transferFeeRate": 0.00001, "slippageRate": 0}
    })


class OptimizerTest(unittest.TestCase):
    def test_replay_rank_preference_repair_and_fee_ledger(self):
        payload = example_input()
        result = optimize_portfolio(payload)
        self.assertEqual(result["status"], "ok", result["rejectionReasons"])
        self.assertEqual(result, optimize_portfolio(payload))
        self.assertAlmostEqual(result["continuous"]["weights"][AK], 0.6, places=6)
        self.assertLessEqual(result["repaired"]["quantities"][AK], 6000)
        self.assertGreaterEqual(result["repaired"]["quantities"][AK], 5900)
        self.assertEqual(result["repaired"]["quantities"][BK], 0)
        self.assertTrue(all(row["satisfied"] for row in result["constraintDiagnostics"]))
        self.assertEqual(result["relaxations"], [])
        self.assertFalse(result["solver"]["integerOptimal"])
        trade = result["repaired"]["trades"][0]
        self.assertEqual(result["repaired"]["cash"], 100000 - trade["notional"] - trade["fees"]["total"])
        self.assertEqual(trade["fees"]["stampDuty"], 0)
        risk = result["risk"]
        self.assertAlmostEqual(risk["activeVariance"], risk["factorVariance"] + risk["specificVariance"])
        self.assertAlmostEqual(sum(risk["factorContributions"].values()), risk["factorVariance"])
        self.assertEqual(rebalance_plan(payload)["repaired"], result["repaired"])
        self.assertEqual(payload, example_input())

    def test_rank_is_scale_invariant_and_ties_are_neutral(self):
        payload = example_input()
        payload["assets"][0]["score"] = 80
        payload["assets"][1]["score"] = 20
        ranked = optimize_portfolio(seal(payload))
        self.assertEqual(ranked["continuous"]["alpha"], {AK: 1, BK: -1})
        payload["assets"][1]["score"] = 80
        tied = optimize_portfolio(seal(payload))
        self.assertEqual(tied["continuous"]["alpha"], {AK: 0, BK: 0})

    def test_fail_closed_schema_hash_pit_and_quality(self):
        cases = [
            (lambda p: p.update(dryRun=False), "dryRun"),
            (lambda p: p.update(unknown=1), "unknown keys"),
            (lambda p: p.update(asOf="2026-01-06"), "timezone"),
            (lambda p: p["assets"][0].update(score=None), "score"),
            (lambda p: p["assets"][0].update(scoreAvailableAt="2027-01-01T00:00:00Z"), "future"),
            (lambda p: p["assets"][0].update(statusAvailableAt="2025-01-01T00:00:00Z"), "stale"),
            (lambda p: p["assets"][0].update(canBuy="yes"), "boolean"),
            (lambda p: p["assets"][0].update(sellableQuantity=1), "exceeds"),
            (lambda p: p["riskSnapshot"]["sourceQuality"].update(proxyFlags=["benchmark-proxy"]), "proxy"),
            (lambda p: p["riskSnapshot"].update(factorCovariance=[[1, 2], [0, 1]]), "symmetric"),
            (lambda p: p["riskSnapshot"].update(factorCovariance=[[1, 2], [2, 1]]), "semidefinite"),
            (lambda p: p["riskSnapshot"].update(stockCovariance=[[0.01, 0], [0, 0.01]]), "reconcile"),
            (lambda p: p["riskSnapshot"]["securities"].pop(), "shape"),
            (lambda p: p["benchmark"]["weights"].update({BK: 0.2}), "sum to one"),
            (lambda p: p["mandate"]["styleBands"].update(UNKNOWN={"min": 0, "max": 1}), "unknown style"),
        ]
        for change, reason in cases:
            with self.subTest(reason=reason):
                payload = example_input()
                change(payload)
                result = optimize_portfolio(seal(payload))
                self.assertEqual(result["status"], "rejected")
                self.assertIn(reason, " ".join(result["rejectionReasons"]))
                self.assertIsNone(result["solver"]["duals"])
                self.assertIsNone(result["repaired"])
        payload = example_input()
        payload["cash"] += 1
        self.assertIn("inputHash", optimize_portfolio(payload)["rejectionReasons"][0])

    def test_infeasible_and_discrete_failure_never_relax_or_fabricate_duals(self):
        payload = example_input()
        payload["mandate"].update(minWeight=0.6, maxWeight=0.7)
        result = optimize_portfolio(seal(payload))
        self.assertEqual(result["status"], "rejected")
        self.assertIn("infeasible", result["solver"]["status"])
        self.assertIsNone(result["solver"]["duals"])
        payload = example_input()
        payload["mandate"].update(weightBounds={AK: {"min": 0.105, "max": 0.105}}, cashMin=0.89, cashMax=0.9)
        result = optimize_portfolio(seal(payload))
        self.assertEqual(result["status"], "rejected")
        self.assertIsNotNone(result["continuous"])
        self.assertIn("discrete repair", result["rejectionReasons"][0])
        self.assertEqual(result["relaxations"], [])

    def test_no_trade_odd_quantity_and_t_plus_one_are_preserved(self):
        payload = example_input()
        payload["assets"][0].update(quantity=155, sellableQuantity=0, canBuy=False, canSell=False)
        payload["assets"][1].update(canBuy=False, canSell=False)
        payload["cash"] = 98450
        payload["mandate"].update(cashMax=1)
        result = optimize_portfolio(seal(payload))
        self.assertEqual(result["status"], "ok", result["rejectionReasons"])
        self.assertEqual(result["repaired"]["quantities"], {AK: 155, BK: 0})
        self.assertEqual(result["repaired"]["trades"], [])
        self.assertEqual(result["repaired"]["cash"], 98450)

    def test_all_cash_cash_floor_and_fee_repair(self):
        payload = example_input()
        payload["assets"][1]["score"] = 0.5
        payload["mandate"].update(cashMin=0.01, cashMax=0.01)
        result = optimize_portfolio(seal(payload))
        # Exact cash equality plus board lots and nonzero fees is not silently relaxed.
        self.assertEqual(result["status"], "rejected")
        payload["mandate"].update(cashMax=0.1)
        result = optimize_portfolio(seal(payload))
        self.assertEqual(result["status"], "ok", result["rejectionReasons"])
        self.assertGreaterEqual(result["repaired"]["cash"], 1000)
        self.assertGreater(result["repaired"]["totalCosts"], 0)

    def test_missing_held_risk_and_factor_only_snapshot(self):
        payload = example_input()
        del payload["riskSnapshot"]["stockCovariance"]
        self.assertEqual(optimize_portfolio(seal(payload))["status"], "ok")
        payload["assets"][1].update(quantity=100, sellableQuantity=100)
        payload["riskSnapshot"]["securities"].pop()
        result = optimize_portfolio(seal(payload))
        self.assertEqual(result["status"], "rejected")
        self.assertIn("coverage", result["rejectionReasons"][0])

    def test_domain_freshness_defaults_to_global_max_age(self):
        payload = example_input()
        result = optimize_portfolio(payload)
        self.assertEqual(result["status"], "ok", result["rejectionReasons"])
        # Unspecified per-domain windows fall back to the global maxAgeDays (5).
        self.assertEqual(result["freshnessPolicy"]["maxAgeDays"], 5)
        self.assertEqual(set(result["freshnessPolicy"]["maxAgeDaysByDomain"]),
                         {"price", "tradingStatus", "risk", "research", "holdings", "benchmark"})
        self.assertTrue(all(v == 5 for v in result["freshnessPolicy"]["maxAgeDaysByDomain"].values()))

    def test_per_domain_freshness_separates_annual_research_from_daily_price(self):
        # A research score 60 days old with a short global/price window must not be
        # forced stale, while prices stay on a tight session-timed window.
        payload = example_input()
        payload["asOf"] = "2026-03-31T09:30:00+08:00"
        for asset in payload["assets"]:
            asset["scoreAvailableAt"] = "2026-01-31T09:00:00+08:00"  # ~59 days old
        payload["mandate"]["qualityPolicy"]["maxAgeDaysByDomain"] = {"research": 120}
        # daily domains still reference the near-asOf timestamps
        for label in ("priceAvailableAt", "advAvailableAt", "statusAvailableAt"):
            for asset in payload["assets"]:
                asset[label] = "2026-03-31T09:00:00+08:00"
        payload["cashAvailableAt"] = payload["holdingsAvailableAt"] = "2026-03-31T09:00:00+08:00"
        payload["riskSnapshot"]["asOf"] = "2026-03-30"
        payload["riskSnapshot"]["availableAt"] = "2026-03-31T08:00:00+08:00"
        payload["benchmark"]["availableAt"] = "2026-03-31T08:00:00+08:00"
        result = optimize_portfolio(seal(payload))
        self.assertEqual(result["status"], "ok", result["rejectionReasons"])
        self.assertEqual(result["freshnessPolicy"]["maxAgeDaysByDomain"]["research"], 120)
        # Tightening research back to the 5-day global window rejects the stale score.
        payload["mandate"]["qualityPolicy"]["maxAgeDaysByDomain"] = {"research": 5}
        rejected = optimize_portfolio(seal(payload))
        self.assertEqual(rejected["status"], "rejected")
        self.assertIn("scoreAvailableAt", " ".join(rejected["rejectionReasons"]))

    def test_per_domain_freshness_rejects_unknown_domain_and_bad_age(self):
        payload = example_input()
        payload["mandate"]["qualityPolicy"]["maxAgeDaysByDomain"] = {"unknownDomain": 10}
        self.assertIn("maxAgeDaysByDomain", " ".join(optimize_portfolio(seal(payload))["rejectionReasons"]))
        payload["mandate"]["qualityPolicy"]["maxAgeDaysByDomain"] = {"price": 500}
        self.assertIn("maxAgeDaysByDomain.price", " ".join(optimize_portfolio(seal(payload))["rejectionReasons"]))

    def test_unscored_held_name_keeps_alpha_zero_without_shifting_ranked_pool(self):
        # Three names, two scored (600000 high, 000001 low) plus an unscored held
        # position. The unscored name must not enter the rank pool nor change the
        # scored assets' [-1, 1] endpoints, and must carry an explicit reason.
        payload = example_input()
        held = {"market": "CN", "exchange": "SZSE", "symbol": "000002", "assetType": "equity"}
        held_key = "CN:SZSE:000002:equity"
        payload["assets"].append({
            "instrument": held, "scoreReason": "no-research-coverage", "price": 10,
            "priceAvailableAt": AT, "quantity": 100, "sellableQuantity": 100,
            "industry": "bank", "advNotional": 10000000, "advAvailableAt": AT,
            "canBuy": True, "canSell": True, "statusAvailableAt": AT,
            "previousClose": 10, "limitRate": 0.1})
        payload["benchmark"]["weights"] = {AK: 0.4, BK: 0.3, held_key: 0.3}
        payload["riskSnapshot"]["securities"].append(
            {"instrument": held, "exposures": [1, 0], "specificRisk": 0.01})
        del payload["riskSnapshot"]["stockCovariance"]  # factor-only snapshot covers the added security
        payload["cash"] = 99000
        result = optimize_portfolio(seal(payload))
        self.assertEqual(result["status"], "ok", result["rejectionReasons"])
        self.assertEqual(result["continuous"]["alpha"], {AK: 1, BK: -1, held_key: 0})
        self.assertEqual(result["continuous"]["scoringPool"], [AK, BK])
        self.assertEqual(result["continuous"]["unscoredReasons"], {held_key: "no-research-coverage"})

    def test_scored_and_unscored_field_shape_is_fail_closed(self):
        cases = [
            (lambda p: p["assets"][0].pop("score") or p["assets"][0].update(scoreReason="x"), "scoreAvailableAt"),
            (lambda p: p["assets"][0].update(scoreReason="both"), "both score and scoreReason"),
            (lambda p: (p["assets"][0].pop("score"), p["assets"][0].pop("scoreAvailableAt"), p["assets"][0].pop("evidenceRefs")), "requires a scoreReason"),
        ]
        for change, reason in cases:
            with self.subTest(reason=reason):
                payload = example_input()
                change(payload)
                result = optimize_portfolio(seal(payload))
                self.assertEqual(result["status"], "rejected")
                self.assertIn(reason, " ".join(result["rejectionReasons"]))
        # Fewer than two scored assets is rejected even if held names remain.
        payload = example_input()
        payload["assets"][1].pop("score")
        payload["assets"][1].pop("scoreAvailableAt")
        payload["assets"][1].pop("evidenceRefs")
        payload["assets"][1]["scoreReason"] = "no-coverage"
        self.assertIn("cross-section", " ".join(optimize_portfolio(seal(payload))["rejectionReasons"]))


if __name__ == "__main__":
    unittest.main()
