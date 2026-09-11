from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import polars as pl

from cne6_engine.data_sources.acceptance import content_hash, strict_json, validate_contract
from cne6_engine.data_sources.sample import load_artifact


def live_observation_days(records: list[dict], contract_hash: str) -> dict:
    seen = set()
    live_days = []
    rejected = []
    for record in records:
        day = record.get("tradeDate")
        reason = None
        if day in seen:
            reason = "duplicate-session"
        elif record.get("contractHash") != contract_hash:
            reason = "different-contract"
        elif record.get("mode") != "live":
            reason = "not-live"
        elif record.get("sourceStatus") != "pass":
            reason = "source-check-failed"
        else:
            try:
                start = datetime.fromisoformat(record["startedAt"].replace("Z", "+00:00"))
                finish = datetime.fromisoformat(record["finishedAt"].replace("Z", "+00:00"))
                now = datetime.now(timezone.utc)
                if start.tzinfo is None or finish.tzinfo is None:
                    raise ValueError("timezone required")
                local = start.astimezone(ZoneInfo("Asia/Shanghai"))
                if (start > finish or finish > now or local.date().isoformat() != day
                        or finish.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat() != day
                        or local.hour < 17):
                    reason = "backdated-or-premature-observation"
            except (ValueError, KeyError, TypeError):
                reason = "invalid-observation-time"
        if reason:
            rejected.append({"tradeDate": day, "reason": reason})
        else:
            seen.add(day)
            live_days.append(day)
    return {"distinctLiveSourceDays": sorted(live_days), "sourceDayCount": len(live_days),
            "rejected": rejected, "publicationStabilityStatus": "not-evaluated",
            "reason": "Source probes are not accepted incremental publications; the 20-session publication gate is separate."}


def audit_a2(root: Path, candidate: Path, contract_path: Path, repo_root: Path) -> dict:
    contract = strict_json(contract_path.read_text())
    validate_contract(contract, repo_root)
    contract_hash = content_hash(contract_path)
    report_path = candidate / "acceptance.json"
    if report_path.is_symlink() or not report_path.is_file():
        raise ValueError("candidate acceptance must be a regular file")
    source_report = strict_json(report_path.read_text())
    if source_report.get("contractHash") != contract_hash or source_report.get("stage") != "A2-sample":
        raise ValueError("expected sample report tied to frozen A2 contract")
    required_assets = {"daily-panel.parquet", "statements.parquet", "industry.parquet", "corporate-actions.parquet", "benchmark-series.parquet"}
    if set(source_report.get("assets", {})) != required_assets or not source_report.get("rawLineage"):
        raise ValueError("sample asset manifest and raw lineage must be complete and non-empty")
    verified_rows = {}
    for filename, entry in source_report["assets"].items():
        if "/" in filename or "\\" in filename or not filename.endswith(".parquet"):
            raise ValueError("unsafe candidate asset name")
        path = candidate / filename
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["bytes"] or content_hash(path) != entry["sha256"]:
            raise ValueError("candidate asset integrity failed")
        verified_rows[filename] = pl.scan_parquet(path).select(pl.len()).collect().item()
    hashes = set()
    for source in source_report["rawLineage"]:
        artifact = load_artifact(root, source["request"], contract_hash)
        if artifact["artifactHash"] != source["artifactHash"]:
            raise ValueError("candidate raw lineage mismatch")
        hashes.add(artifact["artifactHash"])
    if hashes != set(source_report["inputArtifactHashes"]):
        raise ValueError("candidate raw lineage set mismatch")
    observations = []
    observation_refs = []
    observation_root = root / "observations"
    if observation_root.is_symlink():
        raise ValueError("observation root must not be a symlink")
    if observation_root.exists():
        for path in sorted(observation_root.glob("*/observation.json")):
            if path.is_symlink() or path.parent.is_symlink():
                raise ValueError("observation must be a regular file")
            observation = strict_json(path.read_text())
            name = observation.get("acquisitionReportFile")
            if not isinstance(name, str) or Path(name).name != name or not name.endswith(".json"):
                raise ValueError("observation requires a safe acquisition report reference")
            acquisition_path = path.parent / "runs" / name
            if acquisition_path.parent.is_symlink() or acquisition_path.is_symlink() or content_hash(acquisition_path) != observation.get("acquisitionReportHash"):
                raise ValueError("observation acquisition report integrity failed")
            acquisition = strict_json(acquisition_path.read_text())
            if (acquisition.get("plan", {}).get("contractHash") != contract_hash
                    or acquisition["plan"].get("decisionDate") != observation.get("tradeDate")):
                raise ValueError("observation acquisition contract/date mismatch")
            if observation.get("sourceStatus") == "pass":
                results = acquisition.get("results", [])
                if acquisition.get("status") != "collected" or acquisition.get("requestStarts") != 4 or len(results) != 4:
                    raise ValueError("live acquisition must execute all four source requests")
                artifacts = [load_artifact(path.parent, request, contract_hash) for request in acquisition["plan"]["requests"]]
                by_tool = {artifact["request"]["tool"]: artifact for artifact in artifacts}
                if len(artifacts) != 4 or set(by_tool) != {"daily", "daily_basic", "trade_cal", "suspend_d"}:
                    raise ValueError("live acquisition source inventory mismatch")
                day = observation["tradeDate"].replace("-", "")
                for artifact in artifacts:
                    fetched = datetime.fromisoformat(artifact["fetchedAt"].replace("Z", "+00:00"))
                    if fetched.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat() != observation["tradeDate"]:
                        raise ValueError("live acquisition was not fetched on the observed date")
                    if any((row.get("trade_date") or row.get("cal_date")) != day for row in artifact["rows"]):
                        raise ValueError("live acquisition returned a different date")
                calendar = by_tool["trade_cal"]["rows"]
                prices = by_tool["daily"]["rows"]
                capital = by_tool["daily_basic"]["rows"]
                if len(calendar) != 1 or calendar[0].get("is_open") != 1 or not prices:
                    raise ValueError("live acquisition must be an open market session")
                price_codes = {row["ts_code"] for row in prices}
                capital_codes = {row["ts_code"] for row in capital}
                if price_codes != capital_codes or len(price_codes) != len(prices) or len(capital_codes) != len(capital):
                    raise ValueError("live acquisition identity coverage mismatch")
            observations.append(observation)
            observation_refs.append({"tradeDate": observation.get("tradeDate"), "sha256": content_hash(path)})
    observation_summary = live_observation_days(observations, contract_hash)
    gates = [{"id": key, "status": value, "scope": "sample-reported", "evidenceHash": content_hash(report_path)}
             for key, value in source_report["gates"].items()]
    gates.extend([
        {"id": "artifactIntegrity", "status": "pass", "scope": "verified-locally", "assetRows": verified_rows, "rawArtifacts": len(hashes)},
        {"id": "historicalIndexConstituentCoverage", "status": "blocked", "scope": "full-history",
         "reason": "One dated CSI300/800 weight snapshot is not the 2016..D historical constituent/weight universe."},
        {"id": "fullMarketCoverage", "status": "blocked", "scope": "full-market",
         "reason": "24-security sample and D-day cross-section cannot establish full historical market coverage."},
        {"id": "riskAcceptance", "status": "blocked", "scope": "full-market",
         "reason": "No accepted full-market 42-descriptor/risk coverage and covariance calibration artifacts; historical factor dictionary still needs correction."},
        {"id": "incrementalPublicationStability", "status": "blocked", "requiredTradingDays": contract["thresholds"]["incrementalTradingDays"],
         "acceptedPublicationDays": 0, "reason": "No accepted publication observation chain. Do not count historical downloads or same-day repeats as elapsed sessions."},
    ])
    return {"schemaVersion": 1, "kind": "DataAcceptanceRun", "stage": "A2", "status": "blocked",
            "generatedAt": datetime.now(timezone.utc).isoformat(), "decisionDate": contract["decisionDate"],
            "window": contract["history"], "contractHash": contract_hash,
            "scope": {"requested": "SSE/SZSE/BSE-full-market", "observed": "24-security-sample-and-D-cross-section"},
            "sampleReportHash": content_hash(report_path), "sampleSize": source_report["sampleSize"],
            "gates": gates, "sourceObservation": observation_summary, "observationRefs": observation_refs,
            "promotionAllowed": False, "readyForA3": False,
            "limitations": ["This gate verifies existing sample artifacts; it does not certify external source truth from a declared pass flag.",
                            "No formal publication or CURRENT change is performed."]}
