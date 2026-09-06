from __future__ import annotations

import json
import subprocess
import sys
import unittest

from ngfi_quant import stable_hash


class AgentBridgeTest(unittest.TestCase):
    def run_bridge(self, operation: str, payload: dict) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "ngfi_quant.agent_bridge", operation], input=json.dumps(payload),
            text=True, capture_output=True, check=False,
        )

    def test_research_backtest_emits_json_safe_research_tier_evidence(self) -> None:
        instrument = {"market": "CN", "exchange": "SSE", "symbol": "600000", "assetType": "equity"}
        calendar = ["2026-01-05", "2026-01-06", "2026-01-07"]
        bars = [{
            "date": day, "instrument": instrument, "availableAt": f"{day}T07:00:01+00:00",
            "open": 10 + index, "high": 10.2 + index, "low": 9.8 + index,
            "close": 10 + index, "previousClose": 9.5 + index,
        } for index, day in enumerate(calendar)]
        payload = {
            "calendar": calendar, "bars": bars,
            "signals": [{"observationId": stable_hash({"signal": 1}), "instrument": instrument, "signalDate": calendar[0]}],
            "costModel": {"commissionRate": 0, "minimumCommission": 0, "stampDutyRate": 0, "transferFeeRate": 0},
            "portfolio": {"initialCapital": 100_000, "maxPositions": 1, "allocationFraction": 0.5, "holdingDays": 1},
            "metadata": {
                "datasetSnapshotId": "snapshot:bridge", "datasetHash": stable_hash({"dataset": 1}),
                "datasetAsOf": "2026-02-01T00:00:00+00:00", "strategyHash": stable_hash({"strategy": 1}),
                "configHash": stable_hash({"config": 1}), "executionHash": stable_hash({"execution": 1}),
                "benchmarkInstrument": None, "benchmarkDatasetHash": None,
                "startedAt": "2026-02-01T00:00:00+00:00", "completedAt": "2026-02-01T00:00:01+00:00",
            },
        }
        result = self.run_bridge("research-backtest", payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["run"]["engineTier"], "research")
        self.assertEqual(output["run"]["dataset"]["snapshotId"], "snapshot:bridge")

    def test_promotion_rejects_smoke_without_leaking_a_traceback(self) -> None:
        result = self.run_bridge("promotion", {"researchRun": {"engineTier": "smoke"}})
        self.assertEqual(result.returncode, 2)
        self.assertIn("smoke is never eligible", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
