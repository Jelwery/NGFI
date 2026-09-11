---
name: equity-valuation
description: Build and reconcile independent equity valuations using DCF/WACC/sensitivity, explicit peer comparables, RIM/industry methods and analyst consensus. Use for intrinsic/fair value, DCF估值、股票估值、相对估值、可比公司、一致预期、WACC、敏感性分析, P/E, P/B, EV/EBITDA, analyst targets or expectations. Lock independent assumptions before any price comparison; supports explicit intrinsic-only mode.
---

# Equity valuation

Valuation is an explicit, source-backed scenario model, not a price oracle. Use `financial-analysis` for historical quality, industry applicability and fatal gates; use `company-research` for end-to-end research and durable cases.

## Workflow

1. **Scope** — resolve the listing with `finance_security_reference`; state currency, amount unit, shares basis, valuation date/cutoff, horizon and method. Obtain relevant `finance_fundamentals`. Retain provider/upstream/source kind, period, observation/publication/availability/retrieval times, original field status and limitations. Unknown PIT availability is not an as-of fact.
2. **Gate** — complete financial-analysis industry and fatal checks. `UNKNOWN` industry or missing essential safety evidence blocks applicable models; `fatal` stops valuation. Banks/insurers/brokers do not use generic FCFF as their sole method; read `../financial-analysis/references/financial-enterprise.md` for P/EV, DDM, PB, RIM and holding-company SOTP. Missing cash/debt is never zero.
3. **Independent valuation first** — choose evidence-based bull/base/bear assumptions, distinguish reported data from assumptions, and record sources, quality, uncertainties and falsifiers. Do not use target price, current price or a desired upside to calibrate forecasts, WACC, terminal growth, peers or weights. If price was already supplied, quarantine it from the assumption record. Lock the model inputs/results before the comparison stage; ledger tools preserve the revision/hash, while an ephemeral analysis labels the lock as conversation-local, not an audited snapshot.
4. **Calculate only what is supported** — use `finance_wacc`, `finance_dcf` and `finance_dcf_sensitivity` for DCF; `finance_comparables` and `finance_relative_valuation` for explicit peer sets; `finance_estimates` for expectations. Load only the matching progressive reference below. No mandatory shell, WebSearch, arbitrary URL/raw provider or guessed tool names. RIM and explicit forecast helpers in core are offline support where no narrow tool exists; ask for outputs or mark unperformed, never pretend they ran.
5. **Reconcile** — audit EV/equity/minority/share bridge, units, annual/TTM/forward denominator, terminal-value share and sensitivity. Explain DCF/peer/RIM divergence rather than mechanically averaging. Missing bridge stops at enterprise value with equity/per-share `null`. Unsupported estimates remain unavailable, not “zero analysts” or “no growth”.
6. **Compare only after lock** — default `valuation-first` mode permits a separately sourced current-price/consensus comparison after independent results are fixed. Use `finance_market_data` if needed and available; align listing/currency and timestamp. Do not back-solve assumptions to meet that price. Consensus targets are external expectations, not our intrinsic value or personalized trading advice.
7. **Audit and preserve** — append evidence, assumptions, model inputs/outputs, lock and post-lock comparison separately through `finance_research_ledger` with `expected_revision`, then use actual research audit tools when present. Without them explicitly say **ephemeral / not persisted**; do not invent audit or snapshot claims. Preserve all evidence, failures and provenance.

## Intrinsic-only mode

When requested, set output mode `intrinsic-only`: do not retrieve, repeat, store in the model/export, or compare current price, analyst price targets, upside/discount, ratings or trade recommendations. User-supplied price does not relax the mode. Output only independent value ranges, assumptions, sensitivity and falsifiers.

Historical state/report imports remain compatible with `packages/finance-core/python/validate_state.py` and `validate_finance_output.py --mode intrinsic-only`. These are offline import validators, not a second research workflow. Normal valuation-first price comparisons belong to the ledger/memo and are not passed through the intrinsic-only validator. No helper execution is claimed unless an authorized tool actually returned it.

## Progressive references

- DCF, WACC, explicit forecast and sensitivity: `references/dcf-valuation.md`.
- Explicit peer choice, denominator quality and multiples: `references/relative-valuation.md`.
- Estimates, consensus coverage and historical/forward separation: `references/consensus-check.md`.
- RIM stable/fade modes, AEG, normalized cyclical earnings and SOTP: `../financial-analysis/references/stage6-估值分析.md`.
- Offline explicit forecast schema and source metadata: `../financial-analysis/references/scenario-schema.md`.

## Output

State `ok|partial|needs_input|data_conflict|tool_error|fatal` while retaining specific upstream statuses. Give a range before a point estimate; scope/cutoff; independent assumptions and quality; FCF/WACC and EV/equity bridges; sensitivity; peer/consensus reconciliation; separate post-lock comparison only when allowed; risks, falsifiers, gaps and actual persistence/audit status. Research support only: no orders, personalized buy/sell recommendation or portfolio weights.
