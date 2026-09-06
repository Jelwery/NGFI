---
name: company-research
description: Build, resume, audit, freeze, compare, and adversarially review an NGFI company research case. Use for durable research workspaces, evidence ledgers, auditable company-research workflows, frozen replay, thesis drift, or bull/bear review.
---

# Company Research

Use this Skill only in the `company-research` preset. The domain code owns identity, revisions, hashes, workflow state, audit gates, thesis classification, and adversarial-stage isolation; never reproduce those decisions in prose.

## Workflow

1. Use `finance_research_case` with an explicit `workspace_id`. Create once, then retain its canonical `case_id` and current revision.
2. Gather data through the curated finance tools. Preserve provider, upstream, source kind, retrieval/observation/publication/availability times, period, currency, unit, adjustment, status, warnings, and limitations.
3. Add validated evidence, assumptions, claims, model runs, decisions, memo, run artifacts, and a terminal run manifest with `finance_research_ledger`. Every write includes `expected_revision`; on conflict, reopen rather than overwrite.
4. Use `finance_research_workflow` for `company-research-v1`. A stage result may declare an explicit gap, but the workflow cannot report `complete` unless `finance_research_audit` passes citation, number, calculation, conflict, status, and section gates.
5. Freeze only a complete, non-empty run with `finance_research_snapshot`; verify before seeding or review. Never substitute current provider data for a frozen replay.
6. Use `finance_thesis_drift` only on structured snapshots. A missing baseline is `insufficient`; wording or price-only changes cannot alter unrelated business claims.
7. Use `finance_adversarial_review` only for a verified frozen dossier. Preserve role failures and truncation gaps. Its neutral adjudicator cannot vote out a trade or portfolio weight.

## Boundaries

Never use shell, arbitrary URL, raw provider/MCP, orders, or live trading. Keep `missing`, `no-data`, `unsupported`, `unavailable`, `unauthorized`, `insufficient-permission`, `partial`, `stale`, `unfillable`, `insufficient`, and `failed/error` distinct. Never fill a gap with memory or zero.

Return the case/revision and evidence/run/snapshot hashes used, the audit status, open gaps, and a clear distinction between facts, assumptions, calculations, and interpretation.
