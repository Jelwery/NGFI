# Explicit offline forecast schema

`packages/finance-core/python/calc_valuation.py` accepts `--scenario-file` JSON mapping scenario names to assumptions. Use `pessimistic`, `neutral`, `optimistic` for the report; sensitivity uses `neutral`. The helper accepts 1–30 annual forecast steps; all schedules must have the same length. It produces forecasts only from explicit assumptions, then calls canonical finance-core DCF/sensitivity through the fixed Node bridge.

## Required per-scenario fields

| Field | Shape and meaning |
|---|---|
| `rev_growth` | annual decimal growth array; every value > -1 |
| `gm`, `sm_rate`, `admin_rate`, `rd_rate`, `other_inc_rate`, `tax_surcharge_rate` | decimal scalar or same-length annual array; `gm` in [0,1] |
| `tax_rate` | explicit effective tax rate scalar or array in [0,1] |
| `depr_annual`, `capex_annual` | explicit nonnegative amount scalar or array, matching the statement currency/unit |
| `nwc_change_rate` | explicit scalar ΔNWC/Δrevenue; ΔNWC uses current revenue minus preceding revenue |
| `depr_in_cogs` | explicit boolean; true means reported gross margin already includes D&A, so do not deduct it twice |
| `wacc`, `term_g` | decimal discount and terminal growth rate; Gordon growth must be below WACC |

No default 15% tax, 2% depreciation/capex, fee rates, zero NWC or 2% minority interest is inserted. `derive_tax_rate`, `derive_depr` and `derive_nwc_rate` are historical diagnostics only; the analyst must explicitly adopt and source an assumption. Missing historical depreciation/flat revenue can return unknown.

## Optional bridge and quality fields

- `net_debt` **or** `nfa_addback` (not both): explicit signed bridge; zero and negative values are meaningful. `nfa_addback` is cash + nonoperating assets − full debt. Avoid double counting assets already reflected in FCFF.
- Without an override, cash, all five debt fields and all six nonoperating asset fields must be explicitly observed (including reported zero) before the helper constructs a bridge. Any unknown means EV only, equity/per-share null.
- `minority_ratio`: explicit [0,1) allocation; otherwise a disclosed book-equity proxy is used only with complete minority/parent equity. Unknown minority allocation means parent-equity/per-share null, not an assumed 2%.
- `total_shares`: explicit positive shares; CLI `--shares` takes priority across DCF, sensitivity, RIM and relative valuation. Historical EPS-derived/capital shares remain a labelled proxy when no explicit shares exist.
- `assumption_sources`: map each supplied assumption name to a source/evidence ID. Output `quality.assumptions` preserves value, kind, source and `sourced|unverified`; absent sources produce `partial`, not fabricated provenance. PIT and source eligibility still require ledger audit.

## Illustrative shape, not a company forecast

```json
{
  "neutral": {
    "rev_growth": [0.03, 0.03, 0.03], "gm": 0.4,
    "sm_rate": 0.1, "admin_rate": 0.04, "rd_rate": 0.03,
    "other_inc_rate": 0, "tax_surcharge_rate": 0.01, "tax_rate": 0.25,
    "depr_annual": 30, "capex_annual": 40, "nwc_change_rate": 0.05,
    "depr_in_cogs": true, "wacc": 0.09, "term_g": 0.02,
    "net_debt": 100, "minority_ratio": 0, "total_shares": 10,
    "assumption_sources": {"wacc": "illustrative-user-assumption"}
  }
}
```

## Other preserved methods

`calc_rim(data, ke, g_re, fade_years=5, shares=None, payout_ratio=None)` retains stable-perpetuity and fade-to-historical-ROE modes. Fade requires explicit payout or complete dividend/minority-dividend/interest components; missing payout is never 50% by default. Stable mode does not use a payout forecast and may report it unknown. `--g-re` is explicit; `--payout-ratio` is optional but required when fade cannot derive it.

`calc_relative_valuation` retains PE/PB diagnostic bands with quality labels; runtime peer calculations use `finance_relative_valuation`. Its revenue-to-EPS proxy and empirical bands are assumptions, not consensus data.

Keep the complete scenario, input statement, bridge, quality and calculation output in the ledger/artifacts. Offline `state.json` imports retain the full scenario for reproducibility but do not replace the durable research case.
