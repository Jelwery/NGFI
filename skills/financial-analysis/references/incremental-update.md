# Incremental research and historical state imports

Use `company-research` case/ledger/workflow/audit/snapshot tools for durable incremental research. This reference preserves legacy `state.json` field meaning for offline import; it is not a parallel six-stage filesystem workflow. Without research tools report **not persisted** and request original evidence when needed.

## Legacy intrinsic-only state contract

Validate supplied historical artifacts with `packages/finance-core/python/validate_state.py` and `validate_finance_output.py --report <report> --state <state> --mode intrinsic-only` through an authorized offline operator. A passed import validator is not a passed ledger audit. Keep the original file/hash and map verified observations, assumptions and claims into ledger records; do not overwrite old evidence or silently promote old conclusions.

Required top-level objects are `metadata`, `stage1`, `stage2_4_summary`, `risk_models`, `last_valuation`, `data_snapshots`. The alias `meta` is rejected. Required metadata strings are `code`, `name`, `last_period`; optional `last_qtr` and `last_report` retain the original artifact context.

`last_valuation` has a method, complete nonempty scenario and finite `results.pessimistic`, `neutral`, `optimistic`, `recommended`, or explicitly `{"status":"unavailable","reason":"..."}`. These are historical intrinsic values, not trade recommendations. Do not fabricate the four numbers when a model is unavailable. Current price, target price, upside/discount and buy-rating keys are forbidden in this import format; normal valuation-first comparisons belong separately to the ledger memo.

### Preserved field meaning

- `stage1`: company type, industry, market rhythm, moat, governance risk/note, competitors and SWOT.
- `stage2_4_summary`: annual revenue/profit/margin/EPS and expense rates; short/long borrowing, cash coverage, NFA, goodwill, assets, leverage and parent equity; OCF, cash protection/self-sufficiency, FCF and lifecycle; same-quarter revenue/profit/cash changes and warning flags. Record original units instead of assuming all old amounts are yuan or 亿元.
- `risk_models`: ROE drivers, EBIT-based ROA, borrowing-rate estimate, leverage direction, applicable Z/M results, three-year AG, financial health, earnings quality and risk classification. `stage5_metrics` is a historical alias to map explicitly, not another canonical top-level key.
- `last_valuation`: full scenario plus DCF/EV/equity/share bridge, capex/depreciation/tax/NWC/minority assumptions, RIM BPS/value/implied PB, relative peer PE/EPS/method bands, discount parameters, sensitivity and run date. Preserve original outputs and source/quality metadata, not only the four summary numbers.
- `data_snapshots`: period-keyed revenue, parent profit, EPS, assets, parent equity, cash, short/long borrowings, goodwill, OCF, margins and ROE. Missing values remain missing/null with status, never zero. Import validation requires at least one period, not invented history.

## Decide update depth from new evidence

Resolve identity and cutoff again, retrieve available new evidence using curated tools, and compare against the verified frozen baseline. A current provider fetch cannot reproduce a historical snapshot. Distinguish new observations, restatements, assumptions and wording changes.

Before choosing a light update, inspect six dimensions: product cycle; competition; management/governance; regulation; profit composition; asset structure. Material changes in any dimension require broader re-analysis. Evidence of new products, regulation, governance events, nonrecurring-profit share >20%, or major balance-sheet movements >30% are investigation triggers, not automatic conclusions from search-hit counts.

- Only a new quarter and no structural change: focus on same-quarter/YTD comparability, balance-sheet change, cash trajectory and forecast implications. A quarter is not multiplied by four by default; missing same-quarter history means unavailable YoY.
- A new annual report: refresh financial quality, industry/fatal gates, assumptions and valuation, retaining supported prior business facts with citations.
- No newer admissible evidence: state no update instead of pretending a fresh analysis.

## Forecast bridge

Use the explicit `scenario-schema.md`; absent admin/R&D/tax/capex/depreciation/NWC inputs are `needs_input`, never hidden defaults. One quarter can motivate an explained Y1 change, not mechanically replace five forecast years. Require supporting trend/structural evidence for longer changes.

Preserve old/new input snapshots and run controlled model variations for revenue, margin, reinvestment, discount rate, terminal value, capital structure and shares. Show each difference and interaction/residual. Time advancement requires an actual dated roll-forward; `new_value × terminal_growth` is not a valid generic time bridge. If decomposition cannot be calculated, say so and report only supported differences.

## Event-specific scope preserved

- Accounting shock: recheck recoverability, goodwill, pledges, earnings quality and applicable risk screens.
- Acquisition: check purchase accounting/new goodwill, consolidation, segment SOTP and integration cash flows.
- Restructuring/regulatory change: reconsider industry, competition, model applicability and terminal assumptions.
- Management or disputed auditor departure: refresh governance evidence and fatal gates; ordinary rotation is not a company-failure fact.
- Dividend/buyback policy: assess sustainable distributions, liquidity, DDM/RIM payout assumptions.
- New equity/rights/convertibles: update dilution and dated shares across all per-share models.
- ST/distress warning: investigate going concern and asset-based valuation suitability; pre-model fatal gates still stop valuation.

Append new versions, sources, gate decisions and model outputs to the ledger using `expected_revision`. Reopen revision conflicts. Freeze only after the real audit passes. Keep earlier reports, state imports, scenarios, input data and calculation outputs; no cleanup step deletes audit evidence.
