---
name: company-research
description: Research a public company or stock end to end, including business quality, financial statements, independent valuation, consensus, bull/bear cases, catalysts and risks. Use for company research, equity deep dives, investment memos, 公司深度研究、个股研报、帮我看看这家公司, or creating/resuming/auditing/freezing a durable research case. Works ephemerally in finance-analyst and with an audited ledger when research tools are available.
---

# Company research

Use the smallest complete evidence chain. `financial-analysis` owns financial quality and industry/fatal gates; `equity-valuation` owns independent DCF, comps and consensus. Do not launch a second six-stage filesystem workflow.

## 1. Scope and choose persistence

Confirm unique ticker/listing, currency, analysis cutoff, horizon and requested scope. Ambiguous identity is `needs_input`; never guess the company or silently change listing.

- **Research tools available**: use `finance_research_case` with explicit `workspace_id`; retain canonical `case_id` and current revision. Use the audited case path below.
- **Research tools absent** (for example `finance-analyst`): continue with exposed curated finance tools and a conversation-local evidence table. State **“ephemeral / not persisted / 未持久化”**. Do not invent a case ID, ledger write, audit pass, snapshot or resume capability. If durable storage is required, return `needs_input` and request the research preset.
- Never require shell, arbitrary URLs, raw provider/MCP access, external search or delegation. Offline helpers are not callable finance tools; do not claim to have run them.

## 2. Ground and analyze

1. Resolve with `finance_security_reference`; obtain statements with `finance_fundamentals`. Use `ticker-snapshot` for an optional market context section, but isolate price observations from intrinsic assumptions.
2. Preserve provider, upstream, source kind, source ID, retrieval/observation/publication/availability time, reporting period, currency, unit, adjustment, status, warnings and limitations. Frozen evidence outranks incompatible live data; a vendor is not automatically an exchange source. Do not count two wrappers over one upstream as independent corroboration.
3. Apply PIT: publication/availability must be at or before the cutoff. Retrieval time alone does not establish historical availability; unknown PIT is a gap, not an invented date. Never substitute live data for frozen replay.
4. Analyze business model, competitors, moat and governance only from read evidence. Consult `financial-analysis` for annual/quarterly/TTM separation, three-statement checks, financial-enterprise rules and fatal gates. Unknown industry or missing safety evidence cannot pass a gate. On `fatal`, stop models and report the trigger, period and sources.
5. Use `equity-valuation`: lock independent assumptions/results first, then optionally compare contemporaneous price/consensus. Keep intrinsic-only output when requested. Reconcile methods; do not average DCF, peer multiples and analyst targets mechanically.
6. Synthesize base/bull/bear drivers, catalysts, risks, alternative explanations and falsifiers. Distinguish facts, assumptions, calculations and interpretation.

## 3. Audited case path

Only use tools actually exposed by the preset. Domain code owns revisions, hashes, workflow state, audit gates and isolation; do not reproduce a passed audit in prose.

1. Append evidence, assumptions, claims, model runs, decisions, memo, run artifacts and terminal run manifest with `finance_research_ledger`. Every write uses `expected_revision`; on conflict reopen, do not overwrite.
2. Drive `company-research-v1` with `finance_research_workflow`. Record gaps and blocked stages explicitly. Completion requires `finance_research_audit` citation, number, calculation, conflict, status and section gates to pass.
3. Freeze only complete non-empty runs with `finance_research_snapshot`; verify hashes before replay/review. Retain original evidence, model inputs, outputs and provenance. Never delete intermediate audit evidence to leave only a report/state file.
4. For updates, compare structured snapshots via `finance_thesis_drift`; missing baseline is `insufficient`, and price-only changes cannot rewrite business claims.
5. For adversarial review, use `finance_adversarial_review` only on verified frozen dossiers. Preserve failed/truncated roles and gaps. Adjudication does not authorize trades or portfolio weights.

## Output and stopping rules

Return executive view; scope and cutoff; business drivers; financial quality and gates; valuation assumptions/results/sensitivity; peers/consensus when supported; bull/base/bear cases; catalysts/risks/falsifiers; sources and open gaps. For durable work include case/revision, evidence/run/snapshot hashes and actual audit status; otherwise repeat **not persisted**.

Use `ok|partial|needs_input|data_conflict|tool_error|fatal` for the analysis summary; retain the original tool/field statuses, including `missing`, `no-data`, `unsupported`, `unavailable`, `unauthorized`, `insufficient-permission`, `stale`, `unfillable`, `insufficient` and `failed/error`. Never convert missing data to zero or model memory. No personalized trade recommendation, order execution or live trading.
