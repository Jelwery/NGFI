---
name: financial-analysis
description: Analyze company financial statements, earnings quality, revenue/margins, balance sheet, cash conversion, DuPont/ROA, risk screens and new annual or quarterly results. Use for 财报分析、公司财务分析、三表勾稽、杜邦分析、银行保险券商财务分析、更新财报, fundamentals reviews, leverage, or historical-versus-TTM comparisons. Preserve financial-enterprise methods and stop valuation on fatal signals; use equity-valuation for pricing models and company-research for full research cases.
---

# Financial analysis

## V2 execution contract

Use available finance tools and the research ledger, not a second research workflow. Status is `ok|partial|needs_input|data_conflict|tool_error|fatal`; preserve more specific upstream field statuses. `fatal` stops subsequent risk synthesis/valuation; missing inputs are not a fabricated fatal company fact or a passed safety check.

## Workflow

1. **Identity and evidence** — resolve unique ticker/listing with `finance_security_reference`, then call `finance_fundamentals`. A-share data requests use `a-share-data-research` routing only if that capability is exposed. No mandatory shell, WebSearch, raw provider or arbitrary URL access. Read supplied audit/frozen files when available; do not claim an unavailable tool executed.
2. **Source and PIT gate** — retain provider/upstream/source kind, period, currency/unit, retrieval/observation/publication/availability timestamps, status and limitations. Respect cutoff and frozen snapshot. If publication/availability is unknown, disclose PIT uncertainty; never use retrieval time as historical availability. Reconcile revenue, parent profit, EPS and assets against official filings or already validated evidence; vendor-normalized data is not automatically L1/exchange-direct. A material unresolved conflict is `data_conflict`.
3. **Industry gate** — lock `GENERAL|BANK|INSURANCE|BROKER|FINANCIAL_HOLDING`; `UNKNOWN` remains `partial/needs_input`, not silently GENERAL. Read `references/financial-enterprise.md` for financial businesses. Explicitly state “通用 Z/M 模型不适用”. Banks require NIM, bad-loan ratio, provision coverage, CET1 and deposit/liquidity structure; lending-driven negative OCF is not automatically a crisis. Insurance requires solvency and distinguishes underwriting, investment earnings, EV/VNB; brokers separate client money; holding companies use segment analysis/SOTP.
4. **Three statements** — separate annual, quarterly/YTD and TTM. Do not compare a quarter to a full year or fabricate TTM from incomplete quarters. Review growth, gross/operating/net margin, nonrecurring profit, operating cash conversion, capex and liquidity. Missing cash, debt or capex stays unknown. Use the progressive stage references for notes, reclassification, cash-flow timing and governance.
5. **Calculations** — prefer narrow finance calculation tools actually present. Ratio/risk helpers below are offline support, not invented tool names. ROA 的定义固定为 `EBIT / 总资产`, with EBIT/interest definition disclosed; distinguish net-profit ROA. Keep DuPont dynamics, ROA versus borrowing cost, Altman Z components, Beneish M, AG and Benford support. A heuristic imputation must carry quality limitations and cannot establish a fatal gate alone.
6. **Cross-check and fatal gate** — independently verify CV-1 through CV-4 using traceable inputs/results. CV-1 requires all four comparisons for the same comparable periods: profit growth > revenue growth; OCF growth < profit growth; inventory growth > revenue growth; payables growth < revenue growth. Missing/invalid growth baselines cannot pass or trigger it. Check the complete fatal list in `references/fatal-gates.md` and financial-industry thresholds before valuation; record `pass|blocked|fatal` with formulas, values, period, sources and next action. `fatal` means “分析终止”, no valuation result. Missing solvency/safety data blocks valuation without alleging insolvency.
7. **Persist or report** — when `finance_research_ledger` is present, append evidence, calculation inputs/results, quality, assumptions and gate decisions under the case with `expected_revision`. Otherwise report ephemerally, explicitly **not persisted**. Retain source files, calculation artifacts and provenance; never delete audit evidence. Hand off a supported, gate-passed model request to `equity-valuation`, not an automatic six-stage calculation pipeline.

## Offline support, not runtime permissions

Canonical helpers live in `packages/finance-core/python/`, resolved from the repository root, not copied into a company directory:

- `calc_ratios.py`: `calc_all(data)` and CLI `data.json -o ratios.json`; profitability, efficiency, solvency, FCF quality, DuPont dynamics, growth and ROA/r.
- `calc_risk_models.py`: Altman components, M-Score, AG and optional Benford; industry applicability and missing inputs remain visible.
- `calc_valuation.py`: explicit forecast, RIM and legacy PE/PB diagnostics; DCF/WACC/sensitivity delegate to the fixed canonical Node bridge. See `references/scenario-schema.md`; no automatic tax, capex, depreciation, NWC, cash/debt or minority assumptions.
- `run_canonical.py --script <allowlisted-helper> --input data.json --output result.json -- <helper-args>` appends hashes and exit status to `_provenance.json`; this is offline calculation provenance, not a research-case audit.
- `validate_state.py state.json` and `validate_finance_output.py --report report.md --state state.json --mode intrinsic-only` are **offline import validation** for historical report/state artifacts. They do not create cases, run the workflow or establish a ledger audit pass. Preserve their intrinsic-only price firewall; normal valuation-first comparison lives in a separately audited memo.

Extraction is provider-owned at `packages/finance-data-service/providers/astock/python/sources/company_financials.py`. Never call it through a calculation wrapper or assume a finance preset exposes shell. Without a suitable narrow tool, request the offline output from an authorized operator or mark the calculation unperformed/partial; never falsely claim execution.

## Progressive references

Read only the needed resource:

- Business/industry context: `references/stage1-初步分析.md`.
- Income statement, balance sheet and cash flow: `references/stage2-利润表分析.md`, `references/stage3-资产负债表分析.md`, `references/stage4-现金流量表分析.md`.
- Ratios/risk/accounting red flags: `references/stage5-特殊指标分析.md`, `references/thresholds.md`, `references/fatal-gates.md`.
- Bank/insurance/broker/holding-company detail: `references/financial-enterprise.md`.
- RIM/AEG, cycle normalization and SOTP: `references/stage6-估值分析.md`; orchestration belongs to `equity-valuation`.
- Evidence shape and offline import compatibility: `references/data-extraction.md`, `references/incremental-update.md`, `references/state-schema.json`, `references/scenario-schema.md`.

## Output

Financial-quality conclusion; industry and fatal-gate status; growth/profitability; balance-sheet capacity; cash-flow reconciliation; ratios/risk with applicability; quarterly changes; evidence/period/unit/source table; missing/conflicting data and unperformed calculations. Distinguish observed facts, assumptions and hypotheses. No personalized buy/sell, price target or portfolio-weight instruction.
