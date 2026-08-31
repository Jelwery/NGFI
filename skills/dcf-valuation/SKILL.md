---
name: dcf-valuation
description: Construct and audit an explicit discounted cash-flow valuation with WACC, forecast free cash flows, enterprise-to-equity bridge and sensitivity analysis. Use whenever the user asks for DCF, intrinsic value, fair value, terminal growth, WACC, or valuation sensitivity.
---

# DCF valuation

Treat DCF as an explicit scenario model, not a price oracle.

## Workflow

1. Call `finance_security_reference` and `finance_fundamentals`. Establish currency, amount unit, current price observation, historical/TTM FCF, cash, debt and shares.
2. State a year-by-year FCF forecast. Explain the revenue, margin, tax, reinvestment or cash-conversion logic supporting it. If the available data cannot support a forecast, ask for assumptions or present a clearly labelled illustrative scenario.
3. Call `finance_wacc`; all rates are decimals. State risk-free rate, equity risk premium, beta, capital structure, after-tax debt cost and resulting WACC. A provider beta is an input, not proof that the capital assumptions are appropriate.
4. Call `finance_dcf` with consistent units. Use net debt as debt minus cash; if net debt is unavailable, stop at enterprise value because the tool will return `null` for equity/per-share value rather than replacing the missing bridge with zero.
5. Call `finance_dcf_sensitivity` by default. Include a useful range around WACC and terminal growth or exit multiple. Invalid Gordon-growth cells where growth is at or above WACC must remain `null`.
6. Audit the enterprise-value to equity-value bridge, shares, implied per-share value and terminal-value share. A high terminal-value share increases uncertainty and should widen the conclusion.

## Output

Give a valuation range before a point estimate. Include an assumptions table, explicit FCF schedule, WACC bridge, EV-to-equity bridge, sensitivity grid, current-price comparison, major risks and limitations. Never output a normal Gordon-growth result when `discount_rate <= terminal_growth_rate`.
