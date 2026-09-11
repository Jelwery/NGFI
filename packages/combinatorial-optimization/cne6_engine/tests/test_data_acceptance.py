from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from cne6_engine.data_sources.acceptance import (
    DOMAIN_IDS, content_hash, inventory, strict_json, validate_candidate, validate_contract,
)

REPO = Path(__file__).resolve().parents[4]
CONTRACT_PATH = REPO / "config/equity-data-acceptance.json"


@pytest.fixture
def contract():
    return json.loads(CONTRACT_PATH.read_text())


@pytest.fixture
def candidate(tmp_path, contract):
    root = tmp_path / "candidate"
    (root / "reference").mkdir(parents=True)
    row = {
        "domain": "raw-prices", "securityId": "SSE:600519", "field": "close",
        "value": 100, "unit": "CNY/share", "currency": "CNY",
        "economicEffectiveAt": "2026-09-09T15:00:00+08:00",
        "sourceAvailableAt": "2026-09-09T15:01:00+08:00",
        "firstFetchedAt": "2026-09-09T16:00:00+08:00", "revisionFetchedAt": None,
        "sourceId": "official", "sourceVersion": "v1", "sourceContentHash": "a" * 64,
        "locator": "source-row:1", "qualityFlag": "real", "reason": "",
    }
    manifest = {
        "schemaVersion": 1, "contractHash": content_hash(CONTRACT_PATH),
        "purpose": "research-diagnostic", "decisionDate": contract["decisionDate"],
        "window": {"start": "2026-09-09", "end": "2026-09-09"},
        "createdAt": "2026-09-09T17:00:00+08:00", "publishedAt": None, "availableAt": None, "codeHash": "b" * 64,
        "ruleHash": "c" * 64, "universe": {key: "d" * 64 for key in contract["universes"]},
        "sources": [{"id": "official", "authorizationCategory": "public-diagnostic", "authorizationEvidenceHash": None}],
        "assets": [], "quality": [{"domain": domain, "qualityFlag": "missing", "validCount": 0,
                                   "totalCount": 1, "coverage": 0, "denominator": "sample-security-days",
                                   "denominatorHash": "e" * 64, "reason": "not independently accepted"}
                                  for domain in sorted(DOMAIN_IDS)],
        "failures": [{"domain": "industry", "securityId": "SSE:600519", "reason": "missing PIT vintage"}],
        "recordSchema": 1, "timeMode": "contemporaneous",
    }

    def write(rows=None):
        asset = root / "reference/rows.jsonl"
        asset.write_text("".join(json.dumps(value) + "\n" for value in (rows or [row])))
        manifest["assets"] = [{"file": "rows.jsonl", "sha256": content_hash(asset),
                               "bytes": asset.stat().st_size, "rows": len(rows or [row])}]
        (root / "manifest.json").write_text(json.dumps(manifest))
        return root

    return root, manifest, row, write


def test_contract_and_inventory_preserve_blockers(contract, monkeypatch, tmp_path):
    validate_contract(contract, REPO)
    monkeypatch.setenv("CNE6_DATA_ROOT", str(tmp_path / "absent"))
    report = inventory(CONTRACT_PATH, REPO)
    assert report["a0ContractStatus"] == report["a1InventoryStatus"] == "pass"
    assert report["dataAcceptanceStatus"] == report["next"]["status"] == "blocked"
    assert report["strategyPromotionAllowed"] is False
    assert len(report["sourceGaps"]) == 12
    assert report["publication"]["status"] == "missing"
    assert str(tmp_path) not in json.dumps(report)
    assert report["publicationSchema"]["recordKey"][-1] == "sourceVersion"


@pytest.mark.parametrize("change", ["lower-coverage", "omit-domain", "omit-universe", "omit-todo", "short-warmup", "promote"])
def test_contract_rejects_weakened_baselines(contract, change):
    if change == "lower-coverage":
        contract["thresholds"]["consumedPitVerified"] = .99
    elif change == "omit-domain":
        contract["domains"].pop()
    elif change == "omit-universe":
        contract["universes"].pop("U_hold")
    elif change == "omit-todo":
        contract["domains"][0]["todo"] = ""
    elif change == "short-warmup":
        contract["history"]["minimumPriceWarmupTradingDays"] = 252
    else:
        contract["publicationPolicy"]["candidateOnlyUntilA2"] = False
    with pytest.raises(ValueError):
        validate_contract(contract, REPO)


@pytest.mark.parametrize("payload", ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":{"nested":1e400}}'])
def test_strict_json_rejects_ambiguous_or_nonfinite_values(payload):
    with pytest.raises(ValueError):
        strict_json(payload)


def test_candidate_validation_is_not_data_acceptance(candidate, contract):
    root, _, _, write = candidate
    write()
    (root / "CURRENT").write_text("last-good\n")
    before = (root / "CURRENT").read_bytes()
    result = validate_candidate(root, contract, content_hash(CONTRACT_PATH))
    assert result["schemaStatus"] == "pass"
    assert result["dataAcceptanceStatus"] == "not-evaluated"
    assert result["rows"] == 1 and result["promotionAllowed"] is False
    assert (root / "CURRENT").read_bytes() == before


@pytest.mark.parametrize("change,match", [
    ("future-source", "future source"), ("future-fetch", "fetched after"),
    ("unknown-pit", "unknown PIT"), ("degraded-strategy", "degraded records"),
    ("no-license", "authorization evidence"), ("wrong-currency", "wrong currency"),
    ("false-coverage", "coverage inconsistent"), ("omit-quality", "all domains"),
    ("bad-revision", "revision fetched"), ("out-of-window", "outside publication window"),
    ("false-publication", "formal publication"), ("no-denominator", "denominator identity"),
])
def test_candidate_rejects_invalid_claims(candidate, contract, change, match):
    root, manifest, row, write = candidate
    if change == "future-source":
        row["sourceAvailableAt"] = "2026-09-10T15:00:00+08:00"
    elif change == "future-fetch":
        row["firstFetchedAt"] = "2026-09-10T15:00:00+08:00"
    elif change == "unknown-pit":
        row["sourceAvailableAt"] = None
        manifest["purpose"] = "strategy-validation"
    elif change == "degraded-strategy":
        row.update(qualityFlag="proxy", reason="annual replaces quarterly")
        manifest["purpose"] = "strategy-validation"
    elif change == "no-license":
        manifest["purpose"] = "strategy-validation"
    elif change == "wrong-currency":
        row["currency"] = "USD"
    elif change == "false-coverage":
        manifest["quality"][0]["coverage"] = 1
    elif change == "omit-quality":
        manifest["quality"].pop()
    elif change == "bad-revision":
        row["revisionFetchedAt"] = "2026-09-08T15:00:00+08:00"
    elif change == "false-publication":
        manifest["publishedAt"] = manifest["createdAt"]
    elif change == "no-denominator":
        manifest["quality"][0]["denominatorHash"] = None
    else:
        row["economicEffectiveAt"] = "2026-09-08T15:00:00+08:00"
    write()
    with pytest.raises(ValueError, match=match):
        validate_candidate(root, contract, content_hash(CONTRACT_PATH))


@pytest.mark.parametrize("change,match", [("duplicate", "duplicate record"), ("tampered", "hash/size"), ("symlink", "regular file"), ("traversal", "unsafe")])
def test_candidate_rejects_unsafe_assets(candidate, contract, change, match):
    root, manifest, row, write = candidate
    write([row, copy.deepcopy(row)] if change == "duplicate" else None)
    asset = root / "reference/rows.jsonl"
    if change == "tampered":
        asset.write_text("{}\n")
    elif change == "symlink":
        other = root / "other.jsonl"
        asset.rename(other)
        asset.symlink_to(other)
    elif change == "traversal":
        manifest["assets"][0]["file"] = "../other.jsonl"
        (root / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match=match):
        validate_candidate(root, contract, content_hash(CONTRACT_PATH))


def test_retrospective_generation_keeps_actual_fetch_time(candidate, contract):
    root, manifest, row, write = candidate
    manifest.update(timeMode="retrospective", simulationAsOf="2026-09-09T15:30:00+08:00",
                    reconstructedAt="2026-09-09T17:00:00+08:00")
    write()
    assert validate_candidate(root, contract, content_hash(CONTRACT_PATH))["schemaStatus"] == "pass"
    row["sourceAvailableAt"] = "2026-09-09T15:31:00+08:00"
    write()
    with pytest.raises(ValueError, match="future source"):
        validate_candidate(root, contract, content_hash(CONTRACT_PATH))


def test_diagnostic_missing_availability_stays_unverified(candidate, contract):
    root, _, row, write = candidate
    row.update(sourceAvailableAt=None, qualityFlag="unverified", reason="source time unknown")
    write()
    result = validate_candidate(root, contract, content_hash(CONTRACT_PATH))
    assert result["schemaStatus"] == "pass" and result["promotionAllowed"] is False
