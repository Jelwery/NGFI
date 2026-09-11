# Relative valuation reference

Use within `equity-valuation`; sources/PIT, fatal gates and output mode remain binding.

1. Choose explicit peer tickers before inspecting implied value. Justify business model, geography, scale, growth, margin and capital intensity; never select peers to produce a desired target price.
2. Call `finance_comparables`. Preserve each field's source, status, observation time, currency, unit and denominator period. Review exclusions, negative earnings and outliers rather than silently treating them as zeros.
3. Compare operating quality before multiples. Premium growth/returns may justify a premium; a discount is not automatically an opportunity. Distinguish annual, TTM and forward multiples and explain cycle-normalization.
4. Use returned calculations or `finance_relative_valuation` for a deliberately adjusted peer set. P/E requires positive EPS; EV metrics require an explicit net-debt bridge; price/sales requires revenue and shares. Unsupported/missing inputs cannot yield a precise per-share value. PB/RIM may be more relevant for banks; loss-making companies require an appropriate alternative denominator.
5. Reconcile methods and weight only with a stated rationale. Keep raw observations, inclusion/exclusion decisions, median and sensitivity. Lock the analysis before a permitted post-lock price comparison; omit price/targets/discounts entirely in intrinsic-only mode.

Output peer rationale, comparable operating metrics, raw multiples and periods, excluded observations/reasons, peer median, implied values, limitations and source/quality metadata. Legacy Python PE/PB bands remain offline diagnostic assumptions, not a substitute for a sourced peer table.
