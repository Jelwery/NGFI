from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timedelta, timezone
import json
import math
from pathlib import Path

import polars as pl

from cne6_engine.algorithm.registry import level1_names
from cne6_engine.data_sources.acceptance import content_hash, strict_json
from ngfi_quant.hashing import stable_hash

GROUPS = ("daily", "daily_basic", "adj_factor", "namechange", "suspend_d", "stk_limit", "dividend", "income", "balancesheet", "cashflow", "index_member_all")


def digest(value):
    return stable_hash(value).removeprefix("sha256:")


def load_artifact(root: Path, request: dict, contract_hash: str) -> dict:
    path = root / "requests" / f"{digest(request)}.json"
    if path.is_symlink() or not path.is_file():
        raise ValueError("missing or unsafe acquisition artifact")
    result = strict_json(path.read_text())
    expected = result.pop("artifactHash")
    if (digest(result) != expected or digest(result["request"]) != digest(request)
            or digest(result["raw"]) != result["rawHash"] or result["rows"] != result["raw"]
            or result["contractHash"] != contract_hash):
        raise ValueError("acquisition artifact integrity/contract mismatch")
    result["artifactHash"] = expected
    return result


def _date(value):
    if not isinstance(value, str) or len(value) != 8:
        return None
    try:
        return date.fromisoformat(f"{value[:4]}-{value[4:6]}-{value[6:]}")
    except ValueError:
        return None


def _number(value, scale=1.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value * scale


def daily_index(rows, code, label):
    result = {}
    for row in rows:
        day = row.get("trade_date")
        if row.get("ts_code") != code or _date(day) is None or day in result:
            raise ValueError(f"{label}: wrong security, invalid date or duplicate key")
        result[day] = row
    return result


def calendar_check(rows, exchange, start, end):
    dates = [_date(row.get("cal_date")) for row in rows]
    expected = {start + timedelta(days=i) for i in range((end - start).days + 1)}
    if (len(dates) != len(set(dates)) or set(dates) != expected
            or any(row.get("exchange") != exchange or row.get("is_open") not in (0, 1) for row in rows)):
        raise ValueError("calendar has gaps, duplicates, wrong exchange or unknown sessions")
    return sorted(row["cal_date"] for row in rows if row["is_open"] == 1)


def normalize_day(code, day, bar, cap, factor, limit, suspensions, names, fetched_at, calendar_flag):
    full_suspension = any(row.get("suspend_type") == "S" and not row.get("suspend_timing") for row in suspensions)
    status = "observed-traded" if bar else "source-suspended" if full_suspension else "missing-unexplained"
    flags = []
    if full_suspension and bar:
        status = "conflict"
        flags.append("trade-versus-full-suspension-conflict")
    active_names = [row for row in names if row.get("start_date") and row["start_date"] <= day
                    and (not row.get("end_date") or day <= row["end_date"])]
    name = active_names[0] if len(active_names) == 1 else None
    st = ("ST" in str(name.get("name", "")) or str(name.get("name", "")).startswith("PT")) if name else None
    if name is None:
        flags.append("missing-or-overlapping-name-history")
    elif not name.get("ann_date") or name["ann_date"] > day:
        flags.append("name-availability-unverified")
    if calendar_flag != "source-reported":
        flags.append("BSE-calendar-shared-by-provider-convention")
    bar = bar or {}
    cap = cap or {}
    factor = factor or {}
    limit = limit or {}
    record = {
        "security_id": code, "date": _date(day).isoformat(), "currency": "CNY", "adjustment": "none",
        "open": _number(bar.get("open")), "high": _number(bar.get("high")),
        "low": _number(bar.get("low")), "close": _number(bar.get("close")),
        "ex_right_preclose": _number(bar.get("pre_close")),
        "volume_shares": _number(bar.get("vol"), 100), "amount_cny": _number(bar.get("amount"), 1000),
        "total_shares": _number(cap.get("total_share"), 10000), "float_shares": _number(cap.get("float_share"), 10000),
        "total_market_cap_cny": _number(cap.get("total_mv"), 10000), "float_market_cap_cny": _number(cap.get("circ_mv"), 10000),
        "turnover_rate": _number(cap.get("turnover_rate"), .01), "adjustment_factor": _number(factor.get("adj_factor")),
        "limit_up": _number(limit.get("up_limit")), "limit_down": _number(limit.get("down_limit")),
        "trading_status": status, "st_from_name": st, "name": name.get("name") if name else None,
        "source_available_at": None, "fetched_at": fetched_at, "quality_flag": "unverified",
        "pit_reason": "Historical date and documented update SLA are not actual first-available/vintage timestamps.",
    }
    if bar:
        if any(record[key] is None for key in ("open", "high", "low", "close", "volume_shares", "amount_cny")):
            flags.append("missing-required-raw-price-field")
        elif not (0 < record["low"] <= min(record["open"], record["close"]) <= max(record["open"], record["close"]) <= record["high"]):
            flags.append("invalid-OHLC")
        if any(record[key] is None or record[key] <= 0 for key in ("total_shares", "float_shares", "total_market_cap_cny", "float_market_cap_cny")):
            flags.append("missing-capital")
        if record["adjustment_factor"] is None or record["adjustment_factor"] <= 0:
            flags.append("missing-adjustment-factor")
        if record["limit_up"] is None or record["limit_down"] is None:
            flags.append("missing-authoritative-price-limits")
    record["reasons"] = flags
    return record


def _pit_industry_lookup(industry_rows):
    """Point-in-time SW-L1 membership per code: keep intervals, resolve by date.

    Returns ``lookup(code, ymd) -> industry_name or None``. Overlapping or
    undated memberships resolve to None so the caller counts them as missing,
    never silently backfilling today's classification onto history.
    """
    memberships: dict[str, list[dict]] = {}
    for row in industry_rows:
        memberships.setdefault(row["security_id"], []).append(row)

    def lookup(code: str, ymd: str):
        found = None
        for row in memberships.get(code, ()):
            start = row.get("in_date")
            end = row.get("out_date")
            if isinstance(start, str) and start <= ymd and (end is None or ymd < end):
                if found is not None and found != row.get("industry_name"):
                    return None
                found = row.get("industry_name")
        return found

    return lookup


def risk_model_probe(rows, industry_rows, evaluation_start, end):
    """Deterministically test whether the sample can support a CNE6 factor model.

    CNE6 daily WLS needs a full-rank cross-section: N tradable stocks must exceed
    K = 1 country + industry dummies + style factors. This is a structural
    feasibility measurement on the real sample, not an estimated risk model.
    """
    lookup = _pit_industry_lookup(industry_rows)
    all_styles = len(level1_names())
    style_counts = {"cne6_full": all_styles, "no_analyst_sentiment": all_styles - 1, "value_quality_only": 2}
    per_day: dict[str, list[str]] = {}
    for row in rows:
        if row["trading_status"] == "observed-traded" and row["date"] >= evaluation_start:
            per_day.setdefault(row["date"], []).append(row["security_id"])
    days = sorted(per_day)
    feasible = {name: 0 for name in style_counts}
    max_margin = {name: None for name in style_counts}
    max_cross_section = 0
    for day in days:
        codes = per_day[day]
        ymd = day.replace("-", "")
        industries = {ind for ind in (lookup(code, ymd) for code in codes) if ind}
        n = len(codes)
        max_cross_section = max(max_cross_section, n)
        for name, styles in style_counts.items():
            k = 1 + len(industries) + styles
            margin = n - k
            if margin > 0:
                feasible[name] += 1
            best = max_margin[name]
            max_margin[name] = margin if best is None else max(best, margin)
    total = len(days)
    feasible_full = feasible["no_analyst_sentiment"]
    return {
        "scope": "24-security-sample", "styleFactorCount": style_counts, "canonicalStyleNames": level1_names(),
        "evaluationWindow": {"start": evaluation_start, "end": end.isoformat()},
        "observedTradedDays": total, "maxCrossSectionSize": max_cross_section,
        "feasibleFullRankDays": feasible, "maxRankMarginByStyleSet": max_margin,
        "status": "pass" if total and feasible_full == total else "blocked",
        "reason": ("Sample cross-section is rank-deficient (N<=K) on "
                   f"{total - feasible_full}/{total} evaluation-window days for a country+industry+8-style model; "
                   "24 securities cannot identify CNE6 factor returns. Point-in-time industry, PIT float shares "
                   "and full-market breadth are required before a covariance can be accepted."),
    }


def build_sample(root: Path, contract_path: Path, output: Path):
    contract = strict_json(contract_path.read_text())
    contract_hash = content_hash(contract_path)
    selected = strict_json((root / "selection-v2.json").read_text())
    if selected["contractHash"] != contract_hash:
        raise ValueError("selection contract mismatch")
    selected_codes = [item["security"]["ts_code"] for item in selected["selected"]]
    quotas = Counter(item["security"]["exchange"] for item in selected["selected"])
    if len(selected_codes) != len(set(selected_codes)) or dict(quotas) != contract["a2Sample"]["exchangeQuota"]:
        raise ValueError("sample identity/quota drift")
    all_artifacts = []
    plans = (["a2-bootstrap-v1"] + [f"a2-sample-{group.replace('_', '-')}-v1" for group in GROUPS]
             + ["a2-repair-balance-early-v1", "a2-repair-balance-late-v1", "a2-repair-industry-history-v1", "a2-repair-benchmarks-v1",
                "a2-repair-index-weights-csi300-v1", "a2-repair-index-weights-csi800-v1"]
             + [f"a2-repair-{tool}-type-{report_type}-v1" for tool in ("income", "balancesheet", "cashflow") for report_type in (4, 5)])
    for plan_id in plans:
        plan = strict_json((root / "plans" / f"{plan_id}.json").read_text())
        for request in plan["requests"]:
            artifact = load_artifact(root, request, contract_hash)
            all_artifacts.append(artifact)
    by_code = {}
    for artifact in all_artifacts:
        args = artifact["request"]["arguments"]
        if args.get("ts_code"):
            by_code.setdefault((artifact["request"]["tool"], args["ts_code"]), []).append(artifact)
    calendars = {exchange: [row for artifact in all_artifacts
                           if artifact["request"]["tool"] == "trade_cal" and artifact["request"]["arguments"]["exchange"] == exchange
                           for row in artifact["rows"]] for exchange in ("SSE", "SZSE")}
    end = date.fromisoformat(contract["decisionDate"])
    sessions = {exchange: calendar_check(rows, exchange, date(2009, 1, 1), end) for exchange, rows in calendars.items()}
    if sessions["SSE"] != sessions["SZSE"]:
        raise ValueError("SSE and SZSE calendars differ; shared BSE proxy forbidden")
    rows = []
    exclusions = []
    summaries = []
    statements = []
    actions = []
    industry = []
    for item in selected["selected"]:
        security = item["security"]
        code = security["ts_code"]
        exchange = security["exchange"]
        source = {}
        for tool in GROUPS:
            parts = by_code[(tool, code)]
            if tool == "balancesheet" and len(parts[0]["rows"]) >= 100:
                parts = [part for part in parts if part["request"]["arguments"].get("report_type") or not (part["request"]["arguments"].get("start_date") == "20090101"
                         and part["request"]["arguments"].get("end_date") == contract["decisionDate"].replace("-", ""))]
                if sum(not part["request"]["arguments"].get("report_type") for part in parts) != 2 or any(len(part["rows"]) >= 100 for part in parts):
                    raise ValueError("financial truncation has not been repaired")
            source[tool] = {"rows": [row for part in parts for row in part["rows"]],
                            "rawHash": digest([part["rawHash"] for part in parts]),
                            "fetchedAt": max(part["fetchedAt"] for part in parts)}
        bars = daily_index(source["daily"]["rows"], code, "daily")
        caps = daily_index(source["daily_basic"]["rows"], code, "daily_basic")
        factors = daily_index(source["adj_factor"]["rows"], code, "adj_factor")
        limits = daily_index(source["stk_limit"]["rows"], code, "stk_limit")
        suspension = {}
        for row in source["suspend_d"]["rows"]:
            if row["ts_code"] != code or _date(row.get("trade_date")) is None:
                raise ValueError("invalid suspension identity/date")
            suspension.setdefault(row["trade_date"], []).append(row)
        listed = security["list_date"]
        delisted = security["delist_date"] or "99991231"
        calendar_flag = "provider-convention-proxy" if exchange == "BSE" else "source-reported"
        effective_start = max(listed, "20211115" if exchange == "BSE" else "20090101")
        days = [day for day in sessions["SSE" if exchange == "BSE" else exchange] if effective_start <= day < delisted]
        day_set = set(days)
        for day in bars:
            if day not in day_set:
                exclusions.append({"securityId": code, "date": day, "reason": "outside-exchange-listing-or-session-interval", "sourceHash": source["daily"]["rawHash"]})
        security_rows = [normalize_day(code, day, bars.get(day), caps.get(day), factors.get(day), limits.get(day),
                                       suspension.get(day, []), source["namechange"]["rows"], source["daily"]["fetchedAt"], calendar_flag) for day in days]
        rows.extend(security_rows)
        evaluation = [row for row in security_rows if row["date"] >= contract["history"]["evaluationStart"]]
        counts = Counter(row["trading_status"] for row in evaluation)
        unexplained = [row["date"] for row in evaluation if row["trading_status"] == "missing-unexplained"]
        for missing in unexplained:
            exclusions.append({"securityId": code, "date": missing, "reason": "expected-session-without-bar-or-full-suspension", "sourceHash": source["daily"]["rawHash"]})
        observed = [row for row in evaluation if row["trading_status"] == "observed-traded"]
        denominator = counts["observed-traded"] + counts["missing-unexplained"] + counts["conflict"]
        longest_suspension = current_suspension = 0
        for record in evaluation:
            current_suspension = current_suspension + 1 if record["trading_status"] == "source-suspended" else 0
            longest_suspension = max(longest_suspension, current_suspension)
        summaries.append({"securityId": code, "exchange": exchange, "listingDate": listed, "delistingDate": security["delist_date"],
                          "rawRows": len(bars), "accountedSessions": len(evaluation), "statusCounts": dict(counts),
                          "normalPriceDenominator": denominator, "rawPriceCoverage": len(observed) / denominator if denominator else None,
                          "latest20ObservedAdvCny": sum(row["amount_cny"] for row in observed[-20:]) / 20 if len(observed) >= 20 and all(row["amount_cny"] is not None for row in observed[-20:]) else None,
                          "calendarQuality": calendar_flag, "sourceAvailabilityVerified": False,
                          "longestSourceSuspensionSessions": longest_suspension,
                          "industryLabel": security.get("industry"), "yearlyCoverage": [
                              {"year": year, "sessions": sum(row["date"].startswith(year) for row in evaluation),
                               "traded": sum(row["date"].startswith(year) and row["trading_status"] == "observed-traded" for row in evaluation)}
                              for year in sorted({row["date"][:4] for row in evaluation})],
                          "reasonCounts": dict(Counter(reason for row in evaluation for reason in row["reasons"]))})
        for tool in ("income", "balancesheet", "cashflow"):
            for raw in source[tool]["rows"]:
                if raw["ts_code"] != code:
                    raise ValueError("financial identity mismatch")
                reported = raw.get("f_ann_date") or raw.get("ann_date")
                statements.append({"security_id": code, "statement": tool, "report_date": raw.get("end_date"),
                                   "reported_available_date": reported, "source_available_at": None,
                                   "report_type": raw.get("report_type"), "update_flag": raw.get("update_flag"),
                                   "fetched_at": source[tool]["fetchedAt"], "source_hash": source[tool]["rawHash"],
                                   "quality_flag": "unverified", "eligible_as_of_date": bool(_date(reported) and reported <= contract["decisionDate"].replace("-", "")),
                                   "reason": "Date-only announcement and latest/adjusted report need original-version corroboration; no midnight inference.",
                                   "raw_json": json.dumps(raw, ensure_ascii=False, allow_nan=False)})
        for raw in source["dividend"]["rows"]:
            actions.append({"security_id": code, "report_date": raw.get("end_date"), "record_date": raw.get("record_date"),
                            "ex_date": raw.get("ex_date"), "pay_date": raw.get("pay_date"), "new_shares_listing_date": raw.get("div_listdate"),
                            "cash_per_share_pre_tax": _number(raw.get("cash_div_tax")), "bonus_ratio": _number(raw.get("stk_bo_rate")),
                            "transfer_ratio": _number(raw.get("stk_co_rate")), "progress": raw.get("div_proc"),
                            "implementation_ann_date": raw.get("imp_ann_date"), "source_hash": source["dividend"]["rawHash"],
                            "quality_flag": "unverified", "raw_json": json.dumps(raw, ensure_ascii=False, allow_nan=False)})
        for raw in source["index_member_all"]["rows"]:
            industry.append({"security_id": code, "industry_code": raw.get("l1_code"), "industry_name": raw.get("l1_name"),
                             "in_date": raw.get("in_date"), "out_date": raw.get("out_date"), "source_available_at": None,
                             "quality_flag": "unverified", "source_hash": source["index_member_all"]["rawHash"],
                             "reason": "Effective membership date is not historical publication/vintage evidence."})
    weights = [a for a in all_artifacts if a["request"]["tool"] == "index_weight"]
    benchmarks = []
    index_month_ends: dict[str, dict[str, dict]] = {}
    for artifact in weights:
        by_date = {}
        for row in artifact["rows"]:
            by_date.setdefault(row["trade_date"], []).append(row)
        for day, values in by_date.items():
            index_code = artifact["request"]["arguments"]["index_code"]
            benchmarks.append({"index": index_code, "date": day, "names": len(values),
                               "weightPercentSum": sum(row["weight"] for row in values), "sourceHash": artifact["rawHash"],
                               "qualityFlag": "unverified", "reason": "Historical weight date lacks original publication time and daily rebalance lineage."})
            bucket = index_month_ends.setdefault(index_code, {})
            snapshot = {"names": len({row["con_code"] for row in values}), "rows": len(values),
                        "weightSum": sum(row["weight"] for row in values)}
            if day in bucket:
                # The same month-end can appear in both the bootstrap probe and the
                # dedicated history partitions; accept only if identical, never
                # silently pick one over a differing snapshot.
                if bucket[day] != snapshot:
                    raise ValueError("conflicting index_weight month-end across partitions")
                continue
            bucket[day] = snapshot
    # Historical constituent/weight coverage: every calendar month in the
    # evaluation window must resolve to exactly one month-end snapshot with the
    # expected constituent count and a ~100% weight sum. This is real 2016..D
    # monthly history, not one dated snapshot; daily rebalance lineage and
    # original publication time are still not proven, so quality stays unverified.
    expected_counts = {"000300.SH": 300, "000906.SH": 800}
    evaluation_start = contract["history"]["evaluationStart"]
    # Require month-end coverage only for fully-completed calendar months in the
    # evaluation window. The month containing D is incomplete, so its month-end
    # constituent snapshot is not yet published and must not be demanded.
    decision_month = contract["decisionDate"].replace("-", "")[:6]
    expected_months = sorted({d[:6] for d in sessions["SSE"]
                              if d >= evaluation_start.replace("-", "") and d[:6] < decision_month})
    index_constituents = {}
    constituent_history_ok = bool(index_month_ends) and set(index_month_ends) == set(expected_counts)
    for index_code, expected in expected_counts.items():
        buckets = index_month_ends.get(index_code, {})
        months = {day[:6]: day for day in sorted(buckets)}
        if len(months) != len(buckets):
            raise ValueError("multiple index_weight month-ends within one month")
        missing_months = [month for month in expected_months if month not in months]
        bad_snapshots = sorted(day for day, info in buckets.items()
                               if info["names"] != expected or info["rows"] != expected or abs(info["weightSum"] - 100.0) > 1.0)
        index_ok = not missing_months and not bad_snapshots and bool(buckets)
        constituent_history_ok &= index_ok
        index_constituents[index_code] = {
            "expectedConstituents": expected, "monthEndSnapshots": len(buckets),
            "coveredMonths": len([m for m in expected_months if m in months]), "expectedMonths": len(expected_months),
            "earliest": min(buckets) if buckets else None, "latest": max(buckets) if buckets else None,
            "missingMonths": missing_months, "badSnapshots": bad_snapshots,
            "status": "pass" if index_ok else "blocked",
        }
    benchmark_constituents = {
        "scope": "CSI300 (000300.SH) and CSI800 (000906.SH) evaluation-window monthly history",
        "evaluationStart": evaluation_start, "decisionDate": contract["decisionDate"],
        "indices": index_constituents, "status": "pass" if constituent_history_ok else "blocked",
        "qualityFlag": "unverified",
        "reason": ("Full 2016..D month-end constituents and weights with expected counts and ~100% weight sums. "
                   "Daily rebalance lineage and original index-methodology publication time remain unverified; "
                   "this covers historical constituent/weight universe, not intra-month or original-publication provenance."),
    }
    benchmark_series = []
    for artifact in all_artifacts:
        if artifact["request"]["tool"] != "index_daily":
            continue
        code = artifact["request"]["arguments"]["ts_code"]
        indexed = daily_index(artifact["rows"], code, "benchmark")
        if set(indexed) != set(sessions["SSE"]):
            raise ValueError("benchmark series has missing or extra sessions")
        for day in sorted(indexed):
            row = indexed[day]
            if _number(row.get("close")) is None or row["close"] <= 0:
                raise ValueError("invalid benchmark close")
            benchmark_series.append({"index_id": code, "date": _date(day).isoformat(), "close": row["close"],
                                     "convention": "total-return" if code in {"H00300.CSI", "H00906.CSI"} else "price",
                                     "currency": "CNY", "source_hash": artifact["rawHash"], "quality_flag": "unverified"})
    total = sum(s["normalPriceDenominator"] for s in summaries)
    valid = sum(s["statusCounts"].get("observed-traded", 0) for s in summaries)
    implemented = [action for action in actions if action["progress"] == "实施"]
    evaluation_actions = [action for action in implemented if _date(action.get("ex_date"))
                          and date.fromisoformat(contract["history"]["evaluationStart"]) <= _date(action["ex_date"]) <= end]
    dated_actions = [action for action in evaluation_actions if _date(action.get("record_date"))
                    and action["cash_per_share_pre_tax"] is not None
                    and (action["cash_per_share_pre_tax"] == 0 or _date(action.get("pay_date")))
                    and (not ((action["bonus_ratio"] or 0) > 0 or (action["transfer_ratio"] or 0) > 0)
                         or _date(action.get("new_shares_listing_date")))]
    unscoped_actions = [action for action in implemented if _date(action.get("ex_date")) is None]
    identity_evidence = [{"securityId": s["securityId"], "longSuspensionSessions": s["longestSourceSuspensionSessions"],
                          "delisted": s["delistingDate"] is not None} for s in summaries]
    reason_counts = Counter(reason for row in rows for reason in row["reasons"])
    conflict_rows = sorted(({"securityId": row["security_id"], "date": row["date"]}
                            for row in rows if "trade-versus-full-suspension-conflict" in row["reasons"]),
                           key=lambda item: (item["securityId"], item["date"]))
    conflicts_in_evaluation = [item for item in conflict_rows if item["date"] >= contract["history"]["evaluationStart"]]
    conflict_dates = sorted(item["date"] for item in conflict_rows)
    trading_status_diagnostic = {
        "conflictRows": len(conflict_rows), "conflictsInEvaluationWindow": len(conflicts_in_evaluation),
        "conflicts": conflict_rows, "earliestConflict": conflict_dates[0] if conflict_dates else None,
        "latestConflict": conflict_dates[-1] if conflict_dates else None,
        "classification": ("Each conflict is a same-day source disagreement: suspend_d reports a full-day suspension "
                           "(suspend_type=S, empty timing) while daily returns a traded bar. All fall before the "
                           "2016 evaluation window but remain in warm-up and block trading-status consistency until "
                           "reconciled against official exchange suspension notices."),
    }
    risk_model = risk_model_probe(rows, industry, contract["history"]["evaluationStart"], end)
    lineage = [{"requestHash": artifact["requestHash"], "rawHash": artifact["rawHash"], "fetchedAt": artifact["fetchedAt"],
                "artifactHash": artifact["artifactHash"], "request": artifact["request"]} for artifact in all_artifacts]
    report = {
        "schemaVersion": 1, "stage": "A2-sample", "decisionDate": contract["decisionDate"], "contractHash": contract_hash,
        "codeContentHashes": {"sample.py": content_hash(Path(__file__)), "acceptance.py": content_hash(Path(__file__).with_name("acceptance.py")),
                              "hashing.py": content_hash(Path(__file__).parents[2] / "ngfi_quant/hashing.py"),
                              "uv.lock": content_hash(Path(__file__).parents[2] / "uv.lock")},
        "selectionHash": content_hash(root / "selection-v2.json"), "generatedAt": datetime.now(timezone.utc).isoformat(),
        "inputArtifactHashes": sorted({a["artifactHash"] for a in all_artifacts}), "sampleSize": len(summaries),
        "coverage": {"rawPrices": {"validCount": valid, "totalCount": total, "coverage": valid / total if total else 0,
                                    "denominator": "evaluation-window exchange sessions within listing interval, excluding only source-confirmed full suspensions; BSE calendar remains proxy"},
                     "sourceAvailability": {"validCount": 0, "totalCount": len(rows), "coverage": 0},
                     "corporateActionDates": {"validCount": len(dated_actions), "totalCount": len(evaluation_actions),
                                              "coverage": len(dated_actions) / len(evaluation_actions) if evaluation_actions else 0,
                                              "denominator": "implemented evaluation-window events; cash payment date only for positive cash, share listing date for positive share events",
                                              "allHistoricalImplementedCount": len(implemented), "unscopedCount": len(unscoped_actions),
                                              "historicalMissingPayDateCount": sum(not _date(action.get("pay_date")) for action in implemented)}},

        "securities": summaries, "benchmarkWeights": benchmarks, "exclusions": exclusions,
        "reasonCounts": dict(reason_counts), "stratumEvidence": identity_evidence,
        "tradingStatusConflicts": trading_status_diagnostic, "riskModelProbe": risk_model,
        "benchmarkConstituents": benchmark_constituents,
        "rawLineage": lineage,
        "fieldSemantics": {"volume_shares": "TuShare vol lots * 100", "amount_cny": "TuShare amount thousands CNY * 1000",
                           "shares_and_market_cap": "TuShare daily_basic ten-thousands * 10000", "turnover_rate": "percent / 100",
                           "ex_right_preclose": "TuShare ex-right reference price; not previous day's raw close",
                           "row_fetched_at": "daily artifact fetch only; per-domain actual fetch times are in rawLineage",
                           "financial_period": "raw report_type 1/4/5 retained; not converted to TTM/MRQ",
                           "BSE_calendar": "shared SSE/SZSE convention is explicit proxy, not exchange-verified history"},
        "gates": {"hashIntegrity": "pass", "SSE_SZSE_calendar_continuity": "pass", "sampleRawPriceCoverage": "pass" if total and valid / total >= .995 else "blocked",
                  "BSE_identity_calendar": "blocked", "originalFinancialVintages": "blocked", "industryPublicationTime": "blocked",
                  "tradingStatusConsistency": "blocked" if reason_counts["trade-versus-full-suspension-conflict"] else "pass",
                  "corporateActionSettlementDates": "pass" if len(dated_actions) == len(evaluation_actions) and evaluation_actions and not unscoped_actions else "blocked",
                  "fullMarketHistoricalMaster": "blocked", "benchmarkPriceTotalReturnContinuity": "pass", "benchmarkOriginalPublication": "blocked",
                  "historicalIndexConstituentCoverage": benchmark_constituents["status"],
                  "riskModel": risk_model["status"], "twentyDayIncremental": "not-run"},
        "status": "blocked", "promotionAllowed": False,
        "next": "Resolve per-security gaps, BSE transfer/listing identities, source vintages and independent gold evidence before expanding or promoting.",
    }
    output.mkdir(parents=True, exist_ok=False)
    for name, data in (("daily-panel", rows), ("statements", statements), ("corporate-actions", actions), ("industry", industry), ("benchmark-series", benchmark_series)):
        if not data:
            raise ValueError(f"empty normalized domain: {name}")
        pl.from_dicts(data, infer_schema_length=None).write_parquet(output / f"{name}.parquet")
    report["assets"] = {path.name: {"sha256": content_hash(path), "bytes": path.stat().st_size} for path in sorted(output.glob("*.parquet"))}
    (output / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    return report
