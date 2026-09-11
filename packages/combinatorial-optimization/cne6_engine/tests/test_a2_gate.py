from datetime import datetime, timezone
import json
from pathlib import Path

import polars as pl
import pytest

from cne6_engine.data_sources.a2_gate import audit_a2, live_observation_days
from cne6_engine.data_sources.acceptance import content_hash
from cne6_engine.data_sources.sample import digest

REPO = Path(__file__).resolve().parents[4]
CONTRACT = REPO / "config/equity-data-acceptance.json"


def observation(**updates):
    return {"tradeDate": "2026-09-09", "mode": "live", "contractHash": "a" * 64, "sourceStatus": "pass",
            "startedAt": "2026-09-09T10:00:00Z", "finishedAt": "2026-09-09T10:01:00Z", **updates}


def test_observation_days_do_not_promote_source_probes():
    result = live_observation_days([observation(), observation()], "a" * 64)
    assert result["sourceDayCount"] == 1
    assert result["rejected"] == [{"tradeDate": "2026-09-09", "reason": "duplicate-session"}]
    assert result["publicationStabilityStatus"] == "not-evaluated"


@pytest.mark.parametrize("updates", [
    {"mode": "retrospective"}, {"contractHash": "b" * 64}, {"sourceStatus": "blocked"},
    {"tradeDate": "2026-09-08"}, {"startedAt": "2026-09-09T06:00:00Z"},
    {"finishedAt": "2026-09-10T00:00:00Z"}, {"startedAt": "2026-09-09T10:00:00"},
    {"startedAt": "invalid"},
])
def test_observation_rejects_backfill_bad_time_and_failure(updates):
    result = live_observation_days([observation(**updates)], "a" * 64)
    assert result["sourceDayCount"] == 0
    assert len(result["rejected"]) == 1


@pytest.fixture
def candidate(tmp_path):
    root = tmp_path / "data"
    root.mkdir()
    target = root / "candidate"
    target.mkdir()
    contract_hash = content_hash(CONTRACT)
    request = {"tool": "daily", "arguments": {"trade_date": "20260909"}}
    raw = [{"ts_code": "600000.SH", "trade_date": "20260909", "close": 10}]
    artifact = {"request": request, "requestHash": digest(request), "contractHash": contract_hash,
                "raw": raw, "rows": raw, "rawHash": digest(raw)}
    artifact["artifactHash"] = digest(artifact)
    (root / "requests").mkdir()
    (root / "requests" / f"{digest(request)}.json").write_text(json.dumps(artifact))
    assets = {}
    for name in ("daily-panel", "statements", "industry", "corporate-actions", "benchmark-series"):
        path = target / f"{name}.parquet"
        pl.DataFrame({"value": [1]}).write_parquet(path)
        assets[path.name] = {"bytes": path.stat().st_size, "sha256": content_hash(path)}
    report = {"stage": "A2-sample", "contractHash": contract_hash, "sampleSize": 24, "assets": assets,
              "rawLineage": [{"request": request, "artifactHash": artifact["artifactHash"]}],
              "inputArtifactHashes": [artifact["artifactHash"]],
              "gates": {"sampleRawPriceCoverage": "pass", "riskModel": "blocked", "historicalIndexConstituentCoverage": "pass"},
              "riskModelProbe": {"status": "blocked", "maxCrossSectionSize": 20, "observedTradedDays": 2597,
                                 "feasibleFullRankDays": {"no_analyst_sentiment": 0}, "reason": "rank-deficient"},
              "tradingStatusConflicts": {"conflictRows": 18, "conflictsInEvaluationWindow": 0,
                                         "earliestConflict": "2009-02-23", "latestConflict": "2012-07-06", "conflicts": []},
              "benchmarkConstituents": {"status": "pass", "indices": {
                  "000300.SH": {"status": "pass", "monthEndSnapshots": 128, "coveredMonths": 128, "expectedMonths": 128,
                                "missingMonths": [], "badSnapshots": []},
                  "000906.SH": {"status": "pass", "monthEndSnapshots": 128, "coveredMonths": 128, "expectedMonths": 128,
                                "missingMonths": [], "badSnapshots": []}}}}
    (target / "acceptance.json").write_text(json.dumps(report))
    return root, target, report


def test_a2_sample_integrity_does_not_mean_full_market_acceptance(candidate):
    root, target, _ = candidate
    report = audit_a2(root, target, CONTRACT, REPO)
    assert report["status"] == "blocked"
    assert report["promotionAllowed"] is False and report["readyForA3"] is False
    gates = {row["id"]: row for row in report["gates"]}
    assert gates["artifactIntegrity"]["rawArtifacts"] == 1
    assert gates["fullMarketCoverage"]["status"] == "blocked"
    assert gates["incrementalPublicationStability"]["acceptedPublicationDays"] == 0
    # risk-model feasibility surfaces the rank-deficient sample and never promotes.
    assert gates["riskModel"]["status"] == "blocked"
    assert gates["riskModelFeasibility"]["status"] == "blocked"
    assert gates["riskAcceptance"]["status"] == "blocked"
    assert report["riskModelProbe"]["maxCrossSectionSize"] == 20
    assert report["tradingStatusConflicts"]["conflictRows"] == 18
    # historical index constituent/weight history is real 2016..D monthly coverage.
    assert gates["historicalIndexConstituentCoverage"]["status"] == "pass"
    assert report["benchmarkConstituents"]["status"] == "pass"


def test_a2_requires_risk_and_conflict_diagnostics(candidate):
    root, target, report = candidate
    report.pop("riskModelProbe")
    (target / "acceptance.json").write_text(json.dumps(report))
    with pytest.raises(ValueError, match="riskModelProbe"):
        audit_a2(root, target, CONTRACT, REPO)


def test_a2_requires_benchmark_constituent_diagnostic(candidate):
    root, target, report = candidate
    report.pop("benchmarkConstituents")
    (target / "acceptance.json").write_text(json.dumps(report))
    with pytest.raises(ValueError, match="benchmarkConstituents"):
        audit_a2(root, target, CONTRACT, REPO)


@pytest.mark.parametrize("change", ["tampered", "symlink", "wrong-contract", "empty-manifest"])
def test_a2_rejects_invalid_artifact_evidence(candidate, change):
    root, target, report = candidate
    if change == "tampered":
        (target / "daily-panel.parquet").write_text("invalid")
    elif change == "symlink":
        path = target / "daily-panel.parquet"
        path.rename(target / "other.parquet")
        path.symlink_to(target / "other.parquet")
    elif change == "wrong-contract":
        report["contractHash"] = "f" * 64
    else:
        report.update(assets={}, rawLineage=[], inputArtifactHashes=[])
    (target / "acceptance.json").write_text(json.dumps(report))
    with pytest.raises(ValueError):
        audit_a2(root, target, CONTRACT, REPO)


def test_a2_rejects_observation_without_acquisition_evidence(candidate):
    root, target, _ = candidate
    directory = root / "observations/2026-09-09"
    directory.mkdir(parents=True)
    (directory / "observation.json").write_text(json.dumps(observation(contractHash=content_hash(CONTRACT))))
    with pytest.raises(ValueError, match="acquisition"):
        audit_a2(root, target, CONTRACT, REPO)
