from __future__ import annotations

import hashlib
import json
import math
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from cne6_engine.algorithm.registry import DESCRIPTORS
from cne6_engine.data_sources.publication import resolve_published_root

DOMAIN_IDS = {
    "securities", "calendar", "raw-prices", "trading-status", "trading-rules",
    "capital", "industry", "financials", "corporate-actions", "benchmarks",
    "research-documents", "analyst",
}
UNIVERSE_IDS = {"U_all", "U_eligible", "U_model", "U_research", "U_hold", "U_benchmark"}
FLAGS = {"real", "proxy", "missing", "imputed", "unverified"}


def content_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def strict_json(payload: str) -> dict[str, Any]:
    def invalid(value):
        raise ValueError(f"non-finite JSON number: {value}")
    def finite_float(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            invalid(value)
        return parsed
    result = json.loads(payload, object_pairs_hook=_unique_object, parse_constant=invalid, parse_float=finite_float)
    if not isinstance(result, dict):
        raise ValueError("expected a JSON object")
    return result


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def _keys(value: Any, expected: set[str], label: str) -> None:
    _require(isinstance(value, dict) and set(value) == expected, f"{label}: unexpected or missing fields")


def _timestamp(value: Any, label: str) -> datetime:
    _require(isinstance(value, str), f"{label}: timestamp required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _require(parsed.tzinfo is not None, f"{label}: timezone required")
    return parsed


def _hash(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def validate_contract(contract: dict[str, Any], repo_root: Path) -> None:
    _keys(contract, {
        "schemaVersion", "contractVersion", "taskStartedAt", "frozenAt", "decisionDate", "decisionDateBasis",
        "timezone", "currency", "purposes", "history", "universes", "benchmarks",
        "thresholds", "resources", "timeContract", "publicationPolicy", "domains", "a2Sample",
    }, "contract")
    _require(contract["schemaVersion"] == 1, "unsupported contract version")
    _require(contract["timezone"] == "Asia/Shanghai" and contract["currency"] == "CNY", "unsupported market convention")
    frozen = _timestamp(contract["frozenAt"], "frozenAt")
    started = _timestamp(contract["taskStartedAt"], "taskStartedAt")
    _require(started <= frozen, "freeze must not predate task start")
    decision = date.fromisoformat(contract["decisionDate"])
    _require(decision <= started.astimezone(ZoneInfo(contract["timezone"])).date(), "D cannot be after the frozen task date")
    _require(set(contract["purposes"]) == {"research-diagnostic", "strategy-validation"}, "purpose separation required")
    _require(set(contract["universes"]) == UNIVERSE_IDS, "all six universes must be declared")
    history = contract["history"]
    _require(history["evaluationStart"] == "2016-01-01" and history["evaluationEnd"] == decision.isoformat(), "registered historical window changed")
    _require(history["minimumPriceWarmupTradingDays"] >= 1576 and history["minimumAnnualReportsBeforeFirstExposure"] >= 6, "insufficient warm-up")
    thresholds = contract["thresholds"]
    for key in ("universeAccounted", "consumedPitVerified", "consumedRawPrices", "holdingsRisk", "usedBenchmarkRisk", "constraintInputs"):
        _require(thresholds[key] == 1, f"{key} must be 100%")
    for key, minimum in (("normalTradableRawPrices", .995), ("eligibleRiskByNames", .98), ("eligibleRiskByFloatCap", .995)):
        _require(minimum <= thresholds[key] <= 1, f"{key}: cannot weaken registered coverage")
    _require(thresholds["descriptorCount"] == len(DESCRIPTORS) == 42, "descriptor registry drift")
    for key in ("futureRows", "duplicateKeys", "wrongCurrency", "mixedAdjustment", "goldSampleErrors", "hardConstraintViolations"):
        _require(thresholds[key] == 0, f"{key}: zero tolerance required")
    _require(thresholds["incrementalTradingDays"] >= 20, "incremental observation must span 20 actual trading days")
    _require(0 < thresholds["covarianceMaxRelativeRepairFrobenius"] <= .01, "PSD repair budget cannot be weakened")
    _require(contract["resources"]["acquisitionWorkers"] == 1 and contract["resources"]["attemptsPerPartition"] == 1, "initial acquisition must be single-worker/no-retry")
    _require(contract["resources"]["initialBatchRequestBudget"] <= 30, "initial request budget exceeded")
    _require(contract["publicationPolicy"]["candidateOnlyUntilA2"] is True, "A1 cannot enable formal promotion")
    _require(set(contract["publicationPolicy"]["qualityFlags"]) == FLAGS, "quality flag drift")
    domains = contract["domains"]
    _require(len(domains) == len(DOMAIN_IDS) and {row["id"] for row in domains} == DOMAIN_IDS, "domain inventory incomplete or duplicated")
    for row in domains:
        _keys(row, {"id", "required", "fields", "candidateSources", "codeRefs", "availability", "pit", "usageRights", "gap", "todo"}, row["id"])
        _require(row["required"] is (row["id"] != "analyst"), "required domain cannot be silently disabled")
        _require(row["availability"] in {"partial", "blocked", "verified"}, "invalid source status")
        _require(row["pit"] in {"real", "proxy", "missing", "unverified"}, "invalid source quality")
        for key in ("fields", "candidateSources", "usageRights", "codeRefs"):
            _require(bool(row[key]), f"{row['id']}: missing {key}")
        if row["availability"] != "verified":
            _require(bool(row["gap"]) and row["todo"].startswith("DATA-"), f"{row['id']}: explicit source/authorization action required")
        for reference in row["codeRefs"]:
            path = repo_root / reference
            _require(not Path(reference).is_absolute() and ".." not in Path(reference).parts and path.is_file(), f"missing code evidence: {reference}")
    sample = contract["a2Sample"]
    _require(20 <= sample["size"] <= 50 and sum(sample["exchangeQuota"].values()) == sample["size"], "invalid stratified sample size")
    _require(set(sample["exchangeQuota"]) == {"SSE", "SZSE", "BSE"}, "all three exchanges required")
    _require(sample["strategyPromotionAllowed"] is False, "sample cannot promote strategy")


def publication_schema(contract: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "manifestRequiredKeys": contract["publicationPolicy"]["requiredManifestFields"],
        "manifestAdditionalKeys": ["simulationAsOf", "reconstructedAt"],
        "assetRequiredKeys": ["file", "sha256", "bytes", "rows"],
        "assetFormat": "UTF-8 JSONL record envelopes; path must be a plain filename under candidate/reference",
        "sourceRequiredKeys": ["id", "authorizationCategory", "authorizationEvidenceHash"],
        "authorizationCategories": ["public-diagnostic", "licensed-research", "official-permitted", "unconfirmed"],
        "recordRequiredKeys": contract["publicationPolicy"]["requiredRowEnvelope"],
        "recordKey": ["domain", "securityId", "field", "economicEffectiveAt", "sourceVersion"],
        "qualityRequiredKeys": ["domain", "qualityFlag", "validCount", "totalCount", "coverage", "denominator", "denominatorHash", "reason"],
        "failureRequiredKeys": ["domain", "securityId", "reason"],
        "qualityFlags": sorted(FLAGS),
        "universeRequiredKeys": sorted(UNIVERSE_IDS),
        "universeValue": "sha256 of explicit membership/exclusion artifact; hash is integrity, not a coverage attestation",
        "temporalSemantics": contract["timeContract"],
        "promotion": "Never by schema validation. A2 independently verifies scope, rows, provenance, stratified denominators and acceptance gates before CURRENT may change.",
    }


def validate_candidate(root: Path, contract: dict[str, Any], contract_hash: str) -> dict[str, Any]:
    _require(not root.is_symlink(), "candidate root must not be symlink")
    manifest_path = root / "manifest.json"
    _require(manifest_path.is_file() and not manifest_path.is_symlink(), "manifest must be a regular file")
    _require(manifest_path.stat().st_size <= 8 * 1024 * 1024, "manifest exceeds size budget")
    manifest = strict_json(manifest_path.read_text())
    required = set(contract["publicationPolicy"]["requiredManifestFields"])
    extra = {"simulationAsOf", "reconstructedAt"} if manifest.get("timeMode") == "retrospective" else set()
    _keys(manifest, required | extra, "manifest")
    _require(manifest["schemaVersion"] == 1 and manifest["recordSchema"] == 1, "unsupported publication schema")
    _require(manifest["contractHash"] == contract_hash, "frozen contract hash mismatch")
    _require(manifest["purpose"] in contract["purposes"], "unknown purpose")
    _require(manifest["decisionDate"] == contract["decisionDate"], "D drift")
    _keys(manifest["window"], {"start", "end"}, "window")
    window_start = date.fromisoformat(manifest["window"]["start"])
    window_end = date.fromisoformat(manifest["window"]["end"])
    _require(window_start <= window_end <= date.fromisoformat(contract["decisionDate"]), "invalid publication window")
    created = _timestamp(manifest["createdAt"], "createdAt")
    _require(created <= datetime.now(timezone.utc), "future generation time")
    _require(manifest["publishedAt"] is None and manifest["availableAt"] is None,
             "candidate cannot claim formal publication or signal availability")
    _require(_hash(manifest["codeHash"]) and _hash(manifest["ruleHash"]), "code/rule content hashes required")
    _keys(manifest["universe"], UNIVERSE_IDS, "universe")
    _require(all(_hash(value) for value in manifest["universe"].values()), "universe content hashes required")
    _require(manifest["timeMode"] in {"contemporaneous", "retrospective"}, "invalid time mode")
    cutoff = created
    if extra:
        cutoff = _timestamp(manifest["simulationAsOf"], "simulationAsOf")
        reconstructed = _timestamp(manifest["reconstructedAt"], "reconstructedAt")
        _require(cutoff <= reconstructed <= created, "retrospective time ordering invalid")
    sources = {}
    for source in manifest["sources"]:
        _keys(source, {"id", "authorizationCategory", "authorizationEvidenceHash"}, "source")
        _require(isinstance(source["id"], str) and bool(source["id"]) and source["id"] not in sources, "source id missing/duplicated")
        _require(source["authorizationCategory"] in {"public-diagnostic", "licensed-research", "official-permitted", "unconfirmed"}, "unknown authorization category")
        evidence_hash = source["authorizationEvidenceHash"]
        _require(evidence_hash is None or _hash(evidence_hash), "invalid authorization evidence hash")
        sources[source["id"]] = source
    _require(bool(sources), "sources required")
    reference = root / "reference"
    _require(reference.is_dir() and not reference.is_symlink(), "reference must be plain directory")
    seen_assets: set[str] = set()
    seen_records: set[tuple[Any, ...]] = set()
    row_count = 0
    for asset in manifest["assets"]:
        _keys(asset, {"file", "sha256", "bytes", "rows"}, "asset")
        name = asset["file"]
        _require(isinstance(name, str) and name.endswith(".jsonl") and "/" not in name and "\\" not in name and name not in seen_assets, "unsafe/duplicated asset filename")
        seen_assets.add(name)
        path = reference / name
        _require(path.is_file() and not path.is_symlink(), "asset must be a regular file")
        _require(type(asset["bytes"]) is int and 0 < asset["bytes"] <= 64 * 1024 * 1024, "invalid asset size; partition sample assets")
        _require(type(asset["rows"]) is int and asset["rows"] > 0, "asset row count required")
        _require(path.stat().st_size == asset["bytes"] and content_hash(path) == asset["sha256"], "asset content hash/size mismatch")
        count = 0
        with path.open() as stream:
            for line in stream:
                _require(len(line) <= 1024 * 1024, "record exceeds sample budget")
                row = strict_json(line)
                _keys(row, set(contract["publicationPolicy"]["requiredRowEnvelope"]), "record")
                _require(row["domain"] in DOMAIN_IDS and row["qualityFlag"] in FLAGS, "unknown record domain/quality")
                for key in ("securityId", "field", "unit", "sourceVersion", "locator"):
                    _require(isinstance(row[key], str) and bool(row[key]), f"record {key} required")
                _require(row["currency"] in {None, "CNY"}, "wrong currency")
                if isinstance(row["value"], (int, float)) and not isinstance(row["value"], bool):
                    _require(math.isfinite(row["value"]), "non-finite value")
                _require(row["qualityFlag"] != "missing" or row["value"] is None, "missing value must be null")
                if row["qualityFlag"] != "real":
                    _require(isinstance(row["reason"], str) and bool(row["reason"]), "degradation must explain why")
                else:
                    _require(row["value"] is not None, "real value cannot be null")
                _require(_hash(row["sourceContentHash"]) and row["sourceId"] in sources, "source lineage missing")
                effective = _timestamp(row["economicEffectiveAt"], "economicEffectiveAt")
                if row["domain"] in {"raw-prices", "trading-status", "calendar"}:
                    _require(window_start <= effective.astimezone(ZoneInfo(contract["timezone"])).date() <= window_end,
                             "record outside publication window")
                fetched = _timestamp(row["firstFetchedAt"], "firstFetchedAt")
                _require(fetched <= created, "input fetched after generation")
                if row["revisionFetchedAt"] is not None:
                    revision = _timestamp(row["revisionFetchedAt"], "revisionFetchedAt")
                    _require(fetched <= revision <= created, "revision fetched time ordering invalid")
                if row["sourceAvailableAt"] is None:
                    _require(row["qualityFlag"] != "real" and manifest["purpose"] == "research-diagnostic", "unknown PIT cannot enter strategy validation")
                else:
                    available = _timestamp(row["sourceAvailableAt"], "sourceAvailableAt")
                    _require(available <= fetched and available <= cutoff, "future source input")
                if manifest["purpose"] == "strategy-validation":
                    _require(row["qualityFlag"] == "real", "strategy candidate cannot consume degraded records")
                    source = sources[row["sourceId"]]
                    _require(source["authorizationCategory"] in {"licensed-research", "official-permitted"} and _hash(source["authorizationEvidenceHash"]), "strategy authorization evidence required")
                key = tuple(row[field] for field in ("domain", "securityId", "field", "economicEffectiveAt", "sourceVersion"))
                _require(key not in seen_records, "duplicate record key")
                seen_records.add(key)
                count += 1
        _require(count == asset["rows"], "asset row count mismatch")
        row_count += count
    _require(bool(seen_assets), "empty candidate cannot pass")
    quality_domains = set()
    for row in manifest["quality"]:
        _keys(row, {"domain", "qualityFlag", "validCount", "totalCount", "coverage", "denominator", "denominatorHash", "reason"}, "quality")
        _require(isinstance(row["denominator"], str) and bool(row["denominator"]) and _hash(row["denominatorHash"]), "quality original denominator identity required")
        _require(row["domain"] in DOMAIN_IDS and row["domain"] not in quality_domains and row["qualityFlag"] in FLAGS, "quality domain duplicated/unknown")
        quality_domains.add(row["domain"])
        valid, total = row["validCount"], row["totalCount"]
        _require(type(valid) is int and type(total) is int and 0 <= valid <= total, "invalid quality denominator")
        coverage = valid / total if total else 0
        _require(type(row["coverage"]) in (int, float) and math.isfinite(row["coverage"]) and abs(row["coverage"] - coverage) <= 1e-12, "quality coverage inconsistent with counts")
        _require(bool(row["reason"]) or (valid == total and total > 0 and row["qualityFlag"] == "real"), "quality degradation/empty denominator requires reason")
    _require(quality_domains == DOMAIN_IDS, "all domains must retain quality denominators")
    for failure in manifest["failures"]:
        _keys(failure, {"domain", "securityId", "reason"}, "failure")
        _require(failure["domain"] in DOMAIN_IDS and bool(failure["reason"]) and bool(failure["securityId"]), "invalid per-security failure")
    return {"schemaStatus": "pass", "rows": row_count, "manifestHash": content_hash(manifest_path),
            "dataAcceptanceStatus": "not-evaluated", "promotionAllowed": False,
            "reason": "A1 validates structure/integrity/time ordering only; source authenticity, denominators and A2 gates remain independent."}


def inventory(contract_path: Path, repo_root: Path) -> dict[str, Any]:
    contract = strict_json(contract_path.read_text())
    validate_contract(contract, repo_root)
    configured = os.environ.get("CNE6_DATA_ROOT", "").strip()
    data_root = Path(configured).expanduser() if configured else repo_root / "packages/combinatorial-optimization/data"
    publication: dict[str, Any] = {"rootKind": "configured" if configured else "default", "exists": data_root.exists(), "status": "missing"}
    if data_root.exists():
        try:
            published, snapshot_id = resolve_published_root(data_root)
            publication.update({"status": "integrity-verified" if snapshot_id else "legacy-unverified", "snapshotId": snapshot_id,
                                "qualityReportPresent": (published / "quality-report.json").is_file()})
        except (ValueError, OSError) as exc:
            publication.update({"status": "invalid", "errorType": type(exc).__name__})
    gaps = [{"domain": row["id"], "required": row["required"], "status": row["availability"],
             "qualityFlag": row["pit"], "gap": row["gap"], "todo": row["todo"]}
            for row in contract["domains"] if row["availability"] != "verified"]
    return {
        "schemaVersion": 1, "contractVersion": contract["contractVersion"], "contractHash": content_hash(contract_path),
        "generatedAt": datetime.now(timezone.utc).isoformat(), "decisionDate": contract["decisionDate"],
        "a0ContractStatus": "pass", "a1InventoryStatus": "pass", "publication": publication,
        "configuration": {key: bool(os.environ.get(key)) for key in ("TUSHARE_TOKEN", "TUSHARE_MCP_URL", "IFIND_MCP_URL", "IFIND_MCP_CREDENTIAL", "CNE6_DATA_ROOT")},
        "configurationScope": "Process environment only; no secret files or browser credentials read. Configured is not authorization verified.",
        "sourceGaps": gaps, "publicationSchema": publication_schema(contract),
        "dataAcceptanceStatus": "blocked", "strategyPromotionAllowed": False,
        "next": {"stage": "A2", "status": "blocked", "scope": contract["a2Sample"],
                 "reason": "Historical security master, lawful PIT fields, three-exchange calendar and independent source attestation are not yet accepted; do not run bulk rebuild."},
    }
