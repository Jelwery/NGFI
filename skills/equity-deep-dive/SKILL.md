---
name: equity-deep-dive
description: Produce a full public-equity research report combining company scope, market snapshot, financial quality, DCF, peer valuation, consensus reconciliation, catalysts, risks and an auditable conclusion. Use for stock deep dives, investment memos, company research reports, bull/bear cases, or comprehensive valuation requests.
---

# Equity deep dive

Use the smallest complete evidence chain. Load the specialist Skills when their steps become relevant: `ticker-snapshot`, `financial-analysis`, `dcf-valuation`, `relative-valuation`, and `consensus-check`.

## Loop

1. **Scope** — confirm ticker/listing, currency, analysis date, requested horizon and whether assumptions are user-supplied or illustrative.
2. **Ground** — call `finance_security_reference`, `finance_fundamentals` and `finance_market_data`. Preserve period and observation metadata.
3. **Analyze** — explain business/industry claims only when supported by available evidence; use the financial-analysis discipline for growth, margins, cash conversion and leverage.
4. **Model** — build explicit DCF assumptions, call `finance_wacc`, `finance_dcf` and `finance_dcf_sensitivity`. If history is insufficient, clearly label the model illustrative.
5. **Compare** — choose explicit peers, call `finance_comparables`, and assess operating comparability before multiples.
6. **Reconcile** — call `finance_estimates` when useful. Explain differences among DCF, comps, consensus and current price; do not mechanically average them.
7. **Audit** — check ticker, period, currency, unit, field status, formulas, EV/equity bridge, terminal-value share and whether every material numeric claim is traceable.
8. **Synthesize** — state a base view, bull/bear drivers, catalysts, risks, what would falsify the thesis and data limitations.

## Report structure

Use: executive view; scope/data timestamp; business and key drivers; financial quality; valuation assumptions and results; DCF sensitivity; peer comparison; consensus check; bull/base/bear cases; catalysts; risks; data gaps and audit notes. This is research support, not personalized investment advice.
