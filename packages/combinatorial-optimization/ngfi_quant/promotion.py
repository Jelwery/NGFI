"""Evidence-only strategy promotion rules; never mutate strategy registrations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PromotionThresholds:
    minimum_oos_score: float
    minimum_walk_forward_score: float
    maximum_pbo: float
    minimum_deflated_sharpe_probability: float
    minimum_track_record_observations: int
    maximum_cost_stress_degradation: float


def decide_promotion(
    *, thresholds: PromotionThresholds, is_oos: dict[str, Any], walk_forward: dict[str, Any],
    pbo: dict[str, Any], deflated_sharpe_result: dict[str, Any], minimum_track_record_result: dict[str, Any],
    actual_track_record_observations: int, base_return: float | None, stressed_return: float | None,
) -> dict[str, Any]:
    evidence = {
        "isOos": is_oos, "walkForward": walk_forward, "cscvPbo": pbo,
        "deflatedSharpe": deflated_sharpe_result, "minimumTrackRecord": minimum_track_record_result,
        "actualTrackRecordObservations": actual_track_record_observations,
        "baseReturn": base_return, "stressedReturn": stressed_return,
    }
    required = (is_oos, walk_forward, pbo, deflated_sharpe_result, minimum_track_record_result)
    if any(item.get("status") != "available" for item in required) or base_return is None or stressed_return is None:
        return {"decision": "insufficient", "targetStatus": None, "criteria": {}, "evidence": evidence}
    required_observations = minimum_track_record_result["minimumObservations"]
    criteria = {
        "oos": is_oos["testScore"] >= thresholds.minimum_oos_score,
        "walkForward": walk_forward["meanOuterTestScore"] >= thresholds.minimum_walk_forward_score,
        "pbo": pbo["pbo"] <= thresholds.maximum_pbo,
        "deflatedSharpe": deflated_sharpe_result["probability"] >= thresholds.minimum_deflated_sharpe_probability,
        "trackRecord": actual_track_record_observations >= max(required_observations, thresholds.minimum_track_record_observations),
        "costStress": base_return - stressed_return <= thresholds.maximum_cost_stress_degradation and stressed_return > 0,
    }
    if all(criteria.values()):
        return {"decision": "promote-to-shadow", "targetStatus": "shadow", "criteria": criteria, "evidence": evidence}
    return {"decision": "remain-candidate", "targetStatus": "candidate", "criteria": criteria, "evidence": evidence}
