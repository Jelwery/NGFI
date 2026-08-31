---
name: relative-valuation
description: Perform peer-comparable valuation with explicit peer selection, operating comparability checks, median multiples and implied per-share values. Use for comps, peer valuation, P/E, EV/EBITDA, EV/revenue, price/sales, or “is this stock expensive versus peers?” questions.
---

# Relative valuation

Multiples are only meaningful after peer and denominator quality are examined.

## Workflow

1. Identify the target and choose explicit peer tickers. Explain business model, geography, scale, growth, margin and capital-intensity similarities and differences. Do not let the tool silently choose peers.
2. Call `finance_comparables` with the target and peer list. Review field statuses and remove or qualify unusable denominators, negative earnings and obvious outliers.
3. Compare growth, margins and return on equity before comparing multiples. A premium can be justified only by corresponding quality/growth differences; a discount is not automatically an opportunity.
4. Use the returned valuation or call `finance_relative_valuation` for a deliberately adjusted peer set. Preserve metric-specific semantics: P/E uses EPS; EV metrics require the net-debt bridge; price/sales uses revenue and shares.
5. Reconcile each method instead of averaging blindly. Explain why one multiple deserves more weight.

## Output

Show the peer rationale, comparable operating metrics, raw multiples, included/excluded observations, peer median, implied values by method, current-price comparison and limitations. Label all market data with its observation time and currency.
