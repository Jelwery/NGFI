# DCF valuation reference

Use within `equity-valuation`; its source/PIT, industry/fatal, persistence and output-mode rules apply.

1. Obtain historical/TTM FCF, cash, debt and dated shares through available finance tools. Normalize currency and amount units; price is not a forecast input.
2. State each annual FCF forecast and supporting revenue/margin/tax/reinvestment assumptions. Unknown history or forecast inputs mean `needs_input/partial`; a user-approved illustrative scenario is explicitly labelled, never passed off as fact.
3. Call `finance_wacc` with decimal rates. CAPM is Rf + beta × ERP. For debt-funded WACC supply cost of debt, tax and debt/equity together; weight both equity and after-tax debt. Document currency-consistent risk-free rates, capital structure, beta and source dates. Historical/cycle-normal rates are alternate assumptions, not hidden substitutions.
4. Call `finance_dcf` with explicit FCFs and either Gordon growth or exit multiple. Growth must be below discount rate. Net debt is debt minus cash; material nonoperating assets/minority interests need an explicit non-double-counted bridge. With an unknown bridge stop at EV and keep equity/per-share null; shares alone are insufficient.
5. Call `finance_dcf_sensitivity` with independent discount-rate and terminal axes. Each row discounts the entire explicit FCF schedule at its own rate; invalid cells remain null, not clamped to another valid assumption. Explain terminal-value share and scenario fragility.
6. Lock inputs/results and their sources before any permitted price comparison. In intrinsic-only mode omit that comparison entirely.

## Offline helper contract

`packages/finance-core/python/calc_valuation.py` retains `forecast_fcff`, `calc_dcf`, `calc_sensitivity`, `calc_wacc`, RIM and legacy PE/PB diagnostics. The fixed `valuation_bridge.mjs` calls compiled `calculateDcf`, `calculateDcfSensitivity` and `calculateWacc`; Python does not implement another DCF discounting kernel. Missing compiled core/Node is an explicit tool failure, not permission to implement a replacement formula.

Read `../../financial-analysis/references/scenario-schema.md` before preparing legacy forecast input. Do not claim this offline helper executed in a preset without an exposed narrow tool. Preserve inputs, outputs, assumption quality and provenance.

Output range, explicit FCF schedule, assumptions/sources, WACC and EV/equity bridges, sensitivity, terminal-value share, invalid/missing cells, model risks and actual execution status.
